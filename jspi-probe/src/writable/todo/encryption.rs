//! Separate feature-gated encryption probe; never uses the demo database.
use super::*;

pub(super) struct CodecVfs;
impl CodecVfs {
    pub(super) fn register() -> Result<Self, JsValue> {
        let rc = unsafe { sqlite_wasm_rs::sqlite3mc_vfs_create(c"jspi-todo-slice".as_ptr(), 0) };
        if rc != ffi::SQLITE_OK {
            return Err(js_error(format!("Cipher VFS registration failed: {rc}")));
        }
        Ok(Self)
    }
}
impl Drop for CodecVfs {
    fn drop(&mut self) {
        // Connections must close before this wrapper, and this wrapper must
        // disappear before the underlying VFS/data are unregistered/freed.
        unsafe {
            sqlite_wasm_rs::sqlite3mc_vfs_destroy(c"multipleciphers-jspi-todo-slice".as_ptr())
        }
    }
}

pub(super) fn code(db: &Connection, rc: i32) -> Result<(), JsValue> {
    if rc == ffi::SQLITE_OK {
        return Ok(());
    }
    let message = unsafe { std::ffi::CStr::from_ptr(sqlite_wasm_rs::sqlite3_errmsg(db.handle())) }
        .to_string_lossy();
    let error = js_sys::Error::new(&message);
    js_sys::Reflect::set(&error, &"sqliteCode".into(), &rc.into())?;
    Err(error.into())
}

pub(super) fn set_read_key(db: &Connection, key: Option<&str>) -> Result<(), JsValue> {
    // Pin the cipher explicitly; do not depend on a library default or SQLCipher compatibility mode.
    db.pragma_update(None, "cipher", "chacha20").map_err(sql)?;
    if let Some(key) = key {
        if key.is_empty() {
            return Err(js_error(
                "Use no key for plaintext; an encryption key must not be empty",
            ));
        }
        let length = i32::try_from(key.len()).map_err(|_| js_error("Key too long"))?;
        code(db, unsafe {
            sqlite_wasm_rs::sqlite3_key(db.handle(), key.as_ptr().cast(), length)
        })?;
    }
    Ok(())
}
fn check_name(name: &str) -> Result<(), JsValue> {
    if !name.starts_with("encryption-check-") || !name.ends_with(".sqlite") {
        return Err(js_error(
            "Encryption probe requires an encryption-check-*.sqlite fixture",
        ));
    }
    Ok(())
}
fn verify(db: &Connection) -> Result<JsValue, JsValue> {
    schema(db, false)?;
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(sql)?;
    if integrity != "ok" {
        return Err(js_error(format!("integrity_check: {integrity}")));
    }
    let lists = model(todo_list::TodoList::list_all(db))?;
    let result = js_sys::Array::new();
    for (id, _) in lists {
        result.push(&snapshot(&model(todo_list::TodoList::load(db, id))?)?);
    }
    Ok(result.into())
}

#[wasm_bindgen(jspi)]
pub fn encryption_create(name: String, key: String, hook: Function) -> Result<JsValue, JsValue> {
    check_name(&name)?;
    if key.is_empty() {
        return Err(js_error("Encryption key required"));
    }
    database_inner(name, Creation::IfMissing, hook, true, Some(&key), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, true)?;
        let mut list = model(todo_list::TodoList::new(
            &tx,
            "Encrypted list α".to_string(),
        ))?;
        model(list.add_item(&tx, "Private item 'β' ✓".to_string()))?;
        tx.commit().map_err(sql)?;
        verify(db)
    })
}

#[wasm_bindgen(jspi)]
pub fn encryption_read(
    name: String,
    key: Option<String>,
    hook: Function,
) -> Result<JsValue, JsValue> {
    check_name(&name)?;
    database_inner(name, Creation::Existing, hook, true, key.as_deref(), |db| {
        verify(db)
    })
}

#[wasm_bindgen(jspi)]
pub fn encryption_rekey(
    name: String,
    key: Option<String>,
    new_key: String,
    hook: Function,
) -> Result<JsValue, JsValue> {
    check_name(&name)?;
    database_inner(name, Creation::Existing, hook, true, key.as_deref(), |db| {
        verify(db)?;
        let length = i32::try_from(new_key.len()).map_err(|_| js_error("Key too long"))?;
        code(db, unsafe {
            sqlite_wasm_rs::sqlite3_rekey(db.handle(), new_key.as_ptr().cast(), length)
        })?;
        verify(db)
    })
}

#[wasm_bindgen(jspi)]
pub fn encryption_export(name: String, key: String, hook: Function) -> Result<Vec<u8>, JsValue> {
    check_name(&name)?;
    let source = name.clone();
    database_inner(name, Creation::Existing, hook, true, Some(&key), |db| {
        verify(db)?;
        super::super::super::read(&source)
    })
}

#[wasm_bindgen(jspi)]
pub fn encryption_add(
    name: String,
    key: String,
    description: String,
    hook: Function,
) -> Result<JsValue, JsValue> {
    check_name(&name)?;
    database_inner(name, Creation::Existing, hook, true, Some(&key), |db| {
        let tx = db.transaction().map_err(sql)?;
        schema(&tx, false)?;
        let id = model(todo_list::TodoList::list_all(&tx))?
            .first()
            .ok_or_else(|| js_error("Missing fixture list"))?
            .0;
        let mut list = model(todo_list::TodoList::load(&tx, id))?;
        model(list.add_item(&tx, description))?;
        tx.commit().map_err(sql)?;
        verify(db)
    })
}
