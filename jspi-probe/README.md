# JSPI + OPFS feasibility probe

This standalone experiment exercises Promise-based OPFS from synchronous Rust
functions on the browser's main page. Additional checks exercise SQLite's `xOpen`
callback and read an immutable SQLite fixture from OPFS through `xRead`.
A storage-only write-semantics check investigates the next prerequisites.
A minimal buffered writable VFS now tests publication through SQLite's `xSync`.
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

For the read-only step, click **Run OPFS read-only checks**. It copies the bundled
database fixture into OPFS, queries it through the read-only VFS, checks errors
and cleanup, and displays **PASS: all OPFS read-only checks completed**. It does
not reload the page. Run it twice and report the output and browser version.

For the storage-only write step, click **Run OPFS write semantics checks**. Keep the page
foregrounded and expect **PASS: all OPFS write semantics checks completed**.
Run it twice and report all output, including the `OBSERVED` line. This check
does not reload the page and does not write a SQLite database.

For the writable VFS step, click **Run writable SQLite checks**. Expect **PASS: all
writable SQLite checks completed**. Run it twice and report the output. It uses
fresh test files, one connection at a time, and a memory rollback journal. There
is no page reload or crash test.

For the reload step, click **Run writable SQLite reload checks**. The page
creates and commits a test database, reloads automatically, verifies it, and
deletes it. Expect **PASS: all writable SQLite reload checks completed**. Run it
twice and report the output. Keep the same hostname and port through the reload.

For the cross-tab step, click **Run cross-tab lock checks**. Allow the second tab
to open and keep both tabs open until it finishes. The helper tab closes itself
at completion; results appear in the original tab. Expect **PASS: all cross-tab
lock checks completed**. Run it twice and report the output. Both tabs must use
the same browser profile and origin. Also rerun **Run writable SQLite checks**
to exercise publication-failure recovery with the new locking enabled.

For the owner-lifecycle step, click **Run owner-tab termination checks**. Allow the
helper tab to open; the test closes it automatically while it owns the database.
Expect **PASS: all owner-tab termination checks completed** in the original tab.
Run it twice and report the output. Do not manually close either tab mid-test.

For the current step, click **Run uncommitted interruption checks**. Allow the
helper tab to open; the test closes it automatically after checking pending row
changes and before COMMIT. Expect **PASS: all uncommitted transaction interruption
checks completed** in the original tab. Run it twice and report the output.

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
The storage-only write-semantics probe passed a browser test using the
same pinned toolchain. A second successful run remains unverified.
The buffered writable VFS passed two browser tests with that toolchain.
The page-reload check passed twice using the existing Rust exports; no Rust or
build-setting changes were needed for this step.
The new Web Lock integration builds; three JavaScript lease tests pass using
Node's Web Locks implementation. The two-tab browser check passed twice. The
separate writable-check rerun with locking enabled also passed twice.
The owner-tab termination probe passed twice in browser tests. Its build,
JavaScript checks, and the three lease tests also pass.
The uncommitted-transaction interruption probe passed twice in browser
tests. Its build, JavaScript syntax checks, and Rust formatting checks also pass.

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
named copy and must not modify it while it is open. SQLite lock callbacks remain
no-ops; an exclusive Web Lock now wraps the entire read-only export, as described
below. This is cooperative whole-database ownership, not SQLite lock-level support. Mutating VFS
operations reject with `SQLITE_READONLY`; journal and WAL files are unsupported.
SQLite closes before VFS unregistration and before the file snapshot is dropped.
The original file-access exports remain independent of the SQLite guard and Web
Lock, so callers must leave the fixture unchanged during a run.

This check advances the read side only. The separate writable probe below adds
buffered writes; durable sync, persistent journaling, crash recovery, encryption,
and app integration remain future work. Reopening is tested within one page;
querying after a page reload is not part of this check.

## OPFS write semantics check

The Rust export uses synchronous functions with JSPI suspension for all storage
operations. Each run owns a uniquely named binary file and removes it afterward.
Writers use `keepExistingData: true`; fresh-reader checks reopen the handle and
obtain a new `File`. The checks assert:

