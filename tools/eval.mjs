// Evaluation for the gta6-twitch-ccu-forecast-01 entry. Two jobs, both on the same model code the
// graded entrypoint runs (../model.mjs):
//
//   (a) practice: run main.ts on the kit's practice cases and score the .out files against the
//       launches' real prints with the contest's own loss, beside the house baseline;
//   (b) leave-one-launch-out: treat each weighted analog launch as the target and forecast it from
//       the others only -- the honest read on how the model generalises to a launch it has never
//       seen, which is the only thing the final day measures. The practice set is four launches;
//       LOO is twenty-one, and it is what the tuning knobs are chosen on.
//
// Usage:
//   node tools/eval.mjs --kit <kit-dir> [--ans <dir with ans_p0*.json>] [--grid] [--per-target]
//   node tools/eval.mjs --kit <kit-dir> --emit-default    # regenerate model.mjs's fallback curve
// The kit's inputs and the answer files are deliberately *not* in this repository; pass their
// paths (or set MAKEFUN_KIT_DIR / MAKEFUN_ANS_DIR).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEVELS, DEFAULTS, analogCurve, hourlyMap, fitHours, predictRatios, logQuantiles,
  baselineLogQuantiles, weightOf, normName, usDst, wMedian,
} from '../model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const KIT = opt('--kit', process.env.MAKEFUN_KIT_DIR ?? '');
const ANS = opt('--ans', process.env.MAKEFUN_ANS_DIR ?? '');
const KIT_INPUT = KIT && existsSync(join(KIT, 'input')) ? join(KIT, 'input') : KIT;

// ---------------------------------------------------------------------------
// Loss
// ---------------------------------------------------------------------------

/** The contest's pinball loss for one hour, in log space: the mean over the five levels. */
const pinball = (lnY, lnQ) => {
  let s = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    const d = lnY - lnQ[i];
    s += 2 * Math.max(LEVELS[i] * d, (LEVELS[i] - 1) * d);
  }
  return s / LEVELS.length;
};

/** Accumulates loss, |log error| of the median and 5-95% coverage over many hours. */
const makeScorer = () => {
  const st = { n: 0, loss: 0, abs: 0, cover: 0 };
  return {
    add(lnY, lnQ) {
      st.n++;
      st.loss += pinball(lnY, lnQ);
      st.abs += Math.abs(lnY - lnQ[2]);
      if (lnY >= lnQ[0] && lnY <= lnQ[4]) st.cover++;
    },
    get() {
      const n = Math.max(1, st.n);
      return { n: st.n, loss: st.loss / n, miss: 100 * (Math.exp(st.abs / n) - 1), coverage: st.cover / n };
    },
  };
};

const fmt = (r) => `loss ${r.loss.toFixed(6)}  miss ${r.miss.toFixed(1)}%  cov ${r.coverage.toFixed(3)}  n=${r.n}`;

// ---------------------------------------------------------------------------
// The launch universe for LOO: every weighted analog in the practice cases' comparables, plus the
// four practice launches themselves (whose release-day prints come from the answer files; the
// final's comparables carry those four as analogs anyway, so this is the final's real pool).
// ---------------------------------------------------------------------------
const practiceCases = () => {
  if (!KIT_INPUT) throw new Error('pass --kit <kit dir> (or set MAKEFUN_KIT_DIR)');
  return readdirSync(KIT_INPUT)
    .filter((f) => f.endsWith('.in'))
    .sort()
    .map((f) => ({ id: f.slice(0, -3), c: JSON.parse(readFileSync(join(KIT_INPUT, f), 'utf8')) }));
};

const buildUniverse = (cases) => {
  const byName = new Map();
  for (const { c } of cases) {
    for (const comp of c.comparables ?? []) {
      if (weightOf(comp.name) <= 0) continue;
      const key = normName(comp.name);
      if (byName.has(key)) continue;
      byName.set(key, {
        name: comp.name, weight: weightOf(comp.name), dayMs: Date.parse(comp.day_start),
        map: hourlyMap(comp), source: 'comparable',
      });
    }
  }
  let withAns = 0;
  if (ANS) {
    for (const { id, c } of cases) {
      const file = join(ANS, `ans_${id}.json`);
      if (!existsSync(file) || weightOf(c.game.name) <= 0) continue;
      const a = JSON.parse(readFileSync(file, 'utf8'));
      const map = new Map([[0, a.h1]]);
      a.ans.forEach((v, i) => {
        if (v > 0) map.set(i + 1, v);
      });
      byName.set(normName(c.game.name), {
        name: c.game.name, weight: weightOf(c.game.name), dayMs: Date.parse(c.day_start),
        map, source: 'practice',
      });
      withAns++;
    }
  }
  return { launches: [...byName.values()], withAns };
};

