// Tile Station - Verona Sync Extension
// Popup Script - v6.1 - self-check + diagnostics report + resume

const statusBox = document.getElementById('status-box');
const statusValue = document.getElementById('status-value');
const syncBtn = document.getElementById('sync-btn');
const btnText = document.getElementById('btn-text');
const btnSpinner = document.getElementById('btn-spinner');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const statsContainer = document.getElementById('stats-container');
const productsCount = document.getElementById('products-count');
const syncedCount = document.getElementById('synced-count');
const skippedCount = document.getElementById('skipped-count');
const settingsToggle = document.getElementById('settings-toggle');
const apiConfig = document.getElementById('api-config');
const apiUrlInput = document.getElementById('api-url');
const saveSettingsBtn = document.getElementById('save-settings');
const crawlBtn = document.getElementById('crawl-btn');
const resumeBtn = document.getElementById('resume-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const syncHistoryCount = document.getElementById('sync-history-count');
const modeLightBtn = document.getElementById('mode-light');
const modeFullBtn = document.getElementById('mode-full');
const recheckBtn = document.getElementById('recheck-btn');
const sendReportBtn = document.getElementById('send-report-btn');
const copyReportBtn = document.getElementById('copy-report-btn');
const reportNote = document.getElementById('report-note');
const errorsList = document.getElementById('errors-list');
const errorsCount = document.getElementById('errors-count');
const clearErrorsBtn = document.getElementById('clear-errors-btn');

const VERSION = '6.1.0';
const DEFAULT_API_URL = 'https://tile-station-production.up.railway.app';

let pollInterval = null;
let syncMode = 'light';
let lastCheck = {};   // results of the last self-check (also what gets reported)

// ============ INIT ============

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get(['apiUrl', 'syncMode']);
  // Auto-heal a stored www.tilestation.co.uk URL — the shop domain doesn't serve the API
  if (settings.apiUrl && /tilestation\.co\.uk/i.test(settings.apiUrl)) {
    settings.apiUrl = DEFAULT_API_URL;
    await chrome.storage.local.set({ apiUrl: DEFAULT_API_URL });
  }
  apiUrlInput.value = settings.apiUrl || DEFAULT_API_URL;

  syncMode = settings.syncMode || 'light';
  updateSyncModeUI();
  updateSyncHistoryDisplay();
  loadErrors();
  checkSyncState();
  runSelfCheck();
});

// ============ SELF-CHECK ============

