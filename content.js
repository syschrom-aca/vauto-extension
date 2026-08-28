/**
 * content.js — vAuto Vehicle Intelligence (content script)
 * =========================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Runs on vAuto / Cox Automotive pages (see `matches` in manifest.json).
 * When a vehicle pricing view is open, it reads the current VIN + Stock #
 * from the page and injects a floating "Vehicle Intelligence" (VI) panel
 * that shows Microsoft Fabric data for that vehicle. The panel can be
 * minimized to a small draggable bar and expands again on click.
 *
 * HIGH-LEVEL FLOW
 * ---------------
 *   1. A MutationObserver + a polling interval both call `checkForModal()`.
 *   2. `checkForModal()` detects whether a pricing view is open and reads
 *      the VIN (`detectVin`) and Stock # (`detectStock`) from the DOM/iframe.
 *   3. On a new VIN/Stock, `injectPanel()` builds the UI and calls `loadData()`.
 *   4. `loadData()` asks the background service worker for Fabric data via
 *      `chrome.runtime.sendMessage({ action: 'fetchVehicleData', ... })`.
 *      (The actual network request lives in background.js.)
 *   5. `renderData()` fills the panel; errors are shown by the error branch,
 *      including a RAW debug string when the VIN is not in the dataset.
 *
 * KEY FUNCTIONS (in order)
 * ------------------------
 *   detectVin / detectStock  – scrape VIN + Stock # from modal/header/iframe.
 *   findChartContainer       – locate the vAuto chart "red box" to overlay.
 *   findModalRoot            – find the modal root, used to anchor the bar.
 *   injectPanel              – build the panel + bar and wire up events.
 *   positionOverChartArea /
 *   positionBar              – place the panel/bar on screen.
 *   makeDraggable            – allow the panel to be dragged by its header.
 *   minimize / expand        – toggle between the panel and the compact bar.
 *   loadData                 – request vehicle data from the background worker.
 *   setStatus / renderData   – update the status dot and render Fabric metrics.
 *   buildPanelHTML /
 *   buildBarHTML             – return the inline HTML/CSS templates.
 *   checkForModal            – the main loop: detect view, inject/refresh UI.
 *
 * DEPENDENCIES / CONTRACTS
 * ------------------------
 *   - background.js: responds to { action: 'fetchVehicleData', vin, stock }
 *     with { success, data } or { success:false, error }. A missing vehicle
 *     is signalled by an error message prefixed with 'NOMATCH|'.
 *   - No chrome.storage / chrome.tabs are used here (kept permission-free);
 *     the only extension API used is chrome.runtime.
 *
 * NOTE: The panel markup and styles are injected inline (see buildPanelHTML)
 *       so the extension does not depend on external CSS files.
 */

