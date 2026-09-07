// Tile Station - Verona Sync Extension
// Background Service Worker
// v6.1 - TERMINATION-PROOF SYNC ENGINE + SELF-DIAGNOSTICS
//
// Manifest V3 browsers (Chrome/Edge) KILL service workers at any moment,
// even mid-sync. v6.0 made the job survive that (state in chrome.storage,
// chrome.alarms watchdog). v6.1 adds what was missing when it DID fail:
//   • an error log (last 30 problems, with the page title / HTTP status)
//   • Cloudflare-check detection → sync PAUSES instead of failing every product
//   • 3 server rejections in a row → PAUSE with the HTTP status shown
//   • PING / CHECK_API / SEND_REPORT so the popup can self-check and post a
//     diagnostics report to Tile Station (Sync Hub → Verona shows it)

const VERSION = '6.1.0';
const DEFAULT_API_URL = 'https://tile-station-production.up.railway.app';
// Known Tile Station backend locations — the extension auto-detects the first
// one that responds so a future backend migration never breaks syncing.
const API_CANDIDATES = [
  'https://tile-station-production.up.railway.app',
  'https://www.tilestation.co.uk'
];

const JOB_KEY = 'syncJob';
const ERR_KEY = 'errorLog';
const WATCHDOG = 'verona-sync-watchdog';
const CLOUDFLARE_RE = /just a moment|attention required|checking your browser|verify you are human|cloudflare|access denied|sorry, you have been blocked/i;

// True only while THIS worker instance is actively running the loop.
let loopActive = false;

// ============ ERROR LOG ============

async function logError(context, detail) {
  try {
    const stored = await chrome.storage.local.get([ERR_KEY]);
    const log = stored[ERR_KEY] || [];
    log.push({ at: new Date().toISOString(), context, detail });
    while (log.length > 30) log.shift();
    await chrome.storage.local.set({ [ERR_KEY]: log });
  } catch (e) { /* storage unavailable — nothing else to do */ }
  console.error(`[${context}]`, detail);
}

async function getErrors() {
  const stored = await chrome.storage.local.get([ERR_KEY]);
  return stored[ERR_KEY] || [];
}