- An offset write preserves the untouched prefix and suffix.
- Fresh readers see the previous contents after the write Promise resolves but
  before the stream closes, then see the changed contents after close resolves.
- Truncating shrinks the file, growing it fills the extension with zeros, and
  writing beyond EOF fills the gap with zeros. Visibility is checked before and
  after closing each writer.
- Explicit abort discards both pending truncation and writing.
- Writing on a closed stream rejects without changing the file; opening another
  writer after abort/rejection works.
- Truncating to zero publishes an empty file after close.

The probe also reports whether a `File` obtained before the first write remains
readable, returns updated contents, or rejects after close. This is an observation,
not a portability assumption; a future writable VFS must refresh its read handles.
The recorded run passed the assertions and the old File rejected with
`AbortError`. Failures include the operation phase and expected/actual byte arrays.

In the recorded run, a fresh `File` did not see pending writes until the stream
closed. A future `xWrite`/`xRead` implementation therefore needs an explicit design
for read-your-writes, publication, refreshing snapshots, and reopening the writer.
This check does **not** establish that close is a durable `xSync`, that
abort provides SQLite transaction rollback, or that multi-file journal updates
are crash-safe. No SQLite write callbacks, journaling, concurrent writers, quota
failure simulation, or crash tests are added in this step.

## Buffered writable SQLite check

`jspi-writable-probe` implements one main file using a whole-file Rust buffer,
limited to 1 MiB. It loads the file from OPFS when the export starts. `xWrite` and
`xTruncate` update that buffer, including zero-filled extensions; `xRead` and
`xFileSize` consult it. This intentionally trades memory and copying costs for a
small, inspectable read-your-writes implementation. It does not yet combine the
previous range-reader with a dirty-page overlay.

`xSync` writes the complete buffer to an OPFS stream, waits for close, and verifies
the bytes through a freshly acquired `File`. Only then does it mark the buffer
clean. This is **publication, not a proven durable fsync**. `xClose` does not
publish. Publication failure poisons the buffer to prevent retries within the
same connection; subsequent use requires a fresh VFS and connection. Actual
failure during close may have an ambiguous publication outcome.

The caller pre-creates an empty, uniquely named file. Only main-database opens
are supported; journal/temporary files and WAL are rejected. SQLite is configured
with `journal_mode=MEMORY`, `synchronous=FULL`, and `cache_spill=OFF`. The memory
journal permits ordinary rollback but provides no recovery after a crash. Lock
callbacks are no-ops: the test owns its file and permits one SQLite probe per WASM
instance. An exclusive Web Lock now rejects competing SQLite exports for the
same filename across tabs; shared readers and concurrent writers remain unsupported.

The browser checks cover:

- Direct `xWrite`/`xRead` calls proving pending bytes are readable below SQLite's
  pager cache while OPFS still contains the old file; `xSync` publication and
  `xTruncate` back to an empty file.
- Event-loop progress during a controlled wait inside `xSync`, plus rejection
  of an overlapping SQLite probe.
- Creating a database, inserting binary data, committing, rolling back an update,
  and checking exact rows and `integrity_check`.
- Closing an uncommitted deletion, then opening a fresh VFS and connection that
  reloads only the OPFS bytes. The committed rows must remain and verification
  must leave published bytes unchanged.
- Injecting a rejected Promise before a SQL-triggered publication. It must reach
  rusqlite as `SQLITE_IOERR_FSYNC` (1034) with the original JS cause, leave the
  previous file unchanged, and allow recovery with a fresh VFS/connection.

The last failure is injected before any OPFS mutation; it does not simulate disk
failure, quota exhaustion, partial writes, or a failed close. Test files are
removed after the run. Persistent journaling, performance, and encryption remain
future steps; the cross-tab ownership check passed twice. The separate reload check tests this
writable path across page lifetimes.

## Writable SQLite reload check

Before reload, the existing writable export creates the database, commits its
known binary rows, exercises rollback, and closes with an uncommitted deletion.
The page records the published file's length and SHA-256. A sessionStorage
checkpoint contains only the filename, length, digest, page-instance token, and
log lines; it contains no database bytes or serialized WASM state.

