
## 10 Aug 2026 — CRITICAL TOOLING LESSON
NEVER run multiple search_replace/insert_text edits on the SAME file in one parallel batch.
Parallel writes race and corrupt large files (happened twice: tiles.py ~2954 lines, supplier_sync.py ~15044 lines — duplicated/mangled tail blocks).
Rule: batch edits to DIFFERENT files in parallel; edits to the SAME file must be sequential (or combined into one search_replace).
