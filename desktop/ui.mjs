const markers = ['🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫'];

export function initUi(db) {
  try { db.exec('ALTER TABLE outbox ADD COLUMN reply_markup TEXT'); } catch {}
  db.exec('CREATE TABLE IF NOT EXISTS thread_colors (tid TEXT PRIMARY KEY, color INTEGER NOT NULL)');
}
function marker(db, tid) {
  let row = db.prepare('SELECT color FROM thread_colors WHERE tid=?').get(tid);
  if (!row) {
    const color = db.prepare('SELECT count(*) n FROM thread_colors').get().n % markers.length;
    db.prepare('INSERT OR IGNORE INTO thread_colors VALUES (?,?)').run(tid, color); row = { color };
  }
  return markers[row.color % markers.length];
}
export function outgoingMessage({ db, row, title, selectedTid = '' }) {
  let text = row.text, replyMarkup = row.reply_markup ? JSON.parse(row.reply_markup) : null;
  if (row.route && JSON.parse(row.route).tid) {
    const route = JSON.parse(row.route); const icon = marker(db, route.tid);
    text = `${text}\n\n${icon} ${title(route.tid)}`;
    if (!replyMarkup && !selectedTid) replyMarkup = { inline_keyboard: [
      [{ text: `${icon} Ответить`, callback_data: 'codex:reply' }],
      [{ text: '📌 Только этот чат', callback_data: `codex:select:${route.tid}` }]
    ] };
  }
  return { text, reply_markup: replyMarkup };
}
export function handleReplyButton({ db, update, config, system, title }) {
  const callback = update.callback_query;
  if (!callback || callback.data !== 'codex:reply') return false;
  const allowed = [{ userId: config.ownerUserId, chatId: config.ownerChatId },
    ...(config.additionalUsers ?? []).map(id => ({ userId: Number(id), chatId: Number(id) }))];
  if (!allowed.some(user => callback.from?.id === user.userId && callback.message?.chat?.id === user.chatId)) return true;
  const mapping = db.prepare('SELECT route FROM routes WHERE chat_id=? AND message_id=?').get(callback.message.chat.id, callback.message.message_id);
  if (!mapping) { system('Маршрут этого сообщения уже недоступен.', { chatId: callback.message.chat.id }, `callback-unmapped-${update.update_id}`); return true; }
  const route = { ...JSON.parse(mapping.route), chatId: callback.message.chat.id };
  system(`↩ Напишите ответ для «${title(route.tid)}» — текстом, голосовым сообщением или изображением.`, route, `callback-${update.update_id}`, { force_reply: true, selective: true, input_field_placeholder: 'Ваш ответ в Codex' });
  return true;
}
