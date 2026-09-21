import { write, read, _delete as remove, sqlite_writable_probe } from './pkg/jspi_probe.js';
import { acquireDatabaseLock, databaseLockName } from './locks.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
function bounded(promise, phase) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${phase}`)), 60000);
  })]).finally(() => clearTimeout(timer));
}
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

export async function runTerminationChecks(report) {
  assert(navigator.locks?.request && navigator.locks?.query, 'Web Locks required');
  const token = crypto.randomUUID();
  const peer = window.open(`./lock-peer.html#${token}`, '_blank');
  assert(peer, 'Second tab was blocked; allow popups for localhost and retry');
  const name = `lock-test-${token}-termination.sqlite`;
  let readyResolve, readyReject, holdResolve, holdReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let hold;
  const receive = event => {
    if (event.source !== peer || event.origin !== location.origin || event.data?.token !== token) return;
    const message = event.data;
    if (message.ready) readyResolve();
    else if (message.startupError) readyReject(new Error(message.startupError));
    else if (message.id === 1 && hold) {
      if (message.holding) holdResolve();
      else holdReject(new Error(`Owner failed to remain open: ${JSON.stringify(message)}`));
    }
  };
  window.addEventListener('message', receive);
  const cancellation = new AbortController();
  let releaseWaiter;
  let waiter;
  let created = false;
  try {
    await bounded(ready, 'helper initialization');
    await write(name, new Uint8Array());
    created = true;
    await sqlite_writable_probe(name, true, () => Promise.resolve());
    const committed = await read(name);
    assert(committed.length > 0, 'No committed database');
    report(`PASS: committed and closed database before owner-tab test (${committed.length} bytes)`);
    hold = new Promise((resolve, reject) => { holdResolve = resolve; holdReject = reject; });
    peer.postMessage({ token, id: 1, name, action: 'hold-committed' }, location.origin);
    await bounded(hold, 'owner verified database and holding connection');
    report('PASS: helper tab verified committed rows and holds an open connection and exclusive lock');
    let busy = false;
    try { await sqlite_writable_probe(name, false, () => Promise.resolve()); }
    catch (error) {
      if (error.name !== 'DatabaseBusyError' || error.sqliteCode !== 5) throw error;
      busy = true;
    }
    assert(busy, 'Surviving tab acquired while helper still owned the database');
    report('PASS: surviving tab received SQLITE_BUSY before owner termination');

    // This queued Web Lock is test-only; normal SQLite exports stay fail-fast.
    let acquired = false, acquiredResolve, acquiredReject;
    const acquisition = new Promise((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject; });
    const held = new Promise(resolve => { releaseWaiter = resolve; });
    const key = databaseLockName(name);
    waiter = navigator.locks.request(key, { mode: 'exclusive', signal: cancellation.signal }, () => {
      acquired = true;
      acquiredResolve();
      return held;
    });
    // Attach handlers immediately, even if a later assertion fails.
    waiter.catch(acquiredReject);
    acquisition.catch(() => {});
    const snapshot = await navigator.locks.query();
    assert(!acquired && snapshot.held.some(lock => lock.name === key)
      && snapshot.pending.some(lock => lock.name === key),
      'Expected one owner and a queued waiter before closing the owner');
    report('PASS: surviving tab queued for the held lock without stealing ownership');
    peer.close(); // No gate resolution, release message, or Rust cleanup request.
    await bounded(acquisition, 'browser released owner-tab lock');
    assert(peer.closed, 'Owner tab did not close');
    report('PASS: closing owner tab released its lock and granted the queued waiter');
    releaseWaiter();
    await bounded(waiter, 'waiter release before reopening SQLite');
    const result = await sqlite_writable_probe(name, false, () => {
      throw new Error('Termination verification must not publish');
    });
    for (const line of result.split('\n')) report(line);
    assert(equal(await read(name), committed), 'Committed bytes changed after owner termination');
    report('PASS: committed rows and integrity_check survived; published bytes are unchanged');
    await remove(name);
    created = false;
    report('PASS: test database removed; no commit was interrupted and no crash-durability claim');
  } finally {
    peer.close();
    cancellation.abort();
    releaseWaiter?.();
    if (waiter) await bounded(waiter, 'waiter cleanup').catch(() => {});
    window.removeEventListener('message', receive);
    if (created) {
      // Do not remove the file if browser teardown has not yet released ownership.
      try {
        const release = await acquireDatabaseLock(name);
        try { await remove(name); } finally { await release(); }
      } catch { /* Preserve the test failure; a leftover test file is safe. */ }
    }
  }
}
