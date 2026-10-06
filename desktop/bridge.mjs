import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CodexIpc } from './ipc.mjs';
import { ThreadWakeup } from './wakeup.mjs';
import { BookRelay } from './relay.mjs';
import { initMedia, ownerMessage, mediaOf, queueMedia, MediaError, mediaErrorText, MediaQueue, nextReply, replyInput } from './media.mjs';
import { LocalWhisper, SpeechQueue } from './speech.mjs';
import { applyPatches, turnsOf, latestTurn, eventsOf, redact, cleanNotificationText, splitText, hash, isBotCommand } from './state.mjs';
import { initUi, outgoingMessage, handleReplyButton } from './ui.mjs';

const privateDir = path.resolve(process.env.CODEX_TELEGRAM_HOME || path.join(process.env.LOCALAPPDATA, 'CodexTelegramBridge'));
fs.mkdirSync(privateDir, { recursive: true });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const config = readJson(path.join(privateDir, 'config.json'));
if (!Number.isSafeInteger(config.ownerUserId) || config.ownerUserId <= 0 || config.ownerChatId !== config.ownerUserId
    || (config.additionalUsers ?? []).some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('invalid-allowed-users');
const users = [{ userId: config.ownerUserId, chatId: config.ownerChatId },
  ...(config.additionalUsers ?? []).map(id => ({ userId: Number(id), chatId: Number(id) }))];
const userFor = (userId, chatId) => users.find(user => user.userId === userId && user.chatId === chatId);
const log = (event, details = {}) => fs.appendFileSync(path.join(privateDir, 'bridge.log'), JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const psRoot = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
const ps = path.join(psRoot, 'powershell.exe');
const decrypt = "$ErrorActionPreference='Stop';$s=ConvertTo-SecureString ((Get-Content -LiteralPath (Join-Path $env:CODEX_TELEGRAM_HOME 'bot-token.dpapi') -Raw).Trim());[Console]::Write(([System.Net.NetworkCredential]::new('', $s)).Password)";
// Codex inherits a PowerShell 7 PSModulePath. Do not pass it to Windows PowerShell 5.1.
const token = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', decrypt], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, CODEX_TELEGRAM_HOME: privateDir, PSModulePath: path.join(psRoot, 'Modules') } }).trim();
if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid-protected-token');
const relayKey = config.relayUrl ? execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', decrypt.replace('bot-token.dpapi', 'book-relay-key.dpapi')], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, CODEX_TELEGRAM_HOME: privateDir, PSModulePath: path.join(psRoot, 'Modules') } }).trim() : null;
const relay = config.relayUrl ? new BookRelay(config.relayUrl, relayKey) : null;

class TelegramError extends Error {
  constructor(code, retryAfter) { super(`telegram-${code}`); this.code = code; this.retryAfter = retryAfter; }
}
async function telegram(method, body = {}) {
  let response;
  try { response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 20000) }); }
  catch { throw new TelegramError('network'); }
  let payload;
  try { payload = await response.json(); } catch { throw new TelegramError('invalid-response'); }
  if (!payload.ok) throw new TelegramError(payload.error_code, payload.parameters?.retry_after);
  return payload.result;
}

// A separate named pipe prevents competing getUpdates consumers on this PC.
const singleton = net.createServer(socket => socket.end());
try { await new Promise((resolve, reject) => { singleton.once('error', reject); singleton.listen('\\\\.\\pipe\\codex-telegram-bridge', resolve); }); }
catch { console.log('Bridge is already running.'); process.exit(0); }

