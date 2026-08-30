#!/usr/bin/env node
// src/server.js
// Near Miss (擦肩而过) — local desktop app entry point.
// Starts a localhost-only Express server and opens the GUI in the default
// browser. All personal data stays on this machine.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');

// `open` is an ESM-only package in v10+. On Node < 22, require() of an ES
// module throws — fall back to the native OS opener so a missing browser
// opener can never crash the server.
let openBrowser;
try {
  const openPkg = require('open');
  openBrowser = typeof openPkg === 'function'
    ? openPkg
    : (openPkg && (openPkg.default || openPkg.open));
} catch (_e) {
  openBrowser = function (url) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    return new Promise((resolve) => exec(cmd, () => resolve()));
  };
}

const {
  loadSettings, saveSettings, getApiKey, setApiKey, defaultSettings,
} = require('./lib/crypto-store');
const {
  geocode, reverseGeocode, buildSpatialScope, classifyLayer, LAYER_META,
} = require('./lib/geo');
const { systemMessage, userMessage } = require('./lib/prompt-builder');
const { searchEvents, normalizeEvent } = require('./lib/llm-search');
const offline = require('./lib/offline-emdat');
const regions = require('./lib/china-regions');
const { createResultCache, DEFAULT_TTL_DAYS } = require('./lib/result-cache');

// ---- paths ----
const INSTALL_PATH = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.homedir(), '.near-miss');
const CONFIG_PATH = path.join(DATA_DIR, 'settings.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let settings = loadSettings(CONFIG_PATH);
// persisted layer cache for offline db
let offlineDb = null;
// persistent online-search result cache (determinism + instant repeat queries)
const resultCache = createResultCache(path.join(DATA_DIR, 'search-cache.json'));
resultCache.prune(settings.cacheTtlDays);

// ---- app ----
const app = express();

// Disable static file caching so the browser always loads the latest JS/CSS.
// Without this, users get "Failed to fetch" after code updates because
// the browser serves a stale cached app.js with missing functions.
app.use('/css', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/js', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(INSTALL_PATH, 'src', 'public')));

// photo uploads are gone (photo matching removed); keep only the CSV importer.
const uploadDb = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, /csv/i.test(file.mimetype) || /\.csv$/i.test(file.originalname));
  },
});

// ---------- settings ----------
app.get('/api/settings', (_req, res) => {
  // never echo the secret back; just whether it is set
  res.json({
    schemaVersion: settings.schemaVersion,
    apiBaseUrl: settings.apiBaseUrl,
    model: settings.model,
    coreRadiusKm: settings.coreRadiusKm,
    companionRadiusKm: settings.companionRadiusKm,
    maxEvents: settings.maxEvents,
    requestTimeoutSec: settings.requestTimeoutSec,
    useOfflineMode: settings.useOfflineMode,
    offlineDbPath: settings.offlineDbPath,
    cacheTtlDays: settings.cacheTtlDays,
    hasApiKey: !!getApiKey(settings, INSTALL_PATH),
  });
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const allowed = ['apiBaseUrl', 'model', 'coreRadiusKm', 'companionRadiusKm', 'maxEvents', 'requestTimeoutSec', 'useOfflineMode', 'offlineDbPath', 'cacheTtlDays'];
  for (const k of allowed) {
    if (b[k] !== undefined) settings[k] = b[k];
  }
  // API key handled separately (encrypted) — only update if provided & non-empty
  if (typeof b.apiKey === 'string' && b.apiKey !== '') {
    setApiKey(settings, INSTALL_PATH, b.apiKey);
  } else if (b.clearApiKey === true) {
    setApiKey(settings, INSTALL_PATH, '');
  }
  try {
    saveSettings(CONFIG_PATH, settings);
  } catch (e) {
    return res.status(500).json({ error: '保存设置失败：' + e.message });
  }
  // reload offline db if path changed
  offlineDb = null;
  res.json({ ok: true, hasApiKey: !!getApiKey(settings, INSTALL_PATH) });
});

// ---------- reset settings ----------
app.post('/api/settings/reset', (req, res) => {
  settings = defaultSettings();
  try {
    // Wipe the settings file entirely (next loadSettings picks up fresh defaults)
    const fresh = defaultSettings();
    saveSettings(CONFIG_PATH, fresh);
  } catch (e) {
    return res.status(500).json({ error: '重置设置失败：' + e.message });
  }
  offlineDb = null;
  res.json({ ok: true });
});

