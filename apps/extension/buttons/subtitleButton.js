/* yc-module-scope */
(function () {
// subtitleButton.js - Full version with word element recycling and fixes

// משתנה לשמירת מצב טעינת מודול subtitle location
let subtitleLocationModuleLoaded = false;
let subtitleLocationObserver = null; // שמירת ה-observer לניקוי מאוחר יותר

// הגדרת קבועים גלובליים לשימוש בכל הקבצים - חייב להיות לפני כל שימוש
window.DEFAULT_BG_OPACITY = "85";
const DEFAULT_BG_OPACITY = window.DEFAULT_BG_OPACITY;

// הגדרת משתנה DEBUG גלובלי
const DEBUG = window.DEBUG;
const CONSENT_VERSION = '2026-02-17';
const SUBTITLE_MODE_STATUS_SHOW_MS = 2600;

function normalizeAiModeForSubtitles(value) {
  const raw = typeof value === "string" ? value.toLowerCase() : "off";
  return ["off", "auto", "always"].includes(raw) ? raw : "off";
}

function hasActiveGeminiKeyForSubtitles(keys) {
  return Array.isArray(keys)
    && keys.some((keyData) => keyData && keyData.active !== false && keyData.status !== "disabled");
}

function getSubtitleButtonVideoId() {
  return window.ycUtils?.extractVideoId?.(window.location.href) || null;
}

function isTutorialDemoSubtitleVideo(videoId = getSubtitleButtonVideoId()) {
  return window.__ycIsTutorialDemoVideo?.(videoId) === true;
}

async function ensureSubtitleAuthLoaded() {
  if (!window.ycAuth?.getJWTPayload) {
    if (!window.dynamicLoader?.ensureAuthLoaded) return false;
    console.log("[SubtitleButton] Loading auth on demand...");
    await window.dynamicLoader.ensureAuthLoaded();
  }

  await window.ycAuth?.waitForAuthCache?.();
  return !!window.ycAuth?.getJWTPayload;
}

function resolveSubtitleLanguageName(codeOrName) {
  if (!codeOrName || typeof codeOrName !== "string") {
    return "Unknown";
  }

  const normalized = codeOrName.trim();
  if (!normalized) {
    return "Unknown";
  }

  if (typeof window.getLanguageByCode === "function") {
    const byCode = window.getLanguageByCode(normalized.toLowerCase());
    if (byCode?.name) {
      return byCode.name;
    }
  }

  const fallbackByCode = {
    he: "Hebrew",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ru: "Russian",
    ar: "Arabic",
    tr: "Turkish",
    ja: "Japanese",
    ko: "Korean",
    hi: "Hindi",
  };

  const lower = normalized.toLowerCase();
  if (fallbackByCode[lower]) {
    return fallbackByCode[lower];
  }

  // If this is already a readable name, keep it.
  if (/\s/.test(normalized) || /[A-Z]/.test(normalized)) {
    return normalized;
  }

  return normalized.toUpperCase();
}

function resolveOriginalSubtitleSourceName(subtitlesData) {
  const rawName = subtitlesData?.languageName || "";
  const rawCode = subtitlesData?.languageCode || "";
  const normalizedName = String(rawName || "").trim();
  const normalizedCode = String(rawCode || "").trim();

  if (normalizedName && !/gemini|translation/i.test(normalizedName)) {
    return normalizedName;
  }
  if (normalizedCode) {
    return resolveSubtitleLanguageName(normalizedCode);
  }
  return null;
}

function showSubtitleModeStatusOverlay(text) {
  const safeText = String(text || "").trim();
  if (!safeText) return;

  const player = document.querySelector(".html5-video-player");
  if (!player) return;

  let toast = window.subtitleState?.modeStatusToastElement || null;
  if (!toast || !toast.isConnected) {
    toast = createDOMElement("div", "yc-subtitle-mode-status-toast");
    toast.style.cssText = `
      position: absolute;
      top: 68px;
      left: 64px;
      z-index: 3005;
      max-width: min(72vw, 560px);
      padding: 8px 12px;
      border-radius: 2px;
      background: rgba(0, 0, 0, 0.82);
      color: #fff;
      font: 500 20px/1.25 Roboto, Arial, sans-serif;
      letter-spacing: 0.1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-4px);
      transition: opacity 140ms ease, transform 140ms ease;
    `;
    player.appendChild(toast);
    window.subtitleState.modeStatusToastElement = toast;
  }

  toast.textContent = safeText;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  if (window.subtitleState.modeStatusToastTimeout) {
    clearTimeout(window.subtitleState.modeStatusToastTimeout);
  }
  window.subtitleState.modeStatusToastTimeout = setTimeout(() => {
    if (!toast || !toast.isConnected) return;
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-4px)";
  }, SUBTITLE_MODE_STATUS_SHOW_MS);
}

async function showSubtitleModeStatusToast(videoId = null) {
  try {
    const settings = await chrome.storage.local.get([
      "showTranslation",
      "translationLanguage",
      "translationIncludeOriginal",
      "translationSecondaryLanguage",
      "aiTranscriptionMode",
    ]);

    const aiMode = normalizeAiModeForSubtitles(settings.aiTranscriptionMode);
    let useTranslation = settings.showTranslation === true;
    if (aiMode === "off") {
      useTranslation = false;
    }

    if (!useTranslation) {
      showSubtitleModeStatusOverlay("Subtitles: DEFAULT");
      return;
    }

    const primary = resolveSubtitleLanguageName(settings.translationLanguage || "he");
    const includeOriginal = settings.translationIncludeOriginal === true;
    const secondaryCode = settings.translationSecondaryLanguage || null;

    if (secondaryCode) {
      const secondary = resolveSubtitleLanguageName(secondaryCode);
      showSubtitleModeStatusOverlay(
        `Subtitles: TRANSLATE • Primary: ${primary} • Secondary: ${secondary}`
      );
      return;
    }

    if (includeOriginal) {
      let originalSource = null;
      if (videoId && window.databaseManager?.loadSubtitlesFromIndexedDB) {
        try {
          let subtitlesData = await window.databaseManager.loadSubtitlesFromIndexedDB(videoId);
          if (subtitlesData && window.databaseManager?.normalizeSubtitlesForActiveMode) {
            subtitlesData = await window.databaseManager.normalizeSubtitlesForActiveMode(
              subtitlesData,
              aiMode
            );
          }
          originalSource = resolveOriginalSubtitleSourceName(subtitlesData);
        } catch (dbError) {
          console.warn("[SubtitleButton] Could not resolve original source language:", dbError);
        }
      }

      const normalizedOriginal = originalSource || "Source audio";
      showSubtitleModeStatusOverlay(
        `Subtitles: TRANSLATE • Primary: ${primary} • Original: ${normalizedOriginal}`
      );
      return;
    }

    showSubtitleModeStatusOverlay(`Subtitles: TRANSLATE • Primary: ${primary}`);
  } catch (error) {
    console.warn("[SubtitleButton] Failed to show subtitle mode status toast:", error);
  }
}

function getSubtitleVideoDurationSeconds(fallbackSeconds = null) {
  const fallback = Number(fallbackSeconds);
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }

  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  const duration = Number(video?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

async function maybeConfirmLongGeminiForSubtitles(aiMode, durationSeconds) {
  return true;
}

// ------------------------------
// 🎬 Create Subtitle Button (Real Version)
// ------------------------------
window.createSubtitleButton = function () {
  const container = document.createElement('div');
  container.className = 'custom-button-container';

  const button = document.createElement('button');
  button.className = 'ytp-button ytp-subtitle-button';
  button.title = 'Toggle Subtitles';

  // SVG - CC בעיגול
  button.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <use class="ytp-svg-shadow"/>
    <circle class="ytp-svg-stroke" cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="1.5"/>
    <text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="7" font-weight="bold" fill="#fff" class="ytp-svg-fill">CC</text>
  </svg>`;

  container.appendChild(button);
  return container;
};

// ------------------------------
// 🔐 Modal Functions for Authentication
// ------------------------------
function showSubtitleModal(icon, title, message, buttons = [{ text: 'OK', action: 'close' }]) {
  const existingModal = document.getElementById('yc-subtitle-auth-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'yc-subtitle-auth-modal';

  const buttonsHtml = buttons.map(btn => {
    const btnClass = btn.action === 'reload' ? 'yc-modal-btn-reload' :
      btn.action === 'upgrade' ? 'yc-modal-btn-upgrade' : 'yc-modal-btn-close';
    return `<button class="yc-modal-btn ${btnClass}" data-action="${btn.action}">${btn.text}</button>`;
  }).join('');

  modal.innerHTML = `
    <div class="yc-modal-backdrop"></div>
    <div class="yc-modal-content">
      <div class="yc-modal-icon">${icon}</div>
      <h2 class="yc-modal-title">${title}</h2>
      <p class="yc-modal-text">${message}</p>
      <div class="yc-modal-buttons">${buttonsHtml}</div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #yc-subtitle-auth-modal {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 2147483647; display: flex; align-items: center; justify-content: center;
    }
    #yc-subtitle-auth-modal .yc-modal-backdrop {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px);
    }
    #yc-subtitle-auth-modal .yc-modal-content {
      position: relative; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-radius: 20px; padding: 40px; max-width: 420px; text-align: center;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.1);
    }
    #yc-subtitle-auth-modal .yc-modal-icon { font-size: 48px; margin-bottom: 15px; }
    #yc-subtitle-auth-modal .yc-modal-title { color: #fff; font-size: 24px; margin: 0 0 20px 0; font-weight: 600; }
    #yc-subtitle-auth-modal .yc-modal-text { color: #a0a0a0; font-size: 15px; line-height: 1.6; margin: 0 0 15px 0; }
    #yc-subtitle-auth-modal .yc-modal-text strong { color: #fff; }
    #yc-subtitle-auth-modal .yc-modal-buttons { margin-top: 25px; display: flex; gap: 12px; }
    #yc-subtitle-auth-modal .yc-modal-btn { flex: 1; padding: 12px 24px; border-radius: 25px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.3s ease; border: none; }
    #yc-subtitle-auth-modal .yc-modal-btn-close { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
    #yc-subtitle-auth-modal .yc-modal-btn-close:hover { transform: scale(1.05); box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4); }
    #yc-subtitle-auth-modal .yc-modal-btn-reload { background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; }
    #yc-subtitle-auth-modal .yc-modal-btn-reload:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(231, 76, 60, 0.4); }
    #yc-subtitle-auth-modal .yc-modal-btn-upgrade { background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%); color: white; }
    #yc-subtitle-auth-modal .yc-modal-btn-upgrade:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(243, 156, 18, 0.4); }
  `;

  document.head.appendChild(style);
  document.body.appendChild(modal);

  modal.querySelector('.yc-modal-backdrop').addEventListener('click', () => modal.remove());
  modal.querySelectorAll('.yc-modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'reload') location.reload();
      else if (action === 'upgrade') {
        if (window.__ycOpenUpgradePage) {
          window.__ycOpenUpgradePage();
        } else {
          window.open('https://www.you-chords.com/upgrade', '_blank');
        }
      }
      modal.remove();
    });
  });
}

function showSubtitleSignInRequired() {
  const existingModal = document.getElementById('yc-subtitle-signin-modal');
  if (existingModal) existingModal.remove();

  // Remove existing style tag to prevent accumulation
  const existingStyle = document.getElementById('yc-subtitle-signin-modal-style');
  if (existingStyle) existingStyle.remove();

  const modal = document.createElement('div');
  modal.id = 'yc-subtitle-signin-modal';
  modal.innerHTML = `
    <div class="yc-modal-backdrop"></div>
    <div class="yc-modal-content">
      <button class="yc-modal-close-btn">×</button>
      <div class="yc-modal-icon">🔐</div>
      <h2 class="yc-modal-title">Sign In Required</h2>
      <p class="yc-modal-text">To access <strong>Subtitles</strong>, please sign in.</p>
      
      <button class="yc-google-signin-btn" aria-disabled="false">
        <svg class="yc-google-icon" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      </button>

      <p class="yc-consent-error" style="display:none;">Please confirm consent to continue.</p>
      
      <p class="yc-consent-notice">By signing in, you agree to our <a href="https://you-chords.com/terms" target="_blank">Terms of Service</a><br>and <a href="https://you-chords.com/privacy" target="_blank">Privacy Policy</a>.</p>
      
      <div class="yc-or-divider">OR</div>
      
      <p class="yc-toolbar-hint">
        Click the extension icon <img src="${chrome.runtime.getURL('images/icons/icon-16.png')}" class="yc-popup-icon" alt="Extension Icon"> in the toolbar
      </p>
      
      <p class="yc-modal-help">
        Can't find the extension icon in the toolbar?
        <div style="display:flex;gap:10px;justify-content:center;margin-top:8px;">
          <a href="${chrome.runtime.getURL('videos/signin_tutorial.mp4')}" target="_blank" class="yc-help-link yc-video-tutorial-link" style="display:flex;align-items:center;gap:5px;text-decoration:none;text-underline-offset:2px;">
            🎥 Video Tutorial
          </a>
          <button type="button" class="yc-help-link yc-image-guide-btn" style="display:flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;color:white;text-decoration:none;text-underline-offset:2px;font-size:13px;padding:0;">
            📷 Image Guide
          </button>
        </div>
      </p>
    </div>
  `;

  const style = document.createElement('style');
  style.id = 'yc-subtitle-signin-modal-style';
  style.textContent = `
    #yc-subtitle-signin-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #yc-subtitle-signin-modal .yc-modal-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
    }
    #yc-subtitle-signin-modal .yc-modal-content {
      position: relative;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-radius: 20px;
      padding: 40px;
      max-width: 450px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    #yc-subtitle-signin-modal .yc-modal-close-btn {
      position: absolute;
      top: 15px;
      right: 15px;
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      font-size: 28px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      line-height: 1;
      padding: 0;
    }
    #yc-subtitle-signin-modal .yc-modal-close-btn:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }
    #yc-subtitle-signin-modal .yc-modal-icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
    #yc-subtitle-signin-modal .yc-modal-title {
      color: #fff;
      font-size: 28px;
      margin: 0 0 15px 0;
      font-weight: 700;
    }
    #yc-subtitle-signin-modal .yc-modal-text {
      color: rgba(255, 255, 255, 0.95);
      font-size: 16px;
      line-height: 1.6;
      margin: 0 0 15px 0;
    }
    #yc-subtitle-signin-modal .yc-modal-text strong {
      color: #fff;
      font-weight: 600;
    }
    #yc-subtitle-signin-modal .yc-google-signin-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: white;
      color: #1f1f1f;
      border: none;
      border-radius: 50px;
      padding: 12px 24px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin: 20px auto;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    #yc-subtitle-signin-modal .yc-google-signin-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    }
    #yc-subtitle-signin-modal .yc-google-signin-btn:active {
      transform: translateY(0);
    }
    #yc-subtitle-signin-modal .yc-google-signin-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
      filter: grayscale(0.35);
    }
    #yc-subtitle-signin-modal .yc-google-signin-btn:disabled:hover {
      transform: none;
      box-shadow: none;
    }
    #yc-subtitle-signin-modal .yc-google-icon {
      width: 18px;
      height: 18px;
    }
    #yc-subtitle-signin-modal .yc-consent-error {
      color: #fecaca;
      font-size: 12px;
      margin: 4px 0 8px 0;
    }
    #yc-subtitle-signin-modal .yc-consent-notice {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.5;
      margin: 15px 0;
    }
    #yc-subtitle-signin-modal .yc-consent-notice a {
      color: white;
      text-decoration: underline;
    }
    #yc-subtitle-signin-modal .yc-or-divider {
      text-align: center;
      margin: 20px 0;
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
    }
    #yc-subtitle-signin-modal .yc-toolbar-hint {
      text-align: center;
      color: rgba(255, 255, 255, 0.8);
      font-size: 14px;
      margin: 15px 0;
    }
    #yc-subtitle-signin-modal .yc-modal-help {
      color: rgba(255, 255, 255, 0.9);
      font-size: 15px;
      font-weight: 500;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    #yc-subtitle-signin-modal .yc-help-link {
      color: white;
      text-decoration: none;
      font-size: 13px;
      transition: color 0.2s;
    }
    #yc-subtitle-signin-modal .yc-help-link:hover {
      color: rgba(255, 255, 255, 0.8);
      text-decoration: underline;
    }
    #yc-subtitle-signin-modal .yc-signin-spinner {
      width: 18px;
      height: 18px;
      border: 3px solid rgba(0, 0, 0, 0.2);
      border-top-color: #1f1f1f;
      border-radius: 50%;
      animation: yc-spin 0.8s linear infinite;
    }
    @keyframes yc-spin {
      to { transform: rotate(360deg); }
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(modal);

  const consentError = modal.querySelector('.yc-consent-error');

  const getSignInFailureMessage = (error) => {
    const message = String(error || '').trim();
    if (!message) return 'Sign in failed. Please try again.';
    if (/oauth|client|credentials|authorization|identity/i.test(message)) {
      return 'Google sign-in could not start for this extension build. If this is a local test build, check the extension ID and OAuth setup.';
    }
    if (/cancel|approve|denied|dismiss/i.test(message)) {
      return 'Google sign-in was cancelled. Please try again.';
    }
    if (/network|fetch|timeout|connection/i.test(message)) {
      return 'Could not reach YouChords. Check your connection and try again.';
    }
    return message.length > 180 ? `${message.slice(0, 180)}...` : message;
  };

  // Event listeners
  modal.querySelector('.yc-modal-close-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('.yc-modal-backdrop').addEventListener('click', () => modal.remove());

  // Sign In button
  modal.querySelector('.yc-google-signin-btn').addEventListener('click', async () => {
    const btn = modal.querySelector('.yc-google-signin-btn');
    if (consentError) consentError.style.display = 'none';
    const consent = {
      accepted: true,
      version: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
      source: 'youtube_subtitle_modal'
    };

    btn.innerHTML = '<div class="yc-signin-spinner"></div> Signing in...';
    btn.disabled = true;
    btn.style.opacity = '0.8';
    btn.style.cursor = 'wait';

    try {
      // Send message to background script to handle sign in
      const response = await chrome.runtime.sendMessage(
        { action: 'signIn', consent }
      );

      if (response.success) {
        console.log('[Subtitle] Sign in successful!', response.user);

        // 1. Store JWT securely (chrome.storage + memory cache)
        if (window.__ycSetJwt) {
          await window.__ycSetJwt(response.jwt);
        } else {
          await chrome.storage.local.set({ youchords_jwt: response.jwt });
        }

        // 2. Update in-memory auth state
        if (window.ycAuth?.initAuthCache) {
          window.ycAuth.initAuthCache();
        }

        // Show success notification
        const userName = response.user?.displayName?.split(' ')[0] || response.user?.email?.split('@')[0] || 'there';
        showSignInSuccessNotification(userName);

        modal.remove();

        // 3. Retry action - simulate button click
        setTimeout(() => {
          const subtitleBtn = document.querySelector('[data-btn="subtitle"] .ytp-subtitle-button');
          if (subtitleBtn) {
            console.log('[Subtitle] Clicking subtitle button after sign in');
            subtitleBtn.click();
          }
        }, 100);
      } else {
        if (response.error === 'CONSENT_REQUIRED') {
          if (consentError) {
            consentError.textContent = 'Could not record sign-in consent. Please try again.';
            consentError.style.display = 'block';
          }
          btn.innerHTML = `
            <svg class="yc-google-icon" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          `;
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.style.cursor = 'pointer';
          return;
        }

        console.error('[Subtitle] Sign in failed:', response.error);
        if (consentError) {
          consentError.textContent = getSignInFailureMessage(response.error);
          consentError.style.display = 'block';
        }
        btn.textContent = 'Sign in failed. Try again';
        btn.disabled = false;
        setTimeout(() => {
          btn.innerHTML = `
            <svg class="yc-google-icon" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          `;
        }, 2000);
      }
    } catch (error) {
      console.error('[Subtitle] Sign in error:', error);
      if (consentError) {
        consentError.textContent = getSignInFailureMessage(error?.message || error);
        consentError.style.display = 'block';
      }
      btn.textContent = 'Error. Try again';
      btn.disabled = false;
    }
  });
}

// ✅ Success notification after sign in
function showSignInSuccessNotification(userName) {
  // Remove existing notification if any
  const existing = document.getElementById('yc-signin-success-toast');
  if (existing) existing.remove();

  // Find video player container
  const videoPlayer = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  if (!videoPlayer) {
    console.warn('[Subtitle] Video player not found for success notification');
    return;
  }

  // Create notification
  const toast = document.createElement('div');
  toast.id = 'yc-signin-success-toast';
  toast.innerHTML = `
    <span class="yc-toast-icon">✅</span>
    <div class="yc-toast-text">
      <div class="yc-toast-title">Successfully signed in!</div>
      <div class="yc-toast-subtitle">Welcome ${userName}</div>
    </div>
  `;

  // Add styles
  const style = document.createElement('style');
  style.id = 'yc-signin-success-toast-style';
  style.textContent = `
    #yc-signin-success-toast {
      position: absolute;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(16, 185, 129, 0.4);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 15px;
      font-weight: 600;
      z-index: 9999;
      animation: ycSlideUp 0.3s ease-out;
      pointer-events: none;
    }
    @keyframes ycSlideUp {
      from {
        transform: translateX(-50%) translateY(50px);
        opacity: 0;
      }
      to {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
    }
    #yc-signin-success-toast .yc-toast-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    #yc-signin-success-toast .yc-toast-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #yc-signin-success-toast .yc-toast-title {
      font-size: 15px;
      font-weight: 600;
    }
    #yc-signin-success-toast .yc-toast-subtitle {
      font-size: 13px;
      opacity: 0.9;
    }
  `;

  // Remove existing style if any
  const existingStyle = document.getElementById('yc-signin-success-toast-style');
  if (existingStyle) existingStyle.remove();

  document.head.appendChild(style);
  videoPlayer.appendChild(toast);

  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = 'ycSlideDown 0.3s ease-out';
    setTimeout(() => {
      toast.remove();
      style.remove();
    }, 300);
  }, 3000);
}

