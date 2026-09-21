import { write, read, _delete as remove, sqlite_writable_probe, sqlite_publication_probe } from './pkg/jspi_probe.js';
import { acquireDatabaseLock, databaseLockName } from './locks.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const readyHook = async () => {};
const noPublish = async () => { throw new Error('Verification must not publish'); };
function bounded(promise, phase) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${phase}`)), 60000);
  })]).finally(() => clearTimeout(timer));
}

export async function runPublicationChecks(report) {
  assert(navigator.locks?.query, 'Web Locks required');
  const token = crypto.randomUUID();
  // One popup opened within user activation; reload its document between cases.
  const url = `./lock-peer.html#${token}`;
  const peer = window.open(url, '_blank');
  assert(peer, 'Allow popups for localhost and retry');
  let readyResolve, readyReject, heldResolve, heldReject, command = 0, phase;
  let readiness;
  const resetReady = () => {
    readiness = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    readiness.catch(() => {});
  };
  resetReady();
  const receive = event => {
    if (event.source !== peer || event.origin !== location.origin || event.data?.token !== token) return;
    const message = event.data;
    if (message.ready) readyResolve();
    else if (message.startupError) readyReject(new Error(message.startupError));
    else if (message.id === command) {
      if (message.holding === phase) heldResolve();
      else heldReject(new Error(`Publication owner failed: ${JSON.stringify(message)}`));
    }
  };
  window.addEventListener('message', receive);
  const name = `lock-test-${token}-publication.sqlite`;
  let created = false;
  let waiter, releaseWaiter, cancellation;
  try {
    await bounded(readiness, 'helper initialization');
    await write(name, new Uint8Array());
    created = true;
    await sqlite_writable_probe(name, true, readyHook);
    const oldBytes = await read(name);
    await sqlite_publication_probe(name, 'mutate', readyHook);
    const newBytes = await read(name);
    assert(!equal(oldBytes, newBytes), 'Reference COMMIT did not change bytes');
    await sqlite_publication_probe(name, 'verify-new', noPublish);
    report('PASS: reference COMMIT produced a distinct complete database with expected rows and integrity_check');

    for (const fault of ['write-after-abort', 'truncate-after-abort', 'close-after-abort', 'synthetic-quota', 'after-close-rejection']) {
      await write(name, oldBytes);
      let cause, causeCaptured = false, injected = false;
      const hook = async (stage, stream) => {
        const target = fault === 'after-close-rejection' ? 'after-close' : 'before-close';
        if (stage !== target) return;
        injected = true;
        try {
          if (fault === 'synthetic-quota') throw new DOMException('Injected quota failure; not real exhaustion', 'QuotaExceededError');
          if (fault === 'after-close-rejection') throw new Error('Injected failure after successful close');
          await stream.abort();
          if (fault === 'write-after-abort') await stream.write(new Uint8Array([1]));
          if (fault === 'truncate-after-abort') await stream.truncate(0);
          if (fault === 'close-after-abort') await stream.close();
        } catch (error) { cause = error; causeCaptured = true; throw error; }
        throw new Error(`Expected browser rejection: ${fault}`);
      };
      let failure;
      try { await sqlite_publication_probe(name, 'mutate', hook); } catch (error) { failure = error; }
      // abort() without a reason can make later writes reject with undefined.
      // A rejection value need not be an Error, or even truthy.
      const hasCause = failure != null && Object.hasOwn(failure, 'cause');
      assert(injected && causeCaptured && failure?.sqliteCode === 1034
        && hasCause && Object.is(failure.cause, cause),
      `${fault}: expected SQLITE_IOERR_FSYNC (1034) with original cause; `
        + `injected=${injected}, caught=${causeCaptured}, code=${failure?.sqliteCode}, `
        + `hasCause=${hasCause}, sameCause=${Object.is(failure?.cause, cause)}, `
        + `expected cause=${String(cause)}, actual cause=${String(failure?.cause)}; got ${failure}`);
      const isNew = fault === 'after-close-rejection';
      assert(equal(await read(name), isNew ? newBytes : oldBytes), `${fault}: unexpected stored bytes`);
      await sqlite_publication_probe(name, isNew ? 'verify-new' : 'verify-old', noPublish);
      // Recovery includes a subsequent successful write, not just reopening.
      if (!isNew) {
        await sqlite_publication_probe(name, 'mutate', readyHook);
        await sqlite_publication_probe(name, 'verify-new', noPublish);
        assert(equal(await read(name), newBytes), `${fault}: retry produced unexpected bytes`);
      }
      report(`PASS: ${fault}: SQLITE_IOERR_FSYNC preserved cause; complete ${isNew ? 'new' : 'old'} database reopened; lock and connection recovered`);
    }

    const phases = ['before-open', 'after-open', 'after-half-write', 'before-close', 'close-started', 'after-close'];
    for (phase of phases) {
      await write(name, oldBytes);
      const held = new Promise((resolve, reject) => { heldResolve = resolve; heldReject = reject; });
      peer.postMessage({ token, id: ++command, name, action: 'publication', phase }, location.origin);
      await bounded(held, `COMMIT paused at ${phase}`);
      let busy = false;
      try { await sqlite_publication_probe(name, 'verify-old', noPublish); }
      catch (error) { if (error.name !== 'DatabaseBusyError' || error.sqliteCode !== 5) throw error; busy = true; }
      assert(busy, `${phase}: owner did not exclude contender`);
      if (!['close-started', 'after-close'].includes(phase)) {
        assert(equal(await read(name), oldBytes), `${phase}: unclosed stream changed published bytes`);
      }

      cancellation = new AbortController();
      let acquiredResolve, acquiredReject, acquired = false;
      const acquisition = new Promise((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject; });
      acquisition.catch(() => {});
      const gate = new Promise(resolve => { releaseWaiter = resolve; });
      const key = databaseLockName(name);
      waiter = navigator.locks.request(key, { signal: cancellation.signal }, () => {
        acquired = true;
        acquiredResolve();
        return gate;
      });
      waiter.catch(acquiredReject);
      const snapshot = await navigator.locks.query();
      assert(!acquired && snapshot.held.some(l => l.name === key) && snapshot.pending.some(l => l.name === key),
        `${phase}: lock waiter was not queued`);
      if (phase === 'after-close') peer.close();
      else {
        resetReady();
        // A fresh document and WASM instance destroy the suspended owner without
        // running its rollback/abort code. No gate is resolved.
        peer.location.href = `./lock-peer.html?case=${command}#${token}`;
      }
      await bounded(acquisition, `${phase}: owner teardown and lock release`);
      releaseWaiter();
      await bounded(waiter, 'waiter release');
      waiter = undefined;
      const actual = await read(name);
      const isOld = equal(actual, oldBytes), isNew = equal(actual, newBytes);
      assert(isOld || isNew, `${phase}: database is neither complete reference version`);
      if (phase === 'after-close') assert(isNew && peer.closed, 'Successful close must retain new bytes');
      else if (phase !== 'close-started') assert(isOld, `${phase}: expected previous committed version`);
      await sqlite_publication_probe(name, isNew ? 'verify-new' : 'verify-old', noPublish);
      assert(equal(await read(name), actual), `${phase}: verification modified bytes`);
      // Also verify no abandoned stream prevents the next writer.
      if (isOld) {
        await sqlite_publication_probe(name, 'mutate', readyHook);
        await sqlite_publication_probe(name, 'verify-new', noPublish);
      }
      report(`PASS: ${phase}: owner terminated, lock reacquired, complete ${isNew ? 'new' : 'old'} bytes and rows verified; integrity_check and recovery succeeded`);
      if (phase !== 'after-close') await bounded(readiness, 'fresh helper document');
    }
    await remove(name);
    created = false;
    report('PASS: test database removed; post-close errors can leave a committed result despite COMMIT rejection');
    report('SCOPE: close-started races completion; synthetic quota is not exhaustion; document/tab teardown is not process crash or power loss; persistent recovery design remains open');
  } finally {
    peer.close();
    cancellation?.abort();
    releaseWaiter?.();
    if (waiter) await bounded(waiter, 'waiter cleanup').catch(() => {});
    window.removeEventListener('message', receive);
    if (created) {
      try {
        const release = await acquireDatabaseLock(name);
        try { await remove(name); } finally { await release(); }
      } catch { /* Leave the file if ownership is unavailable. */ }
    }
  }
}
