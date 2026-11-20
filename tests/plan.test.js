import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig, generatePlan, applyLog, canMove, phases, targets, isRunType,
  addDays, weekday, demoConfig, demoLog, sessionOn,
} from '../public/js/plan.js';

const base = {
  race: { name: 'Ultra Marin', date: '2027-06-26', km: 175, dplus: 1430 },
  start: '2026-11-23', runDays: [1, 3, 5], longRunDay: 5, strengthDays: [0, 4], currentHours: 4,
};
const plan = () => generatePlan(validateConfig(base).config);
const allSessions = (p) => p.weeks.flatMap((w) => w.sessions);

test('validateConfig rejects back-to-back run days when the rule is on', () => {
  const { errors } = validateConfig({ ...base, runDays: [1, 2, 5] });
  assert.ok(errors.some((e) => /back to back/.test(e)));
  assert.equal(validateConfig({ ...base, runDays: [1, 2, 5], noBackToBack: false }).errors.length, 0);
});

test('validateConfig catches the Sunday → Monday wrap', () => {
  const { errors } = validateConfig({ ...base, runDays: [0, 3, 6], longRunDay: 6 });
  assert.ok(errors.some((e) => /Sunday and Monday/.test(e)));
});

test('validateConfig requires the long run on a run day and a plausible race', () => {
  assert.ok(validateConfig({ ...base, longRunDay: 6 }).errors.length > 0);
  assert.ok(validateConfig({ ...base, race: { ...base.race, km: 2 } }).errors.length > 0);
  assert.ok(validateConfig({ ...base, race: { ...base.race, date: '2026-12-01' } }).errors.length > 0);
});

test('phases end with taper and keep base first', () => {
  const p = phases(31);
  assert.equal(p[0], 'base');
  assert.deepEqual(p.slice(-2), ['taper', 'taper']);
  assert.ok(p.indexOf('build') > p.lastIndexOf('base'));
  assert.equal(phases(6).filter((x) => x === 'taper').length, 1);
});

test('plan covers start to race day, race day is last', () => {
  const p = plan();
  const s = allSessions(p);
  assert.equal(s[0].date, '2026-11-23');
  assert.equal(s.at(-1).date, '2027-06-26');
  assert.equal(s.at(-1).type, 'race');
});

test('never two run days in a row, anywhere in the plan', () => {
  const s = allSessions(plan());
  for (let i = 1; i < s.length; i++) {
    if (s[i].type === 'race') continue;
    assert.ok(!(isRunType(s[i].type) && isRunType(s[i - 1].type)), `${s[i - 1].date} and ${s[i].date}`);
  }
});

test('weekly volume never jumps more than 10% between normal weeks', () => {
  const weeks = plan().weeks.filter((w) => !w.recovery && w.phase !== 'taper');
  for (let i = 1; i < weeks.length; i++) {
    assert.ok(weeks[i].hours <= weeks[i - 1].hours * 1.1 + 0.25, `week ${weeks[i].number}: ${weeks[i - 1].hours} → ${weeks[i].hours}`);
  }
});

test('long run grows toward the ultra cap and drops in taper', () => {
  const p = plan();
  const longs = p.weeks.map((w) => w.sessions.find((s) => s.type === 'long')?.minutes || 0);
  assert.ok(Math.max(...longs) <= 330);
  assert.ok(Math.max(...longs) >= 240, `peak long run ${Math.max(...longs)}`);
  assert.ok(longs[0] < Math.max(...longs));
  const taper = p.weeks.filter((w) => w.phase === 'taper');
  assert.ok(taper.every((w) => w.hours < p.targets.peakHours));
});

test('peak volume never exceeds double the starting volume', () => {
  const t = targets(validateConfig(base).config);
  assert.ok(t.peakHours <= 8);
  const beginner = targets(validateConfig({ ...base, currentHours: 1.5, race: { ...base.race, km: 21, dplus: 300 } }).config);
  assert.ok(beginner.peakHours <= 4);
});