const db = new DatabaseSync(path.join(privateDir, 'bridge.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, baselined INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS active_turns (tid TEXT, turn_id TEXT, PRIMARY KEY(tid,turn_id));
  CREATE TABLE IF NOT EXISTS seen (event_key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, event_key TEXT, part INTEGER, text TEXT, route TEXT, status TEXT DEFAULT 'pending', telegram_id INTEGER, UNIQUE(event_key,part));
  CREATE TABLE IF NOT EXISTS routes (chat_id INTEGER, message_id INTEGER, tid TEXT, route TEXT, PRIMARY KEY(chat_id,message_id));
  CREATE TABLE IF NOT EXISTS incoming (update_id INTEGER PRIMARY KEY, message_id INTEGER, text TEXT, route TEXT, status TEXT, client_message_id TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS media_groups (chat_id INTEGER, group_id TEXT, route TEXT, PRIMARY KEY(chat_id,group_id));
`);
initMedia(db);
initUi(db);
try { db.exec('ALTER TABLE outbox ADD COLUMN chat_id INTEGER'); } catch {}
db.prepare('UPDATE outbox SET chat_id=? WHERE chat_id IS NULL').run(config.ownerChatId);
const mediaQueue = new MediaQueue({ db, directory: path.join(privateDir, 'media'), token, telegram, notify: system, log });
const whisper = new LocalWhisper({ root: config.whisperRoot || path.resolve(import.meta.dirname, '../speech'), audioRoot: privateDir, language: config.voiceLanguage || 'ru' });
const speechQueue = new SpeechQueue({ db, recognizer: whisper, notify: system, log, title });
const setting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
const setSetting = (key, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, String(value));
const firstStart = Number(setting('firstStart', Date.now())); setSetting('firstStart', firstStart);
let offset = Number(setting('telegramOffset', (config.initialUpdateOffset ?? 0)));
const paused = false; setSetting('paused', 'false');
let selectedTid = setting('selectedTid', '');
const selectedTidFor = chatId => chatId === config.ownerChatId ? selectedTid : setting(`selectedTid:${chatId}`, selectedTid);
const setSelectedTid = (chatId, tid) => {
  setSetting(chatId === config.ownerChatId ? 'selectedTid' : `selectedTid:${chatId}`, tid);
  if (chatId === config.ownerChatId) selectedTid = tid;
};
db.prepare("UPDATE incoming SET status='unknown',error='restarted-during-delivery' WHERE status='sending'").run();
db.prepare("UPDATE outbox SET status='unknown' WHERE status='sending'").run();
let connected = false, stopping = false, scanning = false, discovering = false, sending = false, delivering = false;
const ipc = new CodexIpc();
const states = new Map(), revisions = new Map(), scannedRevisions = new Map(), known = new Map(), followRequested = new Set(), activity = new Map();
const wakeup = new ThreadWakeup({ ipc, states, known, log });
let lastGoodEvent = null;
let catalogPublishedHash = '', publishingCatalog = false;

function reconcileFollowing() {
  if (!connected) return;
  const pendingTids = new Set(db.prepare("SELECT route FROM incoming WHERE status IN ('queued','media_queued','media_downloading','speech_queued','speech_running') AND route IS NOT NULL").all().map(row => JSON.parse(row.route).tid));
  for (const tid of known.keys()) {
    const wanted = users.some(user => !selectedTidFor(user.chatId) || tid === selectedTidFor(user.chatId)) || pendingTids.has(tid);
    if (wanted && !followRequested.has(tid)) { ipc.follow(tid); followRequested.add(tid); }
    else if (!wanted && followRequested.has(tid)) {
      ipc.follow(tid, false); followRequested.delete(tid);
      states.delete(tid); revisions.delete(tid); scannedRevisions.delete(tid);
    }
  }
}

function title(tid) { return redact(known.get(tid)?.title || states.get(tid)?.title || db.prepare('SELECT title FROM threads WHERE id=?').get(tid)?.title || tid.slice(0, 8)).slice(0, 150); }
function threadMenu(chatId, page = 0) {
  const rows = [...known.values()];
  if (!rows.length) { system('Открытых чатов Codex пока не обнаружено. Попробуйте /chat позже.', { chatId }); return; }
  const selected = selectedTidFor(chatId);
  const size = 7, pages = Math.ceil(rows.length / size), current = Math.min(Math.max(0, page), pages - 1);
  const buttons = rows.slice(current * size, (current + 1) * size).map(row => [{
    text: `${row.id === selected ? '✅ ' : ''}${title(row.id).slice(0, 48)}`,
    callback_data: `codex:select:${row.id}`
  }]);
  const nav = [];
  if (current > 0) nav.push({ text: '⬅️', callback_data: `codex:page:${current - 1}` });
  if (current + 1 < pages) nav.push({ text: '➡️', callback_data: `codex:page:${current + 1}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: 'Все чаты', callback_data: 'codex:select:all' }]);
  system(`Выберите один чат для уведомлений и обычных сообщений. Страница ${current + 1}/${pages}.${selected ? `\nСейчас выбран: ${title(selected)}` : '\nСейчас: все чаты.'}`, { chatId }, randomUUID(), { inline_keyboard: buttons });
}
function modeMenu(chatId) {
  const selected = selectedTidFor(chatId);
  system(`Режим уведомлений: ${selected ? `один чат — «${title(selected)}»` : 'все чаты'}. Приходят только результаты выполненной работы и ошибки.`, { chatId }, randomUUID(), { inline_keyboard: [
    [{ text: 'Один чат', callback_data: 'codex:mode:single' }],
    [{ text: 'Все чаты', callback_data: 'codex:select:all' }]
  ] });
}
function enqueue(eventKey, text, route = null, replyMarkup = null, chatId = config.ownerChatId) {
  const parts = splitText(redact(text));
  const statement = db.prepare('INSERT OR IGNORE INTO outbox(event_key,part,text,route,reply_markup,chat_id) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < parts.length; i++) statement.run(eventKey + ':' + chatId, i, parts[i], route ? JSON.stringify({ ...route, chatId }) : null, replyMarkup && i === parts.length - 1 ? JSON.stringify(replyMarkup) : null, chatId);
}
function system(text, route = null, key = randomUUID(), replyMarkup = null) { enqueue(`system:${key}`, text, route, replyMarkup, route?.chatId ?? config.ownerChatId); }
function announce(event) {
  const icons = { final: '✅ Готово', error: '❌ Ошибка', progress: '💬 Ход работы', question: '❓ Нужен ответ', async_question: '❓ Нужен ответ', approval: '🔐 Нужен доступ' };
  const route = { tid: event.tid, kind: event.kind, requestId: event.requestId, itemId: event.itemId, questions: event.questions };
  const text = `${cleanNotificationText(event.text)}\n\n${icons[event.kind]}`;
  for (const user of users) if (!selectedTidFor(user.chatId) || selectedTidFor(user.chatId) === event.tid)
    enqueue(event.key, text, route, null, user.chatId);
}
function scan(tid) {
  const state = states.get(tid); if (!state) return;
  const thread = db.prepare('SELECT * FROM threads WHERE id=?').get(tid);
  if (!thread) return;
  for (const turn of turnsOf(state).slice(-3)) if (turn.status === 'inProgress') db.prepare('INSERT OR IGNORE INTO active_turns VALUES (?,?)').run(tid, turn.turnId ?? String(turn.turnStartedAtMs));
  const events = eventsOf(state, false, 3);
  for (const event of events) {
    if (!event.text?.trim() || db.prepare('SELECT 1 FROM seen WHERE event_key=?').get(event.key)) continue;
    if (event.kind === 'progress') {
      const signature = hash(event.text), previous = activity.get(event.key);
      if (previous?.hash !== signature) { activity.set(event.key, { hash: signature, at: Date.now() }); continue; }
      if (Date.now() - previous.at < 3000) continue;
    }
    const wasActive = event.turnId && db.prepare('SELECT 1 FROM active_turns WHERE tid=? AND turn_id=?').get(tid, event.turnId);
    const historical = ['final', 'error'].includes(event.kind) && !wasActive && (event.startedAt ?? 0) < firstStart;
    // Baseline existing history silently. Current outstanding blocking requests are useful immediately.
    const send = !paused && !historical && ['final', 'error'].includes(event.kind) && thread.baselined;
    db.exec('BEGIN IMMEDIATE');
    try { if (send) announce(event); db.prepare('INSERT OR IGNORE INTO seen VALUES (?)').run(event.key); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!thread.baselined) db.prepare('UPDATE threads SET baselined=1 WHERE id=?').run(tid);
}

ipc.on('broadcast', message => {
  if (!connected) return;
  const p = message.params ?? {};
  if (message.method === 'thread-stream-following-status-requested' && p.hostId === 'local' && known.has(p.conversationId) && followRequested.has(p.conversationId)) {
    ipc.follow(p.conversationId, true, [message.sourceClientId]); return;
  }
  if (message.method !== 'thread-stream-state-changed' || p.hostId !== 'local' || !known.has(p.conversationId) || !followRequested.has(p.conversationId)) return;
  if (message.version !== 11) { if (!setting('protocolMismatch', '')) { setSetting('protocolMismatch', message.version); system('После обновления Codex изменился протокол. Мост приостановлен до проверки совместимости.'); } return; }
  const tid = p.conversationId, change = p.change;
  try {
    if (change.type === 'snapshot') states.set(tid, change.conversationState);
    else if (change.type === 'patches' && revisions.get(tid) === change.baseRevision && states.has(tid)) states.set(tid, applyPatches(states.get(tid), change.patches));
    else { ipc.follow(tid, false); ipc.follow(tid, true); return; }
    revisions.set(tid, change.revision); lastGoodEvent = Date.now();
  } catch { states.delete(tid); revisions.delete(tid); scannedRevisions.delete(tid); ipc.follow(tid, false); ipc.follow(tid, true); log('snapshot-resync', { tid }); }
});
ipc.on('disconnected', () => { connected = false; states.clear(); revisions.clear(); scannedRevisions.clear(); followRequested.clear(); log('codex-disconnected'); });
ipc.on('socketError', error => log('codex-socket-error', { message: error?.message, code: error?.code }));
ipc.on('socketEnd', () => log('codex-socket-end'));
ipc.on('protocolError', error => log('codex-protocol-error', { message: error?.message }));
ipc.on('handlerError', (error, message) => log('codex-handler-error', { message: error?.message, type: message?.type, method: message?.method }));
ipc.on('frameTooLarge', size => log('codex-frame-too-large', { size }));

async function discover() {
  if (!connected || discovering) return; discovering = true;
  let catalog;
  try {
    catalog = new DatabaseSync(path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE, '.codex'), 'state_5.sqlite'), { readOnly: true });
    const rows = catalog.prepare("SELECT id, COALESCE(NULLIF(name,''),title) AS title FROM threads WHERE archived=0 AND COALESCE(thread_source,'user') != 'subagent' AND agent_path IS NULL AND source NOT LIKE '%subagent%' ORDER BY recency_at_ms DESC").all();
    if (relay && !publishingCatalog) {
      const menuRows = rows.map(row => ({ id: row.id, title: redact(row.title || row.id.slice(0, 8)).slice(0, 150) }));
      const signature = hash(JSON.stringify(menuRows));
      if (signature !== catalogPublishedHash) {
        publishingCatalog = true;
        relay.publishCatalog(menuRows)
          .then(() => { catalogPublishedHash = signature; })
          .catch(error => log('catalog-publish-failed', { code: error.code ?? 'local' }))
          .finally(() => { publishingCatalog = false; });
      }
    }
    const current = new Set(rows.map(row => row.id));
    for (const id of known.keys()) if (!current.has(id)) { ipc.follow(id, false); known.delete(id); states.delete(id); revisions.delete(id); scannedRevisions.delete(id); followRequested.delete(id); }
    known.clear();
    for (const row of rows) {
      known.set(row.id, row);
      db.prepare('INSERT INTO threads(id,title) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(row.id, row.title);
    }
    reconcileFollowing();
  } catch { log('catalog-unavailable'); }
  finally { catalog?.close(); discovering = false; }
}

async function flushOutbox() {
  if (sending) return; sending = true;
  try {
    const row = db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get(); if (!row) return;
    db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(row.id);
    try {
      const route = row.route && JSON.parse(row.route);
      const routine = /^system:(?:delivered-|queued-|media-queued-|speech-transcript-)/.test(row.event_key);
      const nonResult = route && !row.event_key.startsWith('system:') && !['final', 'error'].includes(route.kind);
      const chatId = row.chat_id || config.ownerChatId;
      const selected = selectedTidFor(chatId);
      if (routine || nonResult || (route?.tid && selected && route.tid !== selected)) {
        db.prepare("UPDATE outbox SET status='filtered' WHERE id=?").run(row.id);
        return;
      }
      const outgoing = outgoingMessage({ db, row, title, selectedTid: selected });
      const sent = await telegram('sendMessage', { chat_id: chatId, text: outgoing.text, link_preview_options: { is_disabled: true }, ...(outgoing.reply_markup ? { reply_markup: outgoing.reply_markup } : {}) });
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE outbox SET status='sent',telegram_id=? WHERE id=?").run(sent.message_id, row.id);
        if (route?.tid) db.prepare('INSERT OR REPLACE INTO routes VALUES (?,?,?,?)').run(chatId, sent.message_id, route.tid, row.route);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      log('telegram-sent', { messageId: sent.message_id, hasRoute: !!row.route });
    } catch (error) {
      const status = error.code === 429 ? 'pending' : ['network', 'invalid-response'].includes(error.code) || !error.code ? 'unknown' : 'failed';
      db.prepare('UPDATE outbox SET status=? WHERE id=?').run(status, row.id);
      log('telegram-send-failed', { outboxId: row.id, code: error.code ?? 'local', status });
      if (error.code === 429) await sleep(Math.min(60000, (error.retryAfter ?? 5) * 1000));
    }
  } finally { sending = false; }
}

function numberedAnswers(questions, text) {
  if (questions.length === 1) return [text];
  const chunks = text.split(/(?:^|\n)\s*\d+[.)]\s*/).filter(x => x.trim()).map(x => x.trim());
  if (chunks.length !== questions.length) return null;
  return chunks;
}
function selectedRoute(chatId) {
  const selected = selectedTidFor(chatId);
  if (!selected) return null;
  const request = states.get(selected)?.requests?.find(r => r.method === 'item/tool/requestUserInput');
  return { tid: selected, chatId, kind: request ? 'question' : 'thread', ...(request ? { requestId: request.id } : {}) };
}
function ingest(update) {
  if (update.callback_query) {
    const callback = update.callback_query;
    const chatId = callback.message?.chat?.id;
    if (userFor(callback.from?.id, chatId)) {
      if (callback.data?.startsWith('codex:page:')) {
        const page = Number(callback.data.slice('codex:page:'.length));
        if (Number.isSafeInteger(page)) threadMenu(chatId, page);
      } else if (callback.data === 'codex:mode:single') {
        threadMenu(chatId);
      } else if (callback.data?.startsWith('codex:select:')) {
        const tid = callback.data.slice('codex:select:'.length);
        if (tid === 'all') {
          setSelectedTid(chatId, '');
          reconcileFollowing();
          system('Включены уведомления из всех чатов. Для ответа используйте «Ответить» на уведомление. Выбрать один чат: /chat.', { chatId });
        } else if (known.has(tid)) {
          setSelectedTid(chatId, tid);
          reconcileFollowing();
          system(`Выбран чат «${title(tid)}». Теперь уведомления приходят только из него; текст, голосовые и изображения можно отправлять сюда обычным сообщением. Сменить чат: /chat.`, { chatId }, `selected-${update.update_id}`);
          log('thread-selected', { tid });
        } else system('Этот чат больше не доступен. Откройте /chat и выберите другой.', { chatId }, `selection-missing-${update.update_id}`);
      } else handleReplyButton({ db, update, config, system, title });
    }
    telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {});
    return;
  }
  const m = ownerMessage(update, config);
  if (!m) return;
  const chatId = m.chat.id;
  const selected = selectedTidFor(chatId);
  if (db.prepare('SELECT 1 FROM incoming WHERE update_id=?').get(update.update_id)) return;
  const text = m.text?.trim();
  const media = mediaOf(m);
  if (!text && !media) { system(`Можно отправлять текст, голосовое или изображение.${selected ? '' : ' Используйте «Ответить» на уведомление задачи или выберите один чат через /chat.'}`, { chatId }, `unsupported-${update.update_id}`); return; }
  if (text && isBotCommand(m)) {
    const cmd = text.split(/\s/)[0].split('@')[0];
    if (cmd === '/status') system(`Codex: ${connected ? 'подключён' : 'ожидаю запуска'}\nРежим: ${selected ? title(selected) : 'все чаты'}\nЗадач подключено: ${states.size}\nРаботают: ${[...states.values()].filter(s => s.threadRuntimeStatus?.type === 'active').length}\nУведомления: ${paused ? 'пауза' : 'только результаты и ошибки'}\nОтветов в очереди: ${db.prepare("SELECT count(*) n FROM incoming WHERE status='queued'").get().n}\nВложений на загрузке: ${db.prepare("SELECT count(*) n FROM incoming WHERE status IN ('media_queued','media_downloading')").get().n}\nГолосовых на распознавании: ${db.prepare("SELECT count(*) n FROM incoming WHERE status IN ('speech_queued','speech_running')").get().n}\nРаспознавание: локальный Whisper, русский\nДоставок с неопределённым результатом: ${db.prepare("SELECT count(*) n FROM incoming WHERE status='unknown'").get().n}`, { chatId });
    else if (['/start', '/menu', '/mode'].includes(cmd)) modeMenu(chatId);
    else if (cmd === '/chat') threadMenu(chatId);
    else system('Выберите режим через /mode: один чат или все чаты. Уведомления приходят только о результате работы.', { chatId });
    db.prepare("INSERT INTO incoming(update_id,message_id,text,status) VALUES (?,?,?,'command')").run(update.update_id, m.message_id, cmd);
    return;
  }
  let mapping = (m.reply_to_message && db.prepare('SELECT route FROM routes WHERE chat_id=? AND message_id=?').get(m.chat.id, m.reply_to_message.message_id))
    || (media && m.media_group_id && db.prepare('SELECT route FROM media_groups WHERE chat_id=? AND group_id=?').get(m.chat.id, m.media_group_id));
  if (selected) {
    const mapped = mapping && JSON.parse(mapping.route);
    const currentRequest = mapped?.kind === 'question' && states.get(selected)?.requests?.some(r => r.id === mapped.requestId);
    if (!mapped || mapped.tid !== selected || (mapped.kind === 'question' && !currentRequest)) mapping = { route: JSON.stringify(selectedRoute(chatId)) };
  }
  if (!mapping) { system('Не удалось определить задачу. Выберите один чат через /chat или используйте «Ответить» на уведомление.', { chatId }, `unmapped-${update.update_id}`); return; }
  mapping = { route: JSON.stringify({ ...JSON.parse(mapping.route), chatId }) };
  if (media && m.media_group_id) db.prepare('INSERT OR REPLACE INTO media_groups VALUES (?,?,?)').run(m.chat.id, m.media_group_id, mapping.route);
  if (media) {
    const route = JSON.parse(mapping.route);
    try {
      queueMedia(db, update, route, randomUUID());
      log('media-queued', { updateId: update.update_id, tid: route.tid, kind: media.kind });
    } catch (e) {
      if (!(e instanceof MediaError)) throw e;
      db.prepare("INSERT INTO incoming(update_id,message_id,route,status,error) VALUES (?,?,?,'media_failed',?)").run(update.update_id, m.message_id, mapping.route, e.code);
      system(mediaErrorText(e.code), route, `media-failed-${update.update_id}`);
    }
    return;
  }
  db.prepare("INSERT INTO incoming(update_id,message_id,text,route,status,client_message_id) VALUES (?,?,?,?,'queued',?)").run(update.update_id, m.message_id, text, mapping.route, randomUUID());
  const route = JSON.parse(mapping.route);
  db.prepare('INSERT OR REPLACE INTO routes VALUES (?,?,?,?)').run(m.chat.id, m.message_id, route.tid, mapping.route);
  log('reply-queued', { updateId: update.update_id, tid: route.tid });
}

