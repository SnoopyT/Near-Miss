/* src/public/js/app.js — Near Miss GUI logic */

(() => {
'use strict';

// ---------- state ----------
const state = {
  point: null,        // {lat,lng}
  scope: null,        // spatial scope from reverse geocode
  placeLabel: '',
  results: null,      // last search result
  mainMap: null, miniMap: null,
  mainMarker: null, mainLayers: null,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmtKm = (d) => (d == null ? '—' : d < 1 ? (Math.round(d * 1000) + ' m') : (d + ' km'));
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + type; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let json;
  try { json = await res.json(); } catch (_e) { json = {}; }
  if (!res.ok || json.error) {
    throw new Error(json.error || ('HTTP ' + res.status));
  }
  return json;
}

// ---------- tabs ----------
$$('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
function switchTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  // leaflet needs invalidateSize when shown
  setTimeout(() => {
    if (state.mainMap) state.mainMap.invalidateSize();
    if (state.miniMap) state.miniMap.invalidateSize();
  }, 80);
}

// ---------- maps ----------
function initMainMap() {
  // AMap serves no usable tiles below z3 (blank land, grey gaps, no borders),
  // so the zoom floor is pinned to 3 — the zoom-out control disables there.
  state.mainMap = L.map('map', { zoomControl: true, minZoom: 3 }).setView([35.86, 104.19], 3); // China center, zoomed out one level
  window.__nmMap = state.mainMap; // exposed for diagnostics
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    maxZoom: 18, minZoom: 3, subdomains: ['1', '2', '3', '4'], attribution: '© Gaode Maps',
  }).addTo(state.mainMap);
  state.mainMap.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng, null));
}

function initMiniMap() {
  // Never initialize mini map here — it's handled in drawMiniMap when
  // the results tab becomes visible and the container has a size.
}

const LAYER_COLOR = { core: '#e63946', companion: '#f4a261', empathy: '#457b9d' };

function clearMainEventLayers() {
  if (state.mainLayers) {
    state.mainLayers.forEach((l) => state.mainMap.removeLayer(l));
  }
  state.mainLayers = [];
}

function drawQueryPoint() {
  if (state.mainMarker) state.mainMap.removeLayer(state.mainMarker);
  if (!state.point) return;
  state.mainMarker = L.circleMarker(state.point, {
    radius: 8, color: '#fff', weight: 2, fillColor: '#4a7cff', fillOpacity: 1,
  }).addTo(state.mainMap);
  // draw the three concentric rings
  clearMainEventLayers();
  const cfg = state.cfg || { coreRadiusKm: 1, companionRadiusKm: 50 };
  const rings = [
    [cfg.coreRadiusKm, '#e63946'],
    [cfg.companionRadiusKm, '#f4a261'],
    [Math.max(cfg.companionRadiusKm * 4, 200), '#457b9d'],
  ];
  rings.forEach(([r, color]) => {
    const c = L.circle(state.point, { radius: r * 1000, color, weight: 1, fillOpacity: 0.04, dashArray: '4 4' });
    c.addTo(state.mainMap); state.mainLayers.push(c);
  });
}

// ---------- place / point selection ----------
async function setPoint(lat, lng, label) {
  state.point = { lat, lng };
  state.placeLabel = label || '';
  $('#coordInput').value = lat.toFixed(5) + ', ' + lng.toFixed(5);
  $('#searchBtn').disabled = false;
  drawQueryPoint();
  state.mainMap.setView([lat, lng], Math.max(state.mainMap.getZoom(), 11));

  // fetch reverse scope (for display + query enhancement)
  $('#scopeBox').classList.add('muted');
  $('#scopeBox').textContent = '正在解析行政区划以增强检索词…';
  try {
    const r = await api('/api/reverse?lat=' + lat + '&lng=' + lng);
    state.scope = r.scope;
    state.placeLabel = r.scope.placeLabel || state.placeLabel;
    renderScopeBox();
  } catch (e) {
    $('#scopeBox').textContent = '行政区划解析失败（' + e.message + '），仍可继续查询。';
    state.scope = null;
  }
}

