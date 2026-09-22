import { test, expect } from 'bun:test';
import { Session, type Api } from './backend';
import { parseState } from './state';
const empty = { lists: [], selected: null };
function api(overrides: Partial<Api> = {}): Api {
  return {
    app_state: async () => empty,
    app_create: async () => empty,
    ...overrides,
  } as Api;
}
test('suspended action rejects overlap and locking, then releases the gate', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const session = new Session('unit.sqlite', api({ app_state: async () => { if (paused) await gate; return empty; } }));
  await session.open('password', false);
  paused = true;
  const first = session.state();
  await expect(session.state()).rejects.toThrow('already running');
  expect(() => session.lock()).toThrow('Wait');
  expect(session.unlocked).toBe(true);
  release(); await first;
  expect(session.busy).toBe(false);
  session.lock();
  await expect(session.state()).rejects.toThrow('Unlock');
});
test('publication error locks session, preserves error identity, and permits explicit recovery', async () => {
  const cause = new Error('storage failure');
  const failure = Object.assign(new Error('publication'), { sqliteCode: 1034, cause });
  let fail = true;
  const session = new Session('unit.sqlite', api({ todo_export: async () => { if (fail) throw failure; return new Uint8Array([1]); } }));
  await session.open('password', false);
  await expect(session.export()).rejects.toBe(failure);
  expect(session.unlocked).toBe(false);
  expect(session.busy).toBe(false);
  fail = false;
  await session.open('password', false);
  expect(await session.export()).toEqual(new Uint8Array([1]));
});
test('ambiguous password change discards credentials; success uses new key and rejects removal', async () => {
  let received = '', fail = true, calls = 0;
  const session = new Session('unit.sqlite', api({
    app_change_key: async (_name, _old, _replacement) => { calls++; if (fail) throw new Error('unknown commit result'); },
    todo_export: async (_name, _hook, key) => { received = key!; return new Uint8Array(); },
  }));
  await session.open('old', false);
  await expect(session.changePassword('')).rejects.toThrow('must not be empty');
  expect(calls).toBe(0);
  expect(session.unlocked).toBe(true);
  await expect(session.changePassword('new')).rejects.toThrow('unknown commit result');
  expect(session.unlocked).toBe(false);
  fail = false;
  await session.open('old', false);
  await session.changePassword('new');
  await session.export();
  expect(received).toBe('new');
});
test('wrong-key errors invalidate session but lock contention does not', async () => {
  let code = 5;
  const session = new Session('unit.sqlite', api({ todo_export: async () => { throw Object.assign(new Error('failure'), { sqliteCode: code }); } }));
  await session.open('password', false);
  await expect(session.export()).rejects.toThrow();
  expect(session.unlocked).toBe(true);
  code = 26;
  await expect(session.export()).rejects.toThrow();
  expect(session.unlocked).toBe(false);
});
test('malformed or inconsistent snapshots cannot establish an unlocked session', async () => {
  const session = new Session('unit.sqlite', api({ app_state: async () => ({ lists: [{ id: 1, title: 'A' }], selected: { id: 2, title: 'B', items: [] } }) }));
  await expect(session.open('password', false)).rejects.toThrow('does not match');
  expect(session.unlocked).toBe(false);
  expect(() => parseState({ lists: [{ id: 1, title: 'A' }, { id: 1, title: 'A' }], selected: null })).toThrow('Duplicate');
});
