// /api/plan — the athlete's training plan (live mode). The demo plan is built in the browser.
//   GET                                   → { config, log } or { config: null }
//   PUT  { config }                       → validates, saves, keeps the log
//   POST { action, date, to?, minutes?, feel? }  action: done | undo | move | unmove
// The server re-checks every move against the athlete's rules: the browser is never trusted.
import { handler, json, readJson } from '../lib/http.js';
import { readSession } from '../lib/session.js';
import { db } from '../lib/db.js';
import { validateConfig, generatePlan, applyLog, canMove } from '../public/js/plan.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FEELS = new Set(['easy', 'ok', 'hard']);

function athleteId(req) {
  const s = process.env.SESSION_SECRET ? readSession(req) : null;
  if (!s?.athlete?.id) throw Object.assign(new Error('Connect Strava to save a plan.'), { status: 401 });
  return String(s.athlete.id);
}

export function applyAction(config, log, body) {
  const next = { done: { ...(log.done || {}) }, moves: { ...(log.moves || {}) } };
  const { action, date, to } = body || {};
  if (!DATE_RE.test(String(date || ''))) throw Object.assign(new Error('Invalid date'), { status: 400 });
  if (action === 'done') {
    const minutes = Math.round(Number(body.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw Object.assign(new Error('Minutes must be between 1 and 1440.'), { status: 400 });
    next.done[date] = { minutes, feel: FEELS.has(body.feel) ? body.feel : 'ok' };
  } else if (action === 'undo') {
    delete next.done[date];
  } else if (action === 'move') {
    if (!DATE_RE.test(String(to || ''))) throw Object.assign(new Error('Invalid target date'), { status: 400 });
    const plan = applyLog(generatePlan(config), next);
    const check = canMove(plan, date, to);
    if (!check.ok) throw Object.assign(new Error(check.reason), { status: 409 });
    next.moves[date] = to;
  } else if (action === 'unmove') {
    delete next.moves[date];
  } else {
    throw Object.assign(new Error('Unknown action'), { status: 400 });
  }
  return next;
}

export default handler(['GET', 'PUT', 'POST'], async (req, res) => {
  const id = athleteId(req);
  const sql = await db();
  const [row] = await sql`select config, log from plans where athlete_id = ${id}`;

  if (req.method === 'GET') return json(res, 200, row ? { config: row.config, log: row.log } : { config: null });

  const body = await readJson(req);
  if (req.method === 'PUT') {
    const { config, errors } = validateConfig(body?.config);
    if (errors.length) return json(res, 400, { error: errors[0], errors });
    const log = row?.log || {};
    await sql`insert into plans (athlete_id, config, log) values (${id}, ${JSON.stringify(config)}::jsonb, ${JSON.stringify(log)}::jsonb)
              on conflict (athlete_id) do update set config = excluded.config, updated_at = now()`;
    return json(res, 200, { config, log });
  }

  if (!row) return json(res, 404, { error: 'No plan yet.' });
  const log = applyAction(row.config, row.log || {}, body);
  await sql`update plans set log = ${JSON.stringify(log)}::jsonb, updated_at = now() where athlete_id = ${id}`;
  json(res, 200, { config: row.config, log });
});
