import { todo_rename_list, todo_delete_list, todo_read_list, todo_lists, todo_create, read } from './pkg/jspi_probe.js';
import { assert, equal } from './recovery-state.js';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ready = async () => {};
const noPublish = async () => { throw new Error('Unexpected list-check publication'); };

export async function checkRename(name, older, other, report) {
  const renamed = await todo_rename_list(name, older.id, "Renamed 'δ' ✓", ready);
  assert(renamed.id === older.id && renamed.title === "Renamed 'δ' ✓" && same(renamed.items, older.items), 'Rename changed identity/items or lost title');
  assert(same(await todo_read_list(name, older.id, noPublish), renamed), 'Rename did not reopen');
  assert(same(await todo_read_list(name, other.id, noPublish), other), 'Rename changed other list');
  const bytes = await read(name);
  await todo_rename_list(name, older.id, renamed.title, noPublish);
  assert(equal(await read(name), bytes), 'Unchanged rename published');
  for (const operation of [
    () => todo_rename_list(name, older.id, '  ', noPublish),
    () => todo_rename_list(name, 4294967295, 'Missing list', noPublish),
    () => todo_delete_list(name, 4294967295, noPublish),
  ]) {
    let rejected = false;
    try { await operation(); } catch { rejected = true; }
    assert(rejected && equal(await read(name), bytes), 'Invalid list mutation succeeded or changed bytes');
  }
  const cause = new DOMException('List mutation publication rejected', 'AbortError');
  for (const operation of [
    () => todo_rename_list(name, older.id, 'Rejected rename', async () => { throw cause; }),
    () => todo_delete_list(name, older.id, async () => { throw cause; }),
  ]) {
    let failure;
    try { await operation(); } catch (error) { failure = error; }
    assert(failure?.sqliteCode === 1034 && failure.cause === cause, 'List mutation failure lost code/cause');
    assert(equal(await read(name), bytes), 'Rejected list mutation changed bytes');
    assert(same(await todo_read_list(name, older.id, noPublish), renamed), 'Rejected list mutation changed list/items');
    assert(same(await todo_read_list(name, other.id, noPublish), other), 'Rejected list mutation changed other list');
  }
  // Exercise a successful write after both failures, retaining the same final title.
  await todo_rename_list(name, older.id, 'Recovery rename', ready);
  const recovered = await todo_rename_list(name, older.id, renamed.title, ready);
  assert(same(recovered, renamed), 'Rename did not recover after rejection');
  report('PASS: rename preserved list ID/items and the other list; unchanged/invalid requests did not publish');
  report('PASS: rejected rename and list deletion preserved cause, bytes, and both lists; fresh connections recovered');
  return recovered;
}

export async function checkListAbsent(name, id) {
  let rejected = false;
  try { await todo_read_list(name, id, noPublish); } catch { rejected = true; }
  assert(rejected && !(await todo_lists(name, noPublish)).some(list => list.id === id), 'Deleted list still exists');
}

export async function checkDelete(name, older, survivor, report) {
  assert(older.items.length > 0, 'Cascade fixture must contain items');
  // The export checks the child-row count inside the deletion transaction.
  await todo_delete_list(name, older.id, ready);
  const bytes = await read(name);
  await checkListAbsent(name, older.id);
  assert(same(await todo_read_list(name, survivor.id, noPublish), survivor), 'List deletion changed survivor');
  let repeated = false;
  try { await todo_delete_list(name, older.id, noPublish); } catch { repeated = true; }
  assert(repeated && equal(await read(name), bytes), 'Repeated list deletion published or succeeded');
  report('PASS: shared-model list deletion removed its child rows; other list and items survived; repeated deletion did not publish');
}

export async function checkDeleteLast(name, survivor, report) {
  await todo_delete_list(name, survivor.id, ready);
  const bytes = await read(name);
  assert((await todo_lists(name, noPublish)).length === 0, 'Last-list deletion did not leave an empty database');
  await checkListAbsent(name, survivor.id);
  assert(equal(await read(name), bytes), 'Empty database read published');
  const created = await todo_create(name, 'Created after final deletion', 'New item', ready);
  assert(created.title === 'Created after final deletion' && created.items.length === 1 && created.items[0].description === 'New item', 'Creation after final deletion failed');
  assert(same(await todo_read_list(name, created.id, noPublish), created), 'New list did not reopen');
  report('PASS: final list deletion left no lists; creating and reopening a new list reused the existing schema');
}
