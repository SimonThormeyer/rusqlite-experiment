import { write, read, _delete as remove, sqlite_readonly_probe, sqlite_callback_probe } from './pkg/jspi_probe.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
async function rejects(operation, check) {
  try { await operation(); } catch (error) {
    assert(check(error), `Unexpected error: ${error}; SQLite code: ${error.sqliteCode}; cause: ${error.cause}`);
    return;
  }
  throw new Error('Expected rejection');
}

export async function runReadonlyChecks(report) {
  const response = await fetch('./fixtures/readonly.sqlite');
  assert(response.ok, `Fixture download failed: ${response.status}`);
  const fixture = new Uint8Array(await response.arrayBuffer());
  const name = `readonly-${crypto.randomUUID()}.sqlite`;
  await write(name, fixture);
  try {
    let ticks = 0;
    let delayed = false;
    // The hook runs inside xRead, after xOpen, so the observed progress belongs to xRead.
    const beforeRead = () => {
      if (delayed) return Promise.resolve();
      delayed = true;
      return new Promise(resolve => {
        const timer = setInterval(() => ticks++, 10);
        setTimeout(() => { clearInterval(timer); resolve(); }, 150);
      });
    };
    const pending = sqlite_readonly_probe(name, beforeRead);
    const completion = pending.then(value => ({ value }), error => ({ error }));
    await rejects(() => sqlite_readonly_probe(name, () => Promise.resolve()),
      error => error.message.includes('already running'));
    await rejects(() => sqlite_callback_probe(Promise.resolve(), 'unused-marker'),
      error => error.message.includes('already running'));
    const result = await completion;
    if (result.error) throw result.error;
    const [reads, offsets, shorts] = result.value;
    assert(ticks > 0 && delayed, 'No event-loop progress inside xRead');
    assert(reads > 2 && offsets > 0 && shorts === 2, `Unexpected read counts: ${result.value}`);
    report(`PASS: OPFS xRead suspended and resumed (${ticks} ticks; ${reads} reads; ${offsets} nonzero offsets)`);
    report('PASS: fixture rows, binary payload, aggregate query, and integrity_check');
    report('PASS: read-only SQL rejected writes; EOF and beyond-EOF reads returned zero-padded SQLITE_IOERR_SHORT_READ');
    report('PASS: overlapping read-only and callback probes rejected');

    await rejects(() => sqlite_readonly_probe(name, count => count === 2
      ? Promise.reject(new DOMException('injected xRead failure', 'AbortError'))
      : Promise.resolve()), error => error.sqliteCode === 266 && error.cause?.name === 'AbortError');
    report('PASS: rejected Promise in xRead mapped to SQLITE_IOERR_READ with original cause');

    const again = await sqlite_readonly_probe(name, () => Promise.resolve());
    assert(again[0] > 2 && again[1] > 0 && again[2] === 2, 'Reopen after read failure did not pass');
    report('PASS: new connection reopened OPFS fixture and queried successfully after failure');
    assert(equal(await read(name), fixture), 'Read-only probe changed fixture bytes');
    report('PASS: OPFS fixture is byte-for-byte unchanged');
  } finally { await remove(name); }
  report('PASS: test fixture removed; no database writes or journals implemented');
}
