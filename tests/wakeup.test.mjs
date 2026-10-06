import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadWakeup, openCodexThread } from '../desktop/wakeup.mjs';
import { nextReply } from '../desktop/media.mjs';

const row = (tid, status = 'queued') => ({ status, route: JSON.stringify({ tid }) });
function fixture(error = 'no-client-found') {
  const states = new Map(), known = new Map([['a', {}], ['b', {}]]), opened = [], followed = [];
  let clock = 0;
  const ipc = { follow: (...args) => followed.push(args), owner: async () => {
    if (error) throw new Error(error);
    return 'existing-owner';
  } };
  const worker = new ThreadWakeup({ states, known, ipc, open: async tid => opened.push(tid), now: () => clock });
  return { worker, states, opened, followed, advance: ms => { clock += ms; } };
}

test('unloaded queued chat opens automatically, then becomes deliverable on snapshot', async () => {
  const f = fixture(), rows = [row('a')];
  assert.equal(nextReply(rows, f.states), undefined);
  await f.worker.tick(rows);
  assert.deepEqual(f.opened, []);
  f.advance(5000); await f.worker.tick(rows);
  assert.deepEqual(f.opened, ['a']);
  f.states.set('a', {});
  await f.worker.tick(rows);
  assert.equal(nextReply(rows, f.states), rows[0]);
  assert.equal(f.worker.waiting.size, 0);
  assert.equal(f.opened.length, 1);
});

test('loaded chats and uncertain/already-sent deliveries never open or resend', async () => {
  const f = fixture(); f.states.set('a', {});
  const rows = [row('a'), row('b', 'unknown')];
  await f.worker.tick(rows); f.advance(10000); await f.worker.tick(rows);
  assert.deepEqual(f.opened, []);
});

test('missing snapshot with a live owner only resubscribes', async () => {
  const f = fixture(null), rows = [row('a')];
  await f.worker.tick(rows); f.advance(5000); await f.worker.tick(rows);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.followed.at(-1), ['a', true, ['existing-owner']]);
});

test('discovery timeouts do not imply a missing owner', async () => {
  const f = fixture('ipc-timeout'), rows = [row('a')];
  await f.worker.tick(rows); f.advance(5000); await f.worker.tick(rows);
  assert.deepEqual(f.opened, []);
});

test('per-chat media order and other loaded chats remain independent', async () => {
  const f = fixture(), rows = [row('a', 'speech_running'), row('a'), row('b')];
  f.states.set('b', {});
  await f.worker.tick(rows); f.advance(5000); await f.worker.tick(rows);
  assert.deepEqual(f.opened, []);
  assert.equal(nextReply(rows, f.states), rows[2]);
});

test('failed wakeup is throttled and archived/unknown chats are not opened', async () => {
  const f = fixture(), rows = [row('a'), row('archived')];
  f.worker.open = async tid => { f.opened.push(tid); throw Error('failed'); };
  await f.worker.tick(rows); f.advance(5000); await f.worker.tick(rows);
  for (let i = 0; i < 10; i++) await f.worker.tick(rows);
  assert.deepEqual(f.opened, ['a']);
  f.advance(60000); await f.worker.tick(rows);
  assert.deepEqual(f.opened, ['a', 'a']);
});

test('desktop deep links reject shell arguments and extra URL parameters', async () => {
  await assert.rejects(openCodexThread("a'; bad command"), /invalid-thread-id/);
  await assert.rejects(openCodexThread('00000000-0000-0000-0000-000000000000?prompt=test'), /invalid-thread-id/);
});
