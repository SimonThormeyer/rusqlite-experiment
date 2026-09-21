import init, { todo_export, todo_create, todo_rename_list, todo_delete_list, todo_read, todo_lists, todo_read_list, todo_add_item, todo_update_item, todo_delete_item, read, _delete as remove } from './pkg/jspi_probe.js';
import { runExportChecks } from './todo-export-checks.js';
import { checkRename, checkDelete, checkDeleteLast, checkListAbsent } from './todo-list-checks.js';
import { assert, equal, fingerprint } from './recovery-state.js';

const $ = id => document.getElementById(id);
const name = 'todo-application-slice.sqlite';
const selectionKey = 'jspi-todo-selected-list';
let selectedId = null;
const checkpoint = 'jspi-todo-slice-reload-v1';
const ready = async () => {};
const noPublish = async () => { throw new Error('Reading the TODO model must not publish'); };
let lines = [], working = false;
const report = line => { lines.push(line); $('log').textContent = lines.join('\n'); };
const busy = value => { working = value; for (const control of document.querySelectorAll('button, input, select')) control.disabled = value; for (const id of ['add', 'new-description', 'read', 'lists', 'rename-title', 'rename', 'delete-list']) $(id).disabled = value || selectedId === null; };
function display(list) {
  selectedId = list.id;
  sessionStorage.setItem(selectionKey, String(list.id));
  $('lists').value = String(list.id);
  $('list-title').textContent = list.title;
  $('rename-title').value = list.title;
  $('items').replaceChildren();
  for (const item of list.items) {
    const entry = document.createElement('li');
    const form = document.createElement('form');
    const description = document.createElement('input');
    description.value = item.description; description.required = true;
    description.setAttribute('aria-label', 'Item description');
    const completed = document.createElement('input');
    completed.type = 'checkbox'; completed.checked = item.completed;
    const label = document.createElement('label');
    label.append(completed, ' Completed');
    const save = document.createElement('button');
    save.type = 'submit'; save.textContent = 'Save item';
    const deletion = document.createElement('button');
    deletion.type = 'button'; deletion.textContent = 'Delete item';
    form.append(description, label, save, deletion); entry.append(form);
    form.onsubmit = event => {
      event.preventDefault();
      action(async () => {
        $('status').textContent = 'Saving item…';
        display(await todo_update_item(name, list.id, item.id, description.value, completed.checked, ready));
        $('status').textContent = 'Item saved. Reopen or reload to verify.';
      });
    };
    deletion.onclick = () => action(async () => {
      $('status').textContent = 'Deleting item…';
      display(await todo_delete_item(name, list.id, item.id, ready));
      $('status').textContent = 'Item deleted; list retained.';
    });
    $('items').append(entry);
  }
  if (!list.items.length) { const empty = document.createElement('li'); empty.textContent = 'This list has no items.'; $('items').append(empty); }
  busy(working);
}
async function action(work) {
  if (working) return;
  busy(true);
  try { await work(); }
  catch (error) {
    $('status').textContent = `FAIL: ${error.message ?? error}`;
    report(error.stack ?? String(error));
  } finally { $('lists').value = selectedId === null ? '' : String(selectedId); busy(false); }
}
$('create-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    $('status').textContent = 'Creating list and item…';
    const list = await todo_create(name, $('title').value, $('description').value, ready);
    await refreshLists(list.id);
    $('status').textContent = 'Saved to OPFS. Reload this page or reopen the selected list to verify.';
  });
};
async function refreshLists(preferredId) {
  const lists = await todo_lists(name, noPublish);
  const id = lists.some(list => list.id === preferredId) ? preferredId : lists.at(-1)?.id;
  if (id === undefined) {
    selectedId = null;
    sessionStorage.removeItem(selectionKey);
    $('lists').replaceChildren();
    $('list-title').textContent = 'No lists yet';
    $('items').replaceChildren();
    $('rename-title').value = '';
    $('new-description').value = '';
    busy(working);
    return;
  }
  const loaded = await todo_read_list(name, id, noPublish);
  $('lists').replaceChildren(...lists.map(list => {
    const option = document.createElement('option');
    option.value = String(list.id); option.textContent = `${list.title} (#${list.id})`;
    return option;
  }));
  display(loaded);
}
$('read').onclick = () => action(async () => {
  await refreshLists(selectedId);
  $('status').textContent = 'Selected list loaded through a fresh connection.';
});
$('lists').onchange = () => action(async () => {
  const id = Number($('lists').value);
  display(await todo_read_list(name, id, noPublish));
  $('status').textContent = 'Selected list loaded.';
});
$('add-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    assert(selectedId !== null, 'Select a list first');
    display(await todo_add_item(name, selectedId, $('new-description').value, ready));
    $('new-description').value = '';
    $('status').textContent = 'Item added to the selected list.';
  });
};
$('rename-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    assert(selectedId !== null, 'Select a list first');
    const list = await todo_rename_list(name, selectedId, $('rename-title').value, ready);
    await refreshLists(list.id);
    $('status').textContent = 'List renamed.';
  });
};
$('delete-list').onclick = () => action(async () => {
  assert(selectedId !== null, 'Select a list first');
  await todo_delete_list(name, selectedId, ready);
  await refreshLists(null);
  $('status').textContent = selectedId === null ? 'List deleted. Ready to create a new list.' : 'List deleted; another list is selected.';
});
$('download').onclick = () => action(async () => {
  const bytes = await todo_export(name, noPublish);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'todo-application-snapshot.sqlite';
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  $('status').textContent = `Snapshot download requested (${bytes.length} bytes). Only saved changes are included.`;
});
$('export-checks').onclick = () => action(async () => {
  assert(!sessionStorage.getItem(checkpoint), 'A reload verification is pending; reload to finish it');
  lines = [];
  await runExportChecks(report);
  $('status').textContent = 'PASS: all TODO export checks completed';
});
const matches = (list, title, description) => list.title === title && list.id > 0
  && list.items.length === 1 && list.items[0].id > 0
  && list.items[0].description === description && list.items[0].completed === false;
