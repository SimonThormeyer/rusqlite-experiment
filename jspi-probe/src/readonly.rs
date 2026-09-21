//! Read-only, immutable fixture VFS. No writer, journal, WAL, or cross-tab locking.

use js_sys::{Function, Promise, Uint8Array};
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs::{
    WasmOsCallback,
    utils::{
        OsCallback, SQLiteIoMethods, SQLiteVfs, SQLiteVfsFile, VfsAppData, VfsError, VfsFile,
        VfsResult, VfsStore, ffi,
    },
};
use std::{
    cell::{Cell, RefCell},
    time::Duration,
};
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemFileHandle};

struct OpfsFile {
    snapshot: File,
    before_read: Function,
    reads: Cell<u32>,
    offset_reads: Cell<u32>,
    short_reads: Cell<u32>,
    failure: RefCell<Option<JsValue>>,
}

fn readonly<T>() -> VfsResult<T> {
    Err(VfsError::new(
        ffi::SQLITE_READONLY,
        "immutable fixture".into(),
    ))
}

impl VfsFile for OpfsFile {
    fn read(&self, buf: &mut [u8], offset: usize) -> VfsResult<bool> {
        buf.fill(0); // SQLite requires zero padding on a short read.
        self.reads.set(self.reads.get() + 1);
        if offset > 0 {
            self.offset_reads.set(self.offset_reads.get() + 1);
        }
        let result = (|| -> Result<Vec<u8>, JsValue> {
            // Invoke the test hook only inside xRead, including for rejection tests.
            let promise: Promise = self
                .before_read
                .call2(
                    &JsValue::NULL,
                    &self.reads.get().into(),
                    &(offset as f64).into(),
                )?
                .dyn_into()?;
            super::suspend(&promise)?;
            let slice = self
                .snapshot
                .slice_with_f64_and_f64(offset as f64, (offset as f64) + (buf.len() as f64))?;
            Ok(Uint8Array::new(&super::suspend(&slice.array_buffer())?).to_vec())
        })();
        let bytes = result.map_err(|error| {
            let message = format!("OPFS xRead failed: {error:?}");
            *self.failure.borrow_mut() = Some(error);
            VfsError::new(ffi::SQLITE_IOERR_READ, message)
        })?;
        if bytes.len() > buf.len() {
            return Err(VfsError::new(
                ffi::SQLITE_IOERR_READ,
                "oversized read".into(),
            ));
        }
        buf[..bytes.len()].copy_from_slice(&bytes);
        let complete = bytes.len() == buf.len();
        if !complete {
            self.short_reads.set(self.short_reads.get() + 1);
        }
        Ok(complete)
    }
    fn size(&self) -> VfsResult<usize> {
        Ok(self.snapshot.size() as usize)
    }
    fn write(&mut self, _: &[u8], _: usize) -> VfsResult<()> {
        readonly()
    }
    fn truncate(&mut self, _: usize) -> VfsResult<()> {
        readonly()
    }
    fn flush(&mut self) -> VfsResult<()> {
        readonly()
    }
}

struct Data {
    name: String,
    file: OpfsFile,
}
struct Store;
impl VfsStore<OpfsFile, Data> for Store {
    fn add_file(_: *mut ffi::sqlite3_vfs, _: &str, _: i32) -> VfsResult<()> {
        readonly()
    }
    fn delete_file(_: *mut ffi::sqlite3_vfs, _: &str) -> VfsResult<()> {
        readonly()
    }
    fn contains_file(vfs: *mut ffi::sqlite3_vfs, name: &str) -> VfsResult<bool> {
        Ok(unsafe { Self::app_data(vfs) }.name == name)
    }
    fn with_file<F: Fn(&OpfsFile) -> VfsResult<i32>>(file: &SQLiteVfsFile, f: F) -> VfsResult<i32> {
        // Immutable app data lives until after the connection closes. No RefCell
        // borrow spans suspension; the shared guard excludes all other SQLite probes.
        f(&unsafe { Self::app_data(file.vfs) }.file)
    }
    fn with_file_mut<F: Fn(&mut OpfsFile) -> VfsResult<i32>>(
        _: &SQLiteVfsFile,
        _: F,
    ) -> VfsResult<i32> {
        readonly()
    }
}

struct Io;
impl SQLiteIoMethods for Io {
    type File = OpfsFile;
    type AppData = Data;
    type Store = Store;
    const VERSION: i32 = 1;
    unsafe extern "C" fn xDeviceCharacteristics(_: *mut ffi::sqlite3_file) -> i32 {
        ffi::SQLITE_IOCAP_IMMUTABLE
    }
}

