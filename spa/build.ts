import { mkdir, copyFile, rm } from 'node:fs/promises';
const baseline = process.argv.includes('--indexeddb');
const outdir = baseline ? 'spa/out-indexeddb' : 'spa/out';
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: baseline ? ['spa/indexeddb/index.html'] : ['spa/index.html', 'spa/checks.html'],
  outdir, target: 'browser',
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
await copyFile(baseline ? 'ffi/pkg/ffi_bg.wasm' : 'jspi-probe/pkg-encryption/jspi_probe_bg.wasm',
  `${outdir}/${baseline ? 'ffi_bg.wasm' : 'jspi_probe_bg.wasm'}`);
console.log(`Built ${baseline ? 'IndexedDB baseline' : 'encrypted JSPI SPA'} in ${outdir}`);
