import { initialize, Session, errorCode, type State } from './backend';
import * as wasm from '../jspi-probe/pkg-encryption/jspi_probe.js';
import { acquireDatabaseLock } from '../jspi-probe/locks.js';
const key1 = "public SPA fixture password α";
const key2 = "public SPA replacement password β";
const checkpoint = 'encrypted-spa-checks-v1';
const ready = async () => {};
const $ = (id: string) => document.getElementById(id)!;
let lines: string[] = [];
const report = (line: string) => { lines.push(line); $('log').textContent = lines.join('\n'); };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), value => value.toString(16).padStart(2, '0')).join('');
async function rejects(work: () => Promise<unknown>, predicate: (error: unknown) => boolean, message: string): Promise<void> {
  let failure;
  try { await work(); } catch (error) { failure = error; }
  assert(failure && predicate(failure), `${message}: ${failure instanceof Error ? failure.message : String(failure ?? 'unexpected success')}`);
}
async function cleanup(names: string[]): Promise<void> {
  for (const name of names) { try { await wasm._delete(name); } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError') && (error as {name?: string}).name !== 'NotFoundError') throw error; } }
}
async function run(): Promise<void> {
  assert(!sessionStorage.getItem(checkpoint), 'Reload to finish the pending checkpoint');
  lines = [];
  const name = `app-check-${crypto.randomUUID()}.sqlite`;
  const copy = `app-check-${crypto.randomUUID()}.sqlite`;
  let retained = false;
  let hook = ready;
  const session = new Session(name, wasm, () => hook());
  try {
    assert(await session.inspect() === 'missing', 'Fixture already exists');
    const empty = await session.open(key1, true);
    assert(empty.lists.length === 0 && empty.selected === null, 'Initialization did not produce empty schema');
    const initial = await session.export();
    assert(new TextDecoder().decode(initial.slice(0, 16)) !== 'SQLite format 3\0', 'New database is plaintext');
    await rejects(() => new Session(name).open(key2, true), error => String(error).includes('already exists'), 'Create overwrote existing database');
    assert(equal(await wasm.read(name), initial), 'Rejected creation changed bytes');
    session.lock();
    await rejects(() => session.open('wrong password', false), error => errorCode(error) === 26, 'Wrong password accepted');
    assert(!session.unlocked && equal(await wasm.read(name), initial), 'Wrong password unlocked or changed bytes');
    await session.open(key1, false);
    report('PASS: encrypted empty initialization, duplicate-create protection, lock/unlock and wrong-password rejection preserved bytes');

    const first = await session.createList("First 'α'");
    const second = await session.createList('Second list');
    assert(first.items.length === 0 && second.items.length === 0, 'SPA list creation requires an item');
    let selected = await session.addItem(first.id, 'Item one');
    const itemId = selected.items[0].id;
    selected = await session.updateItem(first.id, itemId, "Edited 'β' ✓", true);
    assert(selected.items[0].completed && selected.items[0].description === "Edited 'β' ✓", 'Edit/completion failed');
    selected = await session.renameList(first.id, 'Renamed first');
    const saved = await session.export();
    hook = async () => { throw new Error('No-op must not publish'); };
    await session.renameList(first.id, selected.title);
    await session.updateItem(first.id, itemId, selected.items[0].description, true);
    await rejects(() => session.updateItem(second.id, itemId, 'Wrong list', false), () => true, 'Cross-list update accepted');
    await rejects(() => session.addItem(first.id, '   '), () => true, 'Blank item accepted');
    assert(equal(await session.export(), saved), 'No-op/invalid operations changed bytes');
    hook = ready;
    assert(same((await session.state(first.id)).selected, selected), 'Selected older list did not reopen');
    assert((await session.state(second.id)).selected?.items.length === 0, 'Other list changed');
    report('PASS: empty lists, list selection/rename, item add/edit/completion, no-op saves, validation and list isolation through the SPA adapter');

    const cause = new DOMException('SPA pre-publication failure', 'AbortError');
    hook = async () => { throw cause; };
    await rejects(() => session.addItem(first.id, 'Must not persist'), error => errorCode(error) === 1034 && (error as Error).cause === cause, 'Publication failure lost code/cause');
    assert(!session.unlocked && equal(await wasm.read(name), saved), 'Failed publication retained unlocked session or changed bytes');
    hook = ready;
    await session.open(key1, false, first.id);
    let enteredResolve!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    hook = () => { enteredResolve(); return gate; };
    const pending = session.addItem(first.id, 'Recovered item');
    pending.catch(() => {});
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('No publication suspension'); })]);
      await new Promise(resolve => setTimeout(resolve, 150));
      await rejects(() => session.state(first.id), error => String(error).includes('already running'), 'Session admitted overlapping action');
      await rejects(() => new Session(name).open(key1, false), error => String(error).includes('already running'), 'WASM admitted second session during suspension');
      let refusedLock = false;
      try { session.lock(); } catch { refusedLock = true; }
      assert(refusedLock, 'Session discarded password while operation was running');
    } finally { release(); clearInterval(timer); selected = await pending; hook = ready; }
    assert(ticks > 0 && selected.items.length === 2, 'Suspension/recovery failed');
    const releaseLock = await acquireDatabaseLock(name);
    try { await rejects(() => session.state(), error => errorCode(error) === 5, 'Held Web Lock did not block app'); }
    finally { await releaseLock(); }
    await session.state(first.id);
    report(`PASS: rejected publication required explicit unlock; fresh write recovered; suspension (${ticks} ticks), overlapping actions, in-flight lock and held Web Lock handled`);

    const beforeKey = await session.export();
    hook = async () => { throw cause; };
    await rejects(() => session.changePassword(key2), error => errorCode(error) === 1034, 'Rekey failure did not surface');
    assert(!session.unlocked && equal(await wasm.read(name), beforeKey), 'Failed rekey changed bytes or retained credentials');
    hook = ready;
    await session.open(key1, false, first.id);
    await rejects(() => session.changePassword(''), () => true, 'Empty replacement key accepted');
    await session.changePassword(key2);
    session.lock();
    await rejects(() => session.open(key1, false), error => errorCode(error) === 26, 'Old password accepted after rekey');
    await session.open(key2, false, first.id);
    const cipher = await session.export();
    const blob = new Blob([Uint8Array.from(cipher)], { type: 'application/vnd.sqlite3' });
    await wasm.write(copy, new Uint8Array(await blob.arrayBuffer()));
    const independent = new Session(copy);
    assert(same(await independent.open(key2, false, first.id), await session.state(first.id)), 'Ciphertext download copy differs');
    assert(equal(await wasm.read(copy), cipher), 'Export verification published');
    independent.lock();
    const removed = selected.items[1].id;
    selected = await session.deleteItem(first.id, removed);
    assert(selected.items.length === 1, 'Item deletion failed');
    assert(equal(await wasm.read(copy), cipher), 'Later mutation changed exported copy');
    await session.deleteList(second.id);
    assert((await session.state(first.id)).lists.length === 1, 'List deletion failed');
    report('PASS: rejected key change locked the session; successful key change rejected old password; ciphertext download copy reopened independently and stayed unchanged after later writes');
    await cleanup([copy]);
    const expected = await session.state(first.id);
    const bytes = await session.export();
    sessionStorage.setItem(checkpoint, JSON.stringify({ name, expected, sha256: await hash(bytes), lines }));
    retained = true;
    session.lock();
    location.reload();
  } finally { if (!retained) await cleanup([name, copy]); }
}
async function resume(): Promise<boolean> {
  const saved = sessionStorage.getItem(checkpoint);
  if (!saved) return false;
  const state = JSON.parse(saved) as { name: string; expected: State; sha256: string; lines: string[] };
  assert(/^app-check-[0-9a-f-]{36}\.sqlite$/.test(state.name) && /^[0-9a-f]{64}$/.test(state.sha256) && Array.isArray(state.lines), 'Invalid checkpoint');
  lines = state.lines;
  const session = new Session(state.name);
  assert(!session.unlocked, 'Fresh page retained password');
  await rejects(() => session.open(key1, false), error => errorCode(error) === 26, 'Old key accepted after reload');
  assert(same(await session.open(key2, false, state.expected.selected?.id), state.expected), 'Model changed across reload');
  assert(await hash(await session.export()) === state.sha256, 'Reload verification modified bytes');
  await session.deleteList(state.expected.selected!.id);
  const empty = await session.state();
  assert(empty.lists.length === 0 && empty.selected === null, 'Final list deletion failed');
  await session.createList('Created after deletion');
  assert((await session.state()).selected?.items.length === 0, 'Creation after last deletion failed');
  session.lock();
  await cleanup([state.name]);
  sessionStorage.removeItem(checkpoint);
  report('PASS: fresh page required unlock; selected rows and ciphertext SHA-256 survived; final-list deletion and subsequent creation succeeded');
  report('PASS: integration fixtures removed; real app and probe databases preserved');
  return true;
}
const button = $('run') as HTMLButtonElement;
button.onclick = async () => {
  button.disabled = true;
  try { await run(); }
  catch (error) { $('status').textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; report(error instanceof Error ? error.stack ?? error.message : String(error)); }
  finally { if (!sessionStorage.getItem(checkpoint)) button.disabled = false; }
};
try { await initialize(); const done = await resume(); $('status').textContent = done ? 'PASS: all encrypted SPA integration checks completed' : 'Ready.'; button.disabled = false; }
catch (error) { $('status').textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; }
