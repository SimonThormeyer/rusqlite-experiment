import { write, read, _delete as remove, sqlite_writable_probe } from './pkg/jspi_probe.js';

// This token is recreated when the document and its WASM module are loaded.
const instance = crypto.randomUUID();
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function fingerprint(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareWritableReload(report) {
  const name = `reload-writable-${crypto.randomUUID()}.sqlite`;
  await write(name, new Uint8Array());
  try {
    const result = await sqlite_writable_probe(name, true, () => Promise.resolve());
    for (const line of result.split('\n')) report(line);
    const bytes = await read(name);
    assert(bytes.length > 0, 'Database was not published before reload');
    const sha256 = await fingerprint(bytes);
    report(`PASS: committed database closed before reload (${bytes.length} bytes)`);
    // Metadata only: the database must be recovered from OPFS after reload.
    return { kind: 'writable-reload', name, length: bytes.length, sha256, instance };
  } catch (error) {
    try { await remove(name); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export async function finishWritableReload(saved, report) {
  assert(/^reload-writable-[0-9a-f-]{36}\.sqlite$/.test(saved.name)
    && /^[0-9a-f]{64}$/.test(saved.sha256)
    && Number.isInteger(saved.length) && saved.length > 0
    && typeof saved.instance === 'string', 'Invalid writable reload checkpoint');
  assert(saved.instance !== instance, 'Verification must run in a new page instance');
  report('Reloaded with a fresh page and WASM instance');
  const bytes = await read(saved.name);
  assert(bytes.length === saved.length && await fingerprint(bytes) === saved.sha256,
    'Published database bytes changed across reload');
  report('PASS: OPFS database length and SHA-256 survived page reload');

  // Reopen only: do not seed, create a schema, or insert rows on this page.
  const result = await sqlite_writable_probe(saved.name, false, () => {
    throw new Error('Reload verification unexpectedly attempted publication');
  });
  for (const line of result.split('\n')) report(line);
  report('PASS: committed rows and binary payloads survived; uncommitted deletion did not');
  const after = await read(saved.name);
  assert(after.length === saved.length && await fingerprint(after) === saved.sha256,
    'Verification changed the stored database');
  report('PASS: verification left OPFS database bytes unchanged');
  await remove(saved.name);
  try {
    await read(saved.name);
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    report('PASS: database removed after reload verification; no crash-durability claim');
    return;
  }
  throw new Error('Database still readable after cleanup');
}