$('checks').onclick = () => action(async () => {
  assert(!sessionStorage.getItem(checkpoint), 'A reload verification is pending; reload to finish it');
  lines = [];
  const testName = `todo-check-${crypto.randomUUID()}.sqlite`;
  let retained = false;
  try {
    let enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    let first;
    const pending = todo_create(testName, "List 'α'", 'First item ✓', () => { enteredResolve(); return gate; });
    pending.catch(() => {});
    try {
      assert(pending instanceof Promise, 'TODO create export is not Promise-returning');
      // If creation fails before xSync, surface it rather than waiting forever.
      await Promise.race([entered, pending.then(() => { throw new Error('Create did not reach publication'); })]);
      await new Promise(resolve => setTimeout(resolve, 150));
      let overlap;
      try { await todo_read(testName, noPublish); } catch (error) { overlap = error; }
      assert(overlap?.message.includes('SQLite probe already running'), 'Overlapping TODO read was not rejected');
    } finally { release(); clearInterval(timer); first = await pending; }
    assert(ticks > 0 && matches(first, "List 'α'", 'First item ✓'), 'Shared model create/load or event loop check failed');
    report(`PASS: shared TODO schema, list/item creation, and model reload; xSync suspended (${ticks} ticks); overlapping call rejected`);
    assert(JSON.stringify(await todo_read(testName, noPublish)) === JSON.stringify(first), 'Fresh model read differs');
    const committed = await read(testName);
    const cause = new DOMException('TODO pre-publication failure', 'AbortError');
    let failure;
    try { await todo_create(testName, 'Must not persist', 'Rejected item', async () => { throw cause; }); }
    catch (error) { failure = error; }
    assert(failure?.sqliteCode === 1034 && failure.cause === cause, 'TODO publication failure lost SQLite code or cause');
    assert(equal(await read(testName), committed), 'Failed TODO transaction changed committed bytes');
    assert(JSON.stringify(await todo_read(testName, noPublish)) === JSON.stringify(first), 'Failure leaked partial list/item');
    report('PASS: rejected TODO COMMIT preserved original cause and committed bytes; fresh connection recovered without partial list/item');
    const second = await todo_create(testName, 'Second list', 'Existing schema reused', ready);
    assert(matches(second, 'Second list', 'Existing schema reused') && second.id !== first.id, 'Second model operation failed');
    report('PASS: subsequent list/item creation reused the schema and committed successfully');
    const summaries = [{ id: first.id, title: first.title }, { id: second.id, title: second.title }];
    const beforeSelection = await read(testName);
    assert(JSON.stringify(await todo_lists(testName, noPublish)) === JSON.stringify(summaries), 'List enumeration differs');
    assert(JSON.stringify(await todo_read_list(testName, first.id, noPublish)) === JSON.stringify(first), 'Could not load older list');
    assert(equal(await read(testName), beforeSelection), 'List enumeration/selection changed bytes');
    const older = await todo_add_item(testName, first.id, "Added to older list 'γ' ✓", ready);
    assert(older.id === first.id && older.items.length === 2 && JSON.stringify(older.items[0]) === JSON.stringify(first.items[0])
      && older.items[1].description === "Added to older list 'γ' ✓" && !older.items[1].completed, 'Append did not preserve existing item');
    assert(JSON.stringify(await todo_read_list(testName, first.id, noPublish)) === JSON.stringify(older), 'Appended item did not reopen');
    assert(JSON.stringify(await todo_read_list(testName, second.id, noPublish)) === JSON.stringify(second), 'Append changed another list');
    const addedBytes = await read(testName);
    for (const operation of [
      () => todo_add_item(testName, first.id, '   ', noPublish),
      () => todo_add_item(testName, 4294967295, 'Missing list', noPublish),
      () => todo_read_list(testName, 4294967295, noPublish),
    ]) {
      let rejected = false;
      try { await operation(); } catch { rejected = true; }
      assert(rejected && equal(await read(testName), addedBytes), 'Invalid list/add request succeeded or changed bytes');
    }
    let addFailure;
    try { await todo_add_item(testName, first.id, 'Rejected addition', async () => { throw cause; }); }
    catch (error) { addFailure = error; }
    assert(addFailure?.sqliteCode === 1034 && addFailure.cause === cause, 'Add failure lost code/cause');
    assert(equal(await read(testName), addedBytes), 'Rejected addition changed bytes');
    assert(JSON.stringify(await todo_read_list(testName, first.id, noPublish)) === JSON.stringify(older), 'Rejected addition leaked item');
    let recovered = await todo_add_item(testName, first.id, 'Addition after failure', ready);
    assert(recovered.items.length === 3 && recovered.items[2].description === 'Addition after failure', 'Addition did not recover');
    assert(JSON.stringify(recovered.items.slice(0, 2)) === JSON.stringify(older.items), 'Recovery changed earlier items');
    assert(JSON.stringify(await todo_read_list(testName, second.id, noPublish)) === JSON.stringify(second), 'Recovery changed other list');
    report('PASS: list enumeration and older-list selection did not publish; additions preserved existing items and isolated the other list');
    report('PASS: invalid list/blank additions rejected; failed addition preserved cause and bytes; fresh connection added successfully after failure');
    const itemId = second.items[0].id;
    let edited = await todo_update_item(testName, second.id, itemId, "Edited 'β' ✓", true, ready);
    assert(edited.items[0].description === "Edited 'β' ✓" && edited.items[0].completed, 'Edit/completion did not save');
    assert(JSON.stringify(await todo_read(testName, noPublish)) === JSON.stringify(edited), 'Edited item did not reopen');
    const editedBytes = await read(testName);
    await todo_update_item(testName, second.id, itemId, "Edited 'β' ✓", true, noPublish);
    assert(equal(await read(testName), editedBytes), 'Unchanged save published');
    for (const operation of [
      () => todo_update_item(testName, second.id, first.items[0].id, 'Wrong list', false, noPublish),
      () => todo_delete_item(testName, second.id, first.items[0].id, noPublish),
      () => todo_update_item(testName, second.id, itemId, '   ', false, noPublish),
    ]) {
      let rejected = false;
      try { await operation(); } catch { rejected = true; }
      assert(rejected && equal(await read(testName), editedBytes), 'Invalid item operation changed bytes or succeeded');
    }
    report('PASS: description and completion saved through shared model; fresh reopen matched; no-op save and invalid/cross-list operations left bytes unchanged');
    for (const operation of [
      () => todo_update_item(testName, second.id, itemId, 'Rejected edit', false, async () => { throw cause; }),
      () => todo_delete_item(testName, second.id, itemId, async () => { throw cause; }),
    ]) {
      let rejected;
      try { await operation(); } catch (error) { rejected = error; }
      assert(rejected?.sqliteCode === 1034 && rejected.cause === cause, 'Item failure lost SQLite code/cause');
      assert(equal(await read(testName), editedBytes), 'Rejected item operation changed committed bytes');
      assert(JSON.stringify(await todo_read(testName, noPublish)) === JSON.stringify(edited), 'Item state changed after failed COMMIT');
    }
    report('PASS: rejected edit and delete COMMITs preserved cause, bytes, and item state; fresh connections recovered');
    edited = await todo_update_item(testName, second.id, itemId, "Edited 'β' ✓", false, ready);
    assert(!edited.items[0].completed && !(await todo_read(testName, noPublish)).items[0].completed, 'Completion could not be cleared');
    edited = await todo_update_item(testName, second.id, itemId, "Edited 'β' ✓", true, ready);
    report('PASS: completion toggled off and on through fresh connections');
    recovered = await checkRename(testName, recovered, edited, report);
    summaries[0].title = recovered.title;
    const bytes = await read(testName);
    sessionStorage.setItem(checkpoint, JSON.stringify({ name: testName, sha256: await fingerprint(bytes), length: bytes.length, expected: edited, expectedOlder: recovered, summaries, phase: 'edited', lines }));
    retained = true;
    location.reload();
  } finally {
    if (!retained) {
      try { await remove(testName); } catch (error) { if (error.name !== 'NotFoundError') report(`Cleanup failed: ${error}`); }
    }
  }
});

