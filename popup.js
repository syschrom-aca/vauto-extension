let currentVin = null;
let isCollapsed = false;

/* ════════════════════════════════
   TAB SWITCHING
   ════════════════════════════════ */
function switchTab(tabId, btn) {  
  document.querySelectorAll('.tab-content').forEach(t => {
    t.classList.remove('active');
  });    
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
  });  
  document.getElementById('tab-' + tabId).classList.add('active');
  btn.classList.add('active');
}

/* ════════════════════════════════
   VIN DETECTION (content script message) - na pozniej lub wywal
   ════════════════════════════════ */
	async function detectVinFromPage() {
	  chrome.runtime.sendMessage({ action: 'requestCurrentVin' }, (response) => {
		if (response && response.vin) {
		  //console.log("Wykryto VIN:" + response.vin);
		  loadVehicleData(response.vin, 'Auto');
		} else {
		  console.log("Nie wykryto VIN-u na stronie.");
		  // Tutaj możesz pokazać info w UI: "Otwórz pojazd w vAuto"
		}
	  });
	}

/* ════════════════════════════════
   LOAD VEHICLE DATA
   ════════════════════════════════ */
// Stały adres URL do Power Automate
const POWER_AUTOMATE_URL = "https://restless-hill-7d81.syschrom-19c.workers.dev";