/** A launch's own release-day log-ratio curve (no DST shift: it is its own reference). */
const ownCurve = (launch) => analogCurve(launch.map, 0);

/** The analog pool for `target`, aligned to the target's DST state. */
const poolFor = (launches, target) => {
  const tDst = usDst(target.dayMs) ? 1 : 0;
  const out = [];
  for (const l of launches) {
    if (l === target) continue;
    const curve = analogCurve(l.map, (usDst(l.dayMs) ? 1 : 0) - tDst);
    if (curve) out.push({ name: l.name, weight: l.weight, x: curve.x, r: curve.r });
  }
  return out;
};

/** The plain weighted-median curve (no regression): the reference model to beat. */
const medianPredict = (analogs, opts) => {
  const o = { ...DEFAULTS, ...opts };
  const mu = new Array(24).fill(NaN);
  const sd = new Array(24).fill(NaN);
  for (let k = 1; k <= 23; k++) {
    const pts = analogs.filter((a) => a.r[k] !== null).map((a) => ({ v: a.r[k], w: a.weight }));
    if (pts.length < o.minAnalogs) continue;
    const med = wMedian(pts);
    const mad = wMedian(pts.map((p) => ({ v: Math.abs(p.v - med), w: p.w })));
    mu[k] = med;
    sd[k] = Math.max(0.1 + 0.01 * (k + 1), 1.4826 * mad * o.inflation);
  }
  return { mu, sd };
};

// ---------------------------------------------------------------------------
// (b) leave-one-launch-out
// ---------------------------------------------------------------------------
const loo = (launches, opts = {}) => {
  const o = { ...DEFAULTS, ...opts };
  const model = makeScorer();
  const median = makeScorer();
  const base = makeScorer();
  const perTarget = [];
  for (const target of launches) {
    const actual = ownCurve(target);
    if (!actual) continue;
    const analogs = poolFor(launches, target);
    const fits = fitHours(analogs, o);
    const { mu, sd } = predictRatios(fits, actual.x, o);
    const med = medianPredict(analogs, o);
    const one = makeScorer();
    for (let k = 1; k <= 23; k++) {
      const y = actual.r[k];
      if (y === null || !Number.isFinite(y)) continue;
      if (Number.isFinite(mu[k])) {
        model.add(y, logQuantiles(mu[k], sd[k], o.skew));
        one.add(y, logQuantiles(mu[k], sd[k], o.skew));
      }
      if (Number.isFinite(med.mu[k])) median.add(y, logQuantiles(med.mu[k], med.sd[k]));
      base.add(y, baselineLogQuantiles(k + 1));
    }
    perTarget.push({ name: target.name, weight: target.weight, ...one.get() });
  }
  return { model: model.get(), median: median.get(), baseline: base.get(), perTarget };
};

