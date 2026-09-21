import { write, read, _delete as remove, opfs_write_semantics } from './pkg/jspi_probe.js';

export async function runWriteChecks(report) {
  const name = `write-semantics-${crypto.randomUUID()}.bin`;
  await write(name, new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
  try {
    const result = await opfs_write_semantics(name);
    for (const line of result.split('\n')) report(line);
    if ((await read(name)).length !== 0) throw new Error('Final file should be empty');
  } finally { await remove(name); }
  report('PASS: test file removed; no SQLite writes or durability claims');
}