async function searchPlace() {
  const q = $('#placeInput').value.trim();
  if (!q) return toast('请输入地名。', 'error');
  $('#placeSearchBtn').disabled = true;
  try {
    const r = await api('/api/geocode?q=' + encodeURIComponent(q));
    state.scope = r.scope;
    await setPoint(r.point.lat, r.point.lng, q);
    toast('已定位：' + (r.displayName || q), 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('#placeSearchBtn').disabled = false;
  }
}

function renderScopeBox() {
  const sc = state.scope;
  if (!sc) { $('#scopeBox').textContent = '尚未选取位置。'; return; }
  $('#scopeBox').classList.remove('muted');
  const lines = [];
  lines.push(`<div class="sc-line">📍 ${escapeHtml(state.placeLabel)}</div>`);
  if (sc.core) lines.push(`<div class="sc-line">🔍 ${escapeHtml(sc.core)}</div>`);
  $('#scopeBox').innerHTML = lines.join('');
}

$('#placeSearchBtn').addEventListener('click', searchPlace);
$('#placeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchPlace(); });

// ---------- wheel date pickers ----------
// iOS-style scroll-wheel date picker: three snap-scrolling columns (year /
// month / day). The centered item is the value; day count rebuilds on
// year/month change so leap years stay correct.
const WHEEL_ITEM_H = 36;
const WHEEL_YEAR_MIN = 1900;

function createWheelCol(container, { min, max, value, suffix, onChange }) {
  const list = document.createElement('div');
  list.className = 'wheel-col';
  const items = [];
  for (let v = min; v <= max; v++) {
    const it = document.createElement('div');
    it.className = 'wheel-item';
    it.textContent = String(v) + (suffix || '');
    list.appendChild(it);
    items.push(it);
  }
  container.appendChild(list);

  let val = value;
  function highlight() {
    const idx = Math.round(list.scrollTop / WHEEL_ITEM_H);
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    items.forEach((el, i) => el.classList.toggle('active', i === clamped));
    val = min + clamped;
  }
  list.addEventListener('scroll', () => {
    clearTimeout(list._t);
    highlight();
    list._t = setTimeout(() => { highlight(); if (onChange) onChange(val); }, 140);
  });

  // Precise wheel stepping: one notch = exactly one item. Native wheel scroll
  // would fly several items per notch (and chain into page scrolling), making
  // a specific date impossible to land on.
  let acc = 0, accT = null;
  function step(dir) {
    const cur = Math.round(list.scrollTop / WHEEL_ITEM_H);
    const target = Math.max(0, Math.min(items.length - 1, cur + dir));
    list.scrollTo({ top: target * WHEEL_ITEM_H, behavior: 'smooth' });
  }
  list.addEventListener('wheel', (e) => {
    e.preventDefault();
    acc += e.deltaY;
    clearTimeout(accT);
    accT = setTimeout(() => { acc = 0; }, 200);
    while (Math.abs(acc) >= 40) {
      const dir = acc > 0 ? 1 : -1;
      acc -= dir * 40;
      step(dir);
    }
  }, { passive: false });

  // Click an item to select it directly.
  items.forEach((it, i) => {
    it.addEventListener('click', () => {
      list.scrollTo({ top: i * WHEEL_ITEM_H, behavior: 'smooth' });
    });
  });

  function set(v) {
    v = Math.max(min, Math.min(max, v));
    val = v;
    list.scrollTop = (v - min) * WHEEL_ITEM_H;
    highlight();
  }
  function get() { return val; }

  // Position after layout so scrollTop lands exactly on the selected item.
  requestAnimationFrame(() => set(value));
  return { get, set, list };
}

function createDatePicker(container, { onChange, defaultDate }) {
  const today = new Date();
  const init = defaultDate || today;

  const box = document.createElement('div');
  box.className = 'wheel-box';
  container.appendChild(box);

  let yearCol, monthCol, dayCol;

  function daysIn(y, m) { return new Date(y, m, 0).getDate(); } // m is 1-based

  function rebuildDays(keep) {
    const n = daysIn(yearCol.get(), monthCol.get());
    const old = dayCol ? dayCol.get() : keep;
    if (dayCol) dayCol.list.remove();
    dayCol = createWheelCol(box, {
      min: 1, max: n,
      value: Math.min(old || 1, n),
      suffix: ' 日',
      onChange,
    });
  }

  yearCol = createWheelCol(box, {
    min: WHEEL_YEAR_MIN, max: today.getFullYear(), value: init.getFullYear(),
    suffix: ' 年', onChange: () => { rebuildDays(); if (onChange) onChange(getValue()); },
  });
  monthCol = createWheelCol(box, {
    min: 1, max: 12, value: init.getMonth() + 1,
    suffix: ' 月', onChange: () => { rebuildDays(); if (onChange) onChange(getValue()); },
  });
  rebuildDays(init.getDate());

  function getValue() {
    const p = (n) => String(n).padStart(2, '0');
    return `${yearCol.get()}-${p(monthCol.get())}-${p(dayCol.get())}`;
  }
  function setValue(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return;
    const [y, m, d] = iso.split('-').map(Number);
    yearCol.set(y);
    monthCol.set(m);
    rebuildDays(d);
  }
  return { getValue, setValue };
}

// default range: 2022-01-01 → 2024-01-01
const wheelFrom = createDatePicker($('#wheelFrom'), { defaultDate: new Date(2022, 0, 1) });
const wheelTo = createDatePicker($('#wheelTo'), { defaultDate: new Date(2024, 0, 1) });

function getTimePayload() {
  const from = wheelFrom.getValue(), to = wheelTo.getValue();
  if (from > to) {
    toast('开始日期不能晚于结束日期。', 'error');
    return null;
  }
  return { mode: 'range', from, to };
}

// ---------- search ----------
async function runSearch(pointOverride) {
  const point = pointOverride || state.point;
  const time = getTimePayload();
  if (!point) return toast('请先选取查询位置。', 'error');
  if (!time) return toast('请设定查询时间。', 'error');

  $('#searchBtn').disabled = true;
  $('#queryStatus').className = 'status';
  const t0 = Date.now();
  // live elapsed-time ticker while the model works
  $('#queryStatus').textContent = '正在联网检索…';
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('#queryStatus').textContent = `正在联网检索，已用时 ${s} 秒…（模型可能进行多次搜索，请耐心等待）`;
  }, 500);

  const payload = { point, time, placeLabel: state.placeLabel, scope: state.scope };
  try {
    const r = await api('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    r.elapsedMs = Date.now() - t0;
    state.results = r;
    state.point = r.point || point;
    renderResults(r);
    toast(`检索完成：${(r.events || []).length} 条事件，用时 ${(r.elapsedMs / 1000).toFixed(1)} 秒。`, 'ok');
    $('#resultBadge').hidden = false;
    $('#resultBadge').textContent = (r.events || []).length;
    switchTab('results');
  } catch (e) {
    $('#queryStatus').className = 'status error';
    $('#queryStatus').textContent = e.message;
    toast(e.message, 'error');
  } finally {
    clearInterval(timer);
    $('#searchBtn').disabled = false;
    setTimeout(() => { $('#queryStatus').textContent = ''; }, 0);
  }
}
$('#searchBtn').addEventListener('click', () => runSearch());

// ---------- results rendering ----------
const CAT_LABEL = { accident: '事故', natural: '自然灾害', health: '公共卫生', security: '治安', other: '其他' };

function renderResults(r) {
  $('#resultsEmpty').hidden = true;
  $('#resultsContainer').hidden = false;
  const timeTxt = r.mode === 'offline' ? '离线检索' : '联网检索' + (r.cached ? '（缓存）' : '');
  const secs = r.elapsedMs != null ? (r.elapsedMs / 1000).toFixed(1) + ' 秒' : null;
  $('#resultsTitle').textContent = '擦肩而过 · ' + (r.placeLabel || '');
  $('#resultsMeta').textContent = `${timeTxt} · 共 ${(r.events || []).length} 条事件 · 查询点 ${r.point.lat.toFixed(4)}, ${r.point.lng.toFixed(4)}`
    + (secs ? ` · 用时 ${secs}` : '');
  $('#resultsNotes').textContent = r.notes || '';

  const buckets = { core: [], companion: [], empathy: [] };
  (r.events || []).forEach((e) => {
    const layer = e.layer || 'empathy';
    if (buckets[layer]) buckets[layer].push(e);
  });

  ['core', 'companion', 'empathy'].forEach((layer) => {
    const group = $('#layer' + layer[0].toUpperCase() + layer.slice(1));
    group.querySelector('.count').textContent = buckets[layer].length;
    const body = group.querySelector('.layer-body');
    body.innerHTML = buckets[layer].map((e) => eventCardHtml(e, layer)).join('');
  });

  drawMiniMap(r, buckets);
}

function eventCardHtml(e, layer) {
  const dist = e.distance_km != null
    ? `<div class="num">${e.distance_km < 1 ? Math.round(e.distance_km * 1000) : e.distance_km}</div><div class="unit">${e.distance_km < 1 ? '米' : '公里'}</div>`
    : `<div class="num">—</div><div class="unit">未知距离</div>`;
  const srcs = (e.sources || []).map((s) => `<a href="${escapeHtml(s)}" target="_blank" rel="noopener" title="${escapeHtml(s)}">${escapeHtml(urlDomain(s))}</a>`).join('');
  const cat = CAT_LABEL[e.category] || '其他';
  const coordNote = e.coordinateTrusted === false ? '<span class="tag-pill warn">坐标缺失</span>' : '';
  const offlineNote = e.offline ? '<span class="tag-pill">离线</span>' : '';
  return `
    <div class="event-card ${layer}">
      <div class="ec-dist">${dist}</div>
      <div class="ec-body">
        <div class="ec-name">${escapeHtml(e.name)} ${coordNote} ${offlineNote}</div>
        <div class="ec-row"><b>时间</b> ${escapeHtml(e.time || '未知')}　<b>地点</b> ${escapeHtml(e.place || '未知')}</div>
        <div class="ec-desc">${escapeHtml(e.description || '')}</div>
        <div class="ec-sources"><span class="ec-cat">${cat}</span>${srcs || '<span class="tag-pill warn">无来源</span>'}</div>
      </div>
    </div>`;
}

function urlDomain(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_e) { return u; }
}