function setCheck(id, state, label, hint) {
  const el = document.getElementById(id);
  el.className = `check-line ${state}`;
  el.innerHTML = `<span class="check-icon">${state === 'ok' ? '✓' : state === 'bad' ? '✗' : '…'}</span><span>${label}${hint ? `<span class="check-hint">${hint}</span>` : ''}</span>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function runSelfCheck() {
  lastCheck = { version: VERSION, at: new Date().toISOString() };
  ['check-worker', 'check-server', 'check-page', 'check-job'].forEach(id => setCheck(id, 'wait', document.getElementById(id).children[1].firstChild.textContent, 'checking…'));

  // 1. Background worker
  let workerOk = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PING' });
    workerOk = !!(r && r.ok);
    lastCheck.worker = workerOk ? `ok v${r.version}` : `bad response ${JSON.stringify(r)}`;
    setCheck('check-worker', workerOk ? 'ok' : 'bad', 'Extension engine', workerOk ? `running (v${r.version})` : 'not responding — open chrome://extensions and click the ↻ reload icon on Tile Station');
  } catch (e) {
    lastCheck.worker = `error: ${e.message}`;
    setCheck('check-worker', 'bad', 'Extension engine', `not responding (${esc(e.message)}) — open chrome://extensions → click ↻ on Tile Station, then reopen this popup`);
  }

  // 2. Server
  const settings = await chrome.storage.local.get(['apiUrl']);
  const apiUrl = settings.apiUrl || DEFAULT_API_URL;
  lastCheck.apiUrlStored = apiUrl;
  if (workerOk) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'CHECK_API', apiUrl });
      lastCheck.server = r;
      if (r && r.url) setCheck('check-server', 'ok', 'Tile Station server', `connected — ${esc(r.url.replace(/^https?:\/\//, ''))}`);
      else setCheck('check-server', 'bad', 'Tile Station server', `unreachable: ${esc((r && r.tried || []).join(' · ') || 'no response')} — check your internet / the API URL below`);
    } catch (e) {
      lastCheck.server = { error: e.message };
      setCheck('check-server', 'bad', 'Tile Station server', esc(e.message));
    }
  } else {
    setCheck('check-server', 'bad', 'Tile Station server', 'skipped — engine not responding');
  }

  // 3. Page
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    lastCheck.tab = { url: tab && tab.url, title: tab && tab.title };
    const isVerona = /verona|vfrg/i.test(tab.url || '');
    if (!isVerona) {
      lastCheck.page = { notVerona: true };
      setCheck('check-page', 'bad', 'This Verona page', `you're on ${esc((tab.url || '').replace(/^https?:\/\//, '').slice(0, 50))} — open veronagroup.co.uk → Tiles listing first`);
    } else {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanListingPage });
      const scan = results[0]?.result || {};
      lastCheck.page = { ...scan, urls: (scan.urls || []).slice(0, 5), urlCount: (scan.urls || []).length };
      if (scan.cloudflare) {
        setCheck('check-page', 'bad', 'This Verona page', `Cloudflare security check is showing ("${esc(scan.title)}") — complete it in the tab, then Re-check`);
      } else if (scan.isDetail) {
        setCheck('check-page', 'ok', 'This Verona page', `single product page — "Sync Current Page" will sync just this product`);
      } else if ((scan.urls || []).length > 0) {
        setCheck('check-page', 'ok', 'This Verona page', `${scan.urls.length} product${scan.urls.length !== 1 ? 's' : ''} found on this page${scan.needsLogin ? ' · ⚠ you look logged OUT of Verona — prices/stock may be hidden' : ''}`);
      } else {
        setCheck('check-page', 'bad', 'This Verona page', `0 products found (${scan.productItems} product boxes, ${scan.anchors} links, title "${esc(scan.title)}") — is this a Tiles listing? Scroll down once and Re-check`);
      }
    }
  } catch (e) {
    lastCheck.page = { error: e.message };
    setCheck('check-page', 'bad', 'This Verona page', `can't read the page: ${esc(e.message)} — reload the Verona tab and reopen this popup`);
  }

  // 4. Job
  try {
    const state = workerOk ? await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' }) : null;
    lastCheck.job = state;
    if (!state || state.status === 'idle' || !state.totalProducts) setCheck('check-job', 'ok', 'Sync engine state', 'idle — ready to start');
    else if (state.isRunning) setCheck('check-job', 'ok', 'Sync engine state', `running — ${state.currentIndex}/${state.totalProducts - state.skipped} done, ${state.synced} sent`);
    else if (state.isPaused) setCheck('check-job', 'bad', 'Sync engine state', `PAUSED — ${esc(state.lastStatus)}`);
    else setCheck('check-job', state.failed > 0 ? 'bad' : 'ok', 'Sync engine state', `last run: ${state.synced} sent, ${state.failed} failed, ${state.skipped} skipped (${state.status})`);
  } catch (e) {
    setCheck('check-job', 'bad', 'Sync engine state', esc(e.message));
  }
}

recheckBtn.addEventListener('click', () => { loadErrors(); runSelfCheck(); });

function buildReportText() {
  return JSON.stringify(lastCheck, null, 2);
}

copyReportBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(buildReportText());
    reportNote.textContent = 'Diagnostics copied — paste them to support.';
    reportNote.classList.remove('hidden');
  } catch (e) {
    reportNote.textContent = `Copy failed: ${e.message}`;
    reportNote.classList.remove('hidden');
  }
});

