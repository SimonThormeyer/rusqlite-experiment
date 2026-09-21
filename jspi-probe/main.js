import init, { write, read, _delete as remove, wait_for } from './pkg/jspi_probe.js';

const button = document.querySelector('#run');
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
  button.disabled = false;
}

async function start() {
  button.disabled = true;
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
  button.disabled = false;
}

button.addEventListener('click', () => start().catch(fail));
try {
  assert(isSecureContext && navigator.storage?.getDirectory, 'OPFS requires HTTPS or localhost');
  assert(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function',
    'This browser does not support WebAssembly JSPI');
  await init();
  const saved = sessionStorage.getItem(checkpoint);
  if (saved) await finish(JSON.parse(saved));
  else {
    status.textContent = 'Ready';
    status.dataset.result = 'ready';
    button.disabled = false;
  }
} catch (error) { fail(error); }