async function deliver() {
  if (delivering || !connected || setting('protocolMismatch', '')) return; delivering = true;
  try {
    const row = nextReply(db.prepare("SELECT * FROM incoming WHERE status IN ('queued','media_queued','media_downloading','speech_queued','speech_running') ORDER BY update_id").all(), states); if (!row) return;
    const media = db.prepare('SELECT kind,path,transcript FROM media_files WHERE update_id=?').get(row.update_id);
    if (media && !media.transcript && (!media.path || !fs.existsSync(media.path))) {
      db.prepare("UPDATE incoming SET status='media_queued' WHERE update_id=?").run(row.update_id);
      db.prepare('UPDATE media_files SET path=NULL,next_attempt_at=0 WHERE update_id=?').run(row.update_id);
      return;
    }
    if (media?.kind === 'voice' && !media.transcript?.trim()) {
      db.prepare("UPDATE incoming SET status='speech_queued' WHERE update_id=?").run(row.update_id);
      return;
    }
    const route = JSON.parse(row.route), state = states.get(route.tid);
    if (!state) return; // The wakeup worker loads missing owners in the existing desktop app.
    let owner;
    try { owner = await ipc.owner(route.tid); } catch (error) {
      if (/^(?:owner-not-found|no-client-found)$/.test(error.message)) states.delete(route.tid);
      return;
    }
    let text = row.text, method, params;
    if (route.kind === 'question') {
      const request = state.requests?.find(r => r.id === route.requestId && r.method === 'item/tool/requestUserInput');
      if (!request) { system('Этот запрос уже закрыт. Ваш ответ не был отправлен. Для нового сообщения ответьте на итог задачи.', { tid: route.tid, kind: 'thread', chatId: route.chatId }); db.prepare("UPDATE incoming SET status='stale' WHERE update_id=?").run(row.update_id); return; }
      const answers = numberedAnswers(request.params.questions, text);
      if (!answers) { system('Ответьте на каждый вопрос отдельной строкой: 1. … 2. …', route); db.prepare("UPDATE incoming SET status='invalid' WHERE update_id=?").run(row.update_id); return; }
      method = 'thread-follower-submit-user-input';
      params = { conversationId: route.tid, requestId: route.requestId, response: { answers: Object.fromEntries(request.params.questions.map((q, i) => [q.id, { answers: [answers[i]] }])) } };
    } else {
      if (route.kind === 'async_question' && (!media || media.kind === 'voice')) {
        const answers = numberedAnswers(route.questions, text);
        if (!answers) { system('Ответьте на каждый вопрос отдельной строкой: 1. … 2. …', route); db.prepare("UPDATE incoming SET status='invalid' WHERE update_id=?").run(row.update_id); return; }
        const reply = route.questions.map((q, i) => ({ questionItemId: JSON.stringify(['request_user_input_async', route.itemId, i]), question: q.title, answer: answers[i] }));
        text = `<send_user_message_question_reply>\n${JSON.stringify(reply)}\n</send_user_message_question_reply>`;
      }
      const input = replyInput(text, media);
      const active = latestTurn(state)?.status === 'inProgress' || state.threadRuntimeStatus?.type === 'active';
      if (active) {
        method = 'thread-follower-steer-turn';
        params = { conversationId: route.tid, input, clientUserMessageId: row.client_message_id, attachments: [],
          restoreMessage: { id: row.client_message_id, text, cwd: state.cwd, createdAt: Date.now(), context: { prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [], commentAttachments: [], workspaceRoots: [state.cwd ?? '/'], ideContext: null, collaborationMode: state.latestCollaborationMode } } };
      } else {
        method = 'thread-follower-start-turn';
        params = { conversationId: route.tid, turnStart: { request: { threadId: route.tid, input, clientUserMessageId: row.client_message_id }, context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] } } };
      }
    }
    db.prepare("UPDATE incoming SET status='sending' WHERE update_id=?").run(row.update_id);
    try {
      await ipc.request(method, params, owner, 20000);
      db.prepare("UPDATE incoming SET status='delivered' WHERE update_id=?").run(row.update_id);
      log('reply-delivered', { updateId: row.update_id, tid: route.tid, method, ...(media ? { mediaKind: media.kind } : {}) });
    } catch (error) {
      // A lost acknowledgement is not evidence that a prompt was rejected. Do not resend it blindly.
      db.prepare("UPDATE incoming SET status='unknown',error=? WHERE update_id=?").run(redact(error.message).slice(0, 150), row.update_id);
      system(`Не удалось подтвердить доставку ответа в «${title(route.tid)}». Автоматически повторять его не буду: проверьте задачу в Codex.`, { tid: route.tid, kind: 'thread', chatId: route.chatId });
      log('reply-unconfirmed', { updateId: row.update_id, tid: route.tid });
    }
  } finally { delivering = false; }
}