// ---------- verify API key ----------
app.post('/api/settings/verify', async (req, res) => {
  const b = req.body || {};
  // Use provided key + endpoint or fall back to currently saved ones
  const apiKey = (typeof b.apiKey === 'string' && b.apiKey) ? b.apiKey : getApiKey(settings, INSTALL_PATH);
  const baseUrl = (typeof b.apiBaseUrl === 'string' && b.apiBaseUrl.trim()) ? b.apiBaseUrl.trim() : settings.apiBaseUrl;
  const model = (typeof b.model === 'string' && b.model.trim()) ? b.model.trim() : settings.model;

  if (!apiKey) {
    return res.json({ ok: false, error: '未提供 API 密钥，请在输入框中填写后再验证。' });
  }

  // Normalize — same logic as in llm-search
  let base = baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(base)) {
    base = base.replace(/\/+$/, '') + '/chat/completions';
  }

  const https = require('https');
  const http = require('http');
  const { URL } = require('url');

  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: '请回复"OK"作为连通性测试。' }],
    max_tokens: 10,
    temperature: 0.1,
    stream: false,
  });

  let u;
  try { u = new URL(base); } catch (e) { return res.json({ ok: false, error: 'API Base URL 格式无效。' }); }

  const lib = u.protocol === 'https:' ? https : http;
  const body = Buffer.from(payload, 'utf8');
  const httpReq = lib.request({
    method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Authorization': 'Bearer ' + apiKey,
    },
    timeout: 15000,
  }, (resp) => {
    let data = '';
    resp.setEncoding('utf8');
    resp.on('data', (c) => data += c);
    resp.on('end', () => {
      // Check HTTP status
      if (resp.statusCode === 401 || resp.statusCode === 403) {
        return res.json({ ok: false, error: '鉴权失败（HTTP ' + resp.statusCode + '）。请检查 API 密钥是否正确。' });
      }
      if (resp.statusCode === 429) {
        return res.json({ ok: false, error: '请求被限流（429），请稍后重试或检查账户额度。' });
      }
      if (resp.statusCode === 404) {
        return res.json({ ok: false, error: '端点不存在（404）。请确认 API Base URL 是否正确（例如 https://api.deepseek.com/v1）。' });
      }
      // Try to parse
      let json;
      try { json = JSON.parse(data); } catch (e) {
        return res.json({ ok: false, error: 'API 返回了无法解析的响应（HTTP ' + resp.statusCode + '）。请检查 Base URL 与模型名。' });
      }
      // Check for API-level error
      if (json.error) {
        const msg = json.error.message || JSON.stringify(json.error);
        return res.json({ ok: false, error: 'API 返回错误：' + msg });
      }
      // Success
      const modelUsed = json.model || json.object || model;
      res.json({ ok: true, message: '连接成功！模型响应正常。', model: modelUsed });
    });
  });
  httpReq.on('error', (e) => {
    if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') {
      return res.json({ ok: false, error: '无法连接到 API 服务器（' + e.code + '）。请检查 Base URL 与网络连接。' });
    }
    if (e.code === 'ETIMEDOUT' || e.message.includes('timeout')) {
      return res.json({ ok: false, error: '连接超时（15s）。请检查网络或 API 服务器状态。' });
    }
    res.json({ ok: false, error: '连接失败：' + e.message });
  });
  httpReq.write(body);
  httpReq.end();
});

// ---------- geocoding ----------
app.get('/api/geocode', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: '请输入地名。' });
    const hit = await geocode(q);
    const scope = await buildScopeFromPoint(hit.lat, hit.lng, q);
    res.json({ point: { lat: hit.lat, lng: hit.lng }, displayName: hit.displayName, scope });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/reverse', async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: '坐标无效。' });
  const scope = await buildScopeFromPoint(lat, lng, null);
  res.json({ lat, lng, scope });
});

