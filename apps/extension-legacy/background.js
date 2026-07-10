import './utils/productionConsole.js';
import { THUMBMARK_VERIFY_URL, THUMBMARK_RESULT_PREFIX, requestThumbmarkVisitorId } from './utils/thumbmarkHelpers.js';

// YouChords Background Service Worker
// Handles external messages from the website
const CONSENT_VERSION = '2026-02-17';
const CONSENT_STORAGE_KEY = 'youchords_consent';
const API_BASE_URL = 'http://127.0.0.1:8765';
const DEVICE_FINGERPRINT_KEY = 'youchords_device_fingerprint';
const DEVICE_PROOF_KEY = 'youchords_device_proof';
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];
const GOOGLE_WEB_AUTH_CLIENT_IDS = {
  replace_with_your_extension_id: 'REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID',
  eamgkgealnjeebajllideljofihjmonp: 'REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID'
};

async function configureSessionStorageAccess() {
  if (!chrome.storage?.session?.setAccessLevel) return;
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    });
  } catch (error) {
    // Best-effort only. Content-side diagnostics can report storage access failures.
  }
}

configureSessionStorageAccess();

// Open the onboarding tutorial only on first install, not on update.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.storage.local.set({ youchords_first_install_at: Date.now() }).catch(() => { });
  chrome.tabs.create({
    url: 'https://www.youtube.com/watch?v=H5JIpZPSmfU'
  });
});

function normalizeConsentPayload(consent, fallbackSource = 'youtube_signin') {
  if (!consent || consent.accepted !== true) return null;
  if (typeof consent.version !== 'string' || consent.version.trim() !== CONSENT_VERSION) return null;

  const acceptedAt = new Date(consent.acceptedAt || Date.now());
  if (Number.isNaN(acceptedAt.getTime())) return null;

  const source = typeof consent.source === 'string' && consent.source.trim()
    ? consent.source.trim()
    : fallbackSource;

  return {
    accepted: true,
    version: CONSENT_VERSION,
    acceptedAt: acceptedAt.toISOString(),
    source
  };
}

async function getStoredConsentPayload(fallbackSource = 'stored_consent') {
  try {
    const result = await chrome.storage.local.get([CONSENT_STORAGE_KEY]);
    return normalizeConsentPayload(result?.[CONSENT_STORAGE_KEY], fallbackSource);
  } catch (error) {
    console.warn('[Background] Failed to read stored consent:', error);
    return null;
  }
}

async function ensureLocalDeviceId(existing = null) {
  const data = existing || await chrome.storage.local.get(['youchords_device_id']);
  if (data.youchords_device_id) return data.youchords_device_id;

  const deviceId = 'did_' + crypto.randomUUID();
  await chrome.storage.local.set({ youchords_device_id: deviceId });
  return deviceId;
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
      console.warn('[Background] Browser web sign-in failed, trying Chrome identity fallback:', webFlowError);
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
    console.warn('[Background] Chrome identity sign-in failed, trying web auth fallback:', identityError);
    return launchGoogleWebAuthFlow();
  }
}


/**
 * Shared helper: Refresh JWT from server for current user.
 * Reads current JWT from chrome.storage, calls refreshJWT endpoint with Bearer auth,
 * and saves the new JWT back to chrome.storage.
 * @returns {Promise<{success: boolean, error?: string, planName?: string, retryAfterSec?: number, needsRelogin?: boolean, blocked?: boolean}>}
 */
