import init, { encryption_create, encryption_read, encryption_add, encryption_rekey, encryption_export,
  todo_create, read, write, _delete as remove } from './pkg-encryption/jspi_probe.js';
import { acquireDatabaseLock } from './locks.js';
import { assert, equal, fingerprint } from './recovery-state.js';
// Public fixture keys, deliberately not user secrets. No key is stored in the checkpoint.
const key1 = "public encryption probe key α";
const key2 = "public replacement probe key β";
const checkpoint = 'jspi-encryption-check-v1';
const ready = async () => {};
const noPublish = async () => { throw new Error('Read/unsupported operation must not publish'); };
const $ = id => document.getElementById(id);
let lines = [];
const report = line => { lines.push(line); $('log').textContent = lines.join('\n'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const encrypted = bytes => new TextDecoder().decode(bytes.slice(0, 16)) !== 'SQLite format 3\0';
async function rejected(work, predicate, message) {
  let error;
  try { await work(); } catch (failure) { error = failure; }
  assert(error && predicate(error), `${message}: ${error?.message ?? 'unexpected success'}`);
}
async function wrongKeys(name, good, bad) {
  const before = await read(name);
  for (const key of [undefined, 'incorrect public probe key', bad]) {
    await rejected(() => encryption_read(name, key, noPublish), error => error.sqliteCode === 26, 'Missing/wrong key must reject as SQLITE_NOTADB');
    assert(equal(await read(name), before), 'Wrong key modified ciphertext');
  }
  await encryption_read(name, good, noPublish);
}
async function cleanup(names) {
  for (const name of names) { try { await remove(name); } catch (error) { if (error.name !== 'NotFoundError') throw error; } }
}
async function run() {
  assert(!sessionStorage.getItem(checkpoint), 'Reload to verify the pending encrypted fixture');
  lines = [];
  const name = `encryption-check-${crypto.randomUUID()}.sqlite`;
  const copy = `encryption-check-${crypto.randomUUID()}.sqlite`;
  const plain = `encryption-check-${crypto.randomUUID()}.sqlite`;
  let retained = false;
  try {
    let release, enteredResolve;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const pending = encryption_create(name, key1, () => { enteredResolve(); return gate; });
    pending.catch(() => {});
    let expected;
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('Create did not publish'); })]);
      await new Promise(resolve => setTimeout(resolve, 150));
      await rejected(() => encryption_read(name, key1, noPublish), error => error.message.includes('SQLite probe already running'), 'Overlap must reject');
    } finally { release(); clearInterval(timer); expected = await pending; }
    assert(ticks > 0 && expected.length === 1 && expected[0].items.length === 1, 'Encrypted creation failed');
    assert(encrypted(await read(name)), 'Encrypted file still has plaintext header');
    assert(same(await encryption_read(name, key1, noPublish), expected), 'Correct key did not reopen');
    await wrongKeys(name, key1, key2);
    report(`PASS: encrypted shared-model creation and correct-key reopen; missing/wrong keys rejected without changing bytes; JSPI suspension (${ticks} ticks) and overlap rejection`);

    const releaseLock = await acquireDatabaseLock(name);
    try { await rejected(() => encryption_read(name, key1, noPublish), error => error.sqliteCode === 5, 'Held lock must block encrypted open'); }
    finally { await releaseLock(); }
    const committed = await read(name);
    const cause = new DOMException('Encryption publication failure', 'AbortError');
    for (const work of [
      () => encryption_add(name, key1, 'Rejected encrypted insertion', async () => { throw cause; }),
      () => encryption_rekey(name, key1, key2, async () => { throw cause; }),
    ]) {
      await rejected(work, error => error.sqliteCode === 1034 && error.cause === cause, 'Publication failure must preserve code/cause');
      assert(equal(await read(name), committed), 'Failed encrypted operation changed bytes');
      assert(same(await encryption_read(name, key1, noPublish), expected), 'Old key/rows failed after rejection');
    }
    expected = await encryption_add(name, key1, 'Committed encrypted addition ✓', ready);
    assert(expected[0].items.length === 2, 'Encrypted write did not recover');
    assert(same(await encryption_read(name, key1, noPublish), expected), 'Encrypted write did not reopen');
    const beforeRekey = await read(name);
    assert(same(await encryption_rekey(name, key1, key2, ready), expected), 'Rekey changed model');
    assert(!equal(await read(name), beforeRekey), 'Rekey did not change ciphertext');
    await wrongKeys(name, key2, key1);
    report('PASS: encrypted write/rekey publication failures preserved cause and old ciphertext; lock recovered; successful write and key change reopened, with old key rejected');

    const bytes = await encryption_export(name, key2, noPublish);
    assert(encrypted(bytes) && equal(bytes, await read(name)), 'Export is not exact ciphertext');
    const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
    await write(copy, new Uint8Array(await blob.arrayBuffer()));
    assert(same(await encryption_read(copy, key2, noPublish), expected), 'Export copy failed rows/integrity');
    await wrongKeys(copy, key2, key1);
    assert(equal(await read(copy), bytes) && equal(await read(name), bytes), 'Export verification published');
    report('PASS: encrypted snapshot/Blob independently reopened with the new key and integrity_check; source/copy bytes unchanged');

    await rejected(() => encryption_rekey(name, key2, '', noPublish), error => error.sqliteCode === 23, 'Key removal must reject the internal ATTACH under the current policy');
    assert(equal(await read(name), bytes), 'Rejected removal changed ciphertext');
    assert(same(await encryption_read(name, key2, noPublish), expected), 'Key failed after rejected removal');
    const plaintext = await todo_create(plain, 'Plain fixture', 'Unchanged plaintext', ready);
    const plainBytes = await read(plain);
    await rejected(() => encryption_rekey(plain, undefined, key1, noPublish), error => error.sqliteCode === 23, 'Plaintext conversion must reject internal ATTACH');
    assert(equal(await read(plain), plainBytes), 'Rejected conversion modified plaintext');
    assert(same(await encryption_read(plain, undefined, noPublish), [plaintext]), 'Plaintext did not recover');
    report('PASS: in-place plaintext encryption and key removal rejected with SQLITE_AUTH; bytes unchanged and fresh connections recovered');
    await cleanup([copy, plain]);
    sessionStorage.setItem(checkpoint, JSON.stringify({ name, sha256: await fingerprint(bytes), expected, lines }));
    retained = true;
    location.reload();
  } finally { if (!retained) await cleanup([name, copy, plain]); }
}
$('run').onclick = async () => {
  $('run').disabled = true;
  try { await run(); } catch (error) { $('status').textContent = `FAIL: ${error.message ?? error}`; report(error.stack ?? String(error)); }
  finally { if (!sessionStorage.getItem(checkpoint)) $('run').disabled = false; }
};
try {
  await init();
  const saved = sessionStorage.getItem(checkpoint);
  if (saved) {
    const state = JSON.parse(saved);
    assert(/^encryption-check-[0-9a-f-]{36}\.sqlite$/.test(state.name) && /^[0-9a-f]{64}$/.test(state.sha256) && Array.isArray(state.lines), 'Invalid encryption checkpoint');
    lines = state.lines;
    const bytes = await read(state.name);
    assert(await fingerprint(bytes) === state.sha256, 'Ciphertext changed on reload');
    assert(same(await encryption_read(state.name, key2, noPublish), state.expected), 'Encrypted rows changed on reload');
    await wrongKeys(state.name, key2, key1);
    assert(equal(await encryption_export(state.name, key2, noPublish), bytes), 'Reload verification changed ciphertext');
    report('PASS: fresh page/WASM reopened encrypted rows and integrity_check; old/wrong/missing keys rejected; SHA-256 unchanged');
    await cleanup([state.name]);
    sessionStorage.removeItem(checkpoint);
    report('PASS: encryption fixtures removed; demo preserved; conversion/removal remain unsupported, no power-loss or SQLCipher compatibility claim');
    $('status').textContent = 'PASS: all encryption boundary checks completed';
  } else { $('status').textContent = 'Ready. Only disposable fixtures and public test keys are used.'; }
  $('run').disabled = false;
} catch (error) { $('status').textContent = `FAIL: ${error.message ?? error}`; report(error.stack ?? String(error)); }
