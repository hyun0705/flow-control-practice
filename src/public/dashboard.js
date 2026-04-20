'use strict';

/* dom */
const $ = (id) => document.getElementById(id);

const connDot      = $('connDot');
const statusBadge  = $('statusBadge');
const totalProcessed = $('totalProcessed');
const totalRejected = $('totalRejected');
const queueSizeEl  = $('queueSize');
const queueBar     = $('queueBar');
const avgWaitMsEl  = $('avgWaitMs');
const slotText     = $('slotText');
const slotGrid     = $('slotGrid');
const tokenAvailable = $('tokenAvailable');
const tokenSub     = $('tokenSub');
const tokenGauge   = $('tokenGauge');
const ratePendingEl = $('ratePending');
const rateSubEl    = $('rateSub');
const rateGaugeEl  = $('rateGauge');
const sendBtn      = $('sendBtn');
const burstBtn     = $('burstBtn');
const burstCount   = $('burstCount');
const burstDec     = $('burstDec');
const burstInc     = $('burstInc');
const resetBtn     = $('resetBtn');
const logList      = $('logList');

const statusBanner = $('statusBanner');
const bannerTitle  = $('bannerTitle');
const bannerDesc   = $('bannerDesc');
const stageToken   = $('stageToken');
const stageRate    = $('stageRate');
const stageQueue   = $('stageQueue');
const stageSlot    = $('stageSlot');
const stageTokenAvail = $('stageTokenAvail');
const stageTokenCap  = $('stageTokenCap');
const stageRateCount = $('stageRateCount');
const stageQueueCount = $('stageQueueCount');
const stageSlotActive = $('stageSlotActive');
const stageSlotMax = $('stageSlotMax');
const stageDoneCount = $('stageDoneCount');
const helpBtn      = $('helpBtn');
const helpPanel    = $('helpPanel');
const helpCloseBtn = $('helpCloseBtn');

/* slot grid */
let currentMaxSlots = 0;
function initSlotGrid(max) {
  if (currentMaxSlots === max) return;
  currentMaxSlots = max;
  slotGrid.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const d = document.createElement('div');
    d.className = 'slot';
    slotGrid.appendChild(d);
  }
}
function updateSlotGrid(active, max) {
  initSlotGrid(max);
  slotGrid.querySelectorAll('.slot').forEach((s, i) => {
    s.classList.toggle('active', i < active);
  });
}

/* metrics → dom */
function updateDashboard(m) {
  const { concurrency, tokenBucket, queue, rate, totals } = m;

  totalProcessed.textContent = String(concurrency.totalProcessed);
  if (totalRejected) totalRejected.textContent = String(totals ? totals.rejected : 0);

  const qs = queue.size;
  const qcap = queue.capacity ?? 100;
  queueSizeEl.textContent = qs + ' / ' + qcap;
  queueBar.style.width = Math.min(100, (qs / qcap) * 100) + '%';

  avgWaitMsEl.innerHTML = concurrency.avgWaitMs + '<span class="cell__u">ms</span>';

  slotText.textContent = concurrency.activeCount + ' / ' + concurrency.maxConcurrent;
  updateSlotGrid(concurrency.activeCount, concurrency.maxConcurrent);

  tokenAvailable.textContent = String(tokenBucket.available);
  tokenSub.textContent = '/ ' + tokenBucket.capacity + ' · refill ' + tokenBucket.refillRate + '/s';
  const tokenPct = tokenBucket.capacity > 0 ? (tokenBucket.available / tokenBucket.capacity) * 100 : 0;
  tokenGauge.style.width = tokenPct + '%';

  const rp = rate ? (rate.pending ?? 0) : 0;
  const rc = rate ? (rate.pendingCapacity ?? 0) : 0;
  const rAvg = rate ? (rate.avgRateWaitMs ?? 0) : 0;
  ratePendingEl.textContent = String(rp);
  rateSubEl.textContent = '/ ' + rc + ' · avg ' + rAvg + 'ms';
  rateGaugeEl.style.width = (rc > 0 ? Math.min(100, (rp / rc) * 100) : 0) + '%';

  updateFlow({
    tokenAvail: tokenBucket.available,
    tokenCap: tokenBucket.capacity,
    ratePending: rp,
    queueSize: qs,
    slotActive: concurrency.activeCount,
    slotMax: concurrency.maxConcurrent,
    totalDone: concurrency.totalProcessed,
  });
  updateBanner({
    tokenAvail: tokenBucket.available,
    ratePending: rp,
    queueSize: qs,
    slotActive: concurrency.activeCount,
    slotMax: concurrency.maxConcurrent,
  });
}

function updateFlow(s) {
  stageTokenAvail.textContent = String(s.tokenAvail);
  stageTokenCap.textContent = String(s.tokenCap);
  stageRateCount.textContent = String(s.ratePending);
  stageQueueCount.textContent = String(s.queueSize);
  stageSlotActive.textContent = String(s.slotActive);
  stageSlotMax.textContent = String(s.slotMax);
  stageDoneCount.textContent = String(s.totalDone);

  setStage(stageToken,
    s.tokenAvail === 0 ? 'saturated'
      : (s.tokenAvail <= s.tokenCap * 0.3 ? 'warning'
      : (s.tokenAvail < s.tokenCap ? 'active' : '')));
  setStage(stageRate,
    s.ratePending > 10 ? 'saturated' : (s.ratePending > 0 ? 'active' : ''));
  setStage(stageQueue,
    s.queueSize > 10 ? 'saturated' : (s.queueSize > 0 ? 'active' : ''));
  setStage(stageSlot,
    s.slotActive === s.slotMax ? 'saturated' : (s.slotActive > 0 ? 'active' : ''));
}

