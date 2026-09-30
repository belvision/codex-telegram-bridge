import { createHash } from 'node:crypto';

export function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
export function redact(value) {
  return String(value ?? '')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/g, '[секрет скрыт]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/ig, '$1[скрыто]');
}
export function splitText(text, limit = 3500) {
  const out = []; let rest = String(text ?? '').trim();
  while (rest.length > limit) {
    let at = Math.max(rest.lastIndexOf('\n', limit), rest.lastIndexOf(' ', limit));
    if (at < limit * 0.6) at = limit;
    out.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest); return out.length ? out : [''];
}
export function isBotCommand(message) { return /^\/[a-z]+(?:@\w+)?(?:\s|$)/i.test(message?.text ?? ''); }

export function applyPatches(value, patches) {
  // IPC has already parsed patch values into new objects. Mutating the stored
  // snapshot avoids cloning the entire chat history for every small update.
  let root = value;
  for (const patch of patches ?? []) {
    const path = Array.isArray(patch.path) ? patch.path : String(patch.path ?? '').split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!path.length) { root = patch.op === 'remove' ? undefined : patch.value; continue; }
    let target = root;
    for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
    const key = path.at(-1);
    if (patch.op === 'remove') Array.isArray(target) ? target.splice(Number(key), 1) : delete target[key];
    else if (patch.op === 'add' && Array.isArray(target)) key === '-' ? target.push(patch.value) : target.splice(Number(key), 0, patch.value);
    else target[key] = patch.value;
  }
  return root;
}

export function turnsOf(state) {
  const candidates = [state?.turns, state?.thread?.turns, state?.conversation?.turns];
  for (const value of candidates) if (Array.isArray(value) && value.length) return value;
  const history = state?.turnHistory?.history;
  if (history?.entitiesByKey) {
    const keys = (history.islands ?? []).flatMap(island => island.entries ?? []).map(entry => entry.value ?? entry.key);
    const ordered = keys.map(key => history.entitiesByKey[key]).filter(value => value?.turnId && Array.isArray(value.items));
    if (ordered.length) return ordered;
    return Object.values(history.entitiesByKey).filter(value => value?.turnId && Array.isArray(value.items));
  }
  return [];
}
export function latestTurn(state) { const turns = turnsOf(state); return turns.at(-1); }

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return value.text ?? value.message ?? value.content?.map?.(textOf).filter(Boolean).join('\n') ?? '';
}
export function cleanNotificationText(text) {
  let value = String(text ?? '').trim();
  const heartbeat = value.match(/<heartbeat>[\s\S]*?<message>([\s\S]*?)<\/message>[\s\S]*?<\/heartbeat>/i);
  if (heartbeat) value = `🔔 Уведомление\n\n${heartbeat[1]}`;
  return value.replace(/<\/?(?:heartbeat|automation_id|decision|message)>/gi, '').trim();
}
export function eventsOf(state, includeProgress = false, recentTurns = null) {
  const events = [];
  const tid = state?.id ?? state?.threadId ?? state?.conversationId;
  for (const request of state?.requests ?? []) {
    const method = request.method ?? '';
    if (method === 'item/tool/requestUserInput') {
      const questions = request.params?.questions ?? [];
      events.push({ tid, kind: 'question', requestId: request.id, questions, text: questions.map((q, i) => `${i + 1}. ${q.header ? `${q.header}: ` : ''}${q.question ?? q.title ?? ''}`).join('\n'), key: `question:${tid}:${request.id}` });
    } else if (/approval/i.test(method)) events.push({ tid, kind: 'approval', requestId: request.id, text: textOf(request.params) || 'Codex запрашивает подтверждение.', key: `approval:${tid}:${request.id}` });
  }
  const turns = turnsOf(state);
  for (const turn of recentTurns ? turns.slice(-recentTurns) : turns) {
    const turnId = turn.turnId ?? turn.id ?? String(turn.turnStartedAtMs ?? 'turn');
    const status = String(turn.status ?? '').toLowerCase();
    const agentMessages = (turn.items ?? []).filter(item => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim());
    const lastAgentMessage = agentMessages.at(-1);
    const finalText = textOf(turn.finalResponse ?? turn.finalOutput ?? turn.response ?? turn.output ?? lastAgentMessage?.text);
    const errorText = textOf(turn.error);
    if (errorText) events.push({ tid, turnId, kind: 'error', text: errorText, key: `${tid}:turn:${turnId}`, startedAt: turn.turnStartedAtMs });
    else if (['completed','complete','succeeded','success'].includes(status) && finalText) events.push({ tid, turnId, kind: 'final', text: cleanNotificationText(finalText), key: `${tid}:turn:${turnId}`, startedAt: turn.turnStartedAtMs });
    else if (includeProgress) {
      const progress = textOf(turn.progress ?? turn.lastAssistantMessage ?? lastAgentMessage?.text);
      if (progress) events.push({ tid, turnId, kind: 'progress', text: progress, key: `progress:${tid}:${turnId}`, startedAt: turn.turnStartedAtMs });
    }
    for (const item of agentMessages) if (Array.isArray(item.questions) && item.questions.length) {
      const questions = item.questions.map(question => ({ ...question, title: question.title ?? question.question ?? '' }));
      events.push({ tid, turnId, kind: 'async_question', itemId: item.id, questions, text: item.text, key: `${tid}:async-question:${item.id}`, startedAt: turn.turnStartedAtMs });
    }
  }
  return events;
}
