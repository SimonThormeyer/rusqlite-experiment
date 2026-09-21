import init, { write, read, _delete as remove, sqlite_writable_probe, sqlite_publication_probe } from './pkg/jspi_probe.js';
import { runQuotaChecks } from './quota-checks.js';
import { acquireDatabaseLock } from './locks.js';
import { phases, assert, equal, fingerprint, validateCheckpoint, classify } from './recovery-state.js';

const $ = id => document.getElementById(id);
const key = 'jspi-final-crash-v1', resultsKey = 'jspi-final-results-v1';
const instance = crypto.randomUUID();
const ready = async () => {};
const noPublish = async () => { throw new Error('Read-only verification must not publish'); };
let checkpoint, preparedHere = false, running = false, lines = [], results = [];
const report = line => { lines.push(line); $('log').textContent = lines.join('\n'); };
function render() {
  for (const id of ['quota', 'prepare', 'import', 'phase']) $(id).disabled = running;
  $('download').disabled = running || !checkpoint;
  $('arm').disabled = running || !preparedHere;
  $('verify').disabled = running || !checkpoint || checkpoint.instance === instance;
  $('discard').disabled = running || !checkpoint;
  $('export').disabled = running;
  $('coverage').textContent = ['Successful runs recorded in this profile (download results after each restart):',
    `actual quota: ${results.filter(r => r.kind === 'quota').length}/2`,
    ...phases.map(phase => `${phase}: ${results.filter(r => r.kind === 'crash' && r.phase === phase).length}/2`)
  ].join('\n');
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function record(value) {
  results.push({ ...value, time: new Date().toISOString(), browser: navigator.userAgent, lines: [...lines] });
  try { localStorage.setItem(resultsKey, JSON.stringify(results)); }
  catch (error) { report(`Results could not be saved in localStorage: ${error}. Download results now.`); }
}
async function execute(action) {
  running = true; lines = []; report(''); render();
  try {
    assert($('isolated').checked, 'Use the dedicated test profile and check its confirmation box');
    await action();
  } catch (error) {
    $('status').textContent = `FAIL: ${error.message ?? error}`;
    report(error.stack ?? String(error));
  } finally { running = false; render(); }
}
for (const phase of phases) {
  const option = document.createElement('option'); option.value = phase; option.textContent = phase; $('phase').append(option);
}
$('quota').onclick = () => execute(async () => {
  assert(!checkpoint, 'Verify or discard the pending crash checkpoint before quota testing');
  $('status').textContent = 'Filling the reduced quota…';
  await runQuotaChecks(report);
  record({ kind: 'quota' });
  $('status').textContent = 'PASS: actual quota exhaustion and recovery';
});
$('prepare').onclick = () => execute(async () => {
  assert(!checkpoint, 'Verify or discard the pending checkpoint before preparing another');
  const name = `crash-final-${crypto.randomUUID()}.sqlite`;
  await write(name, new Uint8Array());
  try {
    await sqlite_writable_probe(name, true, ready);
    const oldBytes = await read(name);
    await sqlite_publication_probe(name, 'mutate', ready);
    await sqlite_publication_probe(name, 'verify-new', noPublish);
    const newBytes = await read(name);
    await write(name, oldBytes);
    assert(equal(await read(name), oldBytes), 'Baseline reset failed');
    await sqlite_publication_probe(name, 'verify-old', noPublish);
    checkpoint = validateCheckpoint({ version: 1, origin: location.origin, name, phase: $('phase').value,
      instance, oldHash: await fingerprint(oldBytes), newHash: await fingerprint(newBytes),
      oldLength: oldBytes.length, newLength: newBytes.length }, location.origin);
    localStorage.setItem(key, JSON.stringify(checkpoint));
    preparedHere = true; $('saved').checked = false;
    report(`Prepared ${checkpoint.phase}; old/new SHA-256 references saved. Download the checkpoint, then arm.`);
    $('status').textContent = 'PREPARED: save the checkpoint outside Firefox';
  } catch (error) {
    checkpoint = undefined;
    await remove(name).catch(() => {});
    throw error;
  }
});
$('download').onclick = () => download(checkpoint, `${checkpoint.name}.json`);
$('discard').onclick = () => execute(async () => {
  const saved = validateCheckpoint(checkpoint, location.origin);
  // Only remove this checkpoint's test database, and never while an owner holds it.
  let release;
  try { release = await acquireDatabaseLock(saved.name); }
  catch (error) {
    if (error.name === 'DatabaseBusyError') throw new Error('The pending run is still open in another tab. Close that tab, then discard again.');
    throw error;
  }
  try {
    try { await remove(saved.name); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    localStorage.removeItem(key);
    checkpoint = undefined; preparedHere = false;
    $('saved').checked = false; $('forced').checked = false; $('import').value = '';
    report(`DISCARDED: ${saved.phase}; pending test database and checkpoint removed. No pass recorded; completed results retained.`);
    record({ kind: 'discarded', phase: saved.phase, name: saved.name });
    $('status').textContent = 'Ready: pending run discarded; prepare a new crash check';
  } finally { await release(); }
});
$('arm').onclick = () => execute(async () => {
  assert(preparedHere && checkpoint.instance === instance && $('saved').checked,
    'Prepare here and save the checkpoint outside Firefox first');
  const saved = checkpoint;
  const bytes = await read(saved.name);
  assert(bytes.length === saved.oldLength && await fingerprint(bytes) === saved.oldHash, 'Baseline changed before arming');
  $('status').textContent = `Arming ${saved.phase}…`;
  const hold = () => {
    $('status').textContent = `ARMED: ${saved.phase} — force-quit the test Firefox now`;
    report(`ARMED: ${saved.phase}; checkpoint ${saved.name}.json; leave the database and checkpoint intact`);
    return new Promise(() => {});
  };
  await sqlite_publication_probe(saved.name, 'mutate', async stage => {
    if (stage === saved.phase) return hold();
  });
  assert(saved.phase === 'commit-returned', 'COMMIT finished without reaching the selected gate');
  await hold();
});
$('import').onchange = () => execute(async () => {
  const file = $('import').files[0];
  assert(file && file.size < 16384, 'Choose a checkpoint JSON file smaller than 16 KiB');
  const saved = validateCheckpoint(JSON.parse(await file.text()), location.origin);
  assert(!checkpoint || checkpoint.name === saved.name, 'A different checkpoint is pending; do not overwrite its evidence');
  checkpoint = saved; preparedHere = false;
  localStorage.setItem(key, JSON.stringify(saved));
  $('status').textContent = `Checkpoint restored: ${saved.phase}`;
});
$('verify').onclick = () => execute(async () => {
  const saved = validateCheckpoint(checkpoint, location.origin);
  assert(saved.instance !== instance, 'Verification requires a fresh page/WASM instance');
  assert($('forced').checked, 'Confirm you saw ARMED and force-quit/restarted this profile');
  const bytes = await read(saved.name);
  const version = classify(saved, bytes.length, await fingerprint(bytes));
  await sqlite_publication_probe(saved.name, `verify-${version}`, noPublish);
  assert(equal(await read(saved.name), bytes), 'Verification changed stored bytes');
  report(`PASS: ${saved.phase}: complete ${version} database survived reported process termination; lock reacquired, rows and integrity_check passed; bytes unchanged`);
  await sqlite_publication_probe(saved.name, version === 'old' ? 'mutate' : 'restore', ready);
  await sqlite_publication_probe(saved.name, version === 'old' ? 'verify-new' : 'verify-old', noPublish);
  report('PASS: subsequent COMMIT and fresh reopen succeeded on the recovered database');
  await remove(saved.name);
  report('PASS: crash test database removed');
  report('SCOPE: forced shutdown is user-attested; close-started may have completed before termination; no power-loss guarantee');
  record({ kind: 'crash', phase: saved.phase, version, name: saved.name, userAttestedForceQuit: true });
  localStorage.removeItem(key); checkpoint = undefined; preparedHere = false; $('forced').checked = false;
  $('status').textContent = 'PASS: process-termination recovery check';
});
$('export').onclick = () => download(results, 'jspi-final-recovery-results.json');
try {
  await init();
  let metadataError;
  try {
    const saved = localStorage.getItem(key);
    if (saved) checkpoint = validateCheckpoint(JSON.parse(saved), location.origin);
  } catch (error) { metadataError = error; }
  try {
    results = JSON.parse(localStorage.getItem(resultsKey) ?? '[]');
    assert(Array.isArray(results), 'Invalid results history');
  } catch (error) { results = []; report(`Results history unavailable: ${error}. Keep your downloaded results.`); }
  $('status').textContent = metadataError ? `Checkpoint metadata unavailable: ${metadataError}. Import your backup before continuing.`
    : checkpoint ? `Pending checkpoint: ${checkpoint.phase}; verify after forced shutdown or restore the backup` : 'Ready';
  render();
  if (metadataError) {
    // A corrupt metadata record must not trap the user with a disabled import
    // control, or invite creating another database before restoring evidence.
    $('prepare').disabled = true;
    $('quota').disabled = true;
  }
} catch (error) { $('status').textContent = `FAIL: ${error}`; }
