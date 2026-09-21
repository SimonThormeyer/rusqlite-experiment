use super::*;

#[wasm_bindgen(jspi)]
pub fn sqlite_vfs_contract_probe(name: String, hook: Function) -> Result<String, JsValue> {
    run(name, false, hook, None, None, "contract")
}

fn require(ok: bool, message: &str) -> Result<(), JsValue> {
    if ok { Ok(()) } else { Err(js_error(message)) }
}

pub(super) fn callbacks(vfs: &mut ffi::sqlite3_vfs, data: &Data) -> Result<(), JsValue> {
    let name = std::ffi::CString::new(data.name.clone()).map_err(js_error)?;
    let missing = std::ffi::CString::new(format!("{}-missing", data.name)).map_err(js_error)?;
    let base = ffi::SQLITE_OPEN_MAIN_DB | ffi::SQLITE_OPEN_READWRITE;
    for flags in [
        ffi::SQLITE_OPEN_MAIN_DB | ffi::SQLITE_OPEN_READONLY,
        base | ffi::SQLITE_OPEN_DELETEONCLOSE,
        base | ffi::SQLITE_OPEN_EXCLUSIVE,
        ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_MAIN_JOURNAL,
        ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_WAL,
        ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_TEMP_DB,
        ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_SUBJOURNAL,
        base | ffi::SQLITE_OPEN_MEMORY,
    ] {
        let mut raw: SQLiteVfsFile = unsafe { std::mem::zeroed() };
        let file = (&mut raw as *mut SQLiteVfsFile).cast();
        let code = unsafe { Vfs::xOpen(vfs, name.as_ptr(), file, flags, std::ptr::null_mut()) };
        require(
            code == ffi::SQLITE_CANTOPEN && unsafe { (*file).pMethods.is_null() },
            "unsupported open flags accepted",
        )?;
    }
    for path in [std::ptr::null(), missing.as_ptr()] {
        let mut raw: SQLiteVfsFile = unsafe { std::mem::zeroed() };
        let file = (&mut raw as *mut SQLiteVfsFile).cast();
        require(
            unsafe {
                Vfs::xOpen(
                    vfs,
                    path,
                    file,
                    base | ffi::SQLITE_OPEN_CREATE,
                    std::ptr::null_mut(),
                )
            } == ffi::SQLITE_CANTOPEN,
            "anonymous/missing file creation accepted",
        )?;
    }
    let mut raw: SQLiteVfsFile = unsafe { std::mem::zeroed() };
    let file = (&mut raw as *mut SQLiteVfsFile).cast();
    let mut out = 0;
    require(
        unsafe { Vfs::xOpen(vfs, name.as_ptr(), file, base, &mut out) } == ffi::SQLITE_OK
            && out == base,
        "supported open failed",
    )?;
    let original = data.buffer.borrow().as_ref().unwrap().bytes.clone();
    let result = (|| -> Result<(), JsValue> {
        let mut second: SQLiteVfsFile = unsafe { std::mem::zeroed() };
        require(
            unsafe {
                Vfs::xOpen(
                    vfs,
                    name.as_ptr(),
                    (&mut second as *mut SQLiteVfsFile).cast(),
                    base,
                    std::ptr::null_mut(),
                )
            } == ffi::SQLITE_BUSY,
            "duplicate handle accepted",
        )?;
        let mut output = [0xa5_u8; 8];
        for offset in [
            original.len() as i64,
            original.len() as i64 + 1,
            1_i64 << 32,
            i64::MAX,
        ] {
            output.fill(0xa5);
            require(
                unsafe { Io::xRead(file, output.as_mut_ptr().cast(), 8, offset) }
                    == ffi::SQLITE_IOERR_SHORT_READ
                    && output == [0; 8],
                "EOF/64-bit read did not zero-pad",
            )?;
        }
        require(
            unsafe {
                Io::xRead(
                    file,
                    output.as_mut_ptr().cast(),
                    8,
                    original.len() as i64 - 2,
                )
            } == ffi::SQLITE_IOERR_SHORT_READ
                && output[..2] == original[original.len() - 2..]
                && output[2..] == [0; 6],
            "partial EOF read differs",
        )?;
        let byte = [0x5a_u8];
        for offset in [LIMIT as i64, 1_i64 << 32, i64::MAX] {
            require(
                unsafe { Io::xWrite(file, byte.as_ptr().cast(), 1, offset) } == ffi::SQLITE_FULL,
                "oversize write accepted",
            )?;
            require(
                unsafe { Io::xTruncate(file, offset + i64::from(offset != i64::MAX)) }
                    == ffi::SQLITE_FULL,
                "oversize truncate accepted",
            )?;
        }
        require(
            unsafe { Io::xRead(file, output.as_mut_ptr().cast(), 8, -1) } == ffi::SQLITE_IOERR_READ,
            "negative read accepted",
        )?;
        require(
            unsafe { Io::xWrite(file, byte.as_ptr().cast(), 1, -1) } == ffi::SQLITE_IOERR_WRITE,
            "negative write accepted",
        )?;
        require(
            unsafe { Io::xTruncate(file, -1) } == ffi::SQLITE_IOERR_TRUNCATE,
            "negative truncate accepted",
        )?;
        require(
            data.buffer.borrow().as_ref().unwrap().bytes == original,
            "rejected operation changed bytes",
        )?;
        require(
            unsafe { Io::xTruncate(file, LIMIT as i64) } == ffi::SQLITE_OK,
            "exact size limit rejected",
        )?;
        require(
            unsafe { Io::xWrite(file, byte.as_ptr().cast(), 1, LIMIT as i64 - 1) }
                == ffi::SQLITE_OK,
            "last in-range byte rejected",
        )?;
        require(
            unsafe { Io::xTruncate(file, 2) } == ffi::SQLITE_OK,
            "shrink failed",
        )?;
        require(
            unsafe { Io::xWrite(file, byte.as_ptr().cast(), 1, 5) } == ffi::SQLITE_OK,
            "offset write failed",
        )?;
        let mut size = -1;
        require(
            unsafe { Io::xFileSize(file, &mut size) } == ffi::SQLITE_OK && size == 6,
            "buffered size incorrect",
        )?;
        output.fill(0xa5);
        require(
            unsafe { Io::xRead(file, output.as_mut_ptr().cast(), 6, 0) } == ffi::SQLITE_OK
                && output[..2] == original[..2]
                && output[2..6] == [0, 0, 0, 0x5a],
            "write gap not zero-filled",
        )?;
        require(
            unsafe { Io::xTruncate(file, 8) } == ffi::SQLITE_OK,
            "growth failed",
        )?;
        require(
            unsafe { Io::xRead(file, output.as_mut_ptr().cast(), 8, 0) } == ffi::SQLITE_OK
                && output[6..] == [0, 0],
            "truncate growth not zero-filled",
        )?;
        let mut reserved = -1;
        for (level, expected) in [
            (ffi::SQLITE_LOCK_SHARED, 0),
            (ffi::SQLITE_LOCK_RESERVED, 1),
            (ffi::SQLITE_LOCK_EXCLUSIVE, 1),
        ] {
            require(
                unsafe { Io::xLock(file, level) } == ffi::SQLITE_OK,
                "lock upgrade failed",
            )?;
            require(
                unsafe { Io::xCheckReservedLock(file, &mut reserved) } == ffi::SQLITE_OK
                    && reserved == expected,
                "reserved lock state incorrect",
            )?;
        }
        require(
            unsafe { Io::xUnlock(file, ffi::SQLITE_LOCK_NONE) } == ffi::SQLITE_OK,
            "unlock failed",
        )?;
        require(
            unsafe { Io::xCheckReservedLock(file, &mut reserved) } == ffi::SQLITE_OK
                && reserved == 0,
            "unlock state incorrect",
        )?;
        for flag in [
            ffi::SQLITE_ACCESS_EXISTS,
            ffi::SQLITE_ACCESS_READ,
            ffi::SQLITE_ACCESS_READWRITE,
        ] {
            for (path, expected) in [(name.as_ptr(), 1), (missing.as_ptr(), 0)] {
                let mut exists = -1;
                require(
                    unsafe { Vfs::xAccess(vfs, path, flag, &mut exists) } == ffi::SQLITE_OK
                        && exists == expected,
                    "access result incorrect",
                )?;
            }
        }
        require(
            unsafe { Vfs::xDelete(vfs, name.as_ptr(), 0) } == ffi::SQLITE_IOERR_DELETE,
            "VFS delete unexpectedly supported",
        )?;
        require(
            unsafe { Io::xFileControl(file, 9999, std::ptr::null_mut()) } == ffi::SQLITE_NOTFOUND
                && unsafe { Io::xDeviceCharacteristics(file) } == 0
                && Io::METHODS.iVersion == 1
                && Io::METHODS.xShmMap.is_none()
                && Io::METHODS.xFetch.is_none(),
            "unsupported capabilities advertised",
        )?;
        require(
            super::super::read(&data.name)? == original,
            "unsynced callbacks changed OPFS",
        )?;
        Ok(())
    })();
    // Dirty close must not publish; this registration is restored only by this
    // test harness before the subsequent SQL contract checks.
    unsafe {
        Io::xClose(file);
    }
    let mut closed: SQLiteVfsFile = unsafe { std::mem::zeroed() };
    require(
        unsafe {
            Vfs::xOpen(
                vfs,
                name.as_ptr(),
                (&mut closed as *mut SQLiteVfsFile).cast(),
                base,
                std::ptr::null_mut(),
            )
        } == ffi::SQLITE_CANTOPEN,
        "dirty registration reopened without reconstructing published state",
    )?;
    require(
        super::super::read(&data.name)? == original,
        "dirty close published",
    )?;
    let mut borrow = data.buffer.borrow_mut();
    let buffer = borrow.as_mut().unwrap();
    buffer.bytes = original;
    buffer.dirty = false;
    buffer.writes = 0;
    result
}

pub(super) fn sql(db: &Connection) -> rusqlite::Result<()> {
    for sql in [
        "PRAGMA journal_mode=WAL",
        "PRAGMA journal_mode=DELETE",
        "PRAGMA journal_mode=TRUNCATE",
        "PRAGMA journal_mode=PERSIST",
        "PRAGMA journal_mode=OFF",
        "PRAGMA synchronous=OFF",
        "PRAGMA cache_spill=ON",
        "PRAGMA temp_store=FILE",
        "ATTACH ':memory:' AS other",
        "VACUUM",
    ] {
        if db.execute_batch(sql).is_ok() {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    let journal: String = db.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    let sync: i32 = db.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
    let spill: i32 = db.query_row("PRAGMA cache_spill", [], |r| r.get(0))?;
    let temp: i32 = db.query_row("PRAGMA temp_store", [], |r| r.get(0))?;
    if journal != "memory" || sync != 2 || spill != 0 || temp != 2 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    db.execute_batch("BEGIN; UPDATE writable SET payload=x'ffff' WHERE id=1; ROLLBACK;")?;
    Ok(())
}
