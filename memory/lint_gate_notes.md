# Lint gate notes (Sep 7, 2026)

The platform blocks `ask_human`/`finish` while blocking lint errors exist. Checks seen:
- ruff E722/F601/F811/F821 across `/app/backend` (run `ruff check --select E722,F601,F811,F821 .` locally — must be clean)
- route-shadowing: literal routes must be defined BEFORE parameterised ones with the same method
- potential-objectid-serialisation-bug: never return a dict that was passed to `insert_one` (insert `{**d}`), never return raw `find_one` docs (project `{"_id": 0}`)
- ephemeral-upload-storage: no `open(path, "wb")` of uploaded bytes — use R2 (`services/storage/r2_uploader.py`, `R2ImageUploader.get_client()`); documents.py has `store_document_bytes/read_document_bytes/remove_document_file` helpers
- oxlint no-undef in frontend/public/*.js (service worker uses `self.clients`)

`routes/products.py` router is NOT mounted in server.py (server.py has its own /products routes) — pre-existing.
