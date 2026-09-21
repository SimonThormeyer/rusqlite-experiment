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
This SPA still uses IndexedDB.

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
