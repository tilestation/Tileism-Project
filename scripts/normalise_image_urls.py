#!/usr/bin/env python3
"""
Defensively normalise all <img src={x.images[0]}> and similar patterns
across the frontend so the prod backend's new `{url, alt}` object shape
doesn't render `[object Object]`.

Pattern replacements:
  src={product.images[0]}                    →  src={firstImageUrl(product.images)}
  src={tile.images[0]}                       →  src={firstImageUrl(tile.images)}
  src={product.images?.[0]}                  →  src={firstImageUrl(product.images)}
  src={product.images?.[0] || 'fallback'}    →  src={firstImageUrl(product.images) || 'fallback'}
  src={tile.images[selectedImage]}           →  src={imageUrl(tile.images[selectedImage])}
  src={product.images[selectedImage]}        →  src={imageUrl(product.images[selectedImage])}

Also adds `import { firstImageUrl, imageUrl } from '../../utils/imageUrl';`
to each touched file when missing.
"""
import re
from pathlib import Path

FILES = [
    "/app/frontend/src/pages/shop/ShopHome.js",
    "/app/frontend/src/pages/shop/ShopProducts.js",
    "/app/frontend/src/pages/shop/TileCalculatorPage.js",
    "/app/frontend/src/pages/shop/TileDetailPage.js",
    "/app/frontend/src/pages/shop/Products.js",
    "/app/frontend/src/pages/shop/RoomVisualizer.js",
    "/app/frontend/src/pages/shop/TileListingPage.js",
    "/app/frontend/src/pages/shop/TileCollectionsPage.js",
    "/app/frontend/src/pages/shop/ShopProductDetail.js",
    "/app/frontend/src/components/shop/RoomVisualizer.js",
    "/app/frontend/src/components/shop/ProductCarousel.js",
    "/app/frontend/src/pages/shop/CollectionDetailPage.js",
]

# patterns to rewrite (order matters — most-specific first)
PATTERNS = [
    # `obj.images?.[0]`         → firstImageUrl(obj.images)
    (re.compile(r"\b(\w+)\.images\?\.\[0\]"),          r"firstImageUrl(\1.images)"),
    # `obj.images[0]`           → firstImageUrl(obj.images)
    (re.compile(r"\b(\w+)\.images\[0\]"),              r"firstImageUrl(\1.images)"),
    # `obj.images[<expr>]`      → imageUrl(obj.images[<expr>])  (selected index)
    (re.compile(r"\b(\w+)\.images\[([a-zA-Z_]\w*)\]"), r"imageUrl(\1.images[\2])"),
]

def transform(src: str, fname: str) -> tuple[str, int]:
    changed_total = 0
    for pat, repl in PATTERNS:
        new, n = pat.subn(repl, src)
        changed_total += n
        src = new
    if changed_total == 0:
        return src, 0

    # Insert import if missing
    if "from '../../utils/imageUrl'" not in src and 'from "../../utils/imageUrl"' not in src:
        # Determine depth (components/shop/ vs pages/shop/)
        depth = "../../utils/imageUrl" if "/pages/" in fname or "/components/" in fname else "../utils/imageUrl"
        # Insert AFTER the last existing import statement
        lines = src.split("\n")
        last_import = -1
        for i, ln in enumerate(lines[:200]):
            if ln.startswith("import "):
                last_import = i
        if last_import >= 0:
            lines.insert(last_import + 1, f"import {{ firstImageUrl, imageUrl }} from '{depth}';")
            src = "\n".join(lines)
        else:
            src = f"import {{ firstImageUrl, imageUrl }} from '{depth}';\n" + src

    return src, changed_total


for f in FILES:
    p = Path(f)
    if not p.exists():
        print(f"SKIP (not found): {f}")
        continue
    orig = p.read_text()
    new, n = transform(orig, f)
    if n > 0:
        p.write_text(new)
        print(f"OK  {n:2d} edits — {f}")
    else:
        print(f"--  0 edits   — {f}")