async function poll() {
  while (!stopping) {
    try {
      const updates = relay ? await relay.poll() : await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message','callback_query'] });
      for (const update of updates) {
        db.exec('BEGIN IMMEDIATE');
        try { ingest(update); offset = update.update_id + 1; setSetting('telegramOffset', offset); db.exec('COMMIT'); }
        catch { db.exec('ROLLBACK'); throw new Error('ingest-failed'); }
      }
      // Only acknowledge the server queue after all replies are durably stored locally.
      // A failed acknowledgement replays the same update IDs; ingest() deduplicates them.
      if (relay) { await relay.ack(updates); await sleep(updates.length ? 500 : 5000); }
    } catch (error) { log('poll-retry', { code: error.code ?? 'local' }); await sleep(relay ? 1000 : 5000); }
  }
}

async function statusFile() {
  const value = { pid: process.pid, updatedAt: new Date().toISOString(), connected, transport: relay ? 'https-server-relay' : 'telegram-direct', discovered: known.size, subscribed: states.size, selectedTid,
    active: [...states.values()].filter(s => s.threadRuntimeStatus?.type === 'active').length,
    includeProgress: false, paused, lastGoodEvent, queuedReplies: db.prepare("SELECT count(*) n FROM incoming WHERE status='queued'").get().n,
    mediaReplies: db.prepare("SELECT count(*) n FROM incoming WHERE status IN ('media_queued','media_downloading')").get().n,
    speechReplies: db.prepare("SELECT count(*) n FROM incoming WHERE status IN ('speech_queued','speech_running')").get().n,
    voiceRecognition: 'local-whisper-turbo', voiceLanguage: config.voiceLanguage || 'ru',
    deliveredMedia: db.prepare("SELECT count(*) n FROM incoming JOIN media_files USING(update_id) WHERE status='delivered'").get().n,
    deliveredReplies: db.prepare("SELECT count(*) n FROM incoming WHERE status='delivered'").get().n,
    unknownReplies: db.prepare("SELECT count(*) n FROM incoming WHERE status='unknown'").get().n };
  fs.writeFileSync(path.join(privateDir, 'status.json'), JSON.stringify(value, null, 2));
}
async function connectionLoop() {
  while (!stopping) {
    if (!connected) try { await ipc.connect(); connected = true; log('codex-connected'); await discover(); }
    catch { ipc.close(); }
    await sleep(5000);
  }
}

