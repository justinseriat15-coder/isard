// Trail.AI app: Today, Plan, Progress, Coach.
// Demo runs entirely in the browser (fictional runner, nothing saved).
// Live mode reads and writes the plan through /api/plan; the server re-checks every change.
import {
  validateConfig, generatePlan, applyLog, canMove, sessionOn, weekOf, isRunType,
  addDays, weekday, isoDate, mondayOf, daysBetween, demoConfig, demoLog, EFFORT, DAY_NAMES, DAY_LONG,
} from './plan.js';
import { loadWatch, watchMetrics } from './watch.js';
import { mountCoach } from './coach.js';

const $ = (id) => document.getElementById(id);
const TODAY = isoDate();
const state = { mode: 'demo', config: null, log: { done: {}, moves: {} }, plan: null, weekIdx: 0, expanded: null };

// ---------- tiny DOM helper: never innerHTML with data ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// ---------- formatting ----------
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `${m} min`);
const fmtHours = (m) => fmtMin(Math.round(m / 5) * 5 || 0);
const dayLabel = (d) => `${DAY_LONG[weekday(d)]} ${Number(d.slice(8))} ${new Date(`${d}T12:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
const PHASE = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper' };
function sessionHeadline(s) {
  if (s.type === 'race') return s.title;
  if (s.type === 'rest') return 'Rest';
  if (s.type === 'strength') return `Strength · ${fmtMin(s.minutes)}`;
  if (s.type === 'hills') return `Hills · ${fmtMin(s.minutes)}`;
  return `${fmtMin(s.minutes)} ${s.type === 'long' ? 'on trail' : s.type === 'steady' ? 'steady' : 'easy'}`;
}
function togo() {
  const d = daysBetween(TODAY, state.config.race.date);
  if (d < 0) return null;
  if (d === 0) return { n: 'Today', unit: 'race day' };
  if (d < 14) return { n: d, unit: d === 1 ? 'day to go' : 'days to go' };
  return { n: Math.floor(d / 7), unit: 'weeks to go' };
}
function statusOf(s) {
  if (s.done) return 'done';
  if (s.type === 'rest') return 'rest';
  if (s.date < TODAY) return 'missed';
  return 'planned';
}
function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}


