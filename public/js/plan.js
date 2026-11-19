// Training plan engine: pure, deterministic, shared by browser and server.
// Rules in code, no model call. The AI coach can explain a plan; it never writes one.
//
// Dates are local calendar days as 'YYYY-MM-DD' strings. Weekdays: 0 = Monday … 6 = Sunday.

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Effort is described in words first. Heart rate is optional and comes later.
export const EFFORT = {
  easy: { label: 'Easy', words: 'You can hold a conversation.', bars: 2 },
  steady: { label: 'Steady', words: 'Full sentences, but you have to think about it.', bars: 3 },
  hard: { label: 'Hard', words: 'A few words at a time.', bars: 4 },
  strength: { label: 'Strength', words: 'Slow and controlled. Stop two reps before failure.', bars: 0 },
  rest: { label: 'Rest', words: 'Nothing to do. Bike commute or a walk is fine.', bars: 0 },
};

const RUN_TYPES = new Set(['easy', 'long', 'hills', 'steady', 'race', 'shakeout']);
export const isRunType = (t) => RUN_TYPES.has(t);

// ---------- date helpers (UTC arithmetic on calendar days, no time zones involved) ----------
const toMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => fromMs(toMs(d) + n * 86400000);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 86400000);
export const weekday = (d) => (new Date(toMs(d)).getUTCDay() + 6) % 7; // 0 = Monday
export const mondayOf = (d) => addDays(d, -weekday(d));
export const isoDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// ---------- config validation ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const uniqSorted = (a) => [...new Set(a)].sort((x, y) => x - y);

// Returns { config, errors }. config is null when errors is non-empty.
export function validateConfig(input) {
  const errors = [];
  const c = input && typeof input === 'object' ? input : {};
  const race = c.race && typeof c.race === 'object' ? c.race : {};
  const name = String(race.name || '').trim().slice(0, 80) || 'Race day';
  const km = Number(race.km);
  const dplus = Number(race.dplus ?? 0);
  if (!DATE_RE.test(String(race.date || ''))) errors.push('Race date is missing.');
  if (!Number.isFinite(km) || km < 5 || km > 400) errors.push('Race distance must be between 5 and 400 km.');
  if (!Number.isFinite(dplus) || dplus < 0 || dplus > 30000) errors.push('Climbing must be between 0 and 30,000 m.');

  const days = (v) => (Array.isArray(v) ? uniqSorted(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)) : []);
  const runDays = days(c.runDays);
  const strengthDays = days(c.strengthDays);
  const longRunDay = Number(c.longRunDay);
  const noBackToBack = c.noBackToBack !== false;
  if (runDays.length < 2 || runDays.length > 6) errors.push('Pick between 2 and 6 run days.');
  if (!runDays.includes(longRunDay)) errors.push('The long run day must be one of your run days.');
  if (noBackToBack) {
    const clash = runDays.find((d) => runDays.includes((d + 1) % 7));
    if (clash !== undefined) errors.push(`${DAY_LONG[clash]} and ${DAY_LONG[(clash + 1) % 7]} are back to back. Your rule says never two run days in a row.`);
  }
  const strength = strengthDays.filter((d) => d !== longRunDay);

  const currentHours = Number(c.currentHours);
  if (!Number.isFinite(currentHours) || currentHours < 0 || currentHours > 25) errors.push('Current weekly running must be between 0 and 25 hours.');

  const start = DATE_RE.test(String(c.start || '')) ? mondayOf(c.start) : null;
  if (!start) errors.push('Start date is missing.');
  if (start && DATE_RE.test(String(race.date || ''))) {
    const weeks = Math.floor(daysBetween(start, race.date) / 7) + 1;
    if (weeks < 4) errors.push('The race is less than 4 weeks after the start. Too short to build a plan.');
    if (weeks > 60) errors.push('The race is more than 60 weeks away. Start the plan closer to it.');
  }
  if (errors.length) return { config: null, errors };
  return {
    config: {
      race: { name, date: race.date, km, dplus },
      start, runDays, longRunDay, strengthDays: strength, noBackToBack,
      currentHours: Math.round(currentHours * 2) / 2,
    },
    errors,
  };
}

// ---------- season shape ----------
// Taper 1–2 weeks, then base / build / peak in 45 / 35 / 20 proportions.
export function phases(totalWeeks) {
  const taper = totalWeeks >= 10 ? 2 : 1;
  const rest = totalWeeks - taper;
  const base = Math.max(1, Math.round(rest * 0.45));
  const peak = Math.max(1, Math.round(rest * 0.2));
  const build = Math.max(1, rest - base - peak);
  const out = [];
  for (let i = 0; i < totalWeeks; i++) {
    out.push(i < base ? 'base' : i < base + build ? 'build' : i < base + build + peak ? 'peak' : 'taper');
  }
  return out;
}