function showSubtitleAuthError(message) {
  showSubtitleModal('⚠️', 'System Error', message,
    [{ text: 'Reload Page', action: 'reload' }, { text: 'Close', action: 'close' }]);
}

// ------------------------------
// 0. פונקציות עזר לטיפול בטקסט
// ------------------------------
function fixPunctuation(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(/([.!?])(?=\S)/g, "$1 ");
}

function normalizeWord(text) {
  if (!text || typeof text !== "string") return "";
  return fixPunctuation(text).trim();
}

function normalizeSubtitleText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGeminiDefaultSubtitleSource() {
  return (
    window.subtitleState?.timingSourceKey === "gemini_default" &&
    window.subtitleState?.useTranslation === false
  );
}

function canMergeGeminiDefaultSentences(first, second) {
  if (!first || !second) return false;

  const firstText = normalizeSubtitleText(first.text);
  const secondText = normalizeSubtitleText(second.text);
  if (!firstText || !secondText) return false;

  const gapSec = Math.max(0, (second.startTime || 0) - (first.endTime || 0));
  if (gapSec > GEMINI_DEFAULT_MERGE_GAP_SEC) return false;

  const mergedDurationSec = Math.max(
    0,
    (second.endTime || 0) - (first.startTime || 0)
  );
  if (mergedDurationSec > GEMINI_DEFAULT_MERGE_MAX_WINDOW_SEC) return false;

  const mergedText = `${firstText} ${secondText}`;
  if (mergedText.length < GEMINI_DEFAULT_MIN_MERGE_CHARS) return false;

  return true;
}

function mergeGeminiDefaultSentences(first, second) {
  return {
    ...first,
    text: normalizeSubtitleText(`${first.text} ${second.text}`),
    startTime: first.startTime,
    endTime: second.endTime,
    _ycMergedGeminiDefault: true,
  };
}

function buildGeminiDefaultMergePairs(sentences) {
  if (!Array.isArray(sentences) || sentences.length === 0) return [];

  const pairsByIndex = new Array(sentences.length).fill(null);
  let i = 0;
  while (i < sentences.length - 1) {
    const first = sentences[i];
    const second = sentences[i + 1];

    if (canMergeGeminiDefaultSentences(first, second)) {
      const merged = mergeGeminiDefaultSentences(first, second);
      merged._ycMergedStartIndex = i;
      merged._ycMergedEndIndex = i + 1;
      pairsByIndex[i] = merged;
      pairsByIndex[i + 1] = merged;
      i += 2; // non-overlapping pairs only
      continue;
    }

    i += 1;
  }

  return pairsByIndex;
}

// ------------------------------
// 1. בדיקת RTL
// ------------------------------
function isRTLText(text) {
  const rtlCharsRegex =
    /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  if (!text || typeof text !== "string") return false;
  const matches = text.match(rtlCharsRegex);
  if (matches && matches.length > 0) {
    const rtlCharsCount = text
      .split("")
      .filter((char) => rtlCharsRegex.test(char)).length;
    const textWithoutSpaces = text.replace(/\s/g, "");
    if (textWithoutSpaces.length === 0) return false;
    const rtlRatio = rtlCharsCount / textWithoutSpaces.length;
    return rtlRatio > 0.1;
  }
  return false;
}

// ------------------------------
// 2. ניהול מצב הכתוביות - עם הוספת מערכי SPANs
// ------------------------------
const MAX_WORDS_PER_LINE = 30; // כמות SPAN-ים מוכנים מראש
const MAX_PIXEL_RATIO = 0.8; // לשימוש עתידי (מדידה-בפיקסלים)
const MAX_CHARS_PER_LINE = 42; // 🎬 Netflix standard (42 chars per line)
const MIN_SPLIT_LENGTH = 21; // 🎬 Netflix minimum (half of 42)
const MAX_LINES = 8; // 🆕 הגדלנו ל-8 שורות לתמיכה בדו-לשוני (4 לכל שפה)
const GEMINI_DEFAULT_MERGE_GAP_SEC = 0.45;
const GEMINI_DEFAULT_MERGE_MAX_WINDOW_SEC = 8.5;
const GEMINI_DEFAULT_MIN_MERGE_CHARS = 20;
const LEADING_PUNCT_REGEX = /^[.,;!?…]+$/; // מזהה סימני פיסוק "בודדים"

if (!window.subtitleState) {
  window.subtitleState = {
    isVisible: false,
    sentences: [],
    words: [],
    isRTL: false,
    sizePercentage: "300",
    overlay: null, // Main overlay div
    textContainer: null, // Inner container for lines (yt-subtitle-container)
    line1Element: null,
    line2Element: null,
    line3Element: null,
    line4Element: null,
    line5Element: null, // 🆕
    line6Element: null, // 🆕
    line7Element: null, // 🆕
    line8Element: null, // 🆕
    line1WordSpans: [],
    line2WordSpans: [],
    line3WordSpans: [],
    line4WordSpans: [],
    line5WordSpans: [], // 🆕
    line6WordSpans: [], // 🆕
    line7WordSpans: [], // 🆕
    line8WordSpans: [], // 🆕
    settingsMenu: null,
    isSettingsVisible: false,
    wordCountdownState: {},
    timing_offset: 0,
    geminiDefaultMergePairsByIndex: null,
    useTranslation: false,
    translationIncludeOriginal: false,
    translationSecondaryLanguage: null,
    isSingleLanguageTranslation: false,
    modeStatusToastElement: null,
    modeStatusToastTimeout: null,
  };
}
if (!window.subtitleObservers) {
  window.subtitleObservers = [];
}
if (!window.subtitleModeState) {
  window.subtitleModeState = {
    isLyricsMode: true,
    isSubtitleMode: false,
    lastMode: "lyrics",
    isLyricsHighlightEnabled: true,
    isChordsHighlightEnabled: false,
  };
}
window.currentSubtitleColor = window.currentSubtitleColor || "#FFFFFF";
window.currentHighlightColor =
  window.currentHighlightColor || "rgba(255, 255, 0, 0.5)";
window.currentHighlightBackgroundEnabled =
  window.currentHighlightBackgroundEnabled === true;
window.currentFontOpacity = window.currentFontOpacity || "100";
window.currentBackgroundColor =
  window.currentBackgroundColor || "rgba(0, 0, 0, 0.8)";
window.currentBackgroundOpacity =
  window.currentBackgroundOpacity || DEFAULT_BG_OPACITY;
window.currentWordCountdownType = window.currentWordCountdownType || "none";
window.currentWordHighlightTextColor =
  window.currentWordHighlightTextColor || "#FFFFFF";
window.hasCustomWordHighlightTextColor =
  window.hasCustomWordHighlightTextColor || false;

// ------------------------------
// 3. פונקציות עזר: debounce ויצירת אלמנטים
// ------------------------------
const debounce = (fn, delay = 50) => {
  let timer = null;
  function wrapper(...args) {
    const context = this;
    clearTimeout(timer);
    if (window.requestIdleCallback) {
      timer = setTimeout(() => {
        requestIdleCallback(() => fn.apply(context, args), { timeout: delay });
      }, delay / 2);
    } else {
      timer = setTimeout(() => fn.apply(context, args), delay);
    }
  }
  /* ⬅️ מאפשר ביטול ידני — נשתמש ב-beforeunload */
  wrapper.cancel = () => clearTimeout(timer);
  return wrapper;
};

const createDOMElement = (tag, className, styles = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (styles) element.style.cssText = styles;
  return element;
};

