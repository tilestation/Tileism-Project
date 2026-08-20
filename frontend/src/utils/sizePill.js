/**
 * Compute proportional pill dimensions for a list of tile sizes.
 *
 * Algorithm (matches /tmp/size_pills_preview.html mockup approved by user):
 *  1. Parse each size string -> [w_mm, h_mm]
 *  2. base_pill_area scales from the smallest tile in the set
 *  3. pill area grows as sqrt(tile_area / min_tile_area) — sub-linear so
 *     the largest tile doesn't blow the row out
 *  4. orient long side horizontal so wider rectangles read as "wider"
 *  5. clamp long side (MAX_LONG) and short side (MIN_SHORT) for legibility
 *
 * Sizes that don't parse (e.g. "1L", "3kg", "Single") return null and the
 * caller should fall back to the default fixed pill width.
 */

const SIZE_REGEX = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/i;

export function parseSizeToMm(s) {
  if (!s) return null;
  const m = s.match(SIZE_REGEX);
  if (!m) return null;
  const unit = (m[3] || 'cm').toLowerCase();
  const factor = unit === 'mm' ? 1 : 10;
  return [parseFloat(m[1]) * factor, parseFloat(m[2]) * factor];
}

export function computePillDims(sizes, opts = {}) {
  const BASE = opts.base ?? 6400;        // px² floor for smallest pill (Aug 20: doubled — user wanted bigger size pills)
  const MAX_LONG = opts.maxLong ?? 175;  // px cap on long side
  const MIN_SHORT = opts.minShort ?? 58; // px floor on short side

  const parsed = sizes.map((s) => ({ raw: s, dims: parseSizeToMm(s) }));
  const validAreas = parsed
    .filter((p) => p.dims)
    .map((p) => p.dims[0] * p.dims[1]);

  if (validAreas.length === 0) {
    return sizes.map(() => null);
  }

  const minArea = Math.min(...validAreas);

  return parsed.map(({ dims }) => {
    if (!dims) return null;
    const [w, h] = dims;
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    const aspect = short / long; // 0..1
    let pillArea = BASE * Math.sqrt((w * h) / minArea);
    let pillLong = Math.sqrt(pillArea / aspect);
    let pillShort = pillArea / pillLong;
    if (pillLong > MAX_LONG) {
      pillLong = MAX_LONG;
      pillShort = pillLong * aspect;
    }
    if (pillShort < MIN_SHORT) {
      pillShort = MIN_SHORT;
      pillLong = pillShort / aspect;
    }
    return { w: Math.round(pillLong), h: Math.round(pillShort) };
  });
}
