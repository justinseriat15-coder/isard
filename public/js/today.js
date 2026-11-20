// Isard app: Today, Plan, Progress, Coach.
// Demo runs entirely in the browser (fictional runner, nothing saved).
// Live mode reads and writes the plan through /api/plan; the server re-checks every change.
import {
  validateConfig, generatePlan, applyLog, canMove, sessionOn, weekOf, isRunType,
  addDays, weekday, isoDate, matchActivities, demoLogFor, regularity, isKeySession, sessionDifficulty, estimateKm, mondayOf, daysBetween, demoConfig, demoLog, EFFORT, DAY_NAMES, DAY_LONG,
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
  state.plan = state.config ? matchActivities(applyLog(generatePlan(state.config), state.log), state.activities || []) : null;
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
      s.done.source === 'strava' ? `Done · ${fmtMin(s.done.minutes)} · ${s.activities?.[0]?.name || 'Strava'}, ${(s.activities.reduce((m, a) => m + (a.distance || 0), 0) / 1000).toFixed(1)} km` : `Done · ${fmtMin(s.done.minutes)} · felt ${s.done.feel === 'ok' ? 'about right' : s.done.feel}`,
      s.done.source === 'strava' ? null : h('button', { type: 'button', onclick: () => act({ action: 'undo', date: s.originalDate }) }, 'Undo'));
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
  const est = estimateKm(s, easyPace());
  if (s.type !== 'race' && s.type !== 'rest') meta.push(est ? h('span', {}, h('b', {}, `~${est}`), ' km') : null, h('span', { class: 'diff' }, 'Difficulty ', bolts(sessionDifficulty(s))));
  if (s.type === 'race') meta.push(h('span', {}, h('b', {}, String(state.config.race.km)), ' km'), h('span', {}, h('b', {}, state.config.race.dplus.toLocaleString('en-GB')), ' m D+'));
  return h('article', { class: 'card', 'aria-labelledby': 'today-title' },
    h('div', { class: 'k' }, h('span', { class: `chip${isKeySession(s) ? '' : ' calm'}` }, isKeySession(s) && s.type !== 'race' ? `Key · ${tag}` : tag), h('span', { class: 'label' }, `Week ${week.number} · ${PHASE[week.phase]}`)),
    head,
    runLike && s.type !== 'race' ? routeSvg(s.originalDate, s.type === 'long' || s.type === 'hills') : null,
    meta.filter(Boolean).length ? h('div', { class: 'meta' }, ...meta.filter(Boolean)) : null,
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


// The athlete's usual easy pace (sec/km), from their recent runs; 6:40/km when unknown.
function easyPace() {
  const p = (state.activities || []).filter((a) => /Run/.test(a.sport_type || a.type) && a.average_speed > 0).slice(0, 30).map((a) => 1000 / a.average_speed).sort((a, b) => a - b);
  return p.length >= 3 ? p[Math.floor(p.length * 0.6)] : 400;
}
function bolts(n) {
  return h('span', { class: 'bolts', role: 'img', 'aria-label': `Difficulty ${n} of 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= n ? 'on' : '' })));
}
function weekTotals(w) {
  const inWeek = (d) => d >= w.start && d <= addDays(w.start, 6);
  const acts = (state.activities || []).filter((a) => /Run/.test(a.sport_type || a.type) && inWeek(String(a.start_date_local).slice(0, 10)));
  const manual = w.sessions.filter((s) => s.done && s.done.source !== 'strava');
  return {
    n: acts.length + manual.filter((s) => !acts.some((a) => String(a.start_date_local).slice(0, 10) === s.date)).length,
    km: acts.reduce((m, a) => m + (a.distance || 0), 0) / 1000,
    min: acts.reduce((m, a) => m + (a.moving_time || 0), 0) / 60 + manual.filter((s) => !acts.some((a) => String(a.start_date_local).slice(0, 10) === s.date)).reduce((m, s) => m + s.done.minutes, 0),
  };
}
function weekOverview(week) {
  const prev = state.plan.weeks[week.index - 1];
  const a = weekTotals(week); const b = prev ? weekTotals(prev) : null;
  const delta = (x, y, f) => {
    if (b == null) return null;
    const d = x - y; if (Math.abs(d) < 0.05) return h('span', { class: 'delta' }, '=');
    return h('span', { class: `delta ${d > 0 ? 'up' : 'down'}` }, `${d > 0 ? '▲' : '▼'} ${f(Math.abs(d))}`);
  };
  return h('section', { class: 'panel overview', 'aria-label': 'Your week' },
    h('h3', {}, h('span', {}, week.index === (weekOf(state.plan, TODAY)?.index) ? 'Your week so far' : 'Your week'), h('span', {}, b ? 'vs previous week' : '')),
    h('div', { class: 'ov' },
      h('div', {}, h('span', {}, 'Activities'), h('b', { class: 'num' }, String(a.n)), delta(a.n, b?.n, (v) => String(v))),
      h('div', {}, h('span', {}, 'Distance'), h('b', { class: 'num' }, a.km.toFixed(1), h('small', {}, ' km')), delta(a.km, b?.km, (v) => v.toFixed(1))),
      h('div', {}, h('span', {}, 'Time'), h('b', { class: 'num' }, fmtMin(Math.round(a.min))), delta(a.min, b?.min, (v) => fmtMin(Math.round(v))))));
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
    t ? h('a', { class: 'togo', href: '#progress', 'aria-label': 'Open your goal' }, h('b', { class: 'num' }, String(t.n)), h('span', { class: 'label' }, `${t.unit} · ${state.config.race.name}`)) : null));

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
  el.append(seasonStrip(state.weekIdx), weekOverview(week));

  const list = h('ul', { class: 'week' });
  for (const s of week.sessions) {
    const st = statusOf(s);
    const cls = ['day', isRunType(s.type) ? 'run' : '', s.type === 'strength' ? 'str' : '', s.type === 'rest' ? 'rest' : '', `is-${st}`, s.date === TODAY ? 'is-today' : '', state.expanded === s.date ? 'expanded' : ''].join(' ');
    const stLabel = st === 'done' ? '' : st === 'missed' ? 'Missed' : s.date === TODAY ? 'Today' : s.type === 'rest' ? '' : fmtMin(s.minutes || 0);
    const id = `d-${s.date}`;
    list.append(h('li', { class: cls },
      h('button', { type: 'button', 'aria-expanded': state.expanded === s.date ? 'true' : 'false', 'aria-controls': id, onclick: () => { state.expanded = state.expanded === s.date ? null : s.date; render(); } },
        h('span', { class: 'dn' }, DAY_NAMES[weekday(s.date)], h('em', {}, String(Number(s.date.slice(8))))),
        h('span', { class: 's' }, isKeySession(s) && s.type !== 'race' ? h('span', { class: 'key' }, 'Key session') : null, s.title, s.moved ? h('span', { class: 'moved-tag' }, 'Moved') : null, s.type !== 'rest' ? h('span', { class: 'facts' }, s.minutes ? h('span', {}, fmtMin(s.minutes)) : null, estimateKm(s, easyPace()) ? h('span', {}, `~${estimateKm(s, easyPace())} km`) : null, bolts(sessionDifficulty(s))) : null, h('small', {}, (() => { const ex = (state.plan.extras || []).find((e) => e.date === s.date); if (ex) return `Extra run from Strava: ${ex.activities[0].name}, ${(ex.activities.reduce((m, a) => m + (a.distance || 0), 0) / 1000).toFixed(1)} km`; return s.type === 'rest' ? (s.why || 'Rest') : `${s.detail || EFFORT[s.effort]?.words || ''}`; })())),
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

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function goalHero() {
  const r = state.config.race;
  const d = daysBetween(TODAY, r.date);
  const chip = d > 0 ? `D-${d}` : d === 0 ? 'Race day' : 'Done';
  return h('header', { class: 'goal-hero' },
    h('div', { class: 'gh-top' },
      h('span', { class: 'status' }, h('i'), d >= 0 ? 'In preparation' : 'Finished'),
      h('a', { class: 'gh-set', href: '#setup', 'aria-label': 'Edit goal and days' }, '⚙')),
    h('div', { class: 'gh-body' },
      h('h1', { class: 'display', id: 'h-progress' }, r.name),
      h('p', { class: 'gh-date' }, fmtDate(r.date), h('span', { class: 'gh-chip' }, chip)),
      h('div', { class: 'gh-stats' },
        h('div', {}, h('span', {}, 'Distance'), h('b', {}, String(r.km), h('small', {}, ' km'))),
        h('div', {}, h('span', {}, 'Climbing'), h('b', {}, r.dplus.toLocaleString('en-GB'), h('small', {}, ' m'))),
        h('div', {}, h('span', {}, 'Preparation'), h('b', {}, String(state.plan.totalWeeks), h('small', {}, ' weeks'))))));
}

function regularityCard() {
  const r = regularity(state.plan, TODAY);
  const cols = r.columns.slice(-16);
  const rows = Math.max(...cols.map((c) => c.cells.length), 1);
  const order = { done: 0, extra: 1, missed: 2, planned: 3 };
  const grid = h('div', { class: 'reg-grid', style: `--cols:${cols.length};--rows:${rows}`, role: 'img',
    'aria-label': `Regularity: ${r.done} sessions done out of ${r.due} due, across ${cols.length} weeks.` },
    ...cols.map((c) => h('div', { class: 'reg-col' },
      ...[...c.cells].sort((x, y) => order[x] - order[y]).map((s) => h('i', { class: `c-${s}` })),
      h('em', {}, c.number % 2 === 0 || cols.length <= 8 ? `W${c.number}` : '·'))));
  return h('section', { class: 'gcard', 'aria-labelledby': 'h-reg' },
    h('h2', { id: 'h-reg' }, 'Regularity'),
    h('p', { class: 'gdesc' }, 'Consistency is what pays. Every session done builds the next one.'),
    h('div', { class: 'gbig' }, h('b', {}, r.pct == null ? '—' : `${r.pct}%`), h('span', { class: 'pill' }, `${r.done} sessions of ${r.due}`)),
    grid,
    h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'c-done' }), 'Done'), h('span', {}, h('i', { class: 'c-missed' }), 'Missed'), h('span', {}, h('i', { class: 'c-extra' }), 'Extra'), h('span', {}, h('i', { class: 'c-planned' }), 'Planned')));
}

function volumeCard() {
  const cur = weekOf(state.plan, TODAY)?.index ?? state.plan.weeks.length - 1;
  const ws = state.plan.weeks.slice(Math.max(0, cur - 11), cur + 1);
  const planned = ws.map((w) => w.sessions.filter((s) => isRunType(s.type)).reduce((a, s) => a + s.minutes, 0) / 60);
  const done = ws.map((w) => w.sessions.reduce((a, s) => a + (s.done && isRunType(s.type) ? s.done.minutes : 0), 0) / 60
    + (state.plan.extras || []).filter((e) => e.date >= w.start && e.date <= addDays(w.start, 6)).reduce((a, e) => a + e.activities.reduce((m, x) => m + x.moving_time, 0) / 3600, 0));
  const full = done.slice(0, -1);
  const avg = full.length ? full.slice(-4).reduce((a, x) => a + x, 0) / Math.min(4, full.length) : 0;
  const W = 600; const H = 180; const P = 18;
  const max = Math.max(...planned, ...done, 1) * 1.15;
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, ws.length - 1);
  const y = (v) => H - 22 - (v / max) * (H - 40);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Running hours per week, done against the plan's range, last ${ws.length} weeks.` });
  for (const g of [0.25, 0.5, 0.75]) svg.append(svgEl('line', { x1: P, x2: W - P, y1: y(max * g), y2: y(max * g), class: 'grid' }));
  const band = planned.map((v, i) => `${x(i)},${y(v * 1.1)}`).join(' ') + ' ' + planned.map((v, i) => `${x(i)},${y(v * 0.9)}`).reverse().join(' ');
  svg.append(svgEl('polygon', { points: band, class: 'band' }));
  svg.append(svgEl('polyline', { points: done.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: 'line' }));
  done.forEach((v, i) => {
    const inBand = v >= planned[i] * 0.9 && v <= planned[i] * 1.1;
    svg.append(svgEl('circle', { cx: x(i), cy: y(v), r: i === done.length - 1 ? 5 : 4, class: i === done.length - 1 ? 'now' : inBand ? 'in' : 'out' }));
    if (ws.length <= 8 || i % 2 === 1) { const tx = svgEl('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', class: 'tick' }); tx.textContent = `W${ws[i].number}`; svg.append(tx); }
  });
  return h('section', { class: 'gcard', 'aria-labelledby': 'h-vol' },
    h('h2', { id: 'h-vol' }, 'Volume'),
    h('p', { class: 'gdesc' }, 'How your endurance builds week after week, against the range the plan asked for.'),
    h('div', { class: 'gbig' }, h('b', {}, avg ? avg.toFixed(1) : '—'), h('span', { class: 'unit' }, 'h / week, last 4 weeks')),
    h('div', { class: 'vol' }, svg),
    h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'l-band' }), 'Plan range'), h('span', {}, h('i', { class: 'l-in' }), 'In range'), h('span', {}, h('i', { class: 'l-out' }), 'Outside'), h('span', {}, h('i', { class: 'l-now' }), 'This week (in progress)')));
}

