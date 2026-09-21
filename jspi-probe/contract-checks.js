import { write, read, _delete as remove, sqlite_writable_probe, sqlite_vfs_contract_probe } from './pkg/jspi_probe.js';
import { acquireDatabaseLock } from './locks.js';
import { assert, equal } from './recovery-state.js';

export async function runContractChecks(report) {
  for (const invalid of ['', '.', '..', 'bad\0name', 'a/b', 'a\\b']) {
    let rejected = false;
    try { const release = await acquireDatabaseLock(invalid); await release(); }
    catch (error) { assert(error.message.includes('bare database filename'), 'Unexpected validation error'); rejected = true; }
    assert(rejected, 'Invalid filename accepted');
  }
  report('PASS: invalid filenames rejected before storage or SQLite access');
  const name = `contract-${crypto.randomUUID()}.sqlite`;
  await write(name, new Uint8Array());
  try {
    await sqlite_writable_probe(name, true, async () => {});
    const before = await read(name);
    const result = await sqlite_vfs_contract_probe(name, async () => { throw new Error('Contract checks must not publish'); });
    for (const line of result.split('\n')) report(line);
    assert(equal(await read(name), before), 'Contract checks modified the committed fixture');
    await sqlite_writable_probe(name, false, async () => { throw new Error('Reopen must not publish'); });
    report('PASS: committed bytes unchanged; fresh VFS/connection reopened rows and integrity_check after rejected operations');
  } finally { await remove(name); }
  report('PASS: contract fixture removed; pre-created main file only, memory journal, exclusive owner, 1 MiB limit');
}
