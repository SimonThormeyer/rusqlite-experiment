//! Storage semantics only: no SQLite write or sync callbacks.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use web_sys::{
    File, FileSystemCreateWritableOptions, FileSystemFileHandle, FileSystemWritableFileStream,
    WritableStream,
};

fn bytes(file: &File) -> Result<Vec<u8>, JsValue> {
    Ok(Uint8Array::new(&super::suspend(&file.array_buffer())?).to_vec())
}

fn check(name: &str, expected: &[u8], phase: &str) -> Result<(), JsValue> {
    // Reopen the handle and obtain a fresh File on every visibility check.
    let actual = super::read(name)?;
    if actual != expected {
        return Err(js_sys::Error::new(&format!(
            "{phase}: expected {expected:02x?}, got {actual:02x?}"
        ))
        .into());
    }
    Ok(())
}

fn writer(handle: &FileSystemFileHandle) -> Result<FileSystemWritableFileStream, JsValue> {
    let options = FileSystemCreateWritableOptions::new();
    options.set_keep_existing_data(true);
    super::suspend(&handle.create_writable_with_options(&options))?.dyn_into()
}

fn put(stream: &FileSystemWritableFileStream, offset: u32, data: &[u8]) -> Result<(), JsValue> {
    super::suspend(&stream.seek_with_u32(offset)?)?;
    super::suspend(&stream.write_with_u8_array(data)?)?;
    Ok(())
}

// Release the stream on both success and failure, preserving the original error.
fn edit(
    handle: &FileSystemFileHandle,
    commit: bool,
    operation: impl FnOnce(&FileSystemWritableFileStream) -> Result<(), JsValue>,
) -> Result<FileSystemWritableFileStream, JsValue> {
    let stream = writer(handle)?;
    let result = operation(&stream).and_then(|()| {
        super::suspend(&if commit {
            WritableStream::close(&stream)
        } else {
            WritableStream::abort(&stream)
        })?;
        Ok(())
    });
    if result.is_err() {
        let _ = super::suspend(&WritableStream::abort(&stream));
    }
    result?;
    Ok(stream)
}

/// Exercise offset writes, truncate, visibility on close, and explicit abort.
/// The caller seeds a unique file and removes it after this function completes.
#[wasm_bindgen(jspi)]
pub fn opfs_write_semantics(name: String) -> Result<String, JsValue> {
    let baseline: &[u8] = &[10, 20, 30, 40, 50, 60, 70, 80];
    check(&name, baseline, "initial fixture")?;
    let handle: FileSystemFileHandle =
        super::suspend(&super::directory()?.get_file_handle(&name))?.dyn_into()?;
    let old: File = super::suspend(&handle.get_file())?.dyn_into()?;
    let mut log = Vec::new();
    let patched: &[u8] = &[10, 20, 0, 255, 128, 60, 70, 80];
    let closed = edit(&handle, true, |stream| {
        put(stream, 2, &[0, 255, 128])?;
        check(&name, baseline, "before close: offset write")
    })?;
    check(&name, patched, "after close: offset write")?;
    log.push("PASS: offset write preserved prefix/suffix; fresh readers saw old bytes before close and new bytes after close".to_string());

    // Old File objects can become unreadable after changes. Record the outcome;
    // the VFS must obtain a fresh File rather than rely on an old snapshot.
    let observation = match bytes(&old) {
        Ok(data) if data == baseline => "original bytes".to_string(),
        Ok(data) if data == patched => "updated bytes".to_string(),
        Ok(data) => format!("other bytes {data:02x?}"),
        Err(error) => format!("read rejected: {error:?}"),
    };
    log.push(format!(
        "OBSERVED: pre-write File after close: {observation}"
    ));

    let short: &[u8] = &[10, 20, 0];
    edit(&handle, true, |stream| {
        super::suspend(&stream.truncate_with_u32(3)?)?;
        check(&name, patched, "before close: shrink")
    })?;
    check(&name, short, "after close: shrink")?;
    let grown: &[u8] = &[10, 20, 0, 0, 0, 0, 0];
    edit(&handle, true, |stream| {
        super::suspend(&stream.truncate_with_u32(7)?)?;
        check(&name, short, "before close: grow")
    })?;
    check(&name, grown, "after close: grow")?;
    log.push(
        "PASS: truncate shrank and grew the file; growth was zero-filled and visible after close"
            .into(),
    );

    let gap: &[u8] = &[10, 20, 0, 0, 0, 0, 0, 0, 0, 0, 90, 195];
    edit(&handle, true, |stream| {
        put(stream, 10, &[90, 195])?;
        check(&name, grown, "before close: write beyond EOF")
    })?;
    check(&name, gap, "after close: write beyond EOF")?;
    log.push("PASS: write beyond EOF extended the file with a zero-filled gap".into());

    edit(&handle, false, |stream| {
        super::suspend(&stream.truncate_with_u32(1)?)?;
        put(stream, 0, &[99])?;
        check(&name, gap, "before abort")
    })?;
    check(&name, gap, "after abort")?;
    log.push("PASS: explicit abort discarded both truncate and write".into());

    let rejected = match closed.write_with_u8_array(&[1_u8]) {
        Err(_) => true,
        Ok(promise) => super::suspend(&promise).is_err(),
    };
    if !rejected {
        return Err(js_sys::Error::new("write on closed stream unexpectedly succeeded").into());
    }
    check(&name, gap, "after rejected write on closed stream")?;
    edit(&handle, true, |stream| put(stream, 0, &[42]))?;
    let recovered: &[u8] = &[42, 20, 0, 0, 0, 0, 0, 0, 0, 0, 90, 195];
    check(&name, recovered, "reopened writer after abort/rejection")?;
    log.push(
        "PASS: closed-stream write rejected; reopening after abort/rejection succeeded".into(),
    );

    edit(&handle, true, |stream| {
        super::suspend(&stream.truncate_with_u32(0)?)?;
        check(&name, recovered, "before close: truncate to zero")
    })?;
    check(&name, &[], "after close: truncate to zero")?;
    log.push("PASS: truncate to zero published an empty file after close".into());
    Ok(log.join("\n"))
}