if (process.argv.includes('--welcome') && !setting('welcomed', '')) {
  system('Мост Telegram ↔ Codex подключён. Выберите режим через /start: один чат или все чаты. Я буду присылать только результаты работы и ошибки.', null, 'welcome');
  setSetting('welcomed', true);
}
log('started', { pid: process.pid });
const menuCommands = [
  { command: 'start', description: 'Выбрать режим' },
  { command: 'mode', description: 'Один чат или все чаты' }
];
if (!relay) telegram('setMyCommands', { commands: menuCommands })
  .catch(error => log('telegram-menu-failed', { code: error.code }));
setInterval(() => { if (!scanning) { scanning = true; try {
  for (const tid of states.keys()) {
    const revision = revisions.get(tid);
    if (revision === scannedRevisions.get(tid)) continue;
    scan(tid);
    scannedRevisions.set(tid, revision);
  }
} catch { log('scan-failed'); } finally { scanning = false; } } }, 1500);
setInterval(() => { discover().catch(() => log('discovery-failed')); }, 15000);
setInterval(() => { flushOutbox().catch(() => log('outbox-failed')); }, 1100);
setInterval(() => { deliver().catch(() => log('delivery-failed')); }, 1500);
setInterval(() => {
  if (!connected || setting('protocolMismatch', '')) return;
  reconcileFollowing();
  const pending = db.prepare("SELECT route,status FROM incoming WHERE status IN ('queued','media_queued','media_downloading','speech_queued','speech_running') ORDER BY update_id").all();
  wakeup.tick(pending).catch(() => log('thread-wakeup-failed'));
}, 1500);
setInterval(() => { mediaQueue.tick().catch(() => log('media-queue-failed')); }, 1000);
setInterval(() => { speechQueue.tick().catch(() => log('speech-queue-failed')); }, 1000);
setInterval(() => { statusFile().catch(() => {}); }, 5000);
process.on('uncaughtException', () => { log('fatal-error'); process.exit(1); });
process.on('unhandledRejection', () => { log('unhandled-error'); process.exit(1); });
process.on('SIGTERM', () => { stopping = true; whisper.close(); ipc.close(); db.close(); process.exit(0); });
process.on('exit', () => whisper.close());
await Promise.all([poll(), connectionLoop()]);
