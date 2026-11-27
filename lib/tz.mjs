// Time-zone offsets for the bars of an exchange, day by day. Charts show an exchange's own clock
// (9:30 is the New York open in summer and in winter), so a bar's offset is the one of its own
// day, not today's: with today's, a summer bar seen in winter is an hour off.

const cache = new Map();

/** The UTC offset (seconds) of time zone tz (e.g. 'America/New_York') on the UTC day holding t; null if tz is unknown. */
export function tzOffset(tz, t) {
  const day = Math.floor(t / 86400);
  const id = `${tz}|${day}`;
  if (cache.has(id)) return cache.get(id);
  let off = null;
  try {
    const noon = day * 86400 + 12 * 3600;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(noon * 1000));
    const v = Object.fromEntries(parts.map((p) => [p.type, +p.value]));
    off = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute) / 1000 - noon;
  } catch { /* not a time zone this system knows */ }
  if (cache.size > 20000) cache.clear();
  cache.set(id, off);
  return off;
}

/** A bar's offset: its exchange's on that day, or `fallback` (today's) when the time zone isn't known. */
export const offsetAt = (tz, t, fallback) => (tz ? tzOffset(tz, t) ?? fallback : fallback);
