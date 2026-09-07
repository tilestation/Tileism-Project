# Tile Station - Verona Sync Extension v6.1

Chrome / Edge extension that reads product data from the Verona Group trade
portal (veronagroup.co.uk) while YOU are logged in, and stages it in Tile
Station → Sync Hub → Verona for review.

## What's new in v6.1 — it tells you WHY when something fails

Open the popup and the **Self-check** runs by itself:

| Line | Green means | Red means / what to do |
|---|---|---|
| Extension engine | background worker is alive | open `chrome://extensions`, click ↻ on Tile Station, reopen popup |
| Tile Station server | connected (shows which server) | no internet / wrong API URL — check "API Settings" |
| This Verona page | "N products found on this page" | not a Tiles listing, Cloudflare check showing, or 0 products (scroll once, Re-check) |
| Sync engine state | idle / running / last run summary | PAUSED — read the reason, fix it, press **Resume** |

* **Send report to Tile Station** posts the self-check + last 30 problems to the
  server (Sync Hub → Verona shows the latest report) so support can see exactly
  what went wrong. **Copy** puts the same text on your clipboard.
* **Recent problems** — every failed product / rejected request with the reason.
* **Cloudflare aware** — if Verona shows a security check mid-sync the sync
  PAUSES (no more "300 failed"). Complete the check in the Verona tab → Resume.
* **Server aware** — 3 rejected products in a row pauses with the HTTP status.
* **Resume** continues from the exact product it stopped at.

v6.0 engine kept: the job lives in extension storage and a 30-second watchdog
alarm revives it whenever Chrome kills the background worker — minimise the
browser, keep working, it carries on.

## Install / upgrade (2 minutes)

1. `chrome://extensions` → find **Tile Station - Verona Sync** → **Remove**
2. Unzip this download to a folder you will keep (e.g. `Documents\TileStation-Verona`)
3. `chrome://extensions` → **Developer mode** ON (top right)
4. **Load unpacked** → choose the unzipped folder
5. Click the puzzle icon → pin **Tile Station - Verona Sync**
6. Header must say **Verona Sync v6.1**

## Daily use

1. Log in to veronagroup.co.uk → **Tiles** → set "Show 500 per page" (or any listing)
2. Click the extension → wait for the Self-check to go green
3. Pick **⚡ Light** (stock & price, fast) or **📦 Full** (all details + images)
4. **Sync This Page** → the tab walks through each product; already-synced products are skipped
5. When it says Complete → next page → repeat. Review in Tile Station → Sync Hub → Verona.

**Clear History** forces every product on the page to be synced again (use after a
price change on Verona's side, or if Sync Hub shows nothing new).

## If it still won't sync
Press **Send report to Tile Station** (or **Copy**) and send the reference /
text to support — the report contains the page scan, server test and the error log.