sendReportBtn.addEventListener('click', async () => {
  sendReportBtn.disabled = true;
  sendReportBtn.textContent = 'Sending…';
  reportNote.classList.add('hidden');
  try {
    const settings = await chrome.storage.local.get(['apiUrl']);
    const r = await chrome.runtime.sendMessage({ type: 'SEND_REPORT', apiUrl: settings.apiUrl || DEFAULT_API_URL, report: lastCheck });
    if (r && r.ok) {
      reportNote.textContent = `✓ Report sent to Tile Station (Sync Hub → Verona shows it). Ref ${r.id || ''}`;
    } else {
      reportNote.textContent = `✗ Could not send: ${(r && r.error) || 'unknown error'} — use Copy instead`;
    }
  } catch (e) {
    reportNote.textContent = `✗ Could not send: ${e.message} — use Copy instead`;
  } finally {
    reportNote.classList.remove('hidden');
    sendReportBtn.disabled = false;
    sendReportBtn.textContent = 'Send report to Tile Station';
  }
});

// ============ ERROR LOG ============

async function loadErrors() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_ERRORS' });
    const errors = (r && r.errors) || [];
    errorsCount.textContent = errors.length;
    errorsList.innerHTML = errors.slice().reverse().map(e =>
      `<li><small>${esc(new Date(e.at).toLocaleString())}</small> <b>${esc(e.context)}</b> — ${esc(e.detail)}</li>`
    ).join('') || '<li style="color:#6b7280">No problems recorded.</li>';
  } catch (e) {
    errorsCount.textContent = '?';
  }
}

clearErrorsBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ type: 'CLEAR_ERRORS' });
  loadErrors();
});

// ============ SYNC MODE ============

if (modeLightBtn) {
  modeLightBtn.addEventListener('click', async () => {
    syncMode = 'light'; updateSyncModeUI();
    await chrome.storage.local.set({ syncMode: 'light' });
  });
}
if (modeFullBtn) {
  modeFullBtn.addEventListener('click', async () => {
    syncMode = 'full'; updateSyncModeUI();
    await chrome.storage.local.set({ syncMode: 'full' });
  });
}

function updateSyncModeUI() {
  if (modeLightBtn && modeFullBtn) {
    modeLightBtn.classList.toggle('active', syncMode === 'light');
    modeFullBtn.classList.toggle('active', syncMode === 'full');
    if (crawlBtn && !crawlBtn.disabled) {
      crawlBtn.textContent = syncMode === 'light' ? '⚡ Sync This Page (Stock & Price Only)' : '📦 Sync This Page (Full Details)';
    }
  }
}

async function updateSyncHistoryDisplay() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_SYNC_HISTORY' });
    if (syncHistoryCount && result && result.count !== undefined) syncHistoryCount.textContent = result.count;
  } catch (e) { /* worker down — self-check reports it */ }
}

// ============ SYNC STATE ============

async function checkSyncState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
    if (state && state.isRunning) {
      showSyncProgress(state);
      startPolling();
    } else if (state && state.isPaused) {
      showPaused(state);
    } else if (state && state.lastStatus && state.totalProducts > 0) {
      showCompletedSync(state);
    }
  } catch (e) {
    console.log('No background state available');
  }
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
      if (state && state.isRunning) {
        showSyncProgress(state);
      } else {
        stopPolling();
        if (state && state.isPaused) showPaused(state);
        else if (state) showCompletedSync(state);
        updateSyncHistoryDisplay();
        loadErrors();
      }
    } catch (e) {
      stopPolling();
    }
  }, 500);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function showSyncProgress(state) {
  progressContainer.classList.remove('hidden');
  statsContainer.classList.remove('hidden');
  resumeBtn.classList.add('hidden');
  updateProgress(state.lastProgress, state.lastStatus);
  productsCount.textContent = state.totalProducts;
  syncedCount.textContent = state.synced;
  if (skippedCount) skippedCount.textContent = state.skipped || 0;
  crawlBtn.disabled = false;
  crawlBtn.innerHTML = `<span class="spinner"></span> Syncing… (click to stop)`;
  syncBtn.disabled = true;
  statusBox.className = 'status-box';
  statusValue.innerHTML = `
    <strong>🔄 SYNC IN PROGRESS</strong><br>
    <small>You can minimise the browser — the sync continues and survives Chrome pausing the extension.</small>
    ${state.failed > 0 ? `<br><small style="color:#b45309;">⚠ ${state.failed} failed so far — see Recent problems</small>` : ''}
    ${state.skipped > 0 ? `<br><small style="color: #22c55e;">✓ ${state.skipped} already synced (skipped)</small>` : ''}
  `;
}

