import { todo_export, todo_create, todo_add_item, todo_delete_list, todo_lists, todo_read_list, read, write, _delete as remove } from './pkg/jspi_probe.js';
import { acquireDatabaseLock } from './locks.js';
import { assert, equal, fingerprint } from './recovery-state.js';
const ready = async () => {};
const noPublish = async () => { throw new Error('Export/read must not publish'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function runExportChecks(report) {
  const source = `todo-export-${crypto.randomUUID()}.sqlite`;
  const copy = `todo-export-copy-${crypto.randomUUID()}.sqlite`;
  const missing = `todo-export-missing-${crypto.randomUUID()}.sqlite`;
  try {
    let failure;
    try { await todo_export(missing, noPublish); } catch (error) { failure = error; }
    assert(failure?.name === 'NotFoundError', 'Missing export did not reject');
    try { await read(missing); throw new Error('Missing export created a file'); }
    catch (error) { assert(error.name === 'NotFoundError', 'Missing export created a file'); }
    const first = await todo_create(source, "Download 'α'", 'First item ✓', ready);
    const second = await todo_create(source, 'Second list', 'Second item', ready);
    const before = await read(source);
    const bytes = await todo_export(source, noPublish);
    assert(bytes instanceof Uint8Array && equal(bytes, before), 'Export is not an exact committed snapshot');
    assert(new TextDecoder().decode(bytes.slice(0, 16)) === 'SQLite format 3\0', 'Export lacks SQLite header');
    const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
    assert(equal(new Uint8Array(await blob.arrayBuffer()), bytes), 'Download Blob changed bytes');
    await write(copy, new Uint8Array(await blob.arrayBuffer()));
    assert(same(await todo_lists(copy, noPublish), [{ id: first.id, title: first.title }, { id: second.id, title: second.title }]), 'Export lost list summaries');
    for (const list of [first, second]) assert(same(await todo_read_list(copy, list.id, noPublish), list), 'Export lost model rows');
    assert(equal(await read(source), before) && equal(await read(copy), bytes), 'Export/verification modified database bytes');
    report(`PASS: snapshot and download Blob match committed bytes (SHA-256 ${await fingerprint(bytes)}); independent copy reopened all rows and integrity_check without publication`);

    const release = await acquireDatabaseLock(source);
    try {
      let busy;
      try { await todo_export(source, noPublish); } catch (error) { busy = error; }
      assert(busy?.sqliteCode === 5, 'Export bypassed exclusive database lock');
    } finally { await release(); }
    assert(equal(await todo_export(source, noPublish), before), 'Export did not recover after contention');

    let enteredResolve, resume;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const pending = todo_add_item(source, first.id, 'Committed after snapshot', () => { enteredResolve(); return gate; });
    pending.catch(() => {});
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('Write never suspended'); })]);
      let overlap;
      try { await todo_export(source, noPublish); } catch (error) { overlap = error; }
      assert(overlap?.message.includes('SQLite probe already running'), 'Export overlapped a suspended COMMIT');
    } finally { resume(); await pending; }
    assert(equal(new Uint8Array(await blob.arrayBuffer()), before) && equal(await read(copy), before), 'Later commit changed earlier snapshot');
    const committed = await read(source);
    assert(!equal(committed, before) && equal(await todo_export(source, noPublish), committed), 'New export did not see later commit');
    const cause = new DOMException('Export recovery check', 'AbortError');
    let rejected;
    try { await todo_add_item(source, first.id, 'Rejected addition', async () => { throw cause; }); } catch (error) { rejected = error; }
    assert(rejected?.sqliteCode === 1034 && rejected.cause === cause, 'Injected COMMIT did not preserve cause');
    assert(equal(await todo_export(source, noPublish), committed) && equal(await read(source), committed), 'Export after failed COMMIT changed committed bytes');
    report('PASS: held lock and suspended COMMIT blocked export; later commits did not alter earlier snapshots; export recovered after contention and rejected COMMIT');

    await todo_delete_list(source, first.id, ready);
    await todo_delete_list(source, second.id, ready);
    const emptyBytes = await read(source);
    await write(copy, await todo_export(source, noPublish));
    assert((await todo_lists(copy, noPublish)).length === 0, 'Empty database export contained lists');
    assert(equal(await todo_export(copy, noPublish), emptyBytes) && equal(await read(source), emptyBytes), 'Empty export failed integrity or modified source');
    await write(copy, new Uint8Array([1, 2, 3, 4]));
    const corrupt = await read(copy);
    let invalid = false;
    try { await todo_export(copy, noPublish); } catch { invalid = true; }
    assert(invalid && equal(await read(copy), corrupt), 'Invalid database export succeeded or modified bytes');
    assert(equal(await todo_export(source, noPublish), emptyBytes), 'Valid export did not recover after invalid database');
    report('PASS: empty TODO database exported and reopened; missing/corrupt databases rejected without creation or modification; subsequent valid export recovered');
  } finally {
    for (const name of [source, copy]) {
      try { await remove(name); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
  }
  report('PASS: export fixtures removed; demo database preserved; unencrypted committed snapshots only');
}