// ------------------------------
// 4. פונקציות לפענוח SRT
// ------------------------------
const parseTime = (timeStr) => {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const parts = timeStr.split(":");
  if (parts.length !== 3) return 0;
  const secondsPart = parts[2];
  const msPart = secondsPart.split(",");
  if (msPart.length !== 2) return 0;

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const secs = parseInt(msPart[0], 10);
  const ms = parseInt(msPart[1], 10);

  if (isNaN(hours) || isNaN(minutes) || isNaN(secs) || isNaN(ms)) return 0;
  return hours * 3600 + minutes * 60 + secs + ms / 1000;
};

const parseSRT = (content) => {
  if (!content || typeof content !== "string")
    return { subtitles: [], isRTL: false };
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let blocks = normalizedContent.trim().split("\n\n");
  if (blocks.length === 1 && blocks[0] === "") blocks = [];

  if (blocks.length <= 1 && normalizedContent.includes("-->")) {
    blocks = normalizedContent
      .trim()
      .split(
        /\n(?=\d+\n\d{1,2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2},\d{3})/
      );
  }

  const parsedSubs = blocks
    .map((block) => {
      const lines = block.trim().split("\n");
      if (lines.length < 2) return null;

      let timeLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("-->")) {
          timeLineIndex = i;
          break;
        }
      }
      if (timeLineIndex === -1 || lines.length <= timeLineIndex) return null;

      const timeMatch = lines[timeLineIndex].match(
        /(\d{1,2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2},\d{3})/
      );
      if (!timeMatch) return null;

      const textContent = lines
        .slice(timeLineIndex + 1)
        .join(" ")
        .trim();
      if (!textContent) return null;

      return {
        startTime: parseTime(timeMatch[1]),
        endTime: parseTime(timeMatch[2]),
        text: textContent,
      };
    })
    .filter(Boolean);

  let isRTLContent = false;
  if (parsedSubs.length > 0) {
    const sampleSize = Math.min(10, parsedSubs.length);
    let rtlCount = 0;
    for (let i = 0; i < sampleSize; i++) {
      const subtitleIndex = Math.floor((i * parsedSubs.length) / sampleSize);
      const subtitle = parsedSubs[subtitleIndex];
      if (subtitle && isRTLText(subtitle.text)) rtlCount++;
    }
    isRTLContent = rtlCount / sampleSize > 0.3;
  }
  return { subtitles: parsedSubs, isRTL: isRTLContent };
};