function drawMiniMap(r, buckets) {
  const miniEl = document.getElementById('miniMap');
  if (!miniEl) return;

  // Destroy previous instance if any
  if (state.miniMap) {
    state.miniMap.remove();
    state.miniMap = null;
  }

  // Check container is visible — otherwise defer to switchTab's invalidateSize
  const visible = miniEl.offsetParent !== null;
  if (!visible) {
    // The results tab hasn't been shown yet. Switch to results tab first,
    // then draw after a short delay for the panel transition.
    setTimeout(() => drawMiniMap(r, buckets), 400);
    return;
  }

  // Create map with the same tile layer as the main map
  state.miniMap = L.map('miniMap', { zoomControl: false, attributionControl: false, minZoom: 3 }).setView([35, 110], 3);
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    maxZoom: 18, minZoom: 3, subdomains: ['1', '2', '3', '4'], attribution: '© Gaode Maps',
  }).addTo(state.miniMap);

  const pts = [];
  // query point
  if (r.point) {
    L.circleMarker(r.point, { radius: 7, color: '#fff', weight: 2, fillColor: '#4a7cff', fillOpacity: 1 }).addTo(state.miniMap);
    pts.push(r.point);
  }
  ['core', 'companion', 'empathy'].forEach((layer) => {
    (buckets[layer] || []).forEach((e) => {
      if (e.lat == null || e.lng == null) return;
      L.circleMarker([e.lat, e.lng], { radius: 5, color: '#fff', weight: 1, fillColor: LAYER_COLOR[layer], fillOpacity: .9 })
        .bindPopup(`<b>${escapeHtml(e.name)}</b><br>${escapeHtml(e.time || '')}<br>${escapeHtml(e.place || '')}`)
        .addTo(state.miniMap);
      pts.push([e.lat, e.lng]);
    });
  });
  if (pts.length > 1) {
    state.miniMap.fitBounds(L.latLngBounds(pts).pad(0.3));
  } else if (pts.length === 1) {
    state.miniMap.setView(pts[0], 10);
  }
}

