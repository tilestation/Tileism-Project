// Tile Station - Verona Sync Extension
// Background Service Worker - Runs even when popup is closed
// v3.0 - SKIP ALREADY SYNCED PRODUCTS

const DEFAULT_API_URL = 'https://tile-station-production.up.railway.app';
// Known Tile Station backend locations — the extension auto-detects the first
// one that responds so a future backend migration never breaks syncing.
const API_CANDIDATES = [
  'https://tile-station-production.up.railway.app',
  'https://www.tilestation.co.uk'
];

async function resolveApiUrl(preferred) {
  const candidates = [preferred, ...API_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const base of candidates) {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/api/supplier-sync/verona/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: [], source: 'connection_test' })
      });
      if (r.ok) {
        console.log(`API connection OK: ${base}`);
        return base.replace(/\/$/, '');
      }
      console.warn(`API candidate rejected (${r.status}): ${base}`);
    } catch (e) {
      console.warn(`API candidate unreachable: ${base}`, e.message);
    }
  }
  return null;
}

// Store sync state
let syncState = {
  isRunning: false,
  currentIndex: 0,
  totalProducts: 0,
  synced: 0,
  failed: 0,
  skipped: 0,
  failedProducts: [],
  productUrls: [],
  lastStatus: '',
  lastProgress: 0,
  tabId: null,
  syncMode: 'light'  // Track current sync mode
};

// Get synced products from storage
async function getSyncedProducts() {
  const result = await chrome.storage.local.get(['syncedProducts']);
  return result.syncedProducts || {};
}

// Save synced product to storage
async function markProductSynced(url, sku) {
  const synced = await getSyncedProducts();
  const key = sku || url;
  synced[key] = {
    url: url,
    sku: sku,
    syncedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ syncedProducts: synced });
}

// Check if product was already synced
async function isProductSynced(url, sku) {
  const synced = await getSyncedProducts();
  // Check by SKU first (more reliable), then by URL
  if (sku && synced[sku]) return true;
  if (synced[url]) return true;
  return false;
}

// Clear sync history
async function clearSyncHistory() {
  await chrome.storage.local.set({ syncedProducts: {} });
  console.log('Sync history cleared');
}

// Get sync history stats
async function getSyncHistoryStats() {
  const synced = await getSyncedProducts();
  const count = Object.keys(synced).length;
  return { count, products: synced };
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message.type);
  
  switch (message.type) {
    case 'GET_SYNC_STATE':
      sendResponse({ ...syncState });
      break;
      
    case 'START_FULL_SYNC':
      startFullSync(message.tabId, message.productUrls, message.apiUrl, message.syncMode || 'full')
        .then(result => {
          console.log('Full sync completed:', result);
        })
        .catch(error => {
          console.error('Full sync error:', error);
          syncState.lastStatus = `Error: ${error.message}`;
          syncState.isRunning = false;
        });
      sendResponse({ started: true });
      break;
      
    case 'STOP_SYNC':
      syncState.isRunning = false;
      syncState.lastStatus = 'Sync stopped by user';
      sendResponse({ stopped: true });
      break;
      
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
      return true; // Keep channel open for async response
      
    default:
      sendResponse({ error: 'Unknown message type' });
  }
  
  return true; // Keep message channel open
});