async function resolveApiUrl(preferred) {
  const candidates = [preferred, ...API_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i);
  const tried = [];
  for (const base of candidates) {
    const clean = base.replace(/\/$/, '');
    try {
      const r = await fetch(`${clean}/api/supplier-sync/verona/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: [], source: `connection_test_v${VERSION}` })
      });
      if (r.ok) {
        console.log(`API connection OK: ${clean}`);
        return { url: clean, tried };
      }
      tried.push(`${clean} → HTTP ${r.status}`);
    } catch (e) {
      tried.push(`${clean} → ${e.message}`);
    }
  }
  await logError('api-unreachable', tried.join(' | '));
  return { url: null, tried };
}

// ============ PERSISTED JOB STATE ============

async function getJob() {
  const result = await chrome.storage.local.get([JOB_KEY]);
  return result[JOB_KEY] || null;
}

async function setJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

function jobToState(job) {
  if (!job) {
    return { isRunning: false, isPaused: false, status: 'idle', currentIndex: 0, totalProducts: 0, synced: 0, failed: 0, skipped: 0, failedProducts: [], lastStatus: '', lastProgress: 0, syncMode: 'light' };
  }
  return {
    isRunning: job.status === 'running',
    isPaused: job.status === 'paused',
    status: job.status,
    currentIndex: job.nextIndex,
    totalProducts: job.total,
    synced: job.synced,
    failed: job.failed,
    skipped: job.skipped,
    failedProducts: (job.failedProducts || []).slice(-20),
    lastStatus: job.lastStatus,
    lastProgress: job.lastProgress,
    syncMode: job.syncMode,
    apiUrl: job.apiUrl,
    startedAt: job.startedAt
  };
}

// ============ SYNC HISTORY (Smart Sync skip) ============

async function getSyncedProducts() {
  const result = await chrome.storage.local.get(['syncedProducts']);
  return result.syncedProducts || {};
}

async function markProductSynced(url, sku) {
  const synced = await getSyncedProducts();
  const key = sku || url;
  synced[key] = { url, sku, syncedAt: new Date().toISOString() };
  await chrome.storage.local.set({ syncedProducts: synced });
}

async function isProductSynced(url, sku) {
  const synced = await getSyncedProducts();
  if (sku && synced[sku]) return true;
  if (synced[url]) return true;
  return false;
}

async function clearSyncHistory() {
  await chrome.storage.local.set({ syncedProducts: {} });
  console.log('Sync history cleared');
}

async function getSyncHistoryStats() {
  const synced = await getSyncedProducts();
  return { count: Object.keys(synced).length };
}

// ============ MESSAGES FROM POPUP ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message.type);

  switch (message.type) {
    case 'PING':
      sendResponse({ ok: true, version: VERSION });
      return false;

    case 'CHECK_API':
      resolveApiUrl(message.apiUrl).then(r => sendResponse(r)).catch(e => sendResponse({ url: null, tried: [e.message] }));
      return true;

    case 'GET_SYNC_STATE':
      getJob().then(job => sendResponse(jobToState(job)));
      return true;

    case 'GET_ERRORS':
      getErrors().then(log => sendResponse({ errors: log })).catch(() => sendResponse({ errors: [] }));
      return true;

    case 'CLEAR_ERRORS':
      chrome.storage.local.set({ [ERR_KEY]: [] }).then(() => sendResponse({ cleared: true }));
      return true;

    case 'SEND_REPORT':
      sendReport(message.apiUrl, message.report)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'START_FULL_SYNC':
      startFullSync(message.tabId, message.productUrls, message.apiUrl, message.syncMode || 'full')
        .then(result => console.log('Full sync started:', result))
        .catch(async (error) => {
          await logError('start-sync', error.message);
          await setJob({
            status: 'error', urls: [], nextIndex: 0, total: 0, synced: 0, failed: 0, skipped: 0,
            failedProducts: [], lastStatus: `Error: ${error.message}`, lastProgress: 0,
            syncMode: message.syncMode || 'full'
          });
        });
      sendResponse({ started: true });
      break;

    case 'RESUME_SYNC':
      (async () => {
        const job = await getJob();
        if (job && (job.status === 'paused' || job.status === 'stopped') && job.nextIndex < (job.urls || []).length) {
          job.status = 'running';
          job.apiFailStreak = 0;
          job.lastStatus = `Resuming from product ${job.nextIndex + 1}/${job.urls.length}…`;
          await setJob(job);
          chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
          runLoop();
          sendResponse({ resumed: true });
        } else {
          sendResponse({ resumed: false });
        }
      })();
      return true;

    case 'STOP_SYNC':
      (async () => {
        const job = await getJob();
        if (job && (job.status === 'running' || job.status === 'paused')) {
          job.status = 'stopped';
          job.lastStatus = 'Sync stopped by user';
          await setJob(job);
        }
        chrome.alarms.clear(WATCHDOG);
        sendResponse({ stopped: true });
      })();
      return true;

    case 'CLEAR_SYNC_HISTORY':
      clearSyncHistory()
        .then(() => sendResponse({ cleared: true }))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'GET_SYNC_HISTORY':
      getSyncHistoryStats()
        .then(stats => sendResponse(stats))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'QUICK_SYNC':
      quickSync(message.tabId, message.products, message.apiUrl)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true;
});

// ============ DIAGNOSTICS REPORT → Tile Station ============

async function sendReport(apiUrl, report) {
  const { url } = await resolveApiUrl(apiUrl);
  if (!url) throw new Error('Cannot reach the Tile Station server to send the report');
  const job = await getJob();
  const payload = {
    version: VERSION,
    report: {
      ...report,
      job: jobToState(job),
      errors: await getErrors(),
      syncHistory: await getSyncHistoryStats(),
      userAgent: navigator.userAgent,
      sentAt: new Date().toISOString()
    }
  };
  const r = await fetch(`${url}/api/supplier-sync/verona/extension-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Report rejected: HTTP ${r.status}`);
  return { ok: true, url, ...(await r.json().catch(() => ({}))) };
}

// ============ WATCHDOG: revive the scan after ANY worker termination ============

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  const job = await getJob();
  if (job && job.status === 'running') {
    if (!loopActive) {
      console.log(`[WATCHDOG] Worker was terminated mid-sync — resuming from product ${job.nextIndex + 1}/${job.urls.length}`);
      runLoop();
    }
  } else {
    chrome.alarms.clear(WATCHDOG);
  }
});

// Also resume instantly whenever the worker boots up with an unfinished job
(async () => {
  try {
    const job = await getJob();
    if (job && job.status === 'running') {
      console.log(`[BOOT] Unfinished sync found — resuming from product ${job.nextIndex + 1}/${job.urls.length}`);
      chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
      runLoop();
    }
  } catch (e) {
    console.warn('Boot resume check failed:', e.message);
  }
})();

// Quick sync - just send products from listing page
async function quickSync(tabId, products, apiUrl) {
  const { url: workingUrl } = await resolveApiUrl(apiUrl);
  if (!workingUrl) {
    throw new Error('Cannot reach the Tile Station server — check your internet connection or the API URL in settings');
  }
  const response = await fetch(`${workingUrl}/api/supplier-sync/verona/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products,
      source: `browser_extension_v${VERSION}_quick`,
      timestamp: new Date().toISOString()
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    await logError('quick-sync', `HTTP ${response.status} ${errorData.detail || ''}`);
    throw new Error(errorData.detail || `API error: ${response.status}`);
  }

  const result = await response.json();
  return { success: true, synced: result.synced || products.length };
}

// ============ FULL SYNC: create the persisted job, then run the loop ============

async function startFullSync(tabId, productUrls, apiUrl, syncMode = 'full') {
  const existing = await getJob();
  if (existing && existing.status === 'running' && loopActive) {
    throw new Error('Sync already in progress');
  }

  // Auto-detect the working backend BEFORE starting
  const { url: workingUrl, tried } = await resolveApiUrl(apiUrl);
  if (!workingUrl) {
    throw new Error(`Cannot reach the Tile Station server (${tried.join('; ')})`);
  }

  const isLightMode = syncMode === 'light';
  console.log(`Starting sync in ${isLightMode ? 'LIGHT' : 'FULL'} mode`);

  // Filter out already synced products BEFORE starting
  const urlsToSync = [];
  const alreadySynced = [];

  for (const url of productUrls) {
    const urlMatch = url.match(/\/([a-z])(\d+)/i);
    const potentialSku = urlMatch ? (urlMatch[1].toUpperCase() + urlMatch[2]) : null;
    if (await isProductSynced(url, potentialSku)) alreadySynced.push(url);
    else urlsToSync.push(url);
  }

  console.log(`Found ${productUrls.length} products total — already synced: ${alreadySynced.length}, to sync: ${urlsToSync.length}`);

  const job = {
    status: 'running',
    urls: urlsToSync,
    nextIndex: 0,
    total: productUrls.length,
    synced: 0,
    failed: 0,
    skipped: alreadySynced.length,
    failedProducts: [],
    apiFailStreak: 0,
    apiUrl: workingUrl,
    syncMode,
    tabId,
    startedAt: new Date().toISOString(),
    lastStatus: urlsToSync.length > 0
      ? `Starting ${isLightMode ? '⚡LIGHT' : '📦FULL'} sync: ${urlsToSync.length} new products (${alreadySynced.length} already synced)...`
      : `All ${alreadySynced.length} products already synced!`,
    lastProgress: alreadySynced.length > 0 ? Math.round((alreadySynced.length / productUrls.length) * 100) : 0
  };

  if (urlsToSync.length === 0) {
    job.status = 'complete';
    job.lastProgress = 100;
    job.lastStatus = `All ${alreadySynced.length} products already synced! Go to next page → (or Clear History to re-sync them)`;
    await setJob(job);
    chrome.runtime.sendMessage({ type: 'SYNC_COMPLETE', synced: 0, skipped: alreadySynced.length, failed: 0, total: productUrls.length }).catch(() => {});
    return { started: true, finished: true };
  }

  await setJob(job);
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  runLoop(); // deliberately not awaited — the loop persists its own progress
  return { started: true };
}

// Navigate the sync tab; if the user closed it, open a fresh background tab
async function ensureTab(tabId, url) {
  try {
    await chrome.tabs.update(tabId, { url });
    return tabId;
  } catch (e) {
    console.warn('Sync tab is gone — opening a new background tab');
    const tab = await chrome.tabs.create({ url, active: false });
    return tab.id;
  }
}

// Persist loop progress WITHOUT stomping an externally-set status (e.g. user Stop)
async function persistProgress(job) {
  const stored = await getJob();
  if (stored && stored.status !== 'running') {
    job.status = stored.status;
    job.lastStatus = stored.lastStatus || job.lastStatus;
  }
  await setJob(job);
  return job;
}

async function pauseJob(job, reason) {
  job.status = 'paused';
  job.lastStatus = reason;
  await setJob(job);
  chrome.alarms.clear(WATCHDOG);
  chrome.runtime.sendMessage({ type: 'SYNC_PAUSED', reason }).catch(() => {});
}

// What is the sync tab actually showing? (used when extraction finds nothing)
async function peekPage(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        title: document.title,
        h1: (document.querySelector('h1') || {}).textContent || '',
        url: location.href,
        text: (document.body && document.body.innerText || '').slice(0, 300)
      })
    });
    return r[0]?.result || {};
  } catch (e) {
    return { error: e.message };
  }
}

