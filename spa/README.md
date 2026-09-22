# Encrypted JSPI TODO application

The default SPA now uses the validated JSPI/OPFS VFS with SQLite3 Multiple
Ciphers (`chacha20`). SQLite and the shared Rust TODO model execute in the
page's WASM instance. Browser acceptance checks passed on 2026-09-22.

## Build and serve

```sh
make serve-spa
```

Open [the application](http://127.0.0.1:8080/). `make spa` builds without serving;
`make spa-check` additionally typechecks and runs the session adapter tests.
The build requires the existing Rust/WASM toolchain, wasm-pack, Bun, and
miniserve; typechecking also uses `tsc`. The application uses the probe's pinned
`encryption` feature build in `jspi-probe/pkg-encryption/`, not the old FFI.
The Bun build bundles generated glue and imported JS snippets and copies the
matching WASM binary. `spa/out/` is the complete deployable directory.

The preserved IndexedDB UI can be built/served with `make spa-indexeddb` /
`make serve-spa-indexeddb` (port 8082). Its Rust FFI and the native CLI are unchanged.
To inspect previous IndexedDB data, serve that baseline on the exact original
scheme, host, and port instead; the convenience 8082 origin is distinct.
No existing data is moved, deleted, or converted by the new application.

## Data and password lifecycle

The application uses `todo-app-encrypted.sqlite` inside the existing
`rusqlite-jspi-probe` OPFS directory, separate from all probe fixtures and the
unencrypted `todo-application-slice.sqlite` demo. OPFS is origin-specific: data on
127.0.0.1:8081 does not appear on 127.0.0.1:8080 or localhost:8080.

A missing or empty file prompts for a new password and confirmation. Creation
checks under the exclusive lock that no nonempty database exists, then commits
the shared schema into an encrypted file. A nonempty file prompts for unlock;
plaintext is explicitly refused and opaque/corrupt data is never automatically
overwritten. If initialization publishes an empty file but fails before schema
publication, setup can retry. If a failure occurs after publication, inspection
prompts to unlock the already-created database.

Passwords are held only in the live `Session` and passed to each operation.
The app writes no passwords to localStorage, sessionStorage, URLs, logs, or files.
It stores only the selected list ID in sessionStorage. Lock clears the password,
model snapshots and form fields; reload starts locked. Restoring from the browser's
back/forward cache triggers reload. Strings are not guaranteed to be zeroized by
JavaScript/WASM, and browser password-manager behavior is outside this storage policy.

Encrypted databases stay encrypted permanently. Changing to a nonempty password
is supported. Unlocking does not decrypt the stored file. There is no plaintext
conversion, encryption-removal control, import/migration, or password recovery.
Downloads contain committed ciphertext for all lists/items and require the
password current at export time; later password changes do not alter old downloads.

## Integration architecture

- `backend.ts` wraps the actual JSPI exports in a typed, guarded session. It
  rejects overlapping actions and lock requests while a call is in flight.
- `state.ts` validates plain list/item snapshots. No live Rust `Database`,
  `TodoList`, or `Item` object is retained by JavaScript or freed by UI handlers.
- `main.ts` serializes whole UI actions, disables controls during suspension, and
  updates displayed rows after successful storage calls. Item fields are saved
  explicitly with **Save item**; list creation supports empty lists.
- `app_state` reads the summaries and selected list under one ownership lease,
  avoiding a mixed overview when another tab changes the database. It checks
  schema and integrity. Missing selections fall back to the latest list.
- Existing CRUD/export entry points accept an optional key; omission preserves
  the unencrypted probe API. The SPA always provides a nonempty key.
- Each operation opens, configures, and closes a fresh connection while holding
  the reentrancy guard and exclusive Web Lock. The cipher wrapper is destroyed
  before the underlying VFS registration/data. The existing single-poll adapter
  still depends on the shared model doing synchronous rusqlite work internally.

The UI checks secure context, JSPI, OPFS, and Web Locks before initialization.
Contention shows a retryable message. Wrong-key/unreadable errors clear the
session. Publication failures require explicit unlock and inspection, because an
error after close may have committed. Any failed password change clears credentials
rather than guessing which password is current. Writes are never automatically
retried; **Reload saved data** rereads through a fresh connection.

The supported contract remains one owner, a 1 MiB whole-file buffer, MEMORY
journal, FULL synchronous setting, disabled cache spill, and memory temp storage.
Persistent journals, WAL, larger databases, SQLCipher interoperability, and
power-loss durability are not established by this integration.

## Local verification

The encrypted and default probe release builds pass, as do the preserved
IndexedDB FFI/bundle build and native CLI check. Strict SPA TypeScript checking,
five session adapter tests (22 assertions), and all ten existing storage helper
tests pass. Generated HTML asset references and matching WASM files were checked.
Browser integration checks and manual acceptance passed, as recorded below.

## Browser acceptance

1. Run [integration checks](http://127.0.0.1:8080/checks.html) twice. Each run reloads
   once and cleans up random `app-check-*.sqlite` fixtures. It uses the same
   session adapter and WASM package as the UI, with public test passwords.
2. In the actual app, create a password-protected database, create two empty
   lists, add/edit/complete/delete items, rename a list, and switch lists.
   Reload: unlock must be required and the selected list/data must return.
3. Lock; try an incorrect password, then the correct one. Confirm failed unlock
   reveals no rows and does not prevent a successful retry.
4. Change the password. Lock/reload: the old password must fail and the new one
   must restore the data. Check confirmation mismatch and empty-password rejection.
5. Download, then edit live data. The saved file must remain unchanged. It is
   ciphertext and cannot be queried by ordinary SQLite without cipher support.
6. Open another app tab, unlock, and verify updates appear after **Reload saved
   data**. Change the key in one tab; the other tab's next read should require
   unlocking with the new key. Use disposable lists to check deleting the last
   list and creating another without losing the database.
7. Rerun the TODO slice/export checks and encryption boundary checks on the probe
   origin after this shared API change.

The integration sequence covers encrypted empty initialization, existing-file
protection, wrong passwords, CRUD and no-op/invalid requests, rejected publications,
event-loop progress, overlap/lock refusal, Web Lock contention, rejected and
successful key changes, independent ciphertext export, reload hash/model checks,
and deletion/recreation. It does not automate the DOM interactions above; those
remain checks. Failed reload verification retains its checkpoint/fixture.

## Recorded integration acceptance

On 2026-09-22, the integration sequence passed twice. Manual app checks and one
rerun each of the TODO, export, and encryption probe suites also passed.

Manual checks covered encrypted setup/unlock, list/item CRUD, reload persistence,
password changes, and encrypted downloads. Acceptance of the integrated SPA is
complete within the existing experimental contract. This does not establish
additional browser support, performance improvement, migration, or production
durability. Broader browser coverage and the performance comparison are out of
scope. Existing capability checks and recorded tested-browser evidence remain.
Performance remains unmeasured. The final assessment and replacement/migration
decision remain.