// Quick sync - just send products from listing page
async function quickSync(tabId, products, apiUrl) {
  try {
    const workingUrl = await resolveApiUrl(apiUrl);
    if (!workingUrl) {
      throw new Error('Cannot reach the Tile Station server — check your internet connection or the API URL in settings');
    }
    const response = await fetch(`${workingUrl}/api/supplier-sync/verona/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: products,
        source: 'browser_extension_v3.0_quick',
        timestamp: new Date().toISOString()
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `API error: ${response.status}`);
    }
    
    const result = await response.json();
    return { success: true, synced: result.synced || products.length };
  } catch (error) {
    throw error;
  }
}

// Full sync - visit each product page (runs in background)
async function startFullSync(tabId, productUrls, apiUrl, syncMode = 'full') {
  if (syncState.isRunning) {
    throw new Error('Sync already in progress');
  }
  
  // Auto-detect the working backend BEFORE starting — a wrong URL previously
  // caused every product to silently fail.
  const workingUrl = await resolveApiUrl(apiUrl);
  if (!workingUrl) {
    syncState.lastStatus = '❌ Cannot reach the Tile Station server — sync not started. Check the API URL in settings.';
    throw new Error('Cannot reach the Tile Station server — check the API URL in settings');
  }
  apiUrl = workingUrl;
  
  const isLightMode = syncMode === 'light';
  console.log(`Starting sync in ${isLightMode ? 'LIGHT' : 'FULL'} mode`);
  
  // Filter out already synced products BEFORE starting
  const syncedProducts = await getSyncedProducts();
  const urlsToSync = [];
  const alreadySynced = [];
  
  for (const url of productUrls) {
    // Extract potential SKU from URL for checking
    const urlMatch = url.match(/\/([a-z])(\d+)/i);
    const potentialSku = urlMatch ? (urlMatch[1].toUpperCase() + urlMatch[2]) : null;
    
    if (await isProductSynced(url, potentialSku)) {
      alreadySynced.push(url);
    } else {
      urlsToSync.push(url);
    }
  }
  
  console.log(`Found ${productUrls.length} products total`);
  console.log(`Already synced: ${alreadySynced.length}, To sync: ${urlsToSync.length}`);
  
  // Initialize state
  syncState = {
    isRunning: true,
    currentIndex: 0,
    totalProducts: productUrls.length,
    synced: 0,
    failed: 0,
    skipped: alreadySynced.length,
    failedProducts: [],
    productUrls: urlsToSync,
    lastStatus: urlsToSync.length > 0 
      ? `Starting ${isLightMode ? '⚡LIGHT' : '📦FULL'} sync: ${urlsToSync.length} new products (${alreadySynced.length} already synced)...`
      : `All ${alreadySynced.length} products already synced!`,
    lastProgress: alreadySynced.length > 0 ? Math.round((alreadySynced.length / productUrls.length) * 100) : 0,
    tabId: tabId,
    syncMode: syncMode
  };
  
  // If all products already synced, finish immediately
  if (urlsToSync.length === 0) {
    syncState.isRunning = false;
    syncState.lastProgress = 100;
    syncState.lastStatus = `All ${alreadySynced.length} products already synced! Go to next page →`;
    
    chrome.runtime.sendMessage({ 
      type: 'SYNC_COMPLETE', 
      synced: 0, 
      skipped: alreadySynced.length,
      failed: 0,
      total: productUrls.length
    }).catch(() => {});
    
    return syncState;
  }
  
  console.log(`Starting ${isLightMode ? 'LIGHT' : 'FULL'} sync: ${urlsToSync.length} products (${alreadySynced.length} skipped)`);
  
  for (let i = 0; i < urlsToSync.length && syncState.isRunning; i++) {
    const url = urlsToSync[i];
    syncState.currentIndex = i;
    const totalProcessed = alreadySynced.length + i + 1;
    syncState.lastProgress = Math.round((totalProcessed / productUrls.length) * 100);
    syncState.lastStatus = `${isLightMode ? '⚡' : '📦'} Syncing ${i + 1}/${urlsToSync.length} (${alreadySynced.length} skipped)`;
    
    try {
      // Navigate to product page
      await chrome.tabs.update(tabId, { url });
      
      // LIGHT MODE: Shorter wait time (only need basic page to load)
      // FULL MODE: Wait longer for images to load
      const waitTime = isLightMode ? 1000 : 2000;
      await waitForPageLoad(tabId, waitTime);
      
      // Extract product details - use light extractor for light mode
      const extractResult = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: isLightMode ? extractProductDetailsLight : extractProductDetails
      });
      
      const product = extractResult[0]?.result;
      
      if (product && product.name) {
        // Send to API
        const response = await fetch(`${apiUrl}/api/supplier-sync/verona/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            products: [product],
            source: `browser_extension_v3.0_${isLightMode ? 'light' : 'full'}`,
            timestamp: new Date().toISOString()
          })
        });
        
        if (response.ok) {
          syncState.synced++;
          // Mark product as synced to avoid re-syncing
          await markProductSynced(url, product.sku);
          console.log(`✓ Synced & saved: ${product.name} (${product.sku})`);
        } else {
          syncState.failed++;
          syncState.failedProducts.push(product.name || url);
          console.error(`✗ API error for: ${product.name}`);
        }
      } else {
        syncState.failed++;
        syncState.failedProducts.push(url);
        console.error(`✗ No data extracted from: ${url}`);
      }
    } catch (e) {
      syncState.failed++;
      syncState.failedProducts.push(url);
      console.error(`✗ Error processing: ${url}`, e);
    }
    
    // LIGHT MODE: Minimal delay (100ms) between products
    // FULL MODE: Standard delay (300ms)
    const delayTime = isLightMode ? 100 : 300;
    await sleep(delayTime);
  }
  
  // Sync complete
  syncState.isRunning = false;
  syncState.lastProgress = 100;
  
  const skippedText = syncState.skipped > 0 ? ` (${syncState.skipped} skipped)` : '';
  const modeEmoji = isLightMode ? '⚡' : '📦';
  
  if (syncState.failed > 0) {
    syncState.lastStatus = `${modeEmoji} Done! Synced ${syncState.synced}/${syncState.totalProducts}${skippedText}. ${syncState.failed} failed.`;
  } else {
    syncState.lastStatus = `${modeEmoji} Complete! Synced ${syncState.synced}${skippedText}. Go to next page →`;
  }
  
  // Notify popup if it's open
  chrome.runtime.sendMessage({ 
    type: 'SYNC_COMPLETE', 
    synced: syncState.synced, 
    skipped: syncState.skipped,
    failed: syncState.failed,
    total: syncState.totalProducts
  }).catch(() => {}); // Ignore errors if popup is closed
  
  return syncState;
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
  console.log('=== Tile Station v2.9: Extracting Product Details ===');
  console.log('URL:', window.location.href);
  
  const product = {
    url: window.location.href
  };
  
  // ============ GET PRODUCT NAME ============
  const titleSelectors = [
    'h1.page-title',
    'h1[itemprop="name"]',
    '.product-info-main h1',
    'h1'
  ];
  
  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) {
      product.name = el.textContent.trim();
      console.log('Name:', product.name);
      break;
    }
  }
  
  if (!product.name) {
    console.error('Could not find product name!');
    return null;
  }
  
  // ============ GET SIZE FROM TABLE OR PAGE ============
  const pageText = document.body.innerText;
  const tables = document.querySelectorAll('table');
  
  // Method 1: Find "Size" row in table
  for (const table of tables) {
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if ((label === 'size' || label === 'tile size' || label === 'dimensions') && value) {
          product.size = value;
          console.log('Size from table:', product.size);
          break;
        }
      }
    }
    if (product.size) break;
  }
  
  // Method 2: Extract size pattern from page text
  if (!product.size) {
    const sizePatterns = [
      /(\d{2,4})\s*[xX×]\s*(\d{2,4})\s*(cm|mm)?/,
      /(\d{2,3})\s*[xX×]\s*(\d{2,3})/
    ];
    for (const pattern of sizePatterns) {
      const match = pageText.match(pattern);
      if (match) {
        product.size = match[0].trim();
        console.log('Size from page text:', product.size);
        break;
      }
    }
  }
  
  // ============ GET FINISH FROM TABLE OR NAME ============
  // Method 1: Find "Finish" row in table
  for (const table of tables) {
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if ((label === 'finish' || label === 'surface' || label === 'texture') && value) {
          product.finish = value;
          console.log('Finish from table:', product.finish);
          break;
        }
      }
    }
    if (product.finish) break;
  }
  
  // Method 2: Extract finish from product name
  if (!product.finish) {
    const finishKeywords = ['matt', 'matte', 'polished', 'gloss', 'glossy', 'satin', 'lappato', 'honed', 'natural', 'textured'];
    const nameLower = product.name.toLowerCase();
    for (const finish of finishKeywords) {
      if (nameLower.includes(finish)) {
        product.finish = finish.charAt(0).toUpperCase() + finish.slice(1);
        console.log('Finish from name:', product.finish);
        break;
      }
    }
  }
  
  // ============ GET PRODUCT CODE/SKU ============
  for (const table of tables) {
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (label === 'code' && value) {
          product.sku = value;
          console.log('Code from table:', product.sku);
          break;
        }
      }
    }
    if (product.sku) break;
  }
  
  // Method 2: Extract from URL
  if (!product.sku) {
    const urlMatch = window.location.href.match(/\/([a-z])(\d+)/i);
    if (urlMatch) {
      product.sku = urlMatch[1].toUpperCase() + urlMatch[2];
      console.log('Code from URL:', product.sku);
    }
  }
  
  // ============ GET PRICE PER M² ============
  const pricePatterns = [
    /£([\d.]+)\s*per\s*m²/i,
    /£([\d.]+)\s*per\s*m2/i,
    /£([\d.]+)\s*\/\s*m²/i,
    /£([\d.]+)\s*\/m²/i,
    /£([\d.]+)\s*m²/i
  ];
  
  for (const pattern of pricePatterns) {
    const match = pageText.match(pattern);
    if (match) {
      product.price = parseFloat(match[1]);
      console.log('Price per m²:', product.price);
      break;
    }
  }
  
  // ============ GET STOCK INFORMATION ============
  console.log('Looking for stock info...');
  
  let stockFound = false;
  
  // FIRST: Check for "Out of stock" explicitly
  if (pageText.match(/out\s*of\s*stock/i)) {
    product.in_stock = false;
    product.stock_quantity = 0;
    product.stock_m2 = 0;
    console.log('OUT OF STOCK detected');
    stockFound = true;
  }
  
  // If not out of stock, look for "In stock" with quantities
  if (!stockFound) {
    const stockPatterns = [
      /in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m²?\)/i,
      /in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m2?\)/i,
      /in\s*stock[:\s]+(\d[\d,]*)/i,
    ];
    
    for (const pattern of stockPatterns) {
      const match = pageText.match(pattern);
      if (match) {
        const firstNum = parseInt(match[1].replace(/,/g, ''));
        const secondNum = match[2] ? parseInt(match[2]) : null;
        
        if (secondNum !== null) {
          product.stock_quantity = firstNum;
          product.stock_m2 = secondNum;
          console.log(`Stock: ${firstNum} units (${secondNum}m²)`);
        } else {
          product.stock_quantity = firstNum;
          console.log(`Stock: ${firstNum} units (no m² shown)`);
        }
        
        product.in_stock = firstNum > 0;
        stockFound = true;
        break;
      }
    }
  }
  
  // If no stock info found, default to OUT OF STOCK
  if (!stockFound) {
    product.in_stock = false;
    product.stock_quantity = 0;
    product.stock_m2 = 0;
    console.log('No stock info found - marking as OUT OF STOCK');
  }
  
  // ============ GET PRODUCT IMAGE ============
  const imgSelectors = [
    '.gallery-placeholder__image',
    '.product-image-photo',
    '.fotorama__img',
    '.product-image img',
    'img[src*="catalog/product"]',
    'img[src*="media/catalog"]'
  ];
  
  for (const selector of imgSelectors) {
    const img = document.querySelector(selector);
    if (img) {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy');
      if (src && src.startsWith('http')) {
        product.image = src;
        console.log('Image found');
        break;
      }
    }
  }
  
  console.log('=== EXTRACTED PRODUCT ===');
  console.log(JSON.stringify(product, null, 2));
  
  return product;
}

