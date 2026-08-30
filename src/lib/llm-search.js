// src/lib/llm-search.js
// Calls an OpenAI-compatible chat/completions endpoint that supports web
// search, parses the constrained JSON response, validates it, recomputes
// distances from real coordinates (never trusting the model's distance guesses
// when we have coordinates), and assigns the final circle layer.
//
// Privacy: only the anonymized prompt (place + time) is sent — no photos,
// no user identity. See prompt-builder.js.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { classifyLayer, LAYER_META } = require('./geo');

/**
 * Low-level POST with JSON body to an OpenAI-compatible endpoint.
 */
function postJson(urlStr, body, { headers = {}, timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效的 API Base URL：' + urlStr)); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const reqHeaders = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
    }, headers);

    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）。模型可能仍在联网检索，请重试或加大超时。')));
    req.write(payload);
    req.end();
  });
}

/**
 * Extract a JSON object from a model response that *should* be pure JSON but
 * sometimes comes wrapped in ```json fences or with stray prose. We try, in
 * order: direct parse, then first balanced {...} block.
 */
function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip markdown code fences if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try { return JSON.parse(candidate); } catch (_e) { /* fall through */ }
  // Find the first balanced top-level object.
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
    } else {
      if (ch === '"') { inStr = true; }
      else if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { return JSON.parse(candidate.slice(start, i + 1)); } catch (_e) { return null; } } }
    }
  }
  return null;
}

/**
 * Validate and normalize one event object from the model. Drops events that
 * fail the reliability bar (no name, or no source).
 */
function normalizeEvent(ev, queryPoint, cfg) {
  if (!ev || typeof ev !== 'object') return null;
  const name = (ev.name || '').toString().trim();
  const sourcesRaw = Array.isArray(ev.sources) ? ev.sources : (ev.sources ? [ev.sources] : []);
  const sources = sourcesRaw.map((s) => (s || '').toString().trim()).filter((s) => /^https?:\/\//i.test(s));
  if (!name) return null;
  if (sources.length === 0) return null; // reliability-first: must have a verifiable URL

  const lat = typeof ev.lat === 'number' ? ev.lat : parseFloat(ev.lat);
  const lng = typeof ev.lng === 'number' ? ev.lng : parseFloat(ev.lng);
  const hasCoord = !isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng);

  // Recompute distance ourselves when we have coordinates — do not trust the
  // model's guess. This keeps the circle classification honest.
  let distanceKm = null;
  let layer = null;
  if (hasCoord) {
    const a = queryPoint.lat, b = queryPoint.lng;
    const dLat = (lat - a) * Math.PI / 180;
    const dLng = (lng - b) * Math.PI / 180;
    const la1 = a * Math.PI / 180, la2 = lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    distanceKm = Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
    layer = classifyLayer(distanceKm, cfg);
  } else {
    // No coordinate: trust the model's declared bucket by field placement.
    layer = ev.__layer || null;
  }

  return {
    name,
    time: (ev.time || '').toString().trim(),
    place: (ev.place || '').toString().trim(),
    city: (ev.city || '').toString().trim(),
    lat: hasCoord ? lat : null,
    lng: hasCoord ? lng : null,
    distance_km: distanceKm,
    layer,
    layerLabel: layer ? LAYER_META[layer].label : null,
    layerTagline: layer ? LAYER_META[layer].tagline : null,
    layerColor: layer ? LAYER_META[layer].color : null,
    description: (ev.description || '').toString().trim(),
    sources,
    category: (ev.category || 'other').toString().trim(),
    coordinateTrusted: hasCoord,
  };
}

/**
 * Run the search. Returns { events, notes, raw }.
 * Throws on network / auth / parse errors with a human-readable message.
 */
async function searchEvents({ apiKey, apiBaseUrl, model, system, user, timeoutMs }) {
  if (!apiKey) throw new Error('未配置 API 密钥。请在「设置」面板填写支持联网搜索的大模型 API 密钥。');
  if (!apiBaseUrl) throw new Error('未配置 API Base URL。');

  // Normalize base URL + endpoint. Accept either the base or a full path.
  let base = apiBaseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(base)) {
    base = base.replace(/\/+$/, '') + '/chat/completions';
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0, // fully deterministic sampling; combined with the local result cache
    seed: 42,       // fixed seed — providers that support it (OpenAI, DeepSeek…) get reproducible output
    stream: false,
  };

  // Only attach web-search tooling for OpenAI (detected by host).
  // DeepSeek etc. do not support `web_search_preview` — this is fine;
  // they answer from training knowledge, which is sufficient for the task.
  const host = (apiBaseUrl.replace(/\/+$/, '').split('/')[2] || '').toLowerCase();
  if (host.includes('openai.com')) {
    body.web_search_options = {};
    body.tools = [{ type: 'web_search_preview' }];
    body.tool_choice = 'auto';
  }

  const res = await postJson(base, body, {
    headers: { Authorization: 'Bearer ' + apiKey },
    timeoutMs,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error('API 鉴权失败（' + res.status + '）。请检查密钥与 Base URL 是否正确。');
  }
  if (res.status === 429) {
    throw new Error('请求被限流（429）。请稍后重试，或检查账户额度。');
  }
  if (res.status >= 500) {
    throw new Error('API 服务端错误（' + res.status + '）：' + truncate(res.body, 300));
  }
  if (res.status !== 200) {
    throw new Error('API 返回非预期状态码 ' + res.status + '：' + truncate(res.body, 300));
  }

  let json;
  try { json = JSON.parse(res.body); } catch (e) { throw new Error('无法解析 API 响应为 JSON：' + truncate(res.body, 300)); }

  const content = extractContent(json);
  if (!content) throw new Error('API 响应中未包含文本内容。原始响应：' + truncate(res.body, 400));

  const parsed = extractJsonObject(content);
  if (!parsed) {
    // Model didn't return valid JSON. Surface a clear error with the raw text.
    throw new Error('模型未返回可解析的 JSON。请确认所选模型支持联网搜索，并重试。原始内容片段：' + truncate(content, 300));
  }

  return { parsed, raw: content };
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Pull the assistant text out of an OpenAI-style completion response.
 * Handles plain content, tool/web-search wrapped responses, and — critically —
 * reasoning models (e.g. deepseek-v4-flash) that put the final answer in
 * `reasoning_content` while `content` comes back EMPTY.
 */
function extractContent(json) {
  if (!json) return null;
  if (json.choices && Array.isArray(json.choices)) {
    for (const c of json.choices) {
      if (!c || !c.message) continue;
      if (typeof c.message.content === 'string' && c.message.content.trim()) return c.message.content;
      // Some providers nest final text under a tool/web_search message.
      if (Array.isArray(c.message.content)) {
        for (const part of c.message.content) {
          if (part && typeof part.text === 'string' && part.text.trim()) return part.text;
          if (part && typeof part === 'string' && part.trim()) return part;
        }
      }
      // Reasoning models: final JSON often lands in reasoning_content.
      if (typeof c.message.reasoning_content === 'string' && c.message.reasoning_content.trim()) {
        return c.message.reasoning_content;
      }
      if (typeof c.message.reasoning === 'string' && c.message.reasoning.trim()) {
        return c.message.reasoning;
      }
    }
  }
  return null;
}

module.exports = { searchEvents, normalizeEvent, extractJsonObject };
