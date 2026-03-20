// popup.js

const $ = id => document.getElementById(id);

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// Auto-submit toggle updates description + dashboard alert
$('autoSubmit').addEventListener('change', () => {
  updateModeUI($('autoSubmit').checked);
});

function updateModeUI(autoSubmit) {
  $('modeDesc').textContent = autoSubmit
    ? 'ON — bids placed automatically'
    : 'OFF — proposals saved for manual review';
  const alert = $('modeAlert');
  if (autoSubmit) {
    alert.className = 'alert';
    alert.textContent = '⚠️ Auto-submit is active. Bids will be placed without confirmation.';
  } else {
    alert.className = 'alert info-alert';
    alert.textContent = '👁 Manual mode — proposals will open in a tab for you to review and submit.';
  }
}

// Load saved config
chrome.storage.local.get([
  'apiKey', 'userBio', 'catWebDev', 'catDataEntry',
  'minBudget', 'maxBudget', 'scanInterval', 'searchUrl', 'autoSubmit',
  'isRunning', 'stats', 'bidLog', 'activityLog'
], data => {
  if (data.apiKey) $('apiKey').value = data.apiKey;
  if (data.userBio) $('userBio').value = data.userBio;
  if (data.searchUrl) $('searchUrl').value = data.searchUrl;
  $('catWebDev').checked = data.catWebDev !== false;
  $('catDataEntry').checked = data.catDataEntry !== false;
  if (data.minBudget !== undefined) $('minBudget').value = data.minBudget;
  if (data.maxBudget !== undefined) $('maxBudget').value = data.maxBudget;
  if (data.scanInterval !== undefined) $('scanInterval').value = data.scanInterval;

  const autoSubmit = data.autoSubmit !== false; // default true
  $('autoSubmit').checked = autoSubmit;
  updateModeUI(autoSubmit);

  updateStats(data.stats || { scanned: 0, submitted: 0, errors: 0 });

  if (data.isRunning) setRunningUI(true);

  if (data.bidLog && data.bidLog.length) renderBidLog(data.bidLog);

  if (data.activityLog && data.activityLog.length) {
    const feed = $('logFeed');
    feed.innerHTML = '';
    data.activityLog.slice(-30).forEach(entry => appendLog(entry.msg, entry.type, entry.time, false));
    feed.scrollTop = feed.scrollHeight;
  }
});

// Save config
$('btnSave').addEventListener('click', () => {
  const config = {
    apiKey: $('apiKey').value.trim(),
    userBio: $('userBio').value.trim(),
    searchUrl: $('searchUrl').value.trim(),
    catWebDev: $('catWebDev').checked,
    catDataEntry: $('catDataEntry').checked,
    minBudget: parseInt($('minBudget').value) || 0,
    maxBudget: parseInt($('maxBudget').value) || 9999,
    scanInterval: parseInt($('scanInterval').value) || 5,
    autoSubmit: $('autoSubmit').checked,
  };
  chrome.storage.local.set(config, () => {
    const badge = $('savedBadge');
    badge.style.display = 'block';
    setTimeout(() => badge.style.display = 'none', 2000);
  });
});

// Start agent
$('btnStart').addEventListener('click', () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { alert('Please enter your Anthropic API key in the Config tab first.'); return; }
  if (!$('userBio').value.trim()) { alert('Please add your bio/skills in the Config tab first.'); return; }

  chrome.storage.local.set({
    apiKey,
    userBio: $('userBio').value.trim(),
    searchUrl: $('searchUrl').value.trim(),
    catWebDev: $('catWebDev').checked,
    catDataEntry: $('catDataEntry').checked,
    minBudget: parseInt($('minBudget').value) || 0,
    maxBudget: parseInt($('maxBudget').value) || 9999,
    scanInterval: parseInt($('scanInterval').value) || 5,
    autoSubmit: $('autoSubmit').checked,
    isRunning: true
  }, () => {
    chrome.runtime.sendMessage({ action: 'START_AGENT' });
    setRunningUI(true);
    appendLog('Agent started. Scanning Freelancer...', 'success');
  });
});

// Stop agent
$('btnStop').addEventListener('click', () => {
  chrome.storage.local.set({ isRunning: false }, () => {
    chrome.runtime.sendMessage({ action: 'STOP_AGENT' });
    setRunningUI(false);
    appendLog('Agent stopped by user.', 'warn');
  });
});

// Listen for background messages
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') appendLog(msg.text, msg.level);
  if (msg.type === 'STATS_UPDATE') updateStats(msg.stats);
  if (msg.type === 'BID_ADDED') addBidItem(msg.bid);
});