async function loadVehicleData(vin, source = 'Auto') {
  currentVin = vin;
  
  document.getElementById('manual-vin-input').textContent = vin;
  document.getElementById('card-vin').textContent = vin;
  
  document.getElementById('loading-state').style.display = 'block';
  document.getElementById('data-content').style.display = 'none';
  document.getElementById('error-state').style.display = 'none';

  try {
    const finalUrl = `${POWER_AUTOMATE_URL}?vin=${encodeURIComponent(vin)}&stk=`;
    const resp = await fetch(finalUrl, { method: 'GET' });

    if (!resp.ok) throw new Error('Power Automate Error');
    
    // ZMIANA: Pobieranie jako RAW tekst
    const rawText = await resp.text();
    let data;
    try { data = JSON.parse(rawText); } catch(e) { data = rawText; }
	
    if (!data || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && Object.keys(data).length === 0)) {
      throw new Error('NOMATCH|' + rawText);
    }
    
    const vehicleData = Array.isArray(data) ? data[0] : data;	
    renderData(vehicleData);
  } catch (e) {
    // ZMIANA: Pokazuj błąd w konsoli TYLKO jeśli to nie jest nasz przewidziany brak danych (NOMATCH)
    if (!e.message.includes('NOMATCH|')) {
      console.error('Fetch Error:', e);
    }
    
    document.getElementById('loading-state').style.display = 'none';
    
    const errorStateEl = document.getElementById('error-state');
    errorStateEl.style.display = 'block';
    
    let errorText = e.message || 'Connection Error';
    let rawData = '';
    
    // Elastyczne wykrywanie znacznika NOMATCH
    if (errorText.includes('NOMATCH|')) {
        rawData = errorText.split('NOMATCH|')[1] || '';
        errorText = 'No Match Found';
    }

    // Wstrzykujemy błąd i RAW dane prosto w element error-state
    errorStateEl.innerHTML = `
      <div class="empty-icon">⚠️</div>
      <div style="font-size:13px;font-weight:600;margin-bottom:4px;">${errorText}</div>
      <div style="font-family:monospace;font-size:9px;color:#9ca3af;background:#f3f4f6;padding:6px;border-radius:4px;word-break:break-all;text-align:left;margin-top:8px;">
        RAW: ${rawData ? (rawData === '[]' ? '[Pusta tablica]' : rawData) : '(No data → empty string)'}
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
  const pct = Math.min(100, Math.max(0, d.avgsalestomarket*100));
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
   RECENT VINS
   ════════════════════════════════ */
let recentVins = [];
function addToRecentVins(vin, data) {
  recentVins = recentVins.filter(v => v.vin !== vin);
  recentVins.unshift({ vin, label: `${data.year} ${data.make} ${data.model}` });
  if (recentVins.length > 5) recentVins.pop();
  renderRecentVins();
}
function renderRecentVins() {
  const el = document.getElementById('recent-vins-list');
  if (!recentVins.length) {
    el.innerHTML = '<div style="padding:10px 0; font-size:11px; color:var(--text-muted); text-align:center;">No recent VINs in this session</div>';
    return;
  }
  el.innerHTML = recentVins.map(v => `
    <div onclick="loadVehicleData('${v.vin}','History')" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--surface);border:1px solid var(--border-light);border-radius:6px;margin-bottom:5px;cursor:pointer;transition:border-color 0.15s;" onmouseover="this.style.borderColor='var(--accent-blue)'" onmouseout="this.style.borderColor='var(--border-light)'">
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;font-weight:500;">${v.vin}</div>
        <div style="font-size:10px;color:var(--text-muted);">${v.label}</div>
      </div>
      <span style="font-size:10px;color:var(--accent-blue);">Load →</span>
    </div>
  `).join('');
}

/* ════════════════════════════════
   MANUAL VIN LOOKUP
   ════════════════════════════════ */
function lookupManualVin() {
  const val = document.getElementById('manual-vin-input').value.trim().toUpperCase();
  if (!val) return;
  loadVehicleData(val, 'Manual');
  // Update full view data area
  document.getElementById('full-view-data').innerHTML = '<div style="padding:10px 0; font-size:11px; color:var(--text-muted); text-align:center;">Loading...</div>';
  setTimeout(() => {    
      document.getElementById('full-view-data').innerHTML = `<div style="padding:16px; text-align:center; font-size:11px; color:var(--text-muted);">No data found for VIN "${val}" (not in demo dataset)</div>`;    
  }, 1000);
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
   TOGGLES
   ════════════════════════════════ */
function toggleSwitch(el) {
  el.classList.toggle('on');
}

/* ════════════════════════════════
   SETTINGS
   ════════════════════════════════ */
// Uproszczone zapisywanie ustawień (bez pól URL/Token)
function saveSettings() {
  const msg = document.getElementById('save-msg');
  msg.style.display = 'block';
  setTimeout(() => { msg.style.display = 'none'; }, 2000);
}

/* ════════════════════════════════
   INIT — simulate VIN detection
   ════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
	
  document.getElementById('app-version').textContent = 'v.' + chrome.runtime.getManifest().version;
	
  // 1. Sprawdź, czy background.js już ma jakiś VIN w pamięci (opcjonalne)
  // 2. Wyślij zapytanie o aktualny VIN z aktywnej karty 
  /*
  chrome.runtime.sendMessage({ action: 'requestCurrentVin' }, (response) => {
    if (response && response.vin) {
      console.log("Popup otrzymał VIN:", response.vin);
      loadVehicleData(response.vin); // Ta funkcja pobierze dane z Fabric
    } else {
      document.getElementById('vin-display').textContent = "Detecting...";
    }
  });	*/
	
  // Kod do obsługi kliknięć w taby
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.textContent.toLowerCase();
      let targetId = 'tab-panel';
      if (text.includes('full')) targetId = 'tab-fullview';
      if (text.includes('integration')) targetId = 'tab-integration';
      if (text.includes('settings')) targetId = 'tab-settings';

      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      
      document.getElementById(targetId).classList.add('active');
      btn.classList.add('active');
    });
  });
  
  const manualBtn = document.getElementById('lookup-manual-btn');
  if (manualBtn) {
    manualBtn.addEventListener('click', lookupManualVin);
  }

  // Obsługa Entera w polu VIN
  const manualInput = document.getElementById('manual-vin-input');
  if (manualInput) {
    manualInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') lookupManualVin();
    });
  }
  
  // 4. Obsługa przycisku Save Settings (bo on też ma onclick w HTML, który nie zadziała)
  const saveBtn = document.querySelector('.save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveSettings);
  }  
  
});

/* Content script message listener (production) */
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'vinDetected' && msg.vin) {
      loadVehicleData(msg.vin, 'Auto');
    }
  });
}