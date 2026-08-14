// Tile Station - Verona Sync Extension
// Popup Script - v3.0 - Skip already synced products

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
const clearHistoryBtn = document.getElementById('clear-history-btn');
const syncHistoryCount = document.getElementById('sync-history-count');
const modeLightBtn = document.getElementById('mode-light');
const modeFullBtn = document.getElementById('mode-full');

// Production API URL
const DEFAULT_API_URL = 'https://tile-station-production.up.railway.app';

let pollInterval = null;
let syncMode = 'light'; // Default to light mode for faster syncing

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get(['apiUrl', 'syncMode']);
  // Auto-heal stored URLs that don't serve the API (www domain / old previews)
  if (settings.apiUrl && /tilestation\.co\.uk/i.test(settings.apiUrl)) {
    settings.apiUrl = DEFAULT_API_URL;
    await chrome.storage.local.set({ apiUrl: DEFAULT_API_URL });
  }
  apiUrlInput.value = settings.apiUrl || DEFAULT_API_URL;
  
  // Load sync mode preference
  syncMode = settings.syncMode || 'light';
  updateSyncModeUI();
  
  // Load sync history count
  updateSyncHistoryDisplay();
  
  // Check if there's an ongoing sync
  checkSyncState();
  checkCurrentPage();
});

// Sync mode toggle handlers
if (modeLightBtn) {
  modeLightBtn.addEventListener('click', async () => {
    syncMode = 'light';
    updateSyncModeUI();
    await chrome.storage.local.set({ syncMode: 'light' });
  });
}

if (modeFullBtn) {
  modeFullBtn.addEventListener('click', async () => {
    syncMode = 'full';
    updateSyncModeUI();
    await chrome.storage.local.set({ syncMode: 'full' });
  });
}

function updateSyncModeUI() {
  if (modeLightBtn && modeFullBtn) {
    modeLightBtn.classList.toggle('active', syncMode === 'light');
    modeFullBtn.classList.toggle('active', syncMode === 'full');
    
    // Update button text to reflect mode
    if (crawlBtn) {
      if (syncMode === 'light') {
        crawlBtn.textContent = '⚡ Sync This Page (Stock & Price Only)';
      } else {
        crawlBtn.textContent = '📦 Sync This Page (Full Details)';
      }
    }
  }
}

// Update sync history display
async function updateSyncHistoryDisplay() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_SYNC_HISTORY' });
    if (syncHistoryCount && result && result.count !== undefined) {
      syncHistoryCount.textContent = result.count;
    }
  } catch (e) {
    console.log('Could not get sync history');
  }
}

// Poll for sync state from background worker
async function checkSyncState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
    
    if (state && state.isRunning) {
      // Show ongoing sync progress
      showSyncProgress(state);
      startPolling();
    } else if (state && state.lastStatus && state.totalProducts > 0) {
      // Show last completed sync result
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
        if (state) showCompletedSync(state);
        updateSyncHistoryDisplay();
      }
    } catch (e) {
      stopPolling();
    }
  }, 500);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function showSyncProgress(state) {
  progressContainer.classList.remove('hidden');
  statsContainer.classList.remove('hidden');
  
  updateProgress(state.lastProgress, state.lastStatus);
  productsCount.textContent = state.totalProducts;
  syncedCount.textContent = state.synced;
  if (skippedCount) skippedCount.textContent = state.skipped || 0;
  
  crawlBtn.disabled = true;
  const remaining = state.totalProducts - state.skipped - state.currentIndex;
  crawlBtn.innerHTML = `<span class="spinner"></span> Syncing... (${state.skipped || 0} skipped)`;
  syncBtn.disabled = true;
  
  statusBox.className = 'status-box';
  statusValue.innerHTML = `
    <strong>🔄 SYNC IN PROGRESS</strong><br>
    <small>You can minimize the browser - sync will continue!</small>
    ${state.skipped > 0 ? `<br><small style="color: #22c55e;">✓ ${state.skipped} already synced (skipped)</small>` : ''}
  `;
}

function showCompletedSync(state) {
  progressContainer.classList.remove('hidden');
  statsContainer.classList.remove('hidden');
  
  updateProgress(100, 'Complete!');
  productsCount.textContent = state.totalProducts;
  syncedCount.textContent = state.synced;
  if (skippedCount) skippedCount.textContent = state.skipped || 0;
  
  if (state.failed > 0) {
    statusBox.className = 'status-box warning';
  } else {
    statusBox.className = 'status-box success';
  }
  statusValue.textContent = state.lastStatus;
  
  crawlBtn.disabled = false;
  crawlBtn.textContent = 'Sync This Page (with stock & prices)';
  syncBtn.disabled = false;
  btnText.textContent = 'Quick Sync (names only)';
}

