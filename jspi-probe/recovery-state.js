export const phases = ['before-open', 'after-open', 'after-half-write', 'before-close', 'close-started', 'after-close', 'commit-returned'];
export const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export async function fingerprint(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateCheckpoint(saved, origin) {
  assert(saved?.version === 1 && saved.origin === origin
    && /^crash-final-[0-9a-f-]{36}\.sqlite$/.test(saved.name)
    && phases.includes(saved.phase) && typeof saved.instance === 'string'
    && /^[0-9a-f]{64}$/.test(saved.oldHash) && /^[0-9a-f]{64}$/.test(saved.newHash)
    && saved.oldHash !== saved.newHash
    && Number.isInteger(saved.oldLength) && saved.oldLength > 0 && saved.oldLength <= 1048576
    && Number.isInteger(saved.newLength) && saved.newLength > 0 && saved.newLength <= 1048576,
  'Invalid checkpoint or wrong origin');
  return saved;
}
export function classify(saved, length, hash) {
  const old = length === saved.oldLength && hash === saved.oldHash;
  const fresh = length === saved.newLength && hash === saved.newHash;
  assert(old || fresh, 'Database is missing, torn, or different from both reference versions; preserve it for investigation');
  if (['after-close', 'commit-returned'].includes(saved.phase)) assert(fresh, 'Completed publication lost the new database');
  else if (saved.phase !== 'close-started') assert(old, 'Publication occurred before the selected close boundary');
  return fresh ? 'new' : 'old';
}
