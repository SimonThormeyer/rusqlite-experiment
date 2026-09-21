import { write, read, _delete as remove, sqlite_writable_probe } from './pkg/jspi_probe.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
function timeout(promise, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 60000);
  })]).finally(() => clearTimeout(timer));
}

export async function runCrossTabChecks(report) {
  if (!navigator.locks?.request) throw new Error('This probe requires the Web Locks API');
  const token = crypto.randomUUID();
  // Open synchronously in the user's button handler, before the first await.
  const peer = window.open(`./lock-peer.html#${token}`, '_blank');
  assert(peer, 'Second tab was blocked; allow popups for localhost and retry');
  const name = `lock-test-${token}.sqlite`;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const requests = new Map();
  let sequence = 0;
  const receive = event => {
    if (event.source !== peer || event.origin !== location.origin || event.data?.token !== token) return;
    const message = event.data;
    if (message.ready) readyResolve();
    else if (message.startupError) readyReject(new Error(message.startupError));
    else requests.get(message.id)?.(message);
  };
  window.addEventListener('message', receive);
  const command = async action => {
    const id = ++sequence;
    const result = new Promise(resolve => requests.set(id, resolve));
    peer.postMessage({ token, id, name, action }, location.origin);
    try { return await timeout(result, `second tab ${action}`); }
    finally { requests.delete(id); }
  };
  let release;
  let owner;
  let created = false;
  let settled = false;
  try {
    await timeout(ready, 'second tab initialization');
    report('PASS: second tab initialized its own WASM instance');
    await write(name, new Uint8Array());
    created = true;
    let enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    let publications = 0;
    owner = sqlite_writable_probe(name, true, () => {
      // First two publications belong to the direct callback tests; the third
      // runs with the SQL connection open while creating the schema.
      if (++publications === 3) { enteredResolve(); return hold; }
      return Promise.resolve();
    }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await timeout(Promise.race([entered, owner.then(result => {
      throw result.error ?? new Error('Owner finished without reaching the SQL publication gate');
    })]), 'owner holding the database');
    const before = await read(name);
    for (const action of ['verify', 'readonly']) {
      const result = await command(action);
      assert(result.error?.name === 'DatabaseBusyError' && result.error.sqliteCode === 5,
        `Expected SQLITE_BUSY for ${action}, got ${JSON.stringify(result)}`);
    }
    const after = await read(name);
    assert(before.length === after.length && before.every((byte, i) => byte === after[i]),
      'Contending tab changed the database');
    report('PASS: second-tab writable and read-only opens rejected with SQLITE_BUSY while owner held the lock');
    report('PASS: rejected contenders left database bytes unchanged');
    release();
    const completed = await timeout(owner, 'owner completion and lock release');
    if (completed.error) throw completed.error;
    report('PASS: owner completed SQL publication and released its lock');
    const verified = await command('verify');
    assert(!verified.error, `Second tab could not acquire after release: ${JSON.stringify(verified.error)}`);
    report('PASS: second tab acquired after release and verified committed rows and integrity_check');

    const rejected = await command('invalid-create');
    assert(rejected.error?.message.includes('creation requires an empty file'),
      `Expected validation failure after acquiring lock: ${JSON.stringify(rejected)}`);
    await sqlite_writable_probe(name, false, () => Promise.resolve());
    report('PASS: lock released after second-tab error; original tab reopened successfully');
    await remove(name);
    created = false;
    report('PASS: test database removed; cooperative exclusive access only, no crash-recovery claim');
  } finally {
    release?.();
    // Do not delete the file underneath an owner whose completion is unknown.
    if (owner && !settled) await timeout(owner, 'owner cleanup').catch(() => {});
    if (created && (!owner || settled)) await remove(name).catch(() => {});
    window.removeEventListener('message', receive);
    peer.close();
  }
}
