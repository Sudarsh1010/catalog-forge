# Eval Set — Layer 1 Baseline (Ticket #13)

The committed Eval Set (`supplier-sheet.csv`, 121 messy Sheet Rows + a photo
ZIP of 36 PNGs) collapses by hand into **39 gold Products / 49 Variants**
(`gold-labels.json`, hand-verified). Every `edge-cases.md` category is
represented:

| Category | Where |
|---|---|
| Duplicate rows (EC-061) | rows 1–2, 10, 12, 16, 45, … (exact + near-duplicate "richer copy wins") |
| Conflicting duplicate | rows 6–7 (KB-50-A at 29,99 vs 27,99) |
| Split rows (EC-060) | rows 13–14 (Wand-Uhr/Wanduhr), 71–73 (Hochbeet cm/m/plain) |
| Over-merge trap (EC-062) | SL-2 vs SL-4 (2er vs 4er), SOFA-2A vs SOFA-3 |
| Mixed currencies (EC-040) | row 15 `£8` (GBP) inside an EUR column, row 17 `$ 24.99` |
| Locale decimals (EC-038/039) | `1,299.00` (row 51, en) inside a de column; `1.299,00 €` (row 52) |
| Mixed units (EC-047/048) | rows 19–22 (`150 cm`, `1,5 m`, `1500 mm`, `59"`), 61–62 (`7,5`, `7,5 kg`, `7500 g`), 63–65 (`100 l`, `100.000 ml`) |
| German text + typos (EC-054/055) | "Terrakota"/"terracotta", "Swarz"/"Schwarz", `Wand-Uhr`/`Wanduhr` |
| HTML descriptions (EC-056) | rows 24–25, 90–91 (`<p><b>`, `<br/>`, `&amp;` — forces CSV quoting) |
| Missing fields (EC-031, EC-043) | no-SKU rows 28–30, 88–89; blank prices rows 33, 58–59; `auf Anfrage` row 48 |
| Invisible-char SKUs (EC-034) | rows 34–36 (U+2011 hyphen, trailing space, clean) |
| GTIN corruption (EC-014/036) | rows 37–38 (UPC-A + leading-zero-stripped) |
| Piece pricing (EC-043/051) | rows 40–41 (`6er Pack`, price per pack) |
| Apparel sizes (EC-050) | rows 42–45 (S/M/L axis) |
| Photos without rows (EC-072) | `IMG_4472.PNG`, `dsc00042.png`, `p1000031.png`, `scan012.png` (must Park) |
| Ragged/phantom rows (EC-005/004) | rows 66 (trailing delimiter), 67 (short row) |

## Baseline — current pipeline, Demo Mode (keyless, 2026-10-22)

Run: `pnpm --filter @workspace/worker eval:l1` (full pipeline, stub provider,
no API key; throwaway `catalog_forge_eval` database).

| Field | Exact-match accuracy |
|---|---|
| Grouping (rows → Products) | **92.3 %** (36/39; 6 extra Products) |
| Dedupe (Variant count per Product) | **94.9 %** (37/39) |
| Price cents + currency | **95.9 %** (47/49) |
| Canonical units (mm/g/ml per cell) | **99.0 %** (98/99) |
| Photo matching (matched/Parked) | **82.9 %** (29/35; 1 extra Parked) |
| Review status | **87.2 %** (34/39) |

### Known misses (each is a real pipeline gap the eval exposes)

- **P02** — `KB-50`/`KB-50-A` (Terrakotta vs Anthrazit titles) stay two
  Products; the differing colour titles defeat the title-corroborated code
  family union. Also: the 24,99/27,99 conflicting duplicate does not flag
  Needs Review.
- **P03** — `SOFA-2A`/`SOFA-2B` (same title, family codes `A`/`B`) do not
  merge; the sibling code-family relation misses letter suffixes.
- **P16** — leading-zero-stripped `12345678905` (11 digits) is not normalized
  onto the same GTIN family key as `012345678905`; two Products result.
- **row 64** — `100.000 ml` (German thousands separator) is unparseable as a
  volume.
- **Photos** — filenames that carry no SKU/GTIN token park instead of
  matching (`seifenkiste-01`, `kissen-01`, `strohhut-01`, `gl-auf`,
  `tp-100-gruen-01`); `kb-50-01` lands on the half of the split P02.
- **Review status** — blank-price rows (P14, P21, P28) publish without Needs
  Review; the HTML rows (P10) over-flag.

## CI

`.github/workflows/eval-layer1.yml` runs the scorer keyless on every PR
against live Postgres/Redis/Garage services. `eval/thresholds.json` records
this baseline as floors: any Layer 1 field dropping below it fails the run.
Fix the pipeline, raise the floor.