function showPaused(state) {
  progressContainer.classList.remove('hidden');
  statsContainer.classList.remove('hidden');
  updateProgress(state.lastProgress, 'Paused');
  productsCount.textContent = state.totalProducts;
  syncedCount.textContent = state.synced;
  if (skippedCount) skippedCount.textContent = state.skipped || 0;
  statusBox.className = 'status-box warning';
  statusValue.innerHTML = `<strong>⏸ SYNC PAUSED</strong><br><small>${esc(state.lastStatus)}</small>`;
  crawlBtn.disabled = false;
  crawlBtn.textContent = 'Start a new sync instead';
  resumeBtn.classList.remove('hidden');
  syncBtn.disabled = false;
}

function showCompletedSync(state) {
  progressContainer.classList.remove('hidden');
  statsContainer.classList.remove('hidden');
  resumeBtn.classList.add('hidden');
  updateProgress(100, state.status === 'stopped' ? 'Stopped' : 'Complete!');
  productsCount.textContent = state.totalProducts;
  syncedCount.textContent = state.synced;
  if (skippedCount) skippedCount.textContent = state.skipped || 0;
  statusBox.className = state.failed > 0 || state.status === 'error' ? 'status-box warning' : 'status-box success';
  statusValue.textContent = state.lastStatus;
  crawlBtn.disabled = false;
  updateSyncModeUI();
  syncBtn.disabled = false;
}

// ============ RESUME ============

resumeBtn.addEventListener('click', async () => {
  resumeBtn.disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'RESUME_SYNC' });
  resumeBtn.disabled = false;
  if (r && r.resumed) {
    resumeBtn.classList.add('hidden');
    startPolling();
  } else {
    statusBox.className = 'status-box error';
    statusValue.textContent = 'Nothing to resume — start a new sync.';
  }
});

// ============ QUICK SYNC (hidden legacy button) ============

syncBtn.addEventListener('click', async () => {
  try {
    syncBtn.disabled = true;
    btnText.textContent = 'Extracting...';
    btnSpinner.classList.remove('hidden');
    progressContainer.classList.remove('hidden');
    statsContainer.classList.add('hidden');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    updateProgress(10, 'Scanning page...');
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractProductsFromListingPage });
    const response = results[0]?.result;
    if (!response || !response.products || response.products.length === 0) {
      throw new Error('No products found. Make sure you are on a product listing page.');
    }
    updateProgress(50, `Found ${response.products.length} products...`);
    productsCount.textContent = response.products.length;
    updateProgress(70, 'Sending to Tile Station...');
    const settings = await chrome.storage.local.get(['apiUrl']);
    const result = await chrome.runtime.sendMessage({ type: 'QUICK_SYNC', tabId: tab.id, products: response.products, apiUrl: settings.apiUrl || DEFAULT_API_URL });
    if (result.error) throw new Error(result.error);
    updateProgress(100, 'Complete!');
    syncedCount.textContent = result.synced || response.products.length;
    statusBox.className = 'status-box success';
    statusValue.textContent = `Synced ${result.synced} products (names only)`;
    statsContainer.classList.remove('hidden');
    btnText.textContent = 'Sync Complete!';
    setTimeout(() => { btnText.textContent = 'Quick Sync (names only)'; syncBtn.disabled = false; btnSpinner.classList.add('hidden'); }, 2000);
  } catch (error) {
    statusBox.className = 'status-box error';
    statusValue.textContent = `Error: ${error.message}`;
    btnText.textContent = 'Retry';
    syncBtn.disabled = false;
    btnSpinner.classList.add('hidden');
  }
});

