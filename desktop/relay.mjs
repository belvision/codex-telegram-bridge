export class BookRelay {
  constructor(url, key) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('relay-must-use-https');
    if (!key) throw new Error('relay-key-missing');
    this.url = parsed.toString();
    this.key = key;
  }

  async call(body) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Book-Relay-Key': this.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(body.action === 'poll' ? 8000 : 15000)
    });
    if (!response.ok) throw Object.assign(new Error(`relay-http-${response.status}`), { code: `http-${response.status}` });
    const payload = await response.json();
    if (!payload?.ok) throw new Error('relay-invalid-response');
    return payload;
  }

  async poll() { return (await this.call({ action: 'poll' })).updates ?? []; }
  async configureMenu() { await this.call({ action: 'menu' }); }
  async publishCatalog(threads) { await this.call({ action: 'catalog', threads }); }
  async ack(updates) {
    if (!updates.length) return;
    await this.call({ action: 'ack', update_ids: updates.map(update => update.update_id) });
  }
}