// Peak weekly running hours and longest long run (minutes), from the race and the starting point.
export function targets(config) {
  const { km, dplus } = config.race;
  const ultra = km >= 60;
  const effortKm = km + dplus / 100; // effort-km: 100 m of climbing ≈ 1 km
  const longPeak = Math.round(Math.min(ultra ? 330 : 240, Math.max(75, effortKm * (ultra ? 3 : 4.2))) / 5) * 5;
  const wanted = Math.max(longPeak / 60 * 2.2, ultra ? 7 : 4);
  const start = Math.max(config.currentHours, 1.5);
  // Never more than double the starting volume: the season length decides what is safe.
  const peakHours = Math.round(Math.min(wanted, start * 2, 14) * 2) / 2;
  return { longPeak, peakHours: Math.max(peakHours, start) };
}

const r5 = (m) => Math.max(20, Math.round(m / 5) * 5);

// ---------- session copy ----------
function why(type, phase, ctx) {
  const race = ctx.raceName;
  const lines = {
    long: {
      base: `Builds the time on your feet that everything else sits on. Keep it easy enough to talk the whole way.`,
      build: `${race} is decided by who slows down least. This trains time on feet, not speed. Walk the steep climbs.`,
      peak: `Your longest runs of the season. Practise race-day food and kit here, not on the day.`,
      taper: `Shorter on purpose. You keep the habit, you lose the fatigue.`,
    },
    easy: {
      base: `Easy volume. It feels too slow, and that is the point: it builds the engine without the cost.`,
      build: `Recovery between the hard days. If you can't talk, slow down.`,
      peak: `Keeps the legs moving between big sessions. Shorter is better than harder.`,
      taper: `Short and easy. Stay sharp, stay fresh.`,
    },
    hills: {
      base: `Short climbs, done strong. Builds leg power for ${race}'s ${ctx.dplus.toLocaleString('en-GB')} m of climbing.`,
      build: `Repeated climbs at a hard effort. This is where climbing speed comes from.`,
      peak: `Fewer reps, same effort. Sharpen, don't dig a hole.`,
      taper: `A few short pick-ups to remind the legs. Nothing more.`,
    },
    steady: {
      base: `A touch quicker than easy. Teaches you a pace you can hold for hours.`,
      build: `Race-like effort on rolling ground. The pace you want to own on race day.`,
      peak: `Long steady block at race effort, on terrain like the race.`,
      taper: `Short steady block at race effort. Confidence, not fitness.`,
    },
    strength: {
      base: `Legs only: single-leg squats, lunges, step-ups, calf raises. Protects knees and hips on long descents.`,
      build: `Same moves, a bit heavier. Strong legs stay efficient late in the race.`,
      peak: `Maintain, don't build. Keep it short and clean.`,
      taper: `One light session to stay switched on.`,
    },
    rest: {
      base: `Rest is when the training turns into fitness.`,
      build: `Rest is when the training turns into fitness.`,
      peak: `Big weeks need real rest days. Protect this one.`,
      taper: `Rest. Sleep is the best thing you can do now.`,
    },
  };
  return lines[type]?.[phase] || '';
}

const TITLES = { long: 'Long run', easy: 'Easy run', hills: 'Hills', steady: 'Steady run', strength: 'Strength · legs', rest: 'Rest', race: 'Race day', shakeout: 'Shake-out' };
const EFFORT_OF = { long: 'easy', easy: 'easy', hills: 'hard', steady: 'steady', strength: 'strength', rest: 'rest', race: 'hard', shakeout: 'easy' };

function detailFor(type, phase, minutes) {
  if (type === 'hills') {
    const reps = phase === 'base' ? 6 : phase === 'build' ? 8 : phase === 'peak' ? 6 : 4;
    const len = phase === 'base' ? '1 min' : phase === 'taper' ? '45 s' : '3 min';
    return `${reps} × ${len} uphill, walk or jog down. Easy warm-up and cool-down.`;
  }
  if (type === 'steady') return `${Math.round(minutes * 0.5 / 5) * 5} min steady in the middle, easy either side.`;
  if (type === 'long') return phase === 'peak' ? 'Hilly route if you can. Eat every 40 min.' : 'On trail if you can.';
  if (type === 'strength') return phase === 'taper' ? '20 min, bodyweight.' : '3 rounds: single-leg squat, reverse lunge, step-up, calf raise.';
  return '';
}

