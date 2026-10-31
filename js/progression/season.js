/* Seasons are calendar quarters in UTC: "2026-Q4" runs 1 Oct to 31 Dec 2026. Pure. */
export const SEASON_RE = /^[0-9]{4}-Q[1-4]$/;
export const seasonId = (d = new Date()) => { const t = new Date(d); return `${t.getUTCFullYear()}-Q${Math.floor(t.getUTCMonth() / 3) + 1}`; };
/** "2026-Q4" -> "Season 2026 · Q4" */
export const seasonLabel = id => SEASON_RE.test(id) ? `Season ${id.slice(0, 4)} · ${id.slice(5)}` : 'Season';
/** First instant of the next season (ms), for "ends in N days". */
export function seasonEnds(d = new Date()){
  const t = new Date(d), q = Math.floor(t.getUTCMonth() / 3);
  return Date.UTC(t.getUTCFullYear() + (q === 3 ? 1 : 0), ((q + 1) % 4) * 3, 1);
}