const OK_SVG = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<circle class="ok-dot" cx="10" cy="10" r="10"/><path class="ok-tick" d="M6 10.4 8.8 13 14 7.4"/>'; return s; };
const TICK_SVG = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M2.8 6.3 5 8.5 9.3 3.8"/>'; return s; };
const clock = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
// A plausible elevation profile, stable per date (illustrative, not a real route).
function routeSvg(seed, hilly) {
  let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const a = 0.6 + rnd() * 0.8; const b = rnd() * 6; const amp = hilly ? 1 : 0.45;
  const pts = []; for (let i = 0; i <= 60; i++) {
    const y = 30 - amp * (13 * Math.sin(i / (8 * a) + b) + 7 * Math.sin(i / 3.1 + b * 2)) - 2 * Math.sin(i / 1.3) + (rnd() - 0.5) * 1.6;
    pts.push(`${(i * 5).toFixed(1)} ${Math.max(4, Math.min(52, y)).toFixed(1)}`); }
  const d = `M${pts.join(' L')}`;
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'route'); s.setAttribute('viewBox', '0 0 300 56'); s.setAttribute('preserveAspectRatio', 'none'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path class="rf" d="${d} L300 56 L0 56Z"/><path class="rl" d="${d}"/>`;
  return s;
}

// ---------- data ----------
async function api(method, body) {
  const r = await fetch('/api/plan', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: r.status });
  return data;
}

function rebuild() {
  state.plan = state.config ? applyLog(generatePlan(state.config), state.log) : null;
}

async function act(body) {
  if (state.mode === 'demo') {
    const next = { done: { ...state.log.done }, moves: { ...state.log.moves } };
    if (body.action === 'done') next.done[body.date] = { minutes: body.minutes, feel: body.feel };
    if (body.action === 'undo') delete next.done[body.date];
    if (body.action === 'move') {
      const c = canMove(state.plan, body.date, body.to);
      if (!c.ok) throw new Error(c.reason);
      next.moves[body.date] = body.to;
    }
    if (body.action === 'unmove') delete next.moves[body.date];
    state.log = next;
  } else {
    const data = await api('POST', body);
    state.log = data.log;
  }
  rebuild();
  render();
}

// ---------- sheet (dialog) ----------
let lastFocus = null;
function openSheet(content) {
  lastFocus = document.activeElement;
  const sheet = $('sheet');
  sheet.replaceChildren(content);
  sheet.hidden = false; $('sheet-back').hidden = false;
  const f = sheet.querySelector('button, input, [tabindex]');
  if (f) f.focus();
}
function closeSheet() {
  $('sheet').hidden = true; $('sheet-back').hidden = true;
  if (lastFocus) lastFocus.focus();
}
$('sheet-back').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

function doneSheet(s) {
  const minutes = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '1440', value: String(s.minutes || 30), id: 'f-min', required: true });
  const feel = h('div', { class: 'feel', role: 'radiogroup', 'aria-label': 'How did it feel?' },
    ...[['easy', 'Easy'], ['ok', 'About right'], ['hard', 'Hard']].map(([v, l]) =>
      h('label', {}, h('input', { type: 'radio', name: 'feel', value: v, checked: v === 'ok' }), h('span', {}, l))));
  const err = h('p', { class: 'form-err', role: 'alert' });
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const m = Math.round(Number(minutes.value));
    if (!(m >= 1 && m <= 1440)) { err.textContent = 'Minutes must be between 1 and 1440.'; return; }
    try { await act({ action: 'done', date: s.originalDate, minutes: m, feel: form.querySelector('input[name=feel]:checked').value }); closeSheet(); toast('Logged. Nice work.'); }
    catch (x) { err.textContent = x.message; }
  } },
  h('div', {}, h('p', { class: 'label muted' }, dayLabel(s.date)), h('h2', { class: 'display', id: 'sheet-title' }, `Log ${s.title.toLowerCase()}`)),
  h('label', { class: 'field' }, h('span', {}, 'Minutes'), minutes),
  h('div', { class: 'field' }, h('span', {}, 'How did it feel?'), feel),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save'), h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'Cancel')));
  openSheet(form);
}

function moveSheet(s) {
  const week = weekOf(state.plan, s.date);
  const list = h('div', { class: 'choice' });
  for (let d = 0; d < 7; d++) {
    const to = addDays(week.start, d);
    if (to === s.date) continue;
    const c = canMove(state.plan, s.originalDate, to);
    list.append(h('button', {
      type: 'button', class: c.ok ? 'ok' : '', 'aria-disabled': c.ok ? null : 'true',
      onclick: async () => {
        if (!c.ok) return;
        try { await act({ action: 'move', date: s.originalDate, to }); closeSheet(); toast(`Moved to ${DAY_LONG[weekday(to)]}.`); }
        catch (x) { toast(x.message); }
      },
    }, h('b', {}, `${DAY_NAMES[d]} ${Number(to.slice(8))}`), h('span', {}, c.reason)));
  }
  const extra = s.moved ? h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await act({ action: 'unmove', date: s.originalDate }); closeSheet(); toast('Back to its original day.'); } }, 'Put it back') : null;
  openSheet(h('div', {},
    h('p', { class: 'label muted' }, `Move ${s.title.toLowerCase()}`),
    h('h2', { class: 'display', id: 'sheet-title' }, 'Which day?'),
    h('p', { class: 'sub' }, 'Only days that keep your rules can be picked.'),
    list,
    h('div', { class: 'actions' }, extra, h('button', { class: 'btn ghost small', type: 'button', onclick: closeSheet }, 'Cancel'))));
}

// ---------- pieces ----------
function effortRow(s) {
  const e = EFFORT[s.effort];
  if (!e || !e.bars) return h('div', { class: 'effort' }, h('b', {}, e?.label || ''), h('span', {}, e?.words || ''));
  return h('div', { class: 'effort' },
    h('span', { class: 'bars', 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5].map((i) => h('u', { class: i <= e.bars ? '' : 'o' }))),
    h('b', {}, e.label), h('span', {}, e.words));
}

function sessionActions(s, { onLight = false } = {}) {
  const st = statusOf(s);
  if (s.type === 'rest') return null;
  if (s.done) {
    return h('div', { class: 'done-line' }, OK_SVG(),
      `Done · ${fmtMin(s.done.minutes)} · felt ${s.done.feel === 'ok' ? 'about right' : s.done.feel}`,
      h('button', { type: 'button', onclick: () => act({ action: 'undo', date: s.originalDate }) }, 'Undo'));
  }
  const canAct = s.date <= addDays(TODAY, 0) || true;
  return h('div', { class: 'actions' },
    canAct && s.type !== 'race' ? h('button', { class: 'btn grow', type: 'button', onclick: () => doneSheet(s) }, st === 'missed' ? 'Log it anyway' : 'Mark as done') : null,
    s.type !== 'race' ? h('button', { class: `btn ghost${onLight ? '' : ''}`, type: 'button', onclick: () => moveSheet(s) }, 'Move') : null);
}

function sessionCard(s, week) {
  const runLike = isRunType(s.type);
  const tag = s.type === 'long' ? 'Long run' : s.type === 'race' ? 'Race day' : s.title;
  const head = runLike && s.minutes
    ? h('div', { class: 'big-time' }, h('b', { id: 'today-title' }, clock(s.minutes)), h('span', {}, s.minutes >= 60 ? 'hours' : 'minutes', h('br'), s.type === 'long' ? 'on trail' : EFFORT[s.effort]?.label.toLowerCase()))
    : h('h2', { class: 'display', id: 'today-title' }, sessionHeadline(s));
  const meta = [];
  if (s.type === 'race') meta.push(h('span', {}, h('b', {}, String(state.config.race.km)), ' km'), h('span', {}, h('b', {}, state.config.race.dplus.toLocaleString('en-GB')), ' m D+'));
  return h('article', { class: 'card', 'aria-labelledby': 'today-title' },
    h('div', { class: 'k' }, h('span', { class: `chip${runLike ? '' : ' calm'}` }, tag), h('span', { class: 'label' }, `Week ${week.number} · ${PHASE[week.phase]}`)),
    head,
    runLike && s.type !== 'race' ? routeSvg(s.originalDate, s.type === 'long' || s.type === 'hills') : null,
    meta.length ? h('div', { class: 'meta' }, ...meta) : null,
    s.detail && s.type !== 'race' ? h('p', { class: 'detail' }, s.detail) : null,
    s.type !== 'rest' ? effortRow(s) : null,
    s.why ? h('p', { class: 'why' }, s.why) : null);
}

function weekStrip(week) {
  return h('div', { class: 'wstrip', role: 'list', 'aria-label': 'This week' }, ...week.sessions.map((s) => {
    const st = statusOf(s);
    const cls = ['wd', isRunType(s.type) ? 'run' : '', s.type === 'rest' ? 'rest' : '', st === 'done' ? 'done' : '', st === 'missed' ? 'missed' : '', s.date === TODAY ? 'today' : ''].join(' ');
    return h('span', { class: cls, role: 'listitem', 'aria-label': `${DAY_LONG[weekday(s.date)]}: ${s.title}${st === 'done' ? ', done' : st === 'missed' ? ', missed' : ''}` },
      h('em', {}, DAY_NAMES[weekday(s.date)][0]), h('i', {}, st === 'done' ? TICK_SVG() : null));
  }));
}

// ---------- views ----------
function viewToday() {
  const hit = sessionOn(state.plan, TODAY);
  const el = $('view-today');
  el.replaceChildren();
  const t = togo();
  if (!hit) {
    const before = TODAY < state.plan.weeks[0].start;
    el.append(h('div', { class: 'view-head' }, h('h1', { class: 'display', id: 'h-today' }, before ? 'Not yet' : 'Season done')),
      h('p', { class: 'coach-intro' }, before ? `Your plan starts on ${dayLabel(state.plan.weeks[0].start)}.` : 'Race day is behind you. Set a new goal in Plan.'));
    return;
  }
  const { week, session } = hit;
  el.append(h('div', { class: 'view-head' },
    h('div', {}, h('p', { class: 'label kick' }, `${DAY_LONG[weekday(TODAY)]} · Week ${week.number} of ${state.plan.totalWeeks} · ${PHASE[week.phase]}${week.recovery ? ' · lighter week' : ''}`),
      h('h1', { class: 'display', id: 'h-today' }, 'Today')),
    t ? h('div', { class: 'togo' }, h('b', { class: 'num' }, String(t.n)), h('span', { class: 'label' }, `${t.unit} · ${state.config.race.name}`)) : null));

  const tomorrow = sessionOn(state.plan, addDays(TODAY, 1));
  const runs = week.sessions.filter((s) => isRunType(s.type));
  const planned = runs.reduce((a, s) => a + s.minutes, 0);
  const done = week.sessions.reduce((a, s) => a + (s.done?.minutes && isRunType(s.type) ? s.done.minutes : 0), 0);
  const nextKey = state.plan.weeks.flatMap((w) => w.sessions).find((s) => s.date > TODAY && (s.type === 'long' || s.type === 'race'));

  const pct = Math.min(100, Math.round((done / Math.max(planned, 1)) * 100));
  el.append(h('div', { class: 'grid2' },
    h('div', { class: 'today-col' }, sessionCard(session, week), sessionActions(session)),
    h('div', { class: 'stack' },
      h('a', { class: 'panel', href: '#plan' },
        h('h3', {}, h('span', {}, 'This week'), h('span', {}, `${fmtHours(done)} / ${fmtHours(planned)}`)),
        weekStrip(week),
        h('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% of the week's running done` }, h('i', { style: `width:${pct}%` }))),
      h('div', { class: 'pair' },
        tomorrow ? h('div', { class: 'panel' }, h('h3', {}, 'Tomorrow'), h('p', { class: 'big num' }, tomorrow.session.type === 'rest' ? 'Rest' : sessionHeadline(tomorrow.session)), h('p', {}, tomorrow.session.type === 'rest' ? 'Recovery counts.' : EFFORT[tomorrow.session.effort]?.words || '')) : null,
        nextKey ? h('div', { class: 'panel' }, h('h3', {}, 'Next key'), h('p', { class: 'big num' }, `${DAY_NAMES[weekday(nextKey.date)]} · ${nextKey.type === 'race' ? 'Race' : clock(nextKey.minutes)}`), h('p', {}, dayLabel(nextKey.date))) : null))));
}

