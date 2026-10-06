import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function openCodexThread(tid) {
  if (!threadIdPattern.test(tid)) throw new Error('invalid-thread-id');
  if (process.platform !== 'win32') throw new Error('thread-wakeup-windows-only');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Only open the existing task. Never put a prompt or a credential in a URL,
  // and never resume its history in a competing app-server process.
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Start-Process -FilePath 'codex://threads/${tid}' -WindowStyle Hidden`],
  { windowsHide: true, timeout: 15000 });
}

export class ThreadWakeup {
  constructor({ ipc, states, known, open = openCodexThread, log = () => {}, now = Date.now,
    graceMs = 5000, retryMs = 60000 }) {
    Object.assign(this, { ipc, states, known, open, log, now, graceMs, retryMs });
    this.waiting = new Map(); this.busy = false; this.nextOpenAt = 0;
  }

  async tick(rows) {
    if (this.busy) return;
    this.busy = true;
    try {
      const first = new Map();
      for (const row of rows) {
        const tid = JSON.parse(row.route).tid;
        if (!first.has(tid)) first.set(tid, row);
      }
      for (const tid of this.waiting.keys()) {
        if (this.states.has(tid) || !first.has(tid)) this.waiting.delete(tid);
      }
      for (const [tid, row] of first) {
        if (row.status !== 'queued' || this.states.has(tid) || !this.known.has(tid)) continue;
        let job = this.waiting.get(tid);
        if (!job) {
          this.ipc.follow(tid);
          this.waiting.set(tid, { nextAttempt: this.now() + this.graceMs });
          continue;
        }
        if (this.now() < job.nextAttempt || this.now() < this.nextOpenAt) continue;
        job.nextAttempt = this.now() + this.retryMs;
        try {
          // A loaded owner may simply owe us a snapshot. Resubscribe first.
          const owner = await this.ipc.owner(tid);
          this.ipc.follow(tid, true, [owner]);
        } catch (error) {
          // A timeout/disconnect is not proof that the task has no owner.
          if (!/^(?:owner-not-found|no-client-found)$/.test(error.message)) {
            this.log('thread-wakeup-retry', { tid, reason: 'owner-discovery-unavailable' });
            continue;
          }
          if (this.states.has(tid)) continue;
          this.nextOpenAt = this.now() + this.graceMs;
          try {
            await this.open(tid);
            this.ipc.follow(tid);
            this.log('thread-wakeup-opened', { tid });
          } catch {
            this.log('thread-wakeup-retry', { tid, reason: 'open-failed' });
          }
        }
      }
    } finally { this.busy = false; }
  }
}
