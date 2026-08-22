"""
Shared series-name extraction — single source of truth used by:
  - routes/tiles.py  _get_tile_collections_impl (storefront card grouping)
  - routes/filters.py get_filters_for_page (per-option collection counts)
Lifted verbatim from the grouping logic in tiles.py so counts always match
what the storefront actually renders.
"""
import re
import unicodedata

# Common color words to strip from series names for better grouping
COLOR_WORDS = {
    # Basic colors
    'white', 'grey', 'gray', 'black', 'beige', 'cream', 'brown', 'blue', 'green',
    'red', 'pink', 'yellow', 'orange', 'purple', 'silver', 'gold', 'ivory',
    'charcoal', 'anthracite', 'taupe', 'sand', 'bone', 'pearl', 'light', 'dark',
    # Italian colors
    'crema', 'bianco', 'grigio', 'nero', 'avorio', 'noce', 'cenere', 'pietra',
    'polvere', 'verde', 'rosa', 'marfil',
    # Spanish colors
    'blanco', 'gris', 'perla', 'ceniza', 'grafito', 'hueso', 'arena',
    'marengo', 'roble', 'terra', 'acacia', 'arce', 'nuez',
    # Decorative / pattern (used as tile variant names)
    'decor', 'feature', 'border', 'listello',
    # Color modifiers
    'brilliant', 'bright', 'jet', 'royal', 'midnight', 'pale', 'deep', 'ultra',
    # Blue/ocean tones
    'sky', 'ocean', 'aqua', 'teal', 'azure', 'cobalt', 'turquoise', 'indigo',
    'denim', 'navy', 'jean',
    # Green tones
    'sage', 'olive', 'emerald', 'mint', 'forest', 'moss',
    # Pink/red tones
    'coral', 'salmon', 'blush', 'rose', 'orchid', 'magenta',
    'burgundy', 'maroon', 'garnet', 'bordeaux', 'ruby', 'wine', 'claret',
    # Brown/warm tones
    'rust', 'terracotta', 'copper', 'bronze', 'brass', 'amber', 'honey', 'caramel',
    'walnut', 'chocolate', 'coffee', 'mocha', 'tobacco', 'cinnamon', 'chestnut',
    # Grey/neutral tones
    'smoke', 'ash', 'graphite', 'slate', 'onyx', 'ice', 'snow', 'carbon',
    'smoky', 'greige', 'platinum', 'titanium', 'pewter', 'lead',
    # Purple tones
    'violet', 'lilac', 'lavender', 'mauve', 'lemon',
    # Descriptive color words (used as tile color variants, not series)
    'pigment', 'leaf', 'romantic', 'storm', 'pepper', 'blonde', 'golden',
    'warm', 'cool', 'soft', 'fumes', 'lawa', 'thunder',
    # Marble/stone color variant names
    'breccia', 'carrara',
    'natural', 'stone', 'earth', 'clay',
    # Italian blue
    'blu',
    # Misc color-like words
    'alga', 'invisible', 'sugar', 'brillo',
    'antrecide',
}

# Words that are product attributes/descriptors (not series identifiers) — skipped during grouping
ATTRIBUTE_WORDS = {
    # Location/use
    'outdoor', 'indoor', 'external', 'internal', 'anti-slip', 'antislip',
    # Finish types
    'rectified', 'unrectified', 'honed', 'lappato', 'lapato', 'structured',
    'polished', 'matt', 'matte', 'gloss', 'glossy', 'satin', 'silk', 'rustic',
    'linear', 'plain', 'scored', 'textured', 'embossed', 'riven', 'tumbled',
    'brushed', 'glazed', 'unglazed', 'smooth', 'flamed', 'hammered', 'bush-hammered',
    'oiled', 'lacquered', 'whitewashed', 'smoked', 'unfinished', 'sanded',
    'carving', 'high-gloss', 'semi', 'waxed', 'primed',
    'brillo', 'mate',  # Spanish for gloss/matte
    # Style/pattern descriptors
    'savage', 'garden', 'mosaic', 'patchwork', 'stripe', 'chevron', 'herringbone',
    'hexagon', 'split', 'face', 'endless', 'deluxe', 'lounge', 'unique',
    'square', 'flat', 'bumpy', 'bevelled', 'round',
    # Product type suffixes (never part of a series name)
    'tiles', 'tile', 'wall', 'floor', 'and', 'slabs', 'slab',
    # Material/effect descriptors
    'effect', 'marble', 'wood', 'concrete', 'ceramic', 'metro',
    'quarry', 'travertine', 'terrazzo', 'porcelain', 'patterned',
    'laminate', 'engineered', 'lvt', 'plank', 'straight',
}