try {
  await init();
  const saved = sessionStorage.getItem(checkpoint);
  if (saved) {
    const state = JSON.parse(saved);
    assert(/^todo-check-[0-9a-f-]{36}\.sqlite$/.test(state.name) && /^[0-9a-f]{64}$/.test(state.sha256)
      && Number.isInteger(state.length) && state.length > 0 && Array.isArray(state.lines), 'Invalid TODO reload checkpoint');
    lines = state.lines;
    const bytes = await read(state.name);
    assert(bytes.length === state.length && await fingerprint(bytes) === state.sha256, 'TODO bytes changed across page reload');
    const list = await todo_read(state.name, noPublish);
    assert(JSON.stringify(list) === JSON.stringify(state.expected), 'TODO model rows changed across reload');
    if (state.expectedOlder) {
      assert(JSON.stringify(await todo_lists(state.name, noPublish)) === JSON.stringify(state.summaries), 'List summaries changed across reload');
      assert(JSON.stringify(await todo_read_list(state.name, state.expectedOlder.id, noPublish)) === JSON.stringify(state.expectedOlder), 'Older list additions changed across reload');
      report('PASS: both list summaries and older-list additions survived page/WASM reload; explicit selection loaded the correct items');
    }
    if (state.deletedListId) {
      await checkListAbsent(state.name, state.deletedListId);
      assert(JSON.stringify(await todo_lists(state.name, noPublish)) === JSON.stringify(state.summaries), 'Surviving summaries differ after deletion reload');
      report('PASS: renamed list deletion and unchanged surviving list persisted across a fresh page/WASM reload');
    }
    assert(equal(await read(state.name), bytes), 'TODO reopen modified bytes');
    report('PASS: fresh page/WASM loaded shared model rows; SHA-256 and integrity_check passed; verification did not publish');
    if (state.phase === 'edited') {
      const empty = await todo_delete_item(state.name, list.id, list.items[0].id, ready);
      assert(empty.id === list.id && empty.title === list.title && empty.items.length === 0, 'Delete did not retain the empty list');
      assert(JSON.stringify(await todo_read(state.name, noPublish)) === JSON.stringify(empty), 'Deletion did not reopen');
      const deletedBytes = await read(state.name);
      let missing = false;
      try { await todo_delete_item(state.name, list.id, list.items[0].id, noPublish); } catch (error) { missing = error.message.includes('Item not found'); }
      assert(missing && equal(await read(state.name), deletedBytes), 'Repeated delete changed data or succeeded');
      report('PASS: shared model deleted the item and retained its list; fresh reopen matched; repeated delete rejected without publication');
      sessionStorage.setItem(checkpoint, JSON.stringify({ ...state, phase: 'deleted', expected: empty,
        sha256: await fingerprint(deletedBytes), length: deletedBytes.length, lines }));
      location.reload();
      // Do not clean up or enable controls before the second reload verifies deletion.
      await new Promise(() => {});
    }
    if (state.phase === 'deleted') report('PASS: item deletion and empty list survived a second page/WASM reload');
    if (state.expectedOlder && state.phase === 'deleted') {
      const refilled = await todo_add_item(state.name, list.id, 'Added to empty list', ready);
      assert(refilled.id === list.id && refilled.items.length === 1 && refilled.items[0].description === 'Added to empty list', 'Could not add to empty list');
      assert(JSON.stringify(await todo_read_list(state.name, list.id, noPublish)) === JSON.stringify(refilled), 'Refilled list did not reopen');
      assert(JSON.stringify(await todo_read_list(state.name, state.expectedOlder.id, noPublish)) === JSON.stringify(state.expectedOlder), 'Refilling changed older list');
      report('PASS: empty list accepted a new item; fresh reopen matched and the older list stayed unchanged');
      await checkDelete(state.name, state.expectedOlder, refilled, report);
      const deletedBytes = await read(state.name);
      sessionStorage.setItem(checkpoint, JSON.stringify({ ...state, phase: 'list-deleted', expected: refilled,
        deletedListId: state.expectedOlder.id, expectedOlder: null, summaries: [{ id: refilled.id, title: refilled.title }],
        sha256: await fingerprint(deletedBytes), length: deletedBytes.length, lines }));
      location.reload();
      await new Promise(() => {});
    }
    if (state.phase === 'list-deleted') await checkDeleteLast(state.name, list, report);
    await remove(state.name);
    sessionStorage.removeItem(checkpoint);
    report('PASS: test database removed; demo database preserved; unencrypted list rename and deletion slice');
    $('status').textContent = 'PASS: all TODO application slice checks completed';
  } else {
    try { await refreshLists(Number(sessionStorage.getItem(selectionKey))); $('status').textContent = selectedId === null ? 'Ready to create a new list.' : 'Selected list restored from OPFS.'; }
    catch (error) { if (error.name !== 'NotFoundError') throw error; $('status').textContent = 'Ready to create your first list.'; }
  }
  busy(false);
} catch (error) { $('status').textContent = `FAIL: ${error.message ?? error}`; report(error.stack ?? String(error)); }
