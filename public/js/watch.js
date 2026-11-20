// "From your watch": the metrics of the former analysis dashboard, rendered in the app's Progress tab.
// Same numbers as before (computed in analytics.js from /api/activities), new presentation.
import {
  isRun, km, durStr, parseLocal, paceStr,
  loadVsUsual, loadReading, easyShare, easyShareReading,
  aerobicEngine, engineReading, weeklyClimbSpeed, climbTrend, climbNowOf, MIN_CLIMB_WEEKS,
} from './analytics.js';

let cache = null;

export async function loadWatch(mode) {
  if (cache?.mode === mode) return cache.data;
  const r = await fetch(`/api/activities?source=${mode}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  cache = { mode, data };
  return data;
}

// Pure: turns the API payload into display-ready tiles. Exported for tests.
export function watchMetrics(data, now = new Date()) {
  const { hrMax, hrRest } = data.profile;
  const acts = data.activities;
  const per = data.insights?.perActivity || {};
  const runs7 = acts.filter((a) => isRun(a) && now - parseLocal(a.start_date_local) < 7 * 86400000);
  const hours7 = runs7.reduce((s, a) => s + a.moving_time, 0) / 3600;
  const dplus7 = Math.round(runs7.reduce((s, a) => s + (a.total_elevation_gain || 0), 0));

  const lv = loadVsUsual(acts, hrMax, hrRest, now);
  const lr = loadReading(lv.deltaPct);
  const es = easyShare(acts.map((a) => ({ ...a, zoneSecs: per[a.id]?.zoneSecs || null })), now);
  const esr = easyShareReading(es.d28.pct);
  const eng = aerobicEngine(acts, hrMax);
  const ct = climbTrend(weeklyClimbSpeed(acts, per, 12, now));
  const climbNow = climbNowOf(ct);
  const tone = (x, up = 3) => (x == null ? '' : x >= up ? 'ok' : x <= -up ? 'warn' : '');
  const pace = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

  return {
    tiles: [
      { k: 'Last 7 days', v: `${hours7.toFixed(1)} h`, sub: `${dplus7.toLocaleString('en-GB')} m D+ · ${runs7.length} run${runs7.length === 1 ? '' : 's'}` },
      { k: 'Load vs usual', v: lv.deltaPct == null ? '—' : `${lv.deltaPct > 0 ? '+' : ''}${lv.deltaPct}%`, sub: lr.label.replace(/^.*?vs your usual: /, ''), tone: lr.level === 'good' ? 'ok' : lr.level === 'serious' || lr.level === 'warning' ? 'warn' : '', note: lr.sentence },
      { k: 'Easy share, 28 days', v: es.d28.pct == null ? '—' : `${es.d28.pct}%`, sub: es.d28.pct == null ? 'No heart-rate data' : 'Target about 80%', tone: esr.level === 'good' ? 'ok' : esr.level === 'neutral' ? '' : 'warn' },
      { k: 'Climbing speed', v: climbNow == null ? '—' : `${climbNow} m/h`, sub: climbNow == null ? (ct.weeksWithData === 0 ? 'No sustained climbs lately' : `${ct.weeksWithData} of ${MIN_CLIMB_WEEKS} weeks needed`) : (ct.changePct == null ? '3-week average' : `${ct.changePct > 0 ? 'Up' : 'Down'} ${Math.round(Math.abs(ct.changePct))}% over 12 weeks`), tone: tone(ct.changePct) },
      { k: 'Aerobic engine', v: eng.latestSecPerKm ? `${pace(eng.latestSecPerKm)}/km` : '—', sub: eng.latestSecPerKm ? `at ${eng.refHr} bpm · ${engineReading(eng.changePct)}` : 'Needs flat easy runs', tone: tone(eng.changePct) },
    ],
    recent: acts.filter(isRun).slice(0, 8).map((a) => ({
      id: a.id,
      date: parseLocal(a.start_date_local).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
      name: a.name,
      dist: `${km(a.distance)} km`,
      time: durStr(a.moving_time),
      dplus: `${Math.round(a.total_elevation_gain || 0).toLocaleString('en-GB')} m`,
      pace: `${paceStr(a.average_speed)}/km`,
    })),
  };
}
