import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const allowedCodes = new Set(['speech-protocol', 'speech-file-unavailable', 'speech-too-large', 'speech-too-long', 'speech-invalid-audio', 'speech-empty', 'speech-model-unavailable', 'speech-uncertain', 'speech-engine-error']);
export class SpeechError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export class LocalWhisper {
  constructor({ root = path.resolve(import.meta.dirname, '../speech'), audioRoot, language = 'ru' }) {
    Object.assign(this, { root, audioRoot, language });
    this.pending = new Map(); this.child = null;
  }
  start() {
    if (this.child) return;
    const python = path.join(this.root, '.venv', 'Scripts', 'python.exe');
    const script = path.join(this.root, 'bridge-worker.py');
    if (![python, script, path.join(this.root, 'models', 'turbo', 'model.bin')].every(file => fs.existsSync(file))) throw new SpeechError('speech-model-unavailable');
    const child = spawn(python, ['-u', '-X', 'utf8', script, '--audio-root', this.audioRoot, '--language', this.language], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
    });
    this.child = child;
    let buffer = '';
    const fail = code => {
      if (this.child !== child) return;
      this.child = null; child.stdin.destroy();
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new SpeechError(code)); }
      this.pending.clear();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { fail('speech-protocol'); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let value;
        try { value = JSON.parse(line); } catch { fail('speech-protocol'); return; }
        if (value.type === 'ready') {
          if (value.protocol !== 1) fail('speech-protocol');
          continue;
        }
        const item = this.pending.get(value.id); if (!item) continue;
        clearTimeout(item.timer); this.pending.delete(value.id);
        if (value.type === 'result' && typeof value.text === 'string' && value.text.trim() && value.text.length <= 50000) item.resolve(value);
        else item.reject(new SpeechError(allowedCodes.has(value.code) ? value.code : 'speech-protocol'));
      }
    });
    // stderr can contain library paths or diagnostics. Do not include it in logs or user messages.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => fail('speech-worker-unavailable'));
    child.on('error', () => fail('speech-worker-unavailable'));
    child.on('exit', () => fail('speech-worker-exited'));
  }
  transcribe(audioPath, duration = 0) {
    if (this.pending.size) return Promise.reject(new SpeechError('speech-worker-busy'));
    try { this.start(); } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeoutMs = Math.max(120000, Math.min(1260000, (duration * 2 + 60) * 1000));
      const timer = setTimeout(() => this.close('speech-timeout'), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, path: audioPath }) + '\n');
    });
  }
  close(code = 'speech-worker-stopped') {
    const child = this.child; this.child = null;
    child?.stdin.destroy(); // worker's stdin reader terminates it, including an in-progress recognition
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new SpeechError(code)); }
    this.pending.clear();
  }
}
export function speechErrorText(code) {
  if (code === 'speech-empty') return 'Не удалось обнаружить речь в голосовом. Ответьте ещё раз голосом или текстом; в Codex ничего не отправлено.';
  if (code === 'speech-uncertain') return 'Не удалось уверенно распознать речь. Повторите запись ближе к микрофону или ответьте текстом; в Codex ничего не отправлено.';
  if (code === 'speech-too-long') return 'Для распознавания разделите голосовое на записи не длиннее 10 минут.';
  return 'Не удалось распознать голосовое. Запись сохранена; отправьте ответ текстом или повторите голосовое позже.';
}
export class SpeechQueue {
  constructor({ db, recognizer, notify, log, title = tid => tid, now = Date.now }) {
    Object.assign(this, { db, recognizer, notify, log, title, now }); this.busy = false;
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const job = this.db.prepare("SELECT m.*,i.route FROM media_files m JOIN incoming i USING(update_id) WHERE i.status='speech_queued' AND m.speech_retry_at<=? ORDER BY m.update_id LIMIT 1").get(this.now());
      if (!job) return;
      const route = JSON.parse(job.route);
      if (!job.path) {
        this.db.prepare("UPDATE incoming SET status='media_queued' WHERE update_id=?").run(job.update_id);
        return;
      }
      this.db.prepare("UPDATE incoming SET status='speech_running' WHERE update_id=?").run(job.update_id);
      try {
        const result = job.transcript ? { text: job.transcript } : await this.recognizer.transcribe(job.path, job.duration);
        const transcript = result.text?.trim();
        if (!transcript) throw new SpeechError('speech-empty');
        const text = transcript + (job.caption ? `\n\nПодпись: ${job.caption}` : '');
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('UPDATE media_files SET transcript=? WHERE update_id=?').run(transcript, job.update_id);
          this.db.prepare("UPDATE incoming SET status='queued',text=?,error=NULL WHERE update_id=?").run(text, job.update_id);
          this.db.exec('COMMIT');
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        this.log('speech-ready', { updateId: job.update_id, tid: route.tid });
      } catch (error) {
        const code = error instanceof SpeechError ? error.code : 'speech-local-error';
        if (code === 'speech-file-unavailable') {
          this.db.prepare("UPDATE incoming SET status='media_queued',error=? WHERE update_id=?").run(code, job.update_id);
          this.db.prepare('UPDATE media_files SET path=NULL,next_attempt_at=0 WHERE update_id=?').run(job.update_id);
          return;
        }
        const attempts = job.speech_attempts + 1;
        const permanent = ['speech-empty', 'speech-uncertain', 'speech-too-long', 'speech-too-large', 'speech-invalid-audio'].includes(code);
        const retry = !permanent && attempts < 3;
        if (!permanent) this.recognizer.close?.();
        this.db.prepare('UPDATE incoming SET status=?,error=? WHERE update_id=?').run(retry ? 'speech_queued' : 'speech_failed', code, job.update_id);
        this.db.prepare('UPDATE media_files SET speech_attempts=?,speech_retry_at=? WHERE update_id=?').run(attempts, this.now() + attempts * 30000, job.update_id);
        if (!retry) this.notify(speechErrorText(code), route, `speech-failed-${job.update_id}`);
        this.log('speech-failed', { updateId: job.update_id, code, retry });
      }
    } finally { this.busy = false; }
  }
}
