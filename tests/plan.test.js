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