def _normalize_word(w):
    return unicodedata.normalize('NFD', w.lower()).encode('ascii', 'ignore').decode('ascii')


def extract_series_name(product_name):
    """Extract series name from product name (everything before dimensions, without color/attribute suffix).
    E.g. 'Ardesia Slate Beige 20mm Outdoor 40x80cm Matt' -> 'Ardesia Slate'
    For materials: 'Cleaning & Maintenance - Easy Clean Tile Protector 1L' -> 'Cleaning & Maintenance'
    For materials without separator: 'ProGrout Flexible Almond 3kg' -> 'ProGrout Flexible'
    """
    if not product_name:
        return "Other"

    # If name contains ' - ' separator (common in materials/tools/accessories),
    # use the part before it as the series name for grouping
    if ' - ' in product_name:
        prefix = product_name.split(' - ')[0].strip()
        if prefix:
            return prefix

    # Split by space and find where dimensions start
    parts = product_name.strip().split()

    # Pre-process: split concatenated word+dimension tokens (e.g., "Decor25x60cm" → "Decor" + "25x60cm")
    expanded_parts = []
    for part in parts:
        concat_match = re.match(r'^([A-Za-z]+)(\d+(\.\d+)?[xX]\d+.*)$', part)
        if concat_match:
            expanded_parts.append(concat_match.group(1))
            expanded_parts.append(concat_match.group(2))
        else:
            expanded_parts.append(part)
    parts = expanded_parts

    series_parts = []
    for part in parts:
        # Check if this part looks like dimensions (e.g., 60x60cm, 120X120, 21.6x21.6, etc.)
        if re.match(r'^\d+(\.\d+)?[xX]\d+', part):
            break
        # Skip thickness patterns (e.g., 20mm, 10mm) — these are attributes, not series
        if re.match(r'^\d+mm$', part, re.IGNORECASE):
            continue
        # Skip unit size patterns (e.g., 3kg, 10kg, 1L, 500ml, 5ltr, 2.5L) — these are product variants, not series
        if re.match(r'^\d+(\.\d+)?\s*(kg|g|L|l|ml|ltr|litre|litres|mtr|m)$', part, re.IGNORECASE):
            continue
        # Skip attribute words (e.g., Outdoor, Indoor, Polished, Linear)
        if _normalize_word(part) in ATTRIBUTE_WORDS:
            continue
        series_parts.append(part)

    if not series_parts:
        return product_name

    # Remove trailing color words to group color variants together
    # e.g., "Dolomite Grey" -> "Dolomite", "Dolomite White" -> "Dolomite"
    while series_parts and _normalize_word(series_parts[-1]) in COLOR_WORDS:
        series_parts.pop()

    if not series_parts:
        # If only color/finish words were there, use original first 2 words
        return ' '.join(product_name.strip().split()[:2])

    return ' '.join(series_parts)


def product_group_key(p):
    """The storefront card a product lands in — same priority as tiles.py grouping."""
    return p.get("series") or p.get("original_series") or extract_series_name(
        p.get("display_name") or p.get("name") or ""
    )