// ---------------------------------------------------------------------------
// (a) practice: run the real entrypoint and score the files it writes
// ---------------------------------------------------------------------------
const practice = (cases) => {
  if (!ANS) {
    console.log('practice: no --ans directory given, skipping (the answers are not part of this repo)');
    return null;
  }
  const out = mkdtempSync(join(tmpdir(), 'gta6-eval-'));
  const t0 = process.hrtime.bigint();
  execFileSync(process.execPath, ['main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MAKEFUN_INPUT_DIR: KIT_INPUT, MAKEFUN_OUTPUT_DIR: out },
    stdio: 'inherit',
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const model = makeScorer();
  const base = makeScorer();
  const rows = [];
  for (const { id, c } of cases) {
    const ansFile = join(ANS, `ans_${id}.json`);
    if (!existsSync(ansFile)) continue;
    const a = JSON.parse(readFileSync(ansFile, 'utf8'));
    const f = JSON.parse(readFileSync(join(out, `${id}.out`), 'utf8'));
    const byHour = new Map(f.hours.map((r) => [r.hour, r.q]));
    const p1 = Math.max(1, c.known.find((k) => k.hour === 1).viewers);
    const one = makeScorer();
    for (let i = 0; i < a.ans.length; i++) {
      const y = a.ans[i];
      if (!(y > 0)) continue;
      const lnY = Math.log(Math.max(1, y));
      const lnQ = byHour.get(i + 2).map(Math.log);
      model.add(lnY, lnQ);
      one.add(lnY, lnQ);
      base.add(lnY, baselineLogQuantiles(i + 2).map((z) => z + Math.log(p1)));
    }
    rows.push({ id, name: c.game.name, ...one.get() });
  }
  return { model: model.get(), baseline: base.get(), rows, ms };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const cases = practiceCases();
const { launches, withAns } = buildUniverse(cases);
console.log(`universe: ${launches.length} weighted launches (${withAns} of them the practice launches, via --ans)\n`);

if (flag('--emit-default')) {
  // The embedded fallback curve: the weighted-median curve of the comparables' analogs, aligned to
  // a non-DST target day (GTA VI, 2026-11-19). Paste into model.mjs as DEFAULT_MU / DEFAULT_SD.
  const pool = launches.filter((l) => l.source === 'comparable');
  const target = { dayMs: Date.parse('2026-11-19T00:00:00Z') };
  const analogs = poolFor([...pool, target], target);
  const med = medianPredict(analogs, { inflation: DEFAULTS.inflation });
  const mus = [];
  const sds = [];
  for (let k = 1; k <= 23; k++) {
    mus.push(Number(med.mu[k].toFixed(4)));
    sds.push(Number(med.sd[k].toFixed(4)));
  }
  console.log(`export const DEFAULT_MU = [${mus.join(', ')}];`);
  console.log(`export const DEFAULT_SD = [${sds.join(', ')}];`);
  console.log('median ratios:', mus.map((m) => Math.exp(m).toFixed(2)).join(' '));
  process.exit(0);
}

if (flag('--grid')) {
  // The inflation and the shrink are chosen here, by LOO. Both grids are printed in full so the
  // choice is visible and not just its winner.
  const INFL = [0.9, 1.0, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5];
  const compOnly = launches.filter((l) => l.source === 'comparable');
  const sets = [['LOO over comparables only', compOnly]];
  if (withAns > 0) sets.push(['LOO incl. the practice launches', launches]);
  for (const [label, set] of sets) {
    console.log(`== ${label} (${set.length} launches) ==`);
    console.log('shrink  ' + INFL.map((i) => `infl=${i}`.padStart(10)).join(''));
    for (const shrink of [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1.0]) {
      const cells = INFL.map((inflation) => loo(set, { shrink, inflation }).model.loss.toFixed(4).padStart(10));
      console.log(String(shrink).padEnd(8) + cells.join(''));
    }
    const SKEW = [0, 0.05, 0.1, 0.2];
    console.log('skew    ' + SKEW.map((s) => `s=${s}`.padStart(10)).join(''));
    console.log('        ' + SKEW.map((skew) => loo(set, { skew }).model.loss.toFixed(4).padStart(10)).join(''));
    console.log();
  }
}

const compOnly = launches.filter((l) => l.source === 'comparable');
const rComp = loo(compOnly);
console.log('--- leave-one-launch-out, comparables only (no answer files needed) ---');
console.log('model    ', fmt(rComp.model));
console.log('median   ', fmt(rComp.median));
console.log('baseline ', fmt(rComp.baseline));

if (withAns > 0) {
  const rAll = loo(launches);
  console.log('\n--- leave-one-launch-out, all weighted launches ---');
  console.log('model    ', fmt(rAll.model));
  console.log('median   ', fmt(rAll.median));
  console.log('baseline ', fmt(rAll.baseline));
  if (flag('--per-target')) {
    console.log('\nper target (worst first):');
    for (const t of rAll.perTarget.sort((a, b) => b.loss - a.loss)) {
      console.log(`  ${t.loss.toFixed(4)}  w=${t.weight}  n=${String(t.n).padStart(2)}  ${t.name}`);
    }
  }
}

const p = practice(cases);
if (p) {
  console.log('\n--- practice cases (main.ts, scored against the real prints) ---');
  for (const r of p.rows) console.log(`  ${r.id} ${r.name.padEnd(28)} ${fmt(r)}`);
  console.log('model    ', fmt(p.model));
  console.log('baseline ', fmt(p.baseline));
  console.log(`run: main.ts on ${p.rows.length} cases in ${p.ms.toFixed(0)} ms (one process, all cases)`);
}
