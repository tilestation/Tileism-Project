# Bulk Editor — P0 Surgical Change Plan (for approval)

Date: 3 Aug 2026 · Fork session · Response to owner's approval of P0 items
Status: NO CODE CHANGES YET — awaiting confirmation.

Owner instructions I'm working to:
- **Do all 3 P0 items** — carefully; do NOT break linked features.
- **Delete "Force Save"** — its functionality subsumed by new Save.
- **Keep the 4 description sections** — just make them clearer. Check business rules first.
- **Draft restore: warn but don't auto-discard** — let user decide.

Below is a section-by-section breakdown of EVERY change I plan to make, EVERY code path I checked, and EVERY linked feature I confirmed will still work.

---

## Business Rule Check for Description Generation (asked to verify)

I read `/app/backend/services/ai_descriptions.py` — the crucial developer note at the top reads:

> "Three older, pre-existing generators still live inline in `server.py`:
> - `/api/products/generate-description` — per-product, OpenAI gpt-4o
> - `/api/products/generate-series-description` — per-series, OpenAI gpt-4o
> - `/api/products/generate-batch-series-descriptions` — batch-of-series
>
> Those were written before this service existed... **They work today so we intentionally do NOT rewrite them**; instead, the SEO-tab bulk tool uses the shared helper here and the UI cross-links to the Bulk Edit flow for richer series-level copy."

**Conclusion**: the 4 description entry points are INTENTIONAL business features. Each has a distinct purpose:

| # | Section | Purpose | Endpoint | Writes to |
|---|---|---|---|---|
| 1 | Description Template (`{color}` placeholders) | Fill placeholders in a template using each product's attributes | `/api/products/generate-description` | Individual product `description` |
| 2 | Shorter / Longer / New Variation | Refine the same template | Same, with `mode: shorter/longer/regenerate` | Same |
| 3 | Unified Series Description (Brief / Standard / Detailed) | One paragraph for a whole collection page | `/api/products/generate-series-description` | `collection_settings.custom_description` + optionally each product |
| 4 | Quick Generate All Series | Auto-detect ALL series, generate for each in one go | `/api/products/generate-batch-series-descriptions` | Same as #3, for many series |
| 5 | Auto-Regeneration Settings | Background scheduler | (settings only) | Cron config |

**My promise**: I will NOT delete/merge any of these. I will only add clearer visual grouping, tooltips, and a "which one should I use?" helper.

---

## P0-1: Unify Save Paths (KEEP behaviour, unify code)

### What Force Save uniquely does today (line 4768–5165)

I read every branch. Force Save's unique bits are:

1. **Per-product loop** — one HTTP call per product, so a mid-batch failure only kills THAT product.
2. **Progress bar** — `setForceSaveProgress({current, total, status})`.
3. **Per-product failure collection** — `failedProducts` array (currently only used to build a toast).
4. **Description template post-save** — line 5041 fires the template-apply endpoint after successful saves.
5. **Snapshot for undo** — line 4902 captures `beforeSnapshot` from `/api/bulk-edit-tools/snapshot`.
6. **NO Dry Run** — bypasses `DryRunPreview` entirely.

### What Save Now (`handleBulkCategoryUpdate`) uniquely does today

