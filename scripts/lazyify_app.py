#!/usr/bin/env python3
"""
Convert eager imports of admin/* and heavy shop/* pages to React.lazy()
in /app/frontend/src/App.js. Safe: only touches lines that exactly match
the patterns; leaves contexts, layouts, helpers and the homepage alone.

Run:  python3 /app/scripts/lazyify_app.py
"""
import re
import sys
from pathlib import Path

APP = Path("/app/frontend/src/App.js")

# Keep these eager — they're used outside routes OR are first-paint critical
EAGER_KEEP = {
    # Homepage = first-paint critical
    "TileStationHome",
    # Layouts wrap many routes — keeping eager avoids waterfall on every nav
    "Layout",
    "ShopLayout",
    # Auth-flow / app-shell (low cost, used in many top-level routes)
    "AuthPage",
    "StaffRegister",
    "ForgotPassword",
    "ResetPassword",
    # Error boundary used on shop routes
    "StorefrontErrorBoundary",
    # Compare tray rendered globally (sits next to Routes)
    "CompareTray",
}

src = APP.read_text()
lines = src.split("\n")

# Pattern A: `import Foo from './pages/admin/Foo';`  → default import
RE_DEFAULT_ADMIN = re.compile(
    r"^import\s+(\w+)\s+from\s+'(\./pages/(?:admin|shop|public|customer|auth)/[^']+)';\s*$"
)
# Pattern B: `import { Foo } from './pages/admin/Foo';` → named export
RE_NAMED_ADMIN = re.compile(
    r"^import\s+\{\s*(\w+)\s*\}\s+from\s+'(\./pages/(?:admin|shop|public|customer|auth)/[^']+)';\s*$"
)

converted = 0
out_lines = []
for line in lines:
    m = RE_DEFAULT_ADMIN.match(line)
    if m:
        name, path = m.group(1), m.group(2)
        if name in EAGER_KEEP:
            out_lines.append(line)
            continue
        out_lines.append(f"const {name} = React.lazy(() => import('{path}'));")
        converted += 1
        continue
    m = RE_NAMED_ADMIN.match(line)
    if m:
        name, path = m.group(1), m.group(2)
        if name in EAGER_KEEP:
            out_lines.append(line)
            continue
        out_lines.append(
            f"const {name} = React.lazy(() => import('{path}').then(m => ({{ default: m.{name} }})));"
        )
        converted += 1
        continue
    out_lines.append(line)

APP.write_text("\n".join(out_lines))
print(f"Converted {converted} imports to React.lazy()", file=sys.stderr)
