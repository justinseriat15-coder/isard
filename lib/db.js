// Postgres (Neon) over HTTP. Optional: without DATABASE_URL the app still runs,
// the demo needs no storage, and live endpoints answer 503 with a clear message.
import { neon } from '@neondatabase/serverless';

const url = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const hasDb = () => !!url();

let sql = null;
let ready = null;

export async function db() {
  if (!hasDb()) throw Object.assign(new Error('Storage is not configured yet.'), { status: 503 });
  sql ||= neon(url());
  ready ||= migrate(sql).catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

// Idempotent schema. Two small tables; no ORM.
async function migrate(q) {
  await q`create table if not exists plans (
    athlete_id text primary key,
    config jsonb not null,
    log jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )`;
  await q`create table if not exists waitlist (
    email text primary key,
    created_at timestamptz not null default now()
  )`;
}
