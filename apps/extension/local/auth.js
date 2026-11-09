/* yc-module-scope */
(function () {
// Local build: config injected as a classic script before this file
// (config/local-config.js sets window.YC_LOCAL_CONFIG)
const LOCAL_CONFIG = window.YC_LOCAL_CONFIG;

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
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${PAIRING_TOKEN}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  // 首选后台桥:content script 直连 http://127.0.0.1:8765 会被归因到 https 宿主页,
  // 触发 PNA "Unsafe attempt to load URL" 拦截;后台 SW 受 host_permissions 豁免。
  // 注意:桥不支持转发 AbortSignal,options.signal 仅由轮询间隔的 abortableDelay 响应。
  if (typeof window.ycLoader?.fetchJson === 'function') {
    const response = await window.ycLoader.fetchJson(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ?? null
    });

    if (!response.ok) {
      const payload = response.json || {};
      const error = new Error(payload.detail || payload.error || `Local companion returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json;
  }

  // 回退:桥前端/后台版本不齐(扩展重载与页面刷新必须成对)时直接请求,
  // 至少保留旧行为(PNA 未强制或本地 CORS 放行的环境仍可用),避免静默失败。
  console.warn('[ycAuth] ycLoader.fetchJson unavailable — falling back to direct fetch (may be PNA-blocked)');
  const response = await fetch(url, { ...options, headers });

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
// Consumers access auth via window.ycAuth (classic-script injection).

})();
