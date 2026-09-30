import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initMedia, ownerMessage, queueMedia, nextReply, downloadMedia } from '../desktop/media.mjs';
import { SpeechQueue } from '../desktop/speech.mjs';
import { applyPatches, eventsOf } from '../desktop/state.mjs';
import { BookRelay } from '../desktop/relay.mjs';

test('only explicitly allowed private-chat senders are accepted', () => {
  const config = { ownerUserId: 1, ownerChatId: 1, additionalUsers: [2] };
  const update = (user, chat, type = 'private') => ({ message: { from: { id: user }, chat: { id: chat, type } } });
  assert.ok(ownerMessage(update(1, 1), config));
  assert.ok(ownerMessage(update(2, 2), config));
  assert.equal(ownerMessage(update(3, 3), config), null);
  assert.equal(ownerMessage(update(2, 1), config), null);
  assert.equal(ownerMessage(update(1, 1, 'group'), config), null);
});

test('fresh database supports voice transcription, captions and restart recovery', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE incoming (update_id INTEGER PRIMARY KEY, message_id INTEGER, text TEXT, route TEXT, status TEXT, client_message_id TEXT, error TEXT);
      CREATE TABLE routes (chat_id INTEGER, message_id INTEGER, tid TEXT, route TEXT, PRIMARY KEY(chat_id,message_id));`);
    initMedia(db);
    const update = { update_id: 1, message: { message_id: 2, chat: { id: 1 }, voice: { file_id: 'fixture', duration: 2, file_size: 10 }, caption: 'context' } };
    assert.equal(queueMedia(db, update, { tid: 'thread-1' }, 'client-1'), true);
    assert.equal(queueMedia(db, update, { tid: 'thread-1' }, 'client-1'), false);
    db.prepare("UPDATE incoming SET status='speech_running'").run();
    db.prepare("UPDATE media_files SET path='fixture.ogg'").run();
    initMedia(db);
    assert.equal(db.prepare('SELECT status FROM incoming').get().status, 'speech_queued');
    const queue = new SpeechQueue({ db, recognizer: { transcribe: async () => ({ text: 'hello' }) }, log: () => {}, notify: () => {} });
    await queue.tick();
    assert.deepEqual({ ...db.prepare('SELECT status,text FROM incoming').get() }, { status: 'queued', text: 'hello\n\nПодпись: context' });
  } finally { db.close(); }
});

test('pending media preserves ordering in its chat without blocking another chat', () => {
  const row = (tid, status) => ({ route: JSON.stringify({ tid }), status });
  const rows = [row('a', 'media_queued'), row('a', 'queued'), row('b', 'queued')];
  assert.equal(nextReply(rows, new Map([['a', {}], ['b', {}]])), rows[2]);
});

test('download rejects path traversal before making an HTTP request', async () => {
  await assert.rejects(downloadMedia({ job: { update_id: 1, file_id: 'fixture', kind: 'image' }, directory: '.', token: 'fixture', telegram: async () => ({ file_path: '../private' }), fetcher: () => { throw new Error('must not fetch'); } }), /media-invalid-path/);
});

test('relay rejects insecure transport and absent credentials', () => {
  assert.throws(() => new BookRelay('http://example.com', 'fixture'), /https/);
  assert.throws(() => new BookRelay('https://example.com', ''), /key/);
});

test('IPC patch updates preserve the final response used for notifications', () => {
  const state = { id: 'a', turns: [{ id: 'turn', status: 'inProgress', items: [] }] };
  applyPatches(state, [{ op: 'replace', path: '/turns/0/status', value: 'completed' }, { op: 'add', path: '/turns/0/items/-', value: { type: 'agentMessage', text: 'Done' } }]);
  assert.equal(eventsOf(state)[0].text, 'Done');
  assert.equal(eventsOf(state)[0].kind, 'final');
});
