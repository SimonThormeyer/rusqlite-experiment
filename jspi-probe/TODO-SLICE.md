# First TODO application slice

Encryption validation now precedes SPA integration. The
[isolated encryption probe](ENCRYPTION.md) adds encrypted creation, key changes,
ciphertext export, and recovery checks; the encryption sequence passed twice.
The post-change TODO/export regressions passed.
Encrypted databases will be created encrypted and remain
encrypted permanently. Plaintext conversion and removing encryption are out of
scope; changing a key remains supported. The validated encryption boundary is
sufficient to proceed with SPA integration. The existing SPA still uses IndexedDB.

Open [todo-slice.html](http://localhost:8081/todo-slice.html) on the same origin as
your probe server (use `127.0.0.1` instead if that is your current origin).
This page is the first unencrypted application slice, not a replacement for the
existing IndexedDB SPA.

## What is connected

The probe now depends directly on the repository's `todo-list` crate. It calls
the existing `apply_schema`, `TodoList::new`, `add_item`, `list_all`, and `load`
methods; it does not maintain copies of their SQL or model. The shared crate,
native CLI, and existing `ffi`/SPA implementation are unchanged.

`todo_create`, `todo_read`, `todo_lists`, `todo_read_list`, `todo_add_item`,
`todo_update_item`, `todo_delete_item`, `todo_rename_list`, `todo_delete_list`,
and `todo_export` are JSPI
exports returning Promises. Each holds the
shared reentrancy guard and exclusive database Web Lock, registers the same
audited writable VFS, and closes/drops the connection and registration before
releasing ownership. File creation is performed under the lock only when OPFS
reports `NotFoundError`. Other storage errors are propagated.

The exports use the same connection policy as the probes, plus
`foreign_keys=ON`. Initial schema creation, `user_version=1`, and the first
list/item insert are one transaction. Later creates require that schema version;
an unknown existing schema is rejected rather than overwritten. The read exports
do not create a file or apply schema. `todo_read` loads the latest list, while
`todo_read_list` loads a specified list; both check database integrity.
`todo_lists` returns ID/title summaries in ID order through the shared model.
`todo_add_item` loads an existing list and calls its `add_item` in an explicit
transaction, returning a fresh snapshot only after successful COMMIT.

The model methods are declared async but currently perform synchronous rusqlite
work. A single-poll adapter runs them inside the JSPI entry stack, allowing VFS
suspension to resume on that same stack. It explicitly errors on `Poll::Pending`;
it is not a general async executor. If the shared model later introduces actual
asynchronous waits, the adapter must be replaced before those operations are
supported. No mutable model object or live connection crosses the JS boundary:
the page receives plain list/item snapshots after successful COMMIT and close.
Item updates load the specified list, validate that the item belongs to it, use
the shared model's description/completion setters and `save`, then commit.
Deletion uses `remove_item` in the same transactional pattern and retains the
list. Blank descriptions and missing/cross-list items are rejected. An unchanged
save uses the model's dirty tracking and does not publish.
List renaming uses `set_title` and `save` in the same transaction pattern; blank
titles are rejected and unchanged titles do not publish. List deletion loads the
list first, calls the shared model's `TodoList::delete`, checks that its child-row
count is zero, and commits. The existing `ON DELETE CASCADE` schema and enabled
foreign keys remove the list's items. Missing/repeated deletions reject before
executing DELETE.

The demo uses `todo-application-slice.sqlite` in the dedicated probe OPFS
directory. Create adds a new list with one item and selects it. The existing-list
selector loads any list; **Add to selected list** appends an item. Reopen/page
load restores the selected list ID stored in this tab’s session storage, falling
back to the latest list when no saved selection exists or its ID is absent. Each item has a description field, completion checkbox, **Save item**, and
**Delete item** controls. The selected list also has **Rename list** and
**Delete list and all its items** controls. Deletion selects another existing
list, or clears the selection when no lists remain; creation remains available. Checking completion edits the form; **Save item**
commits both fields. UI controls serialize actions and display errors. A rejected COMMIT can
still be ambiguous after publication, so the UI does not automatically retry it.

## Manual checks

1. On the TODO slice page, click **Run TODO slice checks (reloads three times)** twice
   and report the output. Each run uses a separate random test database and
   removes it after reload verification.
2. Create a list/item using the form. Edit its description, check **Completed**,
   save, and reopen/reload. Clear completion and save, then verify again.
   Delete the item and reload; the list should remain empty.
3. Create two lists, select the older one, and add an item. Switch between them
   and confirm each retains its own items. Reload with the older list selected;
   it should still be selected. Delete all its items, then add to the empty list
   and reopen/reload again.
4. Rename a selected list and reopen/reload; its title, ID, and items should persist.
   Delete a list containing items and verify another list is unchanged after
   reload. Using disposable demo lists, delete the final list and reload; the page
   should offer creation with no stale selection. Create a new list and reopen.

The first slice's VFS contract regression was already confirmed. This extension
does not change the VFS or its connection policy.

The automated browser sequence checks shared-model schema/create/load with
Unicode and quotes, event-loop progress during a controlled publication pause,
reentrant-call rejection, recovery from a rejected COMMIT without partial
list/item publication, another create without reapplying schema, and a fresh
page/WASM instance with identical database SHA-256 and model rows. Its read hook
rejects any unexpected publication. Test cleanup leaves the demo database intact.

The WASM release build succeeds with the locked dependencies. The automated
browser sequence passed twice. The manual demo-form checks and post-integration
VFS contract rerun also passed, completing acceptance of the first unencrypted
application slice. The probe lockfile adds the shared model's dependencies; the
root workspace lockfile and the existing application toolchain are unchanged.

## Recorded browser results

Both runs passed with this output:

```text
PASS: all TODO application slice checks completed
PASS: shared TODO schema, list/item creation, and model reload; xSync suspended (13 ticks); overlapping call rejected
PASS: rejected TODO COMMIT preserved original cause and committed bytes; fresh connection recovered without partial list/item
PASS: subsequent list/item creation reused the schema and committed successfully
PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish
PASS: test database removed; demo database preserved; unencrypted first application slice only
```

The automated sequence does not display its test list in the demo or create a
demo list. Therefore “No list loaded” after the checks is expected; use the form
to test the persistent demo separately.

Form creation, reload persistence, creating a second list and reopening the
latest list, and one VFS contract rerun passed.

## Item mutation extension

The new exports and UI extend the accepted create/read slice with editing,
completion changes, and deletion. The expanded browser sequence retains the
original checks and additionally verifies:

- Unicode/quoted description edits and completion persisted through fresh reads.
- Unchanged saves, blank descriptions, and cross-list item requests do not publish.
- Rejected edit/delete COMMITs preserve the original cause, old bytes, and model
  state, with recovery through fresh connections.
- Completion can be cleared and set again.
- Saved edits/completion survive the first page/WASM reload with unchanged hashes.
- Deletion through the shared model retains the empty list; a repeated delete is
  rejected without publishing; deletion survives a second page/WASM reload.

The mutation extension's release build and JavaScript syntax checks pass;
the expanded automated browser sequence passed twice. The manual UI checks also
passed. Acceptance of this extension is complete. Earlier recorded passes above
cover the create/read slice only.

### Item mutation results

Both runs of the expanded sequence passed with this output:

```text
PASS: shared TODO schema, list/item creation, and model reload; xSync suspended (13 ticks); overlapping call rejected
PASS: rejected TODO COMMIT preserved original cause and committed bytes; fresh connection recovered without partial list/item
PASS: subsequent list/item creation reused the schema and committed successfully
PASS: description and completion saved through shared model; fresh reopen matched; no-op save and invalid/cross-list operations left bytes unchanged
PASS: rejected edit and delete COMMITs preserved cause, bytes, and item state; fresh connections recovered
PASS: completion toggled off and on through fresh connections
PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish
PASS: shared model deleted the item and retained its list; fresh reopen matched; repeated delete rejected without publication
PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish
PASS: item deletion and empty list survived a second page/WASM reload
PASS: test database removed; demo database preserved; unencrypted item editing/completion/deletion slice
```

Manual item editing, completion changes, saving/reloading, and deletion/reloading
with the empty list retained passed.

## List selection and item addition extension

The page now enumerates existing lists, loads a chosen list, and appends items
through the shared model. All controls, including the selector, are disabled
during operations. Failed selection retains the previous displayed list and ID.
The selected demo list is remembered per tab across page reloads; browser check
fixtures do not alter that selection or the demo database.

The expanded two-reload browser sequence additionally checks:

- List enumeration and loading an older list without publication.
- Adding to the older list while preserving its earlier items and the other list.
- Blank descriptions and missing list IDs rejected without changing bytes.
- Rejected addition COMMIT preserving the original cause and committed bytes,
  followed by a successful addition through a fresh connection.
- Both list summaries and the older list’s additions surviving both reloads.
- Adding to an empty list after deletion, then reopening without changing the
  other list.

The expanded browser sequence passed twice. Manual checks also passed: selecting
the older of two lists, adding an item without changing the other list, retaining
selection across reload, and adding to an emptied list followed by reopening.
Acceptance of this extension is complete. Prior recorded logs above cover the
earlier slices. The VFS, schema, and connection policy are unchanged.

## List rename and deletion extension

The selected-list controls now rename or delete a list through the shared model.
Deleting the final list leaves the existing database/schema available for another
create. Operations remain serialized and rejected COMMITs are not retried.

The browser sequence retains earlier checks and now reloads three times. New
checks cover quoted/Unicode titles, stable IDs/items, other-list isolation,
unchanged rename, blank/missing IDs, and rejected rename/delete COMMITs preserving
cause, bytes, and model state. A successful rename after those failures checks
write recovery; the renamed list is verified on subsequent reloads.

After the second reload, the sequence deletes the populated older list and checks
that the other list is unchanged. The delete export verifies cascade removal
inside the transaction. A repeated delete must reject without publication. A
third reload verifies the deleted list stays absent and the surviving model and
database hash match, with no verification publication. Finally, it deletes the
last list and creates/reopens a new list using the existing schema.

The expanded three-reload sequence passed twice, and the manual checks passed.
This completes acceptance of list renaming and deletion. The VFS and schema are
unchanged. The release build, JavaScript syntax checks, and all 10 existing helper
tests also passed.

### List rename and deletion results

Both runs passed with the following output. Manual checks covered rename/reload,
deleting a populated list without affecting another list, and deleting the final
list then reloading, creating, and reopening a new one.

```text
PASS: shared TODO schema, list/item creation, and model reload; xSync suspended (13 ticks); overlapping call rejected
PASS: rejected TODO COMMIT preserved original cause and committed bytes; fresh connection recovered without partial list/item
PASS: subsequent list/item creation reused the schema and committed successfully
PASS: list enumeration and older-list selection did not publish; additions preserved existing items and isolated the other list
PASS: invalid list/blank additions rejected; failed addition preserved cause and bytes; fresh connection added successfully after failure
PASS: description and completion saved through shared model; fresh reopen matched; no-op save and invalid/cross-list operations left bytes unchanged
PASS: rejected edit and delete COMMITs preserved cause, bytes, and item state; fresh connections recovered
PASS: completion toggled off and on through fresh connections
PASS: rename preserved list ID/items and the other list; unchanged/invalid requests did not publish
PASS: rejected rename and list deletion preserved cause, bytes, and both lists; fresh connections recovered
PASS: both list summaries and older-list additions survived page/WASM reload; explicit selection loaded the correct items
PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish
PASS: shared model deleted the item and retained its list; fresh reopen matched; repeated delete rejected without publication
PASS: both list summaries and older-list additions survived page/WASM reload; explicit selection loaded the correct items
PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish
PASS: item deletion and empty list survived a second page/WASM reload
PASS: empty list accepted a new item; fresh reopen matched and the older list stayed unchanged
PASS: shared-model list deletion removed its child rows; other list and items survived; repeated deletion did not publish
PASS: renamed list deletion and unchanged surviving list persisted across a fresh page/WASM reload
PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish
PASS: final list deletion left no lists; creating and reopening a new list reused the existing schema
PASS: test database removed; demo database preserved; unencrypted list rename and deletion slice
```

## Database download extension

**Download database** requests an unencrypted `todo-application-snapshot.sqlite`
download containing every list and saved item, independent of the current list
selection. Unsaved form edits are excluded. An existing database with no lists is
exportable; a missing database returns an error without creating one.

`todo_export` holds the shared reentrancy guard and exclusive database Web Lock
through opening, schema validation, `integrity_check`, capture of OPFS bytes,
and connection cleanup. It returns owned bytes only after cleanup. CRUD operations
close their transactions/connections before returning, so the captured file is
committed state. Export does not publish. This guarantee assumes cooperating
writers use the same lock; the raw storage probe helpers are not application APIs.
The download Blob owns its snapshot and later commits do not change it. The UI
revokes the temporary object URL after allowing the browser time to begin the
download; it reports a download request, not proof that a file was saved.

A separate **Run TODO export checks** button creates disposable source/copy files
and checks exact bytes, SQLite header, SHA-256, Blob conversion, all model rows,
and integrity through a fresh connection to the copy. It also checks lock
contention, overlap with a suspended COMMIT, snapshot independence from later
commits, export after a rejected COMMIT, empty databases, missing/corrupt input,
and recovery. Both fixtures are removed; the demo is preserved. This does not
add an application import/restore API or claim encryption or power-loss durability.

Reproduction procedure:

1. Run **Run TODO export checks** twice and report the results.
2. Run the existing **Run TODO slice checks (reloads three times)** once as a
   regression.
3. In the demo, create/save data in at least two lists and click **Download
   database**. Open the downloaded file with native SQLite, for example:

   ```sh
   sqlite3 -readonly ~/Downloads/todo-application-snapshot.sqlite 'PRAGMA integrity_check; SELECT id, title FROM todo_lists ORDER BY id; SELECT id, list_id, description, is_completed FROM todo_items ORDER BY id;'
   ```

   Use the actual downloaded path if the browser adds a suffix. Confirm `ok` and
   matching saved rows. Edit the live demo after downloading, then query the same
   downloaded file again; it should still contain the earlier snapshot. Reopen
   the live demo and confirm the new edit persists.

### Database download results

The export checks and complete three-reload TODO regression each passed twice.
The regression output matches the list rename/deletion results above, including
13 event-loop ticks. Export results:

```text
PASS: snapshot and download Blob match committed bytes (SHA-256 328f99758113a1288d9eb8478291864ffd917207eccc28c2e3651f58e7d2a995); independent copy reopened all rows and integrity_check without publication
PASS: held lock and suspended COMMIT blocked export; later commits did not alter earlier snapshots; export recovered after contention and rejected COMMIT
PASS: empty TODO database exported and reopened; missing/corrupt databases rejected without creation or modification; subsequent valid export recovered
PASS: export fixtures removed; demo database preserved; unencrypted committed snapshots only
```

The downloaded file also passed verification with native `sqlite3 -readonly`.
`integrity_check` returned `ok`; the file contained lists 6 (`ABCD`) and 7
(`Does this export?`) with one item each, matching the two-list browser view.

Automated browser acceptance and native downloaded-file verification have passed.
Snapshot independence after later commits is covered by the automated export
checks. A later live edit
left the same downloaded file unchanged, and the edit persisted after reopening
the demo. This completes acceptance of the database download extension.

## Still outside this slice

Encryption,
migration from IndexedDB, and replacing the existing SPA remain subsequent work.
The VFS's 1 MiB buffer, single owner, memory journal, and recovery limitations
continue to apply. This slice does not expose a persistent connection or generic
SQL API, and does not establish power-loss durability.
