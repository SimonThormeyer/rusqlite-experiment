# JSPI + OPFS feasibility probe

This standalone experiment exercises Promise-based OPFS from synchronous Rust
functions on the browser's main page. A second check exercises suspension through
a SQLite VFS callback. Neither check uses a worker or changes the TODO
application's IndexedDB backend.

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

For the next step, click **Run SQLite callback checks**. This check does not
reload the page. Keep the tab foregrounded and expect **PASS: all SQLite callback
checks completed**, then run it again to check cleanup and repeatability.

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

The callback probe also pins rusqlite **0.38.0** and sqlite-wasm-rs **0.5.2**,
without the SQLite3 Multiple Ciphers feature. Building embedded SQLite requires
a C compiler capable of targeting WASM (as for the baseline).

The release build succeeded with Rust **1.98.0**, wasm-pack **0.15.0**, and
wasm-bindgen CLI **0.2.128**. Rust formatting, JavaScript syntax, and generated
export names were checked. Both probes passed browser verification as
recorded below; the SQLite callback checks passed twice.

## SQLite callback check

The new probe registers `jspi-callback-probe`, an adapter over the existing
`memvfs`, without modifying that VFS. Its `xOpen` callback suspends on a supplied
Promise, reads and verifies a three-byte OPFS marker, then delegates the file open
to `memvfs`. The path under test is:

```text
JS -> JSPI Rust export -> rusqlite -> SQLite C -> Rust xOpen
   -> JSPI suspension / OPFS read -> resume xOpen -> SQLite -> rusqlite -> JS
```

After resumption, one unencrypted connection creates a table, inserts a value,
rolls back an update, and queries the original value. It uses `journal_mode=MEMORY`.
The callback count must be exactly one. A timer verifies event-loop progress
during the controlled wait inside `xOpen`.

The checks also attempt an overlapping invocation, a rejected Promise, and an
OPFS read of a missing marker. Overlap is rejected before entering SQLite. Both
callback failures return `SQLITE_CANTOPEN` to SQLite; the export verifies that
rusqlite received that code and reports the original JS error as `cause`.
A fresh successful invocation then checks recovery. No mutable state borrow is
held across suspension. Connections close before VFS unregistration, and the
memory database and OPFS marker are removed after use.

**This is a callback-boundary experiment, not an OPFS database VFS.** Database
bytes remain in memory. It does not establish suspension in page read/write
callbacks, persistent transactions, cross-tab locking, or crash durability.
The full VFS stage remains incomplete despite the successful callback checks.

## Browser verification

All original storage checks passed on 2026-09-21 in **Firefox 156.0 (aarch64)**
(before the SQLite check was added):

```text
PASS: binary round trip, shorter overwrite, and empty file
PASS: event loop progressed during controlled suspension (12 ticks)
PASS: rejected Promise propagated through synchronous Rust
Reloaded with a fresh WASM instance
PASS: binary data persisted across page reload
PASS: deletion and missing-file storage errors
PASS: storage operations recover after rejection; test file removed
```

This completes the standalone storage feasibility step for that browser. Repeatability of the original storage checks and other browsers remain unverified.

### SQLite callback results

The SQLite callback checks passed **twice**. Results:

```text
PASS: SQLite xOpen suspended and resumed with event-loop progress (13 ticks)
PASS: overlapping SQLite probe rejected before entering SQLite
PASS: OPFS marker read inside xOpen; SQL insert/query and rollback succeeded
PASS: rejected Promise in xOpen mapped to SQLITE_CANTOPEN with original cause
PASS: missing OPFS marker mapped to SQLITE_CANTOPEN with NotFoundError cause
PASS: fresh connection and SQL operations succeeded after callback failures
PASS: OPFS marker removed; SQLite database was memory-only
```

The narrow `xOpen` suspension boundary and repeatability check are verified.
These results do not establish persistent SQLite storage in OPFS.

This follows the [upstream OPFS example](https://wasm-bindgen.github.io/wasm-bindgen/examples/jspi-opfs.html),
with binary data and error propagation. Random-access VFS semantics, locking,
crash durability, encryption, and database performance require subsequent work
and verification.
