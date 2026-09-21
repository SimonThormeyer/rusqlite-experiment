import init, { write, read, _delete as remove, wait_for } from './pkg/jspi_probe.js';
import { runSqliteChecks } from './sqlite-checks.js';
import { runReadonlyChecks } from './readonly-checks.js';
import { runWriteChecks } from './write-checks.js';
import { runWritableChecks } from './writable-checks.js';
import { prepareWritableReload, finishWritableReload } from './reload-checks.js';
import { runCrossTabChecks } from './cross-tab-checks.js';
import { runTerminationChecks } from './termination-checks.js';

const button = document.querySelector('#run');
const sqliteButton = document.querySelector('#sqlite');
const readonlyButton = document.querySelector('#readonly');
const writeButton = document.querySelector('#writes');
const writableButton = document.querySelector('#writable');
const reloadButton = document.querySelector('#writable-reload');
const lockButton = document.querySelector('#cross-tab');
const terminationButton = document.querySelector('#owner-close');
const setBusy = (busy) => { for (const control of [button, sqliteButton, readonlyButton, writeButton, writableButton, reloadButton, lockButton, terminationButton]) control.disabled = busy; };
const status = document.querySelector('#status');
const log = document.querySelector('#log');
const checkpoint = 'rusqlite-jspi-probe-reload';
const payload = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
let lines = [];
const report = (message) => { lines.push(message); log.textContent = lines.join('\n'); };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

async function rejects(operation, expectedName) {
  try { await operation(); } catch (error) {
    assert(error.name === expectedName, `Expected ${expectedName}, got ${error.name}: ${error}`);
    return;
  }
  throw new Error(`Expected rejection: ${expectedName}`);
}

function fail(error) {
  sessionStorage.removeItem(checkpoint);
  status.textContent = `FAIL: ${error.message ?? error}`;
  status.dataset.result = 'fail';
  report(error.stack ?? String(error));
  setBusy(false);
}

async function start() {
  setBusy(true);
  status.dataset.result = 'running';
  status.textContent = 'Checking storage and suspension…';
  lines = [];
  const name = `probe-${crypto.randomUUID()}.bin`;
  const pending = write(name, payload);
  assert(pending instanceof Promise, 'write must return a Promise');
  await pending;
  assert(equal(await read(name), payload), 'Binary round trip differs');
  // Replacement must truncate the previous contents, including to an empty file.
  await write(name, new Uint8Array([0, 255, 128]));
  assert(equal(await read(name), new Uint8Array([0, 255, 128])), 'Short overwrite differs');
  await write(name, new Uint8Array());
  assert((await read(name)).length === 0, 'Empty overwrite did not truncate');
  await write(name, payload);
  report('PASS: binary round trip, shorter overwrite, and empty file');

  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await wait_for(new Promise(resolve => setTimeout(resolve, 150)));
  } finally { clearInterval(timer); }
  assert(ticks > 0, 'Event loop did not progress during Rust suspension');
  report(`PASS: event loop progressed during controlled suspension (${ticks} ticks)`);
  // Check that a rejected Promise survives the Rust boundary unchanged.
  await rejects(() => wait_for(Promise.reject(new DOMException('probe rejection', 'AbortError'))), 'AbortError');
  report('PASS: rejected Promise propagated through synchronous Rust');
  sessionStorage.setItem(checkpoint, JSON.stringify({ name, lines }));
  location.reload();
}

async function finish(saved) {
  lines = saved.lines;
  report('Reloaded with a fresh WASM instance');
  assert(equal(await read(saved.name), payload), 'Data did not survive reload');
  report('PASS: binary data persisted across page reload');
  await remove(saved.name);
  await rejects(() => read(saved.name), 'NotFoundError');
  await rejects(() => remove(saved.name), 'NotFoundError');
  report('PASS: deletion and missing-file storage errors');
  // A storage failure must not make the instance unusable.
  await write(saved.name, payload);
  assert(equal(await read(saved.name), payload), 'Recovery after storage error failed');
  await remove(saved.name);
  report('PASS: storage operations recover after rejection; test file removed');
  sessionStorage.removeItem(checkpoint);
  status.textContent = 'PASS: all checks completed';
  status.dataset.result = 'pass';
  setBusy(false);
}

button.addEventListener('click', () => start().catch(fail));
reloadButton.addEventListener('click', async () => {
  setBusy(true);
  lines = [];
  log.textContent = '';
  status.textContent = 'Creating the database before reload…';
  status.dataset.result = 'running';
  try {
    const saved = await prepareWritableReload(report);
    try {
      sessionStorage.setItem(checkpoint, JSON.stringify({ ...saved, lines }));
    } catch (error) {
      try { await remove(saved.name); } catch { /* Preserve the checkpoint error. */ }
      throw error;
    }
    location.reload();
  } catch (error) { fail(error); }
});
async function runAdditionalChecks(checks, label) {
  setBusy(true);
  lines = [];
  log.textContent = '';
  status.textContent = `Checking ${label}…`;
  status.dataset.result = 'running';
  try {
    await checks(report);
    status.textContent = `PASS: all ${label} checks completed`;
    status.dataset.result = 'pass';
    setBusy(false);
  } catch (error) { fail(error); }
}
sqliteButton.addEventListener('click', () => runAdditionalChecks(runSqliteChecks, 'SQLite callback'));
readonlyButton.addEventListener('click', () => runAdditionalChecks(runReadonlyChecks, 'OPFS read-only'));
writeButton.addEventListener('click', () => runAdditionalChecks(runWriteChecks, 'OPFS write semantics'));
writableButton.addEventListener('click', () => runAdditionalChecks(runWritableChecks, 'writable SQLite'));
lockButton.addEventListener('click', () => runAdditionalChecks(runCrossTabChecks, 'cross-tab lock'));
terminationButton.addEventListener('click', () => runAdditionalChecks(runTerminationChecks, 'owner-tab termination'));
try {
  assert(isSecureContext && navigator.storage?.getDirectory, 'OPFS requires HTTPS or localhost');
  assert(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function',
    'This browser does not support WebAssembly JSPI');
  await init();
  const saved = sessionStorage.getItem(checkpoint);
  if (saved) {
    const parsed = JSON.parse(saved);
    if (parsed.kind === 'writable-reload') {
      status.textContent = 'Verifying the database after reload…';
      status.dataset.result = 'running';
      lines = parsed.lines;
      await finishWritableReload(parsed, report);
      sessionStorage.removeItem(checkpoint);
      status.textContent = 'PASS: all writable SQLite reload checks completed';
      status.dataset.result = 'pass';
      setBusy(false);
    } else {
      assert(parsed.kind === undefined, 'Unknown reload checkpoint kind');
      await finish(parsed);
    }
  }
  else {
    status.textContent = 'Ready';
    status.dataset.result = 'ready';
    setBusy(false);
  }
} catch (error) { fail(error); }
