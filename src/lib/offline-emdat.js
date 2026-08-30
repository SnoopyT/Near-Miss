// src/lib/offline-emdat.js
// Optional offline mode: search a local EM-DAT-style CSV archive for disaster
// events near the query point and time. No API, no network.
//
// EM-DAT (https://www.emdat.be) is the authoritative global disaster database.
// Users download the export CSV themselves (the spec says we should NOT bundle
// a static DB) and point the app at it via Settings. We then filter locally.
//
// EM-DAT CSV columns vary by export version, but commonly include:
//   Year, Start Month, Start Day, Event Name, Disaster Type, Country, Location names,
//   Latitude, Longitude, Total Deaths, Total Affected, ...
// We tolerant-parse: we look for coordinate columns by header name and for
// dates by year/month/day columns.
//
// If the user's CSV doesn't have coordinates, we fall back to text matching on
// the place name and cannot compute exact distance (distance_km = null).

const fs = require('fs');
const { classifyLayer, LAYER_META } = require('./geo');

// ---- minimal CSV parser (handles quoted fields, commas, newlines) ----
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// header matching helpers
const HEADER_ALIASES = {
  year: ['year', 'start year', 'anno'],
  month: ['start month', 'month'],
  day: ['start day', 'day'],
  name: ['event name', 'disaster name', 'name', 'event'],
  type: ['disaster type', 'disaster subtype', 'type', 'event type'],
  country: ['country', 'iso', 'country name'],
  location: ['location', 'location names', 'admin1', 'admin2', 'geolocation', 'affected area'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'long', 'lng', 'lon'],
  deaths: ['total deaths', 'deaths', 'fatalities'],
  affected: ['total affected', 'affected'],
};

function buildHeaderIndex(header) {
  const idx = {};
  const lower = header.map((h) => (h || '').toString().trim().toLowerCase());
  for (const key in HEADER_ALIASES) {
    for (let i = 0; i < lower.length; i++) {
      if (HEADER_ALIASES[key].includes(lower[i])) { idx[key] = i; break; }
    }
  }
  return idx;
}

function col(row, i) { return i == null ? '' : (row[i] != null ? row[i].toString().trim() : ''); }

function safeNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

/**
 * Load and index the CSV. Throws with a friendly message if unreadable.
 * Returns { rows, header } or null if no file configured.
 */
function loadDb(csvPath) {
  if (!csvPath) return null;
  let text;
  try {
    text = fs.readFileSync(csvPath, 'utf8');
  } catch (e) {
    throw new Error('无法读取离线数据库文件：' + csvPath + '（' + e.message + '）');
  }
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('离线数据库为空或格式不正确。');
  const header = rows.shift();
  const idx = buildHeaderIndex(header);
  return { rows, header, idx };
}

/**
 * Search the loaded DB. Returns normalized events (same shape as online mode),
 * already assigned a layer.
 */
function search(db, { point, placeLabel, scope, time, cfg }) {
  if (!db) return { events: [], notes: '未加载离线数据库。' };
  const { rows, idx } = db;

  // time window
  let yFrom = null, yTo = null;
  if (time.mode === 'single') {
    const y = parseInt((time.single || '').slice(0, 4), 10);
    if (isFinite(y)) { yFrom = y; yTo = y; }
  } else {
    yFrom = parseInt((time.from || '').slice(0, 4), 10);
    yTo = parseInt((time.to || '').slice(0, 4), 10);
    if (!isFinite(yFrom)) yFrom = null;
    if (!isFinite(yTo)) yTo = null;
  }

  const events = [];
  const placeLc = (placeLabel || '').toLowerCase();
  const scopeParts = (scope && scope.raw ? scope.raw.toLowerCase() : '');

  for (const row of rows) {
    const year = safeNum(col(row, idx.year));
    if (year == null) continue;
    if (yFrom != null && yTo != null && !(year >= yFrom && year <= yTo)) continue;

    const lat = safeNum(col(row, idx.lat));
    const lng = safeNum(col(row, idx.lng));
    const hasCoord = lat != null && lng != null && isFinite(lat) && isFinite(lng);

    let distanceKm = null, layer = null;
    if (hasCoord && point) {
      const dLat = (lat - point.lat) * Math.PI / 180;
      const dLng = (lng - point.lng) * Math.PI / 180;
      const la1 = point.lat * Math.PI / 180, la2 = lat * Math.PI / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
      distanceKm = Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
      // For offline we only keep things within the empathy-ish scope to avoid
      // dumping the entire global DB: cap at ~ the companion radius * 10, but
      // at minimum include province-level (empathy) by text fallback below.
      layer = classifyLayer(distanceKm, cfg);
      if (distanceKm > Math.max(cfg.companionRadiusKm * 10, 500)) continue;
    } else {
      // text fallback: must mention the place/scope
      const loc = (col(row, idx.location) + ' ' + col(row, idx.country) + ' ' + col(row, idx.name)).toLowerCase();
      if (!loc) continue;
      const hit = [placeLc, scopeParts].filter(Boolean).some((p) => p && loc.includes(p.split(/\s+/)[0]));
      if (!hit) continue;
      layer = 'empathy'; // can't pin distance; treat as empathy
    }

    const name = col(row, idx.name) || (col(row, idx.type) + ' ' + year);
    const month = col(row, idx.month).padStart(2, '0').replace(/\D/g, '') || '01';
    const day = col(row, idx.day).padStart(2, '0').replace(/\D/g, '') || '01';
    const timeStr = `${year}-${month || '01'}-${day || '01'}`;
    const deaths = safeNum(col(row, idx.deaths));
    const affected = safeNum(col(row, idx.affected));
    let desc = col(row, idx.type) || '灾害';
    if (deaths != null) desc += `；死亡约 ${Math.round(deaths)}`;
    if (affected != null) desc += `；影响约 ${Math.round(affected)}`;

    events.push({
      name,
      time: timeStr,
      place: col(row, idx.location) || col(row, idx.country),
      lat: hasCoord ? lat : null,
      lng: hasCoord ? lng : null,
      distance_km: distanceKm,
      layer,
      layerLabel: LAYER_META[layer].label,
      layerTagline: LAYER_META[layer].tagline,
      layerColor: LAYER_META[layer].color,
      description: desc,
      sources: ['https://www.emdat.be/ (EM-DAT 本地存档)'],
      category: 'natural',
      coordinateTrusted: hasCoord,
      offline: true,
    });
  }

  // sort by distance (nulls last), cap
  events.sort((a, b) => (a.distance_km == null ? 1 : b.distance_km == null ? -1 : a.distance_km - b.distance_km));
  return { events, notes: `离线检索完成，共匹配 ${events.length} 条记录（来源：本地 EM-DAT 存档）。` };
}

module.exports = { loadDb, search, parseCsv };
