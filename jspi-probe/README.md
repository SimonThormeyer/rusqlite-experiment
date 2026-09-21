# JSPI + OPFS feasibility probe

This standalone experiment exercises Promise-based OPFS from synchronous Rust
functions on the browser's main page. Additional checks exercise SQLite's `xOpen`
callback and read an immutable SQLite fixture from OPFS through `xRead`.
None uses a worker or changes the TODO application's IndexedDB backend.

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

For the callback boundary check, click **Run SQLite callback checks**. This does not
reload the page. Keep the tab foregrounded and expect **PASS: all SQLite callback
checks completed**, then run it again to check cleanup and repeatability.

For the current step, click **Run OPFS read-only checks**. It copies the bundled
database fixture into OPFS, queries it through the read-only VFS, checks errors
and cleanup, and displays **PASS: all OPFS read-only checks completed**. It does
not reload the page. Run it twice and report the output and browser version.

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
export names were checked. The storage and `xOpen` probes passed browser
verification as recorded below. The callback and read-only `xRead` checks each
passed twice.

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

## Read-only OPFS check

`jspi-readonly-probe` uses the VFS traits supplied by sqlite-wasm-rs to expose one
pre-existing, unencrypted fixture. It accepts only read-only main-database opens.
Before opening SQLite, Rust obtains an OPFS `File` snapshot without loading its
contents. Each `xRead` slices the requested byte range, suspends on
`Blob.arrayBuffer()`, and copies the bytes into SQLite's buffer. No whole-database
import into `memvfs` is involved.

The bundled `fixtures/readonly.sqlite` has 100 rows on 52 pages of 512 bytes.
It contains labels and binary payloads, with nonzero trailing bytes to distinguish
actual data from short-read zero padding. To regenerate it with Python 3.11+:

```sh
python3 jspi-probe/fixtures/generate.py
```

The checks cover:

- SQL row counts, aggregates, a known binary payload, and `PRAGMA integrity_check`,
  with an assertion that SQL caused reads at nonzero offsets.
- Timer progress during a controlled wait invoked inside the first `xRead`.
- A read-only SQL write rejection, and direct calls through the same VFS callback
  implementation at EOF and beyond EOF. These must preserve available bytes,
  zero-fill the rest, and return `SQLITE_IOERR_SHORT_READ`.
- Rejection of overlapping calls to either SQLite probe. Both now share an
  instance-wide guard, including while OPFS file acquisition is suspended.
- An injected rejected Promise on the second `xRead`, verified as the extended
  SQLite code `SQLITE_IOERR_READ` (266), with the original JS error as `cause`.
- Recovery using a fresh connection and file snapshot, unchanged fixture bytes,
  and removal of the test copy from OPFS.

The read-only VFS advertises `SQLITE_IOCAP_IMMUTABLE`. The test owns a uniquely
named copy and must not modify it while it is open. Lock callbacks are no-ops
under this assumption; this is **not cross-tab locking support**. Mutating VFS
operations reject with `SQLITE_READONLY`; journal and WAL files are unsupported.
SQLite closes before VFS unregistration and before the file snapshot is dropped.
The original file-access exports remain independent of the SQLite guard, so it
is the caller's responsibility to leave the fixture unchanged during a run.

This advances the read side only. Database creation, `xWrite`, durable sync,
journaling, crash recovery, encryption, and integration into the app remain
future work. Reopening is tested within one page; querying after a page reload
is not part of this check.

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
These callback results alone do not establish persistent SQLite storage in OPFS.

### Read-only OPFS results

The read-only checks passed **twice** after correcting
the short-read test buffers from inferred integer arrays to explicit byte arrays.
The initial failure was in the test harness: an eight-byte read filled only two
elements of an eight-element `i32` array. The callback's return code and bytes
were correct.

```text
PASS: all OPFS read-only checks completed
PASS: OPFS xRead suspended and resumed (12 ticks; 55 reads; 53 nonzero offsets)
PASS: fixture rows, binary payload, aggregate query, and integrity_check
PASS: read-only SQL rejected writes; EOF and beyond-EOF reads returned zero-padded SQLITE_IOERR_SHORT_READ
PASS: overlapping read-only and callback probes rejected
PASS: rejected Promise in xRead mapped to SQLITE_IOERR_READ with original cause
PASS: new connection reopened OPFS fixture and queried successfully after failure
PASS: OPFS fixture is byte-for-byte unchanged
PASS: test fixture removed; no database writes or journals implemented
```

This verifies querying the immutable OPFS fixture through suspending range reads,
short-read handling, read-error propagation, recovery, and repeatability. It does
not verify database writes, journaling, cross-tab locking, or crash durability.

This follows the [upstream OPFS example](https://wasm-bindgen.github.io/wasm-bindgen/examples/jspi-opfs.html),
with binary data and error propagation. Writable VFS semantics, locking, crash
durability, encryption, and database performance require subsequent work and
verification.
