const SYS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const CC_ENVELOPE = /<\/?(command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook|stdin)[^>]*>/gi;

function sanitize(s) {
  if (typeof s !== 'string' || !s) return s || '';
  return s.replace(SYS_REMINDER, '').replace(CC_ENVELOPE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function textOf(b) {
  let raw = '';
  if (typeof b.text === 'string') raw = b.text;
  else if (typeof b.content === 'string') raw = b.content;
  else if (Array.isArray(b.content)) raw = b.content.map(c => c?.text || '').join('');
  return sanitize(raw);
}

function groupBySession(events) {
  const m = new Map();
  for (const ev of events) {
    const sid = ev.conversation?.id || 'unknown';
    if (!m.has(sid)) m.set(sid, []);
    m.get(sid).push(ev);
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return m;
}

function buildMessagesForSession(evs) {
  const messages = [];
  let cur = null;
  const flush = () => { if (cur && (cur.content || (cur.tool_calls && cur.tool_calls.length))) messages.push(cur); cur = null; };
  for (const ev of evs) {
    const b = ev.block || {};
    const t = b.type;
    if (ev.role === 'user') {
      if (t === 'tool_result') {
        flush();
        const txt = textOf(b);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: txt });
        continue;
      }
      if (t === 'text' && !b.isMeta) {
        const txt = textOf(b);
        if (!txt.trim()) continue;
        if (cur && cur.role === 'user') cur.content += '\n' + txt;
        else { flush(); cur = { role: 'user', content: txt }; }
      }
      continue;
    }
    if (ev.role === 'assistant') {
      if (!cur || cur.role !== 'assistant') { flush(); cur = { role: 'assistant', content: '' }; }
      if (t === 'text') {
        const txt = textOf(b);
        if (txt) cur.content = cur.content ? cur.content + '\n' + txt : txt;
      } else if (t === 'thinking') {
        continue;
      } else if (t === 'tool_use') {
        if (!cur.tool_calls) cur.tool_calls = [];
        cur.tool_calls.push({
          id: b.id || '',
          type: 'function',
          function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) },
        });
      }
      continue;
    }
  }
  flush();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && !m.content) m.content = null;
  }
  return messages;
}

function hasTrainingValue(messages) {
  let hasUser = false, hasAsst = false;
  for (const m of messages) {
    if (m.role === 'user') hasUser = true;
    if (m.role === 'assistant') hasAsst = true;
  }
  return hasUser && hasAsst;
}

export function toUnslothMessages(events) {
  const sessions = groupBySession(events);
  const out = [];
  for (const [sid, evs] of sessions) {
    const messages = buildMessagesForSession(evs);
    if (!hasTrainingValue(messages)) continue;
    out.push({ session_id: sid, messages });
  }
  return out;
}

export function toShareGPT(events) {
  const sessions = groupBySession(events);
  const out = [];
  for (const [sid, evs] of sessions) {
    const messages = buildMessagesForSession(evs);
    if (!hasTrainingValue(messages)) continue;
    const conversations = [];
    for (const m of messages) {
      if (m.role === 'user') conversations.push({ from: 'human', value: m.content });
      else if (m.role === 'assistant') {
        let v = m.content || '';
        if (m.tool_calls && m.tool_calls.length) {
          const calls = m.tool_calls.map(c => `<tool_call>${c.function.name}(${c.function.arguments})</tool_call>`).join('\n');
          v = v ? v + '\n' + calls : calls;
        }
        conversations.push({ from: 'gpt', value: v });
      } else if (m.role === 'tool') {
        conversations.push({ from: 'tool', value: m.content });
      }
    }
    out.push({ session_id: sid, conversations });
  }
  return out;
}