function seasonStrip(currentIdx) {
  const ph = state.plan.weeks.map((w) => w.phase);
  const groups = [];
  ph.forEach((p, i) => { if (!groups.length || groups.at(-1).p !== p) groups.push({ p, n: 0, i }); groups.at(-1).n++; });
  const total = ph.length;
  const strip = h('div', { class: 'season', role: 'img', 'aria-label': `Season: ${groups.map((g) => `${PHASE[g.p]} ${g.n} weeks`).join(', ')}. Showing week ${currentIdx + 1}.` },
    ...groups.map((g) => h('span', { class: g.p, style: `flex:${g.n} 1 0;min-width:0` }, PHASE[g.p])),
    h('i', { class: 'here', style: `left:calc(4px + (100% - 8px) * ${((currentIdx + 0.5) / total).toFixed(4)} - 1.5px)` }));
  return strip;
}

function viewPlan() {
  const el = $('view-plan');
  el.replaceChildren();
  const week = state.plan.weeks[state.weekIdx];
  const runMin = week.sessions.filter((s) => isRunType(s.type)).reduce((a, s) => a + s.minutes, 0);
  el.append(h('div', { class: 'view-head' },
    h('div', {}, h('p', { class: 'label kick' }, `${state.config.race.name} · ${state.config.race.km} km · ${state.config.race.dplus.toLocaleString('en-GB')} m D+`),
      h('h1', { class: 'display', id: 'h-plan' }, `Week ${week.number}`)),
    h('div', { class: 'weeknav' },
      h('button', { type: 'button', 'aria-label': 'Previous week', disabled: state.weekIdx === 0, onclick: () => { state.weekIdx--; state.expanded = null; render(); } }, '←'),
      h('span', { class: 'label' }, `${PHASE[week.phase]}${week.recovery ? ' · lighter' : ''} · ${fmtHours(runMin)}`),
      h('button', { type: 'button', 'aria-label': 'Next week', disabled: state.weekIdx === state.plan.weeks.length - 1, onclick: () => { state.weekIdx++; state.expanded = null; render(); } }, '→'))));
  el.append(seasonStrip(state.weekIdx));

  const list = h('ul', { class: 'week' });
  for (const s of week.sessions) {
    const st = statusOf(s);
    const cls = ['day', isRunType(s.type) ? 'run' : '', s.type === 'strength' ? 'str' : '', s.type === 'rest' ? 'rest' : '', `is-${st}`, s.date === TODAY ? 'is-today' : '', state.expanded === s.date ? 'expanded' : ''].join(' ');
    const stLabel = st === 'done' ? '' : st === 'missed' ? 'Missed' : s.date === TODAY ? 'Today' : s.type === 'rest' ? '' : fmtMin(s.minutes || 0);
    const id = `d-${s.date}`;
    list.append(h('li', { class: cls },
      h('button', { type: 'button', 'aria-expanded': state.expanded === s.date ? 'true' : 'false', 'aria-controls': id, onclick: () => { state.expanded = state.expanded === s.date ? null : s.date; render(); } },
        h('span', { class: 'dn' }, DAY_NAMES[weekday(s.date)], h('em', {}, String(Number(s.date.slice(8))))),
        h('span', { class: 's' }, s.title, s.moved ? h('span', { class: 'moved-tag' }, 'Moved') : null, h('small', {}, s.type === 'rest' ? (s.why || 'Rest') : `${s.detail || EFFORT[s.effort]?.words || ''}`)),
        h('span', { class: 'st' }, st === 'done' ? OK_SVG() : stLabel)),
      h('div', { class: 'open', id },
        s.type !== 'rest' ? effortRow(s) : null,
        s.why ? h('p', { class: 'why' }, s.why) : null,
        sessionActions(s))));
  }
  el.append(list);
  el.append(h('div', { class: 'actions' },
    state.weekIdx !== (weekOf(state.plan, TODAY)?.index ?? -1) && weekOf(state.plan, TODAY) ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => { state.weekIdx = weekOf(state.plan, TODAY).index; render(); } }, 'Back to this week') : null,
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => { location.hash = '#setup'; } }, state.mode === 'demo' ? 'Try it with your own race' : 'Edit goal and days')));
}