function viewProgress() {
  const el = $('view-progress');
  el.replaceChildren(goalHero(), h('div', { class: 'gcards' }, regularityCard(), volumeCard()));

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
  const PRESETS = { trail25: { name: 'My first trail', km: 25, dplus: 900, weeks: 12, hours: 2.5 }, trail50: { name: 'Trail 50 km', km: 50, dplus: 2500, weeks: 18, hours: 4 }, ultra100: { name: 'Ultra 100 km', km: 100, dplus: 5000, weeks: 28, hours: 5 } };
  const pr = PRESETS[state.program];
  const c = (pr && { race: { name: pr.name, date: addDays(mondayOf(TODAY), pr.weeks * 7 + 5), km: pr.km, dplus: pr.dplus }, start: mondayOf(TODAY), runDays: [1, 3, 5], longRunDay: 5, strengthDays: [0, 4], noBackToBack: true, currentHours: pr.hours })
    || state.config || {
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
      state.program = null; location.hash = '#today'; toast('Plan ready.');
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
  document.title = `Isard — ${({ progress: 'Goal' })[name] || name[0].toUpperCase() + name.slice(1)}`;
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
  state.program = params.get('program');
  history.replaceState({}, '', `/app?mode=${state.mode}${location.hash}`);
  $('mode').textContent = state.mode === 'demo' ? 'Demo' : 'Strava connected';
  $('avatar').textContent = state.mode === 'demo' ? 'D' : (me.athlete?.firstname || 'J')[0];
  $('demo-note').hidden = state.mode !== 'demo';

  // Runs from Strava (demo: the fictional runner's watch data) complete planned sessions.
  const watchP = loadWatch(state.mode).then((d) => { state.activities = d.activities || []; }).catch(() => { state.activities = []; });
  if (state.mode === 'demo') {
    state.config = validateConfig(demoConfig(TODAY)).config;
    await watchP;
    state.log = demoLogFor(state.config, state.activities, TODAY);
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
  await watchP;
  rebuild();
  if (state.plan) state.weekIdx = weekOf(state.plan, TODAY)?.index ?? (TODAY < state.plan.weeks[0].start ? 0 : state.plan.weeks.length - 1);
  render();
}
boot();