function setRunningUI(running) {
  const dot = $('statusDot');
  const statusText = $('statusText');
  if (running) {
    dot.className = 'status-dot running';
    statusText.textContent = 'RUNNING';
    $('btnStart').style.display = 'none';
    $('btnStop').style.display = 'block';
  } else {
    dot.className = 'status-dot active';
    statusText.textContent = 'IDLE';
    $('btnStart').style.display = 'block';
    $('btnStop').style.display = 'none';
  }
}

function updateStats(stats) {
  $('statScanned').textContent = stats.scanned || 0;
  $('statSubmitted').textContent = stats.submitted || 0;
  $('statErrors').textContent = stats.errors || 0;
}

function appendLog(msg, type = 'info', time = null, persist = true) {
  const feed = $('logFeed');
  const now = time || new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">${now}</span><span class="log-msg ${type}">${msg}</span>`;
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
  if (persist) {
    chrome.storage.local.get('activityLog', data => {
      const log = data.activityLog || [];
      log.push({ msg, type, time: now });
      if (log.length > 100) log.splice(0, log.length - 100);
      chrome.storage.local.set({ activityLog: log });
    });
  }
}

function renderBidLog(bids) {
  const list = $('bidList');
  list.innerHTML = '';
  bids.slice().reverse().forEach(bid => list.appendChild(createBidElement(bid)));
}

function addBidItem(bid) {
  const list = $('bidList');
  const placeholder = list.querySelector('div[style]');
  if (placeholder) list.innerHTML = '';
  list.insertBefore(createBidElement(bid), list.firstChild);
}

function createBidElement(bid) {
  const el = document.createElement('div');
  el.className = 'bid-item';

  const badgeClass = bid.status === 'submitted' ? 'badge-submitted'
    : bid.status === 'manual' ? 'badge-manual'
    : bid.status === 'error' ? 'badge-error'
    : 'badge-pending';

  const clientBudgetStr = bid.clientBudget ? `$${bid.clientBudget}` : (bid.budget || 'N/A');
  const bidAmountStr = bid.bidAmount ? ` → bid $${bid.bidAmount}` : '';

  el.innerHTML = `
    <div class="bid-summary" role="button" tabindex="0" aria-expanded="false">
      <div style="flex:1;min-width:0">
        <div class="bid-title">${bid.title || 'Untitled'}</div>
        <div class="bid-meta">
          <span>${clientBudgetStr}${bidAmountStr}</span>
          ${bid.category ? `<span>·</span><span>${bid.category}</span>` : ''}
          <span>·</span><span>${bid.time || ''}</span>
        </div>
      </div>
      <div class="bid-right">
        <span class="bid-badge ${badgeClass}">${(bid.status || 'unknown').toUpperCase()}</span>
        <span class="bid-chevron">▼</span>
      </div>
    </div>
    <div class="bid-detail">
      <div class="bid-detail-label">Project Details</div>
      <div class="bid-detail-row">
        <div class="bid-detail-kv"><span>Client budget: </span>${clientBudgetStr}</div>
        ${bid.bidAmount ? `<div class="bid-detail-kv"><span>Your bid: </span>$${bid.bidAmount}</div>` : ''}
        ${bid.category ? `<div class="bid-detail-kv"><span>Category: </span>${bid.category}</div>` : ''}
      </div>
      ${bid.tags && bid.tags.length ? `<div class="bid-detail-kv" style="margin-bottom:6px"><span>Skills: </span>${bid.tags.slice(0,6).join(', ')}</div>` : ''}
      ${bid.url ? `<a class="bid-open-link" href="${bid.url}" target="_blank">↗ Open on Freelancer</a>` : ''}
      <div class="bid-detail-label" style="margin-top:10px">Proposal</div>
      <div class="bid-proposal-text">${bid.proposal || '(not saved)'}</div>
    </div>
  `;

  const summary = el.querySelector('.bid-summary');
  const detail = el.querySelector('.bid-detail');

  function setExpanded(open) {
    detail.classList.toggle('open', open);
    el.classList.toggle('expanded', open);
    summary.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function toggleAccordion() {
    const wasOpen = detail.classList.contains('open');
    document.querySelectorAll('#bidList .bid-item').forEach(item => {
      item.classList.remove('expanded');
      const d = item.querySelector('.bid-detail');
      if (d) d.classList.remove('open');
      const s = item.querySelector('.bid-summary');
      if (s) s.setAttribute('aria-expanded', 'false');
    });
    if (!wasOpen) setExpanded(true);
  }

  summary.addEventListener('click', e => {
    e.preventDefault();
    toggleAccordion();
  });
  summary.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleAccordion();
    }
  });
  el.querySelector('.bid-open-link')?.addEventListener('click', e => e.stopPropagation());

  return el;
}