// ============ THE RESUMABLE LOOP ============

async function runLoop() {
  if (loopActive) return;
  loopActive = true;
  try {
    let job = await getJob();

    while (job && job.status === 'running' && job.nextIndex < job.urls.length) {
      const i = job.nextIndex;
      const url = job.urls[i];
      const isLightMode = job.syncMode === 'light';
      const totalProcessed = job.skipped + i + 1;

      job.lastProgress = Math.round((totalProcessed / job.total) * 100);
      job.lastStatus = `${isLightMode ? '⚡' : '📦'} Syncing ${i + 1}/${job.urls.length} (${job.skipped} skipped)`;
      job = await persistProgress(job);
      if (job.status !== 'running') break;

      let advance = true;
      try {
        const newTabId = await ensureTab(job.tabId, url);
        if (newTabId !== job.tabId) {
          job.tabId = newTabId;
          await setJob(job);
        }

        await waitForPageLoad(job.tabId, isLightMode ? 1000 : 2000);

        const extractResult = await chrome.scripting.executeScript({
          target: { tabId: job.tabId },
          func: isLightMode ? extractProductDetailsLight : extractProductDetails
        });
        const product = extractResult[0]?.result;

        if (product && product.name && !CLOUDFLARE_RE.test(product.name)) {
          let response = null;
          try {
            response = await fetch(`${job.apiUrl}/api/supplier-sync/verona/receive`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                products: [product],
                source: `browser_extension_v${VERSION}_${isLightMode ? 'light' : 'full'}`,
                timestamp: new Date().toISOString()
              })
            });
          } catch (netErr) {
            await logError('api-network', `${netErr.message} — ${url}`);
          }

          if (response && response.ok) {
            job.synced++;
            job.apiFailStreak = 0;
            await markProductSynced(url, product.sku);
            console.log(`✓ Synced & saved: ${product.name} (${product.sku})`);
          } else {
            job.failed++;
            job.failedProducts.push(product.name || url);
            job.apiFailStreak = (job.apiFailStreak || 0) + 1;
            const status = response ? `HTTP ${response.status}` : 'network error';
            if (response) await logError('api-rejected', `${status} for ${product.sku || url}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
            if (job.apiFailStreak >= 3) {
              job.nextIndex = i + 1;
              await pauseJob(job, `⛔ Paused — the Tile Station server rejected 3 products in a row (${status}). Check your connection, then press Resume.`);
              break;
            }
          }
        } else {
          // Nothing extracted — find out WHY so the popup can say so
          const peek = await peekPage(job.tabId);
          const blocked = CLOUDFLARE_RE.test(`${peek.title} ${peek.h1} ${peek.text}`);
          if (blocked) {
            await logError('cloudflare', `Security check on ${url}: "${peek.title}"`);
            // Do NOT advance — this product still needs syncing after the check is solved
            job.nextIndex = i;
            advance = false;
            await pauseJob(job, `⛔ Paused — Verona is showing a Cloudflare security check. Click the Verona tab, complete the check, then press Resume.`);
            break;
          }
          job.failed++;
          job.failedProducts.push(url);
          await logError('extract-empty', `No product on ${url} — title "${peek.title}", h1 "${(peek.h1 || '').trim().slice(0, 80)}"`);
        }
      } catch (e) {
        job.failed++;
        job.failedProducts.push(url);
        await logError('loop', `${e.message} — ${url}`);
      }

      if (!advance) break;

      // Persist progress after EVERY product — a worker kill can never lose position
      job.nextIndex = i + 1;
      job = await persistProgress(job);
      if (job.status !== 'running') break;

      await sleep(job.syncMode === 'light' ? 100 : 300);
      job = await getJob();
    }

    // Finished (or stopped / paused)
    if (job && job.status === 'running') {
      job.status = 'complete';
      job.lastProgress = 100;
      const skippedText = job.skipped > 0 ? ` (${job.skipped} skipped)` : '';
      const modeEmoji = job.syncMode === 'light' ? '⚡' : '📦';
      job.lastStatus = job.failed > 0
        ? `${modeEmoji} Done! Synced ${job.synced}/${job.total}${skippedText}. ${job.failed} failed — see "Recent problems".`
        : `${modeEmoji} Complete! Synced ${job.synced}${skippedText}. Go to next page →`;
      await setJob(job);
      chrome.alarms.clear(WATCHDOG);
      chrome.runtime.sendMessage({ type: 'SYNC_COMPLETE', synced: job.synced, skipped: job.skipped, failed: job.failed, total: job.total }).catch(() => {});
    } else if (job && job.status !== 'running') {
      chrome.alarms.clear(WATCHDOG);
    }
  } finally {
    loopActive = false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wait for page to fully load
async function waitForPageLoad(tabId, extraDelay = 1000) {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 30;

    const check = async () => {
      attempts++;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.readyState
        });
        if (results[0]?.result === 'complete' || attempts >= maxAttempts) {
          setTimeout(resolve, extraDelay);
          return;
        }
      } catch (e) {
        if (attempts >= maxAttempts) {
          setTimeout(resolve, extraDelay);
          return;
        }
      }
      setTimeout(check, 200);
    };

    check();
  });
}

// ============================================================
// FUNCTION INJECTED INTO PAGE - Extract product details
// ============================================================
function extractProductDetails() {
  console.log('=== Tile Station v6.1: Extracting Product Details ===');
  const product = { url: window.location.href };

  // ============ GET PRODUCT NAME ============
  const titleSelectors = ['h1.page-title', 'h1[itemprop="name"]', '.product-info-main h1', 'h1'];
  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) {
      product.name = el.textContent.trim();
      break;
    }
  }
  if (!product.name) return null;

  // ============ GET SIZE FROM TABLE OR PAGE ============
  const pageText = document.body.innerText;
  const tables = document.querySelectorAll('table');

  for (const table of tables) {
    for (const row of table.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if ((label === 'size' || label === 'tile size' || label === 'dimensions') && value) { product.size = value; break; }
      }
    }
    if (product.size) break;
  }
  if (!product.size) {
    for (const pattern of [/(\d{2,4})\s*[xX×]\s*(\d{2,4})\s*(cm|mm)?/, /(\d{2,3})\s*[xX×]\s*(\d{2,3})/]) {
      const match = pageText.match(pattern);
      if (match) { product.size = match[0].trim(); break; }
    }
  }

  // ============ GET FINISH FROM TABLE OR NAME ============
  for (const table of tables) {
    for (const row of table.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if ((label === 'finish' || label === 'surface' || label === 'texture') && value) { product.finish = value; break; }
      }
    }
    if (product.finish) break;
  }
  if (!product.finish) {
    const nameLower = product.name.toLowerCase();
    for (const finish of ['matt', 'matte', 'polished', 'gloss', 'glossy', 'satin', 'lappato', 'honed', 'natural', 'textured']) {
      if (nameLower.includes(finish)) { product.finish = finish.charAt(0).toUpperCase() + finish.slice(1); break; }
    }
  }

  // ============ GET PRODUCT CODE/SKU ============
  for (const table of tables) {
    for (const row of table.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (label === 'code' && value) { product.sku = value; break; }
      }
    }
    if (product.sku) break;
  }
  if (!product.sku) {
    const urlMatch = window.location.href.match(/\/([a-z])(\d+)/i);
    if (urlMatch) product.sku = urlMatch[1].toUpperCase() + urlMatch[2];
  }

  // ============ GET PRICE PER M² ============
  for (const pattern of [/£([\d.]+)\s*per\s*m²/i, /£([\d.]+)\s*per\s*m2/i, /£([\d.]+)\s*\/\s*m²/i, /£([\d.]+)\s*\/m²/i, /£([\d.]+)\s*m²/i]) {
    const match = pageText.match(pattern);
    if (match) { product.price = parseFloat(match[1]); break; }
  }

  // ============ GET STOCK INFORMATION ============
  let stockFound = false;
  if (pageText.match(/out\s*of\s*stock/i)) {
    product.in_stock = false; product.stock_quantity = 0; product.stock_m2 = 0; stockFound = true;
  }
  if (!stockFound) {
    for (const pattern of [/in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m²?\)/i, /in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m2?\)/i, /in\s*stock[:\s]+(\d[\d,]*)/i]) {
      const match = pageText.match(pattern);
      if (match) {
        const firstNum = parseInt(match[1].replace(/,/g, ''));
        const secondNum = match[2] ? parseInt(match[2]) : null;
        product.stock_quantity = firstNum;
        if (secondNum !== null) product.stock_m2 = secondNum;
        product.in_stock = firstNum > 0;
        stockFound = true;
        break;
      }
    }
  }
  if (!stockFound) { product.in_stock = false; product.stock_quantity = 0; product.stock_m2 = 0; }

  // ============ GET PRODUCT IMAGE ============
  for (const selector of ['.gallery-placeholder__image', '.product-image-photo', '.fotorama__img', '.product-image img', 'img[src*="catalog/product"]', 'img[src*="media/catalog"]']) {
    const img = document.querySelector(selector);
    if (img) {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy');
      if (src && src.startsWith('http')) { product.image = src; break; }
    }
  }

  return product;
}

// ============================================================
// LIGHT MODE EXTRACTION - Only stock, price, SKU (FAST!)
// ============================================================
function extractProductDetailsLight() {
  const product = { url: window.location.href };

  for (const selector of ['h1.page-title', 'h1[itemprop="name"]', '.product-info-main h1', 'h1']) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) { product.name = el.textContent.trim(); break; }
  }
  if (!product.name) return null;

  const pageText = document.body.innerText;

  for (const table of document.querySelectorAll('table')) {
    for (const row of table.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (label === 'code' && value) { product.sku = value; break; }
      }
    }
    if (product.sku) break;
  }
  if (!product.sku) {
    const urlMatch = window.location.href.match(/\/([a-z])(\d+)/i);
    if (urlMatch) product.sku = urlMatch[1].toUpperCase() + urlMatch[2];
  }

  for (const pattern of [/£([\d.]+)\s*per\s*m²/i, /£([\d.]+)\s*per\s*m2/i, /£([\d.]+)\s*\/\s*m²/i, /£([\d.]+)\s*\/m²/i, /£([\d.]+)\s*m²/i]) {
    const match = pageText.match(pattern);
    if (match) { product.price = parseFloat(match[1]); break; }
  }

  if (pageText.match(/out\s*of\s*stock/i)) {
    product.in_stock = false; product.stock_quantity = 0; product.stock_m2 = 0;
  } else {
    let stockFound = false;
    for (const pattern of [/in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m²?\)/i, /in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m2?\)/i, /in\s*stock[:\s]+(\d[\d,]*)/i]) {
      const match = pageText.match(pattern);
      if (match) {
        const firstNum = parseInt(match[1].replace(/,/g, ''));
        const secondNum = match[2] ? parseInt(match[2]) : null;
        product.stock_quantity = firstNum;
        if (secondNum !== null) product.stock_m2 = secondNum;
        product.in_stock = firstNum > 0;
        stockFound = true;
        break;
      }
    }
    if (!stockFound) { product.in_stock = false; product.stock_quantity = 0; product.stock_m2 = 0; }
  }

  return product;
}

console.log(`Tile Station Background Service Worker v${VERSION} loaded (termination-proof engine + diagnostics)`);