(function () {
  'use strict';

  let injectedPanel = null;
  let injectedBar   = null;
  let currentVin    = null;

  // ─── VIN detection ────────────────────────────────────────────────────────
	function detectVin() {
		// 1. Define the sources in priority order
		const modal = document.querySelector('.pricing-modal-class');
		const header = document.getElementById('headerVehicleSummary');
		const iframe = document.getElementById('GaugePageIFrame');

		let sourceText = "";

		// 2. Get text from the available source
		if (modal) {
			sourceText = modal.innerText;
		} else if (header) {
			sourceText = header.innerText;
		} else if (iframe) {
			try {
				const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
				sourceText = iframeDoc.body.innerText;
			} catch (e) {
				// Silent failure if the iframe is blocked by CORS
				sourceText = "";
			}
		}

		// 3. Search for the VIN in the retrieved text
		if (!sourceText) return null;

		const match = sourceText.match(/VIN\s*:?\s*([A-HJ-NPR-Z0-9]{17})/i);
		return match ? match[1] : null;
	}
		  
  // ─── Stock Number detection ──────────────────────────────────────────────  
	function detectStock() {
		// 1. Define the sources in priority order
		const modal = document.querySelector('.pricing-modal-class');
		const header = document.getElementById('headerVehicleSummary');
		const iframe = document.getElementById('GaugePageIFrame');

		let sourceText = "";

		// 2. Get text from the available source
		if (modal) {
			sourceText = modal.innerText;
		} else if (header) {
			sourceText = header.innerText;
		} else if (iframe) {
			try {
				const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
				sourceText = iframeDoc.body.innerText;
			} catch (e) {
				// Silent failure if the iframe is blocked by CORS
				sourceText = "";
			}
		}

		// 3. Search for the VIN in the retrieved text
		if (!sourceText) return null;

		const match = sourceText.match(/Stock\s*#\s*:?\s*([\w-]+)/i);
		return match ? match[1] : null;
	}  
	
  // ─── Find the red-box chart container ─────────────────────────────────────
  // The History/Ranking/Scatter/Curve chart area sits in a tab panel.
  // We look for that tab row and grab its sibling content div.
  function findChartContainer() {
    // Approach 1: find any element with a red/danger border (the literal red box)
    const all = document.querySelectorAll('div, section, article');
    for (const el of all) {
      if (el.id === 'vi-panel' || el.id === 'vi-bar') continue;
      const cs = window.getComputedStyle(el);
      const bc = cs.borderColor;
      if ((bc.includes('255, 0') || bc.includes('220, 38') || bc.includes('239, 68'))
          && el.offsetWidth > 350 && el.offsetHeight > 150) {
        return el;
      }
    }
    // Approach 2: the chart wrapper near History|Ranking tabs
    const tabRows = document.querySelectorAll('[class*="tab-row"], [class*="tabs"], [role="tablist"]');
    for (const row of tabRows) {
      if (row.id === 'vi-panel' || row.closest('#vi-panel')) continue;
      if (row.textContent.includes('History') && row.textContent.includes('Ranking')) {
        // The chart lives in the next sibling or parent's next sibling
        const parent = row.parentElement;
        if (parent) {
          for (const child of parent.children) {
            if (child !== row && child.offsetWidth > 350 && child.offsetHeight > 100) return child;
          }
          const grandParent = parent.parentElement;
          if (grandParent) {
            for (const sib of grandParent.children) {
              if (sib !== parent && sib.offsetWidth > 350 && sib.offsetHeight > 100) return sib;
            }
          }
        }
      }
    }
    // Approach 3: find a div that contains an SVG chart (recharts/d3)
    const svgParents = document.querySelectorAll('[class*="recharts"], [class*="chart-wrapper"], [class*="chartWrapper"]');
    for (const el of svgParents) {
      if (!el.closest('#vi-panel') && el.offsetWidth > 350) return el;
    }
    return null;
  }

  // ─── Find the modal root (for positioning the bar) ────────────────────────
  function findModalRoot() {
    const selectors = ['[class*="modal-content"]','[class*="dialog-content"]','[role="dialog"]','[class*="popout"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 500) return el;
    }
    return document.body;
  }

  // ─── Inject panel ─────────────────────────────────────────────────────────
	// ─── Updated injection function ──────────────────────────────────
	function injectPanel(vin, stock) {
	  if (injectedPanel) return;

	  // 1. Create the main panel
	  const panel = document.createElement('div');
	  panel.id = 'vi-panel';
	  Object.assign(panel.style, {
		position: 'fixed',
		zIndex: '2147483647',
		pointerEvents: 'all',
		fontFamily: "'DM Sans', -apple-system, sans-serif",
		display: 'block',
	  });
	  panel.innerHTML = buildPanelHTML(vin, stock);
	  document.body.appendChild(panel);
	  injectedPanel = panel;
	  
	  const header = panel.querySelector('.vi-hdr');
	  if (header) {
		makeDraggable(panel, header);
	  }

	  // 2. Handle clicks inside the panel (event delegation)
	  panel.addEventListener('click', (e) => {
		// Check what exactly was clicked
		if (e.target.closest('[title="Refresh"]') || e.target.closest('.vi-ftr-btn')) {
		  loadData(vin, stock);
		} else if (e.target.closest('[title="Minimize to bar"]')) {
		  minimize();
		}
	  });

	  positionOverChartArea();

	  // 3. Create the bar
	  const bar = document.createElement('div');
	  bar.id = 'vi-bar';
	  Object.assign(bar.style, {
		position: 'fixed',
		zIndex: '2147483647',
		pointerEvents: 'all',
		display: 'none',
		fontFamily: "'DM Sans', -apple-system, sans-serif",
	  });
	  bar.innerHTML = buildBarHTML(vin);
	  document.body.appendChild(bar);
	  injectedBar = bar;

	  // 4. Handle clicks on the bar
	  bar.addEventListener('click', () => {
		expand();
	  });

	  positionBar();
	  loadData(vin, stock);
	}


	function positionOverChartArea() {
		if (!injectedPanel) return;
		const target = findChartContainer();
		
		if (target) {
		  const r = target.getBoundingClientRect();
		  Object.assign(injectedPanel.style, {
			top:    r.top  + window.scrollY + 'px',
			left:   r.left + window.scrollX + 'px',
			width:  r.width  + 'px',
			minHeight: r.height + 'px',
			height: 'auto', 
			maxHeight: '85vh',
			bottom: 'auto',
			right:  'auto',
		  });
		} else {
		  // Fallback: position in the bottom-right corner (like positionBar)
		  const modal = findModalRoot();
		  const r = modal.getBoundingClientRect();
		  
		  Object.assign(injectedPanel.style, {
			// Calculate the position from the bottom and right edges of the window
			bottom: Math.max(16, window.innerHeight - r.bottom + 64) + 'px',
			right:  Math.max(16, window.innerWidth  - r.right  + 14) + 'px',
			top:    'auto',
			left:   'auto',
			width:  '540px',
			height: 'auto',
			minHeight: '290px'
		  });
		}
	  }

  function positionBar() {
    if (!injectedBar) return;
    // Anchor to bottom-right of the modal
    const modal = findModalRoot();
    const r = modal.getBoundingClientRect();
    Object.assign(injectedBar.style, {
      bottom: Math.max(16, window.innerHeight - r.bottom + 64) + 'px',
      right:  Math.max(16, window.innerWidth  - r.right  + 14) + 'px',
    });
  }
  
  function makeDraggable(el, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    handle.style.cursor = 'move'; // Change the cursor on the header
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e = e || window.event;
      // Do not allow dragging if a button was clicked (refresh/minimize)
      if (e.target.closest('.vi-icon-btn')) return;
      
      e.preventDefault();
      // Get the cursor position at the start
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      // Calculate the new cursor position
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      // Set the new element position
      el.style.top = (el.offsetTop - pos2) + "px";
      el.style.left = (el.offsetLeft - pos1) + "px";
      
      // Reset 'right' and 'bottom' so they don't conflict with the new 'top/left'
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }

    function closeDragElement() {
      // Stop tracking once the mouse button is released
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  // ─── Minimize / Expand ────────────────────────────────────────────────────
  function minimize() {
    if (injectedPanel) injectedPanel.style.display = 'none';
    if (injectedBar)   { injectedBar.style.display = 'block'; positionBar(); }
  }

  function expand() {
    if (injectedBar)   injectedBar.style.display = 'none';
    if (injectedPanel) { injectedPanel.style.display = 'block'; positionOverChartArea(); }
  }

  // ─── Data loading ──────────────────────────────────────────────────────────
  async function loadData(vin, stock) {
    setStatus('loading');
    const loadEl = document.querySelector('#vi-panel #vi-loading');
    const dataEl = document.querySelector('#vi-panel #vi-data');
    const errEl  = document.querySelector('#vi-panel #vi-error');
    if (loadEl) loadEl.style.display = 'flex';
    if (dataEl) { dataEl.style.display = 'none'; }
    if (errEl)  { errEl.style.display = 'none'; }

    try {
       const result = await new Promise(res =>
         chrome.runtime.sendMessage({ action: 'fetchVehicleData', vin, stock }, res)
       );
       if (!result.success) throw new Error(result.error);
       renderData(result.data);

    } catch (e) {
      setStatus('error');
      if (loadEl) loadEl.style.display = 'none';
      if (errEl)  { errEl.style.display = 'flex'; }
      
      const title = errEl?.querySelector('.vi-error-title');
      const msg = errEl?.querySelector('#vi-error-msg');
      
      let errorText = e.message || 'Connection Error';
      let rawData = '';

      // Extract RAW data from the error
      if (errorText.startsWith('NOMATCH|')) {
         rawData = errorText.split('|').slice(1).join('|');
         errorText = 'No Match Found';
      }

      // Update the main title so it does not show "Connection Error" when there is no data
      if (title) {
        title.textContent = errorText === 'No Match Found' ? 'Vehicle Not Found' : 'Connection Error';
      }

      if (msg) {
        // Description under the title
        msg.textContent = errorText === 'No Match Found' ? 'This VIN is not in your Fabric dataset.' : errorText;
        
        // Debug box dla RAW data
        let debugEl = errEl.querySelector('.vi-debug-raw');
        if (!debugEl) {
            debugEl = document.createElement('div');
            debugEl.className = 'vi-debug-raw';
            debugEl.style.cssText = 'font-family: monospace; font-size: 8px; color: #94a3b8; background: #f1f5f9; padding: 4px; border-radius: 4px; word-break: break-all; margin-top: 6px; max-width: 90%; text-align: left;';
            errEl.appendChild(debugEl);
        }
        
        debugEl.textContent = rawData ? 'RAW: ' + (rawData === '[]' ? '[Empty array]' : rawData) : 'RAW: (No data → empty string)';
        debugEl.style.display = 'block';
      }
    }
  }  
  
  function setStatus(state) {
    const dot = document.querySelector('#vi-panel #vi-status-dot');
    const txt = document.querySelector('#vi-panel #vi-status-txt');
    if (!dot || !txt) return;
    dot.className = 'vi-status-dot' + (state === 'loading' ? ' vi-dot-loading' : state === 'error' ? ' vi-dot-error' : ' vi-dot-live');
    txt.textContent = state === 'loading' ? 'Loading…' : state === 'error' ? 'Error' : 'Live';
  }

  function renderData(d) {
    const loadEl = document.querySelector('#vi-panel #vi-loading');
    const dataEl = document.querySelector('#vi-panel #vi-data');
    const errEl  = document.querySelector('#vi-panel #vi-error');
    if (loadEl) loadEl.style.display = 'none';
    if (errEl)  errEl.style.display  = 'none';	
	
	// Update the tier in the header
	const tierPill = document.getElementById('vi-tier-pill');
	if (tierPill) {
		const tierValue = d.performancetier;
		// Remove the old tier-X classes before adding the new one
		tierPill.className = 'vi-hdr-tier'; 
		
		if (tierValue && tierValue !== "null") {
			tierPill.textContent = tierValue;
			// Extract the digit from "Tier X" (e.g. "Tier 1" -> "1")
			const tierNum = tierValue.replace(/\D/g, '');
			if (tierNum) tierPill.classList.add(`vi-tier-${tierNum}`);
		} else {
			tierPill.innerHTML = '&mdash;';
			tierPill.classList.add('vi-tier-null');
		}
	}
	
	// Helper function to determine the color
    const getGrossClass = (val) => {
        const num = Number(val);
        if (isNaN(num) || num === 0) return 'ambient';
        return num > 0 ? 'green' : 'red';
    };

    // Currency formatting
    const formatCurrency = (val) => {
        if (val == null || val === "") return '—';
        const num = Number(val);
        // Add a minus sign before the dollar sign for negative values: -$500
        const prefix = num < 0 ? '-$' : '$';
        return prefix + Math.abs(num).toLocaleString('en-US', { maximumFractionDigits: 0 });
    };

    // Get the classes for the individual values
    const frontClass = getGrossClass(d.avgfrontgross);
    const backClass  = getGrossClass(d.avgbackgross);
    const totalClass = getGrossClass(d.avgtotalgross);

    const frontGross = formatCurrency(d.avgfrontgross);
    const backGross  = formatCurrency(d.avgbackgross);
    const totalGross = formatCurrency(d.avgtotalgross);
	
	// Formats a number as a percentage
    const formatPercent = (val) => {
        if (val == null || val === "" || val === "null") return '—';
        return (Number(val) * 100).toFixed(1) + '%';
    };
	const mktPercent = formatPercent(d.avgsalestomarket);

    dataEl.innerHTML = `
	   <div class="vi-grid">
	    <div class="vi-tile">
          <div class="vi-lbl"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Avg. Front Gross</div>
          <div class="vi-big ${frontClass}">${frontGross}</div>
        </div>
        <div class="vi-tile">
          <div class="vi-lbl"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Avg. Back Gross</div>
          <div class="vi-big ${backClass}">${backGross}</div>
        </div>
        <div class="vi-tile">
          <div class="vi-lbl"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Avg. Total Gross</div>
          <div class="vi-big ${totalClass}">${totalGross}</div>
        </div>	   
	   
        <div class="vi-tile">
          <div class="vi-lbl"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>MTD Sales Pace Used</div>
          <div class="vi-big purple">${d.mtd_salespace != null ? d.mtd_salespace : '—'}</div>
          <div class="vi-sub">units this month</div>
        </div>
        <div class="vi-tile">
          <div class="vi-lbl"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>Leads · 14d</div>
          <div class="vi-big blue">${d.leads14d != null ? d.leads14d : '—'}</div>
          <div class="vi-sub">active enquiries</div>
        </div>
        <div class="vi-tile">
          <div class="vi-lbl"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Road Tests · 14d</div>
          <div class="vi-big purple">${d.roadtests14d != null ? d.roadtests14d : '—'}</div>
          <div class="vi-sub">test drives booked</div>
        </div>

        <div class="vi-inv-tile">
          <div class="vi-inv-hdr"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>Inventory — ${d.year} ${d.make} ${d.model}</div>
          <div class="vi-inv-row">
            <div class="vi-inv-cell"><div class="vi-inv-lbl green">Online</div><div class="vi-inv-val green">${d.inventory_online != null ? d.inventory_online : '—'}</div></div>
            <div class="vi-inv-cell"><div class="vi-inv-lbl amber">In Progress</div><div class="vi-inv-val amber">${d.inventory_inprogress != null ? d.inventory_inprogress : '—'}</div></div>
            <div class="vi-inv-cell"><div class="vi-inv-lbl slate">Total</div><div class="vi-inv-val slate">${d.inventory_total != null ? d.inventory_total : '—'}</div></div>
          </div>
        </div>

		<div class="vi-grid-4col">
          <div class="vi-tile">
            <div class="vi-lbl">Avg. PTM Sold</div>
            <div class="vi-big">${mktPercent}</div>
          </div>
          <div class="vi-tile">
            <div class="vi-lbl">Trim Sales (6M)</div>
            <div class="vi-big">${d.trimsales_180 != null ? d.trimsales_180 : '—'}</div>
          </div>
          <div class="vi-tile">
            <div class="vi-lbl">Model Sales (6M)</div>
            <div class="vi-big">${d.modelsales_180 != null ? d.modelsales_180 : '—'}</div>
          </div>
          <div class="vi-tile">
            <div class="vi-lbl">Avg. days to sell</div>
            <div class="vi-big">${d.avgsoldage != null ? d.avgsoldage.toFixed(0) : '—'}</div>
          </div>
        </div>

        <div class="vi-grid-4col">
          <div class="vi-tile">
            <div class="vi-lbl">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                Over 10 Photos
            </div>
            <div class="vi-status-val">
              ${d.has10photos === null || d.has10photos === undefined || d.has10photos === "null"
                ? '<span style="color:#94a3b8;">—</span>' 
                : Number(d.has10photos) === 1 
                    ? '<span style="color:#16a34a; font-size:18px;">✔</span>' 
                    : '<span style="color:#dc2626; font-size:18px;">✘</span>'}
            </div>
          </div>

          <div class="vi-tile">
            <div class="vi-lbl">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                Price Change
            </div>
            <div class="vi-status-val" style="font-size: 10px; font-weight: 700;">${d.lastpricechangedate != null ? d.lastpricechangedate.split('T')[0] : '—'}</div>
          </div>

          <div class="vi-tile">
            <div class="vi-lbl">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>
                DeskIt deal status
            </div>
            <div class="vi-status-val" style="font-weight: 700;">${d.cdkstatus != null ? d.cdkstatus : '—'}</div>
          </div>

          <div class="vi-tile">
            <div class="vi-lbl">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                Stock Type
            </div>
            <div class="vi-status-val ${d.stocktype === 'Retail' ? 'retail' : ''}" style="font-weight: 700;">${d.stocktype != null ? d.stocktype : '—'}</div>
          </div>
        </div>
		
      </div>
    `;

    dataEl.style.display = 'flex';
    dataEl.style.flex    = '1';
    dataEl.style.overflow = 'hidden';

    setStatus('live');

    // Update bar metrics
    const bLeads = document.getElementById('vi-bar-leads');
    const bMkt   = document.getElementById('vi-bar-mkt');
    if (bLeads) bLeads.textContent = d.leads14d;	
    if (bMkt)   bMkt.textContent   = mktPercent;	
  }

  // ─── HTML builders ────────────────────────────────────────────────────────
  function buildPanelHTML(vin, stock) {
	const stockDisplay = stock ? stock : 'N/A';
    return `
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&family=DM+Mono:wght@400;500&display=swap');
#vi-panel-inner,#vi-panel-inner *,#vi-panel-inner *::before,#vi-panel-inner *::after{box-sizing:border-box;font-family:'DM Sans',-apple-system,sans-serif}
#vi-panel-inner{width: 100%;height: 100%;display: flex;flex-direction: column;border: 1px solid #d1d5db;border-radius: 7px;background: #fff;position: relative;}
@keyframes vi-in{from{opacity:0;transform:scale(.97) translateY(5px)}to{opacity:1;transform:none}}

/* Header */
.vi-hdr{background:linear-gradient(130deg,#1e3a5f 0%,#1e4fc2 100%);padding:7px 10px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;user-select:none}
.vi-hdr-l{display:flex;align-items:center;gap:7px}
.vi-logo-box{width:24px;height:24px;background:rgba(255,255,255,.15);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;letter-spacing:-.5px;border:1px solid rgba(255,255,255,.2)}
.vi-hdr-title{font-size:11px;font-weight:700;color:#fff}
.vi-hdr-vin{font-family:'DM Mono',monospace;font-size:10px;color:rgba(255,255,255,.65);background:rgba(255,255,255,.1);padding:2px 7px;border-radius:3px;border:1px solid rgba(255,255,255,.15)}
.vi-hdr-r{display:flex;align-items:center;gap:5px}
.vi-fabric-pill{display:flex;align-items:center;gap:4px;font-size:9px;color:rgba(255,255,255,.7);background:rgba(255,255,255,.08);padding:2px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.15)}
.vi-status-dot{width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 2px rgba(74,222,128,.3);transition:background .3s}
.vi-dot-loading{background:#fbbf24!important;animation:vi-pulse 1s infinite}
.vi-dot-error{background:#f87171!important}
.vi-dot-live{background:#4ade80!important}
@keyframes vi-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.vi-icon-btn{width:22px;height:22px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;padding:0;transition:background .15s;flex-shrink:0}
.vi-icon-btn:hover{background:rgba(255,255,255,.22)}

/* Body */
.vi-body{flex: 1;overflow-y: auto;background: #f8fafc;display: flex;flex-direction: column;min-height: 0;}

/* Loading */
.vi-loading{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:#94a3b8}
.vi-spinner{width:22px;height:22px;border:2px solid #e2e8f0;border-top-color:#1d4ed8;border-radius:50%;animation:vi-spin .65s linear infinite}
@keyframes vi-spin{to{transform:rotate(360deg)}}
.vi-loading-txt{font-size:11px;font-weight:500}
.vi-loading-sub{font-size:10px;color:#cbd5e1;font-family:'DM Mono',monospace}

/* Error */
.vi-error{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:16px;text-align:center}
.vi-error-icon{font-size:22px}
.vi-error-title{font-size:12px;font-weight:600;color:#374151}
.vi-error-sub{font-size:10px;color:#94a3b8}

/* Data grid */
.vi-grid{flex:1;padding:8px;display:grid;grid-template-columns: 1fr 1fr 1fr;grid-auto-rows: min-content;gap: 5px;overflow: hidden;align-content: start;}
.vi-tile{background:#fff;border:1px solid #e8ecf2;border-radius:5px;padding:7px 9px;display:flex;flex-direction: column;justify-content: center;transition: border-color .15s,box-shadow .15s;}
.vi-lbl{display:flex;align-items:center;gap:4px;font-size:9.5px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.vi-big{font-size:19px;font-weight:800;line-height:1;letter-spacing:-.5px;text-align:center;width:100%;display:block;}
.vi-big.blue{color:#1d4ed8}.vi-big.purple{color:#7c3aed}.vi-big.green{color:#16a34a;}.vi-big.red{color:#dc2626;}.vi-big.ambient{color:#64748b;}
.vi-sub{font-size:9px;color:#94a3b8;margin-top:1px}

/* Inventory */
.vi-inv-tile{grid-column:1/-1;background:#fff;border:1px solid #e8ecf2;border-radius:5px;overflow:hidden}
.vi-inv-hdr{padding:5px 9px;background:#f8fafc;border-bottom:1px solid #e8ecf2;font-size:9.5px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:4px}
.vi-inv-row{display:grid;grid-template-columns:1fr 1fr 1fr}
.vi-inv-cell{padding:6px 9px;text-align:center;border-right:1px solid #f1f5f9}
.vi-inv-cell:last-child{border-right:none}
.vi-inv-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.vi-inv-lbl.green{color:#16a34a}.vi-inv-lbl.amber{color:#d97706}.vi-inv-lbl.slate{color:#64748b}
.vi-inv-val{font-size:19px;font-weight:800;text-align:center;}
.vi-inv-val.green{color:#16a34a}.vi-inv-val.amber{color:#d97706}.vi-inv-val.slate{color:#64748b}

/* Grid (4 columns) */
.vi-grid-4col{grid-column: 1 / -1;display: grid;grid-template-columns: 1fr 1fr 1fr 1fr;gap: 5px;}
.vi-grid-4col .vi-big{font-size: 18px;}
.vi-grid-4col .vi-lbl{font-size: 8px;white-space: nowrap;}

/* Status */
.vi-status-val{font-size:12px;font-weight:700;color:#1e293b;text-align:center;width:100%;}
.vi-status-val.retail{color:#1d4ed8}

/* Stock & Tier */
.vi-hdr-meta{display: flex; gap: 4px; align-items: center;}
.vi-hdr-stock{font-family: 'DM Mono', monospace;font-size: 10px; color: #fff; background: rgba(16, 185, 129, 0.2); padding: 2px 7px; border-radius: 3px; border: 1px solid rgba(16, 185, 129, 0.3);}
.vi-hdr-tier{font-family: 'DM Sans', sans-serif;font-size: 10px;font-weight: 700;padding: 2px 8px;border-radius: 3px;text-transform: uppercase;border: 1px solid rgba(255, 255, 255, 0.2);color: #fff;transition: all 0.3s ease;}
.vi-tier-1{background:#16a34a;border-color:#15803d;} /* Dark green */
.vi-tier-2{background:#84cc16;border-color:#65a30d;} /* Light green / Lime */
.vi-tier-3{background:#eab308;border-color:#ca8a04;} /* Yellow / Gold */
.vi-tier-4{background:#f97316;border-color:#ea580c;} /* Orange */
.vi-tier-5{background:#dc2626;border-color:#b91c1c;} /* Red */
.vi-tier-null{background: rgba(148, 163, 184, 0.2);color: #94a3b8;border-color: rgba(148, 163, 184, 0.3);font-family: 'DM Mono', monospace;}

/* Version */
.vi-version { position: absolute; bottom: 8px; right: 4px; writing-mode: vertical-rl; transform: rotate(180deg); color: #94a3b8; font-size: 9px; opacity: 0.7; pointer-events: none; }
</style>

<div id="vi-panel-inner">
  <div class="vi-hdr">
    <div class="vi-hdr-l">
      <div class="vi-logo-box">VI</div>
      <div class="vi-hdr-meta">
        <span class="vi-hdr-title">Vehicle Intelligence</span>
        <span class="vi-hdr-vin">${vin}</span>
        <span class="vi-hdr-stock" title="Stock Number">STK: ${stockDisplay}</span>
		<span class="vi-hdr-tier" id="vi-tier-pill">Loading...</span>
      </div>
    </div>
    <div class="vi-hdr-r">
      <div class="vi-fabric-pill">
        <div class="vi-status-dot vi-dot-loading" id="vi-status-dot"></div>
        <span id="vi-status-txt">Fabric</span>
      </div>
      <button class="vi-icon-btn" title="Refresh">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
      <button class="vi-icon-btn" title="Minimize to bar">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  </div>

  <div class="vi-body">
    <div class="vi-loading" id="vi-loading">
      <div class="vi-spinner"></div>
      <div class="vi-loading-txt">Fetching from Microsoft Fabric</div>
      <div class="vi-loading-sub">${vin}</div>
    </div>
    <div id="vi-data" style="display:none;flex:1;overflow:hidden;flex-direction:column;"></div>
    <div class="vi-error" id="vi-error" style="display:none;">
      <div class="vi-error-icon">⚠️</div>
      <div class="vi-error-title">Connection Error</div>
      <div class="vi-error-sub" id="vi-error-msg">Check Fabric settings in the extension popup</div>
    </div>
  </div>
  
  <div class="vi-version">v.${chrome.runtime.getManifest().version}</div>

</div>`;
  }

  function buildBarHTML(vin) {
    return `
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,500;9..40,700;9..40,800&family=DM+Mono:wght@400&display=swap');
#vi-bar-inner,#vi-bar-inner *{box-sizing:border-box;font-family:'DM Sans',-apple-system,sans-serif}
#vi-bar-inner{display:flex;align-items:center;gap:9px;background:linear-gradient(130deg,#1e3a5f,#1e4fc2);border-radius:9px;padding:8px 13px;box-shadow:0 6px 24px rgba(29,78,216,.38),0 2px 6px rgba(0,0,0,.14);cursor:pointer;transition:transform .15s,box-shadow .15s;border:1px solid rgba(255,255,255,.15);min-width:230px;animation:vi-bar-in .28s cubic-bezier(.34,1.4,.64,1)}
#vi-bar-inner:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(29,78,216,.48),0 3px 8px rgba(0,0,0,.15)}
@keyframes vi-bar-in{from{opacity:0;transform:translateY(14px) scale(.94)}to{opacity:1;transform:none}}
.vi-bar-logo{width:26px;height:26px;background:rgba(255,255,255,.15);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0;border:1px solid rgba(255,255,255,.2)}
.vi-bar-info{flex:1;min-width:0}
.vi-bar-title{font-size:11px;font-weight:700;color:#fff;line-height:1.2}
.vi-bar-vin{font-size:9px;color:rgba(255,255,255,.5);font-family:'DM Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vi-bar-metrics{display:flex;gap:5px}
.vi-bar-metric{text-align:center;background:rgba(255,255,255,.1);border-radius:4px;padding:3px 8px;border:1px solid rgba(255,255,255,.12)}
.vi-bar-mval{font-size:14px;font-weight:800;color:#fff;line-height:1}
.vi-bar-mlbl{font-size:8px;color:rgba(255,255,255,.5);margin-top:1px}
.vi-bar-expand{width:24px;height:24px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:4px;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s}
#vi-bar-inner:hover .vi-bar-expand{background:rgba(255,255,255,.22)}
</style>
<div id="vi-bar-inner" title="Expand Vehicle Intelligence">
  <div class="vi-bar-logo">VI</div>
  <div class="vi-bar-info">
    <div class="vi-bar-title">Vehicle Intelligence</div>
    <div class="vi-bar-vin">${vin}</div>
  </div>
  <div class="vi-bar-metrics">
    <div class="vi-bar-metric">
      <div class="vi-bar-mval" id="vi-bar-leads">—</div>
      <div class="vi-bar-mlbl">Leads</div>
    </div>
    <div class="vi-bar-metric">
      <div class="vi-bar-mval" id="vi-bar-mkt">—</div>
      <div class="vi-bar-mlbl">Mkt%</div>
    </div>
  </div>
  <div class="vi-bar-expand">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
  </div>
</div>`;
  }

  // ─── Watch for modal + VIN changes ────────────────────────────────────────
  let lastModalCheck = 0;
  let currentStock = null;
  
	function checkForModal() {
		const now = Date.now();
		if (now - lastModalCheck < 400) return;
		lastModalCheck = now;

		// 1. Define only the real data containers
		const modal = document.querySelector('.pricing-modal-class');
		const header = document.getElementById('headerVehicleSummary');
		const iframe = document.getElementById('GaugePageIFrame');

		// 2. Check activity (if any of them exists, treat the view as open)
		// Removed document.body and outerTabs
		const hasPricingModal = !!(modal || header || iframe);

		if (!hasPricingModal) {
			// Vehicle view closed — clean up the panel and bar
			if (injectedPanel) { injectedPanel.remove(); injectedPanel = null; }
			if (injectedBar)   { injectedBar.remove();   injectedBar   = null; }
			
			// Reset state so the script is ready for the next vehicle
			currentVin   = null;
			currentStock = null;
			return;
		}

		// 3. Get the data (assuming the detect functions already handle the iframe)
		const vin = detectVin();
		const stock = detectStock();
		
		// --- Log changes to the console (only when a new value is detected) ---
		if ((vin || stock) && (vin !== currentVin || stock !== currentStock)) {
			console.log(`%c[VI Extension] Found -> VIN: ${vin || '❌'}, Stock: ${stock || '❌'}`, "color: #1e4fc2; font-weight: bold;");
		}
		
		if (!vin) return;

		// 4. Panel injection/update logic
		if (vin !== currentVin || stock !== currentStock) {
			// Vehicle changed or first detection — clear the old and build the new
			if (injectedPanel) { injectedPanel.remove(); injectedPanel = null; }
			if (injectedBar)   { injectedBar.remove();   injectedBar   = null; }
			
			currentVin   = vin;
			currentStock = stock;
			injectPanel(vin, stock);
		} else if (!injectedPanel) {
			// If the data is the same but the panel disappeared (e.g. after a DOM fragment reload)
			injectPanel(vin, stock);
		}
	}

  const mutObs = new MutationObserver(checkForModal);
  mutObs.observe(document.body, { childList: true, subtree: true });
  setInterval(checkForModal, 1500);
  checkForModal();

})();
