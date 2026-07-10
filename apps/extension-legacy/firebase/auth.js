import '../utils/productionConsole.js';
import { requestThumbmarkVisitorId } from '../utils/thumbmarkHelpers.js';

// Firebase Authentication for Chrome Extension
// Uses Chrome Identity API + Firebase Functions + JWT

// Note: firestoreListener.js is loaded separately (bundled with Firebase SDK)

// Firebase Functions base URL
// 🔧 For local testing with emulator, uncomment the line below:
// const FUNCTIONS_BASE = 'http://127.0.0.1:5001/youchords/us-central1';
// 🔧 For production, use this:
const FUNCTIONS_BASE =
  (typeof window !== 'undefined' && typeof window.__YC_FUNCTIONS_BASE === 'string' && window.__YC_FUNCTIONS_BASE.trim()) ||
  'http://127.0.0.1:8765';

// Storage keys
const JWT_KEY = 'youchords_jwt';
const USER_KEY = 'youchords_user';
const DEVICE_ID_KEY = 'youchords_device_id';
const DEVICE_FINGERPRINT_KEY = 'youchords_device_fingerprint';
const DEVICE_PROOF_KEY = 'youchords_device_proof';
const LAST_PRO_REFRESH_KEY = 'youchords_pro_last_refresh';
const LAST_FREE_GATING_REFRESH_KEY = 'youchords_free_gating_last_refresh';
const ACCOUNT_BLOCKED_STATE_KEY = 'youchords_account_blocked_state';
const UPGRADE_PENDING_KEY = 'youchords_upgrade_pending';
const PRO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FREE_REFRESH_BEFORE_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
const FREE_REFRESH_THROTTLE_MS = 24 * 60 * 60 * 1000;
const FREE_GATING_REFRESH_THROTTLE_MS = 10 * 60 * 1000;
const UPGRADE_PENDING_TTL_MS = 45 * 60 * 1000;
const UPGRADE_PENDING_REFRESH_THROTTLE_MS = 15 * 1000;
const CONSENT_STORAGE_KEY = 'youchords_consent';
const CONSENT_VERSION = '2026-02-17';
const FREE_ONE_TIME_CHORDS = 7;
const CHORD_ENGINE_CACHE_VERSION = 2;
const CHORD_ENGINE_CACHE_VERSION_KEY = 'youchords_chord_engine_cache_version';
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];
const GOOGLE_WEB_AUTH_CLIENT_IDS = {
  replace_with_your_extension_id: 'REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID',
  eamgkgealnjeebajllideljofihjmonp: 'REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID'
};
let chordEngineCacheResetPromise = null;

function getPerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function createTimingTracker(flowName, meta = {}) {
  const startedAt = getPerfNow();
  let lastAt = startedAt;
  return {
    mark(stage, extra = {}) {
      const now = getPerfNow();
      const totalMs = Math.round(now - startedAt);
      const stepMs = Math.round(now - lastAt);
      lastAt = now;
      console.log(`[Auth][Timing][${flowName}] ${stage}`, {
        totalMs,
        stepMs,
        ...meta,
        ...extra
      });
    },
    end(stage = 'done', extra = {}) {
      this.mark(stage, extra);
    }
  };
}

// Cache for JWT (to avoid async calls every time)
let cachedJWT = null;
let cachedDeviceId = null;
let cachedDeviceFingerprint = undefined;
let cachedDeviceProof = undefined;
let cachedLastProRefreshAt = null;
let cachedLastFreeGatingRefreshAt = null;
let cachedAccountBlockedState = null;
let refreshJwtPromise = null;
let blockedCleanupPromise = null;

function isPopupContext() {
  return window.location.href.includes('popup.html');
}

function getClientExtensionIdForBackend() {
  try {
    const extensionId = chrome?.runtime?.id || '';
    return /^[a-p]{32}$/.test(extensionId) ? extensionId : null;
  } catch (_) {
    return null;
  }
}

function getManifestGoogleOAuthClientId() {
  try {
    return String(chrome?.runtime?.getManifest?.()?.oauth2?.client_id || '').trim();
  } catch (_) {
    return '';
  }
}

function getGoogleWebAuthClientId() {
  try {
    const extensionId = String(chrome?.runtime?.id || '').trim();
    return GOOGLE_WEB_AUTH_CLIENT_IDS[extensionId] || getManifestGoogleOAuthClientId();
  } catch (_) {
    return getManifestGoogleOAuthClientId();
  }
}

async function isBraveBrowser() {
  try {
    return !!(navigator?.brave && await navigator.brave.isBrave());
  } catch (_) {
    return false;
  }
}

async function shouldPreferGoogleWebAuthFlow() {
  if (await isBraveBrowser()) return true;

  const ua = String(navigator?.userAgent || '');
  if (/\b(Edg|OPR|Opera|Vivaldi|YaBrowser)\//i.test(ua)) return true;

  const brands = [
    ...(navigator?.userAgentData?.brands || []),
    ...(navigator?.userAgentData?.fullVersionList || [])
  ]
    .map((entry) => String(entry?.brand || '').toLowerCase())
    .filter(Boolean);

  if (brands.some((brand) => /brave|edge|opera|vivaldi|yandex|arc/.test(brand))) return true;
  if (brands.some((brand) => brand === 'google chrome')) return false;

  return false;
}

function buildGoogleWebAuthUrl(state) {
  const clientId = getGoogleWebAuthClientId();
  if (!clientId) throw new Error('Google OAuth client ID is missing.');

  const redirectUri = chrome.identity.getRedirectURL('google');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function parseGoogleWebAuthRedirect(redirectUrl, expectedState) {
  let parsed;
  try {
    parsed = new URL(redirectUrl);
  } catch (_) {
    throw new Error('Google sign-in returned an invalid redirect.');
  }

  const rawParams = parsed.hash && parsed.hash.length > 1
    ? parsed.hash.slice(1)
    : parsed.search.slice(1);
  const params = new URLSearchParams(rawParams);

  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    throw new Error(description || error);
  }

  const state = params.get('state') || '';
  if (!state || state !== expectedState) {
    throw new Error('Google sign-in state validation failed.');
  }

  const token = params.get('access_token');
  if (!token) {
    throw new Error('Google sign-in did not return an access token.');
  }

  return token;
}

async function launchGoogleWebAuthFlow() {
  if (!chrome?.identity?.launchWebAuthFlow || !chrome?.identity?.getRedirectURL) {
    throw new Error('Browser web sign-in is unavailable.');
  }

  const state = crypto.randomUUID();
  const url = buildGoogleWebAuthUrl(state);
  const redirectUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(responseUrl);
    });
  });

  if (!redirectUrl) {
    throw new Error('Google sign-in was cancelled.');
  }

  return parseGoogleWebAuthRedirect(redirectUrl, state);
}

async function getGoogleOAuthTokenForSignIn() {
  const shouldPreferWebFlow = await shouldPreferGoogleWebAuthFlow();
  if (shouldPreferWebFlow) {
    try {
      return await launchGoogleWebAuthFlow();
    } catch (webFlowError) {
      console.warn('[Auth] Browser web sign-in failed, trying Chrome identity fallback:', webFlowError);
    }
  }

  try {
    return await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(token);
        }
      });
    });
  } catch (identityError) {
    console.warn('[Auth] Chrome identity sign-in failed, trying web auth fallback:', identityError);
    return launchGoogleWebAuthFlow();
  }
}

async function ensureLocalDeviceId(existing = null) {
  const data = existing || await chrome.storage.local.get([DEVICE_ID_KEY]);
  if (data[DEVICE_ID_KEY]) return data[DEVICE_ID_KEY];

  const deviceId = 'did_' + crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: deviceId });
  return deviceId;
}

// Get local install/session deviceId. Paid visitorId is requested only on signup verification.
async function getIdentifiers() {
  if (cachedDeviceId && cachedDeviceFingerprint !== undefined && cachedDeviceProof !== undefined) {
    return {
      fingerprint: cachedDeviceFingerprint || null,
      deviceProof: cachedDeviceProof || null,
      deviceId: cachedDeviceId
    };
  }

  // Try to use the global function from content.js
  if (typeof window.getYcIdentifiers === 'function') {
    const identifiers = await window.getYcIdentifiers();
    if (identifiers?.deviceId) cachedDeviceId = identifiers.deviceId;
    cachedDeviceFingerprint = identifiers?.fingerprint || null;
    cachedDeviceProof = identifiers?.deviceProof || null;
    return {
      fingerprint: cachedDeviceFingerprint,
      deviceProof: cachedDeviceProof,
      deviceId: identifiers?.deviceId || await ensureLocalDeviceId()
    };
  }

  // Fallback: read directly from storage
  try {
    const result = await chrome.storage.local.get([DEVICE_ID_KEY, DEVICE_FINGERPRINT_KEY, DEVICE_PROOF_KEY]);
    const deviceId = result[DEVICE_ID_KEY] || await ensureLocalDeviceId(result);
    const identifiers = {
      fingerprint: typeof result[DEVICE_FINGERPRINT_KEY] === 'string' && result[DEVICE_FINGERPRINT_KEY].trim()
        ? result[DEVICE_FINGERPRINT_KEY].trim()
        : null,
      deviceProof: typeof result[DEVICE_PROOF_KEY] === 'string' && result[DEVICE_PROOF_KEY].trim()
        ? result[DEVICE_PROOF_KEY].trim()
        : null,
      deviceId
    };
    if (identifiers.deviceId) cachedDeviceId = identifiers.deviceId;
    cachedDeviceFingerprint = identifiers.fingerprint;
    cachedDeviceProof = identifiers.deviceProof;
    return identifiers;
  } catch (e) {
    console.warn('[Auth] Failed to get identifiers:', e);
    return {
      fingerprint: null,
      deviceProof: null,
      deviceId: 'error_getting_device_id'
    };
  }
}

// Helper function to wait for databaseManager to load
function waitForDB(maxWaitMs = 5000) {
  return new Promise((resolve) => {
    if (window.databaseManager) return resolve(true);

    const startTime = Date.now();
    const interval = setInterval(() => {
      if (window.databaseManager) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startTime > maxWaitMs) {
        clearInterval(interval);
        console.warn('[Auth] ⚠️ Timeout waiting for databaseManager');
        resolve(false);
      }
    }, 50);
  });
}