async function buildScopeFromPoint(lat, lng, label) {
  const rev = await reverseGeocode(lat, lng).catch(() => null);
  const placeLabel = label || (rev && rev.displayName) || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const scope = buildSpatialScope(rev && rev.address);
  scope.displayName = rev && rev.displayName;
  scope.placeLabel = placeLabel;
  // When reverse geocoding only reaches province level, the searched place
  // name (label) is the best city hint we have — use it to fill parts.city
  // and to keep the query city out of its own neighbor list.
  if (label && scope.parts && !scope.parts.city) {
    const hint = regions.stripSuffix(label);
    if (hint && regions.citiesOfProvince(scope.parts.state || '').includes(hint)) {
      scope.parts.city = hint + '市';
    }
  }
  attachRegionKeywords(scope, label);
  return scope;
}

/**
 * Resolve explicit neighboring-region keywords from the bundled China region
 * data, so the LLM gets real names (adjacent prefecture cities, adjacent
 * provinces) instead of having to guess them.
 */
function attachRegionKeywords(scope, label) {
  if (!scope) return scope;
  const parts = scope.parts && typeof scope.parts === 'object' ? scope.parts : {};
  const province = parts.state || parts.province || '';
  const city = parts.city || '';
  const hint = regions.stripSuffix(label || '');
  scope.neighborCities = regions.neighborCitiesFor(province, city).filter((x) => x !== hint);
  scope.neighborProvinces = regions.neighborProvincesFor(province);
  if (scope.neighborCities.length) {
    scope.companion = [...new Set([...(scope.companion || []), scope.neighborCities.join('、')])];
  }
  if (scope.neighborProvinces.length) {
    scope.empathy = [...new Set([...(scope.empathy || []), '相邻省份：' + scope.neighborProvinces.join('、')])];
  }
  return scope;
}

/**
 * Administrative (not distance-based) layer classification per the current
 * layer definitions: core = within coreRadiusKm; companion = event's
 * prefecture city is the query city or one of its neighbors (guarded by a
 * sane distance band for far-flung matches); empathy = anywhere in the same
 * province or a neighboring province. Falls back to pure distance when the
 * event's city is unknown.
 */
function applyAdminLayer(norm, scope, cfg) {
  const parts = (scope && scope.parts) || {};
  const queryCity = regions.stripSuffix(parts.city || '');
  const province = regions.stripSuffix(parts.state || parts.province || '');
  // Prefer the model-provided city; otherwise infer it by matching a known
  // city name against the event's place/name text.
  let cityName = regions.stripSuffix(norm.city || '');
  if (!cityName) {
    const hay = `${norm.place || ''} ${norm.name || ''}`;
    const pool = [
      ...(scope.neighborCities || []),
      regions.citiesOfProvince(province),
      ...(scope.neighborProvinces || []).flatMap((p) => regions.citiesOfProvince(p)),
    ].flat();
    cityName = pool.find((c) => c && hay.includes(c)) || '';
  }

  let layer = null;
  if (norm.distance_km != null && norm.distance_km <= cfg.coreRadiusKm) {
    layer = 'core';
  } else if (cityName) {
    const sameCity = queryCity && cityName === queryCity;
    const isNeighbor = (scope.neighborCities || []).includes(cityName);
    // 200km band approximates true adjacency (the dataset is province-wide).
    if (sameCity || (isNeighbor && (norm.distance_km == null || norm.distance_km <= 200))) {
      layer = 'companion';
    } else if (
      regions.citiesOfProvince(province).includes(cityName) ||
      (scope.neighborProvinces || []).some((p) => regions.citiesOfProvince(p).includes(cityName))
    ) {
      layer = 'empathy';
    }
  }
  if (!layer) layer = classifyLayer(norm.distance_km == null ? Infinity : norm.distance_km, cfg);

  norm.layer = layer;
  norm.layerLabel = LAYER_META[layer].label;
  norm.layerTagline = LAYER_META[layer].tagline;
  norm.layerColor = LAYER_META[layer].color;
  return norm;
}

