// The training plan as the coach sees it. Built server-side only: demo plan from the
// same rules as the browser, live plan from Postgres. Never taken from the client.
import { validateConfig, generatePlan, applyLog, matchActivities, demoConfig, demoLogFor, sessionOn, weekOf, isoDate, addDays, daysBetween, DAY_NAMES, EFFORT } from '../public/js/plan.js';
import { db, hasDb } from './db.js';

export async function loadPlan(ctx, today = isoDate()) {
  let config = null; let log = {};
  if (ctx.mode === 'demo') {
    config = validateConfig(demoConfig(today)).config;
    log = demoLogFor(config, ctx.activities || [], today);
  } else if (hasDb() && ctx.athlete?.id) {
    try {
      const sql = await db();
      const [row] = await sql`select config, log from plans where athlete_id = ${String(ctx.athlete.id)}`;
      if (row) { config = row.config; log = row.log || {}; }
    } catch { return null; }
  }
  if (!config) return null;
  return matchActivities(applyLog(generatePlan(config), log), ctx.activities || []);
}

const fmt = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);

// Prompt lines describing the plan. Durations are the plan's targets, not measurements.
export function planLines(plan, today = isoDate()) {
  if (!plan) return ['No training plan is set in the app yet. If asked, say the athlete can build one in the Goal tab.'];
  const r = plan.config.race;
  const w = weekOf(plan, today);
  const lines = [
    `Goal: ${r.name}, ${r.date}, ${r.km} km, ${r.dplus} m D+ (${daysBetween(today, r.date)} days to go). Plan of ${plan.totalWeeks} weeks, built by rules in code; peak ${plan.targets.peakHours} h/week, longest long run ${fmt(plan.targets.longPeak)}.`,
    `Athlete's rules: run days ${plan.config.runDays.map((d) => DAY_NAMES[d]).join(', ')}, long run ${DAY_NAMES[plan.config.longRunDay]}${plan.config.noBackToBack ? ', never two run days in a row' : ''}.`,
  ];
  if (!w) { lines.push(today < plan.weeks[0].start ? `The plan starts on ${plan.weeks[0].start}.` : 'The plan is finished (race day is past).'); return lines; }
  lines.push(`This week: week ${w.number} of ${plan.totalWeeks}, ${w.phase} phase${w.recovery ? ', a lighter recovery week' : ''}.`);
  const show = [...w.sessions, ...((plan.weeks[w.index + 1] || {}).sessions || []).filter((s) => s.date <= addDays(today, 7))];
  for (const s of show) {
    if (s.type === 'rest') { lines.push(`- ${s.date} ${DAY_NAMES[(new Date(s.date + 'T12:00:00Z').getUTCDay() + 6) % 7]}: rest`); continue; }
    const status = s.done ? (s.done.source === 'strava' ? `done (Strava, ${s.done.minutes} min)` : `done (logged, ${s.done.minutes} min, felt ${s.done.feel})`) : s.date < today ? 'missed' : s.date === today ? 'TODAY' : 'planned';
    lines.push(`- ${s.date} ${DAY_NAMES[(new Date(s.date + 'T12:00:00Z').getUTCDay() + 6) % 7]}: ${s.title}${s.minutes ? ` ${fmt(s.minutes)}` : ''}, effort ${EFFORT[s.effort]?.label.toLowerCase() || s.effort}${s.moved ? ', moved by the athlete' : ''} | ${status} | why: ${s.why}`);
  }
  const extras = (plan.extras || []).filter((e) => e.date >= w.start);
  if (extras.length) lines.push(`Runs outside the plan this week: ${extras.map((e) => e.date).join(', ')}.`);
  return lines;
}
