//! Narrow boundary test: xOpen suspends, then delegates to the existing memory VFS.
//! Database bytes are NOT persisted to OPFS by this adapter.

use std::{cell::RefCell, ffi::c_int, ptr};

use js_sys::Promise;
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs as ffi;
use wasm_bindgen::prelude::*;

type Open = unsafe extern "C" fn(
    *mut ffi::sqlite3_vfs,
    ffi::sqlite3_filename,
    *mut ffi::sqlite3_file,
    c_int,
    *mut c_int,
) -> c_int;

struct State {
    gate: Promise,
    marker: String,
    original_open: Open,
    resumed: u32,
    failure: Option<JsValue>,
}

thread_local! {
    // No RefCell borrow is held across a suspension. A second invocation is rejected
    // before it can enter SQLite or replace the active callback state.
    static ACTIVE: RefCell<Option<State>> = const { RefCell::new(None) };
}

struct ActiveGuard;

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE.with(|active| *active.borrow_mut() = None);
    }
}

struct Registration(Box<ffi::sqlite3_vfs>);

impl Drop for Registration {
    fn drop(&mut self) {
        // All connections have been closed before this guard is dropped.
        unsafe { ffi::sqlite3_vfs_unregister(&mut *self.0) };
    }
}

unsafe extern "C" fn open(
    vfs: *mut ffi::sqlite3_vfs,
    name: ffi::sqlite3_filename,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    // SQLite requires pMethods to stay null when xOpen fails before opening a file.
    unsafe { (*file).pMethods = ptr::null() };
    let context = ACTIVE.with(|active| {
        active.borrow().as_ref().map(|state| {
            (
                state.gate.clone(),
                state.marker.clone(),
                state.original_open,
            )
        })
    });
    let Some((gate, marker, original_open)) = context else {
        return ffi::SQLITE_CANTOPEN;
    };
    let result = (|| {
        super::suspend(&gate)?;
        // This is real OPFS I/O reached from SQLite C, not a read before opening SQLite.
        let bytes = super::read(&marker)?;
        if bytes != [0, 255, 128] {
            return Err(JsValue::from_str("unexpected OPFS marker contents"));
        }
        Ok(())
    })();
    if let Err(error) = result {
        ACTIVE.with(|active| {
            if let Some(state) = active.borrow_mut().as_mut() {
                state.failure = Some(error);
            }
        });
        // Do not throw a JS exception or unwind across the C callback boundary.
        return ffi::SQLITE_CANTOPEN;
    }
    ACTIVE.with(|active| {
        if let Some(state) = active.borrow_mut().as_mut() {
            state.resumed += 1;
        }
    });
    // The copied VFS retains memvfs's pAppData and all other callbacks. The original
    // xOpen receives the copy, whose allocation outlives every connection/file.
    unsafe { original_open(vfs, name, file, flags, out_flags) }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

/// Open an unencrypted memory database via a suspending xOpen and exercise SQL.
/// Returns the number of successfully resumed xOpen callbacks (expected: one).
#[wasm_bindgen(jspi)]
pub fn sqlite_callback_probe(gate: Promise, marker: String) -> Result<u32, JsValue> {
    let _busy = super::SqliteGuard::enter()?;
    if ACTIVE.with(|active| active.borrow().is_some()) {
        return Err(js_error("SQLite probe already running"));
    }
    let memory = ffi::MemVfsUtil::<ffi::WasmOsCallback>::new();
    let base = unsafe { ffi::sqlite3_vfs_find(c"memvfs".as_ptr()) };
    if base.is_null() {
        return Err(js_error("memvfs was not installed"));
    }
    // sqlite3_vfs is a plain C struct. Borrow its stable callbacks/app data, but
    // register a distinct name without changing the default VFS or its xOpen.
    let mut vfs = Box::new(unsafe { *base });
    let original_open = vfs.xOpen.ok_or_else(|| js_error("memvfs has no xOpen"))?;
    vfs.zName = c"jspi-callback-probe".as_ptr();
    vfs.pNext = ptr::null_mut();
    vfs.xOpen = Some(open);
    ACTIVE.with(|active| {
        *active.borrow_mut() = Some(State {
            gate,
            marker,
            original_open,
            resumed: 0,
            failure: None,
        });
    });
    let _active = ActiveGuard;
    let code = unsafe { ffi::sqlite3_vfs_register(&mut *vfs, 0) };
    if code != ffi::SQLITE_OK {
        return Err(js_error(format!("VFS registration returned {code}")));
    }
    let _registration = Registration(vfs);
    let filename = "jspi-callback-probe.sqlite";
    let result = (|| -> rusqlite::Result<()> {
        let db = Connection::open_with_flags_and_vfs(
            filename,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            "jspi-callback-probe",
        )?;
        // One connection and a memory rollback journal: no WAL or persistence claim.
        db.execute_batch(
            "PRAGMA journal_mode=MEMORY;
            CREATE TABLE probe(value INTEGER NOT NULL);
            INSERT INTO probe VALUES (42);
            BEGIN; UPDATE probe SET value=99; ROLLBACK;",
        )?;
        let value: i32 = db.query_row("SELECT value FROM probe", [], |row| row.get(0))?;
        if value != 42 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        db.close().map_err(|(_, error)| error)?;
        Ok(())
    })();
    // The closure has dropped its connection on both success and failure.
    memory.delete_db(filename);
    if let Err(error) = result {
        // Include both the SQLite error code and the original JS/storage failure.
        let cause =
            ACTIVE.with(|active| active.borrow_mut().as_mut().and_then(|s| s.failure.take()));
        if let Some(cause) = cause {
            if error.sqlite_error_code() != Some(rusqlite::ErrorCode::CannotOpen) {
                return Err(js_error(format!(
                    "unexpected SQLite error after callback failure: {error}"
                )));
            }
            let error =
                js_sys::Error::new(&format!("SQLite xOpen returned SQLITE_CANTOPEN: {error}"));
            js_sys::Reflect::set(&error, &JsValue::from_str("cause"), &cause)?;
            return Err(error.into());
        }
        return Err(js_error(error));
    }
    Ok(ACTIVE.with(|active| active.borrow().as_ref().map_or(0, |s| s.resumed)))
}