async function refreshJwtForUser() {
  const result = await chrome.storage.local.get(['youchords_jwt', 'youchords_device_id', DEVICE_FINGERPRINT_KEY]);
  const currentJwt = result.youchords_jwt;
  const deviceId = result.youchords_device_id || await ensureLocalDeviceId(result);
  const fingerprint = typeof result[DEVICE_FINGERPRINT_KEY] === 'string' && result[DEVICE_FINGERPRINT_KEY].trim()
    ? result[DEVICE_FINGERPRINT_KEY].trim()
    : null;

  if (!currentJwt) {
    console.log('[Background] No current JWT found');
    return { success: false, error: 'No JWT found' };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/refreshJWT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentJwt}`
      },
      body: JSON.stringify({ deviceId, fingerprint })
    });

    if (!response.ok) {
      let errorData = null;
      try {
        errorData = await response.json();
      } catch (_) {
        errorData = null;
      }

      const retryAfterHeader = Number(response.headers.get('Retry-After'));
      const retryAfterBody = Number(errorData?.retryAfterSec);
      const retryAfterSec = Number.isFinite(retryAfterBody) && retryAfterBody > 0
        ? Math.max(1, Math.round(retryAfterBody))
        : (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? Math.max(1, Math.round(retryAfterHeader))
          : undefined);

      if (errorData?.needsRelogin || response.status === 401) {
        return {
          success: false,
          error: 'Session expired. Please sign in again.',
          needsRelogin: true
        };
      }

      if (errorData?.blocked || response.status === 403) {
        return {
          success: false,
          error: errorData?.error || 'Account access is restricted.',
          blocked: true
        };
      }

      if (errorData?.rateLimited || response.status === 429) {
        return {
          success: false,
          error: retryAfterSec
            ? `Too many refresh attempts. Please try again in ${retryAfterSec}s.`
            : 'Too many refresh attempts. Please wait and try again.',
          retryAfterSec
        };
      }

      const serverMessage = typeof errorData?.error === 'string' && errorData.error.trim()
        ? errorData.error.trim()
        : `Server error (${response.status})`;
      console.error('[Background] Server error:', response.status, serverMessage);
      return { success: false, error: serverMessage };
    }

    const data = await response.json();
    if (!data.jwt) {
      console.error('[Background] No JWT in response');
      return { success: false, error: 'No JWT in response' };
    }

    // Save new JWT to chrome.storage (triggers onChanged for all tabs)
    await chrome.storage.local.set({ youchords_jwt: data.jwt });

    // Decode new JWT to get plan name
    const newPayload = JSON.parse(atob(data.jwt.split('.')[1]));
    const planName = newPayload.plan || 'Premium';

    console.log('[Background] JWT refreshed and saved, plan:', planName);
    return { success: true, planName: planName.replace('_', ' ') };
  } catch (error) {
    console.error('[Background] Error refreshing JWT:', error);
    return { success: false, error: error.message };
  }
}

function getAllowedExternalOrigins() {
  return [
    'https://you-chords.com',
    'https://www.you-chords.com'
  ];
}

function isAllowedExternalOrigin(origin) {
  if (!origin) return false;
  return getAllowedExternalOrigins().some(allowed => origin === allowed);
}

function isAllowedSessionBridgeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;

  try {
    const parsed = new URL(url);
    if (!isAllowedExternalOrigin(parsed.origin)) return false;

    const parts = parsed.pathname.split('/').filter(Boolean);
    const directPage = parts[0] || '';
    const localizedPage = parts[1] || '';
    const allowedPages = new Set(['upgrade', 'account', 'checkout', 'support-tickets']);
    return allowedPages.has(directPage) || allowedPages.has(localizedPage);
  } catch (_) {
    return false;
  }
}

// Listen for messages from external websites (you-chords.com)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[Background] External message received:', message, 'from:', sender.origin);

  // Verify the sender is from our website
  if (!isAllowedExternalOrigin(sender.origin)) {
    console.warn('[Background] Message from unauthorized origin:', sender.origin);
    sendResponse({ success: false, error: 'Unauthorized origin' });
    return;
  }

  if (message.action === 'getSessionJWT') {
    if (!isAllowedSessionBridgeUrl(sender.url)) {
      sendResponse({ success: false, error: 'Session bridge unavailable for this page' });
      return false;
    }

    chrome.storage.local.get(['youchords_jwt'])
      .then((result) => {
        const jwt = typeof result?.youchords_jwt === 'string'
          ? result.youchords_jwt
          : null;
        sendResponse({ success: true, jwt });
      })
      .catch((error) => {
        console.warn('[Background] Failed reading session JWT for website bridge:', error);
        sendResponse({ success: false, error: 'Could not read session' });
      });
    return true;
  }

  // Handle subscription refresh (from Success page after payment)
  if (message.action === 'refreshSubscription') {
    console.log('[Background] Refresh subscription request from website');

    refreshJwtForUser().then(result => {
      sendResponse(result);
    });

    return true; // Keep channel open for async response
  }

  // Handle request from website to open extension popup and highlight Upgrade button.
  if (message.action === 'openUpgradePopup') {
    console.log('[Background] Open upgrade popup request from website');

    chrome.storage.local.set({ highlightUpgradeButton: true })
      .then(() => {
        return chrome.action.openPopup()
          .then(() => {
            sendResponse({ success: true });
          })
          .catch((error) => {
            console.warn('[Background] openPopup failed for external request, using fallback tab:', error);
            chrome.tabs.create({
              url: chrome.runtime.getURL('popup.html'),
              active: true
            }, (tab) => {
              sendResponse({
                success: true,
                fallback: true,
                tabId: tab?.id || null
              });
            });
          });
      })
      .catch((error) => {
        console.error('[Background] Failed preparing upgrade popup highlight:', error);
        sendResponse({ success: false, error: 'Failed to open extension popup' });
      });

    return true; // Keep channel open for async response
  }

  // Handle request from website to open extension popup and highlight Sign In button.
  if (message.action === 'openSignInPopup') {
    console.log('[Background] Open sign-in popup request from website');

    chrome.storage.local.set({ highlightSignInButton: true })
      .then(() => {
        return chrome.action.openPopup()
          .then(() => {
            sendResponse({ success: true });
          })
          .catch((error) => {
            console.warn('[Background] openPopup failed for sign-in request, using fallback tab:', error);
            chrome.tabs.create({
              url: chrome.runtime.getURL('popup.html'),
              active: true
            }, (tab) => {
              sendResponse({
                success: true,
                fallback: true,
                tabId: tab?.id || null
              });
            });
          });
      })
      .catch((error) => {
        console.error('[Background] Failed preparing sign-in popup highlight:', error);
        sendResponse({ success: false, error: 'Failed to open extension popup' });
      });

    return true; // Keep channel open for async response
  }

  if (message.action === 'thumbmarkResult') {
    const senderUrl = typeof sender?.url === 'string' ? sender.url : '';
    let isVerifySender = false;
    if (senderUrl) {
      try {
        const parsed = new URL(senderUrl);
        const allowedHost =
          parsed.hostname === 'you-chords.com' ||
          parsed.hostname === 'www.you-chords.com';
        isVerifySender = allowedHost && parsed.pathname.startsWith('/verify');
      } catch (_) {
        isVerifySender = false;
      }
    }
    if (!isVerifySender) {
      sendResponse({ success: false, error: 'Invalid sender' });
      return false;
    }

    const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
    if (!requestId) {
      sendResponse({ success: false, error: 'Missing requestId' });
      return false;
    }

    const resultKey = `${THUMBMARK_RESULT_PREFIX}${requestId}`;
    const payload = {
      visitorId: typeof message.visitorId === 'string' ? message.visitorId.trim() : null,
      thumbmark: typeof message.thumbmark === 'string' ? message.thumbmark.trim().slice(0, 4096) : null,
      deviceProof: typeof message.deviceProof === 'string' ? message.deviceProof.trim().slice(0, 180) : null,
      deviceProofs: Array.isArray(message.deviceProofs)
        ? message.deviceProofs
          .filter((entry) => typeof entry === 'string' && entry.trim())
          .map((entry) => entry.trim().slice(0, 180))
        : [],
      challengeId: typeof message.challengeId === 'string' ? message.challengeId.trim() : null,
      error: typeof message.error === 'string' ? message.error.trim() : null,
      receivedAt: Date.now()
    };

    const storageUpdate = { [resultKey]: payload };
    if (payload.thumbmark) {
      storageUpdate[DEVICE_FINGERPRINT_KEY] = payload.thumbmark;
    }
    if (payload.deviceProof) {
      storageUpdate[DEVICE_PROOF_KEY] = payload.deviceProof;
    }

    chrome.storage.local.set(storageUpdate)
      .then(() => {
        if (sender?.tab?.id) {
          chrome.tabs.remove(sender.tab.id).catch(() => { });
        }
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Background] Failed to store thumbmark result:', error);
        sendResponse({ success: false, error: 'Failed to store thumbmark result' });
      });

    return true;
  }

  // Handle account deletion
  if (message.action === 'accountDeleted') {
    console.log('[Background] Account deleted, clearing local data...');

    // Clear extension storage (local)
    chrome.storage.local.remove([
      'youchords_jwt',
      'youchords_user',
      'youchords_device_id',
      DEVICE_FINGERPRINT_KEY,
      DEVICE_PROOF_KEY,
      CONSENT_STORAGE_KEY
    ]).then(() => {
      console.log('[Background] Extension local storage cleared');
    });

    // Clear extension storage (sync - popup stores user here)
    chrome.storage.sync.remove(['user']).then(() => {
      console.log('[Background] Extension sync storage cleared');
    });

    // Set cleanup flag for popup (popup will clear its localStorage when opened)
    chrome.storage.local.set({ popupNeedsCleanup: true }).then(() => {
      console.log('[Background] Set popupNeedsCleanup flag');
    });

    // Revoke Google OAuth token to prevent auto-reconnect
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        // Revoke the token on Google's servers
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .then(() => console.log('[Background] Google token revoked'))
          .catch(err => console.log('[Background] Token revoke error:', err));

        // Remove from Chrome's cache
        chrome.identity.removeCachedAuthToken({ token }, () => {
          console.log('[Background] Google token removed from cache');
        });
      }
    });

    // Set flag to clear IndexedDB on next YouTube visit
    chrome.storage.local.set({ pendingIndexedDBClear: true }).then(() => {
      console.log('[Background] Set pendingIndexedDBClear flag');
    });

    // Send message to all YouTube tabs to clear IndexedDB
    chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
      console.log('[Background] Found YouTube tabs:', tabs.length);
      tabs.forEach(tab => {
        console.log('[Background] Sending clearAllData to tab:', tab.id, tab.url);
        chrome.tabs.sendMessage(tab.id, { command: 'clearAllData' }).then(response => {
          console.log('[Background] Tab response:', response);
        }).catch(err => {
          console.log('[Background] Tab error:', err.message);
        });
      });
    });

    sendResponse({ success: true, message: 'Local data cleared' });
    return true; // Keep channel open for async response
  }

  sendResponse({ success: false, error: 'Unknown action' });
});

console.log('[Background] YouChords background service worker loaded');

// Listen for internal messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Internal message received:', message);

  // Handle Sign In request from content script
  if (message.action === 'signIn') {
    console.log('[Background] Sign in request from content script');
    const explicitConsent = normalizeConsentPayload(message?.consent, 'youtube_signin_modal');

    (async () => {
      try {
        const googleToken = await getGoogleOAuthTokenForSignIn();
        if (!googleToken) {
          sendResponse({ success: false, error: 'No token received' });
          return;
        }

        console.log('[Background] Got Google token, calling getUser...');

        // Get local install/session deviceId. Paid visitorId is requested only if the
        // server says this Google account is new and needs device verification.
        const storageData = await chrome.storage.local.get(['youchords_device_id', DEVICE_FINGERPRINT_KEY, DEVICE_PROOF_KEY]);
        const deviceId = storageData.youchords_device_id || await ensureLocalDeviceId(storageData);
        const fingerprint = typeof storageData[DEVICE_FINGERPRINT_KEY] === 'string' && storageData[DEVICE_FINGERPRINT_KEY].trim()
          ? storageData[DEVICE_FINGERPRINT_KEY].trim()
          : null;
        const deviceProof = typeof storageData[DEVICE_PROOF_KEY] === 'string' && storageData[DEVICE_PROOF_KEY].trim()
          ? storageData[DEVICE_PROOF_KEY].trim()
          : null;
        const storedConsent = explicitConsent ? null : await getStoredConsentPayload('youtube_signin_stored');
        const consentToUse = explicitConsent || storedConsent;

        // Call Firebase Function to get/create user + JWT
        const requestData = {
          googleToken,
          deviceId,
          fingerprint,
          deviceProof,
          userAgent: navigator.userAgent
        };
        if (consentToUse) {
          requestData.consent = consentToUse;
        }

        let response = await fetch(`${API_BASE_URL}/getUser`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: requestData
          })
        });

        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }

        let result = await response.json();
        let data = result.result || result;

        if (!data.success && data.code === 'VERIFY_REQUIRED') {
          const verification = await requestThumbmarkVisitorId({
            challengeId: typeof data.challengeId === 'string' ? data.challengeId : null
          });
          const verifiedThumbmark = typeof verification?.thumbmark === 'string'
            ? verification.thumbmark.trim().slice(0, 4096)
            : null;
          if (verifiedThumbmark) {
            await chrome.storage.local.set({ [DEVICE_FINGERPRINT_KEY]: verifiedThumbmark });
          }
          const verifiedDeviceProof = typeof verification?.deviceProof === 'string'
            ? verification.deviceProof.trim()
            : null;
          const verifiedDeviceProofs = Array.isArray(verification?.deviceProofs)
            ? verification.deviceProofs.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
            : [];
          if (verifiedDeviceProof) {
            await chrome.storage.local.set({ [DEVICE_PROOF_KEY]: verifiedDeviceProof });
          }
          response = await fetch(`${API_BASE_URL}/getUser`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: {
                ...requestData,
                visitorId: verification?.visitorId || null,
                thumbmark: verifiedThumbmark,
                deviceProof: verifiedDeviceProof,
                deviceProofs: verifiedDeviceProofs,
                challengeId: verification?.challengeId || data.challengeId || null
              }
            })
          });

          if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
          }

          result = await response.json();
          data = result.result || result;
        }

        if (!data.success) {
          if (data.code === 'CONSENT_REQUIRED' || data.error === 'CONSENT_REQUIRED') {
            sendResponse({ success: false, error: 'CONSENT_REQUIRED' });
            return;
          }
          throw new Error(data.error || 'Failed to get user');
        }

        console.log('[Background] Sign in successful, saving JWT...');

        // Save JWT to chrome.storage (will sync to all tabs)
        const consentToPersist = consentToUse || {
          accepted: true,
          version: CONSENT_VERSION,
          acceptedAt: new Date().toISOString(),
          source: 'server_existing_consent'
        };
        const storagePayload = {
          youchords_jwt: data.jwt,
          youchords_user: JSON.stringify(data.user),
          [CONSENT_STORAGE_KEY]: {
            ...consentToPersist,
            savedAt: new Date().toISOString()
          }
        };
        if (typeof requestData.fingerprint === 'string' && requestData.fingerprint.trim()) {
          storagePayload[DEVICE_FINGERPRINT_KEY] = requestData.fingerprint.trim();
        }
        await chrome.storage.local.set(storagePayload);

        sendResponse({
          success: true,
          user: data.user,
          jwt: data.jwt
        });
      } catch (error) {
        console.error('[Background] Sign in error:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true; // Keep channel open for async response
  }

  // Handle openPopup request from content script
  if (message.action === 'openPopup') {
    console.log('[Background] Open popup request from content script');

    // Open the extension popup (Chrome 127+)
    chrome.action.openPopup()
      .then(() => {
        console.log('[Background] Popup opened successfully');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Background] Failed to open popup:', error);
        // Fallback: open in new tab if openPopup fails
        chrome.tabs.create({
          url: chrome.runtime.getURL('popup.html'),
          active: true
        }, (tab) => {
          console.log('[Background] Opened popup in new tab as fallback:', tab.id);
          sendResponse({ success: true, fallback: true, tabId: tab.id });
        });
      });

    return true; // Keep channel open for async response
  }

  // Handle openApiManagement request - opens popup directly to API management panel
  if (message.action === 'openApiManagement') {
    console.log('[Background] Open API management request from content script');

    // Store flag so popup knows to open API management panel
    chrome.storage.local.set({ openApiManagementOnPopup: true }).then(() => {
      // Open the extension popup
      chrome.action.openPopup()
        .then(() => {
          console.log('[Background] Popup opened for API management');
          sendResponse({ success: true });
        })
        .catch((error) => {
          console.error('[Background] Failed to open popup:', error);
          // Fallback: open in new tab if openPopup fails
          chrome.tabs.create({
            url: chrome.runtime.getURL('popup.html?openApiManagement=true'),
            active: true
          }, (tab) => {
            console.log('[Background] Opened popup in new tab as fallback:', tab.id);
            sendResponse({ success: true, fallback: true, tabId: tab.id });
          });
        });
    });

    return true; // Keep channel open for async response
  }

  // Handle yc_status change (after payment or account deletion)
  if (message.action === 'ycStatusChange') {
    const status = message.status;
    console.log('[Background] YC Status change:', status);

    if (status === 'success') {
      // Payment successful - refresh JWT from server
      console.log('[Background] Payment successful, refreshing JWT...');

      refreshJwtForUser().then(result => {
        sendResponse({ success: result.success, message: result.success ? 'JWT refreshed' : undefined, error: result.error });
      });

      return true; // Keep channel open for async response
    }

    if (status === 'deleted') {
      // Account deleted - clear ALL data (same as accountDeleted handler)
      console.log('[Background] Account deleted via redirect, clearing ALL data...');

      // Clear extension storage (local)
      chrome.storage.local.remove([
        'youchords_jwt',
        'youchords_user',
        'youchords_device_id',
        CONSENT_STORAGE_KEY
      ]).then(() => {
        console.log('[Background] Extension local storage cleared');
      });

      // Clear sync storage
      chrome.storage.sync.remove(['user']).then(() => {
        console.log('[Background] Sync storage cleared');
      });

      // Set cleanup flag for popup (popup will clear its localStorage when opened)
      chrome.storage.local.set({ popupNeedsCleanup: true }).then(() => {
        console.log('[Background] Set popupNeedsCleanup flag');
      });

      // Revoke Google OAuth token to prevent auto-reconnect
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (token) {
          // Revoke the token on Google's servers
          fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
            .then(() => console.log('[Background] Google token revoked'))
            .catch(err => console.log('[Background] Token revoke error:', err));

          // Remove from Chrome's cache
          chrome.identity.removeCachedAuthToken({ token }, () => {
            console.log('[Background] Google token removed from cache');
          });
        }
      });

      // Send message to all YouTube tabs to clear localStorage and IndexedDB
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        console.log('[Background] Found YouTube tabs:', tabs.length);
        tabs.forEach(tab => {
          console.log('[Background] Sending clearAllData to tab:', tab.id, tab.url);
          chrome.tabs.sendMessage(tab.id, { command: 'clearAllData' }).then(response => {
            console.log('[Background] Tab response:', response);
          }).catch(err => {
            console.log('[Background] Tab error:', err.message);
          });
        });
      });

      sendResponse({ success: true, message: 'All data cleared' });
      return true;
    }

    if (status === 'cancelled') {
      // Subscription cancelled - refresh JWT to get cancelPending flag
      console.log('[Background] Subscription cancelled, refreshing JWT...');

      refreshJwtForUser().then(result => {
        sendResponse({ success: result.success, message: result.success ? 'JWT refreshed' : undefined, error: result.error });
      });

      return true; // Keep channel open for async response
    }

    if (status === 'resumed') {
      // Subscription resumed - refresh JWT to clear cancelPending flag
      console.log('[Background] Subscription resumed, refreshing JWT...');

      refreshJwtForUser().then(result => {
        sendResponse({ success: result.success, message: result.success ? 'JWT refreshed' : undefined, error: result.error });
      });

      return true; // Keep channel open for async response
    }

    sendResponse({ success: false, error: 'Unknown status' });
    return true;
  }

  return false; // No async response needed
});
