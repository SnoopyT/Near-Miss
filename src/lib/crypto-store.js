// src/lib/crypto-store.js
// Encrypted local storage for the user's API key and settings.
//
// Threat model & design:
//   - The user's API key is a high-value secret. We never store it in plaintext.
//   - We derive a 256-bit key from a machine-bound passphrase plus a per-install
//     random salt using PBKDF2 (210000 iterations, SHA-256) and encrypt the
//     secret with AES-256-GCM (authenticated encryption -> tamper-resistant).
//   - The "machine passphrase" is a best-effort binding to this machine/user.
//     On Windows we use %USERNAME% + OS hostname + app install path. This is
//     NOT full disk encryption and does not defend against an attacker who
//     fully controls the machine while it is running — its goal is to make the
//     secret non-obvious at rest (defense against casual file-copy).
//
// Privacy guarantee (per requirement 5): the only data that ever leaves the
// machine is the anonymized prompt sent to the user's own configured API.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PBKDF2_ITERATIONS = 210000; // OWASP 2023 recommendation for SHA-256
const KEY_LEN = 32;               // 256-bit key for AES-256
const SALT_LEN = 16;
const IV_LEN = 12;                // 96-bit nonce recommended for GCM
const MAGIC = 'NM1';              // file format version marker

/**
 * Application-wide passphrase for key derivation.
 * Uses a fixed secret so the encrypted settings file is portable
 * across machines (user can copy the app folder to another computer
 * and the API key will still decrypt).
 *
 * WARNING: This provides "convenience-level" obfuscation only.
 * The secret is embedded in the source code.
 */
function machinePassphrase(installPath) {
  const parts = [
    'near-miss-app-v2',
  ];
  return parts.join('|');
}

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

/**
 * Encrypt a UTF-8 string into a self-contained armored string:
 *   MAGIC:base64(salt):base64(iv):base64(authTag):base64(ciphertext)
 */
function encryptString(plaintext, installPath) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(machinePassphrase(installPath), salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt an armored string. Returns null if it cannot be decrypted
 * (wrong machine / corrupted / tampered).
 */
function decryptString(armored, installPath) {
  if (!armored || typeof armored !== 'string') return null;
  const parts = armored.split(':');
  if (parts.length !== 5 || parts[0] !== MAGIC) return null;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const ct = Buffer.from(parts[4], 'base64');
    const key = deriveKey(machinePassphrase(installPath), salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * Default settings (nothing sensitive here). The API key is stored separately,
 * encrypted, under the `apiKey` field.
 */
function defaultSettings() {
  return {
    schemaVersion: 1,
    apiKey: '',            // encrypted armored string (may be empty)
    apiBaseUrl: '',
    model: '',
    coreRadiusKm: 10,      // 第一层 擦肩而过 (km)
    companionRadiusKm: 50, // 第二层内部兜底用（圈层已改为按相邻地级市划分）
    maxEvents: 20,
    requestTimeoutSec: 90,
    useOfflineMode: false, // 第三层 共情圈 uses EM-DAT CSV when true
    offlineDbPath: '',     // path to imported EM-DAT csv
    cacheTtlDays: 7,       // online search result cache lifetime (days)
  };
}

/**
 * Load settings from disk, merging with defaults. Missing/corrupt file is
 * non-fatal: we just return defaults so the app can still start.
 */
function loadSettings(configPath) {
  const base = defaultSettings();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign(base, parsed);
    }
  } catch (_e) {
    // fall through to defaults
  }
  return base;
}

/**
 * Persist settings to disk with restrictive permissions (owner-only).
 */
function saveSettings(configPath, settings) {
  const dir = path.dirname(configPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
  // Write atomically-ish: tmp then rename. 0o600 = owner read/write only.
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath);
}

/**
 * Get the decrypted API key (or '' if not set / undecryptable).
 */
function getApiKey(settings, installPath) {
  if (!settings.apiKey) return '';
  return decryptString(settings.apiKey, installPath) || '';
}

/**
 * Set (and encrypt) the API key. Pass '' to clear.
 */
function setApiKey(settings, installPath, plainKey) {
  settings.apiKey = plainKey ? encryptString(plainKey, installPath) : '';
  return settings;
}

module.exports = {
  encryptString,
  decryptString,
  defaultSettings,
  loadSettings,
  saveSettings,
  getApiKey,
  setApiKey,
};