console.log('Tile Station Background Service Worker v3.0 loaded');

// ============================================================
// LIGHT MODE EXTRACTION - Only stock, price, SKU (FAST!)
// ============================================================
function extractProductDetailsLight() {
  console.log('=== Tile Station v3.0: LIGHT MODE Extract ===');
  console.log('URL:', window.location.href);
  
  const product = {
    url: window.location.href
  };
  
  // ============ GET PRODUCT NAME (required for identification) ============
  const titleSelectors = ['h1.page-title', 'h1[itemprop="name"]', '.product-info-main h1', 'h1'];
  
  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) {
      product.name = el.textContent.trim();
      break;
    }
  }
  
  if (!product.name) {
    console.error('Could not find product name!');
    return null;
  }
  
  const pageText = document.body.innerText;
  
  // ============ GET PRODUCT CODE/SKU ============
  const tables = document.querySelectorAll('table');
  for (const table of tables) {
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (label === 'code' && value) {
          product.sku = value;
          break;
        }
      }
    }
    if (product.sku) break;
  }
  
  if (!product.sku) {
    const urlMatch = window.location.href.match(/\/([a-z])(\d+)/i);
    if (urlMatch) {
      product.sku = urlMatch[1].toUpperCase() + urlMatch[2];
    }
  }
  
  // ============ GET PRICE PER M² ============
  const pricePatterns = [
    /£([\d.]+)\s*per\s*m²/i, /£([\d.]+)\s*per\s*m2/i,
    /£([\d.]+)\s*\/\s*m²/i, /£([\d.]+)\s*\/m²/i, /£([\d.]+)\s*m²/i
  ];
  
  for (const pattern of pricePatterns) {
    const match = pageText.match(pattern);
    if (match) {
      product.price = parseFloat(match[1]);
      break;
    }
  }
  
  // ============ GET STOCK INFORMATION ============
  if (pageText.match(/out\s*of\s*stock/i)) {
    product.in_stock = false;
    product.stock_quantity = 0;
    product.stock_m2 = 0;
  } else {
    const stockPatterns = [
      /in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m²?\)/i,
      /in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m2?\)/i,
      /in\s*stock[:\s]+(\d[\d,]*)/i
    ];
    
    let stockFound = false;
    for (const pattern of stockPatterns) {
      const match = pageText.match(pattern);
      if (match) {
        const firstNum = parseInt(match[1].replace(/,/g, ''));
        const secondNum = match[2] ? parseInt(match[2]) : null;
        
        if (secondNum !== null) {
          product.stock_quantity = firstNum;
          product.stock_m2 = secondNum;
        } else {
          product.stock_quantity = firstNum;
        }
        product.in_stock = firstNum > 0;
        stockFound = true;
        break;
      }
    }
    
    if (!stockFound) {
      product.in_stock = false;
      product.stock_quantity = 0;
      product.stock_m2 = 0;
    }
  }
  
  // NO IMAGE EXTRACTION IN LIGHT MODE - This is what makes it fast!
  
  console.log('=== LIGHT EXTRACT COMPLETE ===');
  console.log(`SKU: ${product.sku}, Stock: ${product.stock_quantity}, Price: ${product.price}`);
  
  return product;
}
