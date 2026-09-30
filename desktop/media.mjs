import fs from 'node:fs/promises';
import path from 'node:path';

// Telegram's standard Bot API download limit applies to voice notes and original images.
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export class MediaError extends Error {
  constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}
export function ownerMessage(update, config) {
  const m = update.message;
  const allowed = [{ userId: config.ownerUserId, chatId: config.ownerChatId },
    ...(config.additionalUsers ?? []).map(id => ({ userId: Number(id), chatId: Number(id) }))];
  return m?.chat?.type === 'private' && allowed.some(user => m.chat.id === user.chatId && m.from?.id === user.userId) ? m : null;
}
export function initMedia(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS media_files (
    update_id INTEGER PRIMARY KEY, file_id TEXT NOT NULL, duration INTEGER,
    file_size INTEGER, kind TEXT NOT NULL, path TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0
  ); UPDATE incoming SET status='media_queued' WHERE status='media_downloading';`);
  const columns = new Set(db.prepare('PRAGMA table_info(media_files)').all().map(row => row.name));
  for (const [name, type] of Object.entries({ caption: 'TEXT', transcript: 'TEXT', speech_attempts: 'INTEGER NOT NULL DEFAULT 0', speech_retry_at: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE media_files ADD COLUMN ${name} ${type}`);
  }
  db.exec("UPDATE incoming SET status='speech_queued' WHERE status='speech_running'");
}
export function mediaOf(message) {
  if (message.voice) return { ...message.voice, kind: 'voice' };
  if (message.photo?.length) return { ...message.photo.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b)), kind: 'image' };
  if (/^image\/(jpeg|png|webp|gif)$/i.test(message.document?.mime_type ?? '')) return { ...message.document, kind: 'image' };
  return null;
}
export function mediaContext(route, caption = '', kind = 'voice') {
  const questionText = route.kind === 'async_question'
    ? '\nЭто ответ на вопрос из этой задачи: ' + (route.questions ?? []).map(q => q.title).join('; ')
    : '';
  return `${kind === 'voice' ? 'Голосовое сообщение' : 'Изображение'} пользователя из Telegram.${questionText}${caption ? '\nПодпись: ' + caption : ''}`;
}
// Called inside ingest's transaction: the server is acknowledged only after this is durable.
export function queueMedia(db, update, route, clientMessageId) {
  if (db.prepare('SELECT 1 FROM incoming WHERE update_id=?').get(update.update_id)) return false;
  const m = update.message, v = mediaOf(m);
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || typeof v?.file_id !== 'string' || !v.file_id || v.file_id.length > 1024
      || (v.kind === 'voice' && (!Number.isSafeInteger(v.duration) || v.duration < 0))) throw new MediaError('media-invalid');
  if (v.file_size != null && (!Number.isSafeInteger(v.file_size) || v.file_size <= 0)) throw new MediaError('media-invalid');
  if (v.file_size > MAX_MEDIA_BYTES) throw new MediaError('media-too-large');
  // This RPC accepts only string answers. Never invent an answer or approve on the user's behalf.
  if (route.kind === 'question') throw new MediaError('media-text-question');
  const serialized = JSON.stringify(route);
  db.prepare("INSERT INTO incoming(update_id,message_id,text,route,status,client_message_id) VALUES (?,?,?,?,'media_queued',?)")
    .run(update.update_id, m.message_id, mediaContext(route, m.caption?.trim(), v.kind), serialized, clientMessageId);
  db.prepare('INSERT INTO media_files(update_id,file_id,duration,file_size,kind,caption) VALUES (?,?,?,?,?,?)')
    .run(update.update_id, v.file_id, v.duration ?? null, v.file_size ?? null, v.kind, m.caption?.trim() || null);
  db.prepare('INSERT OR REPLACE INTO routes VALUES (?,?,?,?)').run(m.chat.id, m.message_id, route.tid, serialized);
  return true;
}
export function mediaErrorText(code) {
  if (code === 'media-too-large') return 'Вложение превышает лимит загрузки Telegram — 20 МБ. Отправьте меньший файл.';
  if (code === 'media-text-question') return 'Этот запрос Codex требует текстового ответа в форме. Ответьте на него текстом; голосовые и изображения можно отправлять в обычную задачу и на вопросы без блокирующей формы.';
  return 'Не удалось загрузить вложение. Отправьте его ещё раз через «Ответить» на уведомление задачи.';
}
function imageExtension(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return '.jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return '.gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return '.webp';
  throw new MediaError('image-invalid');
}
function audioExtension(bytes) {
  if (bytes.subarray(0, 4).toString() === 'OggS') return '.ogg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return '.wav';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return '.m4a';
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return '.mp3';
  throw new MediaError('media-invalid-audio');
}
export async function downloadMedia({ job, directory, token, telegram, fetcher = fetch, maxBytes = MAX_MEDIA_BYTES }) {
  let file;
  try { file = await telegram('getFile', { file_id: job.file_id }); }
  catch (e) { throw new MediaError('media-get-file', ![400, 401, 403, 404].includes(e.code)); }
  if (file.file_size > maxBytes || job.file_size > maxBytes) throw new MediaError('media-too-large');
  // The returned path is relative to api.telegram.org; never accept an arbitrary URL or redirect.
  if (typeof file.file_path !== 'string' || !/^[\w./-]+$/.test(file.file_path)
      || file.file_path.startsWith('/') || file.file_path.split('/').some(p => p === '..' || p === '.' || !p)) throw new MediaError('media-invalid-path');
  let response;
  try { response = await fetcher(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(90000), redirect: 'error' }); }
  catch { throw new MediaError('media-download-network', true); }
  if (!response.ok) throw new MediaError('media-download-http', ![401, 403].includes(response.status));
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new MediaError('media-too-large');
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new MediaError('media-too-large');
      chunks.push(chunk);
    }
  } catch (e) { if (e instanceof MediaError) throw e; throw new MediaError('media-download-network', true); }
  if (!size || (file.file_size != null && size !== file.file_size)) throw new MediaError('media-download-incomplete', true);
  const bytes = Buffer.concat(chunks), extension = job.kind === 'image' ? imageExtension(bytes) : audioExtension(bytes);
  if (!Number.isSafeInteger(job.update_id) || job.update_id < 0) throw new MediaError('media-invalid');
  const destination = path.join(directory, `${job.kind === 'image' ? 'image' : 'voice'}-${job.update_id}${extension}`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(destination + '.part', bytes, { mode: 0o600 });
    await fs.rename(destination + '.part', destination);
  } catch { throw new MediaError('media-storage', true); }
  return destination;
}
export class MediaQueue {
  constructor({ db, directory, token, telegram, notify, log, downloader = downloadMedia, now = Date.now }) {
    Object.assign(this, { db, directory, token, telegram, notify, log, downloader, now });
    this.busy = false;
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const job = this.db.prepare("SELECT v.*, i.route FROM media_files v JOIN incoming i USING(update_id) WHERE i.status='media_queued' AND v.next_attempt_at<=? ORDER BY v.update_id LIMIT 1").get(this.now());
      if (!job) return;
      this.db.prepare("UPDATE incoming SET status='media_downloading' WHERE update_id=?").run(job.update_id);
      try {
        const file = await this.downloader({ job, directory: this.directory, token: this.token, telegram: this.telegram });
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('UPDATE media_files SET path=? WHERE update_id=?').run(file, job.update_id);
          this.db.prepare("UPDATE incoming SET status='queued',error=NULL WHERE update_id=?").run(job.update_id);
          this.db.exec('COMMIT');
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        this.log('media-ready', { updateId: job.update_id });
      } catch (e) {
        const retryable = !(e instanceof MediaError) || e.retryable, code = e instanceof MediaError ? e.code : 'media-local-error';
        const attempts = job.attempts + 1;
        this.db.prepare('UPDATE incoming SET status=?,error=? WHERE update_id=?').run(retryable ? 'media_queued' : 'media_failed', code, job.update_id);
        this.db.prepare('UPDATE media_files SET attempts=?,next_attempt_at=? WHERE update_id=?').run(attempts, this.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)), job.update_id);
        if (!retryable) this.notify(mediaErrorText(code), JSON.parse(job.route), `media-failed-${job.update_id}`);
        else if (attempts === 3) this.notify('Вложение сохранено в очереди. Загрузка пока не удаётся; продолжу попытки автоматически.', JSON.parse(job.route), `media-retry-${job.update_id}`);
        this.log('media-download-failed', { updateId: job.update_id, code, retryable });
      }
    } finally { this.busy = false; }
  }
}
// Preserve ordering within a task while downloads for another task are pending.
export function nextReply(rows, states) {
  const blocked = new Set();
  for (const row of rows) {
    const tid = JSON.parse(row.route).tid;
    if (row.status === 'queued' && states.has(tid) && !blocked.has(tid)) return row;
    blocked.add(tid);
  }
}
export function replyInput(text, media) {
  return [{ type: 'text', text, text_elements: [] }, ...(media?.path ? [{ type: media.kind === 'image' ? 'localImage' : 'localAudio', path: media.path }] : [])];
}