test('every session explains itself', () => {
  for (const s of allSessions(plan())) {
    if (s.type === 'rest') continue;
    assert.ok(s.why && s.why.length > 20, `${s.date} ${s.type}`);
    assert.ok(s.effort);
  }
});

test('canMove enforces the no back-to-back rule and the week boundary', () => {
  const p = applyLog(plan());
  const week = p.weeks[2];
  const thu = week.sessions.find((s) => weekday(s.date) === 3);
  // Thursday run → Wednesday: Tuesday is a run day.
  assert.equal(canMove(p, thu.originalDate, addDays(week.start, 2)).ok, false);
  // Thursday run → Friday: Saturday is the long run.
  assert.equal(canMove(p, thu.originalDate, addDays(week.start, 4)).ok, false);
  // Next week: refused.
  assert.equal(canMove(p, thu.originalDate, addDays(week.start, 8)).ok, false);
  // Strength Friday → Wednesday (rest) is fine.
  const fri = week.sessions.find((s) => weekday(s.date) === 4);
  assert.equal(fri.type, 'strength');
  assert.equal(canMove(p, fri.originalDate, addDays(week.start, 2)).ok, true);
});

test('applyLog relocates moved sessions and marks done ones', () => {
  const raw = plan();
  const week = raw.weeks[2];
  const fri = addDays(week.start, 4); const wed = addDays(week.start, 2);
  const p = applyLog(raw, { moves: { [fri]: wed }, done: { [addDays(week.start, 1)]: { minutes: 50, feel: 'ok' } } });
  assert.equal(sessionOn(p, wed).session.type, 'strength');
  assert.equal(sessionOn(p, wed).session.moved, true);
  assert.equal(sessionOn(p, fri).session.type, 'rest');
  assert.equal(sessionOn(p, addDays(week.start, 1)).session.done.minutes, 50);
});

test('demo plan is valid and lands mid-season', () => {
  const today = '2026-11-19';
  const { config, errors } = validateConfig(demoConfig(today));
  assert.deepEqual(errors, []);
  const p = generatePlan(config);
  assert.equal(p.totalWeeks, 20);
  const log = demoLog(p, today);
  assert.ok(Object.keys(log.done).length > 10);
  assert.ok(Object.keys(log.done).every((d) => d < today));
});

test('server action handler re-checks moves and validates input', async () => {
  const { applyAction } = await import('../api/plan.js');
  const config = validateConfig(base).config;
  const week = generatePlan(config).weeks[2];
  const thu = addDays(week.start, 3); const wed = addDays(week.start, 2);
  assert.throws(() => applyAction(config, {}, { action: 'move', date: thu, to: wed }), /never two run days/);
  const fri = addDays(week.start, 4);
  assert.equal(applyAction(config, {}, { action: 'move', date: fri, to: wed }).moves[fri], wed);
  assert.throws(() => applyAction(config, {}, { action: 'done', date: thu, minutes: 0 }), /Minutes/);
  assert.equal(applyAction(config, {}, { action: 'done', date: thu, minutes: 52, feel: 'hard' }).done[thu].feel, 'hard');
  assert.throws(() => applyAction(config, {}, { action: 'drop', date: thu }), /Unknown/);
});

