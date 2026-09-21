use js_sys::{Function, Promise};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/locks.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = acquireDatabaseLock)]
    fn acquire(name: &str) -> Result<Promise, JsValue>;
}

/// Held before reading OPFS and until all SQLite handles/VFS state are dropped.
pub(crate) struct DatabaseLock(Function);

impl DatabaseLock {
    pub(crate) fn acquire(name: &str) -> Result<Self, JsValue> {
        Ok(Self(super::suspend(&acquire(name)?)?.dyn_into()?))
    }
}

impl Drop for DatabaseLock {
    fn drop(&mut self) {
        // All callers are inside a JSPI export, including its error paths. Wait
        // until the Web Locks callback finishes so immediate retries can acquire.
        if let Ok(value) = self.0.call0(&JsValue::NULL) {
            if let Ok(promise) = value.dyn_into::<Promise>() {
                let _ = super::suspend(&promise);
            }
        }
    }
}