After `location.reload()`, the normal module initialization creates a fresh WASM
instance. The check requires a different page-instance token and reads the
database from OPFS. It compares the length and digest, then invokes the existing
export in verification mode: no seeding, schema creation, or data insertion.
That export checks the committed rows, binary payloads, and `integrity_check`.
A rejecting publication hook catches unexpected attempts to publish during
verification. A second digest check confirms the stored bytes remain unchanged.
Finally, the test deletes the database and requires `NotFoundError` on a read.

Successful runs clear the checkpoint. Failures after reload may leave the test
database in `rusqlite-jspi-probe`; the checkpoint is cleared to avoid an automatic
retry loop. This check passed twice in browser tests. A normal reload after a
completed commit is not a process-crash, power-loss, or interrupted-commit test.

## Cross-tab exclusive ownership check

The read-only and writable SQLite exports acquire an exclusive Web Lock before
reading OPFS or registering/opening SQLite. The key includes the probe directory
and exact bare filename. Acquisition uses `ifAvailable: true`: a contending export
rejects immediately with `DatabaseBusyError` and `sqliteCode=5` (`SQLITE_BUSY`).
That code is reported at the entry boundary, before SQLite opens a connection.
Missing Web Locks support is a startup error for these exports, not an unlocked
fallback.

The Rust guard holds the lease across all JSPI suspensions. On normal return or
error, it releases after connections, VFS registration, and buffer/snapshot state
have been dropped, and waits for release completion. SQLite's internal lock
callbacks remain no-ops because this experiment permits only exclusive ownership
for the entire invocation. The in-instance SQLite guard still rejects overlapping
probes before entering SQLite.

The browser check opens `lock-peer.html` in a second tab with a fresh WASM instance.
Tab A pauses at a SQL-triggered publication while retaining ownership. Tab B calls
the Rust writable and read-only exports directly; both must report busy. The test
checks unchanged bytes, releases tab A, and requires tab B to acquire and query
the committed database successfully. A validation error after acquisition in tab
B must also release ownership so tab A can reopen. Messages verify sender,
origin, and a unique run token; timeouts surface a failed or closed helper tab.

This mechanism coordinates cooperating exports only. The raw storage helpers,
external code, and callers using a different lock name can bypass it; test setup
and cleanup must run while neither tab owns the database. The separate termination
probe below now tests page-close lock release. Shared readers, SQLite lock
escalation, process crashes, and journal recovery remain outside these checks.
No database is recovered by forcibly stealing a lock.

The lease helper has standalone tests (Node with `navigator.locks` required):

```sh
node --test jspi-probe/locks.test.mjs
```

Those tests cover contention, different filenames, release/reacquisition, error
cleanup, and filename validation. They do not replace the two-tab browser test.

## Owner-tab termination check

The main tab first creates and commits the known database, closes the connection,
and retains its published bytes for comparison. The helper then acquires the
same Web Lock, opens SQLite, verifies rows and integrity, and suspends on a test
gate **before closing its connection**. The gate never resolves. The helper is
only reading committed data and has no pending publication or write transaction.

The main tab confirms a normal SQLite open rejects with `SQLITE_BUSY`. It then
queues an exclusive Web Lock request and inspects `navigator.locks.query()` to
confirm both the held lock and pending request exist before closing the helper.
The test sends no release message and does not resolve the helper's gate. Browser
teardown must release ownership and grant the queued request. After releasing
that test lease, the surviving tab opens SQLite, verifies rows and integrity,
compares the database bytes with the pre-test copy, and removes the file.

Queueing is test-only: normal database exports still fail immediately on
contention. Timeouts fail the check; cleanup does not delete a database while
ownership remains unavailable. Two browser runs passed. This is ordinary
tab-close lifecycle cleanup, not a browser-process crash, power failure, or
interrupted commit, and it does not establish crash durability.

## Uncommitted transaction interruption check

