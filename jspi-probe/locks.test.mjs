import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireDatabaseLock } from './locks.js';

test('exclusive database lease rejects contention, isolates filenames, and releases', async () => {
  const name = `lease-${crypto.randomUUID()}.sqlite`;
  const release = await acquireDatabaseLock(name);
  try {
    await assert.rejects(acquireDatabaseLock(name), error =>
      error.name === 'DatabaseBusyError' && error.sqliteCode === 5);
    const releaseOther = await acquireDatabaseLock(`${name}-other`);
    await releaseOther();
  } finally { await release(); }
  // Completion of release means immediate retry is safe.
  const releaseAgain = await acquireDatabaseLock(name);
  await releaseAgain();
});

test('lease can be released on caller failure and acquired again', async () => {
  const name = `failure-${crypto.randomUUID()}.sqlite`;
  await assert.rejects(async () => {
    const release = await acquireDatabaseLock(name);
    try { throw new Error('injected caller failure'); }
    finally { await release(); }
  }, /injected caller failure/);
  const release = await acquireDatabaseLock(name);
  await release();
});

test('lease rejects names that could alias paths', () => {
  for (const name of ['', 'a/b', 'a\\b']) {
    assert.throws(() => acquireDatabaseLock(name), /bare database filename/);
  }
});
