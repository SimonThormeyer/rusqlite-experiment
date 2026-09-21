# Rusqlite Experiment SPA

A single-page app designed to showcase the use case where:

- A Rust crate embeds Sqlite via Rusqlite and presents a storage interface
- That Rust crate is compiled to wasm
- A JS application uses the Rust code.

## Current implementation and planned direction

The SPA currently calls the Rust/WASM bindings directly and stores its database
using the `multipleciphers-relaxed-idb` VFS. It does not yet use JSPI or OPFS.

The next experiment will use a JSPI-backed OPFS VFS in the page's WASM instance.
The staged plan and upstream references are in the [project
README](../README.md#incremental-plan).
First comes a standalone storage probe, then a minimal SQLite integration; the
SPA will be adapted only after those work. The [standalone probe](../jspi-probe/README.md)
passed its storage checks in a Firefox 156.0 (aarch64) session. A new
SQLite callback check also passed twice in browser tests; the SPA is unchanged.
A read-only OPFS `xRead` probe also passed twice in browser tests, separate
from this application's build and storage.
The storage-only probe also passed its OPFS write/truncate/visibility checks;
a separate buffered writable SQLite probe also passed twice in browser tests.
Its page-reload verification check also passed twice in browser tests.
Exclusive Web Locks now wrap the standalone read-only and writable probes;
their two-tab ownership check passed twice in browser tests.
The writable regression checks with locking enabled also passed twice.
The standalone owner-tab termination check also passed twice in browser tests.
A follow-up check interrupting an uncommitted transaction before COMMIT or any
VFS write also passed twice; the application remains unchanged.
This SPA still uses IndexedDB.
The standalone publication interruption and recovery suite passed twice, followed
by two successful writable regression runs. Actual quota exhaustion and all
seven process-termination checks passed twice.
The [final recovery batch](../jspi-probe/FINAL-RECOVERY.md) is complete within its
experimental scope; the decision retains the bounded whole-file design without
a power-loss durability claim. SPA integration follows the completed VFS contract audit.
The [contract audit](../jspi-probe/VFS-CONTRACT.md) now defines the supported
single-file policy and fixes callback gaps; contract checks passed twice.
Writable and cross-tab regressions for those changes also each passed twice,
completing the audit's browser acceptance checks.
The SPA has not yet adopted those changes.
A separate [TODO integration page](../jspi-probe/TODO-SLICE.md) now exercises the
same Rust schema/model over JSPI and OPFS: initialization and one list/item
create/read flow, including reopening. Its automated browser checks passed twice;
the manual demo-form checks and post-integration contract rerun passed.
It is served with the probe, while this IndexedDB SPA remains the baseline.
The separate page now also offers item editing, completion changes, and deletion
through the shared model. The expanded automated browser checks passed twice;
the manual UI checks passed, completing this extension.
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

During that later integration, database operations that can suspend will return
Promises and must be awaited. Existing async CRUD calls are a starting point,
but currently synchronous operations such as `Database.export()` and `set_key()`
also need an audit. UI actions must serialize access to a connection while an
operation is suspended, show pending/error states, and avoid freeing objects that
an in-flight call still uses. Plain in-memory accessors need not become async.

The eventual demo should cover list/item CRUD, reload persistence, encryption and
unlocking, and database download. Browser capability checks and readable startup
errors belong in that integration. The initial probe will require a JSPI-capable
browser and a secure context (HTTPS or localhost). Existing IndexedDB data will
not automatically appear in OPFS; migration is a separate decision.

## Running the current SPA

From the repository root, run `make serve-spa`, then open
`http://localhost:8080`. See [setup requirements](../README.md#setup).
This still builds and serves the IndexedDB baseline. Use `make serve-jspi-probe`
for the separate JSPI probe.

## Files

### In this directory

- `index.html`: landing page, pure scaffolding
- `style.css`: basic styling to improve the UI
- `main.ts`: application core

### Imported during bundling

- `ffi/pkg/ffi.d.ts` (from the repository root): generated TypeScript declarations
  describing the bindings; not bundled or copied into `spa` by the build target
- `ffi.js`: generated JavaScript glue that loads and calls `ffi_bg.wasm`
- `ffi_bg.wasm`: compiled Rust and embedded SQLite; copied into the served output

The Makefile generates these artifacts with `wasm-pack --target web` and bundles
the SPA with Bun. JSPI toolchain and build settings currently apply only to the
separate probe; adapting this SPA remains future work.