function updateProgress(percent, text) {
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text;
}

settingsToggle.addEventListener('click', (e) => { e.preventDefault(); apiConfig.classList.toggle('hidden'); });

saveSettingsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ apiUrl: apiUrlInput.value.trim() });
  saveSettingsBtn.textContent = 'Saved!';
  setTimeout(() => { saveSettingsBtn.textContent = 'Save Settings'; }, 1500);
  runSelfCheck();
});

// ============ FULL SYNC ============

if (crawlBtn) {
  crawlBtn.addEventListener('click', async () => {
    try {
      const currentState = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
      if (currentState && currentState.isRunning) {
        await chrome.runtime.sendMessage({ type: 'STOP_SYNC' });
        crawlBtn.disabled = false;
        updateSyncModeUI();
        syncBtn.disabled = false;
        stopPolling();
        statusBox.className = 'status-box warning';
        statusValue.textContent = 'Sync stopped. Click to restart.';
        return;
      }

      crawlBtn.disabled = true;
      syncBtn.disabled = true;
      resumeBtn.classList.add('hidden');
      crawlBtn.innerHTML = '<span class="spinner"></span> Finding products...';
      progressContainer.classList.remove('hidden');
      statsContainer.classList.remove('hidden');

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const settings = await chrome.storage.local.get(['apiUrl']);
      const apiUrl = settings.apiUrl || DEFAULT_API_URL;

      // Step 1: Scroll to load all lazy-loaded products
      updateProgress(5, 'Loading all products on page...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const totalHeight = document.body.scrollHeight;
          const step = window.innerHeight;
          for (let pos = 0; pos < totalHeight; pos += step) {
            window.scrollTo(0, pos);
            await new Promise(r => setTimeout(r, 250));
          }
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise(r => setTimeout(r, 500));
          window.scrollTo(0, 0);
        }
      });
      await sleep(1500);

      updateProgress(15, 'Scanning page for products...');
      const scanResults = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanListingPage });
      const scan = scanResults[0]?.result || {};
      if (scan.cloudflare) {
        throw new Error(`Verona is showing a Cloudflare security check ("${scan.title}"). Complete it in the tab, then try again.`);
      }
      const productUrls = scan.isDetail && scan.detailUrl ? [scan.detailUrl] : (scan.urls || []);
      if (productUrls.length === 0) {
        throw new Error(`No products found on this page (${scan.productItems || 0} product boxes, ${scan.anchors || 0} links). Open a Verona Tiles listing page, scroll down once, and try again.`);
      }

      productsCount.textContent = productUrls.length;
      syncedCount.textContent = '0';
      statusBox.className = 'status-box';
      statusValue.innerHTML = `<strong>🔄 STARTING BACKGROUND SYNC</strong><br><small>${productUrls.length} products · you can minimise the browser</small>`;

      await chrome.runtime.sendMessage({ type: 'START_FULL_SYNC', tabId: tab.id, productUrls, apiUrl, syncMode });
      startPolling();
      crawlBtn.innerHTML = `<span class="spinner"></span> ${syncMode === 'light' ? '⚡' : '📦'} Syncing in background...`;
    } catch (error) {
      console.error('Sync error:', error);
      statusBox.className = 'status-box error';
      statusValue.textContent = `Error: ${error.message}`;
      crawlBtn.textContent = 'Retry';
      crawlBtn.disabled = false;
      syncBtn.disabled = false;
      loadErrors();
    }
  });
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', async () => {
    if (confirm('Clear sync history? This will allow all products to be synced again.')) {
      try {
        await chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_HISTORY' });
        if (syncHistoryCount) syncHistoryCount.textContent = '0';
        statusBox.className = 'status-box success';
        statusValue.textContent = 'Sync history cleared! All products will be synced on next run.';
      } catch (e) {
        console.error('Failed to clear history:', e);
      }
    }
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SYNC_COMPLETE' || message.type === 'SYNC_PAUSED') {
    stopPolling();
    checkSyncState();
    updateSyncHistoryDisplay();
    loadErrors();
  }
});

