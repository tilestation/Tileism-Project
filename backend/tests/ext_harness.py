"""
End-to-end harness for the Verona Chrome extension (v6.1) — loads the unpacked
extension into headless Chromium, maps www.veronagroup.co.uk to the local mock
server (/tmp/mockverona/server.py on :80) and drives the popup like a user.
Run: python3 /app/backend/tests/ext_harness.py
"""
import asyncio, json, os, sys, time, urllib.request
from playwright.async_api import async_playwright

EXT = "/app/backend/extensions-final/TileStation-Verona"
API = open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split()[0].strip()
MOCK = "http://www.veronagroup.co.uk"


def api_json(path):
    req = urllib.request.Request(f"{API}{path}", headers={"User-Agent": "Mozilla/5.0 ext-harness"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def mock_cf(action, code):
    urllib.request.urlopen(f"http://127.0.0.1/__cf/{action}/{code}", timeout=5).read()


async def main():
    results = []
    def ok(name, cond, detail=""):
        results.append((name, bool(cond), detail))
        print(("PASS" if cond else "FAIL"), name, detail)

    staged_before = api_json("/api/supplier-sync/verona/last-receive")["staged_count"]

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            "/tmp/ext-profile-" + str(int(time.time())),
            executable_path="/usr/bin/chromium",
            headless=True,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--host-resolver-rules=MAP www.veronagroup.co.uk 127.0.0.1, MAP veronagroup.co.uk 127.0.0.1",
                "--no-sandbox",
            ],
        )
        # find the service worker → extension id
        sw = None
        for _ in range(50):
            if ctx.service_workers:
                sw = ctx.service_workers[0]; break
            await asyncio.sleep(0.2)
        if not sw:
            sw = await ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        print("extension id", ext_id)

        # 1. Verona mock listing tab (active)
        verona = await ctx.new_page()
        await verona.goto(f"{MOCK}/tiles?product_list_limit=500")
        ok("mock listing loads", "Mock Tile 1" in await verona.content())

        # 2. popup as a tab; point apiUrl at the preview backend
        popup = await ctx.new_page()
        await popup.goto(f"chrome-extension://{ext_id}/popup.html")
        await popup.evaluate(f"chrome.storage.local.set({{apiUrl: '{API}'}})")
        await popup.reload()
        await asyncio.sleep(3)
        worker = await popup.locator("#check-worker").inner_text()
        server = await popup.locator("#check-server").inner_text()
        ok("self-check: engine ok", "running (v6.1.0)" in worker, worker.strip())
        ok("self-check: server ok", "connected" in server, server.strip())

        # page check with the Verona tab active
        await verona.bring_to_front()
        await popup.evaluate("runSelfCheck()")
        await asyncio.sleep(2.5)
        page_line = await popup.locator("#check-page").inner_text()
        ok("self-check: page finds 7 products", "7 products found" in page_line, page_line.strip())

        # 3. Cloudflare on a product → engine pauses
        mock_cf("on", "p1003")
        await popup.evaluate("document.getElementById('crawl-btn').click()")
        for _ in range(60):
            await asyncio.sleep(1)
            st = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SYNC_STATE'})")
            if st.get("isPaused") or st.get("status") in ("complete", "error", "stopped"):
                break
        ok("cloudflare pauses the sync", st.get("isPaused") and "Cloudflare" in (st.get("lastStatus") or ""), f"{st.get('status')} idx={st.get('currentIndex')} synced={st.get('synced')} :: {st.get('lastStatus')}")
        ok("paused BEFORE the blocked product (2 synced, index 2)", st.get("currentIndex") == 2 and st.get("synced") == 2, f"idx={st.get('currentIndex')} synced={st.get('synced')}")
        await popup.evaluate("checkSyncState()")
        await asyncio.sleep(0.8)
        ok("popup shows PAUSED + Resume button", "PAUSED" in await popup.locator("#status-value").inner_text() and await popup.locator("#resume-btn").is_visible())

        # 4. clear Cloudflare, resume → completes
        mock_cf("off", "p1003")
        await popup.evaluate("document.getElementById('resume-btn').click()")
        for _ in range(90):
            await asyncio.sleep(1)
            st = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SYNC_STATE'})")
            if st.get("status") in ("complete", "error", "stopped", "paused"):
                break
        ok("resume completes the sync with 7 synced / 0 failed", st.get("status") == "complete" and st.get("synced") == 7 and st.get("failed") == 0, f"{st.get('status')} synced={st.get('synced')} failed={st.get('failed')} :: {st.get('lastStatus')}")

        rec = api_json("/api/supplier-sync/verona/last-receive")
        ok("server received v6.1 light data", (rec.get("last_data") or {}).get("source") == "browser_extension_v6.1.0_light", json.dumps(rec.get("last_data")))
        ok("staging grew by 7", rec["staged_count"] - staged_before >= 7, f"{staged_before} → {rec['staged_count']}")

        # 5. second run (back on the listing) skips everything already synced
        await verona.goto(f"{MOCK}/tiles?product_list_limit=500")
        await verona.bring_to_front()
        await popup.evaluate("document.getElementById('crawl-btn').click()")
        await asyncio.sleep(6)
        st = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SYNC_STATE'})")
        ok("smart skip: all 7 already synced", st.get("status") == "complete" and st.get("skipped") == 7, st.get("lastStatus"))

        # 6. error log + send report
        errs = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_ERRORS'})")
        ok("error log recorded the cloudflare event", any(e["context"] == "cloudflare" for e in errs["errors"]), json.dumps(errs["errors"][-1]) if errs["errors"] else "no errors")
        await popup.evaluate("runSelfCheck()")
        await asyncio.sleep(2.5)
        await popup.evaluate("document.getElementById('send-report-btn').click()")
        await asyncio.sleep(4)
        note = await popup.locator("#report-note").inner_text()
        ok("report sent", "Report sent" in note, note)
        rep = api_json("/api/supplier-sync/verona/last-receive")["last_report"]
        ok("server stored report with page scan", rep and rep["version"] == "6.1.0" and rep["worker_ok"] and rep["server_ok"], json.dumps(rep)[:300] if rep else "none")

        # 7. non-Verona page → clear message
        other = await ctx.new_page()
        await other.goto("about:blank")
        await other.bring_to_front()
        await popup.evaluate("runSelfCheck()")
        await asyncio.sleep(2)
        ok("non-Verona tab explained", "open veronagroup.co.uk" in await popup.locator("#check-page").inner_text())

        await ctx.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


asyncio.run(main())