1. **Dry Run** — opens `DryRunPreview` modal → user confirms → then saves.
2. **Batch by common payload** — groups products that share the same scoped payload, sends one HTTP call per unique payload (fast for the "no scopes" case).
3. **Sub-selection branch** (line 4306) — special case: if user has sub-selected products AND set a Material != Porcelain, the OTHER products auto-get "Porcelain". (This is a legacy niche behaviour — I need to check with owner if it's still needed.)
4. **`runSaveVerification`** — after save, re-fetches from DB and compares.
5. **`refreshBreakdownsAfterSave`** + `fetchProducts` — refreshes UI.
6. **Toast about auto-published-to-storefront count**.

### Delta between the two — what would break if we simply deleted Force Save

Everything Force Save does uniquely (progress bar, per-product resilience) is a nice-to-have. Everything Save Now does uniquely (Dry Run, verification, refresh) is important.

### THE PLAN

**New unified save flow**:

```
[ Save ] button
     ↓
Dry Run preview (skippable via "Save without preview" checkbox — power-user default off)
     ↓
Backend saves in a SINGLE call: POST /api/supplier-sync/products/bulk-update-unified
   (backend already supports per-product result reporting — I'll wire it through)
     ↓
Per-product result modal: "23 saved · 2 failed" with each failure's reason inline
     ↓
Automatic verification (runSaveVerification, mandatory)
     ↓
Refresh products + breakdowns
```

**Fallback for the "one failed, kill the batch" case**: if any product in the batch fails, the frontend retries ONLY the failed ones individually. This gives you Force Save's per-product resilience automatically — no button needed.

**Progress bar**: still shown, just simpler ("Saving 23 products…" during batch, then "Retrying 2 that failed…" if needed).

**Undo snapshot**: kept intact (already independently useful for Undo).

### FILES TOUCHED

1. `/app/frontend/src/pages/admin/SupplierProducts.js`
   - **DELETE** `handleForceSave` (lines 4768–5165) and its Force Save button (line 13257).
   - **EXTEND** `handleBulkCategoryUpdate` (line 4243+) to:
     - Accept a per-product retry loop after batch save (only for failed products).
     - Always call `runSaveVerification` (currently only sometimes).
     - Build a `perProductResults` array showing exactly which succeeded/failed.
   - **REMOVE** state: `forceSaveProgress` (line ~490 — will re-check when I make the change).
2. `/app/frontend/src/pages/admin/components/supplier-products/BulkCategoryEditorSections.jsx`
   - No changes here.
3. Backend: **NO CHANGES**. `/api/supplier-sync/products/bulk-update-unified` already returns per-product results (line 11220+ in supplier_sync.py) — the frontend just wasn't parsing them.

### LINKED FEATURES CHECKED (WILL STILL WORK)

| Feature | Uses | Verified? |
|---|---|---|
| **Quick Save (cloud icon)** — per-attribute save | `handleQuickSave` (line 5254) | ✅ Untouched. Still writes just its attribute via the same endpoint. |
| **Description template post-save** | `bulkDescriptionSettings.description_template` fire | ✅ I'll move it into the new unified path so it still fires after any bulk save. |
| **Snapshot for undo** | `/api/bulk-edit-tools/snapshot` | ✅ Kept — I'll take snapshot in the new save path too. |
| **Restore Draft** | `saveDraftToServer` / `clearServerDraft` | ✅ Untouched. |
| **Dry Run Preview** | `DryRunPreview.jsx` | ✅ Kept, becomes default. |
| **Presets** | `BulkEditPresets.jsx` | ✅ Untouched. |
| **Edit History** | `BulkEditHistory.jsx` | ✅ Untouched. |
| **Sub-selection Material branch** | `productSubSelection` (line 4306) | ⚠️ **NEED YOUR CONFIRMATION**: this branch says "if you sub-selected 3 products and set Material=Ceramic, the OTHER products auto-get Porcelain". Is this behaviour still desired? If unsure, I'll KEEP it intact as-is. |
| **Publish auto-fires on category change** | Line 11288 (backend) | ✅ Backend untouched. |
| **Auto-Regeneration scheduler** | Separate settings modal | ✅ Untouched. |
| **Tier pricing modal** | `TierPricingModal.jsx` | ✅ Untouched. |
| **Bulk Sale modal** | `BulkSaleModal.jsx` | ✅ Untouched. |
| **Manage Options modal** | `ManageOptionsModal.jsx` | ✅ Untouched. |

### VISIBLE CHANGES in the modal

- **Green "Save Now to N Products"** button stays, renamed to just **"Save"** with subtitle "N products, X pending changes".
- **Amber "Force Save"** button → **DELETED**.
- New tiny **"Save without preview"** power-user checkbox next to the Save button.
- After save: new **"Save Results" popup** listing each product with a ✓ or ✗ and (if failed) the reason.

---

## P0-2: Clarify Description Sections (keep all 4, add signposting)

Owner's instruction: **do NOT merge / consolidate** — just make it clearer which does what.

### Current layout (in the modal, top section)

```
┌─ Description Template ────────────────┐
│ [textarea with {color} placeholders]   │
│ [Generate] [Standard ▼]                │
├─ Shorter / Longer / New Variation ────┤ ← only shows after generation
│ [Shorter] [Longer] [New Variation]     │
├─ Unified Series Description ──────────┤
│ [Brief] [Standard] [Detailed]          │
│ [Quick Generate All Series]            │
├─ Manage Auto-Regeneration ────────────┤
│ [Settings…]                             │
└────────────────────────────────────────┘
```

Problem: 4 boxes, no signposting, easy to forget which does what.

### Proposed layout (same 4 sections, wrapped in a clear parent)

```
┌─ 🖋 Descriptions  ────────────────────────────────────────────┐
│                                                               │
│ ▼ Which one should I use?                                     │
│   • Per-product template — writes to individual products      │
│   • Unified series — writes to the collection page +          │
│     optionally propagates to each product                     │
│                                                               │
│ 1. Per-product Description (individual products)              │
│    ┌ Description Template ────────────────────────────┐       │
│    │ [textarea with {color} etc placeholders]         │       │
│    │ [Generate] [Standard ▼]                          │       │
│    │ (Once generated:) [Shorter] [Longer] [New]       │       │
│    └───────────────────────────────────────────────────┘       │
│                                                               │
│ 2. Unified Series Description (collection page)               │
│    ┌ Series Description ──────────────────────────────┐       │
│    │ Detected series: "Sparta" (3 products selected)  │       │
│    │ [Brief] [Standard] [Detailed]                    │       │
│    │ ─── or ───                                       │       │
│    │ [Quick Generate for All Series]                  │       │
│    └───────────────────────────────────────────────────┘       │
│                                                               │
│ ⚙ Auto-Regeneration → Manage Settings                          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Changes:
- **Add** a parent "Descriptions" collapsible section wrapping everything.
- **Add** a "Which one should I use?" expandable help block.
- **Merge visually** the Description Template + Shorter/Longer/New into ONE box (they're already interlinked — Shorter/Longer only appears after Generate).
- **Rename** "Unified Series Description" → "Series Description" (shorter, clearer).
- **Show** the detected series name explicitly ("Detected series: 'Sparta' (3 products)") so user knows what will be generated.
- **Move** "Manage Auto-Regeneration" out of the four coloured boxes and into a small link at the bottom.

No functional changes. No endpoint changes. No state changes. Just visual grouping and labelling.

### FILES TOUCHED

1. `/app/frontend/src/pages/admin/SupplierProducts.js`
   - Wrap the 4 existing description JSX blocks in a `<Section title="Descriptions">` container.
   - Add the help block.
   - Merge the "Description Template" + "Shorter/Longer/New" blocks (they're already conditionally rendered together).
   - No changes to `handleBulkGenerateDescription`, `handleGenerateSeriesDescription`, `handleOpenBatchSeriesModal`.

### LINKED FEATURES CHECKED (WILL STILL WORK)

| Feature | Endpoint / Handler | Verified? |
|---|---|---|
| Per-product description generation | `/api/products/generate-description` | ✅ Endpoint untouched. |
| Series description generation | `/api/products/generate-series-description` | ✅ Endpoint untouched. |
| Batch series | `/api/products/generate-batch-series-descriptions` | ✅ Endpoint untouched. |
| Bulk-generate from SEO tab (uses ai_descriptions.py) | `/api/products/bulk-generate-descriptions` | ✅ Different tab; untouched. |
| Description save on Force Save | `bulkDescriptionSettings.description_template` | ✅ Will move into new unified save from P0-1. |

---

## P0-3: Draft Restore — Warning Banner (option b, as chosen)

Owner's choice: **warn but don't auto-discard**. Let owner decide.

### Current behaviour (line 9773)

Blue banner shows "Unsaved draft found from {date}" + Restore / Discard buttons. NO age check. NO product-set match check.

### Proposed change

```
┌ 🟡 Unsaved draft from 29/05/2026, 10:14 (68 days ago) ────────┐
│                                                                │
│ Draft was for 5 products from supplier "Splendour".            │
│ You currently have 3 products from "Ceramica Impex" selected. │
│                                                                │
│ ⚠️ The draft doesn't match your current selection.             │
│    Restoring will replace your current changes but keep your  │
│    current product selection — some draft values may not apply.│
│                                                                │
│         [ Restore Anyway ]   [ Discard Draft ]   [ Ignore ]   │
└────────────────────────────────────────────────────────────────┘
```

Rules:
- Banner colour: BLUE if ≤7 days AND same product set, AMBER if >7 days OR different products, RED if >30 days.
- Show:
  - Age in human words: "just now" / "3 hours ago" / "68 days ago".
  - How many products the draft was for, and how many the user has selected now.
  - Which supplier the draft was for (if different from current, flag it prominently).
- 3 buttons (up from 2):
  - **Restore Anyway** — same as today, forces the merge.
  - **Discard Draft** — same as today.
  - **Ignore** — hide the banner for this session only, keep draft on server. (For "I'll come back to this later.")

### FILES TOUCHED

1. `/app/frontend/src/pages/admin/SupplierProducts.js`
   - `recoveredDraft` object is already returned with `updated_at`, `selected_products`, `supplier` (line 1712) — no backend change needed.
   - Add helper `computeDraftFreshness(draft, currentSelectedProducts, currentSupplier)` returning `{ ageDays, sameProducts, sameSupplier, level: 'fresh' | 'stale' | 'ancient' }`.
   - Update the JSX at line 9773 to render the new banner with colour + counts + Ignore button.

### LINKED FEATURES CHECKED (WILL STILL WORK)

| Feature | Handler | Verified? |
|---|---|---|
| Draft auto-save every 30s | `saveDraftToServer` (line 1691) | ✅ Untouched. |
| Draft clear on save | `clearServerDraft` (line 1764) | ✅ Untouched. |
| Draft retrieve on modal open | Similar useEffect | ✅ Untouched. |

---

## Summary of what changes vs stays

### Changes (planned):
1. `handleForceSave` — **DELETED**.
2. `handleBulkCategoryUpdate` — extended with automatic per-product retry, mandatory verification, per-product result modal.
3. Description sections — visually regrouped into a parent "Descriptions" container with a "which one should I use?" help block.
4. Draft-restore banner — new colour-coded + age + supplier/product-mismatch warnings + Ignore button.

### Stays exactly the same:
- ALL backend endpoints.
- ALL 4 description generation endpoints and their business rules.
- ALL 15 sibling components in `/components/supplier-products/`.
- `handleQuickSave` (per-attribute inline save).
- Presets, Edit History, Dry Run Preview, Manage Options, Tier Pricing, Bulk Sale.
- The 5-collection sync fan-out (`sync_staging → supplier_products → products → tiles → collection_settings`).
- Auto-publish rules.
- Undo snapshot system.
- Sub-selection Material branch — ⚠️ AWAITING YOUR CONFIRMATION on whether to keep it.

---

## Blocker I need answered before I write code:

**The Sub-selection Material branch** at line 4306 says:
> "If you sub-selected specific products AND set Material = something other than Porcelain, the OTHER products auto-get Porcelain."

Is this a real business rule you use, or is it legacy weirdness we should strip? Options:

  a. **Keep it** — I preserve it byte-for-byte in the new unified save path. Safe default.
  b. **Strip it** — this behaviour has surprised me at least once and I'd like it gone.
  c. **Not sure** — I'll keep it to be safe.

Answer (a/b/c) and I'll start implementing P0-1 through P0-3 in order.