// ---------- settings ----------
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    state.cfg = { coreRadiusKm: s.coreRadiusKm, companionRadiusKm: s.companionRadiusKm };
    $('#apiBaseUrlInput').value = s.apiBaseUrl || '';
    $('#modelInput').value = s.model || '';
    $('#maxEventsInput').value = s.maxEvents;
    $('#timeoutInput').value = s.requestTimeoutSec;
    $('#cacheTtlInput').value = s.cacheTtlDays;
    $('#offlineToggle').checked = !!s.useOfflineMode;
    $('#offlinePathInput').value = s.offlineDbPath || '';
    refreshCacheStats();
    // Restore API key from localStorage if available (so it shows after restart)
    const savedKey = localStorage.getItem('nearmiss_apikey');
    if (savedKey && !$('#apiKeyInput').value) $('#apiKeyInput').value = savedKey;
    $('#apiKeyStatus').textContent = '状态：' + (s.hasApiKey ? '✓ 已配置（加密存储）' : '未配置');
    $('#apiKeyStatus').className = s.hasApiKey ? 'hint ok' : 'hint';
  } catch (e) { toast('加载设置失败：' + e.message, 'error'); }
}

$('#toggleKey').addEventListener('click', () => {
  const i = $('#apiKeyInput');
  i.type = i.type === 'password' ? 'text' : 'password';
});

