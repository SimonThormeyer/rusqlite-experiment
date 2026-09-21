import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, validateCheckpoint, phases } from './recovery-state.js';

const saved = { version: 1, origin: 'http://localhost:8081',
  name: 'crash-final-00000000-0000-0000-0000-000000000000.sqlite',
  phase: 'before-close', instance: 'previous', oldLength: 16384, newLength: 16384,
  oldHash: 'a'.repeat(64), newHash: 'b'.repeat(64) };

test('checkpoint rejects other origins and filenames before storage access', () => {
  assert.equal(validateCheckpoint(saved, saved.origin), saved);
  assert.throws(() => validateCheckpoint(saved, 'http://localhost:8082'));
  assert.throws(() => validateCheckpoint({ ...saved, name: '../application.sqlite' }, saved.origin));
  assert.throws(() => validateCheckpoint({ ...saved, oldHash: saved.newHash }, saved.origin));
  assert.throws(() => validateCheckpoint({ ...saved, phase: 'unknown' }, saved.origin));
});
test('partial or foreign bytes cannot pass even when database length matches', () => {
  assert.throws(() => classify(saved, 16384, 'c'.repeat(64)));
  assert.throws(() => classify(saved, 8192, saved.oldHash));
});
test('every crash boundary enforces its allowed complete versions', () => {
  for (const phase of phases) {
    const checkpoint = { ...saved, phase };
    if (['after-close', 'commit-returned'].includes(phase)) {
      assert.throws(() => classify(checkpoint, 16384, saved.oldHash));
      assert.equal(classify(checkpoint, 16384, saved.newHash), 'new');
    } else if (phase === 'close-started') {
      assert.equal(classify(checkpoint, 16384, saved.oldHash), 'old');
      assert.equal(classify(checkpoint, 16384, saved.newHash), 'new');
    } else {
      assert.equal(classify(checkpoint, 16384, saved.oldHash), 'old');
      assert.throws(() => classify(checkpoint, 16384, saved.newHash));
    }
  }
});
