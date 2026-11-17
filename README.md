# gta6-twitch-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/yihow1337/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/yihow1337/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Hour-by-hour quantile forecast of Grand Theft Auto VI's concurrent Twitch viewers on release day,
2026-11-19 (UTC), for the make.fun bounty
[gta6-twitch-ccu-forecast-01](https://make.fun/bounty/gta6-twitch-ccu-forecast-01). The program is
given everything up to the end of hour 1 and writes, for each of hours 2 to 24, the 5th, 25th,
50th, 75th and 95th percentiles of that hour's count.

Run:

```
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## The model

A launch day's **shape** generalises; its **size** does not. So everything happens in log-ratio
space, `r_h = ln(y_h / y_1)`, and the case's own hour-1 print `p1` only reappears at the end:
`q_tau(h) = p1 * exp(mu_h + z_tau * sd_h)`.

1. **Analogs.** The shape is read off the case's own `comparables` — past big launches' hourly
   Twitch counts — keeping only launches that unlock the way GTA VI does: midnight local time,
   rolling westward across the time zones. Each is weighted by how close that match is (1.0 for a
   single-player console launch like Red Dead Redemption 2 or God of War Ragnarök, 0.6 where the
   audience is diluted by multiplayer or a heavy PC share, 0.4 where a simultaneous PC unlock or
   early access confounds hour 1, 0 — ignored — for everything else, including anything whose name
   the table does not know, so a new name can never break the program). The target is never an
   analog of itself.
2. **DST alignment.** Twitch's audience follows US/EU local clocks, so an analog launched inside US
   daylight saving is shifted by one hour against a target outside it (GTA VI, 19 November, is on
   standard time; Red Dead Redemption 2's 26 October was not). Without the shift, every analog's
   US-evening peak lands an hour off.
3. **Level regression.** Bigger launches are more front-loaded: their later hours are a smaller
   multiple of hour 1. Each hour's `mu_h` is a weighted ridge regression of the analogs' `r_h` on
   their own `ln(hour-1 viewers)`, centred at the weighted mean, with a small shrink toward the
   weighted median curve. GTA VI's hour 1 is expected far above every comparable's (the largest in
   the set is ELDEN RING at ~875k), so the regression input is **clamped** just above the largest
   analog instead of being extrapolated — and the clamped-away excess is added back as extra
   spread, which is the honest way to say "bigger than anything we have seen".
4. **Spread.** `sd_h` is the weighted MAD of the regression residuals, scaled to a normal sd,
   inflated by 1.2 and floored at `0.10 + 0.01*h`, then combined in quadrature with the clamp
   excess term. The inflation and the shrink were chosen by leave-one-launch-out (below), not on
   the practice answers.
5. **Live momentum.** If the case carries minute reads inside hour 1 — it does in the final, not in
   the practice, whose history is hourly — the last 15 minutes' level against the hour-1 print
   nudges hours 2, 3 and 4 by 0.6, 0.3 and 0.15 of it, clipped to ±0.4 in logs.
6. **Never invalid.** An entry with one invalid case takes no prize, so every stage degrades
   instead of failing: an hour with too few analogs falls back to an embedded default curve (the
   analogs' weighted-median curve, generated offline by `tools/eval.mjs --emit-default`), an
   unusable case falls back to the house persistence baseline, and the entrypoint re-checks the
   shape of every row it is about to write — 23 rows, five finite positive non-decreasing numbers,
   rounded to 2 decimals. The program is deterministic (no clock, no randomness), reads only its
   case file and takes about 0.09 s per case against the 8 s cap.

## Layout

| path | what |
| --- | --- |
| `main.ts` | the entrypoint the grader runs: I/O, validation, fallbacks |
| `model.mjs` | the model itself, shared by the entrypoint and the tools |
| `tools/eval.mjs` | scoring: practice cases + leave-one-launch-out, and the fallback-curve generator |
| `tools/mkfinal.mjs` | builds a synthetic final-like GTA VI case and prints the forecast curve |

## Evaluation

The kit's practice inputs and the practice launches' real prints are **not** in this repository;
the tools take their paths:

```
node tools/eval.mjs --kit <kit-dir> --ans <dir with ans_p0*.json> [--grid] [--per-target]
node tools/mkfinal.mjs --kit <kit-dir> --p1 2000000,300000,5000000
```

The practice set is four launches, far too few to tune on — and practice answers are public, so a
practice score says nothing about the final. The honest measure is **leave-one-launch-out**: take
each weighted analog launch in turn as the target and forecast it from the other twenty, which is
exactly the position the model is in on release day.

| | loss | typical miss | 90% coverage |
| --- | --- | --- | --- |
| this model | **0.226222** | 38.6% | 0.859 |
| weighted-median curve (no regression) | 0.266636 | 47.5% | 0.834 |
| house persistence baseline | 0.351492 | 71.9% | 0.799 |

(21 launches, 483 scored hours. Over the 17 launches that are analogs in the practice cases, with
no answer files involved at all: 0.237569 / 0.268635 / 0.343114.) On the four practice cases the
model scores **0.182085** against the baseline's 0.387097 — but with four launches that number is
noise, which is why the knobs were set on the LOO grid (`--grid`) instead.

The hardest launch in LOO is Resident Evil Requiem (0.18 loss on everything else, 1.18 on it): a
thin 46k midnight hour that grew twelvefold by evening. That is real launch variance in the
opposite direction from GTA VI, whose hour 1 is the largest part of the problem.
