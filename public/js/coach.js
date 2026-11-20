// The AI coach, as the app's Coach tab. Same /api/chat agent and stream protocol as before.
// The conversation lives in memory for the session: switching tabs keeps it, reloading clears it.

const chat = { history: [], busy: false, mounted: null };

function renderMarkdown(src) {
  const esc = src.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/^#{1,4}\s*/, '');
  const out = [];
  let list = null;
  for (const line of esc.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (m) { (list ||= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

async function readCoachStream(body, { onStep, onDelta } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line.slice(6)); } catch { continue; }
      if (obj.type === 'step') onStep?.(obj.label);
      else if (obj.type === 'delta') onDelta?.(obj.text);
      else if (obj.type === 'reply' || obj.type === 'error' || obj.type === 'paused') answer = obj;
    }
  }
  return answer;
}

// Mounts (or re-attaches) the chat UI inside `root`. `mode` is 'demo' or 'live'.
export function mountCoach(root, mode, { suggestions = [], prefill = '' } = {}) {
  if (chat.mounted && chat.mounted.mode === mode) {
    root.replaceChildren(chat.mounted.node);
    if (prefill) { chat.mounted.input.value = prefill; chat.mounted.input.focus(); }
    return;
  }
  const node = document.createElement('div');
  node.className = 'coach';
  node.innerHTML = `
    <div class="chat-log" role="log" aria-live="polite" aria-label="Conversation with the coach"></div>
    <div class="chat-chips" role="group" aria-label="Suggested questions"></div>
    <form class="chat-form">
      <label class="sr" for="chat-text">Message the coach</label>
      <textarea id="chat-text" rows="1" maxlength="1200" placeholder="Ask about a run, the plan, how you feel…"></textarea>
      <button class="btn" type="submit" aria-label="Send">Send</button>
    </form>
    <p class="chat-foot">Answers use only numbers found in your runs. Not medical advice.</p>`;
  const log = node.querySelector('.chat-log');
  const input = node.querySelector('textarea');
  const sendBtn = node.querySelector('button[type=submit]');
  const chips = node.querySelector('.chat-chips');

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const addMsg = (role, text, isError = false) => {
    const div = document.createElement('div');
    div.className = `msg ${role}${isError ? ' error' : ''}`;
    if (role === 'assistant' && !isError) div.innerHTML = renderMarkdown(text); else div.textContent = text;
    log.appendChild(div); scroll(); return div;
  };
  const addTyping = () => { const d = document.createElement('div'); d.className = 'msg assistant typing'; d.innerHTML = '<i></i><i></i><i></i>'; log.appendChild(d); scroll(); return d; };
  const addSteps = () => {
    const div = document.createElement('div'); div.className = 'msg steps'; div.hidden = true; log.appendChild(div);
    return {
      add(label) { const l = document.createElement('div'); l.textContent = label; div.appendChild(l); div.hidden = false; scroll(); },
      finish() { div.classList.add('done'); },
      remove() { div.remove(); },
    };
  };

  async function send(text) {
    text = (text || '').trim();
    if (!text || chat.busy) return;
    chat.busy = true; sendBtn.disabled = true;
    input.value = ''; input.style.height = 'auto';
    chips.hidden = true;
    addMsg('user', text);
    chat.history.push({ role: 'user', content: text });
    const typing = addTyping();
    const steps = addSteps();
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        body: JSON.stringify({ source: mode, messages: chat.history }),
      });
      const isStream = (r.headers.get('content-type') || '').includes('text/event-stream') && r.body;
      let answerText = '';
      if (!r.ok || !isStream) {
        const data = await r.json().catch(() => ({}));
        typing.remove();
        if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
        (data.steps || []).forEach((l) => steps.add(l));
        answerText = data.reply || '';
        if (!answerText.trim()) throw new Error('The coach did not return an answer. Please try again.');
        steps.finish();
        addMsg('assistant', answerText);
      } else {
        let bubble = null; let acc = '';
        const answer = await readCoachStream(r.body, {
          onStep: (l) => steps.add(l),
          onDelta: (t) => { typing.remove(); acc += t; bubble ||= addMsg('assistant', ''); bubble.innerHTML = renderMarkdown(acc); scroll(); },
        });
        typing.remove();
        if (answer.error) { if (bubble) bubble.remove(); throw new Error(answer.error); }
        answerText = answer.text || '';
        if (!answerText.trim()) { if (bubble) bubble.remove(); throw new Error('The coach did not return an answer. Please try again.'); }
        steps.finish();
        if (bubble) bubble.innerHTML = renderMarkdown(answerText); else addMsg('assistant', answerText);
      }
      chat.history.push({ role: 'assistant', content: answerText });
    } catch (e) {
      typing.remove(); steps.remove();
      chat.history.pop(); // keep the history a clean alternation for the retry
      input.value = text;
      addMsg('assistant', e.message, true);
    } finally {
      chat.busy = false; sendBtn.disabled = false; input.focus();
    }
  }

  addMsg('assistant', mode === 'demo'
    ? "I'm the demo runner's coach. I can see their last weeks of runs: load, easy share, climbing speed, aerobic engine. Ask me anything, or describe a session as if it were yours."
    : 'Connected to your Strava runs. Tell me about a session ("heavy legs this morning…") or ask about the plan.');
  for (const q of suggestions) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip-q'; b.textContent = q;
    b.addEventListener('click', () => send(q)); chips.appendChild(b);
  }
  node.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; });
  if (prefill) input.value = prefill;

  chat.mounted = { mode, node, input };
  root.replaceChildren(node);
}