This reuses the owner-tab termination protocol with a different hold point. After
opening and verifying the committed database, the helper executes `BEGIN IMMEDIATE`,
updates row 1's binary payload, deletes row 2, and inserts row 3. Rust queries and
checks the changed rows, verifies that autocommit is off, and requires zero VFS
writes, zero publications, and a clean VFS buffer before reporting that it is held.
With this small transaction and `cache_spill=OFF`, the changes stay in SQLite's
pager, not the OPFS file or the VFS buffer.

The surviving tab compares OPFS bytes with its pre-transaction copy while the
helper is still open. It then confirms exclusive ownership, queues for the lock,
and closes the helper without resolving its gate or requesting a rollback.
After browser lock release, the survivor reopens the database and checks the
original committed rows, binary payloads, integrity, and unchanged file bytes.
The uncommitted update, deletion, and insertion must all be absent.

Two browser runs passed. This check interrupts an active transaction
**before COMMIT and before any VFS write/publication**. It does not exercise
dirty VFS buffer recovery, a partially written OPFS stream, an interrupted close,
journal recovery, or browser-process crash durability.

## Publication interruption and recovery check

Click **Run publication recovery checks** and allow the helper tab. Run twice
and report the entire output. Also rerun **Run writable SQLite checks**, since
normal `xSync` now uses the same publication routine as this suite.

This combines the next four investigations into one stage: dirty VFS buffers,
interrupted publication, publication failures, and recovery design. The suite
passed twice, followed by two successful writable regression runs.
The WASM release build, JavaScript syntax checks, Rust formatting, and seven Node
tests (three lock tests and four publication-orchestration tests) pass. The
publication unit tests use modeled storage; only the browser run tests OPFS.
The first browser attempt passed the reference COMMIT but failed the
write-after-abort assertion. That assertion incorrectly required a truthy
rejection cause: abort without a reason can yield an `undefined` rejection,
reproduced with Node's WritableStream in a regression test. The corrected check
requires a captured rejection, SQLite code 1034, an own `cause` property, and
identical rejection values, including `undefined`. Two browser reruns passed;
failure diagnostics also report each of those conditions separately.

The suite first saves exact old/new reference database bytes around a successful
UPDATE/DELETE/INSERT transaction. Every interrupted COMMIT is paused inside
`xSync`, after SQLite has called `xWrite`, at one of six boundaries:

| Boundary | Expected reopened contents |
| --- | --- |
| Before opening the writable stream | Exact old database |
| After opening the stream | Exact old database |
| After writing half the buffered bytes | Exact old database |
| After writing/truncating all bytes, before close | Exact old database |
| Immediately after initiating close | Complete old or complete new database |
| After close resolves, before SQLite receives success | Exact new database |

The helper navigates to a fresh document/WASM instance between cases and closes
on the final case. The controller first verifies a contender receives
`SQLITE_BUSY`, queues a Web Lock waiter, and then destroys the owner without
resolving its gate or asking Rust to roll back. It requires lock handoff, exact
reference bytes, expected SQL rows, `integrity_check`, read-only verification,
and a subsequent successful publication whenever the old version survived.
The close-started case races the browser's close operation; it does not prove
termination occurred while the underlying close was still in progress.

The same suite exercises real browser rejections of write, truncate, and close
on an explicitly aborted stream. These are invalid-stream failures, not disk
faults during otherwise valid operations. An injected `QuotaExceededError`
checks error propagation without consuming storage quota. Each must
produce `SQLITE_IOERR_FSYNC` with the original cause, preserve old bytes, release
ownership, and allow a fresh connection to commit successfully. A rejection
injected after successful close must instead retain the new complete database:
a COMMIT error can have an ambiguous outcome once publication has happened.

`publication.js` is shared by normal writable probes and this suite. It replaces
the whole file with two sequential writes, truncates to the buffered length,
awaits close, and aborts on failure where possible. Rust then compares a fresh
read with the buffer. Hooks only provide observation/fault boundaries; normal
calls use no-op hooks. The memory rollback journal and 1 MiB limit are unchanged.