function setStage(el, state) {
  if (!el) return;
  el.classList.remove('is-active', 'is-warning', 'is-saturated');
  if (state === 'active') el.classList.add('is-active');
  else if (state === 'warning') el.classList.add('is-warning');
  else if (state === 'saturated') el.classList.add('is-saturated');
}

function updateBanner(s) {
  const busy = s.ratePending + s.queueSize;
  let mode, title, desc;
  if (busy === 0 && s.slotActive === 0) {
    mode = 'idle'; title = 'idle'; desc = '대기 중. 트래픽이 들어오면 상태가 바뀝니다.';
  } else if (s.ratePending > 10 || s.queueSize > 10) {
    mode = 'saturated'; title = 'saturated';
    desc = `대기 누적 — rate-q ${s.ratePending} · queue ${s.queueSize}. 일부 요청은 거절됩니다.`;
  } else if (busy > 0) {
    mode = 'waiting'; title = 'waiting';
    desc = `processing ${s.slotActive} · rate-q ${s.ratePending} · queue ${s.queueSize}.`;
  } else {
    mode = 'normal'; title = 'normal';
    desc = `processing ${s.slotActive}. 대기 없음.`;
  }
  statusBanner.dataset.mode = mode;
  bannerTitle.textContent = title;
  bannerDesc.textContent = desc;
}

/* log — 무제한 누적 (scroll로 탐색). reset 클릭 시만 비움. */
function addLog(msg, type) {
  const li = document.createElement('li');
  const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  li.textContent = ts + '  ' + msg;
  if (type === 'ok') li.classList.add('ok');
  else if (type === 'err') li.classList.add('err');
  logList.prepend(li);
}

/* sse */
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    connDot.className = 'dot is-ok';
    statusBadge.textContent = 'connected';
  };
  es.onmessage = (e) => {
    try { updateDashboard(JSON.parse(e.data)); } catch (_) { /* noop */ }
  };
  es.onerror = () => {
    connDot.className = 'dot is-bad';
    statusBadge.textContent = 'reconnecting';
  };
  return es;
}

/* send one */
async function sendOne(seq) {
  const start = Date.now();
  try {
    const res = await fetch('/api/work', { method: 'POST' });
    const elapsed = Date.now() - start;
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      addLog(`#${seq}  200  ${elapsed}ms  work=${data.processedMs ?? '?'}ms`, 'ok');
      return { ok: true, status: 200 };
    }
    const data = await res.json().catch(() => ({}));
    addLog(`#${seq}  ${res.status}  ${data.error || res.statusText}`, 'err');
    return { ok: false, status: res.status };
  } catch (err) {
    addLog(`#${seq}  network error: ${err.message}`, 'err');
    return { ok: false, status: 0 };
  }
}

/* single send */
sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  await sendOne('·');
  sendBtn.disabled = false;
});

/* burst — NDJSON 스트리밍 파싱 (태스크 완료마다 로그) */
async function streamBurst(n) {
  const res = await fetch('/api/burst?n=' + n, { method: 'POST' });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    addLog(`burst failed ${res.status} ${txt}`, 'err');
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      handleBurstEvent(obj);
    }
  }
}

function handleBurstEvent(e) {
  if (e.type === 'start') {
    addLog(`burst start · n=${e.n}`);
  } else if (e.type === 'task') {
    const tag = e.status === 200 ? 'ok' : 'err';
    if (e.status === 200) {
      addLog(`#${e.seq}  200  ${e.elapsedMs}ms  work=${e.processedMs ?? '?'}ms`, tag);
    } else {
      addLog(`#${e.seq}  ${e.status}  ${e.error || ''}`, tag);
    }
  } else if (e.type === 'done') {
    addLog(
      `burst done  ${e.elapsedMs}ms  200:${e.ok} 429:${e.rateLimited} 503:${e.queueFull}`,
      'ok'
    );
  } else if (e.type === 'error') {
    addLog(`burst error: ${e.error}`, 'err');
  }
}

burstBtn.addEventListener('click', async () => {
  const n = Math.max(1, Math.min(1000, parseInt(burstCount.value, 10) || 1));
  burstBtn.disabled = true;
  sendBtn.disabled = true;
  try {
    await streamBurst(n);
  } catch (err) {
    addLog(`burst network error: ${err.message}`, 'err');
  }
  burstBtn.disabled = false;
  sendBtn.disabled = false;
});

/* burst 숫자 stepper (클릭 시 ±10, shift-click 시 ±50) */
function clampBurst(v) {
  return Math.max(1, Math.min(1000, v));
}
function bumpBurst(delta) {
  const cur = parseInt(burstCount.value, 10) || 20;
  burstCount.value = String(clampBurst(cur + delta));
}
burstDec.addEventListener('click', (e) => bumpBurst(e.shiftKey ? -50 : -10));
burstInc.addEventListener('click', (e) => bumpBurst(e.shiftKey ? +50 : +10));

/* reset — 카운터/샘플 초기화 + 로그 클리어 */
resetBtn.addEventListener('click', async () => {
  resetBtn.disabled = true;
  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    if (res.ok) {
      logList.innerHTML = '';
      addLog('reset · counters cleared');
    } else {
      addLog(`reset failed ${res.status}`, 'err');
    }
  } catch (err) {
    addLog(`reset error: ${err.message}`, 'err');
  }
  resetBtn.disabled = false;
});

/* help toggle */
helpBtn.addEventListener('click', () => {
  helpPanel.hidden = !helpPanel.hidden;
  helpBtn.textContent = helpPanel.hidden ? 'Help' : 'Close';
});
helpCloseBtn.addEventListener('click', () => {
  helpPanel.hidden = true;
  helpBtn.textContent = 'Help';
});

/* init */
connectSSE();
addLog('init · connecting sse');
