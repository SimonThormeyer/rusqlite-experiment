import { write, read, _delete as remove, sqlite_writable_probe, sqlite_readonly_probe } from './pkg/jspi_probe.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
async function rejects(operation, check) {
  try { await operation(); } catch (error) {
    assert(check(error), `Unexpected error: ${error}; code=${error.sqliteCode}; cause=${error.cause}`);
    return;
  }
  throw new Error('Expected rejection');
}

export async function runWritableChecks(report) {
  const name = `writable-${crypto.randomUUID()}.sqlite`;
  await write(name, new Uint8Array());
  try {
    let ticks = 0;
    let calls = 0;
    const hook = () => {
      if (++calls !== 1) return Promise.resolve();
      return new Promise(resolve => {
        const timer = setInterval(() => ticks++, 10);
        setTimeout(() => { clearInterval(timer); resolve(); }, 150);
      });
    };
    const pending = sqlite_writable_probe(name, true, hook);
    const completion = pending.then(value => ({ value }), error => ({ error }));
    await rejects(() => sqlite_readonly_probe(name, () => Promise.resolve()),
      error => error.message.includes('already running'));
    const result = await completion;
    if (result.error) throw result.error;
    assert(ticks > 0, 'No event-loop progress during xSync publication');
    for (const line of result.value.split('\n')) report(line);
    report(`PASS: xSync suspended with event-loop progress (${ticks} ticks); overlapping SQLite probe rejected`);
    const committed = await read(name);
    assert(committed.length > 0, 'No database published');
    const reopened = await sqlite_writable_probe(name, false, () => Promise.resolve());
    for (const line of reopened.split('\n')) report(line);
    assert(equal(await read(name), committed), 'Verification changed published database bytes');
    report('PASS: reopening discarded buffered state; committed rows survived and uncommitted deletion did not');
  } finally { await remove(name); }

  const failedName = `failed-publication-${crypto.randomUUID()}.sqlite`;
  await write(failedName, new Uint8Array());
  try {
    let calls = 0;
    // Direct callback checks publish twice; the next publication is reached by SQL.
    await rejects(() => sqlite_writable_probe(failedName, true, () => ++calls === 3
      ? Promise.reject(new DOMException('injected before publication', 'AbortError'))
      : Promise.resolve()), error => error.sqliteCode === 1034 && error.cause?.name === 'AbortError');
    assert((await read(failedName)).length === 0, 'Pre-publication failure changed the empty file');
    report('PASS: SQL publication rejection mapped to SQLITE_IOERR_FSYNC; pre-publication contents unchanged');
    await sqlite_writable_probe(failedName, true, () => Promise.resolve());
    await sqlite_writable_probe(failedName, false, () => Promise.resolve());
    report('PASS: fresh VFS/connection recovered after injected publication failure');
  } finally { await remove(failedName); }
  report('PASS: test files removed; memory journal only, no crash-durability claim');
}