// ---------- result cache ----------
async function refreshCacheStats() {
  const el = $('#cacheStatsInput');
  if (!el) return;
  try {
    const s = await api('/api/cache');
    el.value = '已缓存 ' + s.entries + ' 条查询结果';
  } catch (_e) {
    el.value = '';
  }
}

$('#clearCacheBtn').addEventListener('click', async () => {
  try {
    await api('/api/cache/clear', { method: 'POST' });
    toast('缓存已清除，下次查询将重新联网检索。', 'ok');
  } catch (e) {
    toast('清除缓存失败：' + e.message, 'error');
  }
  refreshCacheStats();
});

$('#saveSettingsBtn').addEventListener('click', async () => {
  const body = {
    apiBaseUrl: $('#apiBaseUrlInput').value.trim(),
    model: $('#modelInput').value.trim(),
    maxEvents: parseInt($('#maxEventsInput').value, 10),
    requestTimeoutSec: parseInt($('#timeoutInput').value, 10),
    cacheTtlDays: parseInt($('#cacheTtlInput').value, 10) || 7,
    useOfflineMode: $('#offlineToggle').checked,
  };
  const key = $('#apiKeyInput').value;
  if (key) body.apiKey = key;
  $('#settingsStatus').className = 'status';
  $('#settingsStatus').textContent = '保存中…';
  try {
    const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    state.cfg = { coreRadiusKm: body.coreRadiusKm, companionRadiusKm: body.companionRadiusKm };
    // Persist API key to localStorage so it shows after restart
    if (key) localStorage.setItem('nearmiss_apikey', key);
    else if (body.clearApiKey) localStorage.removeItem('nearmiss_apikey');
    $('#apiKeyStatus').textContent = '状态：' + (r.hasApiKey ? '✓ 已配置（加密存储）' : '未配置');
    $('#apiKeyStatus').className = r.hasApiKey ? 'hint ok' : 'hint';
    $('#settingsStatus').className = 'status ok';
    $('#settingsStatus').textContent = '已保存。';
    toast('设置已保存。', 'ok');
  } catch (e) {
    $('#settingsStatus').className = 'status error';
    $('#settingsStatus').textContent = e.message;
    toast(e.message, 'error');
  }
});

