// Shared forecasting model for make.fun bounty gta6-twitch-ccu-forecast-01.
//
// Plain ESM JavaScript (no dependencies, standard library only) so that both the entrypoint
// (main.ts, TypeScript with erasable syntax) and the tools under tools/ run exactly the same code.
//
// The idea in one paragraph: a launch day's shape is far more stable than its size, so the model
// works in log-ratio space r_h = ln(y_h / y_1) and only at the end multiplies by the case's own
// hour-1 print. The shape is learned from the case's `comparables` (past big launches' hourly
// Twitch counts), restricted to launches that unlock the way GTA VI does -- midnight local time,
// rolling across time zones -- and aligned for US daylight saving so that "9 PM Pacific" of one
// launch lines up with "9 PM Pacific" of the target. Bigger launches are more front-loaded (their
// later hours are a smaller multiple of hour 1), so each hour's mean log-ratio is a weighted ridge
// regression of r_h on the analog's own hour-1 level, shrunk toward the weighted median curve.
// The spread is a weighted MAD of the regression residuals, inflated a little and floored.

/** Quantile levels the contest scores, in the order each output row lists them. */
export const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at those levels (the values the rules quote). */
export const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Hours the case asks for: 2..24, i.e. 23 rows. */
export const HOURS = Array.from({ length: 23 }, (_, i) => i + 2);

// ---------------------------------------------------------------------------
// Tuning knobs. `shrink` and `inflation` are chosen by leave-one-launch-out in
// tools/eval.mjs; the rest are structural and fixed by the research in SPEC.md.
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  lambda: 8,        // ridge penalty on the regression slope (weights sum to ~17, so this is strong)
  // shrink / inflation were picked on leave-one-launch-out over 21 launches, not on the four
  // practice answers (LOO is flat here: 0.2245 at shrink 0 / inflation 1.1, 0.2262 at these).
  // Shrinking toward the median curve costs more the larger the target is -- and GTA VI is the
  // largest target there has ever been -- so the shrink is kept small, only as insurance against
  // a pathological ridge slope. The inflation sits a notch above its LOO optimum because LOO
  // covers 0.86 of hours at 1.2 against 0.84 at 1.1, and the final is one unprecedented launch.
  shrink: 0.15,     // weight on the plain weighted-median curve: mu = (1-shrink)*reg + shrink*median
  inflation: 1.2,   // multiplier on the residual-MAD spread
  skew: 0,          // extra multiplier on the upper half of the spread (LOO: skew never helped)
  clampHead: 0.3,   // how far above the largest analog's ln(hour-1) the target may be extrapolated
  excessSd: 0.25,   // extra sd per nat of ln(hour-1) clamped away, added in quadrature
  minAnalogs: 5,    // fewer usable analogs for an hour => fall back to the embedded default curve
  momentum: [0.6, 0.3, 0.15], // how much of the last-15-minute momentum carries into hours 2,3,4
};

// ---------------------------------------------------------------------------
// Analog pool: which past launches look like a GTA VI launch, and how much.
// Names are matched after normalisation, so diacritics/punctuation/case cannot break it, and a
// name that is not listed simply gets weight 0 -- the program never breaks on an unknown name.
// ---------------------------------------------------------------------------

/** 1.0: console launches that unlocked at midnight local time, rolling across the time zones. */
const W_ROLLING = [
  'Red Dead Redemption 2',
  'God of War Ragnarök',
  "Marvel's Spider-Man 2",
  "Marvel's Wolverine",
  'The Last of Us Part II',
  'Ghost of Tsushima',
  'The Legend of Zelda: Tears of the Kingdom',
  'Ghost of Yōtei',
  'Stellar Blade',
  'FINAL FANTASY VII REBIRTH',
  'Resident Evil Requiem',
  'Monster Hunter Wilds',
];
/** 0.6: rolling console launches whose audience shape is diluted (multiplayer/PC-heavy). */
const W_PARTIAL = [
  'Death Stranding 2: On the Beach',
  'Saros',
  'Call of Duty: Modern Warfare 4',
  'Call of Duty: Black Ops 6',
  'Call of Duty: Black Ops 7',
  'Call of Duty: Modern Warfare III',
];
/** 0.4: big launches whose hour 1 is confounded by a simultaneous PC unlock or early access. */
const W_WEAK = ['ELDEN RING', 'Cyberpunk 2077', 'Hogwarts Legacy'];

/** Lower-case, de-accented, alphanumeric-only form of a game name. */
export const normName = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** normalised name -> analog weight. */
export const WEIGHTS = new Map([
  ...W_ROLLING.map((n) => [normName(n), 1.0]),
  ...W_PARTIAL.map((n) => [normName(n), 0.6]),
  ...W_WEAK.map((n) => [normName(n), 0.4]),
]);