async function deleteChordsDatabaseWithTimeout(timeoutMs = 3000) {
  if (!window.databaseManager?.deleteChordsDatabase) {
    return { success: false, error: 'deleteChordsDatabase unavailable' };
  }

  let timeoutId = null;
  try {
    return await Promise.race([
      window.databaseManager.deleteChordsDatabase(),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ success: false, error: 'chords_db_delete_timeout' });
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ensureChordEngineCacheVersion() {
  if (isPopupContext()) return;
  if (!window.databaseManager?.deleteChordsDatabase) return;
  if (chordEngineCacheResetPromise) {
    return chordEngineCacheResetPromise;
  }

  chordEngineCacheResetPromise = (async () => {
    try {
      const result = await chrome.storage.local.get([CHORD_ENGINE_CACHE_VERSION_KEY]);
      const cachedVersion = Number(result?.[CHORD_ENGINE_CACHE_VERSION_KEY]) || 0;
      if (cachedVersion >= CHORD_ENGINE_CACHE_VERSION) {
        return;
      }

      console.log(`[Auth] 🎼 Chord engine cache v${cachedVersion || 1} detected - resetting Chords DB for v${CHORD_ENGINE_CACHE_VERSION}`);
      const deleteResult = await deleteChordsDatabaseWithTimeout();
      if (deleteResult?.success) {
        window.chordTextsCache = {};
        window.chordTextsCacheOrder = [];
        window.PANEL_SUBSET = null;
        await chrome.storage.local.set({
          [CHORD_ENGINE_CACHE_VERSION_KEY]: CHORD_ENGINE_CACHE_VERSION
        });
        console.log(`[Auth] 🎼 ✅ Chord engine cache reset complete for v${CHORD_ENGINE_CACHE_VERSION}`);
      } else {
        console.warn('[Auth] 🎼 Chord engine cache reset did not complete:', deleteResult);
      }
    } catch (error) {
      console.warn('[Auth] 🎼 Failed to reset chord engine cache version:', error);
    }
  })();

  try {
    return await chordEngineCacheResetPromise;
  } finally {
    chordEngineCacheResetPromise = null;
  }
}

// Initialize cache from chrome.storage
async function initAuthCache() {
  try {
    const result = await chrome.storage.local.get([
      JWT_KEY,
      DEVICE_ID_KEY,
      LAST_PRO_REFRESH_KEY,
      LAST_FREE_GATING_REFRESH_KEY,
      ACCOUNT_BLOCKED_STATE_KEY
    ]);
    if (result[JWT_KEY]) {
      cachedJWT = result[JWT_KEY];
      if (isPopupContext()) {
        localStorage.setItem(JWT_KEY, cachedJWT);
      }
    }
    if (result[DEVICE_ID_KEY]) {
      cachedDeviceId = result[DEVICE_ID_KEY];
    }
    if (typeof result[LAST_PRO_REFRESH_KEY] === 'number') {
      cachedLastProRefreshAt = result[LAST_PRO_REFRESH_KEY];
    }
    if (typeof result[LAST_FREE_GATING_REFRESH_KEY] === 'number') {
      cachedLastFreeGatingRefreshAt = result[LAST_FREE_GATING_REFRESH_KEY];
    }
    const blockedState = result[ACCOUNT_BLOCKED_STATE_KEY];
    if (blockedState?.blocked === true) {
      cachedAccountBlockedState = blockedState;
      if (isPopupContext()) {
        localStorage.setItem(ACCOUNT_BLOCKED_STATE_KEY, JSON.stringify(blockedState));
      }
    } else {
      cachedAccountBlockedState = null;
      if (isPopupContext()) {
        localStorage.removeItem(ACCOUNT_BLOCKED_STATE_KEY);
      }
    }
    console.log('[Auth] Cache initialized, JWT exists:', !!cachedJWT, ', DeviceID exists:', !!cachedDeviceId);

    // 🛡️ Skip cleanup checks if running in popup (databaseManager only exists in content scripts)
    const isPopup = isPopupContext();
    if (isPopup) {
      console.log('[Auth] Running in popup - skipping cleanup checks');
      return;
    }

    // 🛡️ Wait for databaseManager to load before cleanup operations
    if (!window.databaseManager) {
      console.log('[Auth] ⏳ Waiting for databaseManager to load...');
      const dbReady = await waitForDB();
      if (!dbReady) {
        console.warn('[Auth] ⚠️ databaseManager not available - skipping cleanup checks');
        return;
      }
      console.log('[Auth] ✅ databaseManager loaded');
    }

    // 🔒 Check for pending cleanup (interrupted cleanup from previous session)
    if (localStorage.getItem('yc_pending_cleanup') === 'true') {
      console.log('[Auth] 🔒 Found pending cleanup flag - resuming cleanup...');
      if (window.databaseManager?.deleteChordsDatabase) {
        try {
          const result = await deleteChordsDatabaseWithTimeout();
          if (result?.success) {
            localStorage.removeItem('yc_pending_cleanup');
            console.log('[Auth] 🔒 ✅ Resumed cleanup completed: Chords DB deleted');
          } else {
            console.warn('[Auth] 🔒 Resumed cleanup did not complete:', result);
          }
        } catch (error) {
          console.error('[Auth] 🔒 ❌ Resumed cleanup failed:', error);
        }
      } else {
        console.warn('[Auth] 🔒 databaseManager.deleteChordsDatabase not available for resumed cleanup');
      }
    }

    await ensureChordEngineCacheVersion();

    // 🔒 Check for downgrade on page load (in case user downgraded on another page)
    if (cachedJWT) {
      const previousJWT = localStorage.getItem('yc_previous_jwt');
      const currentJWT = cachedJWT;

      if (previousJWT && previousJWT !== currentJWT) {
        console.log('[Auth] 🔍 JWT changed since last visit - checking for downgrade');
        const oldPayload = decodeJWT(previousJWT);
        const newPayload = decodeJWT(currentJWT);

        if (oldPayload?.plan === 'pro' && newPayload?.plan === 'free') {
          console.log('[Auth] 🔒 Detected downgrade from Pro to Free - starting cleanup');
          await checkForProDowngrade(previousJWT, currentJWT);
        }
      }

      // Save current JWT for next comparison
      localStorage.setItem('yc_previous_jwt', currentJWT);
    }
  } catch (e) {
    console.warn('[Auth] Failed to init cache:', e);
  }
}

// Auto-init on load
let authCacheReadyPromise = null;
let initialAuthCachePromise = null;

function startAuthCacheInit() {
  if (authCacheReadyPromise) return authCacheReadyPromise;

  const trackedPromise = initAuthCache().finally(() => {
    if (authCacheReadyPromise === trackedPromise) {
      authCacheReadyPromise = null;
    }
  });
  authCacheReadyPromise = trackedPromise;
  return trackedPromise;
}

initialAuthCachePromise = startAuthCacheInit();

// Decode JWT payload (without verification - server verifies)
function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) {
    return null;
  }
}

// Check if JWT is expired
function isJWTExpired(token) {
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return true;
  // Backward compatibility: support both seconds and milliseconds timestamps.
  const expRaw = Number(payload.exp);
  if (!Number.isFinite(expRaw)) return true;
  const expMs = expRaw > 1e12 ? expRaw : expRaw * 1000;
  return expMs < Date.now();
}

function normalizeConsentPayload(consent, source = 'popup_signin') {
  if (!consent || consent.accepted !== true) return null;
  if (typeof consent.version !== 'string' || !consent.version.trim()) return null;
  if (consent.version.trim() !== CONSENT_VERSION) return null;

  const acceptedAt = new Date(consent.acceptedAt || Date.now());
  if (Number.isNaN(acceptedAt.getTime())) return null;

  const sourceValue = typeof consent.source === 'string' && consent.source.trim()
    ? consent.source.trim()
    : source;

  return {
    accepted: true,
    version: consent.version.trim(),
    acceptedAt: acceptedAt.toISOString(),
    source: sourceValue
  };
}