// Check if we're on a trade portal page
async function checkCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab.url || '';
    
    const isVeronaSite = url.includes('verona') || url.includes('vfrg');
    
    if (isVeronaSite) {
      if (!statusBox.className.includes('success')) {
        statusBox.className = 'status-box success';
        statusValue.textContent = 'Ready to sync from this page';
      }
      syncBtn.disabled = false;
      btnText.textContent = 'Quick Sync (names only)';
    } else {
      statusBox.className = 'status-box warning';
      statusValue.textContent = 'Navigate to Verona trade portal first';
      syncBtn.disabled = false;
      btnText.textContent = 'Try Extract Anyway';
    }
  } catch (error) {
    console.error('Error checking page:', error);
    statusValue.textContent = 'Click button to try extraction';
    syncBtn.disabled = false;
  }
}

// Quick sync button - extract basic info from listing page
syncBtn.addEventListener('click', async () => {
  try {
    syncBtn.disabled = true;
    btnText.textContent = 'Extracting...';
    btnSpinner.classList.remove('hidden');
    progressContainer.classList.remove('hidden');
    statsContainer.classList.add('hidden');
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    updateProgress(10, 'Scanning page...');
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractProductsFromListingPage
    });
    
    const response = results[0]?.result;
    
    if (!response || !response.products || response.products.length === 0) {
      throw new Error('No products found. Make sure you are on a product listing page.');
    }
    
    updateProgress(50, `Found ${response.products.length} products...`);
    productsCount.textContent = response.products.length;
    
    updateProgress(70, 'Sending to Tile Station...');
    
    const settings = await chrome.storage.local.get(['apiUrl']);
    const apiUrl = settings.apiUrl || DEFAULT_API_URL;
    
    // Send via background worker
    const result = await chrome.runtime.sendMessage({
      type: 'QUICK_SYNC',
      tabId: tab.id,
      products: response.products,
      apiUrl: apiUrl
    });
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    updateProgress(100, 'Complete!');
    syncedCount.textContent = result.synced || response.products.length;
    
    statusBox.className = 'status-box success';
    statusValue.textContent = `Synced ${result.synced} products (names only)`;
    statsContainer.classList.remove('hidden');
    btnText.textContent = 'Sync Complete!';
    
    setTimeout(() => {
      btnText.textContent = 'Quick Sync (names only)';
      syncBtn.disabled = false;
      btnSpinner.classList.add('hidden');
    }, 2000);
    
  } catch (error) {
    console.error('Sync error:', error);
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

settingsToggle.addEventListener('click', (e) => {
  e.preventDefault();
  apiConfig.classList.toggle('hidden');
});

saveSettingsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ apiUrl: apiUrlInput.value.trim() });
  saveSettingsBtn.textContent = 'Saved!';
  setTimeout(() => { saveSettingsBtn.textContent = 'Save Settings'; }, 1500);
});

// ============================================================
// FULL SYNC - Background worker handles the heavy lifting
// ============================================================
if (crawlBtn) {
  crawlBtn.addEventListener('click', async () => {
    try {
      // Check if sync is already running
      const currentState = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
      
      if (currentState && currentState.isRunning) {
        // Stop the running sync
        await chrome.runtime.sendMessage({ type: 'STOP_SYNC' });
        crawlBtn.textContent = 'Sync This Page (with stock & prices)';
        crawlBtn.disabled = false;
        syncBtn.disabled = false;
        stopPolling();
        statusBox.className = 'status-box warning';
        statusValue.textContent = 'Sync stopped. Click to restart.';
        return;
      }
      
      crawlBtn.disabled = true;
      syncBtn.disabled = true;
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
            await new Promise(r => setTimeout(r, 300));
          }
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise(r => setTimeout(r, 500));
          window.scrollTo(0, 0);
        }
      });
      
      await sleep(2000);
      
      updateProgress(15, 'Scanning page for products...');
      
      // Step 2: Find all product URLs
      const urlResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: findAllProductUrls
      });
      
      const productUrls = urlResults[0]?.result || [];
      
      if (productUrls.length === 0) {
        throw new Error('No products found. Make sure you are on a Tiles listing page.');
      }
      
      productsCount.textContent = productUrls.length;
      syncedCount.textContent = '0';
      
      statusBox.className = 'status-box';
      statusValue.innerHTML = `
        <strong>🔄 STARTING BACKGROUND SYNC</strong><br>
        <small>You can minimize the browser - sync will continue!</small>
      `;
      
      // Step 3: Start background sync
      await chrome.runtime.sendMessage({
        type: 'START_FULL_SYNC',
        tabId: tab.id,
        productUrls: productUrls,
        apiUrl: apiUrl,
        syncMode: syncMode  // Pass the selected sync mode
      });
      
      // Start polling for updates
      startPolling();
      
      crawlBtn.innerHTML = `<span class="spinner"></span> ${syncMode === 'light' ? '⚡' : '📦'} Syncing in background...`;
      
    } catch (error) {
      console.error('Sync error:', error);
      statusBox.className = 'status-box error';
      statusValue.textContent = `Error: ${error.message}`;
      crawlBtn.textContent = 'Retry';
      crawlBtn.disabled = false;
      syncBtn.disabled = false;
    }
  });
}