/** The weight of a comparable by name; 0 (ignored) for anything not in the table. */
export const weightOf = (name) => WEIGHTS.get(normName(name)) ?? 0;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** ISO 8601 (UTC) -> epoch ms; NaN when unparseable. */
const parseMs = (s) => Date.parse(String(s ?? ''));

/** The nth Sunday of month m (1-based) in year y, as epoch ms at 00:00 UTC. */
const nthSunday = (y, m, n) => {
  const first = Date.UTC(y, m - 1, 1);
  const offset = (7 - new Date(first).getUTCDay()) % 7; // getUTCDay()===0 is Sunday
  return first + (offset + 7 * (n - 1)) * 86400000;
};

/**
 * Is `ms` inside US daylight saving time? (Second Sunday of March to first Sunday of November.)
 * Twitch's audience follows US/EU local clocks, so two launches an hour apart in local time are an
 * hour apart in UTC only if they are on the same side of the DST boundary.
 */
export const usDst = (ms) => {
  const y = new Date(ms).getUTCFullYear();
  return ms >= nthSunday(y, 3, 2) && ms < nthSunday(y, 11, 1);
};

// ---------------------------------------------------------------------------
// Analog curves
// ---------------------------------------------------------------------------

/** A comparable's hourly viewers as a map: hour offset from its day_start -> viewers (>0 only). */
export const hourlyMap = (comp) => {
  const day = parseMs(comp.day_start);
  const map = new Map();
  if (!Number.isFinite(day) || !Array.isArray(comp.hourly)) return map;
  for (const row of comp.hourly) {
    const t = parseMs(row?.from);
    const v = Number(row?.viewers);
    if (!Number.isFinite(t) || !Number.isFinite(v) || v <= 0) continue;
    map.set(Math.round((t - day) / 3600000), v);
  }
  return map;
};

/**
 * One analog's log-ratio curve on the target's hour grid.
 * `shift` = usDst(analog day) - usDst(target day): the analog's local clock runs `shift` hours
 * ahead of the target's in UTC terms, so the target's hour index k is the analog's hour k - shift.
 * Returns { x, r } with x = ln(analog's aligned hour-1 viewers) and r[k] = ln(c[k-shift]/c[-shift]),
 * r[0] = 0, r[k] = null where the analog has no print for that hour.
 */
export const analogCurve = (map, shift) => {
  const base = map.get(0 - shift);
  if (!base || !(base > 0)) return null;
  const r = new Array(24).fill(null);
  for (let k = 0; k < 24; k++) {
    const v = map.get(k - shift);
    if (v > 0) r[k] = Math.log(v / base);
  }
  if (r[0] === null) return null;
  return { x: Math.log(base), r };
};

/**
 * Build the analog pool for a target launch out of a case's `comparables`.
 * Excludes weight-0 names and the target itself (matched by name, and by prefix so that the
 * "Grand Theft Auto VI category before release ..." row -- pre-release history, not a launch --
 * never enters its own pool).
 */
