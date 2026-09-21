import init, { sqlite_writable_probe, sqlite_readonly_probe, sqlite_hold_committed_probe, sqlite_hold_uncommitted_probe, sqlite_publication_probe } from './pkg/jspi_probe.js';

const token = location.hash.slice(1);
const parent = window.opener;
const log = document.querySelector('#log');
const send = message => parent?.postMessage({ ...message, token }, location.origin);
let running = false;
try {
  if (!parent || !/^[0-9a-f-]{36}$/.test(token)) throw new Error('Open this tab using Run cross-tab lock checks');
  await init();
  if (!navigator.locks?.request) throw new Error('Web Locks unavailable');
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.token !== token) return;
    const { id, name, action, phase } = event.data;
    if (!Number.isInteger(id) || !name?.startsWith(`lock-test-${token}`)) return;
    if (running) { send({ id, error: { message: 'Peer command already running' } }); return; }
    running = true;
    try {
      let result;
      if (action === 'publication') {
        result = await sqlite_publication_probe(name, 'mutate', async stage => {
          if (stage !== phase) return;
          send({ id, holding: phase });
          return new Promise(() => {});
        });
      }
      else if (action === 'verify') result = await sqlite_writable_probe(name, false, () => Promise.resolve());
      else if (action === 'readonly') result = await sqlite_readonly_probe(name, () => Promise.resolve());
      else if (action === 'invalid-create') result = await sqlite_writable_probe(name, true, () => Promise.resolve());
      else if (action === 'hold-committed' || action === 'hold-uncommitted') {
        const hold = action === 'hold-uncommitted' ? sqlite_hold_uncommitted_probe : sqlite_hold_committed_probe;
        result = await hold(name,
        () => { throw new Error('Holding owner must not publish'); },
        () => {
          log.textContent += `\n${action}: verified state; waiting for this tab to close`;
          send({ id, holding: action });
          return new Promise(() => {}); // Intentionally never release via application code.
        });
      }
      else throw new Error('Unknown command');
      log.textContent += `\n${action}: succeeded`;
      send({ id, result });
    } catch (error) {
      log.textContent += `\n${action}: ${error.name}: ${error.message}`;
      send({ id, error: { name: error.name, message: error.message, sqliteCode: error.sqliteCode } });
    } finally { running = false; }
  });
  log.textContent = 'Ready — waiting for the probe tab';
  send({ ready: true });
} catch (error) {
  log.textContent = `FAIL: ${error}`;
  send({ startupError: String(error) });
}
