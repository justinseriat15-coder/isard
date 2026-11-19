// POST /api/waitlist { email } → stores the address once. No email is sent from here.
import { handler, json, readJson, clientIp } from '../lib/http.js';
import { db } from '../lib/db.js';
import { rateLimit } from '../lib/ratelimit.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export default handler(['POST'], async (req, res) => {
  const rl = rateLimit(`wl:${clientIp(req)}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return json(res, 429, { error: 'Too many attempts. Try again later.' });
  const { email } = await readJson(req, 2048);
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return json(res, 400, { error: 'That email looks off.' });
  const sql = await db();
  await sql`insert into waitlist (email) values (${e}) on conflict (email) do nothing`;
  json(res, 200, { ok: true });
});
