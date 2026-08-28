let isCollapsed = false;

/* ════════════════════════════════
   LOAD VEHICLE DATA
   ════════════════════════════════ */
// Fixed URL to Power Automate / Worker
const POWER_AUTOMATE_URL = "https://restless-hill-7d81.syschrom-19c.workers.dev";

async function loadVehicleData(vin, source = 'Auto') {
  document.getElementById('manual-vin-input').textContent = vin;
  document.getElementById('card-vin').textContent = vin;

  document.getElementById('loading-state').style.display = 'block';
  document.getElementById('data-content').style.display = 'none';
  document.getElementById('error-state').style.display = 'none';

  try {
    const finalUrl = `${POWER_AUTOMATE_URL}?vin=${encodeURIComponent(vin)}&stk=`;
    const resp = await fetch(finalUrl, { method: 'GET' });

    if (!resp.ok) throw new Error('Power Automate Error');

    // Read as RAW text
    const rawText = await resp.text();
    let data;
    try { data = JSON.parse(rawText); } catch (e) { data = rawText; }

    if (!data || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && Object.keys(data).length === 0)) {
      throw new Error('NOMATCH|' + rawText);
    }

    const vehicleData = Array.isArray(data) ? data[0] : data;
    renderData(vehicleData);
  } catch (e) {
    // Log the error to the console ONLY if this is not the expected no-data case (NOMATCH)
    if (!e.message.includes('NOMATCH|')) {
      console.error('Fetch Error:', e);
    }

    document.getElementById('loading-state').style.display = 'none';

    const errorStateEl = document.getElementById('error-state');
    errorStateEl.style.display = 'block';

    let errorText = e.message || 'Connection Error';
    let rawData = '';

    if (errorText.includes('NOMATCH|')) {
      rawData = errorText.split('NOMATCH|')[1] || '';
      errorText = 'No Match Found';
    }

    errorStateEl.innerHTML = `
      <div class="empty-icon">⚠️</div>
      <div style="font-size:13px;font-weight:600;margin-bottom:4px;">${errorText}</div>
      <div style="font-family:monospace;font-size:9px;color:#9ca3af;background:#f3f4f6;padding:6px;border-radius:4px;word-break:break-all;text-align:left;margin-top:8px;">
        RAW: ${rawData ? (rawData === '[]' ? '[Empty array]' : rawData) : '(No data → empty string)'}
      </div>
    `;
  }
}

/* ════════════════════════════════
   RENDER DATA
   ════════════════════════════════ */
function renderData(d) {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('data-content').style.display = 'block';

  document.getElementById('metric-leads').textContent = d.leads14d;
  document.getElementById('metric-road-tests').textContent = d.roadtests14d;
  document.getElementById('inventory-title').textContent = `Inventory (${d.make} ${d.model})`;
  document.getElementById('inv-online').textContent = d.inventory_online;
  document.getElementById('inv-progress').textContent = d.inventory_inprogress;
  document.getElementById('inv-total').textContent = d.inventory_total;
  document.getElementById('market-rate').textContent = (d.avgsalestomarket != null ? (d.avgsalestomarket * 100).toFixed(1) + '%' : '—');
  document.getElementById('cdk-status').textContent = d.cdkstatus;
  document.getElementById('stock-type').textContent = d.stocktype;
  document.getElementById('stock-type').className = 'status-tile-value ' + (d.stocktype === 'Retail' ? 'retail' : '');

  // Market badge
  const badge = document.getElementById('market-badge');
  if (d.marketposition === 'Below') {
    badge.textContent = '▼ Below market'; badge.className = 'market-badge below';
  } else if (d.marketposition === 'Above') {
    badge.textContent = '▲ Above market'; badge.className = 'market-badge above';
  } else if (d.marketposition === 'At') {
    badge.textContent = '≈ At market'; badge.className = 'market-badge at';
  } else {
    badge.textContent = 'unknown'; badge.className = 'market-badge null';
  }

  // Progress bar
  const pct = Math.min(100, Math.max(0, d.avgsalestomarket * 100));
  document.getElementById('market-bar').style.width = pct + '%';

  // Animate numbers
  animateValue('metric-leads', 0, d.leads14d, 400);
  animateValue('metric-road-tests', 0, d.roadtests14d, 400);
}

function animateValue(id, from, to, duration) {
  const el = document.getElementById(id);
  const start = performance.now();
  function update(ts) {
    const pct = Math.min(1, (ts - start) / duration);
    el.textContent = Math.round(from + (to - from) * easeOut(pct));
    if (pct < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

/* ════════════════════════════════
   MANUAL VIN LOOKUP
   ════════════════════════════════ */
function lookupManualVin() {
  const val = document.getElementById('manual-vin-input').value.trim().toUpperCase();
  if (!val) return;
  loadVehicleData(val, 'Manual');
}

/* ════════════════════════════════
   COLLAPSE
   ════════════════════════════════ */
function toggleCard() {
  isCollapsed = !isCollapsed;
  document.getElementById('card-body').style.display = isCollapsed ? 'none' : 'block';
  document.getElementById('collapse-icon').textContent = isCollapsed ? '▸' : '▾';
}

/* ════════════════════════════════
   INIT
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  document.getElementById('app-version').textContent = 'v.' + chrome.runtime.getManifest().version;

  const manualBtn = document.getElementById('lookup-manual-btn');
  if (manualBtn) {
    manualBtn.addEventListener('click', lookupManualVin);
  }

  // Handle the Enter key in the VIN field
  const manualInput = document.getElementById('manual-vin-input');
  if (manualInput) {
    manualInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') lookupManualVin();
    });
  }
});
