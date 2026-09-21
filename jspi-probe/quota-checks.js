import { write, read, _delete as remove, sqlite_writable_probe, sqlite_publication_probe } from './pkg/jspi_probe.js';
import { assert, equal } from './recovery-state.js';

// A hard ceiling prevents trying to fill the user's disk if profile setup is missing.
const CAP = 48 * 1024 * 1024;
const ready = async () => {};
const noPublish = async () => { throw new Error('Verification must not publish'); };
export async function runQuotaChecks(report) {
  // Report the estimate, but establish exhaustion through actual OPFS failures.
  // The allocation budget below is enforced independently of this estimate.
  try {
    const estimate = await navigator.storage.estimate();
    report(`INFO: storage estimate quota=${estimate.quota}, usage=${estimate.usage}; filler cap=${CAP} bytes`);
    if (estimate.quota > CAP) report('INFO: estimate exceeds the test budget; the reduced quota may not be active. Continuing only within the fixed filler cap.');
  } catch (error) { report(`INFO: storage estimate unavailable: ${error}; allocation limits still apply`); }
  const name = `quota-final-${crypto.randomUUID()}.sqlite`;
  const root = await navigator.storage.getDirectory();
  const folderName = `quota-fill-${crypto.randomUUID()}`;
  const folder = await root.getDirectoryHandle(folderName, { create: true });
  let created = false, passed = false, total = 0, index = 0;
  const started = performance.now();
  try {
    await write(name, new Uint8Array());
    created = true;
    await sqlite_writable_probe(name, true, ready);
    const original = await read(name);
    for (const size of [256 * 1024, 4096]) {
      let exhausted = false;
      while (total + size <= CAP && index < 1024 && performance.now() - started < 120000) {
        const entry = `${index++}.bin`;
        let stream;
        try {
          const file = await folder.getFileHandle(entry, { create: true });
          stream = await file.createWritable();
          const bytes = new Uint8Array(size);
          // Real bytes, not sparse truncate or a fabricated quota error.
          for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
          await stream.write(bytes);
          await stream.close();
          total += size;
        } catch (error) {
          try { await stream?.abort(); } catch { /* preserve failure */ }
          try { await folder.removeEntry(entry); } catch { /* may not exist */ }
          if (error?.name !== 'QuotaExceededError') throw error;
          exhausted = true;
          report(`PASS: real OPFS QuotaExceededError at ${size}-byte allocation (${total} filler bytes retained)`);
          break;
        }
      }
      assert(exhausted, `Real quota was not reached within the byte/file/time budget (${total} filler bytes, ${index} attempts). `
        + 'Check that dom.quotaManager.temporaryStorage.fixedLimit is a Number set to 32768 in the running test profile, then fully exit and restart that profile. This is not a pass.');
    }
    let failure, stage = 'before callback';
    try {
      await sqlite_publication_probe(name, 'grow', async value => { stage = value; });
    } catch (error) { failure = error; }
    assert(failure?.sqliteCode === 1034 && failure.cause?.name === 'QuotaExceededError',
      `Expected real quota failure in xSync; code=${failure?.sqliteCode}, cause=${failure?.cause}, last stage=${stage}`);
    assert(equal(await read(name), original), 'Quota failure changed committed bytes; preserve database for investigation');
    report(`PASS: growing SQL COMMIT hit real quota at ${stage}; SQLITE_IOERR_FSYNC retained QuotaExceededError; committed bytes unchanged`);
    await sqlite_publication_probe(name, 'verify-old', noPublish);
    await root.removeEntry(folderName, { recursive: true });
    await sqlite_publication_probe(name, 'mutate', ready);
    await sqlite_publication_probe(name, 'verify-new', noPublish);
    report('PASS: after freeing filler files, a fresh connection acquired the lock, committed, reopened, and passed integrity_check');
    passed = true;
  } finally {
    // Always release quota pressure; preserve a failed database as evidence.
    try { await root.removeEntry(folderName, { recursive: true }); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    if (created && passed) await remove(name);
    else if (created) report(`EVIDENCE: failed test database retained as ${name}`);
  }
  report('PASS: actual quota exhaustion and recovery completed; filler and test database removed');
}
