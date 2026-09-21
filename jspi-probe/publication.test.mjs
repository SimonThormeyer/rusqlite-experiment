import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDatabase } from './publication.js';

// Model staged visibility to verify orchestration; browser tests validate OPFS.
function storage() {
  let published = [9, 9, 9, 9], pending = [], closed = false, aborted = false;
  const stream = {
    async write(bytes) { pending.push(...bytes); },
    async truncate(size) { pending.length = size; },
    async close() { published = [...pending]; closed = true; },
    async abort() { aborted = true; },
  };
  Object.defineProperty(navigator, 'storage', { configurable: true, value: {
    async getDirectory() { return { async getDirectoryHandle() {
      return { async getFileHandle() { return { async createWritable() { return stream; } }; } };
    } }; },
  } });
  return { published: () => published, closed: () => closed, aborted: () => aborted };
}

test('publication stages preserve old bytes until close and replace full contents', async () => {
  const state = storage(), phases = [];
  await publishDatabase('test', new Uint8Array([1, 2, 3]), async phase => {
    phases.push(phase);
    if (phase === 'before-close') assert.deepEqual(state.published(), [9, 9, 9, 9]);
  });
  assert.deepEqual(phases, ['before-open', 'after-open', 'after-half-write', 'before-close', 'close-started', 'after-close']);
  assert.deepEqual(state.published(), [1, 2, 3]);
  assert.equal(state.aborted(), false);
});

test('failure before close aborts staging and preserves rejection identity', async () => {
  const state = storage(), cause = new Error('storage failure');
  await assert.rejects(publishDatabase('test', new Uint8Array([1, 2]), async phase => {
    if (phase === 'after-half-write') throw cause;
  }), error => error === cause);
  assert.deepEqual(state.published(), [9, 9, 9, 9]);
  assert.equal(state.closed(), false);
  assert.equal(state.aborted(), true);
});

test('failure after close retains published data despite rejection', async () => {
  const state = storage(), cause = new Error('lost acknowledgement');
  await assert.rejects(publishDatabase('test', new Uint8Array([1, 2]), async phase => {
    if (phase === 'after-close') throw cause;
  }), error => error === cause);
  assert.deepEqual(state.published(), [1, 2]);
  assert.equal(state.closed(), true);
});

test('undefined rejection from an aborted WritableStream survives publication', async () => {
  const state = storage();
  let caught = false, cause;
  try {
    await publishDatabase('test', new Uint8Array([1, 2]), async phase => {
      if (phase !== 'before-close') return;
      const stream = new WritableStream();
      await stream.abort();
      const writer = stream.getWriter();
      writer.closed.catch(() => {});
      try { await writer.write(new Uint8Array([1])); }
      finally { writer.releaseLock(); }
    });
  } catch (error) { caught = true; cause = error; }
  assert.equal(caught, true);
  assert.equal(cause, undefined);
  assert.deepEqual(state.published(), [9, 9, 9, 9]);
  assert.equal(state.aborted(), true);
});