function viewProgress() {
  const el = $('view-progress');
  el.replaceChildren();
  const all = state.plan.weeks.flatMap((w) => w.sessions);
  const past = all.filter((s) => s.date < TODAY && s.type !== 'rest');
  const doneCount = past.filter((s) => s.done).length + all.filter((s) => s.date >= TODAY && s.done).length;
  const rate = past.length ? Math.round((past.filter((s) => s.done).length / past.length) * 100) : null;
  const longest = all.filter((s) => s.type === 'long' && s.done).reduce((m, s) => Math.max(m, s.done.minutes), 0);
  const easyFeel = all.filter((s) => s.done && s.effort === 'easy');
  const felt = easyFeel.length ? Math.round((easyFeel.filter((s) => s.done.feel !== 'hard').length / easyFeel.length) * 100) : null;
  const t = togo();

  el.append(h('div', { class: 'view-head' }, h('div', {}, h('p', { class: 'label kick' }, `Week ${(weekOf(state.plan, TODAY)?.number) || '—'} of ${state.plan.totalWeeks}`), h('h1', { class: 'display', id: 'h-progress' }, 'Progress'))));
  el.append(h('div', { class: 'stats' },
    h('div', {}, h('span', { class: 'label' }, 'Sessions done'), h('b', { class: 'num' }, String(doneCount)), h('em', {}, rate == null ? 'Nothing due yet' : `${rate}% of what was due`)),
    h('div', {}, h('span', { class: 'label' }, 'Longest run'), h('b', { class: 'num' }, longest ? fmtMin(longest) : '—'), h('em', {}, `Peak planned: ${fmtMin(state.plan.targets.longPeak)}`)),
    h('div', {}, h('span', { class: 'label' }, 'Easy felt easy'), h('b', { class: `num${felt != null && felt >= 75 ? ' ok' : ''}` }, felt == null ? '—' : `${felt}%`), h('em', {}, 'Of easy sessions, by how they felt')),
    h('div', {}, h('span', { class: 'label' }, 'To go'), h('b', { class: 'num' }, t ? String(t.n) : '—'), h('em', {}, t ? t.unit : 'Race done'))));

  // Planned vs done, running hours per week, from week 1 to four weeks ahead.
  const cur = weekOf(state.plan, TODAY)?.index ?? state.plan.weeks.length - 1;
  const ws = state.plan.weeks.slice(Math.max(0, cur - 11), Math.min(state.plan.weeks.length, cur + 5));
  const maxM = Math.max(...ws.map((w) => w.sessions.filter((s) => isRunType(s.type)).reduce((a, s) => a + s.minutes, 0)), 60);
  const W = 640; const H = 200; const bw = W / ws.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Running hours per week: planned outline, done filled.');
  ws.forEach((w, i) => {
    const plan = w.sessions.filter((s) => isRunType(s.type)).reduce((a, s) => a + s.minutes, 0);
    const done = w.sessions.reduce((a, s) => a + (s.done && isRunType(s.type) ? s.done.minutes : 0), 0);
    const x = i * bw + bw * 0.18; const wd = bw * 0.64;
    const ph = (plan / maxM) * (H - 24); const dh = (Math.min(done, maxM) / maxM) * (H - 24);
    const r1 = document.createElementNS(ns, 'rect');
    Object.entries({ x, y: H - 18 - ph, width: wd, height: ph, fill: 'none', stroke: w.index > cur ? 'rgba(17,17,16,.18)' : 'rgba(17,17,16,.35)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }).forEach(([k, v]) => r1.setAttribute(k, v));
    svg.append(r1);
    if (done) {
      const r2 = document.createElementNS(ns, 'rect');
      Object.entries({ x, y: H - 18 - dh, width: wd, height: dh, fill: w.index === cur ? '#F0602F' : '#3C7A4D' }).forEach(([k, v]) => r2.setAttribute(k, v));
      svg.append(r2);
    }
    const tx = document.createElementNS(ns, 'text');
    Object.entries({ x: x + wd / 2, y: H - 4, 'text-anchor': 'middle', fill: '#6E6A62', 'font-size': 10, 'font-family': '-apple-system, Inter, sans-serif' }).forEach(([k, v]) => tx.setAttribute(k, v));
    tx.textContent = String(w.number);
    svg.append(tx);
  });
  el.append(h('div', { class: 'chart' }, h('p', { class: 'label' }, 'Running hours per week'), svg,
    h('div', { class: 'legend label' }, h('span', {}, h('i', { style: 'box-shadow:inset 0 0 0 1px rgba(17,17,16,.35)' }), 'Planned'), h('span', {}, h('i', { style: 'background:#3C7A4D' }), 'Done'), h('span', {}, h('i', { style: 'background:#F0602F' }), 'This week'))));

  const watch = h('section', { class: 'watch', 'aria-labelledby': 'h-watch' },
    h('div', { class: 'sec-head' }, h('h2', { id: 'h-watch' }, 'From your watch'), h('span', { class: 'label' }, state.mode === 'demo' ? 'Demo runner · Strava data' : 'Strava')),
    h('p', { class: 'loading' }, 'Reading your runs…'));
  el.append(watch);
  loadWatch(state.mode).then((data) => {
    const m = watchMetrics(data);
    watch.querySelector('.loading').remove();
    watch.append(
      h('div', { class: 'wtiles' }, ...m.tiles.map((x) => h('div', { class: `wtile${x.tone ? ` t-${x.tone}` : ''}` },
        h('span', {}, x.k), h('b', {}, x.v), h('em', {}, x.sub), x.note ? h('p', {}, x.note) : null))),
      h('div', { class: 'runs' }, h('h3', {}, 'Recent runs'),
        h('ul', {}, ...m.recent.map((r) => h('li', {},
          h('span', { class: 'r-date' }, r.date), h('span', { class: 'r-name' }, r.name),
          h('span', { class: 'r-n' }, r.dist), h('span', { class: 'r-n' }, r.time), h('span', { class: 'r-n hide-s' }, r.dplus), h('span', { class: 'r-n hide-s' }, r.pace))))),
      h('a', { class: 'linkout', href: '#coach', onclick: () => { state.coachPrefill = 'Look at my last week of runs: what stands out, and what should I change?'; } },
        h('div', {}, h('b', {}, 'Ask the coach'), h('span', {}, 'It reads these runs and only quotes numbers it can find in them.')),
        h('span', { class: 'arr', 'aria-hidden': 'true' }, '→')));
  }).catch((e) => { watch.querySelector('.loading').textContent = `Could not load your runs: ${e.message}`; });
  if (state.mode === 'live') el.append(h('div', { class: 'actions' }, h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/'; } }, 'Disconnect Strava')));
}

function viewCoach() {
  const el = $('view-coach');
  if (el.dataset.ready !== state.mode) {
    el.replaceChildren(
      h('div', { class: 'view-head' }, h('div', {}, h('p', { class: 'label kick' }, 'AI coach · grounded in your runs'), h('h1', { class: 'display', id: 'h-coach' }, 'Coach'))),
      h('div', { id: 'coach-root' }));
    el.dataset.ready = state.mode;
  }
  const asks = ['Am I on track for race day?', 'Was my last long run too easy or too hard?', 'Why is my easy share below target?', 'My left knee feels tight. What should I change?'];
  mountCoach($('coach-root'), state.mode, { suggestions: asks, prefill: state.coachPrefill || '' });
  state.coachPrefill = '';
}

function viewSetup() {
  const el = $('view-setup');
  el.replaceChildren();
  const c = state.config || {
    race: { name: '', date: '', km: '', dplus: '' }, start: mondayOf(TODAY), runDays: [1, 3, 5], longRunDay: 5, strengthDays: [0, 4], noBackToBack: true, currentHours: 3,
  };
  const dayBoxes = (name, sel) => h('div', { class: 'days' }, ...DAY_NAMES.map((d, i) => h('label', {}, h('input', { type: 'checkbox', name, value: String(i), checked: sel.includes(i), 'aria-label': DAY_LONG[i] }), h('span', { 'aria-hidden': 'true' }, d))));
  const input = (name, attrs) => h('input', { name, ...attrs });
  const err = h('p', { class: 'form-err', role: 'alert' });
  const form = h('form', { class: 'form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const cfg = {
      race: { name: f.get('name'), date: f.get('date'), km: Number(f.get('km')), dplus: Number(f.get('dplus') || 0) },
      start: f.get('start'), runDays: f.getAll('run').map(Number), longRunDay: Number(f.get('long')),
      strengthDays: f.getAll('strength').map(Number), noBackToBack: f.get('rule') === 'on', currentHours: Number(f.get('hours')),
    };
    const v = validateConfig(cfg);
    if (v.errors.length) { err.textContent = v.errors[0]; return; }
    try {
      const data = state.mode === 'demo' ? { config: v.config, log: { done: {}, moves: {} } } : await api('PUT', { config: v.config });
      state.config = data.config; state.log = data.log || { done: {}, moves: {} };
      rebuild(); state.weekIdx = weekOf(state.plan, TODAY)?.index ?? 0;
      location.hash = '#today'; toast('Plan ready.');
    } catch (x) { err.textContent = x.message; }
  } },
  h('fieldset', { class: 'form' },
    h('legend', {}, 'The race'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), input('name', { value: c.race.name, placeholder: 'Ultra Marin', maxlength: '80' })),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', {}, 'Date'), input('date', { type: 'date', value: c.race.date, required: true })),
      h('label', { class: 'field' }, h('span', {}, 'Start training'), input('start', { type: 'date', value: c.start, required: true }))),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', {}, 'Distance, km'), input('km', { type: 'number', inputmode: 'decimal', min: '5', max: '400', value: String(c.race.km), required: true })),
      h('label', { class: 'field' }, h('span', {}, 'Climbing, m'), input('dplus', { type: 'number', inputmode: 'numeric', min: '0', max: '30000', value: String(c.race.dplus) })))),
  h('fieldset', { class: 'form' },
    h('legend', {}, 'Your week'),
    h('div', { class: 'field' }, h('span', {}, 'Days you can run'), dayBoxes('run', c.runDays)),
    h('label', { class: 'field' }, h('span', {}, 'Long run on'), h('select', { name: 'long' }, ...DAY_LONG.map((d, i) => h('option', { value: String(i), selected: i === c.longRunDay }, d)))),
    h('div', { class: 'field' }, h('span', {}, 'Leg strength on'), dayBoxes('strength', c.strengthDays)),
    h('label', { class: 'field' }, h('span', {}, 'Running now, hours a week'), input('hours', { type: 'number', inputmode: 'decimal', step: '0.5', min: '0', max: '25', value: String(c.currentHours) })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'rule', checked: c.noBackToBack }), h('span', {}, 'Never two run days in a row'))),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, state.config ? 'Update the plan' : 'Build my plan'), state.config ? h('a', { class: 'btn ghost', href: '#plan' }, 'Cancel') : null),
  h('p', { class: 'hint' }, state.mode === 'demo' ? 'Demo: the plan is built in your browser and not saved.' : 'Sessions you have already logged stay logged.'));
  el.append(h('div', { class: 'view-head' }, h('div', {}, h('p', { class: 'label kick' }, 'Two minutes'), h('h1', { class: 'display', id: 'h-setup' }, state.config ? 'Your goal' : 'Set your goal'))), form);
}

