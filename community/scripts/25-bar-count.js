// Bar Count
// Wickline community script by Tonylo-lab, shared under the MIT license.
// Discussion, updates and likes: https://github.com/keptaduona/wickline/issues/25

indicator('Bar Count', { overlay: true, shortName: 'Bar Count' });

const mode = input('Counting mode', 'Reset daily', {
  options: ['Reset daily', 'Continuous', 'From start time'],
});

const everyInput = input('Label every N bars (even only)', 2, {
  min: 2,
  max: 100,
  step: 2,
});

const session = input('Session preset', 'System time zone', {
  options: [
    'System time zone',
    'Asia (Shanghai 08:00)',
    'New York (09:30)',
    'London (08:00)',
    'Custom',
  ],
});

const customHour = input('Custom reset hour', 8, {
  min: 0,
  max: 23,
  step: 1,
});

const customMinute = input('Custom reset minute', 0, {
  min: 0,
  max: 59,
  step: 1,
});

const startTime = input(
  'Start time (in the session time zone)',
  '2026-01-01 09:30',
);

const position = input('Label position', 'Below', {
  options: ['Below', 'Above'],
});

const colorInput = input('Label color (#RRGGBB)', '#000000');

const recentInput = input('Label only the most recent N bars', 300, {
  min: 1,
  max: 3000,
  step: 1,
});

const limitInput = input('Maximum number of labels', 150, {
  min: 1,
  max: 300,
  step: 1,
});

const customZone = input('Custom IANA time zone (blank = system)', '');

if (timeframe.intraday && timeframe.seconds > 0) {
  const every = Math.max(
    2,
    Math.min(100, 2 * Math.round(everyInput / 2)),
  );

  const recentBars = Math.max(
    1,
    Math.min(3000, Math.round(recentInput)),
  );

  const maxLabels = Math.max(
    1,
    Math.min(300, Math.round(limitInput)),
  );

  const color = ['Dark', 'Light'].includes(colorInput)
    ? '#000000'
    : colorInput.trim();

  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(
      'Label color must use #RRGGBB, for example #000000',
    );
  }

  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let zone = systemZone;
  let resetMinutes =
    /^(America\/(New_York|Detroit|Toronto)|US\/Eastern|Canada\/Eastern)$/.test(zone)
      ? 570
      : 480;

  if (session === 'Asia (Shanghai 08:00)') {
    zone = 'Asia/Shanghai';
    resetMinutes = 480;
  } else if (session === 'New York (09:30)') {
    zone = 'America/New_York';
    resetMinutes = 570;
  } else if (session === 'London (08:00)') {
    zone = 'Europe/London';
    resetMinutes = 480;
  } else if (session === 'Custom') {
    zone = customZone.trim() || systemZone;

    resetMinutes =
      Math.max(0, Math.min(23, Math.round(customHour))) * 60 +
      Math.max(0, Math.min(59, Math.round(customMinute)));
  }

  let formatter;

  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(
      'Invalid IANA time zone. Use a name such as America/New_York or Asia/Shanghai',
    );
  }

  const daySeconds = 86400;

  function wallTime(seconds) {
    const parts = {};

    for (const part of formatter.formatToParts(new Date(seconds * 1000))) {
      if (part.type !== 'literal') {
        parts[part.type] = Number(part.value);
      }
    }

    return Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) / 1000;
  }

  // Resolve each historical date in its IANA zone, rather than applying today's UTC offset.
  function toInstant(wall) {
    const offsets = new Set(
      [-1, 1].map(sign => {
        const sample = wall + sign * 36 * 3600;
        return wallTime(sample) - sample;
      }),
    );

    const candidates = [...offsets].map(offset => {
      const instant = wall - offset;

      return {
        instant,
        delta: wallTime(instant) - wall,
      };
    });

    const exact = candidates.filter(candidate => candidate.delta === 0);

    // Repeated local times use the earlier occurrence; missing times shift forward across the gap.
    if (exact.length) {
      return Math.min(...exact.map(candidate => candidate.instant));
    }

    const later = candidates
      .filter(candidate => candidate.delta > 0)
      .sort((a, b) => a.delta - b.delta);

    if (later.length) {
      return later[0].instant;
    }

    throw new Error(
      'The selected local time cannot be resolved in this time zone',
    );
  }

  let startSeconds = -Infinity;

  if (mode === 'From start time') {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(startTime.trim());

    if (!match) {
      throw new Error(
        'Start time must use YYYY-MM-DD HH:mm, for example 2026-01-01 09:30',
      );
    }

    const [, year, month, day, hour, minute] = match.map(Number);
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const check = new Date(wall);

    if (
      year < 100 ||
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day ||
      check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute
    ) {
      throw new Error('Start time is not a valid date or time');
    }

    startSeconds = toInstant(wall / 1000);
  }

  const boundaries = new Map();

  function boundary(day) {
    if (!boundaries.has(day)) {
      boundaries.set(day, toInstant(day + resetMinutes * 60));
    }

    return boundaries.get(day);
  }

  const counts = new Array(n).fill(0);

  let currentStart = null;
  let nextStart = -Infinity;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const seconds = time[i];

    if (seconds < startSeconds) {
      continue;
    }

    if (mode === 'Reset daily' && seconds >= nextStart) {
      let day = Math.floor(wallTime(seconds) / daySeconds) * daySeconds;

      if (seconds < boundary(day)) {
        day -= daySeconds;
      }

      const start = boundary(day);

      if (start !== currentStart) {
        count = 0;
      }

      currentStart = start;
      nextStart = boundary(day + daySeconds);
    }

    counts[i] = ++count;
  }

  const groups = new Map();
  const firstVisible = Math.max(0, n - recentBars);

  let labels = 0;

  for (let i = n - 1; i >= firstVisible && labels < maxLabels; i--) {
    const value = counts[i];

    if (value === 0 || value % every !== 0) {
      continue;
    }

    if (!groups.has(value)) {
      groups.set(value, []);
    }

    groups.get(value).push(i);
    labels++;
  }

  // marker() accepts a single text string, not an array of per-bar labels.
  const selected = new Array(n).fill(false);

  for (const [value, indices] of groups) {
    for (const i of indices) {
      selected[i] = true;
    }

    marker(selected, {
      position: position === 'Above' ? 'above' : 'below',
      shape: 'circle',
      size: 0,
      color,
      text: String(value),
    });

    for (const i of indices) {
      selected[i] = false;
    }
  }
}