test('matchActivities completes planned runs from Strava, manual logs win, extras stay extras', async () => {
  const { matchActivities } = await import('../public/js/plan.js');
  const raw = generatePlan(validateConfig(base).config);
  const week = raw.weeks[2];
  const tue = addDays(week.start, 1); const thu = addDays(week.start, 3); const sun = addDays(week.start, 6); const mon = week.start;
  const acts = [
    { id: 1, sport_type: 'TrailRun', start_date_local: `${tue}T07:10:00Z`, moving_time: 2700 },
    { id: 2, type: 'Run', start_date_local: `${tue}T18:00:00Z`, moving_time: 900 },
    { id: 3, type: 'Run', start_date_local: `${thu}T07:00:00Z`, moving_time: 3000 },
    { id: 4, type: 'Run', start_date_local: `${sun}T09:00:00Z`, moving_time: 1800 },
    { id: 5, type: 'Ride', start_date_local: `${mon}T08:00:00Z`, moving_time: 1800 },
  ];
  const logged = applyLog(raw, { done: { [thu]: { minutes: 55, feel: 'hard' } } });
  const p = matchActivities(logged, acts);
  const s = (d) => sessionOn(p, d).session;
  assert.deepEqual(s(tue).done, { minutes: 60, feel: 'ok', source: 'strava' });
  assert.equal(s(thu).done.minutes, 55);
  assert.equal(s(thu).done.feel, 'hard');
  assert.equal(s(mon).done, null);
  assert.deepEqual(p.extras.map((e) => e.date), [sun]);
});

test('session card helpers: key sessions, difficulty, distance estimate', async () => {
  const { isKeySession, sessionDifficulty, estimateKm } = await import('../public/js/plan.js');
  assert.equal(isKeySession({ type: 'long' }), true);
  assert.equal(isKeySession({ type: 'easy' }), false);
  assert.equal(sessionDifficulty({ type: 'rest' }), 0);
  assert.equal(sessionDifficulty({ type: 'hills', minutes: 50 }), 4);
  assert.equal(sessionDifficulty({ type: 'long', minutes: 300 }), 4);
  assert.equal(sessionDifficulty({ type: 'easy', minutes: 45 }), 1);
  assert.equal(estimateKm({ type: 'easy', minutes: 60 }, 360), 10);
  assert.equal(estimateKm({ type: 'strength', minutes: 40 }), null);
  assert.ok(estimateKm({ type: 'long', minutes: 120 }, 360) < 20);
});

test('regularity counts done vs due and adds extras', async () => {
  const { regularity, matchActivities } = await import('../public/js/plan.js');
  const raw = generatePlan(validateConfig(base).config);
  const week = raw.weeks[1];
  const today = addDays(raw.weeks[2].start, 0);
  const tue = addDays(week.start, 1); const sun = addDays(week.start, 6);
  const p = matchActivities(applyLog(raw, {}), [
    { type: 'Run', start_date_local: `${tue}T07:00:00Z`, moving_time: 2400 },
    { type: 'Run', start_date_local: `${sun}T07:00:00Z`, moving_time: 2400 },
  ]);
  const r = regularity(p, today);
  assert.equal(r.columns.length, 3);
  assert.ok(r.columns[1].cells.includes('extra'));
  assert.equal(r.done, 1);
  assert.ok(r.due >= 8);
  assert.equal(r.columns[2].cells.every((c) => c === 'planned'), true);
});

test('coach plan context: demo plan matches the app and lists today', async () => {
  const { loadPlan, planLines } = await import('../lib/plan-context.js');
  const today = '2026-11-20';
  const { demoConfig, demoLogFor, matchActivities: match } = await import('../public/js/plan.js');
  const acts = [{ type: 'Run', start_date_local: '2026-11-17T07:00:00Z', moving_time: 2700 }];
  const p = await loadPlan({ mode: 'demo', activities: acts }, today);
  const app = match(applyLog(generatePlan(validateConfig(demoConfig(today)).config), demoLogFor(validateConfig(demoConfig(today)).config, acts, today)), acts);
  assert.deepEqual(p.weeks.map((w) => w.sessions.map((s) => !!s.done)), app.weeks.map((w) => w.sessions.map((s) => !!s.done)));
  const lines = planLines(p, today).join('\n');
  assert.match(lines, /TODAY/);
  assert.match(lines, /never two run days in a row/);
  assert.match(planLines(null).join(' '), /No training plan/);
});
