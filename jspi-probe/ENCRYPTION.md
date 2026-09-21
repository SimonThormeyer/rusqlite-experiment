# Encryption before SPA integration

Encryption validation precedes integration of the actual SPA.
The baseline SPA/FFI remains on IndexedDB. The accepted unencrypted TODO slice
and its database are unchanged; this probe is not an encrypted application UI.

## Build and run

```sh
make jspi-encryption
# If the probe server is not already running:
make serve-jspi-probe
```

Open [encryption.html](http://127.0.0.1:8081/encryption.html) on the existing probe
origin. Run **Run encryption checks (reloads page)** twice and report the output.
The page uses public fixture keys and random `encryption-check-*.sqlite` files;
no user password is requested or persisted. The reload checkpoint contains only
the fixture name, expected rows, ciphertext hash, and progress log. Public test
keys are constants in the test module, not a proposed key-storage mechanism.
After successful reload verification, all fixtures are removed. A failed reload
retains its fixture/checkpoint for investigation; do not clear it before reporting.

The Cargo `encryption` feature enables `sqlite-wasm-rs = 0.5.2`'s `sqlite3mc`
feature. `pkg-encryption/` is separate from the accepted `pkg/` build. The root
workspace lockfile, native CLI, existing FFI, and SPA are untouched.

## Wrapper and lifetime

The pinned library's `sqlite3mc_vfs_create` creates
`multipleciphers-jspi-todo-slice` over the same audited `jspi-todo-slice` VFS.
The probe explicitly registers the cipher wrapper and destroys it only after
closing the connection, before unregistering/freeing the underlying VFS and
its data. This ordering also applies on errors. It avoids leaving a registered
cipher wrapper pointing at a previous operation's freed VFS state.

Each operation retains the existing global reentrancy guard, exclusive Web Lock,
whole-file buffer, 1 MiB limit, MEMORY journal, FULL synchronous setting,
disabled cache spill, and memory temp storage. It selects `chacha20` explicitly
and applies `sqlite3_key` before schema or other database reads. Rekey uses
`sqlite3_rekey`; its return code and original publication cause are preserved.
The shared TODO model/schema supplies the fixture data. Export validates the
key, rows, and integrity, then returns committed ciphertext under ownership.
Checking the file header alone is not treated as proof of encryption; successful
keyed reads and rejection of missing/wrong keys are also required.

## Verified encryption boundary checks

- Encrypted creation through the shared model, controlled xSync suspension with
  event-loop progress, and rejection of an overlapping SQLite call.
- Fresh correct-key read/integrity; missing and wrong keys reject with
  SQLITE_NOTADB and leave ciphertext unchanged.
- A held Web Lock rejects encrypted opens; subsequent opens recover.
- Rejected encrypted insertion and key-change publications retain SQLITE_IOERR_FSYNC,
  the original cause, old ciphertext, and old-key readability.
- Successful encrypted insertion and same-cipher key change; new key reads the
  same data and old key fails.
- Exact ciphertext export/Blob round trip to a separate fixture; correct key,
  model rows, integrity, and unchanged source/copy bytes.
- Fresh page/WASM reopens with the replacement key, rejects the old/wrong/missing
  keys, and preserves the ciphertext SHA-256.
- Explicit rejection/recovery checks for the conversion limitations below.

The encryption release build, JavaScript syntax check, and 10 existing helper
tests pass. The encryption boundary sequence passed twice, with 13 event-loop
ticks. The original TODO and export browser-suite reruns passed after the shared
connection-wrapper refactor. Acceptance of this
encryption boundary stage is complete for the agreed scope: encrypted creation,
keyed reopen, key changes, and ciphertext export. Plaintext conversion and
removal of encryption are out of scope; encrypted databases remain encrypted
permanently. Application integration and real password handling remain open.

### Recorded browser results

```text
PASS: all encryption boundary checks completed
PASS: encrypted shared-model creation and correct-key reopen; missing/wrong keys rejected without changing bytes; JSPI suspension (13 ticks) and overlap rejection
PASS: encrypted write/rekey publication failures preserved cause and old ciphertext; lock recovered; successful write and key change reopened, with old key rejected
PASS: encrypted snapshot/Blob independently reopened with the new key and integrity_check; source/copy bytes unchanged
PASS: in-place plaintext encryption and key removal rejected with SQLITE_AUTH; bytes unchanged and fresh connections recovered
PASS: fresh page/WASM reopened encrypted rows and integrity_check; old/wrong/missing keys rejected; SHA-256 unchanged
PASS: encryption fixtures removed; demo preserved; conversion/removal remain unsupported, no power-loss or SQLCipher compatibility claim
```

## Important conversion constraint

Inspection of the exact cached `sqlite-wasm-rs 0.5.2` source found:

- `sqlite3mcCheckVfs` and `sqlite3mc_vfs_create` implement the cipher wrapper.
- `sqlite3_rekey_v2` calls `sqlite3mcRunVacuumForRekey` when the cipher changes
  reserved bytes per page, including plaintext-to-ChaCha20 and key removal.
- That internal vacuum executes ATTACH. Our connection authorizer rejects ATTACH
  with SQLITE_AUTH, and the VFS does not support additional temporary files.

The browser probe therefore expects in-place encryption of an existing plaintext
fixture and removal of encryption to reject with SQLITE_AUTH, preserve exact
bytes, and allow a fresh connection to recover. Unexpected success or a different
failure is a failed check requiring investigation. We do not relax the VFS policy
or switch ciphers just to avoid this limitation.

Encrypted creation and changing a key with the same cipher/page layout have
passed the browser checks. Converting existing plaintext databases to encrypted
ones is out of scope. That conversion
is excluded from planned implementation and does not block SPA integration;
new encrypted databases will be encrypted from creation. The rejection checks
above remain useful contract coverage and their recorded results are unchanged.

Encrypted databases remain encrypted permanently.
Removing encryption is therefore out of scope as well. The application should
provide key changes with a nonempty replacement key, and no remove-encryption
control. Unlocking permits access through a keyed connection; it does not remove
at-rest encryption. No copy-and-replace conversion or expanded ATTACH/VACUUM
support is needed for the agreed integration scope.
A rejected operation after publication can still have changed committed state;
these injected failures are specifically before publication, not a blanket
atomic-rekey or power-loss guarantee. SQLCipher/native cipher interoperability,
real password UX/storage, and encryption in the SPA remain unverified.
