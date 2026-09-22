//! First application slice: shared TODO schema/model on the audited VFS.
use super::*;
#[cfg(feature = "encryption")]
mod application;
#[cfg(feature = "encryption")]
mod encryption;
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

// The shared model's async methods currently contain synchronous rusqlite work.
// Poll once inside the JSPI stack: suspension occurs in VFS callbacks, not in
// the Rust future scheduler. Fail explicitly if the model ever needs a scheduler.
fn model<T, E: std::fmt::Display>(
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, JsValue> {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => result.map_err(|error| js_error(format!("{error:#}"))),
        Poll::Pending => Err(js_error(
            "TODO model requires an async scheduler; single-poll adapter cannot continue",
        )),
    }
}
fn sql(error: rusqlite::Error) -> JsValue {
    let result = js_sys::Error::new(&error.to_string());
    if let Some(code) = error.sqlite_error() {
        let _ = js_sys::Reflect::set(&result, &"sqliteCode".into(), &code.extended_code.into());
    }
    result.into()
}

fn database<T>(
    name: String,
    create: bool,
    hook: Function,
    work: impl FnOnce(&mut Connection) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    database_inner(name, create.into(), hook, false, None, work)
}

#[derive(Clone, Copy)]
enum Creation {
    Existing,
    IfMissing,
    #[cfg(feature = "encryption")]
    New,
}
impl From<bool> for Creation {
    fn from(create: bool) -> Self {
        if create {
            Self::IfMissing
        } else {
            Self::Existing
        }
    }
}

fn keyed_database<T>(
    name: String,
    hook: Function,
    key: Option<&str>,
    work: impl FnOnce(&mut Connection) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    #[cfg(not(feature = "encryption"))]
    if key.is_some() {
        return Err(js_error("This build does not support encryption"));
    }
    if key == Some("") {
        return Err(js_error("Encryption key must not be empty"));
    }
    database_inner(name, Creation::Existing, hook, key.is_some(), key, work)
}

fn database_inner<T>(
    name: String,
    creation: Creation,
    hook: Function,
    _cipher: bool,
    _key: Option<&str>,
    work: impl FnOnce(&mut Connection) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    let _busy = super::super::SqliteGuard::enter()?;
    let _lease = super::super::locking::DatabaseLock::acquire(&name)?;
    let bytes = match super::super::read(&name) {
        Ok(bytes) => bytes,
        Err(error)
            if !matches!(creation, Creation::Existing)
                && js_sys::Reflect::get(&error, &"name".into())?
                    .as_string()
                    .as_deref()
                    == Some("NotFoundError") =>
        {
            super::super::write(&name, Vec::new())?;
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    #[cfg(feature = "encryption")]
    if matches!(creation, Creation::New) && !bytes.is_empty() {
        return Err(js_error(
            "Database already exists; unlock it instead of creating it",
        ));
    }
    if bytes.len() > LIMIT {
        return Err(js_error("TODO slice limited to 1 MiB"));
    }
    let mut data = Box::new(VfsAppData::new(Data {
        name: name.clone(),
        opened: Cell::new(false),
        lock: Cell::new(ffi::SQLITE_LOCK_NONE),
        buffer: RefCell::new(Some(Buffer {
            name: name.clone(),
            bytes,
            dirty: false,
            failed: false,
            hook,
            publication_hook: None,
            failure: None,
            writes: 0,
            publications: 0,
        })),
    }));
    if unsafe { sqlite_wasm_rs::sqlite3_initialize() } != ffi::SQLITE_OK {
        return Err(js_error("SQLite initialization failed"));
    }
    let mut vfs = Box::new(Vfs::vfs(c"jspi-todo-slice".as_ptr(), &mut *data));
    if unsafe { ffi::sqlite3_vfs_register(&mut *vfs, 0) } != ffi::SQLITE_OK {
        return Err(js_error("TODO VFS registration failed"));
    }
    let _registration = Registration(vfs);
    #[cfg(feature = "encryption")]
    let _codec = if _cipher {
        Some(encryption::CodecVfs::register()?)
    } else {
        None
    };
    let vfs_name = if _cipher {
        "multipleciphers-jspi-todo-slice"
    } else {
        "jspi-todo-slice"
    };
    let mut db = Connection::open_with_flags_and_vfs(
        &name,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        vfs_name,
    )
    .map_err(sql)?;
    #[cfg(feature = "encryption")]
    if _cipher {
        encryption::set_read_key(&db, _key)?;
    }
    configure_connection(&db).map_err(sql)?;
    db.execute_batch("PRAGMA foreign_keys=ON;").map_err(sql)?;
    let result = work(&mut db);
    let close = db.close().map_err(|(_, error)| sql(error));
    let result = result.and_then(|value| close.map(|()| value));
    if let Err(error) = &result {
        if let Some(cause) = data
            .buffer
            .borrow()
            .as_ref()
            .and_then(|b| b.failure.clone())
        {
            js_sys::Reflect::set(error, &"cause".into(), &cause)?;
            js_sys::Reflect::set(error, &"sqliteCode".into(), &ffi::SQLITE_IOERR_FSYNC.into())?;
        }
    }
    result
}

fn schema(db: &Connection, create: bool) -> Result<(), JsValue> {
    let version: i32 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql)?;
    if version == 1 {
        return Ok(());
    }
    let tables: i32 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if !create || version != 0 || tables != 0 {
        return Err(js_error(
            "Unsupported TODO schema; refusing to overwrite or migrate it",
        ));
    }
    model(todo_list::apply_schema(db))?;
    db.execute_batch("PRAGMA user_version=1;").map_err(sql)
}

fn snapshot(list: &todo_list::TodoList) -> Result<JsValue, JsValue> {
    let result = js_sys::Object::new();
    let put =
        |key: &str, value: JsValue| js_sys::Reflect::set(&result, &key.into(), &value).map(|_| ());
    put("id", u32::from(list.id()).into())?;
    put("title", list.title().into())?;
    let items = js_sys::Array::new();
    for item in list.items().values() {
        let value = js_sys::Object::new();
        for (key, entry) in [
            ("id", u32::from(item.id()).into()),
            ("description", item.description().into()),
            ("completed", item.is_completed().into()),
        ] {
            js_sys::Reflect::set(&value, &key.into(), &entry)?;
        }
        items.push(&value);
    }
    put("items", items.into())?;
    Ok(result.into())
}

/// Create schema when needed and one list/item in a single explicit transaction.
#[wasm_bindgen(jspi)]
pub fn todo_create(
    name: String,
    title: String,
    description: String,
    before_publish: Function,
) -> Result<JsValue, JsValue> {
    if title.trim().is_empty() || description.trim().is_empty() {
        return Err(js_error("Title and description are required"));
    }
    database(name, true, before_publish, |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, true)?;
        let mut list = model(todo_list::TodoList::new(&tx, title))?;
        model(list.add_item(&tx, description))?;
        // Reload through the shared model to exercise its date parsing and joins.
        let loaded = model(todo_list::TodoList::load(&tx, list.id()))?;
        let value = snapshot(&loaded)?;
        tx.commit().map_err(sql)?;
        Ok(value)
    })
}

