// make.fun · gta6-twitch-ccu-forecast-01 — entry point (Node 22, standard library only).
//
// Reads every <id>.in in $MAKEFUN_INPUT_DIR (default /input), in name order, and writes one
// <id>.out to $MAKEFUN_OUTPUT_DIR (default /output):
//   {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ... 23 rows, hours 2..24 ...]}
//
// The forecast itself lives in ./model.mjs, which tools/eval.mjs scores and tools/mkfinal.mjs
// exercises, so the graded program and the evaluated model are the same code. In short:
//
//   1. Work in log-ratio space r_h = ln(y_h / y_1): a launch day's *shape* generalises, its size
//      does not. Quantiles come out as p1 * exp(quantile of r_h), p1 = the case's hour-1 print.
//   2. The shape is read off the case's own `comparables` — past launches' hourly Twitch counts —
//      keeping only launches that unlock like GTA VI does (midnight local, rolling across zones),
//      weighted by how close that match is, and aligned for US daylight saving so that the same
//      local hour of two launches lines up.
//   3. Each hour's median log-ratio is a weighted ridge regression on the analog's own hour-1
//      level (bigger launches are more front-loaded), shrunk toward the weighted median curve.
//      GTA VI's hour 1 will sit far above every comparable's, so the regression input is clamped
//      and the clamped-away excess becomes extra spread instead of wild extrapolation.
//   4. The spread is a weighted MAD of the regression residuals, inflated and floored (both chosen
//      by leave-one-launch-out, see tools/eval.mjs).
//   5. If the case carries minute reads inside hour 1 (it does in the final, not in practice), the
//      last 15 minutes' momentum nudges hours 2–4.
//
// Everything is deterministic (no clock, no randomness), runs in well under the 8 s cap, and is
// wrapped so that no case can crash or emit an invalid shape: an unusable case still gets the
// house persistence baseline rather than nothing.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecastCase, baselineLogQuantiles, round2, HOURS } from './model.mjs';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Row {
  hour: number;
  q: number[];
}

/** The house persistence baseline, used only if the model itself fails on a case. */
const baselineRows = (p1: number): Row[] =>
  HOURS.map((h: number) => ({ hour: h, q: baselineLogQuantiles(h).map((z: number) => round2(p1 * Math.exp(z))) }));

/** Hour 1's print from a parsed case (1 when the case is unusable), the scale of everything else. */
const hourOnePrint = (c: any): number => {
  const known = Array.isArray(c?.known) ? c.known.find((k: any) => Number(k?.hour) === 1) : undefined;
  const v = Number(known?.viewers);
  return Number.isFinite(v) && v > 1 ? v : 1;
};

/**
 * Last line of defence: the rules reject a case whose output is not exactly 23 rows of five
 * finite, positive, non-decreasing numbers at most 1e9, and an entry with one invalid case takes
 * no prize. Anything that does not pass here is replaced by the baseline's own row.
 */
const sanitise = (rows: Row[], p1: number): Row[] => {
  const byHour = new Map<number, Row>();
  for (const r of rows ?? []) {
    const h = Number(r?.hour);
    if (!Number.isInteger(h) || h < 2 || h > 24 || byHour.has(h)) continue;
    const q = Array.isArray(r.q) ? r.q.map((v) => Number(v)) : [];
    if (q.length !== 5 || q.some((v) => !Number.isFinite(v) || v <= 0 || v > 1e9)) continue;
    let prev = 0;
    const fixed = q
      .slice()
      .sort((a, b) => a - b)
      .map((v) => {
        const x = Math.min(1e9, Math.max(0.01, round2(v)));
        prev = Math.max(prev, x);
        return prev;
      });
    byHour.set(h, { hour: h, q: fixed });
  }
  const fallback = baselineRows(p1);
  return HOURS.map((h: number) => byHour.get(h) ?? fallback[h - 2]);
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so that two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let rows: Row[];
  let p1 = 1;
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
    p1 = hourOnePrint(c);
    rows = forecastCase(c).hours as Row[];
  } catch {
    rows = baselineRows(p1); // an unreadable case still gets a valid forecast
  }
  const hours = sanitise(rows, p1);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