struct Vfs;
impl SQLiteVfs<Io> for Vfs {
    const VERSION: i32 = 1;
    fn sleep(duration: Duration) {
        WasmOsCallback::sleep(duration);
    }
    fn random(bytes: &mut [u8]) {
        WasmOsCallback::random(bytes);
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
        if flags & ffi::SQLITE_OPEN_MAIN_DB == 0
            || flags & ffi::SQLITE_OPEN_READONLY == 0
            || flags & (ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE) != 0
        {
            return ffi::SQLITE_READONLY;
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

fn error(message: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&message.to_string()).into()
}

/// Query a pre-existing OPFS fixture using range reads inside SQLite xRead.
/// Returns [total reads, nonzero-offset reads, short reads].
#[wasm_bindgen(jspi)]
pub fn sqlite_readonly_probe(name: String, before_read: Function) -> Result<Vec<u32>, JsValue> {
    let _busy = super::SqliteGuard::enter()?;
    let _database_lock = super::locking::DatabaseLock::acquire(&name)?;
    let handle: FileSystemFileHandle =
        super::suspend(&super::directory()?.get_file_handle(&name))?.dyn_into()?;
    let snapshot: File = super::suspend(&handle.get_file())?.dyn_into()?;
    let mut data = Box::new(VfsAppData::new(Data {
        name: name.clone(),
        file: OpfsFile {
            snapshot,
            before_read,
            reads: Cell::new(0),
            offset_reads: Cell::new(0),
            short_reads: Cell::new(0),
            failure: RefCell::new(None),
        },
    }));
    let mut vfs = Box::new(Vfs::vfs(c"jspi-readonly-probe".as_ptr(), &mut *data));
    // Initialize SQLite before registering a non-default VFS.
    let code = unsafe { sqlite_wasm_rs::sqlite3_initialize() };
    if code != ffi::SQLITE_OK {
        return Err(error(format!("initialize: {code}")));
    }
    let code = unsafe { ffi::sqlite3_vfs_register(&mut *vfs, 0) };
    if code != ffi::SQLITE_OK {
        return Err(error(format!("register: {code}")));
    }
    let mut registration = Registration(vfs);
    let result = (|| -> rusqlite::Result<()> {
        let db = Connection::open_with_flags_and_vfs(
            &name,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            "jspi-readonly-probe",
        )?;
        let summary: (i64, i64, i64) = db.query_row(
            "SELECT count(*), sum(id), sum(length(payload)) FROM fixture",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let row: (String, Vec<u8>) = db.query_row(
            "SELECT label, payload FROM fixture WHERE id=73",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut expected = vec![73, 0, 255];
        expected.extend([0; 198]);
        expected.extend([0x5a, 0xc3]);
        if summary != (100, 5050, 20300)
            || row != ("row-073".into(), expected)
            || data.file.offset_reads.get() == 0
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let integrity: String = db.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let write_error = match db.execute("DELETE FROM fixture", []) {
            Err(error) => error,
            Ok(_) => return Err(rusqlite::Error::InvalidQuery),
        };
        if write_error.sqlite_error_code() != Some(rusqlite::ErrorCode::ReadOnly) {
            return Err(write_error);
        }
        db.close().map_err(|(_, error)| error)?;
        Ok(())
    })();
    if let Err(sql_error) = result {
        let js_error = js_sys::Error::new(&sql_error.to_string());
        if let Some(code) = sql_error.sqlite_error() {
            js_sys::Reflect::set(&js_error, &"sqliteCode".into(), &code.extended_code.into())?;
        }
        if let Some(cause) = data.file.failure.borrow_mut().take() {
            js_sys::Reflect::set(&js_error, &"cause".into(), &cause)?;
        }
        return Err(js_error.into());
    }
    // Check short reads via the exact C callbacks installed in this VFS, after
    // closing the SQL connection. Sentinel bytes expose failure to zero the tail.
    let mut raw: SQLiteVfsFile = unsafe { std::mem::zeroed() };
    let file = (&mut raw as *mut SQLiteVfsFile).cast();
    let name = std::ffi::CString::new(name).map_err(error)?;
    let code = unsafe {
        Vfs::xOpen(
            &mut *registration.0,
            name.as_ptr(),
            file,
            ffi::SQLITE_OPEN_READONLY | ffi::SQLITE_OPEN_MAIN_DB,
            std::ptr::null_mut(),
        )
    };
    if code != ffi::SQLITE_OK {
        return Err(error("short-read check open failed"));
    }
    // xRead's length is in bytes. Explicit u8 avoids integer inference creating
    // a 32-byte [i32; 8] buffer while the callback only fills its first 8 bytes.
    let mut tail = [0xa5_u8; 8];
    let code = unsafe {
        Io::xRead(
            file,
            tail.as_mut_ptr().cast(),
            tail.len() as i32,
            data.file.snapshot.size() as i64 - 2,
        )
    };
    let mut beyond = [0xa5_u8; 8];
    let beyond_code = unsafe {
        Io::xRead(
            file,
            beyond.as_mut_ptr().cast(),
            beyond.len() as i32,
            data.file.snapshot.size() as i64 + 8,
        )
    };
    unsafe {
        Io::xClose(file);
    }
    if code != ffi::SQLITE_IOERR_SHORT_READ
        || tail != [0x5a, 0xc3, 0, 0, 0, 0, 0, 0]
        || beyond_code != ffi::SQLITE_IOERR_SHORT_READ
        || beyond != [0; 8]
    {
        return Err(error(format!(
            "short-read check failed: size={}, expected code={}; \
             EOF code={code}, bytes={tail:02x?} (expected [5a, c3, 00, 00, 00, 00, 00, 00]); \
             beyond-EOF code={beyond_code}, bytes={beyond:02x?} (expected eight zero bytes); \
             last storage failure={:?}",
            data.file.snapshot.size(),
            ffi::SQLITE_IOERR_SHORT_READ,
            data.file.failure.borrow(),
        )));
    }
    Ok(vec![
        data.file.reads.get(),
        data.file.offset_reads.get(),
        data.file.short_reads.get(),
    ])
}