/// Load the latest list via a fresh connection; never create or reapply schema.
#[wasm_bindgen(jspi)]
pub fn todo_read(name: String, before_publish: Function) -> Result<JsValue, JsValue> {
    database(name, false, before_publish, |db| {
        schema(db, false)?;
        let lists = model(todo_list::TodoList::list_all(db))?;
        let id = lists
            .iter()
            .map(|(id, _)| *id)
            .max()
            .ok_or_else(|| js_error("No TODO list found"))?;
        let list = model(todo_list::TodoList::load(db, id))?;
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(sql)?;
        if integrity != "ok" {
            return Err(js_error(format!("integrity_check: {integrity}")));
        }
        snapshot(&list)
    })
}

/// Save an explicit description/completion state, scoped to the item's list.
#[wasm_bindgen(jspi)]
pub fn todo_update_item(
    name: String,
    list_id: u32,
    item_id: u32,
    description: String,
    completed: bool,
    before_publish: Function,
    key: Option<String>,
) -> Result<JsValue, JsValue> {
    if description.trim().is_empty() {
        return Err(js_error("Item description is required"));
    }
    keyed_database(name, before_publish, key.as_deref(), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        let mut list = model(todo_list::TodoList::load(&tx, list_id.into()))?;
        let item = list
            .item_mut(item_id.into())
            .ok_or_else(|| js_error("Item not found in this list"))?;
        item.set_description(description);
        item.set_is_completed(completed);
        model(list.save(&tx))?;
        let loaded = model(todo_list::TodoList::load(&tx, list.id()))?;
        let value = snapshot(&loaded)?;
        tx.commit().map_err(sql)?;
        Ok(value)
    })
}

/// Delete one existing item through the shared model, retaining its list.
#[wasm_bindgen(jspi)]
pub fn todo_delete_item(
    name: String,
    list_id: u32,
    item_id: u32,
    before_publish: Function,
    key: Option<String>,
) -> Result<JsValue, JsValue> {
    keyed_database(name, before_publish, key.as_deref(), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        let mut list = model(todo_list::TodoList::load(&tx, list_id.into()))?;
        if list.item(item_id.into()).is_none() {
            return Err(js_error("Item not found in this list"));
        }
        if !model(list.remove_item(&tx, item_id.into()))? {
            return Err(js_error("Item disappeared before deletion"));
        }
        let loaded = model(todo_list::TodoList::load(&tx, list.id()))?;
        let value = snapshot(&loaded)?;
        tx.commit().map_err(sql)?;
        Ok(value)
    })
}