// ---------- plan generation ----------
export function generatePlan(config) {
  const raceDate = config.race.date;
  const totalWeeks = Math.floor(daysBetween(config.start, raceDate) / 7) + 1;
  const ph = phases(totalWeeks);
  const { longPeak, peakHours } = targets(config);
  const startHours = Math.max(config.currentHours, 1.5);
  const ctx = { raceName: config.race.name, dplus: config.race.dplus };

  // Index of the last non-taper week: that week reaches peak volume.
  const lastBuild = ph.lastIndexOf('peak') >= 0 ? ph.lastIndexOf('peak') : ph.lastIndexOf('build');
  const others = config.runDays.filter((d) => d !== config.longRunDay);
  // Starting point: the athlete's current week, split into a long run and the rest.
  const startLong = Math.max(60, Math.min(longPeak, startHours * 60 * 0.4));
  const startOther = others.length ? Math.max(30, (startHours * 60 - startLong) / others.length) : 0;
  // Midweek runs top out at 75 min; the rest of the peak volume goes to the long run.
  const otherPeak = others.length ? Math.max(startOther, Math.min(75, (peakHours * 60 - longPeak) / others.length)) : 0;
  let prevLong = startLong; let prevOther = startOther;
  const weeks = [];
  for (let w = 0; w < totalWeeks; w++) {
    const phase = ph[w];
    const weekStart = addDays(config.start, w * 7);
    const recovery = phase !== 'taper' && w > 0 && (w + 1) % 4 === 0 && w < lastBuild;
    const toRace = daysBetween(weekStart, raceDate); // < 7 means race week
    let longMin; let otherMin;
    if (phase === 'taper') {
      const k = toRace < 7 ? 0 : 0.6;
      longMin = prevLong * k; otherMin = toRace < 7 ? 35 : prevOther * 0.75;
    } else {
      const ramp = lastBuild > 0 ? Math.min(1, w / lastBuild) : 1;
      // Each part grows toward its peak, never more than +10% on the last normal week.
      const wantLong = startLong + (longPeak - startLong) * ramp;
      const wantOther = startOther + (otherPeak - startOther) * ramp;
      longMin = w === 0 ? startLong : Math.min(wantLong, prevLong * 1.1);
      otherMin = w === 0 ? startOther : Math.min(wantOther, prevOther * 1.1);
      if (recovery) { longMin *= 0.65; otherMin *= 0.8; } else { prevLong = longMin; prevOther = otherMin; }
    }

    const sessions = [];
    const runDays = config.runDays;
    const raceWeek = toRace < 7;
    const qualityType = raceWeek ? 'easy' : phase === 'base' ? (w % 2 ? 'steady' : 'hills') : phase === 'build' ? 'hills' : phase === 'peak' ? (w % 2 ? 'hills' : 'steady') : 'steady';
    // Quality goes on the run day furthest from the long run.
    const dist = (d) => Math.min(Math.abs(d - config.longRunDay), 7 - Math.abs(d - config.longRunDay));
    const qualityDay = runDays.length >= 3 && !recovery ? [...others].sort((a, b) => dist(b) - dist(a))[0] : null;

    for (let d = 0; d < 7; d++) {
      const date = addDays(weekStart, d);
      if (date > raceDate) break;
      let type; let minutes = 0;
      if (date === raceDate) { type = 'race'; }
      else if (phase === 'taper' && daysBetween(date, raceDate) === 1 && runDays.length) { type = 'rest'; }
      else if (d === config.longRunDay) { type = phase === 'taper' && daysBetween(date, raceDate) < 7 ? 'shakeout' : 'long'; minutes = type === 'shakeout' ? 20 : r5(longMin); }
      else if (runDays.includes(d)) { type = d === qualityDay ? qualityType : 'easy'; minutes = r5(otherMin); }
      else if (config.strengthDays.includes(d) && !(phase === 'taper' && daysBetween(date, raceDate) < 6)) { type = 'strength'; minutes = phase === 'taper' ? 20 : 35; }
      else { type = 'rest'; }
      const effort = EFFORT_OF[type];
      sessions.push({
        date, type, title: TITLES[type], minutes, effort,
        detail: type === 'race' ? `${config.race.km} km · ${config.race.dplus.toLocaleString('en-GB')} m D+` : detailFor(type, phase, minutes),
        why: type === 'race' ? `Everything was for this. Start slower than you want to.` : type === 'shakeout' ? 'Twenty minutes, very easy, a few strides. Just to wake the legs up.' : why(type, phase, ctx),
      });
    }
    const runMin = sessions.filter((s) => isRunType(s.type)).reduce((a, s) => a + s.minutes, 0);
    weeks.push({ index: w, number: w + 1, start: weekStart, phase, recovery, hours: Math.round(runMin / 6) / 10, sessions });
  }
  return { config, totalWeeks, targets: { longPeak, peakHours }, weeks };
}