// ---------- core search ----------
app.post('/api/search', async (req, res) => {
  try {
    const b = req.body || {};
    const point = b.point;
    if (!point || !isFinite(point.lat) || !isFinite(point.lng)) {
      return res.status(400).json({ error: '缺少有效的查询坐标。' });
    }
    const time = b.time;
    // range-only queries (single-date mode and photo matching were removed)
    if (!time || time.mode !== 'range' || !time.from || !time.to) {
      return res.status(400).json({ error: '请设定查询时间段（开始与结束日期）。' });
    }
    // make sure scope is present (client may pass it; otherwise derive)
    let scope = b.scope;
    if (!scope || !scope.core) {
      scope = await buildScopeFromPoint(point.lat, point.lng, b.placeLabel);
    }
    const placeLabel = b.placeLabel || scope.placeLabel || '';

    const cfg = {
      coreRadiusKm: Number(settings.coreRadiusKm) || 1,
      companionRadiusKm: Number(settings.companionRadiusKm) || 50,
    };

    if (settings.useOfflineMode) {
      if (!offlineDb && settings.offlineDbPath) {
        offlineDb = offline.loadDb(settings.offlineDbPath);
      }
      if (!offlineDb) {
        return res.status(400).json({ error: '离线模式已开启，但未加载离线数据库。请在设置中导入 EM-DAT CSV 文件。' });
      }
      const result = offline.search(offlineDb, { point, placeLabel, scope, time, cfg });
      result.point = point;
      result.placeLabel = placeLabel;
      result.scope = scope;
      result.mode = 'offline';
      return res.json(result);
    }

    // online mode — split into three parallel single-layer requests so each
    // call generates only ~1/3 of the output; wall time ≈ slowest layer.
    const apiKey = getApiKey(settings, INSTALL_PATH);
    const timeoutMs = (Number(settings.requestTimeoutSec) || 90) * 1000;
    const max = Number(settings.maxEvents) || 20;
    const layerNames = ['core', 'companion', 'empathy'];
    // per-layer output caps (方法二): fewer output tokens = faster generation
    const layerCaps = {
      core: Math.min(5, max),
      companion: Math.min(10, max),
      empathy: Math.min(10, max),
    };

    // Deterministic replay: identical queries hit the local cache instead of
    // re-running the slow, non-deterministic web search.
    const cacheKey = resultCache.makeKey({
      point, placeLabel, scope, time, cfg,
      model: settings.model,
      maxEvents: settings.maxEvents,
    });
    const cached = resultCache.get(cacheKey, settings.cacheTtlDays);
    if (cached) {
      const result = Object.assign({}, cached, { mode: 'online', cached: true });
      return res.json(result);
    }

    // Per-layer deadline follows the configured request timeout (default 90s):
    // the neighbor-keyword lists make reasoning models slower, and cutting at
    // 45s was discarding finished answers. A timed-out or EMPTY layer is
    // retried once; partial results are NOT cached.
    const layerTimeoutMs = timeoutMs;

    const settled = await Promise.allSettled(layerNames.map(async (layer) => {
      const attempt = async (n) => {
        const t0 = Date.now();
        try {
          const r = await searchEvents({
            apiKey,
            apiBaseUrl: settings.apiBaseUrl,
            model: settings.model,
            system: systemMessage(layer),
            user: userMessage({ point, placeLabel, scope, time, cfg, cap: layerCaps[layer], layer }),
            timeoutMs: layerTimeoutMs,
          });
          const count = (r.parsed.events || []).length;
          console.log(`[search] ${layer} #${n}: ${((Date.now() - t0) / 1000).toFixed(1)}s, events=${count}`);
          return r;
        } catch (e) {
          console.log(`[search] ${layer} #${n}: FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e.message}`);
          throw e;
        }
      };

      // First pass; retry once when it timed out/failed OR came back empty,
      // so "nothing found" is always confirmed by a second search.
      let first = null, firstErr = null;
      try {
        first = await attempt(1);
      } catch (e) {
        firstErr = e;
      }
      const firstEmpty = first && (first.parsed.events || []).length === 0;
      if (first && !firstEmpty) return first;
      try {
        const second = await attempt(2);
        // Two empty passes = a confirmed miss; keep the richer notes.
        if (second && (second.parsed.events || []).length === 0 && firstEmpty && second.parsed.notes) {
          second.parsed.notes = `${second.parsed.notes}（已二次检索确认）`;
        }
        return second;
      } catch (e2) {
        if (first) return first; // had an empty-but-valid first pass
        throw firstErr || e2;
      }
    }));

    // If every layer failed, rethrow the first error so the user sees it.
    const failures = settled.filter((r) => r.status === 'rejected');
    if (failures.length === settled.length) throw failures[0].reason;

    // Merge fulfilled layers; note the failed ones instead of failing all.
    const events = [];
    const notesArr = [];
    settled.forEach((r, i) => {
      const zh = { core: '擦肩而过', companion: '一衣带水', empathy: '一箭之遥' }[layerNames[i]];
      if (r.status === 'rejected') {
        notesArr.push(`【${zh}】圈层检索超时或失败，未纳入本次结果，可重试`);
        return;
      }
      const parsed = r.value.parsed;
      const arr = Array.isArray(parsed.events) ? parsed.events : [];
      for (const ev of arr) {
        const norm = normalizeEvent({ ...ev, __layer: layerNames[i] }, point, cfg);
        if (!norm) continue;
        applyAdminLayer(norm, scope, cfg);
        events.push(norm);
      }
      // Prefix each layer's note so the combined notes read unambiguously
      // (a "未找到" from one layer is not a global miss).
      if (parsed.notes) notesArr.push(`【${zh}】${parsed.notes}`);
    });

    // dedupe: same date + same city (or near-identical name) = same event.
    // Media names vary ("商贸城特别重大" vs "商贸公司重大"), so name alone
    // is not a reliable key.
    const seen = new Set();
    const dedup = events.filter((e) => {
      const k = `${e.time}|${e.city || (e.name || '').replace(/\s/g, '').slice(0, 8)}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });

    const result = {
      events: dedup.slice(0, max),
      notes: notesArr.join('；'),
      raw: settled.filter((r) => r.status === 'fulfilled').map((r) => r.value.raw).join('\n\n----\n\n'),
      point,
      placeLabel,
      scope,
      mode: 'online',
      partial: failures.length > 0,
    };
    // Cache only complete results — a partial one (some layer timed out) would
    // freeze the gap until the TTL expires.
    if (!result.partial) resultCache.set(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- result cache ----------
app.get('/api/cache', (_req, res) => {
  res.json(resultCache.stats());
});

app.post('/api/cache/clear', (_req, res) => {
  resultCache.clear();
  res.json({ ok: true });
});

// ---------- offline db import ----------
app.post('/api/offline/import', uploadDb.single('db'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件。' });
    // move into data dir with a stable name
    const dest = path.join(DATA_DIR, 'emdat-' + crypto.randomBytes(4).toString('hex') + '.csv');
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    // validate it loads
    const db = offline.loadDb(dest);
    const count = db.rows.length;
    settings.offlineDbPath = dest;
    offlineDb = db;
    saveSettings(CONFIG_PATH, settings);
    res.json({ ok: true, path: dest, rows: count });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.post('/api/offline/test', (_req, res) => {
  try {
    if (!settings.offlineDbPath) return res.json({ ok: false, error: '未配置离线数据库路径。' });
    const db = offline.loadDb(settings.offlineDbPath);
    res.json({ ok: true, rows: db.rows.length, headers: db.header });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- launch ----------
const PORT = Number(process.env.PORT) || 17631;
const HOST = '127.0.0.1'; // localhost only

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  // Banner: lead with ASCII so it's readable under any console code page,
  // then add the Chinese line (shows correctly once chcp 65001 is active,
  // e.g. via start.bat; harmless mojibake otherwise).
  console.log('');
  console.log('  Near Miss is running.');
  console.log('  ----------------------------------');
  console.log('  URL      : ' + url);
  console.log('  Data dir : ' + DATA_DIR);
  console.log('  Privacy  : all data stays on this machine, nothing is uploaded.');
  console.log('  Exit     : press Ctrl+C.');
  console.log('');
  console.log('  Near Miss（擦肩而过）已启动 —— 浏览器应已自动打开，若未打开请手动访问上方 URL。');
  console.log('');

  // Quick self-check: verify the server is actually responding
  const http = require('http');
  http.get(url + 'api/settings', (res) => {
    if (res.statusCode === 200) {
      console.log('  [OK] Health check passed — API is responding.');
    }
  }).on('error', () => {});

  // open browser shortly after (allow a tick for the listener)
  if (!process.env.NO_OPEN) {
    setTimeout(() => {
      Promise.resolve(openBrowser(url)).catch(() => {});
    }, 300);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。请关闭占用程序，或用 PORT=xxxx npm start 指定其他端口。');
  } else {
    console.error('启动失败：', e.message);
  }
  process.exit(1);
});