$('#offlineToggle').addEventListener('change', () => {
  if ($('#offlineToggle').checked && !$('#offlinePathInput').value) {
    toast('已开启离线模式，请导入 EM-DAT CSV 文件。', 'error');
  }
});

$('#resetSettingsBtn').addEventListener('click', async () => {
  if (!confirm('确定要重置所有设置为默认值吗？这将清除已保存的 API 密钥。')) return;
  $('#settingsStatus').className = 'status';
  $('#settingsStatus').textContent = '重置中…';
  try {
    await api('/api/settings/reset', { method: 'POST' });
    // The reset wiped the key server-side; also drop the browser-side copy
    // so loadSettings() doesn't refill the input from localStorage.
    localStorage.removeItem('nearmiss_apikey');
    $('#apiKeyInput').value = '';
    await loadSettings();
    $('#settingsStatus').className = 'status ok';
    $('#settingsStatus').textContent = '已重置为默认设置。';
    toast('设置已重置。', 'ok');
  } catch (e) {
    $('#settingsStatus').className = 'status error';
    $('#settingsStatus').textContent = e.message;
    toast(e.message, 'error');
  }
});

$('#importDbBtn').addEventListener('click', () => $('#dbFileInput').click());
$('#dbFileInput').addEventListener('change', async () => {
  if (!$('#dbFileInput').files.length) return;
  const fd = new FormData();
  fd.append('db', $('#dbFileInput').files[0]);
  try {
    const r = await api('/api/offline/import', { method: 'POST', body: fd });
    $('#offlinePathInput').value = r.path;
    toast(`导入成功：${r.rows} 条记录。`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
  finally { $('#dbFileInput').value = ''; }
});

$('#testDbBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/offline/test', { method: 'POST' });
    if (r.ok) toast(`数据库可用：${r.rows} 行，列：${(r.headers || []).slice(0, 6).join(', ')}…`, 'ok');
    else toast(r.error || '数据库不可用', 'error');
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- verify API key ----------
$('#verifyApiBtn').addEventListener('click', async () => {
  const key = $('#apiKeyInput').value.trim();
  const baseUrl = $('#apiBaseUrlInput').value.trim();
  const model = $('#modelInput').value.trim();
  // Allow verification even without typing a new key (uses saved key on server)
  const payload = { apiBaseUrl: baseUrl, model };
  if (key) payload.apiKey = key;
  else {
    // Check if there's a saved key to verify
    const hasKey = $('#apiKeyStatus').textContent.includes('已配置');
    if (!hasKey) {
      $('#verifyApiResult').className = 'status error';
      $('#verifyApiResult').textContent = '请先输入 API 密钥。';
      return;
    }
  }
  const btn = $('#verifyApiBtn');
  btn.disabled = true; btn.textContent = '验证中…';
  $('#verifyApiResult').className = 'status';
  $('#verifyApiResult').textContent = '正在连接 API…';
  try {
    const r = await api('/api/settings/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      $('#verifyApiResult').className = 'status ok';
      $('#verifyApiResult').textContent = '✓ ' + (r.message || '连接成功') + (r.model ? '（' + r.model + '）' : '');
      toast('API 验证通过！', 'ok');
    } else {
      $('#verifyApiResult').className = 'status error';
      $('#verifyApiResult').textContent = '✗ ' + (r.error || '验证失败');
    }
  } catch (e) {
    $('#verifyApiResult').className = 'status error';
    $('#verifyApiResult').textContent = '✗ ' + (e.message || '无法连接，请检查网络与设置。');
  } finally {
    btn.disabled = false; btn.textContent = '✓ 验证';
  }
});

// ---------- bootstrap ----------
initMainMap();
loadSettings();

})();
