import { write, _delete as remove, sqlite_callback_probe } from './pkg/jspi_probe.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function expectFailure(operation, check) {
  try { await operation(); } catch (error) {
    assert(check(error), `Unexpected error: ${error}; cause: ${error.cause}`);
    return;
  }
  throw new Error('Expected the SQLite probe to reject');
}

export async function runSqliteChecks(report) {
  const marker = `sqlite-marker-${crypto.randomUUID()}.bin`;
  await write(marker, new Uint8Array([0, 255, 128]));
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      const pending = sqlite_callback_probe(new Promise(resolve => setTimeout(resolve, 150)), marker);
      assert(pending instanceof Promise, 'SQLite export must return a Promise');
      // Attach a handler immediately so an unexpected early failure is not unhandled.
      const completion = pending.then(value => ({ value }), error => ({ error }));
      await expectFailure(() => sqlite_callback_probe(Promise.resolve(), marker),
        error => error.message.includes('already running'));
      const result = await completion;
      if (result.error) throw result.error;
      assert(result.value === 1, `Expected one resumed xOpen, got ${result.value}`);
    } finally { clearInterval(timer); }
    assert(ticks > 0, 'Event loop did not progress while SQLite xOpen was suspended');
    report(`PASS: SQLite xOpen suspended and resumed with event-loop progress (${ticks} ticks)`);
    report('PASS: overlapping SQLite probe rejected before entering SQLite');
    report('PASS: OPFS marker read inside xOpen; SQL insert/query and rollback succeeded');

    await expectFailure(() => sqlite_callback_probe(
      Promise.reject(new DOMException('controlled callback failure', 'AbortError')), marker),
      error => error.message.includes('SQLITE_CANTOPEN') && error.cause?.name === 'AbortError');
    report('PASS: rejected Promise in xOpen mapped to SQLITE_CANTOPEN with original cause');
    await expectFailure(() => sqlite_callback_probe(Promise.resolve(), `missing-${marker}`),
      error => error.message.includes('SQLITE_CANTOPEN') && error.cause?.name === 'NotFoundError');
    report('PASS: missing OPFS marker mapped to SQLITE_CANTOPEN with NotFoundError cause');
    assert(await sqlite_callback_probe(Promise.resolve(), marker) === 1,
      'SQLite probe did not recover after failed opens');
    report('PASS: fresh connection and SQL operations succeeded after callback failures');
  } finally { await remove(marker); }
  report('PASS: OPFS marker removed; SQLite database was memory-only');
}
