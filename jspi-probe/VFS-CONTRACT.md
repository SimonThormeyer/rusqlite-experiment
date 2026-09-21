# Buffered writable VFS contract

This audit covers the `jspi-writable-probe` candidate for application integration.
The historical callback adapter and immutable read-only fixture VFS are separate
probes. The candidate remains experimental, with the recovery limits recorded in
[FINAL-RECOVERY.md](FINAL-RECOVERY.md#recovery-decision-for-this-experiment).

## Findings and changes

Inspection of the pinned `rsqlite-vfs` 0.1.1 adapter found unchecked conversions
from SQLite's 64-bit offsets/sizes to `usize`. On wasm32, an offset of 4 GiB could
therefore alias offset zero. The writable VFS now checks these conversions before
accessing buffers. Positive out-of-range reads return zero-filled short reads;
oversize writes/truncations fail without mutation. Negative arguments fail with
the corresponding I/O error.

The writable VFS also now rejects unsupported open flags and simultaneous handles,
tracks SQLite's local lock level, and rejects reusing a dirty/failed registration
after close. Connection setup pins memory temporary storage, and a file-control
policy rejects changes away from the tested journal/sync/spill/temp settings.
A SQLite authorizer rejects ATTACH/DETACH, including memory attachments; VACUUM
is consequently unsupported because it uses an attached database internally.
Filename validation now rejects embedded NUL and dot-directory names before
the Web Lock and OPFS boundaries.

## Supported behavior

| Surface | Contract |
| --- | --- |
| Ownership | One Web Lock per bare filename, acquired before loading OPFS and held through connection/registration cleanup. SQLite entry points also share a reentrancy guard. |
| Filename | Nonempty bare name; no slash, backslash, NUL, `.` or `..`. OPFS enforces remaining filename restrictions. |
| `xOpen` | Pre-created main database, read/write. CREATE may be present for an existing file, but the VFS never creates a missing file. Null/anonymous names, read-only, delete-on-close, exclusive-create, memory, journal, WAL, and temporary-file flags are rejected. Failed opens leave `pMethods` null. |
| Handle count | A second simultaneous handle returns `SQLITE_BUSY`, even within the same VFS registration. |
| `xRead` | Buffered bytes, including unsynced writes; unread bytes are zero-filled with `SQLITE_IOERR_SHORT_READ`. Large positive offsets cannot wrap to the beginning. |
| `xWrite` | Offset overwrite with prefix/suffix retained; growth gaps zero-filled. Maximum database length is 1 MiB; overflow returns `SQLITE_FULL` without mutation. |
| `xTruncate` / `xFileSize` | Size reflects the buffer; shrink discards bytes and growth adds zeros. Oversize truncation returns `SQLITE_FULL`. |
| `xSync` | Dirty buffers publish the whole file, await stream close, and compare a fresh OPFS read. Clean sync is a no-op. This is not a proven physical fsync. Storage errors map to `SQLITE_IOERR_FSYNC`, preserving the original JS cause at the export boundary. |
| Publication failure | Further write/truncate/sync attempts on that buffer fail. The exported operation closes the connection and drops the registration; callers must reopen from published bytes. |
| `xClose` | Frees handle metadata and resets local lock state without publishing. A dirty/failed registration cannot be reopened; a fresh export reconstructs storage state. |
| `xLock` / `xUnlock` | Track local upgrades/downgrades while the enclosing exclusive Web Lock stays held. `xCheckReservedLock` reports reserved-or-higher ownership on the handle. Shared readers are not supported. |
| `xAccess` | Reports the registered preloaded main file present and other names absent for EXISTS/READ/READWRITE. Cooperative ownership excludes external changes while registered. |
| `xDelete` | Always rejects with `SQLITE_IOERR_DELETE`. Setup/cleanup use explicit OPFS operations outside SQLite; persistent journal deletion is unsupported. |
| Full pathname | Adapter copies the bare filename without adding directories; file matching remains exact. |
| Journal/configuration | `journal_mode=MEMORY`, `synchronous=FULL`, `cache_spill=OFF`, `temp_store=MEMORY`. Incompatible assignments fail, including WAL and persistent journal modes. Reading these PRAGMAs remains allowed. |
| Capabilities | I/O version 1, no shared-memory/WAL or mmap callbacks, no atomic-write or powersafe-overwrite claims. Unrecognized file controls return `SQLITE_NOTFOUND`. |
| Multiple databases | ATTACH/DETACH and VACUUM rejected. No general SQL API is exposed by the probe; integration must carry over this policy. |

The VFS is deliberately not a general-purpose filesystem. Database creation and
deletion, export snapshots, SQL scheduling, and connection lifetime will need
application-level ownership handling during integration. Standalone storage
exports do not acquire SQLite's Web Lock and must not be exposed as concurrent
ways to modify a live database. A distinct read-only connection implementation
is not part of this candidate's contract.

## Browser acceptance

Reload the main probe page and run **Run VFS contract checks** twice. It creates
a committed fixture, exercises direct callbacks with byte buffers and large
64-bit offsets, attempts unsupported SQL, and verifies that OPFS bytes are
unchanged and a fresh connection still passes row/integrity checks. Direct
callback tests restore their in-memory test buffer before SQL checks; they do
not publish it. Cleanup removes the fixture.

The contract checks passed twice, including unchanged committed bytes, fresh
reopen/integrity, and rejection of unsupported settings. The complete output is
recorded in [README.md](README.md#vfs-contract-results).

The writable SQLite and cross-tab lock regression suites each passed twice,
completing this audit's browser acceptance checks after the open/close and lock
handling changes. The release WASM build, formatting/syntax checks, and ten
existing local Node tests pass. The callback/SQL assertions passed in both
browser runs.

Audit references: SQLite's [I/O callback contract](https://www.sqlite.org/c3ref/io_methods.html),
[VFS object](https://www.sqlite.org/c3ref/vfs.html), and
[file-control operations](https://www.sqlite.org/c3ref/c_fcntl_begin_atomic_write.html).
