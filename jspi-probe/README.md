# JSPI + OPFS feasibility probe

This standalone experiment exercises Promise-based OPFS from synchronous Rust
functions on the browser's main page. It contains no SQLite or worker code and
does not change the TODO application's IndexedDB backend.

## Run it

From the repository root:

```sh
make serve-jspi-probe
```

Open [localhost:8081](http://localhost:8081) in a JSPI-capable browser and click
**Run checks (reloads page)**. Keep the tab in the foreground. The page writes
test data, reloads itself, verifies the data using a fresh WASM instance, then
deletes the test file. Successful completion displays **PASS: all checks completed**.
Run it again to check repeatability. Stop the server with Ctrl-C.

Prerequisites: Rust with the `wasm32-unknown-unknown` target, `wasm-pack`, and
`miniserve`. The first build may download the matching wasm-bindgen CLI.
For an already-built probe, serve it without rebuilding:

```sh
miniserve --interfaces 127.0.0.1 --port 8081 --index index.html jspi-probe
```

Use localhost or HTTPS for OPFS. The page checks for JSPI and OPFS support and
reports a startup error if either is unavailable. The browser support table is
in the [upstream JSPI guide](https://wasm-bindgen.github.io/wasm-bindgen/reference/jspi.html).

## What the checks establish

- Binary read/write of 4,096 bytes covering all byte values, including zero and
  non-UTF-8 bytes; shorter and empty overwrites truncate the original file.
- Promise-returning exports backed by plain Rust `fn` bodies using
  `jspi_block_on_promise` for storage operations.
- Event-loop progress while Rust is suspended on a controlled 150 ms Promise.
  This deliberately separate check avoids relying on storage being slow enough
  to observe a timer tick; it is not an OPFS performance measurement.
- Rejected Promises propagate through Rust with their error names intact.
- Bytes survive a real page reload at the same origin.
- Deletion works, missing-file reads/deletes reject with `NotFoundError`, and
  subsequent storage operations still succeed.

All data lives in the dedicated OPFS directory `rusqlite-jspi-probe`, with a
unique filename for each run. A sessionStorage checkpoint carries the filename
and results across reload, not the file contents. Successful runs remove their
test file; interrupted or failed runs may leave files in that directory.
Keep the same hostname and port through the reload because storage is origin-scoped.

## Toolchain and status

The probe has its own Cargo workspace and committed lockfile so the baseline's
dependencies stay unchanged. It pins wasm-bindgen **0.2.128** and js-sys/web-sys
**0.3.105**. wasm-pack selects the matching wasm-bindgen CLI; the older CLI on
PATH should not be used directly. Release `wasm-opt` is disabled because the JSPI
glue uses exception-handling instructions.

The release build succeeded with Rust **1.98.0**, wasm-pack **0.15.0**, and
wasm-bindgen CLI **0.2.128**. Rust formatting, JavaScript syntax, and generated
export names were checked. Browser verification passed as recorded below.

## Browser verification

All page checks passed on 2026-09-21 in **Firefox 156.0 (aarch64)**:

```text
PASS: binary round trip, shorter overwrite, and empty file
PASS: event loop progressed during controlled suspension (12 ticks)
PASS: rejected Promise propagated through synchronous Rust
Reloaded with a fresh WASM instance
PASS: binary data persisted across page reload
PASS: deletion and missing-file storage errors
PASS: storage operations recover after rejection; test file removed
```

This completes the standalone feasibility step for that browser. Repeatability and other browsers remain unverified.

This follows the [upstream OPFS example](https://wasm-bindgen.github.io/wasm-bindgen/examples/jspi-opfs.html),
with binary data and error propagation. It does not validate SQLite callbacks,
random-access VFS semantics, locking, crash durability, encryption, or database
performance. Those belong to subsequent steps.
