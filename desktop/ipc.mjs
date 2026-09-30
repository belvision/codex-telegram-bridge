import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const versions = {
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-submit-user-input': 1
};

export class CodexIpc extends EventEmitter {
  constructor(pipe = '\\\\.\\pipe\\codex-ipc') {
    super(); this.pipe = pipe; this.socket = null; this.chunks = []; this.buffered = 0;
    this.frameSize = null; this.draining = false;
    this.pending = new Map(); this.clientId = null;
  }

  connect() {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipe); let settled = false;
      socket.once('error', error => { if (!settled) { settled = true; reject(error); } });
      socket.once('connect', async () => {
        this.socket = socket;
        socket.on('error', error => { if (settled) this.emit('socketError', error); });
        socket.on('data', chunk => this.onData(chunk));
        socket.on('end', () => this.emit('socketEnd'));
        socket.on('close', hadError => this.onClose(hadError));
        try {
          const result = await this.request('initialize', { clientType: 'codex-telegram-bridge' }, null, 10000, 1);
          this.clientId = result?.result?.clientId ?? null;
          if (!this.clientId) throw new Error('ipc-initialize-invalid');
          settled = true; resolve();
        } catch (error) { settled = true; this.close(); reject(error); }
      });
    });
  }

  send(message) {
    if (!this.socket) throw new Error('ipc-disconnected');
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  onData(chunk) {
    this.chunks.push(chunk); this.buffered += chunk.length;
    if (!this.draining) { this.draining = true; setImmediate(() => this.drain()); }
  }

  take(size) {
    const parts = []; let remaining = size;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= remaining) { parts.push(chunk); this.chunks.shift(); remaining -= chunk.length; }
      else { parts.push(chunk.subarray(0, remaining)); this.chunks[0] = chunk.subarray(remaining); remaining = 0; }
    }
    this.buffered -= size;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  }

  drain() {
    if (this.frameSize === null) {
      if (this.buffered < 4) { this.draining = false; return; }
      this.frameSize = this.take(4).readUInt32LE(0);
      // Long-running Codex tasks can legitimately have large snapshots.
      if (this.frameSize > 512 * 1024 * 1024) { this.emit('frameTooLarge', this.frameSize); this.close(); return; }
    }
    if (this.buffered < this.frameSize) { this.draining = false; return; }
    const raw = this.take(this.frameSize); this.frameSize = null;
    let message;
    try { message = JSON.parse(raw.toString('utf8')); }
    catch (error) { this.emit('protocolError', error); this.close(); return; }
    try { this.onMessage(message); }
    catch (error) { this.emit('handlerError', error, message); }
    // Yield between frames so Telegram polling and delivery remain responsive.
    if (this.buffered >= 4) setImmediate(() => this.drain());
    else this.draining = false;
  }

  onMessage(message) {
    if (message.type === 'response' && message.requestId && this.pending.has(message.requestId)) {
      const pending = this.pending.get(message.requestId); this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.resultType === 'error') pending.reject(new Error(message.error ?? 'ipc-request-failed'));
      else pending.resolve(message);
      return;
    }
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'broadcast') this.emit('broadcast', message);
  }

  request(method, params = {}, destinationClientId = null, timeout = 15000, version = versions[method] ?? 1) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ipc-timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const message = { type: 'request', requestId: id, sourceClientId: this.clientId ?? 'initializing-client', method, version, params, timeoutMs: timeout };
      if (destinationClientId) message.targetClientId = destinationClientId;
      try { this.send(message); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  follow(conversationId, following = true, targetClientIds) {
    const params = { hostId: 'local', conversationId, following };
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId, version: 1, params, ...(targetClientIds ? { targetClientIds } : {}) });
  }

  async owner(conversationId) {
    const result = await this.request('thread-owner-discovery', { hostId: 'local', conversationId }, null, 10000);
    const owner = result?.handledByClientId;
    if (!owner || typeof owner !== 'string') throw new Error('owner-not-found');
    return owner;
  }

  onClose(hadError = false) {
    this.socket = null; this.clientId = null; this.chunks = []; this.buffered = 0;
    this.frameSize = null; this.draining = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ipc-disconnected')); }
    this.pending.clear(); this.emit('disconnected', { hadError });
  }
  close() { if (this.socket) { const socket = this.socket; this.socket = null; socket.destroy(); } }
}
