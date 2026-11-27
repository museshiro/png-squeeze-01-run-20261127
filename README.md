# png-squeeze-01-run-20261127

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/museshiro/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/museshiro/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

[PNG Squeeze — 27 November 2026 on make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127)

## What this is

An entry for the [png-squeeze-01-run-20261127 on make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127) competition: squeeze screenshots into the smallest possible lossless PNG. Each input is a 1280×720 RGBA screenshot; the program rewrites it as a valid PNG that decodes to exactly the same pixels, just in fewer bytes. The competition is metric-scored with a $100 prize pool (50 paid places) and a deadline of 29 November 2026, 12:00 WIB.

## How it works

The program (`main.ts`, Node 22, built-ins only, fully deterministic) inspects every input image and picks the cheapest lossless encoding for it:

- **Colour analysis first.** If the image uses at most 256 unique colours it is encoded as a palette PNG; if every pixel is grey it becomes a greyscale PNG; otherwise it stays RGB or RGBA as needed.
- **Per-row filter selection.** For each scanline the program scores all five PNG filters (None, Sub, Up, Average, Paeth) and keeps the one with the smallest cost, instead of fixing one filter for the whole image.
- **Maximum compression.** The filtered data is deflated with zlib level 9, and the smallest candidate encoding is the one written out.

Output goes only to `/output/<id>/image.png` — nothing else is written.

## Practice-set results

Verified on the 8-image practice set: **score 621,509 / 1,000,000**, all 8 instances solved, `passed = 1`. The score rewards smaller output files (higher is better); the house baseline (fixed-Paeth) scored 420,399 on the same set.

| Instance | Score |
| --- | --- |
| i001 | 602,775 |
| i002 | 597,349 |
| i003 | 658,245 |
| i004 | 640,196 |
| i005 | 660,656 |
| i006 | 666,133 |
| i007 | 520,295 |
| i008 | 626,421 |

Total runtime is about 3.8 seconds for all 8 images (limit: 60 seconds), and repeated runs produce byte-identical output.

## Run it locally

```bash
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`MAKEFUN_INPUT_DIR` holds the input screenshots; `MAKEFUN_OUTPUT_DIR` receives one `image.png` per input id.

## Links

- Competition: [png-squeeze-01-run-20261127 on make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127)
- Referral: [make.fun/r/xrr5vp10](https://make.fun/r/xrr5vp10)