async function saveConsentLocally(consent) {
  try {
    await chrome.storage.local.set({
      [CONSENT_STORAGE_KEY]: {
        ...consent,
        savedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.warn('[Auth] Failed to persist consent locally:', error);
  }
}

async function getStoredConsentLocally(source = 'popup_stored_consent') {
  try {
    const result = await chrome.storage.local.get([CONSENT_STORAGE_KEY]);
    return normalizeConsentPayload(result?.[CONSENT_STORAGE_KEY], source);
  } catch (error) {
    console.warn('[Auth] Failed reading stored consent:', error);
    return null;
  }
}

// Get stored JWT
function getStoredJWT() {
  // Check cache first
  if (cachedJWT) {
    // Return token even if expired. Callers can trigger silent refresh before critical actions.
    return cachedJWT;
  }

  // Popup context can read its own extension localStorage as a fallback.
  if (isPopupContext()) {
    const popupJwt = localStorage.getItem(JWT_KEY);
    if (popupJwt) {
      cachedJWT = popupJwt;
      return popupJwt;
    }
  }

  return null;
}

// Store JWT
function storeJWT(jwt) {
  cachedJWT = jwt;
  const payload = decodeJWT(jwt);
  if (payload?.blocked) {
    setBlockedState(payload.blockedReason || 'payment_dispute');
  } else if (cachedAccountBlockedState?.blocked) {
    clearBlockedState();
  }
  if (isPopupContext()) {
    localStorage.setItem(JWT_KEY, jwt);
  }
  // Also save to chrome.storage for cross-context sharing
  chrome.storage.local.set({ [JWT_KEY]: jwt });
  console.log('[Auth] JWT stored');
}

// Clear auth cache only (for regular sign out - keeps IndexedDB!)
function clearAuthCacheOnly() {
  cachedJWT = null;
  cachedDeviceId = null;
  cachedLastProRefreshAt = null;
  cachedLastFreeGatingRefreshAt = null;
  clearBlockedState();
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
  chrome.storage.local.remove([LAST_PRO_REFRESH_KEY, LAST_FREE_GATING_REFRESH_KEY, UPGRADE_PENDING_KEY]);
  console.log('[Auth] Auth cache cleared (IndexedDB kept)');
}

async function clearSessionForRelogin() {
  clearAuthCacheOnly();
  try {
    await chrome.storage.local.remove([JWT_KEY, USER_KEY, LAST_PRO_REFRESH_KEY, LAST_FREE_GATING_REFRESH_KEY]);
  } catch (error) {
    console.warn('[Auth] Failed clearing session for relogin:', error);
  }
}

function setBlockedState(reason = 'payment_dispute') {
  const blockedState = {
    blocked: true,
    reason: reason || 'payment_dispute',
    at: new Date().toISOString()
  };

  cachedAccountBlockedState = blockedState;
  if (isPopupContext()) {
    localStorage.setItem(ACCOUNT_BLOCKED_STATE_KEY, JSON.stringify(blockedState));
  }

  chrome.storage.local.set({ [ACCOUNT_BLOCKED_STATE_KEY]: blockedState }).catch((error) => {
    console.warn('[Auth] Failed saving blocked state:', error);
  });
}

function clearBlockedState() {
  cachedAccountBlockedState = null;
  if (isPopupContext()) {
    localStorage.removeItem(ACCOUNT_BLOCKED_STATE_KEY);
  }
  chrome.storage.local.remove([ACCOUNT_BLOCKED_STATE_KEY]).catch((error) => {
    console.warn('[Auth] Failed clearing blocked state:', error);
  });
}

async function deleteChordsDatabaseForBlocked() {
  if (window.databaseManager?.deleteChordsDatabase) {
    try {
      const result = await window.databaseManager.deleteChordsDatabase();
      if (result?.success) {
        console.log('[Auth] Chords DB deleted due to blocked account');
      }
    } catch (error) {
      console.warn('[Auth] Failed deleting Chords DB for blocked account:', error);
    }
    return;
  }

  if (isPopupContext()) return;
  const dbReady = await waitForDB(1500);
  if (!dbReady || !window.databaseManager?.deleteChordsDatabase) return;

  try {
    const result = await window.databaseManager.deleteChordsDatabase();
    if (result?.success) {
      console.log('[Auth] Chords DB deleted after delayed DB load (blocked account)');
    }
  } catch (error) {
    console.warn('[Auth] Failed delayed Chords DB deletion for blocked account:', error);
  }
}

async function handleBlockedAccount(restriction = {}) {
  const reason = restriction?.blockedReason || restriction?.error || 'payment_dispute';
  setBlockedState(reason);

  if (blockedCleanupPromise) {
    return blockedCleanupPromise;
  }

  blockedCleanupPromise = (async () => {
    await deleteChordsDatabaseForBlocked();
  })().finally(() => {
    blockedCleanupPromise = null;
  });

  return blockedCleanupPromise;
}

// Clear all auth data INCLUDING IndexedDB (for account deletion only!)
function clearAuthCache() {
  clearAuthCacheOnly();

  // 🗑️ Delete Chords DB only on account deletion!
  if (window.databaseManager?.deleteChordsDatabase) {
    window.databaseManager.deleteChordsDatabase();
    console.log('[Auth] 🗑️ Deleted Chords DB on account deletion');
  }

  console.log('[Auth] Full auth cache + IndexedDB cleared');
}

// Get JWT payload (subscription info)
function getJWTPayload() {
  const jwt = getStoredJWT();
  if (!jwt) return null;
  return decodeJWT(jwt);
}

function getTokenExpiryMs(payload) {
  const rawExp = Number(payload?.exp);
  if (!Number.isFinite(rawExp)) return 0;
  return rawExp > 1e12 ? rawExp : rawExp * 1000;
}

async function getLastProRefreshAt() {
  if (typeof cachedLastProRefreshAt === 'number') return cachedLastProRefreshAt;
  try {
    const result = await chrome.storage.local.get([LAST_PRO_REFRESH_KEY]);
    if (typeof result[LAST_PRO_REFRESH_KEY] === 'number') {
      cachedLastProRefreshAt = result[LAST_PRO_REFRESH_KEY];
      return cachedLastProRefreshAt;
    }
  } catch (error) {
    console.warn('[Auth] Failed reading last Pro refresh timestamp:', error);
  }
  cachedLastProRefreshAt = 0;
  return 0;
}

function saveLastProRefreshAt(ts = Date.now()) {
  cachedLastProRefreshAt = ts;
  chrome.storage.local.set({ [LAST_PRO_REFRESH_KEY]: ts }).catch((error) => {
    console.warn('[Auth] Failed saving last Pro refresh timestamp:', error);
  });
}

async function getLastFreeGatingRefreshAt() {
  if (typeof cachedLastFreeGatingRefreshAt === 'number') return cachedLastFreeGatingRefreshAt;
  try {
    const result = await chrome.storage.local.get([LAST_FREE_GATING_REFRESH_KEY]);
    if (typeof result[LAST_FREE_GATING_REFRESH_KEY] === 'number') {
      cachedLastFreeGatingRefreshAt = result[LAST_FREE_GATING_REFRESH_KEY];
      return cachedLastFreeGatingRefreshAt;
    }
  } catch (error) {
    console.warn('[Auth] Failed reading free gating refresh timestamp:', error);
  }
  cachedLastFreeGatingRefreshAt = 0;
  return 0;
}

function saveLastFreeGatingRefreshAt(ts = Date.now()) {
  cachedLastFreeGatingRefreshAt = ts;
  chrome.storage.local.set({ [LAST_FREE_GATING_REFRESH_KEY]: ts }).catch((error) => {
    console.warn('[Auth] Failed saving free gating refresh timestamp:', error);
  });
}

function normalizeUpgradePendingState(rawState) {
  if (!rawState || rawState.active !== true) return null;
  const markedAt = Number(rawState.markedAt);
  const expiresAt = Number(rawState.expiresAt);
  const lastAttemptAt = Number(rawState.lastAttemptAt || 0);
  if (!Number.isFinite(markedAt) || markedAt <= 0) return null;

  const fallbackExpiresAt = markedAt + UPGRADE_PENDING_TTL_MS;
  const safeExpiresAt = Number.isFinite(expiresAt) && expiresAt > 0
    ? expiresAt
    : fallbackExpiresAt;

  return {
    active: true,
    source: typeof rawState.source === 'string' ? rawState.source : 'unknown',
    markedAt,
    expiresAt: safeExpiresAt,
    lastAttemptAt: Number.isFinite(lastAttemptAt) && lastAttemptAt > 0 ? lastAttemptAt : 0
  };
}

async function readUpgradePendingState() {
  try {
    const result = await chrome.storage.local.get([UPGRADE_PENDING_KEY]);
    return normalizeUpgradePendingState(result?.[UPGRADE_PENDING_KEY]);
  } catch (error) {
    console.warn('[Auth] Failed reading upgrade pending state:', error);
    return null;
  }
}

async function writeUpgradePendingState(nextState) {
  const normalizedState = normalizeUpgradePendingState(nextState);
  if (!normalizedState) return;
  try {
    await chrome.storage.local.set({ [UPGRADE_PENDING_KEY]: normalizedState });
  } catch (error) {
    console.warn('[Auth] Failed writing upgrade pending state:', error);
  }
}

async function clearUpgradePendingState() {
  try {
    await chrome.storage.local.remove([UPGRADE_PENDING_KEY]);
  } catch (error) {
    console.warn('[Auth] Failed clearing upgrade pending state:', error);
  }
}

async function shouldForceRefreshForPendingUpgrade(now = Date.now()) {
  const pendingState = await readUpgradePendingState();
  if (!pendingState) return false;

  const isExpired = pendingState.expiresAt <= now || (now - pendingState.markedAt > UPGRADE_PENDING_TTL_MS);
  if (isExpired) {
    await clearUpgradePendingState();
    return false;
  }

  const lastAttemptAt = pendingState.lastAttemptAt || 0;
  const refreshThrottled = lastAttemptAt > 0 && (now - lastAttemptAt < UPGRADE_PENDING_REFRESH_THROTTLE_MS);
  if (refreshThrottled) return false;

  await writeUpgradePendingState({
    ...pendingState,
    lastAttemptAt: now
  });
  return true;
}

async function refreshJWTFromServer() {
  const currentJwt = getStoredJWT();
  if (!currentJwt) {
    return { success: false, error: 'No JWT found' };
  }

  try {
    const identifiers = await getIdentifiers();
    const response = await fetch(`${FUNCTIONS_BASE}/refreshJWT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentJwt}`
      },
      body: JSON.stringify({
        deviceId: identifiers?.deviceId || null,
        fingerprint: identifiers?.fingerprint || null
      })
    });

    if (!response.ok) {
      let responseData = null;
      try {
        responseData = await response.json();
      } catch (_) {
        responseData = null;
      }

      const serverError = responseData?.error || `Refresh failed (${response.status})`;
      return {
        success: false,
        status: response.status,
        error: serverError,
        needsRelogin: !!responseData?.needsRelogin,
        blocked: !!responseData?.blocked,
        deletionPending: !!responseData?.deletionPending
      };
    }

    const data = await response.json();
    if (!data?.jwt) {
      return { success: false, error: 'No JWT in refresh response' };
    }

    storeJWT(data.jwt);
    saveLastProRefreshAt(Date.now());
    return { success: true, jwt: data.jwt };
  } catch (error) {
    return { success: false, error: error.message || 'Refresh failed' };
  }
}

async function refreshJwtSingleFlight() {
  if (refreshJwtPromise) return refreshJwtPromise;

  refreshJwtPromise = (async () => {
    const result = await refreshJWTFromServer();
    if (!result.success && result.blocked) {
      await handleBlockedAccount(result);
    }
    if (!result.success && result.status === 403 && result.needsRelogin) {
      await clearSessionForRelogin();
    }
    if (!result.success && result.status === 401) {
      await clearSessionForRelogin();
    }
    if (!result.success) {
      if (result.status === 403 && result.needsRelogin) {
        console.info('[Auth] Silent JWT refresh skipped (session out of date):', result.error);
      } else if (result.status === 401) {
        console.info('[Auth] Silent JWT refresh rejected (invalid or too old token):', result.error);
      } else {
        console.warn('[Auth] Silent JWT refresh failed:', result.error);
      }
    }
    return result;
  })().finally(() => {
    refreshJwtPromise = null;
  });

  return refreshJwtPromise;
}

async function maybeRefreshUserJWT() {
  const jwt = getStoredJWT();
  if (!jwt) return;

  const payload = decodeJWT(jwt);
  const plan = payload?.plan || 'free';

  const now = Date.now();
  const expiryMs = getTokenExpiryMs(payload);
  const isExpired = expiryMs > 0 ? expiryMs <= now : true;
  const msUntilExpiry = expiryMs > 0 ? expiryMs - now : 0;

  if (plan === 'free') {
    const forceForPendingUpgrade = await shouldForceRefreshForPendingUpgrade(now);
    const nearExpiry = isExpired || msUntilExpiry <= FREE_REFRESH_BEFORE_EXPIRY_MS;
    if (!nearExpiry && !forceForPendingUpgrade) return;

    const lastRefreshAt = await getLastProRefreshAt();
    const refreshDue = forceForPendingUpgrade || !lastRefreshAt || (now - lastRefreshAt >= FREE_REFRESH_THROTTLE_MS);
    if (!refreshDue && !isExpired) return;

    const refreshResult = await refreshJwtSingleFlight();
    if (refreshResult.success) {
      const updatedPayload = decodeJWT(getStoredJWT());
      if ((updatedPayload?.plan || 'free') !== 'free') {
        await clearUpgradePendingState();
      }
    }
    return;
  }

  const lastRefreshAt = await getLastProRefreshAt();
  const refreshDue = !lastRefreshAt || (now - lastRefreshAt >= PRO_REFRESH_INTERVAL_MS);
  if (!isExpired && !refreshDue) return;
  await refreshJwtSingleFlight();
}

async function ensureFreshSubscriptionForGating() {
  await maybeRefreshUserJWT();
  const payload = getJWTPayload();
  const plan = payload?.plan || 'free';
  if (plan !== 'free') {
    return getSubscriptionInfo();
  }

  const now = Date.now();
  const pendingState = await readUpgradePendingState();
  if (pendingState?.active) {
    if (pendingState.expiresAt <= now) {
      await clearUpgradePendingState();
    } else {
      return getSubscriptionInfo();
    }
  }

  const lastAttemptAt = await getLastFreeGatingRefreshAt();
  const refreshDue = !lastAttemptAt || (now - lastAttemptAt >= FREE_GATING_REFRESH_THROTTLE_MS);
  if (!refreshDue) {
    return getSubscriptionInfo();
  }

  saveLastFreeGatingRefreshAt(now);
  const refreshResult = await refreshJwtSingleFlight();
  if (refreshResult.success) {
    const updatedPayload = decodeJWT(getStoredJWT());
    if ((updatedPayload?.plan || 'free') !== 'free') {
      await clearUpgradePendingState();
    }
  }
  return getSubscriptionInfo();
}

// Call Firebase Callable Function (Gen 2)
async function callFunction(functionName, data, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(`${FUNCTIONS_BASE}/${functionName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
    signal: options.signal
  });

  if (!response.ok) {
    let errorPayload = null;
    try {
      errorPayload = await response.json();
    } catch (_) {
      errorPayload = null;
    }
    const errorMessage = errorPayload?.error || `Function ${functionName} failed: ${response.status}`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.data = errorPayload;
    throw error;
  }

  const result = await response.json();
  return result.result || result;
}

function shouldRetryActionToken(error) {
  const status = Number(error?.status || 0);
  if (status !== 401) return false;
  const message = String(error?.data?.error || error?.message || '').toLowerCase();
  return message.includes('action token');
}

function notifyActionTokenRetry() {
  const toastFn = (typeof window?.ycUtils?.showToast === 'function')
    ? window.ycUtils.showToast
    : (typeof window?.showToast === 'function' ? window.showToast : null);
  if (toastFn) {
    try {
      toastFn('Something went wrong, please try again.', '⚠️');
    } catch (_) {
      // ignore toast failures
    }
  }
}

async function requestActionToken(action, videoId, identifiers, options = {}) {
  const jwt = getStoredJWT();
  if (!jwt) {
    throw new Error('Missing JWT');
  }

  const payload = {
    action,
    videoId,
    deviceId: identifiers?.deviceId || null,
    fingerprint: identifiers?.fingerprint || null
  };

  const response = await fetch(`${FUNCTIONS_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`
    },
    body: JSON.stringify(payload),
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data?.success || !data?.token) {
    throw new Error(data?.error || 'Token request failed');
  }

  return data.token;
}

async function callFunctionWithActionToken(functionName, action, videoId, payload, identifiers, options = {}) {
  try {
    return await callFunction(functionName, payload, { signal: options.signal });
  } catch (error) {
    if (!shouldRetryActionToken(error)) {
      throw error;
    }
  }

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let token = null;
    try {
      token = await requestActionToken(action, videoId, identifiers, { signal: options.signal });
    } catch (error) {
      lastError = error;
    }

    if (!token) {
      if (attempt === 0) {
        notifyActionTokenRetry();
        continue;
      }
      throw lastError || new Error('Failed to obtain action token');
    }

    try {
      return await callFunction(functionName, payload, {
        signal: options.signal,
        headers: {
          'x-yc-token': token
        }
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0 && shouldRetryActionToken(error)) {
        notifyActionTokenRetry();
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Action token validation failed');
}

// Process video via Firebase Function (when not in R2)
async function processVideoViaServer(videoId, durationSeconds = 180, options = {}) {
  const { refreshAttempted = false, skipProAutoRefresh = false, signal = null } = options;
  const isAborted = () => !!signal?.aborted;
  const abortedResult = () => ({ success: false, error: 'Request aborted', aborted: true });
  console.log(`[Auth] Processing video via server: ${videoId}`);
  const tracker = createTimingTracker('processVideoViaServer', { videoId });

  if (isAborted()) return abortedResult();

  if (!skipProAutoRefresh) {
    await maybeRefreshUserJWT();
    tracker.mark('afterMaybeRefreshUserJWT');
  }

  const jwt = getStoredJWT();
  const identifiers = await getIdentifiers();

  if (!jwt) {
    return { success: false, error: 'Not logged in', needsLogin: true };
  }

  try {
    // Build YouTube URL from video ID
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Production: Call Firebase Function
    const callStartedAt = getPerfNow();
    if (isAborted()) return abortedResult();
    const result = await callFunctionWithActionToken('processVideo', 'processVideo', videoId, {
      jwt,
      videoId,
      url: youtubeUrl,
      deviceId: identifiers.deviceId,
      fingerprint: identifiers.fingerprint || null,
      clientExtensionId: getClientExtensionIdForBackend(),
      durationSeconds
    }, identifiers, { signal });
    if (isAborted()) return abortedResult();
    tracker.mark('processVideoCallableReturned', {
      callMs: Math.round(getPerfNow() - callStartedAt),
      success: !!result?.success,
      alreadyProcessing: !!result?.alreadyProcessing,
      queueFull: !!result?.queueFull,
      queueTimeout: !!result?.queueTimeout
    });

    // Update JWT if server returned a new one
    if (result.jwt) {
      storeJWT(result.jwt);
    }

    if (result.blocked) {
      await handleBlockedAccount(result);
      return {
        success: false,
        error: result.error || 'Account blocked',
        blocked: true,
        blockedReason: result.blockedReason || null
      };
    }

    if (result.unsupportedVideo || result.precheckRejected) {
      return {
        success: false,
        error: result.error || 'Only music videos between 15 seconds and 35 minutes are supported',
        unsupportedVideo: true,
        precheckRejected: !!result.precheckRejected,
        hardBlockReason: result.hardBlockReason || null
      };
    }

    if (result.fairUsageExceeded) {
      const message = result.error || 'Your account reached the Pro fair usage limit for this billing cycle.';
      if (window.showProcessingRateLimitModal) {
        window.showProcessingRateLimitModal({
          title: 'Fair usage limit reached',
          message,
          secondaryMessage: '',
          tipText: 'Previously downloaded songs are still available.'
        });
      } else {
        window.ycUtils?.showErrorOverlay?.(message, 6000);
      }
      return { success: false, error: message, fairUsageExceeded: true };
    }

    if (result.needsRelogin) {
      await clearSessionForRelogin();
      return {
        success: false,
        error: result.error || 'Session out of date',
        needsLogin: true,
        needsRelogin: true
      };
    }

    if (result.needsRefresh) {
      if (refreshAttempted) {
        return { success: false, error: 'Session expired', needsLogin: true };
      }
      const refreshResult = await refreshJwtSingleFlight();
      if (!refreshResult.success) {
        return { success: false, error: 'Session expired', needsLogin: true };
      }
      return processVideoViaServer(videoId, durationSeconds, {
        ...options,
        refreshAttempted: true,
        skipProAutoRefresh: true
      });
    }

    console.log('[Auth] Process video result:', result);
    tracker.end('returnProcessVideoResult', {
      success: !!result?.success,
      alreadyProcessing: !!result?.alreadyProcessing
    });
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || isAborted()) return abortedResult();
    console.error('[Auth] Process video error:', error);
    tracker.end('processVideoError', { error: error.message });
    return { success: false, error: error.message };
  }
}


// Sign in with Google using Chrome Identity API
async function signInWithGoogle(consent = null) {
  try {
    const explicitConsentPayload = normalizeConsentPayload(consent, 'popup_signin');
    if (consent && !explicitConsentPayload) {
      return { success: false, error: 'CONSENT_REQUIRED' };
    }
    const storedConsentPayload = explicitConsentPayload ? null : await getStoredConsentLocally('popup_signin_stored');
    const consentPayload = explicitConsentPayload || storedConsentPayload;

    // Step 1: Get OAuth token. Chrome uses getAuthToken; Brave can fall back
    // to a browser web auth flow while keeping the same backend sign-in path.
    const googleToken = await getGoogleOAuthTokenForSignIn();
    if (!googleToken) {
      return {
        success: false,
        error: 'Google sign-in did not return an access token. Please try again.'
      };
    }

    // Step 2: Get local install/session deviceId
    const identifiers = await getIdentifiers();
    const userAgent = navigator.userAgent;

    // Step 3: Call Firebase Function to get/create user + JWT
    const requestPayload = {
      googleToken,
      deviceId: identifiers.deviceId,
      fingerprint: identifiers.fingerprint || null,
      deviceProof: identifiers.deviceProof || null,
      userAgent
    };
    if (consentPayload) {
      requestPayload.consent = consentPayload;
    }

    let result = await callFunction('getUser', requestPayload);

    if (!result.success && result.code === 'VERIFY_REQUIRED') {
      const verification = await requestThumbmarkVisitorId({
        challengeId: typeof result.challengeId === 'string' ? result.challengeId : null
      });
      const verifiedThumbmark = typeof verification?.thumbmark === 'string'
        ? verification.thumbmark.trim().slice(0, 4096)
        : null;
      if (verifiedThumbmark) {
        cachedDeviceFingerprint = verifiedThumbmark;
        await chrome.storage.local.set({ [DEVICE_FINGERPRINT_KEY]: verifiedThumbmark });
      }
      const verifiedDeviceProof = typeof verification?.deviceProof === 'string'
        ? verification.deviceProof.trim()
        : null;
      const verifiedDeviceProofs = Array.isArray(verification?.deviceProofs)
        ? verification.deviceProofs.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
        : [];
      if (verifiedDeviceProof) {
        cachedDeviceProof = verifiedDeviceProof;
        await chrome.storage.local.set({ [DEVICE_PROOF_KEY]: verifiedDeviceProof });
      }
      result = await callFunction('getUser', {
        ...requestPayload,
        visitorId: verification?.visitorId || null,
        thumbmark: verifiedThumbmark,
        deviceProof: verifiedDeviceProof,
        deviceProofs: verifiedDeviceProofs,
        challengeId: verification?.challengeId || result.challengeId || null
      });
    }

    if (!result.success) {
      if (result.code === 'CONSENT_REQUIRED' || result.error === 'CONSENT_REQUIRED') {
        return { success: false, error: 'CONSENT_REQUIRED' };
      }
      throw new Error(result.error || 'Failed to get user');
    }

    // Store JWT and user info
    storeJWT(result.jwt);
    const consentToPersist = consentPayload || {
      accepted: true,
      version: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
      source: 'server_existing_consent'
    };
    await saveConsentLocally(consentToPersist);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));

    return {
      success: true,
      user: result.user
    };
  } catch (error) {
    console.error('Sign in error:', error);
    return { success: false, error: error.message };
  }
}

// Sign out
async function signOutUser() {
  try {
    console.log('[Auth] 🔒 Starting Sign Out...');

    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        console.log('[Auth] 🔍 Current token:', token ? 'EXISTS' : 'NULL');
        resolve(token);
      });
    });

    if (token) {
      console.log('[Auth] 🔄 Revoking token from Google...');
      // Revoke the token
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);

      console.log('[Auth] 🔄 Removing cached token...');
      // Remove from Chrome cache
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      });
    }

    // Note: We DON'T use clearAllCachedAuthTokens() because it affects other extensions!
    // removeCachedAuthToken() above is enough for our extension only

    console.log('[Auth] 🔄 Clearing localStorage...');
    // Clear local storage
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(USER_KEY);

    console.log('[Auth] 🔄 Clearing chrome.storage.local...');
    // Clear chrome.storage.local - this will trigger onChanged event in content scripts
    await chrome.storage.local.remove([JWT_KEY, USER_KEY]);
    console.log('[Auth] Cleared chrome.storage.local - content scripts will be notified');

    // Send message to all YouTube tabs to clear their localStorage
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
      console.log(`[Auth] Sending signOut message to ${tabs.length} YouTube tabs`);

      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { command: 'signOut' });
        } catch (e) {
          // Silently ignore "Receiving end does not exist" errors (tab was closed)
          if (e.message && !e.message.includes('Receiving end does not exist')) {
            console.warn(`[Auth] Failed to send signOut to tab ${tab.id}:`, e);
          }
        }
      }
    } catch (e) {
      console.warn('[Auth] Failed to notify tabs:', e);
    }

    console.log('[Auth] ✅ Sign Out completed successfully');
    return { success: true };
  } catch (error) {
    console.error('[Auth] ❌ Sign out error:', error);
    return { success: false, error: error.message };
  }
}

// Get current user (from local storage, refresh if needed)
async function getCurrentUser() {
  try {
    console.log('[Auth] 🔍 getCurrentUser() called');

    // First check popup's localStorage
    let storedUser = localStorage.getItem(USER_KEY);
    let jwt = getStoredJWT();

    console.log('[Auth] 🔍 Popup localStorage - User:', storedUser ? 'EXISTS' : 'NULL', 'JWT:', jwt ? 'EXISTS' : 'NULL');

    // If not in popup localStorage, check chrome.storage.local (shared with content scripts)
    if (!storedUser || !jwt) {
      console.log('[Auth] 🔍 Checking chrome.storage.local...');
      const chromeStorage = await chrome.storage.local.get([USER_KEY, JWT_KEY]);

      if (chromeStorage[USER_KEY] && chromeStorage[JWT_KEY]) {
        console.log('[Auth] ✅ Found user in chrome.storage.local - syncing to popup');
        storedUser = chromeStorage[USER_KEY];
        jwt = chromeStorage[JWT_KEY];

        // Sync to popup's localStorage
        localStorage.setItem(USER_KEY, storedUser);
        if (isPopupContext()) {
          localStorage.setItem(JWT_KEY, jwt);
        }
      }
    }

    if (storedUser && jwt) {
      console.log('[Auth] ✅ Returning cached user');
      return JSON.parse(storedUser);
    }

    console.log('[Auth] ❌ No cached user - user must sign in manually');
    // DON'T try to auto-refresh! User must click "Sign In" button
    return null;
  } catch (error) {
    console.error('[Auth] ❌ Get user error:', error);
    return null;
  }
}


// Check quota locally from JWT (fast, no server call)
// Returns: { allowed, reason, canAccessCache, plan, shouldDeleteChordsDB, shouldDeleteSubtitlesDB, ... }
// - allowed: true if can download NEW content from server
// - canAccessCache: true if can access IndexedDB
// - shouldDeleteChordsDB: true if ChordsDB should be deleted
// - shouldDeleteSubtitlesDB: true if SubtitlesDB should be deleted
function checkQuotaLocal(type) {
  const payload = getJWTPayload();

  if (!payload) {
    return { allowed: false, canAccessCache: false, reason: 'not_logged_in' };
  }

  const plan = payload.plan || 'free';
  const isPaidPlan = plan !== 'free'; // chords_only, lyrics_only, full_access
  const bonusExpiryDate = payload.bonusExpiryDate;
  const now = Date.now();
  const wasPaidUser = payload.wasPaidUser || false;

  // Check if bonus has expired
  const bonusExpired = bonusExpiryDate && new Date(bonusExpiryDate).getTime() < now;

  // Check if user came from another plan (has bonusExpiryDate means they switched plans)
  const cameFromAnotherPlan = !!bonusExpiryDate;

  // If user was a paid subscriber and now is FREE - delete ChordsDB only
  // SubtitlesDB is NOT deleted because subtitles are free for everyone
  if (plan === 'free' && wasPaidUser) {
    return {
      allowed: false,
      canAccessCache: false,
      shouldDeleteChordsDB: true,
      shouldDeleteSubtitlesDB: false,  // Keep subtitles - they're free!
      reason: 'subscription_ended',
      plan: plan
    };
  }

  if (type === 'chords') {
    const bonusChordsLimit = payload.bonusChordsLimit || 0;
    const bonusChordsUsed = payload.bonusChordsUsed || 0;
    const hasBonus = bonusChordsLimit > 0 && !bonusExpired;
    const bonusRemaining = hasBonus ? Math.max(0, bonusChordsLimit - bonusChordsUsed) : 0;

    // For lyrics_only plan - check chords access
    if (plan === 'lyrics_only') {
      // Case 1: Came from another plan (CHORDS/FULL_ACCESS → LYRICS) AND has bonus chords
      if (cameFromAnotherPlan && bonusChordsLimit > 0) {
        if (bonusExpired) {
          // Bonus expired - no access, delete ChordsDB
          return {
            allowed: false,
            canAccessCache: false,
            shouldDeleteChordsDB: true,
            reason: 'bonus_expired',
            plan: plan
          };
        }
        // Bonus still valid
        return {
          allowed: bonusRemaining > 0, // Can download if bonus remaining
          canAccessCache: true, // Can access IndexedDB while bonus valid
          reason: bonusRemaining > 0 ? null : 'bonus_exhausted',
          plan: plan,
          used: bonusChordsUsed,
          limit: bonusChordsLimit,
          hasBonus: true,
          bonusExpiryDate: bonusExpiryDate
        };
      }
      // Case 2: Came directly from FREE OR came from lyrics_only (no bonus chords)
      else {
        const freeChordLimit = (
          typeof payload.chordsLimit === 'number' &&
          payload.chordsLimit > 0 &&
          payload.chordsLimit <= FREE_ONE_TIME_CHORDS
        ) ? payload.chordsLimit : FREE_ONE_TIME_CHORDS;
        const chordsUsed = payload.chordsUsed || 0;
        if (chordsUsed >= freeChordLimit) {
          // Free chords exhausted - no access, delete ChordsDB
          return {
            allowed: false,
            canAccessCache: false,
            shouldDeleteChordsDB: true,
            reason: 'free_chords_exhausted',
            plan: plan,
            used: chordsUsed,
            limit: freeChordLimit
          };
        }
        // Still has free chords
        return {
          allowed: true,
          canAccessCache: true,
          plan: plan,
          used: chordsUsed,
          limit: freeChordLimit,
          hasBonus: false,
          isFreeChords: true
        };
      }
    }

    // For other plans (free, chords_only, full_access)
    if (payload.chordsQuotaExhausted) {
      // Quota exceeded - check if paid user (can still access cache)
      // Delete IndexedDB for one-time FREE quota users
      const shouldDelete = plan === 'free' || (
        typeof payload.chordsLimit === 'number' &&
        payload.chordsLimit > 0 &&
        payload.chordsLimit <= FREE_ONE_TIME_CHORDS
      );
      return {
        allowed: false,
        canAccessCache: isPaidPlan && !shouldDelete, // Paid users can access IndexedDB only if not deleted
        shouldDeleteChordsDB: shouldDelete, // Delete for FREE and LYRICS_ONLY users
        reason: 'quota_exceeded',
        plan: plan,
        used: payload.chordsUsed,
        limit: payload.chordsLimit,
        resetDate: payload.resetDate,
        hasBonus: hasBonus
      };
    }

    return {
      allowed: true,
      canAccessCache: true,
      plan: plan,
      used: payload.chordsUsed,
      limit: payload.chordsLimit,
      hasBonus: hasBonus
    };
  }

  // NOTE: Lyrics quota check removed - lyrics now come directly from YouTube for free
  // Lyrics are FREE for ALL signed-in users (fetched from YouTube, costs us nothing)
  if (type === 'lyrics') {
    return {
      allowed: true,  // Lyrics are free for everyone!
      canAccessCache: true,
      plan: plan,
      reason: null
    };
  }

  return { allowed: false, canAccessCache: false, reason: 'unknown_type' };
}

function createCreditRequestId(prefix = 'credit') {
  const safePrefix = String(prefix || 'credit')
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 40) || 'credit';
  if (globalThis.crypto?.randomUUID) {
    return `${safePrefix}:${globalThis.crypto.randomUUID()}`;
  }
  if (globalThis.crypto?.getRandomValues) {
    const randomParts = new Uint32Array(2);
    globalThis.crypto.getRandomValues(randomParts);
    const randomSuffix = Array.from(randomParts)
      .map((part) => part.toString(36))
      .join('');
    return `${safePrefix}:${Date.now().toString(36)}:${randomSuffix}`;
  }
  return `${safePrefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

// Get chords from server (with quota check)
async function getChords(videoId, options = {}) {
  const {
    skipCreditCount = false,
    checkOnly = false,
    skipProgressBar = false,
    refreshAttempted = false,
    skipProAutoRefresh = false,
    enqueueIfMissing = false,
    durationSeconds = null,
    creditRequestId = null,
    signal = null,
    allowPaidResultRecovery = false
  } = options;

  const isAborted = () => !!signal?.aborted;
  const abortedResult = () => ({ success: false, error: 'Request aborted', aborted: true });

  if (isAborted()) {
    return abortedResult();
  }

  if (!skipProAutoRefresh) {
    await maybeRefreshUserJWT();
  }

  const jwt = getStoredJWT();
  const identifiers = await getIdentifiers();

  if (!jwt) {
    return { success: false, error: 'Not logged in', needsLogin: true };
  }

  const fetchChordsWithToken = async (payload) => {
    if (isAborted()) return abortedResult();
    const clientExtensionId = getClientExtensionIdForBackend();
    const enrichedPayload = clientExtensionId
      ? { ...payload, clientExtensionId }
      : payload;
    return callFunctionWithActionToken('getChords', 'getChords', payload.videoId, enrichedPayload, identifiers, { signal });
  };
  const effectiveCreditRequestId = creditRequestId ||
    (!skipCreditCount && !checkOnly ? createCreditRequestId('get_chords') : null);

  // For checkOnly mode, just check if file exists in R2 without counting credits
  if (checkOnly) {
    try {
      if (isAborted()) return abortedResult();
      const result = await fetchChordsWithToken({
        jwt,
        videoId,
        deviceId: identifiers.deviceId,
        fingerprint: identifiers.fingerprint || null,
        checkOnly: true
      });
      if (isAborted()) return abortedResult();

      if (result.jwt) {
        storeJWT(result.jwt);
      }

      if (result.blocked) {
        await handleBlockedAccount(result);
        return {
          success: false,
          error: result.error || 'Account blocked',
          blocked: true,
          blockedReason: result.blockedReason || null,
          shouldDeleteChordsDB: true
        };
      }

      if (result.needsRelogin) {
        await clearSessionForRelogin();
        return {
          success: false,
          error: result.error || 'Session out of date',
          needsLogin: true,
          needsRelogin: true
        };
      }

      if (result.needsRefresh) {
        if (refreshAttempted) {
          return { success: false, error: 'Session expired', needsLogin: true };
        }
        const refreshResult = await refreshJwtSingleFlight();
        if (!refreshResult.success) {
          return { success: false, error: 'Session expired', needsLogin: true };
        }
        return getChords(videoId, {
          ...options,
          refreshAttempted: true,
          skipProAutoRefresh: true,
          creditRequestId: effectiveCreditRequestId
        });
      }

      return {
        success: result.success,
        alreadyExists: result.success && result.presignedUrl
      };
    } catch (err) {
      if (err.name === 'AbortError' || isAborted()) return abortedResult();
      return { success: false, error: err.message };
    }
  }

  // Local quota check first (skip if we already counted in processVideo)
  if (!skipCreditCount && !allowPaidResultRecovery) {
    const quotaCheck = checkQuotaLocal('chords');
    if (!quotaCheck.allowed) {
      return {
        success: false,
        error: quotaCheck.reason === 'quota_exceeded' ? 'Chords quota exceeded' : 'Not logged in',
        quotaExhausted: quotaCheck.reason === 'quota_exceeded',
        ...quotaCheck
      };
    }
  }

  try {
    const requestPayload = {
      jwt,
      videoId,
      deviceId: identifiers.deviceId,
      fingerprint: identifiers.fingerprint || null,
      skipCreditCount
    };
    if (effectiveCreditRequestId) {
      requestPayload.creditRequestId = effectiveCreditRequestId;
    }
    if (enqueueIfMissing) {
      const parsedDuration = Number(durationSeconds);
      const fallbackDuration = window.ytPlayer?.getDuration?.() || 180;
      const safeDurationSeconds = Number.isFinite(parsedDuration) && parsedDuration > 0
        ? Math.round(parsedDuration)
        : Math.round(fallbackDuration);
      requestPayload.enqueueIfMissing = true;
      requestPayload.durationSeconds = Math.max(1, safeDurationSeconds);
    }

    if (isAborted()) return abortedResult();
    const result = await fetchChordsWithToken(requestPayload);
    if (isAborted()) return abortedResult();

    // Update JWT if server returned a new one
    if (result.jwt) {
      storeJWT(result.jwt);
    }

    if (result.blocked) {
      await handleBlockedAccount(result);
      return {
        success: false,
        error: result.error || 'Account blocked',
        blocked: true,
        blockedReason: result.blockedReason || null,
        shouldDeleteChordsDB: true
      };
    }

    if (result.needsRelogin) {
      await clearSessionForRelogin();
      return {
        success: false,
        error: result.error || 'Session out of date',
        needsLogin: true,
        needsRelogin: true
      };
    }

    // Handle quota exhausted from server (JWT was outdated)
    if (result.quotaExhausted) {
      console.log('[Auth] Server returned quotaExhausted - updating local state');
      return {
        success: false,
        error: 'Chords quota exceeded',
        quotaExhausted: true,
        shouldDeleteChordsDB: true,
        reason: 'quota_exceeded'
      };
    }

    if (result.fairUsageExceeded) {
      const message = result.error || 'Your account reached the Pro fair usage limit for this billing cycle.';
      if (window.showProcessingRateLimitModal) {
        window.showProcessingRateLimitModal({
          title: 'Fair usage limit reached',
          message,
          secondaryMessage: '',
          tipText: 'Previously downloaded songs are still available.'
        });
      } else {
        window.ycUtils?.showErrorOverlay?.(message, 6000);
      }
      return { success: false, error: message, fairUsageExceeded: true };
    }

    // Handle rate limiting returned before the notInCache branch. This can be
    // either processing throttling or cached R2 download throttling.
    if (result.rateLimited) {
      console.log('[Auth] Rate limited:', result.error, result.limitKind || 'unknown');
      const limitKind = String(result.limitKind || '').toLowerCase();
      const currentPayload = getJWTPayload();
      const isPaid = currentPayload?.plan && currentPayload.plan !== 'free';

      if (limitKind === 'processing') {
        if (isPaid) {
          if (window.showProcessingRateLimitModal) {
            window.showProcessingRateLimitModal({
              message: result.error || 'Processing limit reached.',
              secondaryMessage: 'Please wait a bit before processing another song.'
            });
          } else {
            window.ycUtils?.showErrorOverlay?.(result.error || '⏱️ Processing limit reached. Please wait.', 5000);
          }
        } else if (window.showRateLimitModal) {
          window.showRateLimitModal({
            message: result.error || 'Free users can process up to 3 songs per minute.',
            secondaryMessage: 'Please wait a bit and try again.'
          });
        } else {
          window.ycUtils?.showErrorOverlay?.(result.error || '⏱️ Rate limit: 3 songs per minute. Please wait.', 5000);
        }
      } else if (result.error && result.error.includes('1,500')) {
        if (window.showSubscriptionLimitModal) {
          window.showSubscriptionLimitModal();
        }
      } else {
        if (window.showDownloadRateLimitModal) {
          window.showDownloadRateLimitModal({
            message: result.error || 'Download rate limit reached.',
            secondaryMessage: 'Please wait a bit before downloading more songs.'
          });
        }
      }
      return { success: false, error: result.error, rateLimited: true };
    }

    // Handle token refresh needed
    if (result.needsRefresh) {
      if (refreshAttempted) {
        return { success: false, error: 'Session expired', needsLogin: true };
      }
      const refreshResult = await refreshJwtSingleFlight();
      if (!refreshResult.success) {
        return { success: false, error: 'Session expired', needsLogin: true };
      }
      return getChords(videoId, {
        ...options,
        refreshAttempted: true,
        skipProAutoRefresh: true,
        creditRequestId: effectiveCreditRequestId
      });
    }

    // If server returned presigned URL, fetch the data from R2
    if (result.success && result.presignedUrl) {
      try {
        // Progress bar כבר נוצר ב-chordsDisplay.js
        // NOTE: Lyrics now come directly from YouTube - no need to wait for server processing

        // Fetch basic chords (for all users)
        const r2Response = await fetch(result.presignedUrl, { signal });
        if (!r2Response.ok) {
          throw new Error(`R2 fetch failed: ${r2Response.status}`);
        }
        // הדפדפן פותח gzip אוטומטית בזכות Content-Encoding header
        const basicChordsData = await r2Response.json();

        // All data (basic + premium) comes in one file for Pro users
        let chordsData = { ...basicChordsData };

        try {
          await window.__ycMaybeShowFreeCreditsLowModal?.({
            source: skipCreditCount ? 'post_process_chords_fetch' : 'r2_chords_fetch'
          });
        } catch (lowCreditModalError) {
          console.warn('[Auth] Failed to show free credits low modal:', lowCreditModalError);
        }

        // Check if this was the last credit (quota now exhausted)
        // Delete IndexedDB for one-time FREE quota users
        const newPayload = getJWTPayload();
        const shouldDeleteAfter = !!newPayload?.chordsQuotaExhausted && (
          newPayload?.plan === 'free' ||
          (
            typeof newPayload?.chordsLimit === 'number' &&
            newPayload.chordsLimit > 0 &&
            newPayload.chordsLimit <= FREE_ONE_TIME_CHORDS
          )
        );

        return {
          success: true,
          chordsData,
          jwt: result.jwt,
          shouldDeleteChordsDBAfter: shouldDeleteAfter  // Delete IndexedDB AFTER displaying chords
        };
      } catch (r2Error) {
        if (r2Error.name === 'AbortError' || isAborted()) return abortedResult();
        console.error('R2 fetch error:', r2Error);
        return { success: false, error: 'Failed to download chords data' };
      }
    }

    // 🆕 FALLBACK: If not in R2 (notInCache), try server processing
    if (result.notInCache) {
      console.log('[Auth] Chords not in R2, requesting server processing...');
      const flowTracker = createTimingTracker('chordsDockerFlow', { videoId });
      flowTracker.mark('enteredNotInCache');

      // Get video duration (default 3 minutes if unknown)
      const durationSeconds = window.ytPlayer?.getDuration?.() || 180;
      const durationMinutes = durationSeconds / 60;

      // 🎯 Progress bar כבר נוצר ב-chordsDisplay.js - רק מחליפים למצב Docker
      if (window.extractorModule?.switchToDockerMode) {
        window.extractorModule.switchToDockerMode('chords', durationMinutes);
      }

      const inlineQueueResult = !!(
        result.enqueuedByGetChords ||
        result.alreadyProcessing ||
        result.queueFull ||
        result.queueTimeout ||
        result.tempUnavailable ||
        result.insufficientCredits ||
        result.rateLimited ||
        result.blocked ||
        result.unsupportedVideo ||
        result.precheckRejected ||
        result.fairUsageExceeded
      );

      let processResult = result;
      if (inlineQueueResult) {
        flowTracker.mark('processAlreadyHandledByGetChords', {
          enqueuedByGetChords: !!result.enqueuedByGetChords,
          alreadyProcessing: !!result.alreadyProcessing,
          queueFull: !!result.queueFull,
          queueTimeout: !!result.queueTimeout,
          unsupportedVideo: !!result.unsupportedVideo,
          precheckRejected: !!result.precheckRejected,
          fairUsageExceeded: !!result.fairUsageExceeded
        });
      } else {
        flowTracker.end('missingQueueStateFromGetChords', {
          error: 'Queue state missing from getChords response'
        });
        return {
          success: false,
          error: 'Server response was incomplete. Please try again.',
          queueTimeout: true,
          retryAfterSec: 10
        };
      }

      console.log('[Auth] processResult:', JSON.stringify(processResult));

      if (processResult.blocked) {
        return {
          success: false,
          error: processResult.error || 'Account blocked',
          blocked: true,
          blockedReason: processResult.blockedReason || null,
          shouldDeleteChordsDB: true
        };
      }

      if (processResult.unsupportedVideo || processResult.precheckRejected) {
        return {
          success: false,
          error: processResult.error || 'Only music videos between 15 seconds and 35 minutes are supported',
          unsupportedVideo: true,
          precheckRejected: !!processResult.precheckRejected,
          hardBlockReason: processResult.hardBlockReason || null
        };
      }

      if (processResult.fairUsageExceeded) {
        const message = processResult.error || 'Your account reached the Pro fair usage limit for this billing cycle.';
        if (window.showProcessingRateLimitModal) {
          window.showProcessingRateLimitModal({
            title: 'Fair usage limit reached',
            message,
            secondaryMessage: '',
            tipText: 'Previously downloaded songs are still available.'
          });
        } else {
          window.ycUtils?.showErrorOverlay?.(message, 6000);
        }
        return { success: false, error: message, fairUsageExceeded: true };
      }

      // Handle rate limiting FIRST (before other checks)
      if (processResult.rateLimited) {
        console.log('[Auth] 🚫 Rate limited:', processResult.error);
        const currentPayload = getJWTPayload();
        const isPaid = currentPayload?.plan && currentPayload.plan !== 'free';
        if (isPaid) {
          if (window.showProcessingRateLimitModal) {
            window.showProcessingRateLimitModal({
              message: processResult.error || 'Processing limit reached.',
              secondaryMessage: 'Please wait a bit before processing another song.'
            });
          } else {
            console.log('[Auth] showProcessingRateLimitModal not found!');
            window.ycUtils?.showErrorOverlay?.(processResult.error || '⏱️ Processing limit reached. Please wait.', 5000);
          }
        } else {
          if (window.showRateLimitModal) {
            window.showRateLimitModal({
              message: processResult.error || 'Free users can process up to 3 songs per minute.',
              secondaryMessage: 'Please wait a bit and try again.'
            });
          } else {
            window.ycUtils?.showErrorOverlay?.(processResult.error || '⏱️ Rate limit: 3 songs per minute. Please wait.', 5000);
          }
        }
        return { success: false, error: processResult.error, rateLimited: true };
      }

      // Handle queue pressure from Docker/API server
      if (processResult.queueFull || processResult.queueTimeout) {
        const retryAfterSec = processResult.retryAfterSec || 8;
        const recommendedWaitSec = Math.max(30, retryAfterSec);
        const queueMsg = processResult.queueFull
          ? `Server queue is full. Please retry shortly (up to ~${recommendedWaitSec}s during peak load).`
          : `Server is busy. Please retry shortly (up to ~${recommendedWaitSec}s during peak load).`;
        if (window.showQueuePressureModal) {
          window.showQueuePressureModal({
            mode: processResult.queueFull ? 'full' : 'busy',
            retryAfterSec: recommendedWaitSec
          });
        } else {
          window.ycUtils?.showErrorOverlay?.(queueMsg, 5000);
        }
        return {
          success: false,
          error: processResult.error || queueMsg,
          queueFull: !!processResult.queueFull,
          queueTimeout: !!processResult.queueTimeout,
          retryAfterSec
        };
      }

      if (processResult.tempUnavailable) {
        const tempMsg = 'We couldn’t process this song right now. Please try again shortly.';
        if (window.showQueuePressureModal) {
          window.showQueuePressureModal({ mode: 'temporary' });
        } else {
          window.ycUtils?.showErrorOverlay?.(tempMsg, 5000);
        }
        return { success: false, error: tempMsg, tempUnavailable: true, processingFailed: true };
      }

      if (processResult.success && processResult.chordsReady) {
        // Chords were processed and uploaded to R2, now fetch them
        console.log('[Auth] ✅ Chords processed successfully, fetching from R2...');
        flowTracker.mark('processReportedDoneFetchFromR2');

        // Retry getChords - now it should be in R2
        // Skip credit count because we already counted in processVideo
        // Skip progress bar because Docker progress bar is already showing
        const postProcessResult = await getChords(videoId, { skipCreditCount: true, skipProgressBar: true });
        flowTracker.end('postProcessGetChordsReturned', {
          success: !!postProcessResult?.success
        });
        return postProcessResult;
      }

      // Handle specific errors
      if (processResult.insufficientCredits) {
        return {
          success: false,
          error: processResult.error,
          insufficientCredits: true,
          needsUpgrade: true
        };
      }

      if (processResult.alreadyProcessing) {
        window.extractorModule?.setChordsQueueHint?.('queued');
        // Video is being processed by another user - wait for it
        console.log('[Auth] Video is being processed, waiting for completion...');
        flowTracker.mark('alreadyProcessingWaitForListener');

        // If we just queued this request ourselves, an immediate checkOnly call is usually redundant.
        const shouldSkipInitialR2Check = !!processResult.queued;
        if (shouldSkipInitialR2Check) {
          flowTracker.mark('skipInitialCheckOnlyForQueued');
        } else {
          // First check if content is already in R2 (processing might have finished).
          console.log('[Auth] Checking if chords already exist in R2...');
          const r2Check = await getChords(videoId, { checkOnly: true, skipProAutoRefresh: true });
          if (r2Check.success && r2Check.alreadyExists) {
            console.log('[Auth] ✅ Chords already in R2! Fetching...');
            window.extractorModule?.setChordsQueueHint?.(null);
            flowTracker.mark('checkOnlyHitR2Immediate');
            const immediateFetch = await getChords(videoId, {
              skipCreditCount: true,
              skipProgressBar: true,
              skipProAutoRefresh: true
            });
            flowTracker.end('immediateFetchReturned', {
              success: !!immediateFetch?.success
            });
            return immediateFetch;
          }
        }

        return new Promise((resolve) => {
          const videoIdToWatch = processResult.videoId || videoId;

          if (window.firestoreListener?.listenToProcessingStatus) {
            const cleanup = window.firestoreListener.listenToProcessingStatus(
              videoIdToWatch,
              async (status, data) => {
                console.log('[Auth] Processing status update:', status, data);

                if (status === 'queued') {
                  window.extractorModule?.setChordsQueueHint?.('queued');
                  flowTracker.mark('listenerQueued');
                } else if (status === 'processing') {
                  window.extractorModule?.setChordsQueueHint?.('processing');
                  flowTracker.mark('listenerProcessing');
                } else if (status === 'done') {
                  cleanup();
                  window.extractorModule?.setChordsQueueHint?.(null);
                  flowTracker.mark('listenerDone');

                  if (data?.chordsReady) {
                    // Chords are ready - fetch them
                    console.log('[Auth] ✅ Processing complete, fetching chords...');
                    const chordsResult = await getChords(videoId, {
                      skipProAutoRefresh: true,
                      allowPaidResultRecovery
                    });
                    flowTracker.end('listenerDoneFetchReturned', {
                      success: !!chordsResult?.success
                    });
                    resolve(chordsResult);
                  } else {
                    // Chords not ready - need to process ourselves
                    console.log('[Auth] Processing done but chords not ready, retrying...');
                    const retryResult = await getChords(videoId, {
                      skipProAutoRefresh: true,
                      allowPaidResultRecovery
                    });
                    flowTracker.end('listenerDoneRetryReturned', {
                      success: !!retryResult?.success
                    });
                    resolve(retryResult);
                  }
                } else if (status === 'failed') {
                  const failureMessage = data?.error || 'Processing failed';
                  const isAlreadyProcessingRace = /already being processed/i.test(failureMessage);
                  const isDockerRateLimited = /rate exceeded|rate limit|too many requests/i.test(failureMessage);

                  // Defensive handling for transient race conditions where another worker
                  // finishes successfully but a stale "failed" update arrives first.
                  if (isAlreadyProcessingRace) {
                    console.warn('[Auth] Received transient failed status, rechecking R2 before failing...');
                    window.extractorModule?.setChordsQueueHint?.('processing');

                    for (let attempt = 0; attempt < 3; attempt++) {
                      const raceR2Check = await getChords(videoId, { checkOnly: true, skipProAutoRefresh: true });
                      if (raceR2Check.success && raceR2Check.alreadyExists) {
                        cleanup();
                        window.extractorModule?.setChordsQueueHint?.(null);
                        console.log('[Auth] ✅ Chords became available after transient failed status');
                        const chordsResult = await getChords(videoId, {
                          skipCreditCount: true,
                          skipProgressBar: true,
                          skipProAutoRefresh: true
                        });
                        flowTracker.end('transientFailedRecovered', {
                          success: !!chordsResult?.success
                        });
                        resolve(chordsResult);
                        return;
                      }

                      if (attempt < 2) {
                        await new Promise((r) => setTimeout(r, 1500));
                      }
                    }

                    cleanup();
                    window.extractorModule?.setChordsQueueHint?.(null);
                    resolve({
                      success: false,
                      error: 'Processing is still finalizing. Please try again shortly.',
                      processingFailed: true
                    });
                    flowTracker.end('transientFailedNoRecovery');
                    return;
                  }

                  if (isDockerRateLimited) {
                    cleanup();
                    window.extractorModule?.setChordsQueueHint?.(null);
                    const retryAfterSec = 30;
                    const queueMsg = 'Server is busy right now. Please try again shortly.';
                    if (window.showQueuePressureModal) {
                      window.showQueuePressureModal({ mode: 'busy', retryAfterSec });
                    } else {
                      window.ycUtils?.showErrorOverlay?.(queueMsg, 5000);
                    }
                    flowTracker.end('listenerFailedRateLimited', { error: failureMessage });
                    resolve({
                      success: false,
                      error: queueMsg,
                      queueTimeout: true,
                      retryAfterSec
                    });
                    return;
                  }

                  cleanup();
                  window.extractorModule?.setChordsQueueHint?.(null);
                  flowTracker.end('listenerFailed', { error: failureMessage });
                  resolve({ success: false, error: failureMessage, processingFailed: true });
                } else if (status === 'failed_temp') {
                  cleanup();
                  window.extractorModule?.setChordsQueueHint?.(null);
                  flowTracker.end('listenerFailedTemp');
                  resolve({
                    success: false,
                    error: 'We couldn’t process this song right now. Please try again shortly.',
                    tempUnavailable: true,
                    processingFailed: true
                  });
                } else if (status === 'timeout') {
                  cleanup();
                  window.extractorModule?.setChordsQueueHint?.(null);
                  flowTracker.end('listenerTimeout');
                  resolve({ success: false, error: 'Processing timeout, please try again', processingFailed: true });
                }
                // Note: listener keeps waiting if document not found yet
              }
            );
          } else {
            window.extractorModule?.setChordsQueueHint?.(null);
            flowTracker.end('listenerUnavailable');
            resolve({ success: false, error: 'Song is being processed, please wait...', alreadyProcessing: true });
          }
        });
      }

      window.extractorModule?.setChordsQueueHint?.(null);
      console.log('[Auth] Server processing failed:', processResult.error);
      flowTracker.end('processingFailedBeforeReady', { error: processResult.error || 'Processing failed' });
      return { success: false, notInCache: true, error: processResult.error || 'Processing failed' };
    }

    return result;
  } catch (error) {
    if (error.name === 'AbortError' || isAborted()) return abortedResult();
    console.error('Get chords error:', error);
    return { success: false, error: error.message };
  }
}

// NOTE: getLyrics was removed - lyrics now come directly from YouTube via youtubeSubtitles.js
// NOTE: fetchPremiumData was removed - all data now comes in one file for Pro users

// Get subscription info from JWT
// NOTE: Lyrics credits removed - lyrics now come directly from YouTube for free
function getSubscriptionInfo() {
  const payload = getJWTPayload();
  if (!payload && !cachedAccountBlockedState?.blocked) return null;

  const blocked = !!(payload?.blocked || cachedAccountBlockedState?.blocked);
  const blockedReason = payload?.blockedReason || cachedAccountBlockedState?.reason || null;

  return {
    plan: payload?.plan || 'free',
    chordsUsed: payload?.chordsUsed || 0,
    chordsLimit: payload?.chordsLimit || FREE_ONE_TIME_CHORDS,
    chordsQuotaExhausted: payload?.chordsQuotaExhausted || false,
    resetDate: payload?.resetDate || null,
    renewalAt: payload?.renewalAt || null,
    // Processing credits (what actually costs money) - only chords now
    processingChordsUsed: payload?.processingChordsUsed || 0,
    processingChordsLimit: payload?.processingChordsLimit || 0,
    // Bonus credits - only chords now
    bonusChordsUsed: payload?.bonusChordsUsed || 0,
    bonusChordsLimit: payload?.bonusChordsLimit || 0,
    bonusExpiryDate: payload?.bonusExpiryDate || null,
    restrictedUntil: payload?.restrictedUntil || null,
    cancelPending: payload?.cancelPending || false,
    blocked,
    blockedReason,
    deletionPending: payload?.deletionPending || false
  };
}

// Export for ES modules
export {
  signInWithGoogle,
  signOutUser,
  getCurrentUser,
  checkQuotaLocal,
  getChords,
  getSubscriptionInfo,
  getJWTPayload,
  processVideoViaServer,
  ensureFreshSubscriptionForGating
};

// Listen for storage changes (sign out from popup OR JWT refresh from Silent Sync)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[ACCOUNT_BLOCKED_STATE_KEY]) {
    const blockedState = changes[ACCOUNT_BLOCKED_STATE_KEY].newValue;
    if (blockedState?.blocked) {
      cachedAccountBlockedState = blockedState;
      if (isPopupContext()) {
        localStorage.setItem(ACCOUNT_BLOCKED_STATE_KEY, JSON.stringify(blockedState));
      }
    } else {
      cachedAccountBlockedState = null;
      if (isPopupContext()) {
        localStorage.removeItem(ACCOUNT_BLOCKED_STATE_KEY);
      }
    }
  }

  if (areaName === 'local' && changes[JWT_KEY]) {
    const newValue = changes[JWT_KEY].newValue;
    const oldValue = changes[JWT_KEY].oldValue;

    // JWT was removed (sign out - NOT account deletion!)
    if (!newValue) {
      console.log('[Auth] JWT removed from chrome.storage - clearing local cache (keeping IndexedDB)');
      cachedJWT = null;
      if (isPopupContext()) {
        localStorage.removeItem(JWT_KEY);
      }
      localStorage.removeItem(USER_KEY);

      // Dispatch custom event for UI components to react
      // NOTE: ycAuthSignedOut (not ycAuthSignOut) - doesn't delete IndexedDB!
      window.dispatchEvent(new CustomEvent('ycAuthSignedOut'));
    }
    // JWT was updated (Silent Sync after payment/plan change)
    else if (newValue !== oldValue) {
      console.log('[Auth] JWT updated from chrome.storage - refreshing local cache');
      cachedJWT = newValue;
      if (isPopupContext()) {
        localStorage.setItem(JWT_KEY, newValue);
      }

      // 🔒 Check for downgrade from Pro
      checkForProDowngrade(oldValue, newValue);

      // Dispatch custom event for UI components to react
      window.dispatchEvent(new CustomEvent('ycAuthUpdated', { detail: { jwt: newValue } }));
    }
  }
});

// 🔒 Storage key for previous plan (for downgrade detection)
const PREVIOUS_PLAN_KEY = 'youchords_previous_plan';

/**
 * 🔒 Check if user downgraded from Pro and clean premium data
 * Deletes local Chords DB on Pro → non-Pro transition
 */
async function checkForProDowngrade(oldJwt, newJwt) {
  console.log('[Auth] 🔍 checkForProDowngrade called');
  try {
    // Get previous plan from localStorage, chrome.storage.local (backup), or old JWT
    let previousPlan = localStorage.getItem(PREVIOUS_PLAN_KEY);

    // Fallback: check chrome.storage.local (survives browsing data clearing)
    if (!previousPlan) {
      try {
        const stored = await chrome.storage.local.get([PREVIOUS_PLAN_KEY]);
        previousPlan = stored[PREVIOUS_PLAN_KEY] || null;
      } catch (e) { /* ignore */ }
    }

    if (oldJwt && !previousPlan) {
      try {
        const oldPayload = JSON.parse(atob(oldJwt.split('.')[1]));
        previousPlan = oldPayload.plan;
      } catch (e) {
        console.warn('[Auth] Could not parse old JWT');
      }
    }

    // Get current plan from new JWT
    let currentPlan = null;
    if (newJwt) {
      try {
        const newPayload = JSON.parse(atob(newJwt.split('.')[1]));
        currentPlan = newPayload.plan;
      } catch (e) {
        console.warn('[Auth] Could not parse new JWT');
        return;
      }
    }

    console.log('[Auth] 🔍 Plan transition:', previousPlan, '→', currentPlan);

    // Save current plan for next comparison (both localStorage and chrome.storage.local)
    if (currentPlan) {
      localStorage.setItem(PREVIOUS_PLAN_KEY, currentPlan);
      chrome.storage.local.set({ [PREVIOUS_PLAN_KEY]: currentPlan }).catch(() => { });
    }

    // Check for downgrade from Pro
    if (previousPlan === 'pro' && currentPlan !== 'pro') {
      console.log(`[Auth] 🔒 Detected downgrade from Pro to ${currentPlan}`);

      // 🔒 Set pending cleanup flag (in case browser closes during cleanup)
      localStorage.setItem('yc_pending_cleanup', 'true');

      // Delete Chords DB entirely on Pro -> non-Pro transition
      if (window.databaseManager?.deleteChordsDatabase) {
        try {
          const result = await window.databaseManager.deleteChordsDatabase();
          console.log('[Auth] 🗑️ Chords DB cleanup on downgrade result:', result);

          // 🔒 Cleanup successful - remove flag
          if (result.success) {
            localStorage.removeItem('yc_pending_cleanup');
            console.log('[Auth] 🔒 ✅ Chords DB deleted and cleanup flag removed');
          }
        } catch (error) {
          console.error('[Auth] 🔒 ❌ Chords DB cleanup failed:', error);
        }
      } else {
        console.warn('[Auth] 🔒 databaseManager.deleteChordsDatabase not available');
      }

      // Reset capo state (if active)
      if (window.CapoIcon?.cleanup) {
        window.CapoIcon.cleanup();
      }

      // Reset chords mode to Regular
      if (window.chordsMode && window.chordsMode !== 'regular') {
        window.chordsMode = 'regular';
        chrome.storage.sync.set({ chordsMode: 'regular' });
        console.log('[Auth] 🔒 Reset chords mode to Regular');
      }
    }
  } catch (error) {
    console.error('[Auth] 🔒 Error checking for downgrade:', error);
  }
}

// Listen for ycAuthSignOut event (from content.js when account is deleted)
window.addEventListener('ycAuthSignOut', () => {
  console.log('[Auth] ycAuthSignOut event received - clearing cache');
  clearAuthCache();
});

// Expose to window for content scripts
window.ycAuth = {
  signInWithGoogle,
  signOutUser,
  getCurrentUser,
  checkQuotaLocal,
  getChords,
  getSubscriptionInfo,
  getJWTPayload,
  initAuthCache: startAuthCacheInit,
  waitForAuthCache: () => authCacheReadyPromise || initialAuthCachePromise || Promise.resolve(),
  clearAuthCache,
  checkForProDowngrade,  // Expose for content.js downgrade detection
  ensureFreshSubscriptionForGating
};
