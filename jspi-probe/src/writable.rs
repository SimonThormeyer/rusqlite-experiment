//! Single-file, whole-buffer writable experiment. xSync publishes, not fsync.
use js_sys::{Function, Promise};
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs::{
    WasmOsCallback,
    utils::{
        OsCallback, SQLiteIoMethods, SQLiteVfs, SQLiteVfsFile, VfsAppData, VfsError, VfsFile,
        VfsResult, VfsStore, ffi,
    },
};
use std::{cell::RefCell, time::Duration};
use wasm_bindgen::prelude::*;

const LIMIT: usize = 1024 * 1024;
fn io_error(code: i32, message: impl Into<String>) -> VfsError {
    VfsError::new(code, message.into())
}
fn js_error(message: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&message.to_string()).into()
}

struct Buffer {
    name: String,
    bytes: Vec<u8>,
    dirty: bool,
    failed: bool,
    hook: Function,
    failure: Option<JsValue>,
    writes: u32,
    publications: u32,
}
impl VfsFile for Buffer {
    fn read(&self, output: &mut [u8], offset: usize) -> VfsResult<bool> {
        output.fill(0);
        let count = output.len().min(self.bytes.len().saturating_sub(offset));
        if count > 0 {
            output[..count].copy_from_slice(&self.bytes[offset..offset + count]);
        }
        Ok(count == output.len())
    }
    fn write(&mut self, bytes: &[u8], offset: usize) -> VfsResult<()> {
        if self.failed {
            return Err(io_error(
                ffi::SQLITE_IOERR_WRITE,
                "publication failed; reopen required",
            ));
        }
        let end = offset
            .checked_add(bytes.len())
            .filter(|end| *end <= LIMIT)
            .ok_or_else(|| io_error(ffi::SQLITE_FULL, "probe limited to 1 MiB"))?;
        if end > self.bytes.len() {
            self.bytes.resize(end, 0);
        }
        self.bytes[offset..end].copy_from_slice(bytes);
        self.dirty = true;
        self.writes += 1;
        Ok(())
    }
    fn truncate(&mut self, size: usize) -> VfsResult<()> {
        if self.failed {
            return Err(io_error(
                ffi::SQLITE_IOERR_TRUNCATE,
                "publication failed; reopen required",
            ));
        }
        if size > LIMIT {
            return Err(io_error(ffi::SQLITE_FULL, "probe limited to 1 MiB"));
        }
        self.bytes.resize(size, 0);
        self.dirty = true;
        Ok(())
    }
    fn size(&self) -> VfsResult<usize> {
        Ok(self.bytes.len())
    }
    fn flush(&mut self) -> VfsResult<()> {
        if self.failed {
            return Err(io_error(
                ffi::SQLITE_IOERR_FSYNC,
                "publication failed; reopen required",
            ));
        }
        if !self.dirty {
            return Ok(());
        }
        let result = (|| -> Result<(), JsValue> {
            let promise: Promise = self.hook.call0(&JsValue::NULL)?.dyn_into()?;
            super::suspend(&promise)?;
            // Replace the entire file, await close, then use a fresh File to verify
            // publication. Never reuse a snapshot invalidated by this write.
            super::write(&self.name, self.bytes.clone())?;
            if super::read(&self.name)? != self.bytes {
                return Err(js_error("publication did not match the buffered bytes"));
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.failed = true; // Never silently retry a potentially ambiguous publish.
            let message = format!("publication failed: {error:?}");
            self.failure = Some(error);
            return Err(io_error(ffi::SQLITE_IOERR_FSYNC, message));
        }
        self.publications += 1;
        self.dirty = false;
        Ok(())
    }
}

struct Data {
    name: String,
    buffer: RefCell<Option<Buffer>>,
}
struct Store;
impl VfsStore<Buffer, Data> for Store {
    fn add_file(_: *mut ffi::sqlite3_vfs, _: &str, _: i32) -> VfsResult<()> {
        Err(io_error(
            ffi::SQLITE_CANTOPEN,
            "only the pre-created main file is supported",
        ))
    }
    fn delete_file(_: *mut ffi::sqlite3_vfs, _: &str) -> VfsResult<()> {
        Err(io_error(
            ffi::SQLITE_IOERR_DELETE,
            "no journal files supported",
        ))
    }
    fn contains_file(vfs: *mut ffi::sqlite3_vfs, name: &str) -> VfsResult<bool> {
        Ok(unsafe { Self::app_data(vfs) }.name == name)
    }
    fn with_file<F: Fn(&Buffer) -> VfsResult<i32>>(file: &SQLiteVfsFile, f: F) -> VfsResult<i32> {
        let data = unsafe { Self::app_data(file.vfs) };
        let borrow = data.buffer.borrow();
        let buffer = borrow
            .as_ref()
            .ok_or_else(|| io_error(ffi::SQLITE_BUSY, "buffer in use"))?;
        f(buffer) // Reads and size checks are memory-only and cannot suspend.
    }
    fn with_file_mut<F: Fn(&mut Buffer) -> VfsResult<i32>>(
        file: &SQLiteVfsFile,
        f: F,
    ) -> VfsResult<i32> {
        let data = unsafe { Self::app_data(file.vfs) };
        let mut buffer = data
            .buffer
            .borrow_mut()
            .take()
            .ok_or_else(|| io_error(ffi::SQLITE_BUSY, "buffer in use"))?;
        // No RefCell borrow spans JSPI suspension. The shared SQLite guard rejects
        // reentrant probes; f returns storage failures as SQLite error codes.
        let result = f(&mut buffer);
        *data.buffer.borrow_mut() = Some(buffer);
        result
    }
}
struct Io;
impl SQLiteIoMethods for Io {
    type File = Buffer;
    type AppData = Data;
    type Store = Store;
    const VERSION: i32 = 1;
    // Defaults: no shared memory/WAL, no locking, no device guarantees. xClose
    // deliberately does not flush: uncommitted changes must not publish on drop.
}
struct Vfs;
impl SQLiteVfs<Io> for Vfs {
    const VERSION: i32 = 1;
    fn sleep(d: Duration) {
        WasmOsCallback::sleep(d);
    }
    fn random(b: &mut [u8]) {
        WasmOsCallback::random(b);
    }
    fn epoch_timestamp_in_ms() -> i64 {
        WasmOsCallback::epoch_timestamp_in_ms()
    }
    unsafe extern "C" fn xOpen(
        vfs: *mut ffi::sqlite3_vfs,
        name: ffi::sqlite3_filename,
        file: *mut ffi::sqlite3_file,
        flags: i32,
        out: *mut i32,
    ) -> i32 {
        unsafe {
            (*file).pMethods = std::ptr::null();
        }
        if flags & ffi::SQLITE_OPEN_MAIN_DB == 0 {
            return ffi::SQLITE_CANTOPEN;
        }
        unsafe { Self::xOpenImpl(vfs, name, file, flags, out) }
    }
}
struct Registration(Box<ffi::sqlite3_vfs>);
impl Drop for Registration {
    fn drop(&mut self) {
        unsafe {
            ffi::sqlite3_vfs_unregister(&mut *self.0);
        }
    }
}

/// create=true builds a database; false reloads and verifies the published file.
#[wasm_bindgen(jspi)]
pub fn sqlite_writable_probe(
    name: String,
    create: bool,
    before_publish: Function,
) -> Result<String, JsValue> {
    run(name, create, before_publish, None)
}

/// Hold an already-committed, verified database open until the test gate resolves.
/// The owner-termination test destroys this page while that gate remains pending.
#[wasm_bindgen(jspi)]
pub fn sqlite_hold_committed_probe(
    name: String,
    before_publish: Function,
    before_close: Function,
) -> Result<String, JsValue> {
    run(name, false, before_publish, Some((before_close, false)))
}

/// Hold after verifying uncommitted UPDATE/DELETE/INSERT changes in SQLite's pager.
#[wasm_bindgen(jspi)]
pub fn sqlite_hold_uncommitted_probe(
    name: String,
    before_publish: Function,
    before_close: Function,
) -> Result<String, JsValue> {
    run(name, false, before_publish, Some((before_close, true)))
}

fn run(
    name: String,
    create: bool,
    before_publish: Function,
    before_close: Option<(Function, bool)>,
) -> Result<String, JsValue> {
    let _busy = super::SqliteGuard::enter()?;
    let _database_lock = super::locking::DatabaseLock::acquire(&name)?;
    let bytes = super::read(&name)?;
    if bytes.len() > LIMIT || (create && !bytes.is_empty()) {
        return Err(js_error(
            "creation requires an empty file; maximum size is 1 MiB",
        ));
    }
    let mut data = Box::new(VfsAppData::new(Data {
        name: name.clone(),
        buffer: RefCell::new(Some(Buffer {
            name: name.clone(),
            bytes,
            dirty: false,
            failed: false,
            hook: before_publish,
            failure: None,
            writes: 0,
            publications: 0,
        })),
    }));
    let code = unsafe { sqlite_wasm_rs::sqlite3_initialize() };
    if code != ffi::SQLITE_OK {
        return Err(js_error(format!("initialize: {code}")));
    }
    let mut vfs = Box::new(Vfs::vfs(c"jspi-writable-probe".as_ptr(), &mut *data));
    let code = unsafe { ffi::sqlite3_vfs_register(&mut *vfs, 0) };
    if code != ffi::SQLITE_OK {
        return Err(js_error(format!("register: {code}")));
    }
    let mut registration = Registration(vfs);
    let mut logs = Vec::new();
    if create {
        // Direct callback checks ensure read-your-writes is tested below SQLite's
        // pager cache. All raw callback buffers have explicit byte element types.
        let mut raw: SQLiteVfsFile = unsafe { std::mem::zeroed() };
        let file = (&mut raw as *mut SQLiteVfsFile).cast();
        let c_name = std::ffi::CString::new(name.clone()).map_err(js_error)?;
        let code = unsafe {
            Vfs::xOpen(
                &mut *registration.0,
                c_name.as_ptr(),
                file,
                ffi::SQLITE_OPEN_MAIN_DB | ffi::SQLITE_OPEN_READWRITE,
                std::ptr::null_mut(),
            )
        };
        if code != ffi::SQLITE_OK {
            return Err(js_error("direct callback open failed"));
        }
        let result = (|| -> Result<(), JsValue> {
            let input = [0x5a_u8, 0, 0xff, 0xc3];
            let mut output = [0xa5_u8; 4];
            let write = unsafe { Io::xWrite(file, input.as_ptr().cast(), 4, 3) };
            let read = unsafe { Io::xRead(file, output.as_mut_ptr().cast(), 4, 3) };
            if write != ffi::SQLITE_OK
                || read != ffi::SQLITE_OK
                || output != input
                || !super::read(&name)?.is_empty()
            {
                return Err(js_error(
                    "buffered read-your-writes or pre-sync visibility failed",
                ));
            }
            let sync = unsafe { Io::xSync(file, 0) };
            if sync != ffi::SQLITE_OK {
                return Err(js_error(format!("direct xSync failed: {sync}")));
            }
            if super::read(&name)? != [0, 0, 0, 0x5a, 0, 0xff, 0xc3] {
                return Err(js_error("direct publication mismatch"));
            }
            let truncate = unsafe { Io::xTruncate(file, 0) };
            let sync = unsafe { Io::xSync(file, 0) };
            if truncate != ffi::SQLITE_OK
                || sync != ffi::SQLITE_OK
                || !super::read(&name)?.is_empty()
            {
                return Err(js_error("truncate publication failed"));
            }
            Ok(())
        })();
        unsafe {
            Io::xClose(file);
        }
        result?;
        logs.push("PASS: direct xWrite/xRead saw pending bytes; xSync published them; xTruncate published an empty file".to_string());
    }
    let sql_result = (|| -> rusqlite::Result<()> {
        let db = Connection::open_with_flags_and_vfs(
            &name,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            "jspi-writable-probe",
        )?;
        db.execute_batch(
            "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=FULL; PRAGMA cache_spill=OFF;",
        )?;
        if create {
            db.execute_batch(
                "CREATE TABLE writable(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
                BEGIN; INSERT INTO writable VALUES(1, x'00ff80'); COMMIT;
                BEGIN; UPDATE writable SET payload=x'ffff'; ROLLBACK;
                BEGIN; INSERT INTO writable VALUES(2, x'5ac3'); COMMIT;",
            )?;
        }
        let rows: Vec<(i64, Vec<u8>)> = db
            .prepare("SELECT id,payload FROM writable ORDER BY id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if rows != vec![(1, vec![0, 255, 128]), (2, vec![90, 195])] || integrity != "ok" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        // Dropping an uncommitted transaction must not publish its changes.
        if create {
            db.execute_batch("BEGIN; DELETE FROM writable;")?;
        }
        if let Some((gate, uncommitted)) = &before_close {
            if *uncommitted {
                db.execute_batch(
                    "BEGIN IMMEDIATE;
                     UPDATE writable SET payload=x'deadbeef' WHERE id=1;
                     DELETE FROM writable WHERE id=2;
                     INSERT INTO writable VALUES(3, x'cafebabe');",
                )?;
                let pending: Vec<(i64, Vec<u8>)> = db
                    .prepare("SELECT id,payload FROM writable ORDER BY id")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                if db.is_autocommit()
                    || pending
                        != vec![
                            (1, vec![0xde, 0xad, 0xbe, 0xef]),
                            (3, vec![0xca, 0xfe, 0xba, 0xbe]),
                        ]
                {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                // This small transaction with cache_spill=OFF must remain in the
                // pager. Do not confuse this test with interruption during xSync.
                let borrow = data.buffer.borrow();
                let buffer = borrow.as_ref().ok_or(rusqlite::Error::InvalidQuery)?;
                if buffer.writes != 0 || buffer.publications != 0 || buffer.dirty {
                    return Err(rusqlite::Error::InvalidQuery);
                }
            }
            let promise = gate
                .call0(&JsValue::NULL)
                .and_then(|value| value.dyn_into::<Promise>())
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            super::suspend(&promise).map_err(|_| rusqlite::Error::InvalidQuery)?;
        }
        db.close().map_err(|(_, e)| e)?;
        Ok(())
    })();
    if let Err(sql_error) = sql_result {
        let error = js_sys::Error::new(&sql_error.to_string());
        if let Some(code) = sql_error.sqlite_error() {
            js_sys::Reflect::set(&error, &"sqliteCode".into(), &code.extended_code.into())?;
        }
        if let Some(cause) = data
            .buffer
            .borrow()
            .as_ref()
            .and_then(|b| b.failure.clone())
        {
            js_sys::Reflect::set(&error, &"cause".into(), &cause)?;
        }
        return Err(error.into());
    }
    let borrow = data.buffer.borrow();
    let buffer = borrow.as_ref().ok_or_else(|| js_error("missing buffer"))?;
    if create && (buffer.writes < 2 || buffer.publications < 3) {
        return Err(js_error("SQLite did not exercise write/sync callbacks"));
    }
    logs.push(format!(
        "PASS: {} and integrity_check ({} xWrite calls; {} publications)",
        if create {
            "SQL commits, rollback, and close with an uncommitted transaction"
        } else {
            "fresh connection loaded committed rows from OPFS"
        },
        buffer.writes,
        buffer.publications
    ));
    Ok(logs.join("\n"))
}