function viewMessage(title, text, actions = []) {
  const el = $('view-message');
  el.replaceChildren(h('div', { class: 'view-head' }, h('h1', { class: 'display' }, title)), h('p', { class: 'coach-intro' }, text), h('div', { class: 'actions' }, ...actions));
}

// ---------- router ----------
const VIEWS = ['today', 'plan', 'progress', 'coach', 'setup', 'message'];
function show(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('[data-tab]').forEach((a) => { if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = `Isard — ${name[0].toUpperCase()}${name.slice(1)}`;
}

function render() {
  $('loading').hidden = true;
  let tab = (location.hash || '#today').slice(1);
  if (state.special) { show('message'); return; }
  if (!state.config || tab === 'setup') { viewSetup(); show('setup'); return; }
  if (!VIEWS.includes(tab) || tab === 'message') tab = 'today';
  ({ today: viewToday, plan: viewPlan, progress: viewProgress, coach: viewCoach })[tab]();
  show(tab);
}
window.addEventListener('hashchange', () => { state.expanded = null; render(); window.scrollTo(0, 0); });

// ---------- boot ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({ connected: false }));
  state.mode = params.get('mode') === 'live' && me.connected ? 'live' : params.get('mode') === 'demo' ? 'demo' : me.connected ? 'live' : 'demo';
  history.replaceState({}, '', `/app?mode=${state.mode}${location.hash}`);
  $('mode').textContent = state.mode === 'demo' ? 'Demo' : 'Strava connected';
  $('avatar').textContent = state.mode === 'demo' ? 'D' : (me.athlete?.firstname || 'J')[0];
  $('demo-note').hidden = state.mode !== 'demo';

  if (state.mode === 'demo') {
    state.config = validateConfig(demoConfig(TODAY)).config;
    state.log = demoLog(generatePlan(state.config), TODAY);
  } else {
    try {
      const data = await api('GET');
      state.config = data.config; state.log = data.log || { done: {}, moves: {} };
    } catch (e) {
      state.special = true;
      viewMessage(e.status === 503 ? 'Almost there' : 'Something went wrong',
        e.status === 503 ? 'Plans are saved in a database that is not connected yet. The demo works in the meantime.' : e.message,
        [h('a', { class: 'btn', href: '/app?mode=demo' }, 'Open the demo')]);
    }
  }
  rebuild();
  if (state.plan) state.weekIdx = weekOf(state.plan, TODAY)?.index ?? (TODAY < state.plan.weeks[0].start ? 0 : state.plan.weeks.length - 1);
  render();
}
boot();
