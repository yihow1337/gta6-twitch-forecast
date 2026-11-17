// Builds a synthetic "final-like" case (h00) out of a practice case and runs main.ts on it, so the
// GTA VI case itself -- which nobody can test against, since it has not happened -- is at least
// exercised end to end before the deadline: the right day (2026-11-19, US standard time), an
// hour-1 print far above every comparable's, and minute reads inside hour 1 the way the house
// recorder will supply them.
//
//   node tools/mkfinal.mjs --kit <kit-dir> [--p1 2000000[,300000,5000000]] [--decline -0.08] [--keep]
//
// Prints, for each hour-1 level, the median ratio to hour 1 and the 5-95% band, so the curve can be
// eyeballed: GTA VI unlocks at midnight local time rolling west, so 05:00Z (hour 6) is the US
// Eastern unlock, hours 8-13 are the US night trough, and the peak should land in the US
// afternoon/evening, 17:00-22:00Z.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnalogs } from '../model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const KIT = opt('--kit', process.env.MAKEFUN_KIT_DIR ?? '');
const KIT_INPUT = KIT.endsWith('input') ? KIT : join(KIT, 'input');
const P1S = opt('--p1', '2000000,300000,5000000').split(',').map(Number);
const DECLINE = Number(opt('--decline', '-0.08')); // log drift across hour 1's minute reads

const DAY = '2026-11-19T00:00:00Z';
const CHECK = '2026-11-19T01:00:00Z';
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * The fake case: p02's shape (God of War Ragnarök, a midnight-local console launch) retitled to
 * Grand Theft Auto VI on its real release day, with its comparables kept as they are and hour 1
 * replaced by `p1`. The 60 minute reads drift down across the hour by `DECLINE` in logs, which is
 * what a launch hour looks like once the midnight-unlock rush settles.
 */
const makeCase = (base, p1) => {
  const dayMs = Date.parse(DAY);
  const history = [];
  for (let i = 0; i < 60; i++) {
    const frac = i / 59;
    // a smooth decay plus a small deterministic ripple: no randomness, so runs are reproducible
    const v = p1 * Math.exp(DECLINE * frac + 0.01 * Math.sin(i / 3));
    history.push({ at: iso(dayMs + i * 60000), viewers: Math.round(v), channels: Math.round(v / 180) });
  }
  const hourly = Array.isArray(base.history_hourly) ? base.history_hourly.slice(-336) : [];
  return {
    schema: 'makefun/twitch-ccu-case/v1',
    id: 'h00',
    game: { name: 'Grand Theft Auto VI', twitch_id: '1867279146' },
    day_start: DAY,
    checkpoint: CHECK,
    levels: [0.05, 0.25, 0.5, 0.75, 0.95],
    known: [{ hour: 1, from: DAY, until: CHECK, viewers: p1, channels: Math.round(p1 / 170), reads: 60 }],
    forecast: Array.from({ length: 23 }, (_, i) => ({
      hour: i + 2,
      from: iso(dayMs + (i + 1) * 3600000),
      until: iso(dayMs + (i + 2) * 3600000),
    })),
    history,
    history_hourly: hourly,
    streams: null,
    categories_hourly: null,
    comparables: base.comparables,
    notes: 'synthetic final-like case built by tools/mkfinal.mjs from the kit practice data',
  };
};

const base = JSON.parse(readFileSync(join(KIT_INPUT, 'p02.in'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'gta6-final-'));
const inDir = join(work, 'in');
const outDir = join(work, 'out');
mkdirSync(inDir);
mkdirSync(outDir);

const analogs = buildAnalogs(base.comparables, 'Grand Theft Auto VI', Date.parse(DAY));
console.log(`analogs in pool: ${analogs.length}`);
console.log(analogs.map((a) => `${a.name} (w=${a.weight}, h1=${Math.round(Math.exp(a.x) / 1000)}k)`).join('\n'));
console.log(`largest analog hour 1: ${Math.round(Math.exp(Math.max(...analogs.map((a) => a.x))))} viewers\n`);

for (const p1 of P1S) {
  writeFileSync(join(inDir, 'h00.in'), JSON.stringify(makeCase(base, p1)));
  const t0 = process.hrtime.bigint();
  execFileSync(process.execPath, ['main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir },
    stdio: 'inherit',
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const out = JSON.parse(readFileSync(join(outDir, 'h00.out'), 'utf8'));
  const bytes = readFileSync(join(outDir, 'h00.out')).length;
  console.log(`=== hour-1 print ${p1.toLocaleString('en-US')} (${ms.toFixed(0)} ms, ${bytes} bytes) ===`);
  console.log('hour  UTC    median     ratio   5%..95% band            band ratio');
  let peak = { hour: 0, v: 0 };
  for (const row of out.hours) {
    const [q05, , q50, , q95] = row.q;
    if (q50 > peak.v) peak = { hour: row.hour, v: q50 };
    const utc = `${String(row.hour - 1).padStart(2, '0')}Z`;
    console.log(
      `${String(row.hour).padStart(4)}  ${utc}  ${Math.round(q50).toLocaleString('en-US').padStart(9)}` +
      `  x${(q50 / p1).toFixed(2).padStart(5)}  ${Math.round(q05).toLocaleString('en-US').padStart(9)}` +
      ` ..${Math.round(q95).toLocaleString('en-US').padStart(10)}   x${(q05 / p1).toFixed(2)}..x${(q95 / p1).toFixed(2)}`,
    );
  }
  console.log(`peak median: hour ${peak.hour} (${peak.hour - 1}:00-${peak.hour}:00Z) at ${Math.round(peak.v).toLocaleString('en-US')}\n`);
}

if (!argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
else console.log(`kept: ${work}`);