This suite alone did not complete the combined stage. The final batch below
subsequently added real-quota and manually confirmed process-termination checks, all
passing twice. The recovery decision retains the bounded experimental
whole-file design; a persistent durability protocol is deferred. These results
do not establish power-loss durability or a general durable SQLite commit guarantee.

## Final combined-stage batch

The [final recovery procedure](FINAL-RECOVERY.md) brings the final checks
together: bounded actual OPFS quota exhaustion under a reduced Firefox test-profile
quota, and seven process-termination boundaries with downloadable checkpoints.
The dedicated [recovery page](http://localhost:8081/final-recovery.html) preserves
old/new hashes, verifies SQL rows/integrity and unchanged bytes after restart,
and exercises a subsequent COMMIT and fresh reopen. Forced process termination
is manually confirmed; a page cannot distinguish it from a reload on its own.

The decision in that procedure retains the whole-file experimental backend within
its documented limits, with two passes for every final check. Any failed
recovery blocks integration; no persistent durability protocol
is claimed. The WASM release build and ten local Node tests pass, covering
locks, publication rejection
behavior, checkpoint validation, and allowed recovery outcomes.
The first quota attempt stopped at the estimate precheck (reported 10 GiB),
before exhausting storage. The precheck now logs the estimate instead; the
independent 48 MiB allocation cap remains, and a real quota rejection is still
required. The later completed-run summary records two successful actual-quota runs.

## Browser verification

The [first TODO application slice](TODO-SLICE.md) now connects the shared
`todo-list` crate's schema and model to the audited VFS, with a separate
create/read page and reload/failure checks. Its build passes and the automated
browser sequence passed twice (13 suspension ticks in the output).
The manual demo-form checks and post-integration contract rerun passed.
The [slice results](TODO-SLICE.md#recorded-browser-results) record the full output.
This starts application integration without replacing the baseline SPA.
The slice now adds shared-model item editing, completion toggles, and deletion.
Its expanded checks reload twice to verify both saved edits and deletion;
the expanded automated browser checks passed twice. Manual editing, completion,
deletion, and reload checks also passed, completing this step. The full output
is
recorded in [the slice results](TODO-SLICE.md#item-mutation-results).
The separate TODO slice now adds list selection and adding items to existing
lists, with selection retained across page reloads in the same tab. The expanded
browser checks passed twice; the manual selection, reload, list isolation, and
empty-list addition checks passed. This extension is complete.
List renaming and deletion, including cascade removal of items and creation
after deleting the last list, are also complete. The three-reload browser sequence
passed twice, and the manual UI checks passed.
A database download extension now captures committed bytes under exclusive
ownership and validates integrity without publication. Dedicated export checks
and CRUD regressions each passed twice. Native SQLite verified the downloaded
file's integrity and rows. A later live edit left
the downloaded snapshot unchanged and persisted after reopening the demo.
The database download step is complete.

The [writable VFS contract audit](VFS-CONTRACT.md) adds checked 64-bit callback
offsets, stricter opens, local lock-state reporting, and explicit rejection of
unsupported SQL settings/attachments. Its **Run VFS contract checks** passed
twice; writable/cross-tab regressions for this change also each passed twice,
completing the audit's browser acceptance. See the contract
document for the supported operations and exact run instructions.

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

### OPFS write semantics results

The storage-only write-semantics checks passed once. Repeatability remains
unverified.

```text
PASS: all OPFS write semantics checks completed
PASS: offset write preserved prefix/suffix; fresh readers saw old bytes before close and new bytes after close
OBSERVED: pre-write File after close: read rejected: JsValue(AbortError: The operation was aborted.  )
PASS: truncate shrank and grew the file; growth was zero-filled and visible after close
PASS: write beyond EOF extended the file with a zero-filled gap
PASS: explicit abort discarded both truncate and write
PASS: closed-stream write rejected; reopening after abort/rejection succeeded
PASS: truncate to zero published an empty file after close
PASS: test file removed; no SQLite writes or durability claims
```

The buffered writable design accounts for publication on close and invalidation
of old File snapshots. These storage-only observations establish visibility in
the tested browser, not SQLite transaction or crash-durability guarantees.

### Buffered writable SQLite results

The checks passed **twice**. Results:

```text
PASS: all writable SQLite checks completed
PASS: direct xWrite/xRead saw pending bytes; xSync published them; xTruncate published an empty file
PASS: SQL commits, rollback, and close with an uncommitted transaction and integrity_check (7 xWrite calls; 5 publications)
PASS: xSync suspended with event-loop progress (13 ticks); overlapping SQLite probe rejected
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: reopening discarded buffered state; committed rows survived and uncommitted deletion did not
PASS: SQL publication rejection mapped to SQLITE_IOERR_FSYNC; pre-publication contents unchanged
PASS: fresh VFS/connection recovered after injected publication failure
PASS: test files removed; memory journal only, no crash-durability claim
```

This verifies buffered read-your-writes, publication, ordinary SQL commit and
rollback, reopening from OPFS, recovery from a failure injected before publication,
and repeatability. These runs reopened a fresh VFS/connection in the same page;
the subsequent results below verify reopening after page reload as well.
These writable runs preceded the Web Lock integration. Cross-tab exclusive
ownership is verified separately below; persistent journaling and crash durability
remain unverified.

### Writable SQLite reload results

The checks passed **twice**. Results:

```text
PASS: all writable SQLite reload checks completed
PASS: direct xWrite/xRead saw pending bytes; xSync published them; xTruncate published an empty file
PASS: SQL commits, rollback, and close with an uncommitted transaction and integrity_check (7 xWrite calls; 5 publications)
PASS: committed database closed before reload (16384 bytes)
Reloaded with a fresh page and WASM instance
PASS: OPFS database length and SHA-256 survived page reload
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: committed rows and binary payloads survived; uncommitted deletion did not
PASS: verification left OPFS database bytes unchanged
PASS: database removed after reload verification; no crash-durability claim
```

This verifies that the committed 16,384-byte database survives a normal page
reload and is queryable in a fresh WASM instance. Its hash remained unchanged,
the expected committed rows were present, and the uncommitted deletion was absent.
It does not establish recovery from interrupted commits or process crashes.

### Cross-tab ownership results

The checks passed **twice**. Results:

```text
PASS: all cross-tab lock checks completed
PASS: second tab initialized its own WASM instance
PASS: second-tab writable and read-only opens rejected with SQLITE_BUSY while owner held the lock
PASS: rejected contenders left database bytes unchanged
PASS: owner completed SQL publication and released its lock
PASS: second tab acquired after release and verified committed rows and integrity_check
PASS: lock released after second-tab error; original tab reopened successfully
PASS: test database removed; cooperative exclusive access only, no crash-recovery claim
```

This verifies cooperative exclusion between the SQLite probes, unchanged data
after contention, and release/reacquisition after success and a validation error.
The writable regression results below additionally verify recovery after an
injected publication failure with locking enabled. Owner-tab termination is
verified separately below. Noncooperating storage access, persistent journaling,
and crash recovery are not covered by these results.

### Writable regression with locking enabled

The writable SQLite checks passed **twice** after Web Lock integration. Results:

```text
PASS: all writable SQLite checks completed
PASS: direct xWrite/xRead saw pending bytes; xSync published them; xTruncate published an empty file
PASS: SQL commits, rollback, and close with an uncommitted transaction and integrity_check (7 xWrite calls; 5 publications)
PASS: xSync suspended with event-loop progress (12 ticks); overlapping SQLite probe rejected
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: reopening discarded buffered state; committed rows survived and uncommitted deletion did not
PASS: SQL publication rejection mapped to SQLITE_IOERR_FSYNC; pre-publication contents unchanged
PASS: fresh VFS/connection recovered after injected publication failure
PASS: test files removed; memory journal only, no crash-durability claim
```

Successful reacquisition after the injected publication failure verifies that the
error path releases its Web Lock. This completes the requested writable regression
check for the locking change; it does not establish crash recovery.

### Owner-tab termination results

The checks passed **twice**. Results:

```text
PASS: all owner-tab termination checks completed
PASS: committed and closed database before owner-tab test (16384 bytes)
PASS: helper tab verified committed rows and holds an open connection and exclusive lock
PASS: surviving tab received SQLITE_BUSY before owner termination
PASS: surviving tab queued for the held lock without stealing ownership
PASS: closing owner tab released its lock and granted the queued waiter
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: committed rows and integrity_check survived; published bytes are unchanged
PASS: test database removed; no commit was interrupted and no crash-durability claim
```

Browser teardown released the helper's exclusive lock without resolving its gate
or requesting application cleanup. The queued survivor acquired ownership, then
reopened and verified the unchanged committed database. This verifies tab-close
lock lifecycle behavior and repeatability, not interrupted-commit recovery or
browser-process crash durability.

### Uncommitted transaction interruption results

The checks passed **twice**. Results:

```text
PASS: all uncommitted transaction interruption checks completed
PASS: committed and closed database before owner-tab test (16384 bytes)
PASS: helper verified uncommitted UPDATE/DELETE/INSERT rows inside an active transaction
PASS: pending changes remain in SQLite pager (0 xWrite calls; 0 publications)
PASS: OPFS still contains the exact last committed bytes before owner termination
PASS: surviving tab received SQLITE_BUSY before owner termination
PASS: surviving tab queued for the held lock without stealing ownership
PASS: closing owner tab released its lock and granted the queued waiter
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: committed rows and integrity_check survived; published bytes are unchanged
PASS: uncommitted update, deletion, and insertion were absent after reopening
PASS: test database removed; transaction interrupted before COMMIT, no publication/crash-durability claim
```

The committed database remained byte-for-byte unchanged, and reopening recovered
the original rows after tab teardown discarded the uncommitted pager state.
This verifies interruption before COMMIT and before any VFS write. The subsequent
publication suite below exercises dirty VFS buffers and stream staging.

### Publication interruption and recovery results

The publication suite passed **twice**, followed by **two successful writable
SQLite regression runs**. Publication results:

```text
PASS: all publication interruption and recovery checks completed
PASS: reference COMMIT produced a distinct complete database with expected rows and integrity_check
PASS: write-after-abort: SQLITE_IOERR_FSYNC preserved cause; complete old database reopened; lock and connection recovered
PASS: truncate-after-abort: SQLITE_IOERR_FSYNC preserved cause; complete old database reopened; lock and connection recovered
PASS: close-after-abort: SQLITE_IOERR_FSYNC preserved cause; complete old database reopened; lock and connection recovered
PASS: synthetic-quota: SQLITE_IOERR_FSYNC preserved cause; complete old database reopened; lock and connection recovered
PASS: after-close-rejection: SQLITE_IOERR_FSYNC preserved cause; complete new database reopened; lock and connection recovered
PASS: before-open: owner terminated, lock reacquired, complete old bytes and rows verified; integrity_check and recovery succeeded
PASS: after-open: owner terminated, lock reacquired, complete old bytes and rows verified; integrity_check and recovery succeeded
PASS: after-half-write: owner terminated, lock reacquired, complete old bytes and rows verified; integrity_check and recovery succeeded
PASS: before-close: owner terminated, lock reacquired, complete old bytes and rows verified; integrity_check and recovery succeeded
PASS: close-started: owner terminated, lock reacquired, complete new bytes and rows verified; integrity_check and recovery succeeded
PASS: after-close: owner terminated, lock reacquired, complete new bytes and rows verified; integrity_check and recovery succeeded
PASS: test database removed; post-close errors can leave a committed result despite COMMIT rejection
SCOPE: close-started races completion; synthetic quota is not exhaustion; document/tab teardown is not process crash or power loss; persistent recovery design remains open
```

The writable regression output was:

```text
PASS: all writable SQLite checks completed
PASS: direct xWrite/xRead saw pending bytes; xSync published them; xTruncate published an empty file
PASS: SQL commits, rollback, and close with an uncommitted transaction and integrity_check (7 xWrite calls; 5 publications)
PASS: xSync suspended with event-loop progress (13 ticks); overlapping SQLite probe rejected
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: reopening discarded buffered state; committed rows survived and uncommitted deletion did not
PASS: SQL publication rejection mapped to SQLITE_IOERR_FSYNC; pre-publication contents unchanged
PASS: fresh VFS/connection recovered after injected publication failure
PASS: test files removed; memory journal only, no crash-durability claim
```

Before close, the tested interruptions preserved the exact old database. Both
close-started and after-close cases retained the exact new database. The
close-started observation does not establish that close was still pending when
the owner was destroyed. Rejection after successful close retained the new
database despite the SQLite error, demonstrating why callers must treat such a
COMMIT result as ambiguous. The final batch below completes the remaining checks
within the documented experimental scope.

### Final quota and process-termination results

All checks passed, with this completed-run summary:

```text
actual quota: 2/2
before-open: 2/2
after-open: 2/2
after-half-write: 2/2
before-close: 2/2
close-started: 2/2
after-close: 2/2
commit-returned: 2/2
```

Final case results:

```text
PASS: process-termination recovery check
PASS: commit-returned: complete new database survived process termination; lock reacquired, rows and integrity_check passed; bytes unchanged
PASS: subsequent COMMIT and fresh reopen succeeded on the recovered database
PASS: crash test database removed
SCOPE: forced shutdown is manually confirmed; close-started may have completed before termination; no power-loss guarantee
```

All eight cases passed twice, for 16 successful runs. The surviving version at
`close-started` is not recorded here. The combined stage is complete within its
declared scope. We retain the bounded experimental whole-file design and defer a
persistent durability protocol, as recorded in
[the recovery decision](FINAL-RECOVERY.md#recovery-decision-for-this-experiment).

### VFS contract results

The checks passed **twice**. Results:

```text
PASS: all VFS contract checks completed
PASS: invalid filenames rejected before storage or SQLite access
PASS: direct VFS contract checks: flags, single handle, 64-bit offsets, short reads, size limits, locks, access/delete, and capabilities
PASS: unsupported journal/sync/spill/temp settings, ATTACH, and VACUUM rejected; configured mode and rollback preserved
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: committed bytes unchanged; fresh VFS/connection reopened rows and integrity_check after rejected operations
PASS: contract fixture removed; pre-created main file only, memory journal, exclusive owner, 1 MiB limit
```

The writable SQLite and cross-tab lock checks each passed **twice** after these
changes. Results:

```text
PASS: all writable SQLite checks completed
PASS: direct xWrite/xRead saw pending bytes; xSync published them; xTruncate published an empty file
PASS: SQL commits, rollback, and close with an uncommitted transaction and integrity_check (7 xWrite calls; 5 publications)
PASS: xSync suspended with event-loop progress (12 ticks); overlapping SQLite probe rejected
PASS: fresh connection loaded committed rows from OPFS and integrity_check (0 xWrite calls; 0 publications)
PASS: reopening discarded buffered state; committed rows survived and uncommitted deletion did not
PASS: SQL publication rejection mapped to SQLITE_IOERR_FSYNC; pre-publication contents unchanged
PASS: fresh VFS/connection recovered after injected publication failure
PASS: test files removed; memory journal only, no crash-durability claim
```

```text
PASS: all cross-tab lock checks completed
PASS: second tab initialized its own WASM instance
PASS: second-tab writable and read-only opens rejected with SQLITE_BUSY while owner held the lock
PASS: rejected contenders left database bytes unchanged
PASS: owner completed SQL publication and released its lock
PASS: second tab acquired after release and verified committed rows and integrity_check
PASS: lock released after second-tab error; original tab reopened successfully
PASS: test database removed; cooperative exclusive access only, no crash-recovery claim
```

The contract audit and its required regressions are complete within the
documented experimental scope. Application integration remains the next stage.

This follows the [upstream OPFS example](https://wasm-bindgen.github.io/wasm-bindgen/examples/jspi-opfs.html),
with binary data and error propagation. Production-ready writable VFS semantics,
locking, crash durability, encryption, and database performance require subsequent
work and verification.
