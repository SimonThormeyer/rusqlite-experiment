//! Page-context JSPI/OPFS and SQLite callback probes. No worker.
// JSPI is experimental in the pinned wasm-bindgen release.
#![allow(deprecated)]

mod readonly;
mod sqlite;

thread_local! {
    static SQLITE_BUSY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct SqliteGuard;

impl SqliteGuard {
    fn enter() -> Result<Self, JsValue> {
        if SQLITE_BUSY.with(|busy| busy.replace(true)) {
            return Err(js_sys::Error::new("SQLite probe already running").into());
        }
        Ok(Self)
    }
}

impl Drop for SqliteGuard {
    fn drop(&mut self) {
        SQLITE_BUSY.with(|busy| busy.set(false));
    }
}

use js_sys::{Promise, Uint8Array, futures::jspi_block_on_promise as suspend};
use wasm_bindgen::prelude::*;
use web_sys::{
    File, FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetDirectoryOptions,
    FileSystemGetFileOptions, FileSystemWritableFileStream, WritableStream,
};

// Confine all probe files to a dedicated directory, separate from application data.
fn directory() -> Result<FileSystemDirectoryHandle, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("requires a Window"))?;
    let root: FileSystemDirectoryHandle =
        suspend(&window.navigator().storage().get_directory())?.dyn_into()?;
    let options = FileSystemGetDirectoryOptions::new();
    options.set_create(true);
    suspend(&root.get_directory_handle_with_options("rusqlite-jspi-probe", &options))?.dyn_into()
}

/// Replace one probe file with binary data; resolve only after closing the stream.
#[wasm_bindgen(jspi)]
pub fn write(name: &str, bytes: Vec<u8>) -> Result<(), JsValue> {
    let options = FileSystemGetFileOptions::new();
    options.set_create(true);
    let file: FileSystemFileHandle =
        suspend(&directory()?.get_file_handle_with_options(name, &options))?.dyn_into()?;
    let stream: FileSystemWritableFileStream = suspend(&file.create_writable())?.dyn_into()?;
    let result = (|| {
        suspend(&stream.write_with_u8_array(&bytes)?)?;
        suspend(&WritableStream::close(&stream))?;
        Ok(())
    })();
    if result.is_err() {
        // Best effort: release the writer but preserve the original failure.
        let _ = suspend(&WritableStream::abort(&stream));
    }
    result
}

/// Read bytes from a newly opened file snapshot, preserving storage errors.
#[wasm_bindgen(jspi)]
pub fn read(name: &str) -> Result<Vec<u8>, JsValue> {
    let handle: FileSystemFileHandle = suspend(&directory()?.get_file_handle(name))?.dyn_into()?;
    let file: File = suspend(&handle.get_file())?.dyn_into()?;
    Ok(Uint8Array::new(&suspend(&file.array_buffer())?).to_vec())
}

#[wasm_bindgen(jspi)]
pub fn delete(name: &str) -> Result<(), JsValue> {
    suspend(&directory()?.remove_entry(name))?;
    Ok(())
}

/// A controlled pending Promise makes event-loop progress observable even on fast storage.
#[wasm_bindgen(jspi)]
pub fn wait_for(promise: Promise) -> Result<(), JsValue> {
    suspend(&promise)?;
    Ok(())
}
