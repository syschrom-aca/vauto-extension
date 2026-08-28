/**
 * background.js — vAuto Vehicle Intelligence Service Worker
 *
 * Handles:
 *  - Fetching vehicle data from the Fabric / Cloudflare Worker endpoint
 *    on behalf of the content script.
 *  - Setting the install badge.
 */

'use strict';

// ─────────────────────────────────────────────
// Fetch vehicle data from Microsoft Fabric (via Worker)
// ─────────────────────────────────────────────
const POWER_AUTOMATE_URL = "https://restless-hill-7d81.syschrom-19c.workers.dev";

async function fetchVehicleData(vin, stock) {
  const stk = stock || '';
  const endpoint = `${POWER_AUTOMATE_URL}?vin=${encodeURIComponent(vin)}&stk=${encodeURIComponent(stk)}`;

  const response = await fetch(endpoint, { method: 'GET' });
  if (!response.ok) throw new Error('Network response was not ok');

  // Read RAW text first so we can surface it on a no-match.
  const rawText = await response.text();
  let data;

  try {
    data = JSON.parse(rawText);
  } catch (e) {
    data = rawText;
  }

  if (!data || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && Object.keys(data).length === 0)) {
    throw new Error('NOMATCH|' + rawText);
  }

  return { data: Array.isArray(data) ? data[0] : data };
}

// ─────────────────────────────────────────────
// Badge helper
// ─────────────────────────────────────────────
function setBadge(text, color = '#2563eb') {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─────────────────────────────────────────────
// Message handler — only the content script's data request is used
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'fetchVehicleData' && msg.vin) {
    fetchVehicleData(msg.vin, msg.stock || '')
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

// ─────────────────────────────────────────────
// On install: show a one-time badge
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    setBadge('NEW', '#f59e0b');
  }
});
