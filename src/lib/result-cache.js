// src/lib/result-cache.js
// Persistent local cache for online search results.
//
// Purpose: identical queries return instantly and deterministically instead of
// re-running the (slow, non-deterministic) LLM web search. The cache key is a
// SHA-256 of the full query semantics: coordinates, place label, time range,
// radii and model — so changing any of them yields a fresh lookup.
//
// Entries expire after a configurable TTL (default 7 days); event records for
// past dates are stable, so a long-ish TTL is safe. The file lives in the
// private data dir next to settings.json and never leaves the machine.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 7;

function createResultCache(filePath) {
  let cache = null; // lazy-loaded { version, entries: { key: {...} } }
  let dirty = false;

  function load() {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      cache = (parsed && parsed.version === 1 && parsed.entries) ? parsed : { version: 1, entries: {} };
    } catch (_e) {
      cache = { version: 1, entries: {} };
    }
    return cache;
  }

  function persist() {
    if (!cache || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      dirty = false;
    } catch (_e) {
      // Cache is best-effort; a failed write must never break a query.
    }
  }

  /**
   * Build a stable cache key from the query's semantic fields.
   * Radii/model are stringified via JSON so type changes don't collide.
   */
  function makeKey({ point, placeLabel, scope, time, cfg, model, maxEvents }) {
    const norm = {
      lat: Number(point.lat).toFixed(5),
      lng: Number(point.lng).toFixed(5),
      place: (placeLabel || '').trim(),
      core: scope && scope.core ? String(scope.core) : '',
      companion: scope && Array.isArray(scope.companion) ? scope.companion : [],
      empathy: scope && Array.isArray(scope.empathy) ? scope.empathy : [],
      time,
      cfg: { coreRadiusKm: Number(cfg.coreRadiusKm), companionRadiusKm: Number(cfg.companionRadiusKm) },
      model: (model || '').trim(),
      maxEvents: Number(maxEvents) || 0,
    };
    return crypto.createHash('sha256').update(JSON.stringify(norm), 'utf8').digest('hex');
  }

  /**
   * Get a cached result, or null on miss/expiry.
   */
  function get(key, ttlDays) {
    const c = load();
    const hit = c.entries[key];
    if (!hit) return null;
    const ttl = (Number(ttlDays) > 0 ? Number(ttlDays) : DEFAULT_TTL_DAYS) * 24 * 3600 * 1000;
    if (Date.now() - hit.savedAt > ttl) {
      delete c.entries[key];
      dirty = true;
      persist();
      return null;
    }
    return hit.result;
  }

  function set(key, result) {
    const c = load();
    // Keep the file bounded: drop the oldest entries beyond 200.
    const keys = Object.keys(c.entries);
    if (keys.length >= 200) {
      keys.sort((a, b) => (c.entries[a].savedAt || 0) - (c.entries[b].savedAt || 0));
      for (const k of keys.slice(0, keys.length - 199)) delete c.entries[k];
    }
    c.entries[key] = { savedAt: Date.now(), result };
    dirty = true;
    persist();
  }

  function clear() {
    cache = { version: 1, entries: {} };
    dirty = true;
    persist();
    return true;
  }

  /** Remove expired entries; returns how many were dropped. */
  function prune(ttlDays) {
    const c = load();
    const ttl = (Number(ttlDays) > 0 ? Number(ttlDays) : DEFAULT_TTL_DAYS) * 24 * 3600 * 1000;
    let removed = 0;
    for (const k of Object.keys(c.entries)) {
      if (Date.now() - (c.entries[k].savedAt || 0) > ttl) {
        delete c.entries[k];
        removed++;
      }
    }
    if (removed) { dirty = true; persist(); }
    return removed;
  }

  function stats() {
    const c = load();
    return { entries: Object.keys(c.entries).length, path: filePath };
  }

  return { makeKey, get, set, clear, prune, stats };
}

module.exports = { createResultCache, DEFAULT_TTL_DAYS };
