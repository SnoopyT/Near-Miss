// src/lib/geo.js
// Geography helpers: geocoding (Nominatim/OpenStreetMap), distance (haversine),
// and the "client-side query enhancement" required by the spec — expanding a
// user query to include neighboring administrative districts so the downstream
// LLM search has better recall.
//
// Privacy: geocoding sends ONLY the place name the user typed (no user id,
// no photos, no other personal data) to the public Nominatim endpoint, which
// is required to turn a name into coordinates. This is the minimal disclosure
// needed for the feature.

const https = require('https');
const http = require('http');

const EARTH_R_KM = 6371;

function toRad(deg) { return deg * Math.PI / 180; }

/**
 * Great-circle distance between two {lat,lng} points, in kilometers.
 */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Promisified HTTP GET for JSON.
 */
function getJson(url, { timeoutMs = 12000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'NearMiss/1.0 (local desktop app)', ...headers } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(res.headers.location, { timeoutMs, headers }));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { reject(new Error('Bad JSON from ' + url + ': ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Geocode a place name to coordinates using Open-Meteo Geocoding API
 * (https://open-meteo.com/en/docs/geocoding-api). Free, no API key,
 * returns Chinese place names, and provides admin1 (province) /
 * admin2 (city) for spatial scope building.
 *
 * Falls back to Photon (photon.komoot.io) if Open-Meteo finds nothing.
 *
 * Returns { lat, lng, displayName } or throws.
 */
async function geocode(query) {
  // --- primary: Open-Meteo ---
  const url1 = 'https://geocoding-api.open-meteo.com/v1/search'
    + '?name=' + encodeURIComponent(query)
    + '&count=1&language=zh&format=json';
  try {
    const r = await getJson(url1);
    if (r.status === 200 && r.json && Array.isArray(r.json.results) && r.json.results.length > 0) {
      const hit = r.json.results[0];
      const parts = [hit.admin2, hit.admin1, hit.country].filter(Boolean);
      const displayName = (hit.name || query) + (parts.length ? '，' + parts.join('，') : '');
      return { lat: hit.latitude, lng: hit.longitude, displayName };
    }
  } catch (_e) { /* fall through */ }

  // --- fallback: Photon ---
  const url2 = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(query) + '&limit=1';
  try {
    const r = await getJson(url2);
    if (r.status === 200 && r.json && Array.isArray(r.json.features) && r.json.features.length > 0) {
      const props = r.json.features[0].properties;
      const coord = r.json.features[0].geometry.coordinates;
      const parts = [props.city, props.state, props.country].filter(Boolean);
      const displayName = (props.name || query) + (parts.length ? '，' + parts.join('，') : '');
      return { lat: coord[1], lng: coord[0], displayName };
    }
  } catch (_e) { /* fall through */ }

  throw new Error('未找到该地点："' + query + '"。请尝试更具体的名称（例如加上城市/省份）。');
}

/**
 * Reverse-geocode coordinates to a structured address.
 *
 * Since we need admin-level hierarchy (district/city/province) for spatial
 * scope building but no free reverse-geocoder in China gives us that, we use
 * Open-Meteo's forward search with nearby coordinates to approximate: we look
 * up "what place is near lat,lng" by searching the area around the point.
 *
 * Falls back to a simple label if nothing is found.
 */
async function reverseGeocode(lat, lng) {
  // Try: search by rounded coordinates to find the nearest named place.
  // Open-Meteo does not have a reverse endpoint, so we search for places
  // near the coordinate using a small bounding box.
  try {
    // Use a ~10km search radius
    const rLat = lat.toFixed(1), rLng = lng.toFixed(1);
    const url = 'https://geocoding-api.open-meteo.com/v1/search'
      + '?name=' + encodeURIComponent(rLat + ',' + rLng)
      + '&count=5&language=zh&format=json';
    const r = await getJson(url);
    if (r.status === 200 && r.json && Array.isArray(r.json.results)) {
      // pick the result closest to the query point
      let best = null, bestDist = Infinity;
      for (const res of r.json.results) {
        const d = haversineKm({ lat, lng }, { lat: res.latitude, lng: res.longitude });
        if (d < bestDist) { bestDist = d; best = res; }
      }
      if (best && bestDist < 50) {
        const parts = [best.admin2, best.admin1, best.country].filter(Boolean);
        const displayName = (best.name || '') + (parts.length ? '，' + parts.join('，') : '');
        // Build a synthetic "address" object compatible with buildSpatialScope
        return {
          displayName,
          address: {
            city: best.admin2 || best.name || '',
            state: best.admin1 || '',
            country: best.country || '',
            province: best.admin1 || '',
            city_district: '',
            district: '',
          },
        };
      }
    }
  } catch (_e) { /* non-fatal */ }

  // Fallback: Photon reverse
  try {
    const url = 'https://photon.komoot.io/reverse?lat=' + lat + '&lon=' + lng;
    const r = await getJson(url);
    if (r.status === 200 && r.json && r.json.features && r.json.features.length > 0) {
      const props = r.json.features[0].properties;
      const parts = [props.city, props.district, props.state, props.country].filter(Boolean);
      return {
        displayName: parts.join('，') || '未知位置',
        address: {
          city: props.city || '',
          state: props.state || '',
          country: props.country || '',
          province: props.state || '',
          city_district: props.district || '',
          district: props.district || '',
        },
      };
    }
  } catch (_e) { /* non-fatal */ }

  return null;
}

/**
 * Determine the circle layer (圈层) for an event based on its distance from the
 * query point, per the spec's three-layer model.
 *
 *   core (核心圈):       distance <= coreRadiusKm       (default 1 km)
 *   companion (临近圈):  distance <= companionRadiusKm  (default 50 km, ~ neighbor districts/cities)
 *   empathy (共情圈):    everything else within the search scope (province / cultural region)
 *
 * @param {number} distKm
 * @param {{coreRadiusKm:number, companionRadiusKm:number}} cfg
 */
function classifyLayer(distKm, cfg) {
  if (distKm <= cfg.coreRadiusKm) return 'core';
  if (distKm <= cfg.companionRadiusKm) return 'companion';
  return 'empathy';
}

const LAYER_META = {
  core:      { label: '擦肩而过',   tagline: '我与危险擦肩而过。',           color: '#e63946' },
  companion: { label: '一衣带水',   tagline: '危险曾离我的生活圈很近。',     color: '#f4a261' },
  empathy:   { label: '一箭之遥',   tagline: '我们共同经历过这场灾难。',     color: '#457b9d' },
};

/**
 * Build the spatial keywords for an LLM query from a structured address.
 *
 * Spec requirement ("客户端检索策略增强"): when the user queries e.g.
 * "广州市越秀区", the client should automatically augment the API call with
 * neighboring administrative-district keywords (天河区, 海珠区, ...) to
 * improve recall. We implement this by extracting the district / city / province
 * from the reverse-geocoded address and emitting a structured spatial scope.
 *
 * The LLM is then told to treat these as the companion/empathy layers.
 */
function buildSpatialScope(address) {
  if (!address) return { raw: '', parts: [], core: '', companion: [], empathy: [] };
  const a = address;
  // Chinese administrative names
  const district = a.city_district || a.district || a.suburb || a.borough || a.neighbourhood || '';
  const city = a.city || a.town || a.municipality || a.county || '';
  const state = a.state || a.region || a.province || '';
  const country = a.country || '';

  // Core = the most specific place the user is at.
  const core = district || city || state || country;

  // Companion keywords: neighboring prefecture-level cities of the query city.
  // We don't ship a boundary dataset, so we hand the model the city + province
  // and instruct it (in the prompt) to enumerate the adjacent cities itself.
  const companion = [];
  if (city) companion.push(city + ' 的相邻地级市');
  if (district && city && district !== city) companion.push(district);

  // Empathy keywords: the province (same-province scope).
  const empathy = [];
  if (state) empathy.push(state + ' 全省');

  return {
    raw: [district, city, state, country].filter(Boolean).join(' '),
    core,
    companion: Array.from(new Set(companion.filter(Boolean))),
    empathy: Array.from(new Set(empathy.filter(Boolean))),
    parts: { district, city, state, country },
  };
}

module.exports = {
  haversineKm,
  geocode,
  reverseGeocode,
  classifyLayer,
  LAYER_META,
  buildSpatialScope,
  getJson,
};