/// Enumerate existing lists in stable ID order without publishing.
#[wasm_bindgen(jspi)]
pub fn todo_lists(
    name: String,
    before_publish: Function,
    key: Option<String>,
) -> Result<JsValue, JsValue> {
    keyed_database(name, before_publish, key.as_deref(), |db| {
        schema(db, false)?;
        let mut lists = model(todo_list::TodoList::list_all(db))?;
        lists.sort_by_key(|(id, _)| *id);
        let result = js_sys::Array::new();
        for (id, title) in lists {
            let entry = js_sys::Object::new();
            js_sys::Reflect::set(&entry, &"id".into(), &u32::from(id).into())?;
            js_sys::Reflect::set(&entry, &"title".into(), &title.into())?;
            result.push(&entry);
        }
        Ok(result.into())
    })
}

/// Load the chosen list through a fresh connection and check database integrity.
#[wasm_bindgen(jspi)]
pub fn todo_read_list(
    name: String,
    list_id: u32,
    before_publish: Function,
    key: Option<String>,
) -> Result<JsValue, JsValue> {
    keyed_database(name, before_publish, key.as_deref(), |db| {
        schema(db, false)?;
        let list = model(todo_list::TodoList::load(db, list_id.into()))?;
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(sql)?;
        if integrity != "ok" {
            return Err(js_error(format!("integrity_check: {integrity}")));
        }
        snapshot(&list)
    })
}

/// Append to an existing list in a single explicit transaction.
#[wasm_bindgen(jspi)]
pub fn todo_add_item(
    name: String,
    list_id: u32,
    description: String,
    before_publish: Function,
    key: Option<String>,
) -> Result<JsValue, JsValue> {
    if description.trim().is_empty() {
        return Err(js_error("Item description is required"));
    }
    keyed_database(name, before_publish, key.as_deref(), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        let mut list = model(todo_list::TodoList::load(&tx, list_id.into()))?;
        model(list.add_item(&tx, description))?;
        let loaded = model(todo_list::TodoList::load(&tx, list.id()))?;
        let value = snapshot(&loaded)?;
        tx.commit().map_err(sql)?;
        Ok(value)
    })
}

/// Rename through the shared model; unchanged titles do not publish.
#[wasm_bindgen(jspi)]
pub fn todo_rename_list(
    name: String,
    list_id: u32,
    title: String,
    before_publish: Function,
    key: Option<String>,
) -> Result<JsValue, JsValue> {
    if title.trim().is_empty() {
        return Err(js_error("List title is required"));
    }
    keyed_database(name, before_publish, key.as_deref(), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        let mut list = model(todo_list::TodoList::load(&tx, list_id.into()))?;
        list.set_title(title);
        model(list.save(&tx))?;
        let loaded = model(todo_list::TodoList::load(&tx, list.id()))?;
        let value = snapshot(&loaded)?;
        tx.commit().map_err(sql)?;
        Ok(value)
    })
}

/// Delete a list and its items using the shared model's foreign-key cascade.
#[wasm_bindgen(jspi)]
pub fn todo_delete_list(
    name: String,
    list_id: u32,
    before_publish: Function,
    key: Option<String>,
) -> Result<(), JsValue> {
    keyed_database(name, before_publish, key.as_deref(), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        // Reject missing IDs before executing a DELETE, including repeated requests.
        model(todo_list::TodoList::load(&tx, list_id.into()))?;
        if !model(todo_list::TodoList::delete(&tx, list_id.into()))? {
            return Err(js_error("List disappeared before deletion"));
        }
        let remaining: i64 = tx
            .query_row(
                "SELECT count(*) FROM todo_items WHERE list_id = ?",
                [list_id],
                |row| row.get(0),
            )
            .map_err(sql)?;
        if remaining != 0 {
            return Err(js_error("List deletion did not remove its items"));
        }
        tx.commit().map_err(sql)
    })
}

/// Capture committed OPFS bytes while holding the same exclusive ownership as CRUD.
/// No live connection or transaction is exposed by this application slice.
#[wasm_bindgen(jspi)]
pub fn todo_export(
    name: String,
    before_publish: Function,
    key: Option<String>,
) -> Result<Vec<u8>, JsValue> {
    let source = name.clone();
    keyed_database(name, before_publish, key.as_deref(), |db| {
        schema(db, false)?;
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(sql)?;
        if integrity != "ok" {
            return Err(js_error(format!("integrity_check: {integrity}")));
        }
        // Ownership spans validation, this read, and connection cleanup. All
        // cooperating writers acquire the same lock before touching this file.
        super::super::read(&source)
    })
}