// ---------- athlete's changes on top of the generated plan ----------
// log = { done: { [date]: { minutes, feel } }, moves: { [fromDate]: toDate } }
// Moves are within the same week only. Returns a new plan with sessions relocated.
export function applyLog(plan, log = {}) {
  const moves = log.moves || {};
  const done = log.done || {};
  const weeks = plan.weeks.map((wk) => {
    const sessions = wk.sessions.map((s) => ({ ...s, originalDate: s.date }));
    for (const s of sessions) if (moves[s.originalDate]) s.date = moves[s.originalDate];
    // A day vacated by a move becomes rest; a day receiving a session replaces its rest.
    const byDate = new Map();
    for (const s of sessions) {
      const prev = byDate.get(s.date);
      if (!prev || prev.type === 'rest' || (prev.type === 'strength' && isRunType(s.type))) byDate.set(s.date, s);
    }
    const out = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(wk.start, d);
      if (date > plan.config.race.date) break;
      const s = byDate.get(date) || { date, originalDate: date, type: 'rest', title: TITLES.rest, minutes: 0, effort: 'rest', detail: '', why: 'Moved session left this day free.' };
      out.push({ ...s, date, moved: s.originalDate !== date, done: done[s.originalDate] || null });
    }
    return { ...wk, sessions: out };
  });
  return { ...plan, weeks };
}

// Can the session originally on `from` move to `to`? Checks the athlete's rules on the current week.
export function canMove(plan, from, to) {
  const week = plan.weeks.find((w) => w.sessions.some((s) => s.originalDate === from));
  if (!week) return { ok: false, reason: 'Session not found.' };
  const s = week.sessions.find((x) => x.originalDate === from);
  if (from === to) return { ok: false, reason: 'Same day.' };
  if (to < week.start || to > addDays(week.start, 6)) return { ok: false, reason: 'Sessions move within their week.' };
  if (to > plan.config.race.date) return { ok: false, reason: 'After race day.' };
  if (s.type === 'race') return { ok: false, reason: 'Race day does not move.' };
  if (s.type === 'rest') return { ok: false, reason: 'Nothing to move on a rest day.' };
  const target = week.sessions.find((x) => x.date === to);
  if (target && target.type !== 'rest' && !(target.type === 'strength' && isRunType(s.type))) {
    return { ok: false, reason: `${DAY_LONG[weekday(to)]} already has ${target.title.toLowerCase()}.` };
  }
  if (isRunType(s.type) && plan.config.noBackToBack) {
    const isRunOn = (date) => {
      if (date === s.date) return false; // the day being vacated
      const all = plan.weeks.flatMap((w) => w.sessions);
      const x = all.find((y) => y.date === date);
      return x ? isRunType(x.type) : false;
    };
    const before = addDays(to, -1); const after = addDays(to, 1);
    if (isRunOn(before)) return { ok: false, reason: `You ran on ${DAY_LONG[weekday(before)]}. Your rule: never two run days in a row.` };
    if (isRunOn(after)) return { ok: false, reason: `You run on ${DAY_LONG[weekday(after)]}. Your rule: never two run days in a row.` };
  }
  return { ok: true, reason: `${DAY_LONG[weekday(to)]} works: your rules hold.` };
}

export function sessionOn(plan, date) {
  for (const w of plan.weeks) for (const s of w.sessions) if (s.date === date) return { week: w, session: s };
  return null;
}

export function weekOf(plan, date) {
  return plan.weeks.find((w) => date >= w.start && date <= addDays(w.start, 6)) || null;
}

// ---------- demo athlete ----------
// A fictional runner, 9 weeks into a 20-week plan. Dates move with today so the demo never goes stale.
export function demoConfig(today = isoDate()) {
  const start = addDays(mondayOf(today), -8 * 7);
  return {
    race: { name: 'Trail des Crêtes', date: addDays(start, 19 * 7 + 5), km: 50, dplus: 2500 },
    start, runDays: [1, 3, 5], longRunDay: 5, strengthDays: [0, 4], noBackToBack: true, currentHours: 4,
  };
}

export function demoLog(plan, today = isoDate()) {
  // Everything before today was done, with a couple of realistic misses.
  const done = {};
  const all = plan.weeks.flatMap((w) => w.sessions).filter((s) => s.date < today && s.type !== 'rest');
  all.forEach((s, i) => {
    if (i % 11 === 7) return; // missed
    const feel = s.effort === 'hard' ? 'hard' : i % 5 === 0 ? 'hard' : 'ok';
    done[s.date] = { minutes: Math.max(15, s.minutes + ((i * 7) % 11) - 5), feel };
  });
  return { done, moves: {} };
}
