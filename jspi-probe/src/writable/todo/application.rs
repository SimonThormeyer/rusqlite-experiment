//! Application entry points. Passwords are supplied per operation, never persisted.
use super::*;

fn require_key(key: &str) -> Result<(), JsValue> {
    if key.is_empty() {
        Err(js_error("A nonempty password is required"))
    } else {
        Ok(())
    }
}
fn integrity(db: &Connection) -> Result<(), JsValue> {
    let value: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(sql)?;
    if value != "ok" {
        return Err(js_error(format!("integrity_check: {value}")));
    }
    Ok(())
}
fn state(db: &Connection, selected: Option<u32>) -> Result<JsValue, JsValue> {
    schema(db, false)?;
    integrity(db)?;
    let mut lists = model(todo_list::TodoList::list_all(db))?;
    lists.sort_by_key(|(id, _)| *id);
    let id = selected
        .and_then(|id| {
            lists
                .iter()
                .find(|(found, _)| u32::from(*found) == id)
                .map(|(id, _)| *id)
        })
        .or_else(|| lists.last().map(|(id, _)| *id));
    let summaries = js_sys::Array::new();
    for (id, title) in lists {
        let entry = js_sys::Object::new();
        js_sys::Reflect::set(&entry, &"id".into(), &u32::from(id).into())?;
        js_sys::Reflect::set(&entry, &"title".into(), &title.into())?;
        summaries.push(&entry);
    }
    let selected = match id {
        Some(id) => snapshot(&model(todo_list::TodoList::load(db, id))?)?,
        None => JsValue::NULL,
    };
    let result = js_sys::Object::new();
    js_sys::Reflect::set(&result, &"lists".into(), &summaries)?;
    js_sys::Reflect::set(&result, &"selected".into(), &selected)?;
    Ok(result.into())
}

/// Header classification is only a setup hint, never proof of encryption.
#[wasm_bindgen(jspi)]
pub fn app_inspect(name: String) -> Result<String, JsValue> {
    let _busy = super::super::super::SqliteGuard::enter()?;
    let _lease = super::super::super::locking::DatabaseLock::acquire(&name)?;
    match super::super::super::read(&name) {
        Ok(bytes) if bytes.is_empty() => Ok("empty".into()),
        Ok(bytes) if bytes.starts_with(b"SQLite format 3\0") => Ok("plaintext".into()),
        Ok(_) => Ok("locked".into()),
        Err(error)
            if js_sys::Reflect::get(&error, &"name".into())?
                .as_string()
                .as_deref()
                == Some("NotFoundError") =>
        {
            Ok("missing".into())
        }
        Err(error) => Err(error),
    }
}

/// Initialize only a new/empty file. Never overwrite an existing database.
#[wasm_bindgen(jspi)]
pub fn app_create(name: String, key: String, hook: Function) -> Result<JsValue, JsValue> {
    require_key(&key)?;
    database_inner(name, Creation::New, hook, true, Some(&key), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, true)?;
        tx.commit().map_err(sql)?;
        state(db, None)
    })
}

#[wasm_bindgen(jspi)]
pub fn app_state(
    name: String,
    key: String,
    selected: Option<u32>,
    hook: Function,
) -> Result<JsValue, JsValue> {
    require_key(&key)?;
    keyed_database(name, hook, Some(&key), |db| state(db, selected))
}

/// Preserve the SPA's ability to create a list before adding any items.
#[wasm_bindgen(jspi)]
pub fn app_create_list(
    name: String,
    key: String,
    title: String,
    hook: Function,
) -> Result<JsValue, JsValue> {
    require_key(&key)?;
    if title.trim().is_empty() {
        return Err(js_error("List title is required"));
    }
    keyed_database(name, hook, Some(&key), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        let list = model(todo_list::TodoList::new(&tx, title))?;
        let value = snapshot(&list)?;
        tx.commit().map_err(sql)?;
        Ok(value)
    })
}

#[wasm_bindgen(jspi)]
pub fn app_change_key(
    name: String,
    key: String,
    replacement: String,
    hook: Function,
) -> Result<(), JsValue> {
    require_key(&key)?;
    require_key(&replacement)?;
    keyed_database(name, hook, Some(&key), |db| {
        schema(db, false)?;
        integrity(db)?;
        let length = i32::try_from(replacement.len()).map_err(|_| js_error("Key too long"))?;
        encryption::code(db, unsafe {
            sqlite_wasm_rs::sqlite3_rekey(db.handle(), replacement.as_ptr().cast(), length)
        })?;
        integrity(db)
    })
}