// ------------------------------
// 5. טעינת כתוביות
// ------------------------------
async function loadSubtitles(forceLoad = false) {
  try {
    if (window.DEBUG)
      console.log(`[SubtitleButton DEBUG] loadSubtitles: Function started`);
    const currentUrl = window.location.href;
    const videoId = window.ycUtils?.extractVideoId
      ? window.ycUtils.extractVideoId(currentUrl)
      : null;

    if (!videoId) {
      console.error(
        "[SubtitleButton] loadSubtitles: Could not extract video ID from URL"
      );
      showError("Invalid YouTube URL (loadSubtitles)");
      window.subtitleState.sentences = [];
      window.subtitleState.words = [];
      window.subtitleState.isRTL = false;
      window.subtitleState.isCustomPrompt = false;
      return false;
    }

    if (window.DEBUG)
      console.log(
        `[SubtitleButton] loadSubtitles: Loading subtitles for video ${videoId} from IndexedDB...`
      );

    // 🤖 Check AI Transcription mode
    const aiSettings = await new Promise((resolve) => {
      chrome.storage.local.get(['aiTranscriptionMode', 'geminiApiKey', 'geminiApiKeys'], (result) => {
        resolve(result);
      });
    });
    const aiMode = aiSettings.aiTranscriptionMode || 'off';
    const hasApiKey = !!aiSettings.geminiApiKey || hasActiveGeminiKeyForSubtitles(aiSettings.geminiApiKeys);

    let subtitlesData =
      await window.databaseManager?.loadSubtitlesFromIndexedDB?.(videoId);
    if (subtitlesData && window.databaseManager?.normalizeSubtitlesForActiveMode) {
      subtitlesData = await window.databaseManager.normalizeSubtitlesForActiveMode(subtitlesData, aiMode);
    }
    if (window.DEBUG)
      console.log(
        `[SubtitleButton DEBUG] loadSubtitles: subtitlesData from DB:`,
        subtitlesData
      );

    // In ALWAYS, the normalized active default already respects strict mode
    // vs YouTube fallback, so do not require Gemini-only cache here.
    if (aiMode === 'always' && hasApiKey && !forceLoad) {
      const hasActiveDefault = !!(
        subtitlesData?.hasActiveDefault ||
        subtitlesData?.sentenceSRT?.trim()
      );
      const hasTranslationSRT = !!subtitlesData?.translationSRT?.trim();

      if (subtitlesData && (hasActiveDefault || hasTranslationSRT)) {
        if (window.DEBUG) console.log('[SubtitleButton] 🤖 Found active subtitles in cache - loading (ALWAYS mode)');
      } else {
        if (window.DEBUG) console.log('[SubtitleButton] 🤖 No active subtitles in cache - returning false to force fetch (ALWAYS mode)');
        window.subtitleState.sentences = [];
        window.subtitleState.words = [];
        window.subtitleState.isRTL = false;
        window.subtitleState.isCustomPrompt = false;
        return false;
      }
    }

    if (
      !subtitlesData ||
      (!subtitlesData.sentenceSRT?.trim() && !subtitlesData.wordSRT?.trim() && !subtitlesData.translationSRT?.trim())
    ) {
      // Not a warning - this is normal when video has no subtitles
      console.log(
        `[SubtitleButton] No subtitles in IndexedDB for video ${videoId} - will try to fetch`
      );
      window.subtitleState.sentences = [];
      window.subtitleState.words = [];
      window.subtitleState.isRTL = false;
      window.subtitleState.isCustomPrompt = false;
      return false;
    }

    // 🎯 Store custom prompt flag in subtitleState for carousel visibility control
    // But only if it matches the currently selected prompt!
    let isCustomPromptActive = false;
    if (subtitlesData.isCustomPrompt && subtitlesData.customPromptId) {
      try {
        const result = await chrome.storage.local.get(['selectedPromptId']);
        const selectedPromptId = result.selectedPromptId || 'default';

        // Only set flag if custom prompt matches currently selected prompt
        if (selectedPromptId === subtitlesData.customPromptId) {
          isCustomPromptActive = true;
          console.log('[SubtitleButton] ✅ Custom prompt matches selected prompt - carousel will skip subtitles');
        } else {
          console.log('[SubtitleButton] ⚠️ Custom prompt mismatch - DB:', subtitlesData.customPromptId, 'Selected:', selectedPromptId);
          console.log('[SubtitleButton] 🔄 Will use default prompt data instead');
        }
      } catch (e) {
        console.warn('[SubtitleButton] Failed to check selected prompt:', e);
      }
    }
    window.subtitleState.isCustomPrompt = isCustomPromptActive;

    let isRTL = false;

    // 🆕 בדיקה אם המשתמש בחר תרגום
    let useTranslation = false;
    let translationIncludeOriginal = false;
    let translationSecondaryLanguage = null;
    try {
      const selectionResult = await chrome.storage.local.get([
        'showTranslation',
        'translationIncludeOriginal',
        'translationSecondaryLanguage'
      ]);
      useTranslation = selectionResult.showTranslation === true;
      translationIncludeOriginal = selectionResult.translationIncludeOriginal === true;
      const secondaryRaw =
        typeof selectionResult.translationSecondaryLanguage === 'string'
          ? selectionResult.translationSecondaryLanguage.trim()
          : '';
      translationSecondaryLanguage = secondaryRaw || null;
    } catch (e) {
      console.warn("[SubtitleButton] Failed to check translation mode:", e);
    }

    // OFF mode is YouTube-only. Ignore translation selection and force DEFAULT.
    if (aiMode === 'off' && useTranslation) {
      console.log('[SubtitleButton] AI mode OFF - forcing DEFAULT subtitles');
      useTranslation = false;
    }

    // 🆕 שמור את useTranslation ב-subtitleState לשימוש בהמשך
    window.subtitleState.useTranslation = useTranslation;
    window.subtitleState.translationIncludeOriginal =
      useTranslation && translationIncludeOriginal;
    window.subtitleState.translationSecondaryLanguage =
      useTranslation ? translationSecondaryLanguage : null;
    window.subtitleState.isSingleLanguageTranslation =
      useTranslation &&
      !window.subtitleState.translationIncludeOriginal &&
      !window.subtitleState.translationSecondaryLanguage;
    window.subtitleState.geminiDefaultMergePairsByIndex = null;
    window.subtitleState.activeDefaultSource =
      subtitlesData?.activeDefaultSource === "gemini" ? "gemini" : "youtube";

    const fallbackSourceKey = window.databaseManager?.resolveSubtitleOffsetSourceKey
      ? window.databaseManager.resolveSubtitleOffsetSourceKey({
        useTranslation,
        activeDefaultSource: window.subtitleState.activeDefaultSource,
      })
      : (useTranslation
        ? "gemini_translation"
        : window.subtitleState.activeDefaultSource === "gemini"
          ? "gemini_default"
          : "youtube_default");

    window.subtitleState.timingSourceKey = fallbackSourceKey;
    window.subtitleState.timing_offset = 0;

    if (window.databaseManager?.getSubtitleOffsetForActiveSource) {
      try {
        const offsetResult = await window.databaseManager.getSubtitleOffsetForActiveSource(
          videoId,
          {
            useTranslation,
            aiMode,
            subtitlesData,
          }
        );
        window.subtitleState.timing_offset = Number(offsetResult?.offset) || 0;
        window.subtitleState.timingSourceKey =
          offsetResult?.sourceKey || fallbackSourceKey;
      } catch (offsetError) {
        console.warn("[SubtitleButton] Failed to load subtitle timing offset:", offsetError);
      }
    }

    // 🎯 Validate that we have the required data for the selected prompt
    const hasTranslation = !!(subtitlesData.translationSRT?.trim());
    const hasDefault = !!(subtitlesData.sentenceSRT?.trim());

    // If user wants TRANSLATION but we only have DEFAULT → return false
    if (useTranslation && !hasTranslation) {
      console.log('[SubtitleButton] ⚠️ User wants TRANSLATION but only DEFAULT in cache - returning false');
      window.subtitleState.sentences = [];
      window.subtitleState.words = [];
      return false;
    }

    // If user wants DEFAULT but we only have TRANSLATION → return false
    if (!useTranslation && !hasDefault && hasTranslation) {
      console.log('[SubtitleButton] ⚠️ User wants DEFAULT but only TRANSLATION in cache - returning false');
      window.subtitleState.sentences = [];
      window.subtitleState.words = [];
      return false;
    }

    // 🆕 בחירת ה-SRT המתאים
    const useSRT = (useTranslation && hasTranslation)
      ? subtitlesData.translationSRT
      : subtitlesData.sentenceSRT;

    if (useSRT?.trim()) {
      const parsedResult = parseSRT(useSRT);
      window.subtitleState.sentences = parsedResult.subtitles;
      isRTL = parsedResult.isRTL;
      if (window.DEBUG)
        console.log(
          `[SubtitleButton] loadSubtitles: Loaded ${parsedResult.subtitles.length} sentence subtitles. isRTL: ${isRTL}`, useTranslation ? '(translation)' : '(default)'
        );
    } else {
      window.subtitleState.sentences = [];
    }

    if (
      !window.subtitleModeState?.isSubtitleMode &&
      subtitlesData.wordSRT?.trim()
    ) {
      const parsedWords = parseSRT(subtitlesData.wordSRT);
      window.subtitleState.words = parsedWords.subtitles;
      if (!isRTL && parsedWords.isRTL) {
        isRTL = true;
      }
      if (window.DEBUG)
        console.log(
          `[SubtitleButton] loadSubtitles: Loaded ${parsedWords.subtitles.length} word timings. Overall isRTL: ${isRTL}`
        );
    } else {
      window.subtitleState.words = [];
    }

    window.subtitleState.isRTL = isRTL;

    if (
      window.subtitleState.sentences.length === 0 &&
      window.subtitleState.words.length === 0
    ) {
      console.warn(
        `[SubtitleButton] loadSubtitles: No actual subtitle content after parsing for video ${videoId}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      "[SubtitleButton] loadSubtitles: Error loading subtitles from IndexedDB:",
      error
    );
    showError("Error loading subtitles: " + error.message);
    window.subtitleState.sentences = [];
    window.subtitleState.words = [];
    window.subtitleState.isRTL = false;
    window.subtitleState.isCustomPrompt = false;
    return false;
  }
}

// Export loadSubtitles for use by other modules (e.g., chordCarousel)
window.loadSubtitles = loadSubtitles;

// ------------------------------
// 🔄 Subtitle Refresh API for Prompt Changes
// ------------------------------
window.ycSubtitles = {
  /**
   * Refresh subtitles when prompt changes in popup
   */
  async refreshWithNewPrompt(showTranslation, selectedCustomPromptId = null) {
    console.log('[SubtitleButton] 🔄 Refreshing with new prompt:', {
      showTranslation: showTranslation ? 'TRANSLATION' : 'DEFAULT',
      customPromptId: selectedCustomPromptId || 'none'
    });

    if (!window.subtitleState?.isVisible) {
      console.log('[SubtitleButton] ⏸️ Subtitles not visible - ignoring');
      return;
    }

    const currentUrl = window.location.href;
    const videoId = window.ycUtils?.extractVideoId?.(currentUrl);
    if (!videoId) return;

    try {
      const aiModeSettings = await chrome.storage.local.get(['aiTranscriptionMode']);
      const aiMode = aiModeSettings.aiTranscriptionMode || 'off';
      const canUseGemini = aiMode === 'auto' || aiMode === 'always';

      let subtitlesData = await window.databaseManager?.loadFromDatabase?.('subtitles', videoId);
      if (subtitlesData && window.databaseManager?.normalizeSubtitlesForActiveMode) {
        subtitlesData = await window.databaseManager.normalizeSubtitlesForActiveMode(subtitlesData, aiMode);
      }

      if (!subtitlesData) {
        console.log('[SubtitleButton] ⚠️ No data in IndexedDB - hiding subtitles');
        this.hide();
        return;
      }

      const hasTranslation = !!(subtitlesData.translationSRT?.trim());
      if (aiMode === 'off' && showTranslation && !selectedCustomPromptId) {
        console.log('[SubtitleButton] AI mode OFF - ignoring TRANSLATION refresh request');
        showTranslation = false;
      }
      const hasDefault = !!(
        subtitlesData.hasActiveDefault ||
        subtitlesData.sentenceSRT?.trim()
      );
      const hasCustom = !!(subtitlesData.customPromptResponse?.trim());
      const customPromptMatches = selectedCustomPromptId === subtitlesData.customPromptId;

      console.log('[SubtitleButton] 🔍 Data check:', {
        hasTranslation,
        hasDefault,
        hasCustom,
        customPromptMatches,
        selectedCustomPromptId,
        cachedCustomPromptId: subtitlesData.customPromptId
      });

      // 🎯 Check if we have the required data
      let needsData = false;

      if (selectedCustomPromptId && (!hasCustom || !customPromptMatches)) {
        console.log('[SubtitleButton] ⚠️ Custom prompt not in cache or mismatch');
        needsData = true;
      } else if (showTranslation && !hasTranslation) {
        console.log('[SubtitleButton] ⚠️ Translation not in cache');
        needsData = true;
      } else if (!showTranslation && !selectedCustomPromptId && !hasDefault) {
        console.log('[SubtitleButton] ⚠️ Default not in cache');
        needsData = true;
      }

      if (needsData) {
        if (!canUseGemini) {
          console.log('[SubtitleButton] AI mode OFF - fetching missing DEFAULT subtitles from YouTube without Gemini progress');
        } else {
          console.log('[SubtitleButton] 🚀 Fetching missing data from Gemini...');
        }

        // Show progress bar only when Gemini can actually run.
        if (canUseGemini) {
          const video = document.querySelector('video.html5-main-video');
          const durationMinutes = video?.duration ? video.duration / 60 : 3;

          if (window.extractorModule?.createSubtitlesProgressBar) {
            console.log('[SubtitleButton] 🎬 Creating progress bar...');
            window.extractorModule.createSubtitlesProgressBar(durationMinutes);
          }
        }

        // 🎯 Set flag to ignore custom prompts
        window.ycIgnoreCustomPromptForSubtitles = true;
        console.log('[SubtitleButton] 🎯 Ignoring custom prompts during refresh');

        try {
          // Fetch data
          await window.youtubeSubtitles.fetchAndSaveYouTubeSubtitles(videoId, null, null, {
            showDefault: !showTranslation && !selectedCustomPromptId,
            selectedCustomPromptId: selectedCustomPromptId,
            showTranslation: showTranslation
          });

          console.log('[SubtitleButton] ✅ Data fetched successfully');
        } finally {
          // 🎯 Always clear the flag
          window.ycIgnoreCustomPromptForSubtitles = false;
        }
      } else {
        console.log('[SubtitleButton] ✅ Data already in cache');
      }

      // Reload and display subtitles (always, whether we fetched or not)
      console.log('[SubtitleButton] 🔄 Reloading subtitles...');
      await loadSubtitles();

    } catch (error) {
      console.error('[SubtitleButton] Error refreshing:', error);
      this.hide();
    }
  },

  /**
   * 🔄 Handle translation refresh from popup
   * Called when user clicks "Refresh" button in popup after changing translation settings
   */
  async handleTranslationRefresh(videoId) {
    console.log('[SubtitleButton] 🔄 Translation refresh requested for video:', videoId);

    // Check if subtitles are visible
    if (!window.subtitleState?.isVisible) {
      console.log('[SubtitleButton] ⏸️ Subtitles not visible - ignoring translation refresh');
      return;
    }

    // Check if this is the current video
    const currentVideoId = window.ycUtils?.extractVideoId?.(window.location.href);
    if (currentVideoId !== videoId) {
      console.log('[SubtitleButton] ⚠️ Video ID mismatch - ignoring translation refresh');
      return;
    }

    // Check if user is viewing translation mode
    const userSettings = await new Promise((resolve) => {
      chrome.storage.local.get(['showTranslation'], (result) => resolve(result));
    });

    if (!userSettings.showTranslation) {
      console.log('[SubtitleButton] ℹ️ User not in translation mode - ignoring refresh');
      return;
    }

    console.log('[SubtitleButton] 🚀 Starting translation refresh...');

    // Show progress bar
    const video = document.querySelector('video.html5-main-video');
    const durationMinutes = video?.duration ? video.duration / 60 : 3;

    if (window.extractorModule?.createSubtitlesProgressBar) {
      console.log('[SubtitleButton] 🎬 Creating progress bar...');
      window.extractorModule.createSubtitlesProgressBar(durationMinutes);
    }

    // Set flag to ignore custom prompts
    window.ycIgnoreCustomPromptForSubtitles = true;

    try {
      // Fetch new translation from Gemini
      await window.youtubeSubtitles.fetchAndSaveYouTubeSubtitles(videoId, null, null, {
        showDefault: false,
        selectedCustomPromptId: null,
        showTranslation: true
      });

      console.log('[SubtitleButton] ✅ Translation fetched successfully');

      // Reload subtitles with new data
      console.log('[SubtitleButton] 🔄 Reloading subtitles...');
      await loadSubtitles();
    } catch (error) {
      console.error('[SubtitleButton] ❌ Error refreshing translation:', error);
    } finally {
      // Always clear the flag
      window.ycIgnoreCustomPromptForSubtitles = false;
    }
  },

  /**
   * Hide subtitles
   */
  hide() {
    console.log('[SubtitleButton] Hiding subtitles');

    if (window.subtitleState) {
      window.subtitleState.isVisible = false;
    }

    const button = document.querySelector('.ytp-subtitle-button');
    if (button) {
      button.classList.remove('subtitle-button-active');
    }

    if (window.subtitleState?.overlay) {
      window.subtitleState.overlay.style.display = 'none';
    }
    if (window.subtitleState?.textContainer) {
      window.subtitleState.textContainer.style.display = 'none';
    }
  }
};

// ------------------------------
// 🚀 Listen to prompt changes from popup
// ------------------------------
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.command === 'promptChanged') {
    console.log('[SubtitleButton] 📨 Received promptChanged message');

    // Check if subtitles are visible
    if (!window.subtitleState?.isVisible) {
      console.log('[SubtitleButton] ⏸️ Subtitles not visible - ignoring prompt change');
      return;
    }

    console.log('[SubtitleButton] 🔄 Subtitles visible - refreshing with new prompt...');

    try {
      // Refresh subtitles with new prompt
      if (window.ycSubtitles?.refreshWithNewPrompt) {
        await window.ycSubtitles.refreshWithNewPrompt(
          message.showTranslation,
          message.selectedCustomPromptId
        );
      }
    } catch (error) {
      console.error('[SubtitleButton] Error handling prompt change:', error);
    }
  }
});

// ------------------------------
// 6. הצגת הודעות שגיאה
// ------------------------------
const showError = (message, duration = 5000) => {
  if (window.ycUtils && window.ycUtils.showErrorOverlay) {
    window.ycUtils.showErrorOverlay(message, duration);
    return;
  }
  const videoPlayer = document.querySelector(".html5-video-player");
  if (!videoPlayer) return;

  const errorOverlay = createDOMElement(
    "div",
    "yc-error-message-local",
    `
    position: absolute; bottom: 70px; left: 50%; transform: translateX(-50%);
    background: rgba(200, 0, 0, 0.9); color: white; padding: 10px 15px;
    border-radius: 5px; z-index: 2147483647; font-size: 14px; text-align: center;
  `
  );
  errorOverlay.textContent = message;
  videoPlayer.appendChild(errorOverlay);
  setTimeout(() => errorOverlay.remove(), duration);
};

// ------------------------------
// 7. איתור הכתוביות והמילה הנוכחית לפי זמן
// ------------------------------
const findCurrentSubtitles = (currentTime) => {
  const adjustedTime = currentTime + (window.subtitleState.timing_offset || 0);

  const sentences = window.subtitleState.sentences || [];
  const currentSentenceIndex = sentences.findIndex(
    (sub) => adjustedTime >= sub.startTime && adjustedTime <= sub.endTime
  );
  let currentSentence =
    currentSentenceIndex >= 0 ? sentences[currentSentenceIndex] : null;

  const allowGeminiDefaultMerge =
    !!currentSentence &&
    isGeminiDefaultSubtitleSource() &&
    (window.subtitleModeState?.isSubtitleMode || !window.subtitleState.words?.length);

  if (allowGeminiDefaultMerge && currentSentenceIndex >= 0) {
    if (
      !Array.isArray(window.subtitleState.geminiDefaultMergePairsByIndex) ||
      window.subtitleState.geminiDefaultMergePairsByIndex.length !== sentences.length
    ) {
      window.subtitleState.geminiDefaultMergePairsByIndex =
        buildGeminiDefaultMergePairs(sentences);
    }

    const mergedForCurrentIndex =
      window.subtitleState.geminiDefaultMergePairsByIndex?.[currentSentenceIndex];
    if (mergedForCurrentIndex) {
      currentSentence = mergedForCurrentIndex;
    }
  }

  let currentWord =
    !window.subtitleModeState?.isSubtitleMode && window.subtitleState.words
      ? window.subtitleState.words.find(
          (word) =>
            adjustedTime >= word.startTime && adjustedTime <= word.endTime
        )
      : null;

  // For merged Gemini-DEFAULT subtitle pairs, keep display-only mode (no word highlight mismatch).
  if (currentSentence?._ycMergedGeminiDefault) {
    currentWord = null;
  }
  return { currentSentence, currentWord };
};

// ------------------------------
// 7.5 פונקציה גלובלית previewSubtitles
// ------------------------------
// • מקבלת ‎time‎ (שניות) ומרנדרת מיידית כתוביות למיקום זה—ל-"Preview" בעת גרירה
// • משתמשת באותן SPANS ממוחזרים → אין הקצאות חדשות → ללא דליפות RAM
// • אם הכתוביות אינן פעילות – יוצאת מיד (early-return)
// • שומרת על הלוגיקה של highlight כמו בפונקציה updateSubtitles
window.previewSubtitles = function (time) {
  if (!window.subtitleState?.isVisible) return; // ‎⟵‎ אין כתוביות מוצגות

  // מאתרים משפט + מילה בזמן שרירותי (לא video.currentTime)
  const { currentSentence, currentWord } = findCurrentSubtitles(time);

  // רענון תוכן <span>-ים ממוחזרים – אותה פונקציה שמשמשת בזמן Play
  populateRecycledWordSpans(
    currentSentence,
    currentWord,
    window.subtitleState.line1WordSpans,
    window.subtitleState.line2WordSpans,
    window.subtitleState.line3WordSpans,
    window.subtitleState.line4WordSpans,
    window.subtitleState.line5WordSpans,
    window.subtitleState.line6WordSpans,
    window.subtitleState.line7WordSpans,
    window.subtitleState.line8WordSpans
  );

  // הצגת / הסתרת מיכל הטקסט בהתאם למצב
  if (currentSentence && window.subtitleState.textContainer) {
    window.subtitleState.textContainer.style.display = "inline-block";
  } else if (window.subtitleState.textContainer) {
    window.subtitleState.textContainer.style.display = "none";
  }
};

if (!window.__ycSubtitleTimingOffsetListenerBound) {
  window.__ycSubtitleTimingOffsetListenerBound = true;
  window.addEventListener("yc:subtitleTimingOffsetChanged", (e) => {
    if (!window.subtitleState?.isVisible) return;

    const currentVideoId = window.ycUtils?.extractVideoId
      ? window.ycUtils.extractVideoId(window.location.href)
      : new URLSearchParams(location.search).get("v");
    const eventVideoId = e?.detail?.videoId;
    if (eventVideoId && currentVideoId && eventVideoId !== currentVideoId) return;

    const video =
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video");
    if (!video) return;

    window.previewSubtitles?.(video.currentTime);
  });
}

// ---------- 8. חלוקה אופטימלית של מערך מילים (עפ״י מספר-תווים) ----------

/* חישוב אורך כולל של מקטע (מילים+רווחים) */
function computeSegmentLength(wordsArr) {
  return (
    wordsArr.reduce((s, w) => s + w.text.trim().length, 0) +
    (wordsArr.length > 1 ? wordsArr.length - 1 : 0)
  );
}

/* 1) balanced 50-50  (כשהטקסט ≤ 53 תווים) */
function balancedTextSplit(words) {
  if (!words || words.length <= 1) return [words];
  const total = words.map((w) => w.text).join(" ");
  const targetLen = Math.ceil(total.length * 0.5);
  let curr = 0,
    i = 0;
  for (; i < words.length - 1; i++) {
    curr += words[i].text.length + (i > 0 ? 1 : 0);
    if (curr >= targetLen) break;
  }
  if (i === 0) i = 1; // וידוא שיש מילה בשורה 1
  return [words.slice(0, i), words.slice(i)];
}

/* 2) פיצול "even" כשהטקסט חורג מ-53 תווים */
function evenSegmentWords(words, maxLen) {
  const segments = [],
    totalLen = computeSegmentLength(words);
  let remaining = [...words],
    segs = Math.ceil(totalLen / maxLen);
  for (let s = 0; s < segs - 1; s++) {
    let curr = 0,
      best = 1,
      bestDiff = Infinity,
      ideal = computeSegmentLength(remaining) / (segs - s);
    for (let i = 0; i < remaining.length; i++) {
      curr += (i ? 1 : 0) + remaining[i].text.length;
      if (curr > maxLen) break;
      const d = Math.abs(curr - ideal);
      if (d < bestDiff) {
        bestDiff = d;
        best = i + 1;
      }
    }
    segments.push(remaining.slice(0, best));
    remaining = remaining.slice(best);
  }
  segments.push(remaining);
  return segments;
}

/* 3) fine-tune לאיזון טוב יותר */
function adjustSegmentation(seg, maxLen) {
  if (seg.length < 2) return seg;
  const join = (t) => t.map((w) => w.text).join(" ");
  const [a, b] = seg;
  if (!b.length) return seg;
  const candidate = [...a, b[0]];
  if (
    join(candidate).length <= maxLen &&
    Math.abs(join(candidate).length - join(b.slice(1)).length) <
    Math.abs(join(a).length - join(b).length)
  ) {
    seg[0] = candidate;
    seg[1] = b.slice(1);
  }
  return seg.filter((line) => line.length);
}

/*  ===> ה-API הראשי: */
function segmentByCharRules(words) {
  const full = words.map((w) => w.text).join(" ");
  let seg;
  if (full.length < MIN_SPLIT_LENGTH) {
    seg = [words]; // שורה בודדת
  } else if (full.length <= MAX_CHARS_PER_LINE) {
    seg = balancedTextSplit(words); // 50-50
  } else {
    seg = evenSegmentWords(words, MAX_CHARS_PER_LINE);
    seg = adjustSegmentation(seg, MAX_CHARS_PER_LINE);
  }
  return seg.slice(0, MAX_LINES); // מקס׳ 4 שורות
}

// ------------------------------
// 🆕 Split text into balanced lines (for dual-language subtitles)
// ------------------------------
function splitTextBalanced(text, maxCharsPerLine) {
  if (!text || text.length <= maxCharsPerLine) {
    return [text];
  }

  const words = text.split(' ');

  // חישוב כמה שורות צריך
  const numLines = Math.ceil(text.length / maxCharsPerLine);

  // חלוקה מאוזנת - כל שורה תקבל בערך אותו מספר מילים
  const wordsPerLine = Math.ceil(words.length / numLines);

  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const lineWords = words.slice(i, i + wordsPerLine);
    lines.push(lineWords.join(' '));
  }

  return lines;
}

function splitGeminiDefaultNetflixLines(text, durationSec = 0) {
  const normalized = normalizeSubtitleText(text);
  if (!normalized) return [];

  // Keep single short lines when timing and length make it naturally readable.
  if (
    normalized.length <= MIN_SPLIT_LENGTH ||
    (normalized.length <= MAX_CHARS_PER_LINE && durationSec <= 2.2)
  ) {
    return [normalized];
  }

  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 2) return [normalized];

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ");
    const right = words.slice(i).join(" ");
    if (!left || !right) continue;

    const leftLen = left.length;
    const rightLen = right.length;
    const maxLen = Math.max(leftLen, rightLen);
    const minLen = Math.min(leftLen, rightLen);
    const lengthDiff = Math.abs(leftLen - rightLen);
    const overflowPenalty =
      Math.max(0, leftLen - MAX_CHARS_PER_LINE) +
      Math.max(0, rightLen - MAX_CHARS_PER_LINE);
    const tinyLinePenalty = minLen < 8 ? 14 : 0;
    const score = overflowPenalty * 25 + lengthDiff + tinyLinePenalty;

    if (score < bestScore) {
      bestScore = score;
      best = [left, right, maxLen, minLen];
    }
  }

  if (best) {
    const [left, right, maxLen, minLen] = best;
    const acceptable =
      minLen >= 8 &&
      (maxLen <= MAX_CHARS_PER_LINE + 8 || normalized.length <= MAX_CHARS_PER_LINE + 14);

    if (acceptable) {
      return [left, right];
    }
  }

  // Fallback: keep all text, prefer two lines, avoid dropping words.
  const fallback = splitTextBalanced(normalized, MAX_CHARS_PER_LINE).filter(Boolean);
  if (fallback.length <= 2) return fallback;
  return [fallback[0], fallback.slice(1).join(" ")];
}

// ------------------------------
// 9. עיבוד הכתוביות לאלמנטי SPAN ממוחזרים
// ------------------------------
function populateRecycledWordSpans(
  sentence,
  currentWord,
  line1Spans,
  line2Spans,
  line3Spans = [],
  line4Spans = [],
  line5Spans = [],
  line6Spans = [],
  line7Spans = [],
  line8Spans = []
) {
  // נקה את תוכן ה-spans הקיימים - כל 8 השורות
  [line1Spans, line2Spans, line3Spans, line4Spans, line5Spans, line6Spans, line7Spans, line8Spans].forEach((lineSpans) => {
    if (lineSpans) {
      lineSpans.forEach((span) => {
        span.textContent = "";
        span.style.display = "none";
        span.className = "regular-subtitle-word";
        span.style.backgroundColor = "";
        span.style.color = window.currentSubtitleColor || "#FFFFFF";
        span.style.opacity = getSubtitleFontOpacityValue();
      });
    }
  });

  if (!sentence?.text) return;

  let textToProcess = sentence.text;
  let wordsInSentence =
    window.subtitleState.words
      ?.filter(
        (word) =>
          word.startTime >= sentence.startTime &&
          word.endTime <= sentence.endTime
      )
      .map((word) => ({ ...word, text: normalizeWord(word.text) })) || [];

  /* ⭐️ אם המילה הראשונה היא רק סימן פיסוק – מדלגים, כדי שלא תהיה
       שורה נפרדת של "." בלבד                                */
  if (
    wordsInSentence.length &&
    LEADING_PUNCT_REGEX.test(wordsInSentence[0].text)
  ) {
    wordsInSentence.shift();
  }

  if (
    window.subtitleModeState?.isSubtitleMode ||
    wordsInSentence.length === 0
  ) {
    // 🆕 זיהוי דו-לשוני בטקסט עצמו
    const textWords = textToProcess.split(/\s+/);
    let textHasRTL = false;
    let textHasLTR = false;

    textWords.forEach(word => {
      if (isRTLText(word)) {
        textHasRTL = true;
      } else if (word.trim()) {
        textHasLTR = true;
      }
    });

    const isTextDualLanguage = textHasRTL && textHasLTR;

    // אם זוהה דו-לשוני - פצל לפי שפה
    if (isTextDualLanguage) {
      const rtlWords = [];
      const ltrWords = [];

      textWords.forEach(word => {
        if (isRTLText(word)) {
          rtlWords.push(word);
        } else if (word.trim()) {
          ltrWords.push(word);
        }
      });

      const rtlText = rtlWords.join(' ');
      const ltrText = ltrWords.join(' ');

      let lineIndex = 0;

      // הצג עברית קודם (למעלה)
      if (rtlText) {
        const rtlLines = splitTextBalanced(rtlText, MAX_CHARS_PER_LINE);
        rtlLines.forEach((lineText) => {
          lineIndex++;
          const targetSpans = window.subtitleState[`line${lineIndex}WordSpans`];
          const lineElement = window.subtitleState[`line${lineIndex}Element`];

          if (targetSpans && targetSpans[0]) {
            targetSpans[0].textContent = lineText;
            targetSpans[0].style.display = "inline";
            targetSpans[0].className = "regular-subtitle-line-full";
            targetSpans[0].style.direction = "rtl";
            applySubtitleElementPreferences(targetSpans[0]);
          }

          // 🎬 הוסף text-align ל-LINE ELEMENT (parent)
          if (lineElement) {
            lineElement.style.textAlign = "right";
          }
        });
      }

      // הצג אנגלית אחר כך (למטה)
      if (ltrText) {
        const ltrLines = splitTextBalanced(ltrText, MAX_CHARS_PER_LINE);
        ltrLines.forEach((lineText) => {
          lineIndex++;
          const targetSpans = window.subtitleState[`line${lineIndex}WordSpans`];
          const lineElement = window.subtitleState[`line${lineIndex}Element`];

          if (targetSpans && targetSpans[0]) {
            targetSpans[0].textContent = lineText;
            targetSpans[0].style.display = "inline";
            targetSpans[0].className = "regular-subtitle-line-full";
            targetSpans[0].style.direction = "ltr";
            applySubtitleElementPreferences(targetSpans[0]);
          }

          // 🎬 הוסף text-align ל-LINE ELEMENT (parent), לא ל-span!
          if (lineElement) {
            lineElement.style.textAlign = "left";
          }
        });
      }

      return;
    }

    // 🆕 לוגיקה לשפה אחת (DEFAULT או TRANSLATE)
    const isGeminiDefault = isGeminiDefaultSubtitleSource();
    const isGeminiTranslation =
      window.subtitleState?.timingSourceKey === "gemini_translation";

    const useDefaultSingleLanguageLayout =
      isGeminiDefault ||
      (isGeminiTranslation && window.subtitleState?.isSingleLanguageTranslation === true);

    if (isGeminiDefault || isGeminiTranslation) {
      const sentenceDurationSec = Math.max(
        0,
        (sentence?.endTime || 0) - (sentence?.startTime || 0)
      );
      const singleLangLines = useDefaultSingleLanguageLayout
        ? splitGeminiDefaultNetflixLines(textToProcess, sentenceDurationSec)
        : splitTextBalanced(textToProcess, MAX_CHARS_PER_LINE);
      const safeLines =
        singleLangLines && singleLangLines.length > 0
          ? singleLangLines
          : [normalizeSubtitleText(textToProcess)];
      const limitedLines = useDefaultSingleLanguageLayout
        ? safeLines.slice(0, 2)
        : safeLines.slice(0, 4);

      // 🎬 זיהוי כיוון השפה
      const isRTL = isRTLText(textToProcess);

      limitedLines.forEach((lineText, idx) => {
        const lineNum = idx + 1;
        const targetSpans = window.subtitleState[`line${lineNum}WordSpans`];
        const lineElement = window.subtitleState[`line${lineNum}Element`];

        if (targetSpans && targetSpans[0]) {
          targetSpans[0].textContent = lineText;
          targetSpans[0].style.display = "inline";
          targetSpans[0].className = "regular-subtitle-line-full";
          targetSpans[0].style.direction = isRTL ? "rtl" : "ltr";
          applySubtitleElementPreferences(targetSpans[0]);
        }

        // 🎬 הוסף text-align ל-LINE ELEMENT
        if (lineElement) {
          lineElement.style.textAlign = isRTL ? "right" : "left";
        }
      });
    } else {
      // YouTube או ללא GEMINI - לוגיקה ישנה (2 שורות בלבד)
      const lines = textToProcess.split("\n").slice(0, 2);

      // 🎬 זיהוי כיוון השפה
      const isRTL = isRTLText(textToProcess);

      if (lines[0] && line1Spans[0]) {
        line1Spans[0].textContent = lines[0];
        line1Spans[0].style.display = "inline";
        line1Spans[0].className = "regular-subtitle-line-full";
        line1Spans[0].style.direction = isRTL ? "rtl" : "ltr";
        applySubtitleElementPreferences(line1Spans[0]);

        // 🎬 הוסף text-align ל-LINE ELEMENT
        if (window.subtitleState.line1Element) {
          window.subtitleState.line1Element.style.textAlign = isRTL ? "right" : "left";
        }
      }
      if (lines[1] && line2Spans[0]) {
        line2Spans[0].textContent = lines[1];
        line2Spans[0].style.display = "inline";
        line2Spans[0].className = "regular-subtitle-line-full";
        line2Spans[0].style.direction = isRTL ? "rtl" : "ltr";
        applySubtitleElementPreferences(line2Spans[0]);

        // 🎬 הוסף text-align ל-LINE ELEMENT גם לשורה 2
        if (window.subtitleState.line2Element) {
          window.subtitleState.line2Element.style.textAlign = isRTL ? "right" : "left";
        }
      }
    }
    return;
  }

  let segmentation = segmentByCharRules(wordsInSentence); // ‎⟵‎ משתמשים בחוקים

  /* --------------------------------------------------------
   * ❶ אם אחת השורות חורגת מהמגבלה – מפצלים אותה שוב
   *    ולאחר מכן לוקחים רק את שתי השורות הראשונות.
   * -------------------------------------------------------- */
  const forceCharLimit = (segment) => {
    const result = [];
    let current = [];
    let lengthSoFar = 0;

    segment.forEach((wordObj) => {
      const wLen = (wordObj.text || "").length;
      const extra = lengthSoFar === 0 ? wLen : wLen + 1; /* +1 = הרווח */

      if (lengthSoFar + extra > MAX_CHARS_PER_LINE && current.length) {
        result.push(current);
        current = [wordObj];
        lengthSoFar = wLen;
      } else {
        if (lengthSoFar) lengthSoFar += 1; /* רווח */
        lengthSoFar += wLen;
        current.push(wordObj);
      }
    });
    if (current.length) result.push(current);
    return result;
  };

  segmentation = segmentation
    .flatMap(forceCharLimit) /* חיתוך לפי ‎MAX_CHARS_PER_LINE‎ */
    .slice(0, MAX_LINES); /* ‎MAX_LINES‎=2 → שתי שורות בלבד */

  segmentation = segmentation.map((segment) =>
    segment.filter((word) => word.text?.trim() !== "")
  );
  segmentation = segmentation.filter((segment) => segment.length > 0);

  segmentation.forEach((segment, lineIndex) => {
    if (segment.length === 0) return;
    const targetSpans = window.subtitleState[`line${lineIndex + 1}WordSpans`];
    let currentSpanIndex = 0;

    segment.forEach((wordObj, wordIdxInSegment) => {
      if (currentSpanIndex < targetSpans.length) {
        const wordSpan = targetSpans[currentSpanIndex];
        wordSpan.textContent = wordObj.text;
        wordSpan.style.display = "inline-block";
        wordSpan.className = "regular-subtitle-word";
        applySubtitleElementPreferences(wordSpan, { highlighted: false });

        wordSpan.dataset.startTime = wordObj.startTime;
        wordSpan.dataset.endTime = wordObj.endTime;
        wordSpan.dataset.duration = (
          wordObj.endTime - wordObj.startTime
        ).toFixed(3);

        if (
          currentWord &&
          window.subtitleModeState?.isLyricsHighlightEnabled !== false
        ) {
          const normalizedCurrentWordText = normalizeWord(currentWord.text);
          const normalizedWordObjText = wordObj.text;

          const wordStartTimeMs = Math.round(wordObj.startTime * 1000);
          const currentWordStartTimeMs = Math.round(
            currentWord.startTime * 1000
          );
          const toleranceMs = 50;

          if (
            normalizedWordObjText === normalizedCurrentWordText &&
            Math.abs(wordStartTimeMs - currentWordStartTimeMs) <= toleranceMs
          ) {
            wordSpan.classList.add("highlighted");
            applySubtitleElementPreferences(wordSpan, { highlighted: true });
          }
        }
        currentSpanIndex++;
      }

      if (
        wordIdxInSegment < segment.length - 1 &&
        currentSpanIndex < targetSpans.length
      ) {
        const spaceSpan = targetSpans[currentSpanIndex];
        spaceSpan.textContent = " ";
        spaceSpan.style.display = "inline-block";
        spaceSpan.className = "regular-subtitle-space";
        applySubtitleElementPreferences(spaceSpan, { highlighted: false });
        currentSpanIndex++;
      }
    });
  });
}

// ------------------------------
// 10. פונקציות עזר להדגשה ופיסוק
// ------------------------------
function getFinalHighlightColor(baseColor, opacityPercent) {
  let opacity = parseFloat(opacityPercent) / 100;
  if (isNaN(opacity) || opacity < 0 || opacity > 1) opacity = 0.5;

  if (!baseColor) return `rgba(255, 255, 0, ${opacity})`;

  const colorMatch = baseColor.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/
  );
  if (colorMatch) {
    const [, r, g, b] = colorMatch;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  if (
    baseColor.startsWith("#") &&
    (baseColor.length === 4 || baseColor.length === 7)
  ) {
    let r = 0,
      g = 0,
      b = 0;
    if (baseColor.length === 4) {
      r = parseInt(baseColor[1] + baseColor[1], 16);
      g = parseInt(baseColor[2] + baseColor[2], 16);
      b = parseInt(baseColor[3] + baseColor[3], 16);
    } else {
      r = parseInt(baseColor.substring(1, 3), 16);
      g = parseInt(baseColor.substring(3, 5), 16);
      b = parseInt(baseColor.substring(5, 7), 16);
    }
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
  }
  return `rgba(255, 255, 0, ${opacity})`;
}

function getSubtitleFontOpacityValue() {
  const opacity = parseInt(window.currentFontOpacity || "100", 10) / 100;
  return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function shouldStyleSentenceLevelSubtitleAsHighlighted() {
  return (
    window.subtitleModeState?.isLyricsHighlightEnabled !== false &&
    (window.subtitleModeState?.isSubtitleMode === true ||
      !(window.subtitleState?.words?.length > 0))
  );
}

function applySubtitleElementPreferences(element, options = {}) {
  if (!element) return;

  const isSentenceLevelLine = element.classList?.contains(
    "regular-subtitle-line-full"
  );
  const shouldHighlight =
    options.highlighted === true ||
    element.classList?.contains("highlighted") ||
    (isSentenceLevelLine && shouldStyleSentenceLevelSubtitleAsHighlighted());

  element.style.opacity = String(getSubtitleFontOpacityValue());

  if (shouldHighlight) {
    element.classList?.add("highlighted");
    element.style.backgroundColor =
      window.currentHighlightBackgroundEnabled === false
        ? "transparent"
        : getFinalHighlightColor(
            window.currentHighlightColor || "rgba(255, 255, 0, 0.5)",
            parseInt(window.currentHighlightOpacity || "50", 10)
          );
    element.style.color =
      !isSentenceLevelLine || window.hasCustomWordHighlightTextColor
        ? window.currentWordHighlightTextColor ||
          window.currentSubtitleColor ||
          "#FFFFFF"
        : window.currentSubtitleColor || "#FFFFFF";
    element.style.borderRadius =
      window.currentHighlightBackgroundEnabled === false ? "0" : "2px";
    return;
  }

  element.classList?.remove("highlighted");
  element.style.backgroundColor = "transparent";
  element.style.color = window.currentSubtitleColor || "#FFFFFF";
}

window.applyCurrentSubtitlePreferences = function () {
  const subtitleElements = document.querySelectorAll(
    ".regular-subtitle-word, .regular-subtitle-punctuation, .regular-subtitle-space, .regular-subtitle-line-full"
  );
  subtitleElements.forEach((element) => applySubtitleElementPreferences(element));

  const container = document.querySelector(".yt-subtitle-container");
  if (container) {
    const bgColor = window.currentBackgroundColor || "rgba(0, 0, 0, 0.8)";
    const bgOpacityPercent = parseInt(
      window.currentBackgroundOpacity || DEFAULT_BG_OPACITY,
      10
    );
    container.style.backgroundColor = getFinalHighlightColor(
      bgColor,
      bgOpacityPercent
    );
  }
};

// ------------------------------
// 11. עדכון הכתוביות בזמן אמת - עם שימוש ב-populateRecycledWordSpans
// ------------------------------
let subtitleVideoElement = null;
const _acquireSubtitleVideoElement = () => {
  if (!subtitleVideoElement || !subtitleVideoElement.isConnected) {
    subtitleVideoElement = document.querySelector("video");
  }
  return subtitleVideoElement;
};

const updateSubtitles = debounce(() => {
  requestAnimationFrame(() => {
    // אם אין כתוביות גלויות, לא צריך לעדכן
    if (!window.subtitleState || !window.subtitleState.isVisible) {
      return;
    }
    if (
      !window.subtitleState ||
      !window.subtitleState.overlay ||
      !window.subtitleState.isVisible ||
      !window.subtitleState.line1Element ||
      !window.subtitleState.line2Element ||
      !window.subtitleState.overlay.isConnected
    ) {
      if (window.DEBUG && window.subtitleState?.isVisible) {
        console.warn(
          "[updateSubtitles] Aborting update: essential elements missing or overlay not connected, though isVisible is true."
        );
      }
      return;
    }

    const video = _acquireSubtitleVideoElement();
    const container = window.subtitleState.textContainer;
    if (!video) return;

    const { currentSentence, currentWord } = findCurrentSubtitles(
      video.currentTime
    );

    if (currentSentence) {
      populateRecycledWordSpans(
        currentSentence,
        currentWord,
        window.subtitleState.line1WordSpans,
        window.subtitleState.line2WordSpans,
        window.subtitleState.line3WordSpans,
        window.subtitleState.line4WordSpans,
        window.subtitleState.line5WordSpans,
        window.subtitleState.line6WordSpans,
        window.subtitleState.line7WordSpans,
        window.subtitleState.line8WordSpans
      );

      if (container) {
        container.style.display = "inline-block";
        container.style.setProperty(
          "--subtitle-size",
          `${window.subtitleState.sizePercentage || "300"}%`
        );
        const bgColor = window.currentBackgroundColor || "rgba(0, 0, 0, 0.8)";
        const bgOpacityPercent = parseInt(
          window.currentBackgroundOpacity || DEFAULT_BG_OPACITY
        );
        container.style.backgroundColor = getFinalHighlightColor(
          bgColor,
          bgOpacityPercent
        );
        if (window.subtitleState.isRTL) {
          container.classList.add("rtl");
        } else {
          container.classList.remove("rtl");
        }
      }
    } else {
      window.subtitleState.line1WordSpans.forEach((span) => {
        span.textContent = "";
        span.style.display = "none";
      });
      window.subtitleState.line2WordSpans.forEach((span) => {
        span.textContent = "";
        span.style.display = "none";
      });
      if (container) container.style.display = "none";
    }
  });
});

// ------------------------------
// 12. אתחול הגדרות הכתוביות
// ------------------------------
async function initializeSubtitlePreferences() {
  try {
    const storageArea = chrome.storage?.sync;
    if (!storageArea) {
      console.warn(
        "[SubtitleButton] chrome.storage.sync not available. Using default preferences."
      );
      return; // Defaults are already set at the top
    }

    const result = await storageArea.get([
      "subtitleSize",
      "subtitleColor",
      "subtitleHighlightColor",
      "subtitleHighlightBackgroundEnabled",
      "subtitleFontOpacity",
      "subtitleBackgroundColor",
      "subtitleBackgroundOpacity",
      "subtitleWordCountdownType",
      "subtitleLyricsMode",
      "subtitleSubtitleMode",
      "subtitleLastMode",
      "subtitleLyricsHighlightEnabled",
      "subtitleChordsHighlightEnabled",
      "subtitleWordHighlightTextColor",
    ]);

    window.subtitleState.sizePercentage =
      result.subtitleSize || window.subtitleState.sizePercentage;
    window.currentSubtitleColor =
      result.subtitleColor || window.currentSubtitleColor;
    window.currentHighlightColor =
      result.subtitleHighlightColor || window.currentHighlightColor;
    window.currentHighlightBackgroundEnabled =
      result.subtitleHighlightBackgroundEnabled === true;
    window.currentFontOpacity =
      result.subtitleFontOpacity || window.currentFontOpacity;
    window.currentBackgroundColor =
      result.subtitleBackgroundColor || window.currentBackgroundColor;
    window.currentBackgroundOpacity =
      result.subtitleBackgroundOpacity || window.currentBackgroundOpacity;
    window.currentWordCountdownType =
      result.subtitleWordCountdownType || window.currentWordCountdownType;
    window.currentWordHighlightTextColor =
      result.subtitleWordHighlightTextColor ||
      window.currentWordHighlightTextColor;
    window.hasCustomWordHighlightTextColor =
      result.subtitleWordHighlightTextColor != null ||
      window.hasCustomWordHighlightTextColor === true;

    const defaultModeState = {
      isLyricsMode: true,
      isSubtitleMode: false,
      lastMode: "lyrics",
      isLyricsHighlightEnabled: true,
      isChordsHighlightEnabled: false,
    };
    window.subtitleModeState = {
      ...defaultModeState,
      ...(window.subtitleModeState || {}),
      isLyricsMode: result.subtitleLyricsMode !== false,
      isSubtitleMode: result.subtitleSubtitleMode === true,
      lastMode:
        result.subtitleLastMode ||
        window.subtitleModeState?.lastMode ||
        "lyrics",
      isLyricsHighlightEnabled: result.subtitleLyricsHighlightEnabled !== false,
      isChordsHighlightEnabled: result.subtitleChordsHighlightEnabled !== false,
    };

    if (window.DEBUG)
      console.log("[SubtitleButton] Preferences loaded from storage:", {
        result,
        state: window.subtitleState,
        modeState: window.subtitleModeState,
      });
    window.applyCurrentSubtitlePreferences?.();
  } catch (error) {
    console.error("[SubtitleButton] Error initializing preferences:", error);
  }
}

window.changeSubtitleSize = function (percentage) {
  window.subtitleState.sizePercentage = percentage;
  const container = window.subtitleState.overlay?.querySelector(
    ".yt-subtitle-container"
  );
  if (container) {
    container.style.setProperty("--subtitle-size", `${percentage}%`);
  }
  try {
    if (chrome.storage?.sync) {
      chrome.storage.sync.set({ subtitleSize: percentage });
    }
  } catch (error) {
    /* no log */
  }
  updateSubtitles();
};

// ------------------------------
// 13. מאזיני אירועים לווידאו
// ------------------------------
let activeVideoListenersCleanup = null;

function setupVideoEventListeners(signal) {
  const video = _acquireSubtitleVideoElement();

  if (!video) return null;

  const handlers = {
    timeupdate: updateSubtitles,
    seeking: updateSubtitles,
    play: updateSubtitles,
    pause: updateSubtitles,
  };

  const unregisterFunctions = [];

  Object.entries(handlers).forEach(([event, handler]) => {
    const options = { passive: true, signal };
    try {
      video.addEventListener(event, handler, options);
      unregisterFunctions.push(() => {
        try {
          if (video && (!signal || !signal.aborted)) {
            video.removeEventListener(event, handler, options);
          }
        } catch (e) {
          /*ignore*/
        }
      });
    } catch (e) {
      console.warn(
        `[SubtitleButton] Browser might not support AbortSignal in addEventListener for event: ${event}`,
        e
      );
      video.addEventListener(event, handler, { passive: true });
      unregisterFunctions.push(() => {
        try {
          video.removeEventListener(event, handler, { passive: true });
        } catch (err) {
          /*ignore*/
        }
      });
    }
  });

  return () => {
    unregisterFunctions.forEach((unregister) => {
      try {
        unregister();
      } catch (e) {
        /* ignore */
      }
    });
    if (window.DEBUG)
      console.log(
        "[SubtitleButton] Video event listeners cleaned up via returned function."
      );
  };
}

// ------------------------------
// 14. יצירת כפתור הפעלת כתוביות - עם יצירת SPANs ממוחזרים
// ------------------------------
const SUBTITLE_BUTTON_ACTIVE_CLASS = "subtitle-button-active";

// --- NEW: Helper function to ensure all subtitle DOM elements are ready ---
function ensureSubtitleDOM() {
  let createdOrEnsuredSomething = false;
  const videoPlayer = document.querySelector(".html5-video-player");

  if (
    !window.subtitleState.overlay ||
    !window.subtitleState.overlay.isConnected
  ) {
    if (window.subtitleState.overlay) window.subtitleState.overlay.remove();
    window.subtitleState.overlay = createDOMElement(
      "div",
      "yt-subtitle-overlay"
    );
    // style.display will be handled by the click listener
    createdOrEnsuredSomething = true;
  }

  if (
    !window.subtitleState.textContainer ||
    !window.subtitleState.textContainer.isConnected
  ) {
    if (window.subtitleState.textContainer)
      window.subtitleState.textContainer.remove();
    window.subtitleState.textContainer = createDOMElement(
      "div",
      "yt-subtitle-container"
    );
    // Apply initial styles to the text container
    window.subtitleState.textContainer.style.setProperty(
      "--subtitle-size",
      `${window.subtitleState.sizePercentage || "300"}%`
    );
    const bgColor = window.currentBackgroundColor || "rgba(0, 0, 0, 0.8)";
    const bgOpacityPercent = parseInt(
      window.currentBackgroundOpacity || DEFAULT_BG_OPACITY
    );
    window.subtitleState.textContainer.style.backgroundColor =
      getFinalHighlightColor(bgColor, bgOpacityPercent);
    if (window.subtitleState.isRTL)
      window.subtitleState.textContainer.classList.add("rtl");

    window.subtitleState.overlay.appendChild(
      window.subtitleState.textContainer
    );
    createdOrEnsuredSomething = true;
  }

  /* --- יצירת עד 2 div-ים לשורות, עם white-space:normal --- */
  for (let i = 1; i <= MAX_LINES; i++) {
    // כעת יוצר רק line1 & line2
    const key = `line${i}Element`;
    if (!window.subtitleState[key] || !window.subtitleState[key].isConnected) {
      if (window.subtitleState[key]) window.subtitleState[key].remove();

      const lineEl = createDOMElement("div", "yt-subtitle-line");
      lineEl.style.whiteSpace = "normal"; /* שבירה אוטומטית */
      lineEl.style.direction = "inherit"; /* ‎RTL/LTR עובר בירושה */

      window.subtitleState.textContainer.appendChild(lineEl);
      window.subtitleState[key] = lineEl;
      window.subtitleState[`${key}WordSpans`] = [];
    }
  }

  // 🆕 יצירת spans לכל השורות בלולאה (line1, line2, line3, line4)
  for (let lineNum = 1; lineNum <= MAX_LINES; lineNum++) {
    const spansKey = `line${lineNum}WordSpans`;
    const elementKey = `line${lineNum}Element`;

    if (
      !window.subtitleState[spansKey] ||
      window.subtitleState[spansKey].length < MAX_WORDS_PER_LINE * 2 ||
      !window.subtitleState[spansKey].every(
        (span) =>
          span &&
          span.isConnected &&
          span.parentElement === window.subtitleState[elementKey]
      )
    ) {
      if (window.subtitleState[elementKey]) {
        window.subtitleState[elementKey].innerHTML = "";
      }
      window.subtitleState[spansKey] = [];
      for (let i = 0; i < MAX_WORDS_PER_LINE * 2; i++) {
        const wordSpan = createDOMElement("span", "regular-subtitle-word");
        wordSpan.style.display = "none";
        window.subtitleState[elementKey].appendChild(wordSpan);
        window.subtitleState[spansKey].push(wordSpan);
      }
      createdOrEnsuredSomething = true;
    }
  }

  if (
    window.subtitleState.overlay &&
    !window.subtitleState.overlay.isConnected
  ) {
    if (videoPlayer) {
      videoPlayer.appendChild(window.subtitleState.overlay);
      if (window.DEBUG && createdOrEnsuredSomething)
        console.log(
          "[SubtitleButton] ensureSubtitleDOM: Overlay (re)attached to player."
        );
    } else {
      console.error(
        "[SubtitleButton] ensureSubtitleDOM: Video player not found for overlay attachment."
      );
      return false;
    }
  }
  if (window.DEBUG && createdOrEnsuredSomething)
    console.log(
      "[SubtitleButton] ensureSubtitleDOM: DOM elements ensured/recreated."
    );
  return true;
}
// --- END NEW HELPER ---

// שמירת הפונקציה הזמנית אם קיימת
const tempCreateSubtitleFunction = window.createSubtitleButton;

window.createSubtitleButton = function () {
  // אם יש כפתור זמני קיים, מחליפים אותו בכפתור חדש כדי לנקות listeners זמניים
  const existingButton = document.querySelector(".ytp-subtitle-button");
  if (existingButton && existingButton.getAttribute('data-temporary') === 'true') {
    console.log("[SubtitleButton] מחליף כפתור זמני בכפתור אמיתי");
    const existingContainer = existingButton.parentElement;
    const button = createDOMElement("button", "ytp-button ytp-subtitle-button");
    button.setAttribute("title", "Toggle Subtitles");
    setupRealSubtitleButton(button);
    existingContainer.replaceChildren(button);
    return existingContainer;
  }

  const container = createDOMElement("div", "custom-button-container");
  const button = createDOMElement("button", "ytp-button ytp-subtitle-button");
  button.setAttribute("title", "Toggle Subtitles");

  setupRealSubtitleButton(button);
  container.appendChild(button);
  return container;
};

// סימון שזו הפונקציה האמיתית (לא זמנית)
window.createSubtitleButton.isTemporaryFunction = false;

function setupRealSubtitleButton(button) {
  window.ycLoader.text("images/subtitle/subtitle.svg")
    .then((svgText) => {
      button.innerHTML = svgText;
    })
    .catch((error) => {
      console.error("[SubtitleButton] Error loading SVG:", error);
      button.textContent = "SRT";
    });

  // Initial DOM setup (hidden)
  ensureSubtitleDOM();
  if (window.subtitleState.overlay)
    window.subtitleState.overlay.style.display = "none";

  let clickController = null;

  button.addEventListener(
    "click",
    async () => {
      const initialIsVisibleState = window.subtitleState.isVisible;
      if (window.DEBUG)
        console.log(
          `[DEBUG SubtitleButton] Clicked. Initial isVisible: ${initialIsVisibleState}`
        );

      // 🎯 Check if there's an active extraction process (Gemini API call)
      if (clickController && !clickController.signal.aborted) {
        console.log('[SubtitleButton] 🛑 Active extraction detected - aborting and closing');

        // Abort the extraction
        clickController.abort();

        // Clean up video listeners
        if (activeVideoListenersCleanup) {
          activeVideoListenersCleanup();
          activeVideoListenersCleanup = null;
        }

        // Turn off subtitles
        window.subtitleState.isVisible = false;
        if (window.subtitleState.overlay) {
          window.subtitleState.overlay.style.display = "none";
        }

        // Remove red button
        button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);

        // Remove progress bar
        if (window.extractorModule?.removeSubtitlesProgressBar) {
          window.extractorModule.removeSubtitlesProgressBar();
        }

        // Clear the controller
        clickController = null;

        console.log('[SubtitleButton] ✅ Extraction aborted, subtitles closed');
        return; // Exit - don't start a new operation
      }

      clickController = new AbortController();
      const { signal } = clickController;
      let subtitlesProgressShown = false;

      try {
        if (initialIsVisibleState) {
          if (window.DEBUG)
            console.log("[DEBUG SubtitleButton] Turning subtitles OFF.");
          window.subtitleState.isVisible = false;
        } else {
          if (window.DEBUG)
            console.log(
              "[DEBUG SubtitleButton] Turning subtitles ON. Loading dependencies..."
            );

          const isTutorialDemoAccess = isTutorialDemoSubtitleVideo();
          if (!isTutorialDemoAccess && window.__ycBlockClearLiveVideoIfNeeded?.('subtitles-button')) {
            button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
            return;
          }

          // 🎯 OPTIMISTIC UI: הפוך את הכפתור לאדום מיד (לפני כל בדיקה)
          button.classList.add(SUBTITLE_BUTTON_ACTIVE_CLASS);
          console.log("[SubtitleButton] 🎯 Optimistic UI: Button turned red immediately");

          // 🔐 SIGN-IN CHECK: Lyrics are free for all signed-in users
          try {
            if (!isTutorialDemoAccess) {
              await ensureSubtitleAuthLoaded();
            }

            // Fail-Safe: אם ycAuth לא נטען - חסום גישה
            if (!window.ycAuth?.getJWTPayload && !isTutorialDemoAccess) {
              console.error('[SubtitleButton] ycAuth not available - blocking access (Fail-Safe)');
              button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
              showSubtitleAuthError('Authentication system not loaded. Please reload the page.');
              return;
            }

            const jwt = window.ycAuth?.getJWTPayload?.();
            if (!jwt && !isTutorialDemoAccess) {
              console.log('[SubtitleButton] User not signed in');
              button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
              showSubtitleSignInRequired();
              return;
            } else if (!jwt && isTutorialDemoAccess) {
              console.log('[SubtitleButton] 🎬 Tutorial demo video - allowing subtitles without sign-in');
            }

            console.log('[SubtitleButton] User signed in - lyrics access granted');
          } catch (authError) {
            console.error('[SubtitleButton] Auth check error - blocking access (Fail-Safe):', authError);
            button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
            showSubtitleAuthError('Authentication error. Please reload the page.');
            return;
          }

          await initializeSubtitlePreferences();
          if (signal.aborted)
            throw new Error("Operation aborted after preferences init.");

          // (לוגיקת טעינת מודולים, ולידציה, חילוץ נשארת כפי שהייתה)
          if (window.dynamicLoader) {
            await window.dynamicLoader
              .ensureDatabaseManagerLoaded()
              .catch((e) => {
                throw new Error("DB Manager load failed: " + e.message);
              });
            if (!window.extractorModule) {
              await window.dynamicLoader.loadGroup("extractor").catch((e) => {
                throw new Error("Extractor module load failed: " + e.message);
              });
              if (!window.extractorModule && window.DEBUG) {
                /* ... fallback import ... */
              }
            }
          } else {
            throw new Error("dynamicLoader not available.");
          }
          if (
            !window.videoValidator ||
            !window.databaseManager ||
            !window.extractorModule
          ) {
            throw new Error("Critical modules missing");
          }
          const currentUrl = window.location.href;
          const videoId = window.ycUtils.extractVideoId(currentUrl);
          if (!videoId) throw new Error("Invalid YouTube URL");
          if (window.DEBUG)
            console.log(
              `[DEBUG SubtitleButton] Processing videoId: ${videoId}`
            );

          showSubtitleModeStatusToast(videoId);

          // 🎯 Set flag to ignore custom prompts EARLY (before any API calls)
          window.ycIgnoreCustomPromptForSubtitles = true;
          console.log('[SubtitleButton] 🎯 Ignoring custom prompts (subtitles only support DEFAULT/TRANSLATION)');

          let needsExtraction =
            !(await window.videoValidator.checkSubtitlesInIndexedDB(videoId));
          if (signal.aborted)
            throw new Error("Operation aborted after DB check.");
          if (needsExtraction) {
            const aiModeRaw = (await chrome.storage.local.get(['aiTranscriptionMode'])).aiTranscriptionMode;
            const aiModeForLongVideo = isTutorialDemoAccess
              ? 'off'
              : normalizeAiModeForSubtitles(aiModeRaw);
            const allowLongVideoForGemini = aiModeForLongVideo === "auto" || aiModeForLongVideo === "always";

            const validationResult = isTutorialDemoAccess
              ? { isValid: true, isMusic: true, durationSeconds: getSubtitleVideoDurationSeconds() }
              : await window.videoValidator.validateVideo(
                currentUrl,
                {
                  signal,
                  allowNonMusic: true,
                  allowLongVideo: allowLongVideoForGemini
                } // 🎯 Subtitles work for all videos + long videos in AI modes
              );
            if (signal.aborted || !validationResult.isValid) {
              // הצגת הודעת שגיאה בסגנון Toast
              if (window.ycUtils && window.ycUtils.showToast) {
                window.ycUtils.showToast(validationResult.message || "Only videos between 15 seconds and 35 minutes are supported", '⚠️', 3000);
              }
              button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
              return; // יציאה מהפונקציה בלי לזרוק Error
            }

            // 🎯 בדיקה מיוחדת: אם זה לא מוזיקה, רק YouTube או Gemini DEFAULT/TRANSLATION מותרים
            if (!validationResult.isMusic) {
              console.log('[SubtitleButton] 🎬 Non-music video - checking subtitle source...');

              // קריאת הגדרות המשתמש
              const settings = await chrome.storage.local.get(['showDefault', 'showTranslation']);
              const showDefault = settings.showDefault !== false; // ברירת מחדל: true
              const showTranslation = settings.showTranslation || false;

              console.log('[SubtitleButton] User settings:', { showDefault, showTranslation });

              // אם אין DEFAULT ואין TRANSLATION (רק CUSTOM) → חסום!
              if (!showDefault && !showTranslation) {
                console.log('[SubtitleButton] ❌ Non-music video with only Custom Prompt selected - blocking');
                button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
                window.ycUtils.showToast('Subtitles carousel is only available for YouTube or Gemini default subtitles', '📝', 3000);
                return;
              }

              // אם יש DEFAULT או TRANSLATION → מותר, אבל נתעלם מ-CUSTOM
              console.log('[SubtitleButton] ✅ Non-music video with DEFAULT or TRANSLATION selected - allowing (will ignore CUSTOM if selected)');
              // 🎯 נשמור flag שנתעלם מ-CUSTOM בהמשך
              window.ycIgnoreCustomPromptForCarousel = true;
            } else {
              // סרטון מוזיקה → מאפשר הכל (כולל CUSTOM)
              window.ycIgnoreCustomPromptForCarousel = false;
            }

            // 🎯 בדיקה אם יש כתוביות לסרטון (אחרי בדיקת סרטון מוזיקה)
            try {
              if (window.youtubeSubtitles?.hasAvailableCaptions) {
                console.log('[SubtitleButton] Checking if captions available for', videoId);
                const hasCaptions = await window.youtubeSubtitles.hasAvailableCaptions(videoId);
                if (!hasCaptions) {
                  console.log('[SubtitleButton] No captions available - showing toast and stopping');
                  button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
                  window.ycUtils.showToast('No subtitles available for this video', '📝', 3000);
                  return;  // ← יוצא לפני ensureSubtitleDOM()!
                }
                console.log('[SubtitleButton] Captions available - continuing');
              }
            } catch (captionCheckError) {
              console.warn('[SubtitleButton] Caption check failed, continuing anyway:', captionCheckError);
            }

            // 🎬 Check if we actually need Gemini extraction
            // Only create progress bar if we're missing the selected subtitle type
            let needsGeminiExtraction = false;
            const canUseGemini = aiModeForLongVideo === 'auto' || aiModeForLongVideo === 'always';

            try {
              const aiMode = aiModeForLongVideo;

              let existingData = await window.databaseManager?.loadSubtitlesFromIndexedDB?.(videoId);
              if (existingData && window.databaseManager?.normalizeSubtitlesForActiveMode) {
                existingData = await window.databaseManager.normalizeSubtitlesForActiveMode(existingData, aiMode);
              }
              const settings = await chrome.storage.local.get(['showDefault', 'showTranslation']);
              const showDefault = settings.showDefault !== false;
              const showTranslation = settings.showTranslation || false;
              const effectiveShowTranslation = aiMode === 'off' ? false : showTranslation;
              const effectiveShowDefault = aiMode === 'off' ? true : showDefault;

              if (showTranslation && aiMode === 'off') {
                console.log('[SubtitleButton] AI mode OFF - ignoring TRANSLATION request, using DEFAULT');
              }

              if (!canUseGemini) {
                console.log('[SubtitleButton] AI mode OFF - using YouTube subtitles only, no Gemini progress');
              } else {
                // Check if we have the selected subtitle type
                const hasDefault = !!(
                  existingData?.hasActiveDefault ||
                  existingData?.sentenceSRT?.trim()
                );
                const hasTranslation = existingData?.translationSRT?.trim();

                if (effectiveShowDefault && !hasDefault) {
                  needsGeminiExtraction = true;
                  console.log('[SubtitleButton] 🤖 Need DEFAULT subtitles for active AI mode');
                } else if (effectiveShowTranslation && !hasTranslation) {
                  needsGeminiExtraction = true;
                  console.log('[SubtitleButton] 🤖 Need Gemini for TRANSLATION subtitles');
                } else {
                  console.log('[SubtitleButton] ✅ Selected subtitle type already exists in DB');
                }
              }
            } catch (checkError) {
              if (canUseGemini) {
                console.warn('[SubtitleButton] Error checking existing subtitles, assuming Gemini extraction needed:', checkError);
                needsGeminiExtraction = true;
              } else {
                console.warn('[SubtitleButton] Error checking existing subtitles in AI OFF mode - continuing without Gemini progress:', checkError);
              }
            }

            // 🎬 Create Gemini progress bar only if actually needed
            if (needsGeminiExtraction) {
              const longVideoApproved = await maybeConfirmLongGeminiForSubtitles(
                aiModeForLongVideo,
                getSubtitleVideoDurationSeconds(validationResult.durationSeconds)
              );
              if (!longVideoApproved) {
                if (window.DEBUG) {
                  console.log('[SubtitleButton] Long video Gemini confirmation declined by user');
                }
                button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
                return;
              }

              const video = document.querySelector('video.html5-main-video');
              const durationMinutes = video?.duration ? video.duration / 60 : 3;

              if (window.extractorModule?.createSubtitlesProgressBar) {
                console.log('[SubtitleButton] 🎬 Creating Gemini progress bar...');
                window.extractorModule.createSubtitlesProgressBar(durationMinutes);
                subtitlesProgressShown = true;
              }
            }

            const extractResult =
              await window.extractorModule.extractSubtitlesFromTarGz(videoId, null, null, {
                signal,
                ignoreCustom: true,
              });

            // 🎯 Clear flags after extraction
            window.ycIgnoreCustomPromptForCarousel = false;
            window.ycIgnoreCustomPromptForSubtitles = false;

            if (signal.aborted || !extractResult)
              throw new Error("Extraction failed/aborted or no subs in tar.gz");

            if (subtitlesProgressShown && window.extractorModule?.completeSubtitlesProgressBar) {
              window.extractorModule.completeSubtitlesProgressBar();
            }

            if (window.DEBUG)
              console.log(
                `[DEBUG SubtitleButton] Extracted and saved to DB for ${videoId}`
              );

            // ⏱️ המתנה של 1000ms לאחר extraction כדי לאפשר ל-IndexedDB לסיים commit
            console.log('[SubtitleButton] ⏱️ Waiting 1000ms for IndexedDB commit...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log('[SubtitleButton] ✅ Wait complete, proceeding to load');
          } else {
            if (window.DEBUG)
              console.log(
                `[DEBUG SubtitleButton] Subs found in DB for ${videoId}.`
              );
          }

          // ✅ רק עכשיו - אחרי שאישרנו שיש כתוביות - ניצור את ה-DOM!
          if (!ensureSubtitleDOM()) {
            throw new Error(
              "Failed to ensure subtitle DOM structure on click."
            );
          }

          // 🎯 אם היה extraction, נעביר forceLoad=true כדי לעקוף בדיקות
          const loadedSuccessfully = await loadSubtitles(needsExtraction);
          if (signal.aborted)
            throw new Error("Operation aborted after loading subs to state.");

          if (
            loadedSuccessfully &&
            (window.subtitleState.sentences?.length > 0 ||
              window.subtitleState.words?.length > 0)
          ) {
            window.subtitleState.isVisible = true;
          } else {
            if (window.DEBUG)
              console.warn(
                "[SubtitleButton] No subtitles to display even after attempting loadSubtitles()."
              );
            if (loadedSuccessfully === false && needsExtraction === false) {
              showError("No subtitle content found in database.");
            } else if (loadedSuccessfully === false) {
              showError("No subtitle content could be displayed.");
            }
            window.subtitleState.isVisible = false;
          }
        }

        // עדכון סופי של מראה הכפתור והתצוגה
        if (window.subtitleState.isVisible) {
          // טעינת מודול subtitle location בפעם הראשונה שהכתוביות מופעלות
          if (!subtitleLocationModuleLoaded) {
            try {
              await window.ycLoader.js("buttons/settings/subtitles/subtitleLocationMenu.js");
              const { initializeSubtitleLocationPreferences, handleTimelineAlwaysVisibleChange } = window;

              // שמירת הפונקציה לשימוש חוזר
              window.subtitleLocationHandlers = window.subtitleLocationHandlers || {};
              window.subtitleLocationHandlers.handleTimelineAlwaysVisibleChange = handleTimelineAlwaysVisibleChange;

              // אתחול העדפות מיקום כתוביות
              await initializeSubtitleLocationPreferences();

              // הגדרת MutationObserver למעקב אחרי שינויים בפאנל/קרוסלה
              if (typeof MutationObserver !== "undefined") {
                subtitleLocationObserver = new MutationObserver((mutations) => {
                  // בדיקה אם השינוי רלוונטי (פאנל או קרוסלה)
                  const isRelevantChange = mutations.some(mutation => {
                    // בדיקה אם נוספו/הוסרו nodes
                    if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
                      // בדיקה אם זה קשור לפאנל או קרוסלה
                      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
                      return nodes.some(node => {
                        if (node.nodeType === 1) { // Element node
                          const className = typeof node.className === 'string' ? node.className : '';
                          return className.includes('yt-lyrics-chords-panel') ||
                            className.includes('chords-carousel') ||
                            className.includes('carousel');
                        }
                        return false;
                      });
                    }
                    return false;
                  });

                  if (isRelevantChange) {
                    handleTimelineAlwaysVisibleChange();
                  }
                });

                subtitleLocationObserver.observe(document.body, {
                  childList: true,
                  subtree: true,
                });

                if (window.DEBUG) {
                  console.log("[SubtitleLocation] Module loaded and MutationObserver set up");
                }
              }

              subtitleLocationModuleLoaded = true;

              // בדיקה ראשונית של מצב פאנל/קרוסלה כשהכתוביות נפתחות
              console.log("[SubtitleButton] Calling handleTimelineAlwaysVisibleChange on subtitle open (first time)");
              handleTimelineAlwaysVisibleChange();
            } catch (err) {
              console.error("[SubtitleButton] Error loading subtitle location module:", err);
            }
          } else {
            // אם המודול כבר נטען, בדוק את המצב הנוכחי
            console.log("[SubtitleButton] Calling handleTimelineAlwaysVisibleChange on subtitle open (already loaded)");
            if (window.subtitleLocationHandlers?.handleTimelineAlwaysVisibleChange) {
              window.subtitleLocationHandlers.handleTimelineAlwaysVisibleChange();
            } else {
              console.warn("[SubtitleButton] handleTimelineAlwaysVisibleChange not found in window.subtitleLocationHandlers");
            }
          }

          button.classList.add(SUBTITLE_BUTTON_ACTIVE_CLASS);
          if (window.subtitleState.overlay)
            window.subtitleState.overlay.style.display = "block";
          if (activeVideoListenersCleanup) activeVideoListenersCleanup();
          activeVideoListenersCleanup = setupVideoEventListeners(signal);
          updateSubtitles();
          if (window.DEBUG)
            console.log("[DEBUG SubtitleButton] Subtitles display ON.");
        } else {
          button.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);
          if (window.subtitleState.overlay)
            window.subtitleState.overlay.style.display = "none";
          if (activeVideoListenersCleanup) {
            activeVideoListenersCleanup();
            activeVideoListenersCleanup = null;
          }
          subtitleVideoElement = null;
          if (window.subtitleState.line1Element)
            window.subtitleState.line1Element.innerHTML = "";
          if (window.subtitleState.line2Element)
            window.subtitleState.line2Element.innerHTML = "";
          if (window.subtitleState.line3Element)
            window.subtitleState.line3Element.innerHTML = "";
          if (window.subtitleState.line4Element)
            window.subtitleState.line4Element.innerHTML = "";
          if (window.subtitleState.line5Element)
            window.subtitleState.line5Element.innerHTML = "";
          if (window.subtitleState.line6Element)
            window.subtitleState.line6Element.innerHTML = "";
          if (window.subtitleState.line7Element)
            window.subtitleState.line7Element.innerHTML = "";
          if (window.subtitleState.line8Element)
            window.subtitleState.line8Element.innerHTML = "";
          if (window.DEBUG)
            console.log("[DEBUG SubtitleButton] Subtitles display OFF.");
        }
        if (window.DEBUG)
          console.log(
            `[DEBUG SubtitleButton] Final isVisible state: ${window.subtitleState.isVisible}, Button class: ${button.className}`
          );
      } catch (err) {
        if (subtitlesProgressShown && window.extractorModule?.removeSubtitlesProgressBar) {
          window.extractorModule.removeSubtitlesProgressBar();
        }
        if (err.name === "AbortError" || signal.aborted) {
          if (window.DEBUG)
            console.log("[SubtitleButton] Click operation was aborted.");
        } else {
          console.error("[SubtitleButton] Error during click handler:", err);
          showError(err.message || "An error occurred.");
        }
      } finally {
        // 🎯 Always clear the flag, even if there was an error
        window.ycIgnoreCustomPromptForSubtitles = false;
      }
    },
    { passive: true }
  );
}

// ------------------------------
// 15. ניקוי הכתוביות
// ------------------------------
window.cleanupSubtitles = function () {
  if (window.DEBUG)
    console.log("[SubtitleButton DEBUG] cleanupSubtitles called.");
  if (activeVideoListenersCleanup) {
    activeVideoListenersCleanup();
    activeVideoListenersCleanup = null;
  }

  // ניקוי subtitle location observer
  if (subtitleLocationObserver) {
    subtitleLocationObserver.disconnect();
    subtitleLocationObserver = null;
    subtitleLocationModuleLoaded = false;
    if (window.DEBUG) {
      console.log("[SubtitleButton] Disconnected subtitle location observer");
    }
  }

  if (Array.isArray(window.subtitleObservers)) {
    window.subtitleObservers.forEach((o) => o.disconnect?.());
    window.subtitleObservers.length = 0;
  }
  if (Array.isArray(window.subtitleObserverTimeouts)) {
    window.subtitleObserverTimeouts.forEach((id) => clearTimeout(id));
    window.subtitleObserverTimeouts.length = 0;
  }

  if (window.subtitleState.modeStatusToastTimeout) {
    clearTimeout(window.subtitleState.modeStatusToastTimeout);
    window.subtitleState.modeStatusToastTimeout = null;
  }
  if (window.subtitleState.modeStatusToastElement) {
    window.subtitleState.modeStatusToastElement.remove();
    window.subtitleState.modeStatusToastElement = null;
  }

  const menus = document.querySelectorAll(
    ".font-size-submenu, .font-color-submenu, .font-opacity-submenu," +
    " .word-highlight-text-color-submenu, .highlight-color-submenu," +
    " .highlight-opacity-submenu, .background-color-submenu," +
    " .background-opacity-submenu, .subtitle-mode-submenu," +
    " .subtitle-settings-menu, .adjustments-submenu," +
    " .buttons-display-submenu"
  );
  menus.forEach((menu) => {
    if (menu.observer) {
      menu.observer.disconnect();
      delete menu.observer;
    }
  });

  // נקה תוכן במקום למחוק את האלמנטים הממוחזרים עצמם
  ["line1WordSpans", "line2WordSpans", "line3WordSpans", "line4WordSpans", "line5WordSpans", "line6WordSpans", "line7WordSpans", "line8WordSpans"].forEach((arrayName) => {
    window.subtitleState[arrayName]?.forEach((span) => {
      span.textContent = "";
      span.style.display = "none";
    });
  });
  for (let i = 1; i <= MAX_LINES; i++) {
    if (window.subtitleState[`line${i}Element`])
      window.subtitleState[`line${i}Element`].innerHTML = "";
  }
  if (window.subtitleState.textContainer)
    window.subtitleState.textContainer.remove(); // הסר את הקונטיינר הפנימי
  if (window.subtitleState.overlay) window.subtitleState.overlay.remove();

  // אפס את הרפרנסים כדי ש-ensureSubtitleDOM ייצור אותם מחדש
  window.subtitleState.overlay = null;
  window.subtitleState.textContainer = null;
  window.subtitleState.line1Element = null;
  window.subtitleState.line2Element = null;
  window.subtitleState.line3Element = null;
  window.subtitleState.line4Element = null;
  window.subtitleState.line5Element = null; // 🆕
  window.subtitleState.line6Element = null; // 🆕
  window.subtitleState.line7Element = null; // 🆕
  window.subtitleState.line8Element = null; // 🆕
  window.subtitleState.line1WordSpans = [];
  window.subtitleState.line2WordSpans = [];
  window.subtitleState.line3WordSpans = [];
  window.subtitleState.line4WordSpans = [];
  window.subtitleState.line5WordSpans = []; // 🆕
  window.subtitleState.line6WordSpans = []; // 🆕
  window.subtitleState.line7WordSpans = []; // 🆕
  window.subtitleState.line8WordSpans = []; // 🆕

  window.subtitleState.isVisible = false;
  window.subtitleState.isSettingsVisible = false;
  window.subtitleState.sentences = [];
  window.subtitleState.words = [];
  window.subtitleState.isRTL = false;
  window.subtitleState.isCustomPrompt = false;
  window.subtitleState.geminiDefaultMergePairsByIndex = null;

  // ניקוי מערכי SPANs - קריטי למניעת דליפות!
  if (
    window.subtitleState.line1WordSpans &&
    window.subtitleState.line1WordSpans.length > 0
  ) {
    // ניקוי event listeners מכל span
    window.subtitleState.line1WordSpans.forEach((span) => {
      if (span && span.parentNode) {
        span.onclick = null;
        span.onmouseenter = null;
        span.onmouseleave = null;
        span.remove();
      }
    });
    window.subtitleState.line1WordSpans = [];
    if (DEBUG) console.log("[cleanupSubtitles] Cleared line1WordSpans");
  }

  if (
    window.subtitleState.line2WordSpans &&
    window.subtitleState.line2WordSpans.length > 0
  ) {
    // ניקוי event listeners מכל span
    window.subtitleState.line2WordSpans.forEach((span) => {
      if (span && span.parentNode) {
        span.onclick = null;
        span.onmouseenter = null;
        span.onmouseleave = null;
        span.remove();
      }
    });
    window.subtitleState.line2WordSpans = [];
    if (DEBUG) console.log("[cleanupSubtitles] Cleared line2WordSpans");
  }

  // ניקוי רפרנס לווידאו
  if (window.subtitleVideoElement) {
    window.subtitleVideoElement = null;
    if (DEBUG)
      console.log("[cleanupSubtitles] Cleared video element reference");
  }

  /* ביטול הטיימר שמנקה SPAN-ים אם קיים */
  if (typeof window.spanCleanupTimerId === "number") {
    clearInterval(window.spanCleanupTimerId);
    window.spanCleanupTimerId = null;
    if (DEBUG) console.log("[cleanupSubtitles] spanCleanupTimer cancelled");
  }

  subtitleVideoElement = null;

  const subtitleBtn = document.querySelector(".ytp-button.ytp-subtitle-button");
  subtitleBtn?.classList.remove(SUBTITLE_BUTTON_ACTIVE_CLASS);

  if (window.DEBUG) console.log("[SubtitleButton] Subtitles cleaned up.");
};

// ------------------------------
// 16. ניקוי תקופתי של SPANs ישנים
// ------------------------------
function cleanupOldSpans() {
  if (!window.subtitleState) return;

  // ניקוי spans שלא מחוברים ל-DOM
  ["line1WordSpans", "line2WordSpans", "line3WordSpans", "line4WordSpans", "line5WordSpans", "line6WordSpans", "line7WordSpans", "line8WordSpans"].forEach((arrayName) => {
    const spans = window.subtitleState[arrayName];
    if (spans && spans.length > 0) {
      const validSpans = spans.filter((span) => span && span.isConnected);
      if (validSpans.length < spans.length) {
        const removed = spans.length - validSpans.length;
        window.subtitleState[arrayName] = validSpans;
        if (DEBUG)
          console.log(
            `[cleanupOldSpans] Removed ${removed} disconnected spans from ${arrayName}`
          );
      }
    }
  });

  // ✅ בדיקה נוספת - ניקוי spans יתומים עם הclasses החדשים
  const orphanRegularSpans = document.querySelectorAll(
    ".regular-subtitle-word:not(.highlighted):not(.past-word)"
  );
  let cleanedOrphans = 0;
  orphanRegularSpans.forEach((span) => {
    if (!span.closest(".yt-subtitle-overlay") || !span.textContent?.trim()) {
      span.remove();
      cleanedOrphans++;
    }
  });
  if (DEBUG && cleanedOrphans > 0) {
    console.log(
      `[cleanupOldSpans] Cleaned ${cleanedOrphans} orphan regular-subtitle spans`
    );
  }
}

/* ניקוי spans יתומים פעם בדקה — הגנה נוספת מדליפות */
if (!window.spanCleanupTimerId) {
  window.spanCleanupTimerId = setInterval(cleanupOldSpans, 60_000);
}

/* ביטול טיימר ה-debounce של updateSubtitles בעת סגירת הדף */
window.addEventListener(
  "beforeunload",
  () => {
    if (updateSubtitles && typeof updateSubtitles.cancel === "function") {
      updateSubtitles.cancel();
      if (DEBUG)
        console.log(
          "[SubtitleButton] Cancelled updateSubtitles debounce timer"
        );
    }
  },
  { once: true }
);

// ------------------------------
// 17. ייצוא פונקציות חיצוניות וטעינת הגדרות ראשונית
// ------------------------------

// ייצוא updateSubtitles לחלון הגלובלי כדי לאפשר ביטול הטיימר מבחוץ
window.updateSubtitles = updateSubtitles;
if (
  document.readyState === "complete" ||
  document.readyState === "interactive"
) {
  initializeSubtitlePreferences().catch((err) => {
    console.error(
      "[SubtitleButton] Error during initial auto preferences load:",
      err
    );
  });
} else {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      initializeSubtitlePreferences().catch((err) => {
        console.error(
          "[SubtitleButton] Error during initial auto preferences load (DOMContentLoaded):",
          err
        );
      });
    },
    { once: true }
  );
}

// הערה: subtitle location module נטען באופן דינמי רק כשהכתוביות מופעלות בפעם הראשונה
// ראה את הקוד בתוך "if (window.subtitleState.isVisible)" למעלה

})();
