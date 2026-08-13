/**
 * background.js — vAuto Vehicle Intelligence Service Worker
 *
 * Handles:
 *  - Message relay between content script and popup
 *  - Microsoft Fabric API calls (with caching)
 *  - Badge updating to show active VIN detection status
 */

'use strict';

// ─────────────────────────────────────────────
// In-memory cache: { vin -> { data, timestamp } }
// ─────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const vinCache = new Map();

// ─────────────────────────────────────────────
// Fetch vehicle data from Microsoft Fabric
// ─────────────────────────────────────────────
const POWER_AUTOMATE_URL = "https://restless-hill-7d81.syschrom-19c.workers.dev";

async function fetchVehicleData(vin, stock) {
  const stk = stock || '';
  const endpoint = `${POWER_AUTOMATE_URL}?vin=${encodeURIComponent(vin)}&stk=${encodeURIComponent(stk)}`;
  
  const response = await fetch(endpoint, { method: 'GET' });
  if (!response.ok) throw new Error('Network response was not ok');
  
  // ZMIANA: Pobieramy RAW jako tekst dla debugowania
  const rawText = await response.text();
  let data;
  
  // Próbujemy parsować JSON. Jeśli się nie uda, traktujemy jako błąd formatu
  try { 
    data = JSON.parse(rawText); 
  } catch(e) { 
    data = rawText; 
  }
  
  if (!data || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && Object.keys(data).length === 0)) {
    // Wrzucamy do wiadomości błędu znacznik i surowe dane
    throw new Error('NOMATCH|' + rawText);
  }
  
  return { data: Array.isArray(data) ? data[0] : data };
}

// ─────────────────────────────────────────────
// Update the extension badge
// ─────────────────────────────────────────────
function setBadge(text, color = '#2563eb') {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─────────────────────────────────────────────
// Message handlers
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Content script detected a VIN — relay to any open popup and update badge
  if (msg.action === 'vinDetected' && msg.vin) {
    chrome.storage.session.set({ activeVin: msg.vin, vinDetectedAt: Date.now() });
    setBadge('VIN', '#16a34a');

    // Forward to popup if it's open
    chrome.runtime.sendMessage({ action: 'vinDetected', vin: msg.vin }).catch(() => {
      // Popup not open — that's fine
    });
    return false;
  }

  // Popup requesting vehicle data from Fabric
  if (msg.action === 'fetchVehicleData' && msg.vin) {
	const stockNumber = msg.stock || 'nie ma 2';
    fetchVehicleData(msg.vin, stockNumber)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async
  }

  // Popup requesting current VIN from content script
  if (msg.action === 'requestCurrentVin') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ vin: null }); return; }
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getVin' }, (resp) => {
        sendResponse(resp || { vin: null });
      });
    });
    return true;
  }

  // Clear cache for a specific VIN (or all)
  if (msg.action === 'clearCache') {
    if (msg.vin) vinCache.delete(msg.vin);
    else vinCache.clear();
    sendResponse({ success: true });
    return false;
  }
});

// ─────────────────────────────────────────────
// On install: set default settings
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({
      autoDetectVin: true,
      autoOpenPopup: true,
      cacheEnabled: true,
      compactMode: true,
    });
    setBadge('NEW', '#f59e0b');
  }
});