// Clear sync history button
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Listen for sync completion from background worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SYNC_COMPLETE') {
    stopPolling();
    checkSyncState();
    updateSyncHistoryDisplay();
  }
});

// ============================================================
// FUNCTIONS INJECTED INTO PAGE
// ============================================================

// Find ALL product URLs on the current listing page
function findAllProductUrls() {
  console.log('=== Tile Station v3.0: Finding ALL Product URLs ===');
  console.log('Page URL:', window.location.href);
  
  const urls = new Set();
  
  const productItems = document.querySelectorAll(
    'li.product-item, ' +
    '.products-grid .product-item, ' +
    '.products.list .product-item, ' +
    '.product-items .product-item, ' +
    'ol.product-items > li'
  );
  
  console.log('Product items found:', productItems.length);
  
  productItems.forEach((item, idx) => {
    const links = item.querySelectorAll('a');
    
    links.forEach(link => {
      const href = link.href;
      
      if (href && href.match(/\/[a-z]\d+/i)) {
        const cleanUrl = href.split('?')[0].split('#')[0];
        urls.add(cleanUrl);
      }
    });
    
    const dataUrl = item.getAttribute('data-product-url');
    if (dataUrl) {
      urls.add(dataUrl.split('?')[0].split('#')[0]);
    }
  });
  
  // Backup scan
  const allLinks = document.getElementsByTagName('a');
  
  for (let i = 0; i < allLinks.length; i++) {
    const href = allLinks[i].href;
    if (href && href.match(/veronagroup\.co\.uk\/[a-z]\d+/i) &&
        !href.includes('/customer/') &&
        !href.includes('/checkout/') &&
        !href.includes('/account/')) {
      urls.add(href.split('?')[0].split('#')[0]);
    }
  }
  
  console.log('Total unique URLs:', urls.size);
  
  return Array.from(urls);
}

// Extract basic product info from listing page (quick mode)
function extractProductsFromListingPage() {
  console.log('=== Tile Station v2.9: Quick Extract from Listing ===');
  
  const products = [];
  
  // Check if this is a detail page, not listing
  if (window.location.href.match(/\/d\d+/) && document.querySelector('h1.page-title, h1[itemprop="name"]')) {
    console.log('This is a detail page, extracting single product');
    const product = extractProductDetails();
    if (product && product.name) {
      products.push(product);
    }
    return { products, url: window.location.href, pageType: 'detail' };
  }
  
  // Find product containers on listing page
  const containers = document.querySelectorAll(
    'li.product-item, div.product-item, .product-item-info, ' +
    '.products-grid .item, .products.list .item'
  );
  
  console.log(`Found ${containers.length} product containers`);
  
  containers.forEach((container, idx) => {
    try {
      const product = {};
      
      const nameLink = container.querySelector('.product-item-link, .product-name a, a.product-item-link');
      if (nameLink) {
        product.name = nameLink.textContent.trim();
        product.url = nameLink.href;
      }
      
      const img = container.querySelector('img.product-image-photo, img');
      if (img) {
        product.image = img.src || img.getAttribute('data-src');
      }
      
      const priceEl = container.querySelector('.price, [data-price-amount]');
      if (priceEl) {
        const priceText = priceEl.getAttribute('data-price-amount') || priceEl.textContent;
        const match = priceText.match(/[\d.]+/);
        if (match) product.price = parseFloat(match[0]);
      }
      
      if (product.name) {
        products.push(product);
      }
    } catch (e) {
      console.error(`Error extracting product ${idx}:`, e);
    }
  });
  
  console.log(`Extracted ${products.length} products from listing`);
  return { products, url: window.location.href, pageType: 'listing' };
}