// ============================================================
// FUNCTIONS INJECTED INTO PAGE (must be self-contained)
// ============================================================

// Scan a Verona listing page: product URLs + everything needed to explain a miss
function scanListingPage() {
  const out = {
    url: location.href,
    title: document.title,
    h1: ((document.querySelector('h1') || {}).textContent || '').trim().slice(0, 120),
    anchors: document.getElementsByTagName('a').length,
    productItems: 0,
    urls: [],
    cloudflare: false,
    isDetail: false,
    detailUrl: null,
    needsLogin: false
  };
  const bodyText = (document.body && document.body.innerText) || '';
  out.cloudflare = /just a moment|attention required|checking your browser|verify you are human|sorry, you have been blocked/i.test(`${document.title} ${out.h1} ${bodyText.slice(0, 500)}`);
  if (out.cloudflare) return out;

  const isProductPath = (href) => /^https?:\/\/(www\.)?veronagroup\.co\.uk\/[a-z]\d+(?:[-/][^?#]*)?\/?(?:[?#].*)?$/i.test(href);
  const clean = (href) => href.split('?')[0].split('#')[0].replace(/\/$/, '');

  // Single product page?
  if (isProductPath(location.href) && document.querySelector('h1.page-title, h1[itemprop="name"], .product-info-main')) {
    out.isDetail = true;
    out.detailUrl = clean(location.href);
  }

  const urls = new Set();
  const items = document.querySelectorAll('li.product-item, .products-grid .product-item, .products.list .product-item, .product-items .product-item, ol.product-items > li, .product-item-info');
  out.productItems = items.length;
  items.forEach(item => {
    item.querySelectorAll('a[href]').forEach(a => { if (isProductPath(a.href)) urls.add(clean(a.href)); });
    const dataUrl = item.getAttribute('data-product-url');
    if (dataUrl && isProductPath(dataUrl)) urls.add(clean(dataUrl));
  });
  // Backup: every code-first link on the page (root-level /p15247, /l10093-…)
  for (const a of document.getElementsByTagName('a')) {
    const href = a.href || '';
    if (isProductPath(href) && !/\/(customer|checkout|account|wishlist|review|catalogsearch)\//i.test(href)) urls.add(clean(href));
  }
  // Backup 2: JSON-LD ItemList (Magento emits it on category pages)
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const data = JSON.parse(s.textContent);
      const lists = [].concat(data).flatMap(d => (d && d['@type'] === 'ItemList' && d.itemListElement) || []);
      lists.forEach(el => { const u = (el && (el.url || (el.item && el.item.url))) || ''; if (isProductPath(u)) urls.add(clean(u)); });
    } catch (e) { /* not JSON */ }
  });
  out.urls = Array.from(urls);
  out.needsLogin = /\b(sign in|log in|login)\b/i.test(bodyText.slice(0, 3000)) && !/\b(my account|sign out|log out|logout)\b/i.test(bodyText.slice(0, 3000));
  return out;
}

// Extract basic product info from listing page (quick mode)
function extractProductsFromListingPage() {
  const products = [];
  const containers = document.querySelectorAll('li.product-item, div.product-item, .product-item-info, .products-grid .item, .products.list .item');
  containers.forEach((container) => {
    try {
      const product = {};
      const nameLink = container.querySelector('.product-item-link, .product-name a, a.product-item-link');
      if (nameLink) { product.name = nameLink.textContent.trim(); product.url = nameLink.href; }
      const img = container.querySelector('img.product-image-photo, img');
      if (img) product.image = img.src || img.getAttribute('data-src');
      const priceEl = container.querySelector('.price, [data-price-amount]');
      if (priceEl) {
        const priceText = priceEl.getAttribute('data-price-amount') || priceEl.textContent;
        const match = priceText.match(/[\d.]+/);
        if (match) product.price = parseFloat(match[0]);
      }
      if (product.name) products.push(product);
    } catch (e) { /* skip broken card */ }
  });
  return { products, url: window.location.href, pageType: 'listing' };
}
