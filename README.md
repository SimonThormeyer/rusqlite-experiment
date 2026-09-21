# Rusqlite Experiment

How far can we get writing a TODO application that works both on the command line and the internet, backed by Rusqlite?

## Direction and current status

We plan to re-create the browser experiment with an OPFS-backed SQLite VFS using
wasm-bindgen's JS Promise Integration (JSPI). The aim is to keep SQLite and the
Rust application in the page's WASM instance, allowing synchronous SQLite VFS
callbacks to reach Promise-based storage operations without the worker message
facade used in the earlier `sahpool` experiment.

This is a staged investigation. A [standalone JSPI/OPFS probe](jspi-probe/README.md)
passed its original storage checks in a Firefox 156.0 (aarch64) session.
The SQLite `xOpen` suspension check also passed twice in browser tests.
The read-only OPFS `xRead` probe also passed twice in browser tests.
A storage-only write/truncate/visibility probe also passed a browser test.
See the [recorded results](jspi-probe/README.md#browser-verification).
The TODO application still uses `sqlite-wasm-vfs`'s `relaxed-idb` backend with the
`multipleciphers-relaxed-idb` VFS. The native CLI is unchanged.
A minimal buffered writable VFS probe also passed twice in browser tests.
The writable-database page-reload check also passed twice in browser tests.
Exclusive Web Locks now protect the read-only and writable SQLite exports; a
two-tab ownership check passed twice in browser tests.
The owner-tab termination check also passed twice in browser tests.
A controlled uncommitted-transaction interruption check also passed twice, with
the owner paused before COMMIT or any VFS write.
Crash-safe storage and SPA integration are not implemented.
The combined publication-interruption and recovery suite passed twice, followed
by two successful writable regression runs. It covers dirty buffers, staged stream writes,
close boundaries, rejected operations, and reopening complete database versions.
Real-quota exhaustion and each of seven process-termination boundaries passed
twice, completing the combined stage within its
experimental scope. We retain the bounded whole-file design. See the
[complete procedure and recovery decision](jspi-probe/FINAL-RECOVERY.md).

### Proposed architecture

```text
SPA -> Promise-returning WASM entry point
    -> Rust application / rusqlite / embedded SQLite
    -> synchronous VFS callback -> JSPI suspension -> Promise-based OPFS operation
```

The starting references are the [wasm-bindgen JSPI guide](https://wasm-bindgen.github.io/wasm-bindgen/reference/jspi.html)
and its [JSPI + OPFS example](https://wasm-bindgen.github.io/wasm-bindgen/examples/jspi-opfs.html).
JSPI exports return Promises to JavaScript; synchronous Rust callees can suspend
through `jspi_block_on_promise` or a suspending import. This requires a JSPI entry
boundary; making an export `async` alone does not establish one. Suspension lets
the event loop run, so shared state must be protected against reentrant access.

The OPFS example demonstrates file operations, not a SQLite VFS. Our experiment
must establish byte-oriented random access, journaling, locking, and persistence
semantics before treating it as a database backend. In particular, a writable
stream's write/close behavior must be reconciled with SQLite's visibility and
sync requirements. Whether this approach improves performance remains unmeasured.

### Incremental plan

Each stage should produce a reviewable result before moving to the next. The
documentation and standalone storage feasibility stages are complete. Stage 3
has a verified [callback probe](jspi-probe/README.md#sqlite-callback-check), including
two successful runs, and a [read-only OPFS
probe](jspi-probe/README.md#read-only-opfs-check)
verified in two successful runs. The next storage-only probe checks offset writes,
truncation, visibility on close, and abort before implementing SQLite write
callbacks; one successful run is recorded. A buffered writable VFS passed twice
with a memory rollback journal; reopening in a fresh WASM instance after page
reload passed twice in a separate check. Cross-tab exclusive ownership is
verified in two successful runs. Writable failure recovery with locking enabled
also passed twice. Automatic lock release when the owning tab closes is
verified in two successful runs. Closing an owner during an uncommitted
transaction before COMMIT or any VFS write also passed twice. Interruption with
buffered VFS writes and staged publication now passed twice in the combined suite.
Actual quota exhaustion and seven process-termination checks each passed twice.
The bounded recovery decision is
recorded; the supported-VFS-contract audit and stages 4–6 remain future work. The
original storage probe's repeatability and other browsers remain unverified.

1. **Document the direction (complete).** Separate the running IndexedDB
   baseline and historical findings from the proposed JSPI experiment.
2. **Prove JSPI and OPFS access (complete in Firefox 156.0).** Build a minimal page-context Rust/WASM probe,
   independent of SQLite. Choose and record compatible wasm-bindgen crates and
   CLI versions; the existing dependency versions are not a validated JSPI setup.
   Verify binary write/read, reopen after reload, deletion, and rejected storage
   operations. Demonstrate event-loop progress during suspension.
3. **Prove the SQLite VFS boundary.** Choose whether to adapt an existing VFS or
   implement one, and verify suspension through the actual rusqlite/SQLite callback
   path. Start with one unencrypted connection and a documented journal mode.
   Define open/read/write/truncate/size/sync/delete behavior, short reads, and
   mapping storage failures to SQLite errors. Establish a locking strategy that
   rejects unsupported concurrent access, including another tab. Do not assume
   WAL or multiple connections work. Verify transactions, rollback, and reopen
   persistence, and investigate interrupted writes before claiming durability.
4. **Connect the TODO application.** Preserve the shared model and native CLI.
   Audit every browser path that can perform storage I/O, including initialization,
   schema application, export, encryption inspection, and connection cleanup.
   Make the necessary entry points suspendable, update the SPA to await them,
   and serialize operations on each connection across suspension. Verify CRUD,
   reload, error recovery, and a consistent database download.
5. **Re-run the encryption experiment.** Establish how SQLite3 Multiple Ciphers
   wraps the new VFS instead of assuming the old VFS name or utility API applies.
   Test encrypting, reopening with correct/incorrect keys, changing/removing keys,
   and exporting. Record compatibility findings separately from the old backend.
6. **Evaluate and document the result.** Add browser regression coverage and
   compare correctness, responsiveness, and measured performance with the baseline.
   Record supported browsers, remaining limitations, and a decision on replacing
   IndexedDB. Decide separately whether existing browser data needs migration;
   choosing the same database name does not move IndexedDB data into OPFS.

### Requirements to validate for the new approach

The completed combined investigation covers buffered-write interruption, interruption
during OPFS publication, publication failures, and recovery design into one stage.
The [publication recovery
suite](jspi-probe/README.md#publication-interruption-and-recovery-check)
passed twice. The real-quota and browser-process-termination checks in the
[final batch](jspi-probe/FINAL-RECOVERY.md) each passed twice.
The recovery decision retains the bounded experimental whole-file design;
production crash durability and an associated persistent recovery protocol
remain outside that claim. Simulated failures and document teardown do not
establish power-loss durability.
Then come the supported-VFS-contract audit, SPA integration, encryption checks,
and browser/performance evaluation described above.

wasm-bindgen's JSPI support is experimental. Use a JSPI-capable browser and HTTPS
or localhost for OPFS; consult the linked guide's runtime table when selecting
test browsers. JSPI requires reference types and exception-handling support and
cannot be combined with WASM threads/shared memory in this toolchain. Build
post-processing must accept exception-handling instructions; the upstream OPFS
example disables wasm-pack's release `wasm-opt` step.

The standalone probe pins its own dependencies and disables release `wasm-opt`;
the application's build remains unchanged. The probe reports a startup error
for unsupported environments; a fallback backend is not part of it. JSPI yields
during storage waits, but CPU-bound SQLite work on the page can still affect UI
responsiveness.

## Running the current experiment

These commands run the existing IndexedDB implementation, not the planned JSPI VFS.

### Native

```sh
$ cargo run -p cli -- --help
Usage: todo-list [OPTIONS]

Options:
  -p, --db-path <DB_PATH>
          Path to the database

          [default: $HOME/.local/share/todo-list/db.sqlite]

  -l, --log [<LEVEL>]
          Enable logging

          If this flag is set without an explicit level argument, defaults to "info".

          [possible values: trace, debug, info, warn, error]

  -h, --help
          Print help (see a summary with '-h')
```

### WASM

#### Setup

- `rustup target add wasm32-unknown-unknown`
- install `wasm-bindgen-cli`
- install `wasm-pack`, Bun, and `miniserve` (used by the Makefile)

#### Build

```sh
make serve-spa
```

## Baseline notes and historical findings

These observations concern the existing IndexedDB implementation and the earlier
worker-based OPFS experiment. They are not results for the planned JSPI VFS.

### WASM/Browser Interop

1. Wasm-bindgen is perfectly happy to call `&mut self` methods on JS objects.
1. Downloading an unencrypted database requires some support in the SPA, but the implementation is straightforward overall.

### Encryption Compatibility

Rusqlite has Cargo features for sqlcipher but not for Sqlite3 Multiple Ciphers (sqlite3-mc).

- Browser implementation: sqlite3-mc on WASM; the native cipher compatibility
  trial below used the SQLCipher command-line tool
- Unencrypted databases start with `b"SQLite format 3\0"` in their first 16 bytes

In the command-line trial below, SQLite3 Multiple Ciphers and SQLCipher could not
read the same encrypted database with the tested settings. This records a result
for those versions and settings, not proof that interoperability is impossible.
The new VFS does not by itself resolve cipher-format compatibility.

```sh
$ sqlcipher --version
3.49.2 2025-05-07 10:39:52 17144570b0d96ae63cd6f3edca39e27ebd74925252bbaf6723bcb2f6b486alt1 (64-bit) (SQLCipher 4.9.0 community)
$ sqlite3mc --version
3.51.2 2026-01-09 17:27:48 b270f8339eb13b504d0b2ba154ebca966b7dde08e40c3ed7d559749818cb2075 (64-bit)
$ # the db is encrypted
$ hexyl --length 16 experiment.sqlite
┌────────┬─────────────────────────┬─────────────────────────┬────────┬────────┐
│00000000│ aa 31 44 40 c0 28 98 45 ┊ 26 32 d6 91 8a 5f e3 f6 │×1D@×(×E┊&2×××_××│
└────────┴─────────────────────────┴─────────────────────────┴────────┴────────┘
$ # sqlite3mc can decrypt it
$ sqlite3mc experiment.sqlite
SQLite version 3.51.2 2026-01-09 17:27:48 (SQLite3 Multiple Ciphers 2.2.7)
Enter ".help" for usage hints.
sqlite> pragma cipher='sqlcipher';
sqlcipher
sqlite> pragma key='asdf';
ok
sqlite> select * from sqlite_master limit 0;
sqlite> select title, is_completed, description from todo_lists inner join todo_items on todo_lists.id = todo_items.list_id;
asdf|0|a
asdf|1|s
asdf|0|d
asdf|1|f
sqlite> .quit
$ # sqlcipher cannot decrypt it
$ sqlcipher experiment.sqlite
SQLite version 3.49.2 2025-05-07 10:39:52 (SQLCipher 4.9.0 community)
Enter ".help" for usage hints.
sqlite> pragma cipher='sqlcipher';
sqlite> pragma key='asdf';
ok
sqlite> select * from sqlite_master limit 0;
2026-02-26 17:17:15.769: ERROR CORE sqlcipher_page_cipher: hmac check failed for pgno=1
2026-02-26 17:17:15.769: ERROR CORE sqlite3Codec: error decrypting page 1 data: 1
2026-02-26 17:17:15.769: ERROR CORE sqlcipher_codec_ctx_set_error 1
Parse error: file is not a database (26)
sqlite> .quit
```

### IndexedDB VFS

This approach involves embedding sqlite into the compiled wasm program; database access happens in-process and the database is ultimately backed by IndexedDB.

**Conclusion**: Encryption at rest **works** via the IndexedDB VFS.

There's a roundabout path to enabling it: you can't just do `rusqlite::Connection::open(name)` when you create your connection. Instead you have to use `rusqlite::Connection::open_with_flags_and_vfs`, manually specifying the flags and a VFS name comprising a normal vfs name with an encryption prefix. In this case, that's `"multipleciphers-relaxed-idb"`.

See the [demo](#demo) to see this in action.

#### Sqlcipher Incompatibility

sqlite3mc and sqlcipher did not interoperate in the [recorded compatibility trial](#encryption-compatibility).
Cross-device encrypted database portability is not an initial goal of the JSPI
experiment; compatibility must be tested if that becomes a requirement.

But more than that, sqlite3mc on wasm appears to be incompatible with _itself_ when using sqlcipher compat mode. This took quite a lot of debugging to determine. Ultimately the solution is simple: use the default ciphering (or possibly some alternatives do work; not tested). At that point everything works as expected.

### Previous `sahpool` OPFS VFS

This earlier approach embedded SQLite into the WASM program and ran it in a
separate web worker with a message facade. It introduced communication overhead,
but no benchmarks established how its performance compared with IndexedDB.

- Worked unencrypted; performance relative to IndexedDB was not measured
- Got moderately quickly to the same state as the current IDB-backed implementation, to wit: encrypting a blank DB works, and operating on a freshly-encrypted DB works, but once the DB is locked, establishing a new unencrypted connection tends to fail for mysterious reasons.
- Working with OPFS is a real pain for development: once a database has been locked, it is a real pain to get it to unlock again, or even to just delete the whole thing. OPFS eliminates many out of context tools like the filesystem which would make it simple to just delete a DB and start over again.
- The requirement to communicate via channels and replicate the whole program's interface dramatically increases the maintenance burden, at least for programs of this size.
- This experiment targets only the `JS -> IPC -> Rust/WASM in the worker` flow. We didn't even attempt `Rust/WASM -> JS -> IPC -> Rust/WASM in the worker`.
- Most recent commit: [`7e547c4`](https://github.com/coriolinus/rusqlite-experiment/tree/7e547c4d14453cf2900ff24de1925476e799d4c7)

**Historical conclusion**: the worker facade increased maintenance complexity.
That motivates testing direct JSPI-backed OPFS access in the page. It does not
establish that OPFS itself is unsuitable or that the new approach will be faster.

## Demo

This is the existing IndexedDB/encryption demo and the acceptance baseline for
the later JSPI integration. Its recorded outputs do not demonstrate JSPI support.

1. Run the demo with `make serve-spa` and then open a browser at `localhost:8080`.
1. The database is unencrypted and accessible; you can create a list and some items.
1. Click the "Download Database" button for a local copy of the sqlite DB

- ```sh
  $ hexyl --length 16 todo_app.sqlite
  ┌────────┬─────────────────────────┬─────────────────────────┬────────┬────────┐
  │00000000│ 53 51 4c 69 74 65 20 66 ┊ 6f 72 6d 61 74 20 33 00 │SQLite f┊ormat 30│
  └────────┴─────────────────────────┴─────────────────────────┴────────┴────────┘
  ```
- ```sql
  sqlite> .mode table
  sqlite> select * from todo_lists join todo_items on todo_lists.id = todo_items.list_id;
  +----+-------+---------------------+----+---------+-------------+--------------+---------------------+
  | id | title |     created_at      | id | list_id | description | is_completed |     created_at      |
  +----+-------+---------------------+----+---------+-------------+--------------+---------------------+
  | 1  | asdf  | 2026-02-25 13:54:22 | 1  | 1       | 1           | 0            | 2026-02-25 13:54:24 |
  | 1  | asdf  | 2026-02-25 13:54:22 | 2  | 1       | 2           | 1            | 2026-02-25 13:54:25 |
  | 1  | asdf  | 2026-02-25 13:54:22 | 3  | 1       | 3           | 0            | 2026-02-25 13:54:27 |
  +----+-------+---------------------+----+---------+-------------+--------------+---------------------+
  ```

4. Click the "Set Encryption Key" button to encrypt the DB; remember your passphrase!
1. Refresh the page to drop knowledge of the passphrase
1. Enter the passphrase in the popup modal on load
1. Note that everything works
1. Click the "Download Database" button for a local copy of the sqlite DB

- ```sh
  $ hexyl --length 16 todo_app.sqlite
  ┌────────┬─────────────────────────┬─────────────────────────┬────────┬────────┐
  │00000000│ 5c f3 5c bb 09 e8 32 00 ┊ a9 b1 7e 4c 98 3b 20 99 │\×\×_×20┊××~L×; ×│
  └────────┴─────────────────────────┴─────────────────────────┴────────┴────────┘
  ```
- Using [sqlite3mc](https://utelle.github.io/SQLite3MultipleCiphers/docs/installation/install_overview/):

  ```sql
  sqlite> PRAGMA key='my secret passphrase that I set on the website';
  sqlite> .mode table
  sqlite> select * from todo_lists join todo_items on todo_lists.id = todo_items.list_id;
  +----+-------+---------------------+----+---------+-------------+--------------+---------------------+
  | id | title |     created_at      | id | list_id | description | is_completed |     created_at      |
  +----+-------+---------------------+----+---------+-------------+--------------+---------------------+
  | 1  | asdf  | 2026-02-25 13:54:22 | 1  | 1       | 1           | 0            | 2026-02-25 13:54:24 |
  | 1  | asdf  | 2026-02-25 13:54:22 | 2  | 1       | 2           | 1            | 2026-02-25 13:54:25 |
  | 1  | asdf  | 2026-02-25 13:54:22 | 3  | 1       | 3           | 0            | 2026-02-25 13:54:27 |
  +----+-------+---------------------+----+---------+-------------+--------------+---------------------+
  ```