export const buildAnalogs = (comparables, targetName, targetDayMs) => {
  const tgt = normName(targetName);
  const tDst = usDst(targetDayMs) ? 1 : 0;
  const out = [];
  for (const comp of comparables ?? []) {
    const n = normName(comp?.name);
    if (!n) continue;
    if (tgt && (n.startsWith(tgt) || tgt.startsWith(n))) continue; // never an analog of itself
    const w = weightOf(comp.name);
    if (w <= 0) continue;
    const day = parseMs(comp.day_start);
    if (!Number.isFinite(day)) continue;
    const curve = analogCurve(hourlyMap(comp), (usDst(day) ? 1 : 0) - tDst);
    if (curve) out.push({ name: comp.name, weight: w, x: curve.x, r: curve.r });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Weighted statistics
// ---------------------------------------------------------------------------

/** Weighted median of [{v, w}] (the lower of the two middle values when the split is exact). */
export const wMedian = (pts) => {
  if (pts.length === 0) return NaN;
  const s = [...pts].sort((a, b) => a.v - b.v);
  const total = s.reduce((acc, p) => acc + p.w, 0);
  let cum = 0;
  for (const p of s) {
    cum += p.w;
    if (cum >= total / 2) return p.v;
  }
  return s[s.length - 1].v;
};

/** Weighted mean of [{v, w}]. */
const wMean = (pts) => {
  let sw = 0;
  let sv = 0;
  for (const p of pts) {
    sw += p.w;
    sv += p.w * p.v;
  }
  return sw > 0 ? sv / sw : NaN;
};

// ---------------------------------------------------------------------------
// The per-hour fit
// ---------------------------------------------------------------------------

/**
 * Fit, for every hour index k = 1..23 (hour k+1 of the day), a weighted ridge regression of the
 * analogs' log-ratio r_k on x = ln(their hour-1 viewers), centred at the weighted mean x.
 *
 *   mu(x) = ybar + b * (x - xbar),   b = sum w (x-xbar)(r-ybar) / (sum w (x-xbar)^2 + lambda)
 *
 * The ridge keeps the slope sane with ~17 analogs; the weighted median of the same r values is
 * kept so the caller can shrink the regression toward it. `sd` is the weighted MAD of the
 * regression residuals, scaled to a normal sd.
 * Returns an array of 24 slots (index 0 unused) of {n, xbar, ybar, b, median, sd, xmax} or null.
 */
export const fitHours = (analogs, opts = {}) => {
  const { lambda } = { ...DEFAULTS, ...opts };
  const fits = new Array(24).fill(null);
  if (analogs.length === 0) return fits;
  const xmax = Math.max(...analogs.map((a) => a.x));
  for (let k = 1; k <= 23; k++) {
    const pts = analogs.filter((a) => a.r[k] !== null && Number.isFinite(a.r[k]));
    if (pts.length === 0) continue;
    const xs = pts.map((a) => ({ v: a.x, w: a.weight }));
    const ys = pts.map((a) => ({ v: a.r[k], w: a.weight }));
    const xbar = wMean(xs);
    const ybar = wMean(ys);
    let sxx = 0;
    let sxy = 0;
    for (const a of pts) {
      const dx = a.x - xbar;
      sxx += a.weight * dx * dx;
      sxy += a.weight * dx * (a.r[k] - ybar);
    }
    const b = sxy / (sxx + lambda);
    const res = pts.map((a) => ({ v: a.r[k] - (ybar + b * (a.x - xbar)), w: a.weight }));
    const med = wMedian(res);
    const mad = wMedian(res.map((p) => ({ v: Math.abs(p.v - med), w: p.w })));
    fits[k] = {
      n: pts.length,
      xbar,
      ybar,
      b,
      median: wMedian(ys),
      sd: 1.4826 * mad,
      xmax,
    };
  }
  return fits;
};

/**
 * Turn the fit into the target's log-ratio median and spread for hours 2..24.
 * The target's x is clamped to xmax + clampHead (GTA VI's hour 1 is expected far above every
 * comparable's, and a regression must not be extrapolated that far); whatever is clamped away is
 * added back as extra uncertainty instead.
 * Returns { mu: number[24], sd: number[24], used: boolean[24] } (index 0 unused).
 */
export const predictRatios = (fits, xTarget, opts = {}) => {
  const o = { ...DEFAULTS, ...opts };
  const mu = new Array(24).fill(NaN);
  const sd = new Array(24).fill(NaN);
  const used = new Array(24).fill(false);
  for (let k = 1; k <= 23; k++) {
    const f = fits[k];
    if (!f || f.n < o.minAnalogs) continue;
    const xCap = f.xmax + o.clampHead;
    const x = Math.min(Number.isFinite(xTarget) ? xTarget : f.xbar, xCap);
    const excess = Number.isFinite(xTarget) ? Math.max(0, xTarget - xCap) : 0;
    const reg = f.ybar + f.b * (x - f.xbar);
    const m = (1 - o.shrink) * reg + o.shrink * f.median;
    const floor = 0.1 + 0.01 * (k + 1);
    const base = Math.max(floor, f.sd * o.inflation);
    const s = Math.sqrt(base * base + (o.excessSd * excess) ** 2);
    if (!Number.isFinite(m) || !Number.isFinite(s) || s <= 0) continue;
    mu[k] = m;
    sd[k] = s;
    used[k] = true;
  }
  return { mu, sd, used };
};

/** The five log quantiles of one hour from its median and spread (mild right skew optional). */
export const logQuantiles = (m, s, skew = 0) =>
  Z.map((z) => m + z * s * (z > 0 ? 1 + skew : 1));

// ---------------------------------------------------------------------------
// The embedded default curve: the weighted-median log-ratio curve and spread of the analogs,
// generated offline from the practice cases' comparables by `node tools/eval.mjs --emit-default`.
// It is the model's answer when an hour has too few analogs, or when anything goes wrong with the
// case's own comparables, so the program degrades instead of crashing.
// ---------------------------------------------------------------------------
export const DEFAULT_MU = [-0.1318, -0.3369, -0.3828, -0.4706, -0.3458, -0.2463, -0.1401, -0.1863, -0.1205, -0.1647, -0.0816, 0.0063, 0.0904, 0.2304, 0.3338, 0.4918, 0.5471, 0.5642, 0.7573, 0.7718, 0.7537, 0.7004, 0.6242];
export const DEFAULT_SD = [0.12, 0.2498, 0.3374, 0.5189, 0.3718, 0.4584, 0.5096, 0.5472, 0.6435, 0.5872, 0.7076, 0.6837, 0.4841, 0.5102, 0.5504, 0.3587, 0.4461, 0.4631, 0.3177, 0.4278, 0.3482, 0.3562, 0.4214];

// ---------------------------------------------------------------------------
// Live-data nudge
// ---------------------------------------------------------------------------

/**
 * Momentum inside hour 1: how the last 15 minutes before the checkpoint sat against the hour-1
 * print. In the final the case carries the house's minute reads; in a practice case the history is
 * hourly, so this returns 0 and changes nothing.
 */
export const momentumNudge = (kase, p1) => {
  const end = parseMs(kase?.checkpoint);
  if (!Number.isFinite(end) || !(p1 > 0) || !Array.isArray(kase?.history)) return 0;
  const vals = [];
  for (const row of kase.history) {
    const t = parseMs(row?.at);
    const v = Number(row?.viewers);
    if (!Number.isFinite(t) || !Number.isFinite(v) || v <= 0) continue;
    if (t >= end - 15 * 60000 && t < end) vals.push(v);
  }
  if (vals.length < 10) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const m = Math.log(mean / p1);
  if (!Number.isFinite(m)) return 0;
  return Math.max(-0.4, Math.min(0.4, m));
};

// ---------------------------------------------------------------------------
// The whole forecast for one case
// ---------------------------------------------------------------------------

/** The house persistence baseline's log quantiles for hour h (ratios to hour 1). */
export const baselineLogQuantiles = (h) => Z.map((z) => z * 0.15 * Math.sqrt(h - 1));

/** x rounded to 2 decimals, half up. */
export const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Forecast one case. Returns {hours: [{hour, q:[5]}]} with 23 rows, hours 2..24, each row five
 * finite, positive, non-decreasing numbers rounded to 2 decimals. Never throws: every stage falls
 * back (analog fit -> embedded default curve -> house baseline), and the caller wraps it again.
 */
export const forecastCase = (kase, opts = {}) => {
  const o = { ...DEFAULTS, ...opts };
  const known = Array.isArray(kase?.known) ? kase.known.find((k) => Number(k?.hour) === 1) : null;
  const p1 = Math.max(1, Number(known?.viewers) > 0 ? Number(known.viewers) : 1);

  // Hours the case asks for, defaulting to 2..24 if `forecast` is unusable.
  let hours = [];
  if (Array.isArray(kase?.forecast)) {
    hours = kase.forecast.map((f) => Number(f?.hour)).filter((h) => Number.isInteger(h) && h >= 2 && h <= 24);
  }
  if (hours.length !== 23) hours = [...HOURS];

  let mu = new Array(24).fill(NaN);
  let sd = new Array(24).fill(NaN);
  let used = new Array(24).fill(false);
  try {
    const dayMs = Date.parse(String(kase?.day_start ?? ''));
    const analogs = buildAnalogs(kase?.comparables, kase?.game?.name, dayMs);
    const fits = fitHours(analogs, o);
    ({ mu, sd, used } = predictRatios(fits, Math.log(p1), o));
  } catch {
    // keep the all-NaN arrays: every hour falls through to the embedded default curve below
  }

  // Hours the analog fit could not serve fall back to the embedded default curve.
  for (let k = 1; k <= 23; k++) {
    if (used[k]) continue;
    const m = DEFAULT_MU[k - 1];
    const s = DEFAULT_SD[k - 1];
    if (Number.isFinite(m) && Number.isFinite(s) && s > 0) {
      mu[k] = m;
      sd[k] = s;
    }
  }

  // Live momentum inside hour 1 carries into the first few forecast hours.
  let nudge = 0;
  try {
    nudge = momentumNudge(kase, Number(known?.viewers));
  } catch {
    nudge = 0;
  }
  if (nudge !== 0) {
    for (let i = 0; i < o.momentum.length; i++) {
      const k = i + 1; // hour 2 is k = 1
      if (Number.isFinite(mu[k])) mu[k] += o.momentum[i] * nudge;
    }
  }

  const rows = hours.map((h) => {
    const k = h - 1;
    let logs;
    if (Number.isFinite(mu[k]) && Number.isFinite(sd[k]) && sd[k] > 0) {
      logs = logQuantiles(mu[k], sd[k], o.skew);
    } else {
      logs = baselineLogQuantiles(h); // last resort: the house baseline's own shape
    }
    const q = logs.map((lq) => {
      const v = p1 * Math.exp(lq);
      return Number.isFinite(v) ? Math.min(1e9, Math.max(1e-2, v)) : p1;
    });
    q.sort((a, b) => a - b);
    const rounded = [];
    let prev = 0.01;
    for (const v of q) {
      const r = Math.max(0.01, Math.min(1e9, round2(v)));
      prev = Math.max(prev, r);
      rounded.push(prev);
    }
    return { hour: h, q: rounded };
  });

  return { hours: rows };
};
