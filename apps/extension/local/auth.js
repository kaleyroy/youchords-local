import { LOCAL_CONFIG } from '../config/local-config.js';

const API_BASE = String(LOCAL_CONFIG?.baseUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
const PAIRING_TOKEN = String(LOCAL_CONFIG?.pairingToken || '');
const LOCAL_USER = Object.freeze({
  uid: 'local-user',
  displayName: 'Local musician',
  plan: 'local',
  photoURL: null
});
const LOCAL_SUBSCRIPTION = Object.freeze({
  plan: 'pro',
  status: 'active',
  subscriptionStatus: 'active',
  chordsUsed: 0,
  chordsLimit: Number.MAX_SAFE_INTEGER,
  processingChordsUsed: 0,
  processingChordsLimit: Number.MAX_SAFE_INTEGER,
  cancelPending: false,
  blocked: false
});

function ensureConfigured() {
  if (!PAIRING_TOKEN || PAIRING_TOKEN === 'REPLACE_DURING_INSTALL') {
    throw new Error('YouChords Local is not paired. Run install.ps1 again.');
  }
}

async function apiFetch(path, options = {}) {
  ensureConfigured();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAIRING_TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.detail || payload.error || `Local companion returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Request aborted', 'AbortError'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function getResult(videoId, signal) {
  try {
    return await apiFetch(`/v1/results/${encodeURIComponent(videoId)}`, { signal });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function getChords(videoId, options = {}) {
  const signal = options.signal || null;
  try {
    const cached = await getResult(videoId, signal);
    if (cached) return cached;
    if (options.checkOnly || !options.enqueueIfMissing) {
      return { success: false, notInCache: true };
    }

    window.extractorModule?.createProgressBar?.(true, false, 'Processing chords locally...');
    const created = await apiFetch('/v1/jobs', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`
      })
    });

    if (created.status === 'completed') {
      return await getResult(videoId, signal);
    }

    const jobId = created.jobId;
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      await abortableDelay(1000, signal);
      const job = await apiFetch(`/v1/jobs/${encodeURIComponent(jobId)}`, { signal });
      window.extractorModule?.setChordsQueueHint?.(`Local processing: ${job.stage}`);
      if (job.status === 'completed') {
        return await getResult(videoId, signal);
      }
      if (job.status === 'failed') {
        return { success: false, processingFailed: true, error: job.error || 'Local processing failed' };
      }
    }
    return { success: false, processingFailed: true, error: 'Local processing timed out' };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { success: false, aborted: true, error: 'Request aborted' };
    }
    return { success: false, processingFailed: true, error: error?.message || 'Local companion is unavailable' };
  }
}

async function processVideoViaServer(videoId, durationSeconds = 180, options = {}) {
  return getChords(videoId, {
    ...options,
    durationSeconds,
    enqueueIfMissing: true
  });
}

function checkQuotaLocal() {
  return {
    allowed: true,
    plan: 'pro',
    used: 0,
    limit: Number.MAX_SAFE_INTEGER,
    canAccessCache: true,
    shouldDeleteChordsDB: false
  };
}

async function signInWithGoogle() {
  return { success: true, user: LOCAL_USER, local: true };
}

async function signOutUser() {
  return { success: true, local: true };
}

async function getCurrentUser() {
  return LOCAL_USER;
}

function getSubscriptionInfo() {
  return LOCAL_SUBSCRIPTION;
}

function getJWTPayload() {
  return LOCAL_SUBSCRIPTION;
}

function initAuthCache() {
  return Promise.resolve(LOCAL_USER);
}

function clearAuthCache() {}
async function checkForProDowngrade() { return false; }
async function ensureFreshSubscriptionForGating() { return LOCAL_SUBSCRIPTION; }

window.ycAuth = {
  signInWithGoogle,
  signOutUser,
  getCurrentUser,
  checkQuotaLocal,
  getChords,
  getSubscriptionInfo,
  getJWTPayload,
  processVideoViaServer,
  initAuthCache,
  waitForAuthCache: () => Promise.resolve(),
  clearAuthCache,
  checkForProDowngrade,
  ensureFreshSubscriptionForGating
};

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
