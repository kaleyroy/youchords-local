// popup.js - YouChords Extension
import './utils/productionConsole.js';
import { signInWithGoogle, signOutUser, getCurrentUser, getSubscriptionInfo } from './firebase/auth.js';

const CONSENT_VERSION = '2026-02-17';
const CONSENT_STORAGE_KEY = 'youchords_consent';
const API_BASE_URL = 'http://127.0.0.1:8765';
const UPGRADE_PENDING_KEY = 'youchords_upgrade_pending';
const UPGRADE_PENDING_TTL_MS = 45 * 60 * 1000;
const UPGRADE_PENDING_POPUP_REFRESH_THROTTLE_MS = 10 * 1000;
const SUBSCRIPTION_STATE_DIRTY_KEY = 'youchords_subscription_state_dirty';
const SUBSCRIPTION_STATE_DIRTY_TTL_MS = 60 * 60 * 1000;
const SUBSCRIPTION_STATE_DIRTY_REFRESH_THROTTLE_MS = 15 * 1000;
const RENEWAL_DATE_SHOW_TIME_KEY = 'youchords_popup_renewal_date_show_time';
const RENEWAL_DATE_FORMAT_KEY = 'youchords_popup_renewal_date_format';
const RENEWAL_TIME_FORMAT_KEY = 'youchords_popup_renewal_time_format';
const RENEWAL_DATE_FORMATS = [
  'local',
  'dmy',
  'mdy',
  'iso',
  'monthLongDayYear',
  'monthShortDayYear',
  'dayMonthLongYear',
  'dayMonthShortYear',
  'monthLongDayYearNoComma',
  'monthShortDayYearNoComma'
];
const RENEWAL_TIME_FORMATS = ['local', '24h', '12h'];
let renewalFormatMenuCleanup = null;
let renewalFormatMenuElement = null;

function cleanupRenewalFormatMenuListeners() {
  if (typeof renewalFormatMenuCleanup === 'function') {
    renewalFormatMenuCleanup();
    renewalFormatMenuCleanup = null;
  }
  if (renewalFormatMenuElement?.isConnected) {
    renewalFormatMenuElement.remove();
  }
  renewalFormatMenuElement = null;
}

async function markUpgradePending(source = 'popup_upgrade_click') {
  try {
    const now = Date.now();
    await chrome.storage.local.set({
      [UPGRADE_PENDING_KEY]: {
        active: true,
        source,
        markedAt: now,
        expiresAt: now + UPGRADE_PENDING_TTL_MS,
        lastAttemptAt: 0
      }
    });
  } catch (error) {
    console.warn('[Popup] Failed to mark upgrade pending:', error);
  }
}

async function markSubscriptionStateDirty(source = 'popup_subscription_flow') {
  try {
    const now = Date.now();
    await chrome.storage.local.set({
      [SUBSCRIPTION_STATE_DIRTY_KEY]: {
        active: true,
        source,
        markedAt: now,
        expiresAt: now + SUBSCRIPTION_STATE_DIRTY_TTL_MS,
        lastAttemptAt: 0
      }
    });
  } catch (error) {
    console.warn('[Popup] Failed to mark subscription state dirty:', error);
  }
}

async function getJwtForPendingUpgradeRefresh() {
  const localJwt = localStorage.getItem('youchords_jwt');
  if (localJwt) return localJwt;
  const result = await chrome.storage.local.get(['youchords_jwt']);
  const sharedJwt = result?.youchords_jwt || null;
  if (sharedJwt) {
    localStorage.setItem('youchords_jwt', sharedJwt);
  }
  return sharedJwt;
}

async function maybeAutoRefreshAfterPendingUpgrade() {
  try {
    const pendingResult = await chrome.storage.local.get([UPGRADE_PENDING_KEY]);
    const pendingState = pendingResult?.[UPGRADE_PENDING_KEY];
    if (!pendingState?.active) return;

    const now = Date.now();
    const markedAt = Number(pendingState.markedAt || 0);
    const expiresAt = Number(pendingState.expiresAt || (markedAt > 0 ? markedAt + UPGRADE_PENDING_TTL_MS : 0));
    if (!markedAt || !expiresAt || expiresAt <= now) {
      await chrome.storage.local.remove([UPGRADE_PENDING_KEY]);
      return;
    }

    const lastAttemptAt = Number(pendingState.lastAttemptAt || 0);
    if (lastAttemptAt > 0 && (now - lastAttemptAt) < UPGRADE_PENDING_POPUP_REFRESH_THROTTLE_MS) {
      return;
    }

    const jwt = await getJwtForPendingUpgradeRefresh();
    if (!jwt) return;

    await chrome.storage.local.set({
      [UPGRADE_PENDING_KEY]: {
        ...pendingState,
        lastAttemptAt: now,
        expiresAt
      }
    });

    const idResult = await chrome.storage.local.get(['youchords_device_id', 'youchords_device_fingerprint']);
    const response = await fetch(`${API_BASE_URL}/refreshJWT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`
      },
      body: JSON.stringify({
        deviceId: idResult?.youchords_device_id || null,
        fingerprint: idResult?.youchords_device_fingerprint || null
      })
    });

    if (!response.ok) return;

    const data = await response.json();
    if (!data?.success || !data?.jwt) return;

    await chrome.storage.local.set({ youchords_jwt: data.jwt });
    localStorage.setItem('youchords_jwt', data.jwt);

    try {
      const payload = JSON.parse(atob(data.jwt.split('.')[1]));
      if ((payload?.plan || 'free') !== 'free') {
        await chrome.storage.local.remove([UPGRADE_PENDING_KEY]);
      }
    } catch (_) {
      // ignore payload parsing error
    }
  } catch (error) {
    console.warn('[Popup] Auto-refresh after pending upgrade failed:', error);
  }
}

async function maybeAutoRefreshSubscriptionStateDirty() {
  try {
    const dirtyResult = await chrome.storage.local.get([SUBSCRIPTION_STATE_DIRTY_KEY]);
    const dirtyState = dirtyResult?.[SUBSCRIPTION_STATE_DIRTY_KEY];
    if (!dirtyState?.active) return false;

    const now = Date.now();
    const markedAt = Number(dirtyState.markedAt || 0);
    const expiresAt = Number(dirtyState.expiresAt || (markedAt > 0 ? markedAt + SUBSCRIPTION_STATE_DIRTY_TTL_MS : 0));
    if (!markedAt || !expiresAt || expiresAt <= now) {
      await chrome.storage.local.remove([SUBSCRIPTION_STATE_DIRTY_KEY]);
      return false;
    }

    const lastAttemptAt = Number(dirtyState.lastAttemptAt || 0);
    if (lastAttemptAt > 0 && (now - lastAttemptAt) < SUBSCRIPTION_STATE_DIRTY_REFRESH_THROTTLE_MS) {
      return false;
    }

    const jwt = await getJwtForPendingUpgradeRefresh();
    if (!jwt) return false;

    await chrome.storage.local.set({
      [SUBSCRIPTION_STATE_DIRTY_KEY]: {
        ...dirtyState,
        lastAttemptAt: now,
        expiresAt
      }
    });

    const idResult = await chrome.storage.local.get(['youchords_device_id', 'youchords_device_fingerprint']);
    const response = await fetch(`${API_BASE_URL}/refreshJWT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`
      },
      body: JSON.stringify({
        deviceId: idResult?.youchords_device_id || null,
        fingerprint: idResult?.youchords_device_fingerprint || null
      })
    });

    if (!response.ok) return false;

    const data = await response.json();
    if (!data?.success || !data?.jwt) return false;

    await chrome.storage.local.set({ youchords_jwt: data.jwt });
    localStorage.setItem('youchords_jwt', data.jwt);
    await chrome.storage.local.remove([SUBSCRIPTION_STATE_DIRTY_KEY]);
    return true;
  } catch (error) {
    console.warn('[Popup] Subscription state dirty refresh failed:', error);
    return false;
  }
}

function maybeHighlightUpgradeButtonFromFlag() {
  chrome.storage.local.get(['highlightUpgradeButton'], (result) => {
    if (!result?.highlightUpgradeButton) return;

    const maxAttempts = 20;
    let attempts = 0;

    const tryHighlight = () => {
      attempts += 1;
      const upgradeBtn = elements.upgradeBtn || document.getElementById('upgradeBtn');
      const canHighlight = !!upgradeBtn && upgradeBtn.style.display !== 'none';

      if (canHighlight) {
        upgradeBtn.classList.add('upgrade-attention');
        upgradeBtn.focus();
        showToast('👉', 'Click Upgrade to continue', 'info');
        setTimeout(() => {
          upgradeBtn.classList.remove('upgrade-attention');
        }, 6500);
        chrome.storage.local.remove(['highlightUpgradeButton']);
        return;
      }

      if (attempts >= maxAttempts) {
        chrome.storage.local.remove(['highlightUpgradeButton']);
        return;
      }

      setTimeout(tryHighlight, 220);
    };

    setTimeout(tryHighlight, 120);
  });
}

function maybeHighlightSignInButtonFromFlag() {
  chrome.storage.local.get(['highlightSignInButton'], (result) => {
    if (!result?.highlightSignInButton) return;

    const maxAttempts = 20;
    let attempts = 0;

    const tryHighlight = () => {
      attempts += 1;
      const signInBtn = elements.googleSignIn || document.getElementById('googleSignIn');
      const canHighlight = !!signInBtn && signInBtn.style.display !== 'none' && !signInBtn.disabled;

      if (canHighlight) {
        signInBtn.classList.add('signin-attention');
        signInBtn.focus();
        showToast('👉', 'Click Sign in with Google to continue', 'info');
        setTimeout(() => {
          signInBtn.classList.remove('signin-attention');
        }, 6500);
        chrome.storage.local.remove(['highlightSignInButton']);
        return;
      }

      if (attempts >= maxAttempts) {
        chrome.storage.local.remove(['highlightSignInButton']);
        return;
      }

      setTimeout(tryHighlight, 220);
    };

    setTimeout(tryHighlight, 120);
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// Fixed popup theme (always sunrise)
// ============================================
function applyFixedPopupTheme() {
  document.body.classList.remove(
    'night-theme',
    'sunrise-theme',
    'sunset-theme',
    'day-theme'
  );
  document.body.classList.add('sunrise-theme');
  console.log('[Popup] Fixed sunrise theme applied');
}

// Apply theme immediately
applyFixedPopupTheme();

// Toast notification function
function showToast(icon, message, type = 'success') {
  const existing = document.querySelector('.yc-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `yc-toast yc-toast-${type}`;
  const iconSpan = document.createElement('span');
  iconSpan.className = 'yc-toast-icon';
  iconSpan.textContent = String(icon);
  const messageSpan = document.createElement('span');
  messageSpan.className = 'yc-toast-message';
  messageSpan.textContent = String(message);
  toast.appendChild(iconSpan);
  toast.appendChild(messageSpan);

  if (!document.getElementById('yc-toast-styles')) {
    const style = document.createElement('style');
    style.id = 'yc-toast-styles';
    style.textContent = `
      .yc-toast {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%) translateY(-100%);
        padding: 10px 16px;
        border-radius: 20px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        z-index: 10000;
        opacity: 0;
        transition: all 0.3s ease;
        background: white;
        color: #333;
        box-shadow: 0 4px 15px rgba(0,0,0,0.12);
      }
      .yc-toast.show {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
      .yc-toast-success { border: 1.5px solid #4CAF50; }
      .yc-toast-error { border: 1.5px solid #f44336; }
      .yc-toast-info { border: 1.5px solid #667eea; }
      .yc-toast-deleted { border: 1.5px solid #6b7280; }
      .yc-toast-icon { font-size: 16px; }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function renderConfirmMessage(element, message) {
  element.textContent = '';
  element.classList.toggle('has-bullets', typeof message === 'string' && message.includes('•'));

  if (typeof message !== 'string' || !message.includes('•')) {
    element.textContent = message || '';
    return;
  }

  let activeList = null;
  const lines = message.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      activeList = null;
      const spacer = document.createElement('div');
      spacer.className = 'yc-confirm-message-spacer';
      element.appendChild(spacer);
      continue;
    }

    if (line.startsWith('•')) {
      if (!activeList) {
        activeList = document.createElement('ul');
        activeList.className = 'yc-confirm-message-list';
        element.appendChild(activeList);
      }
      const item = document.createElement('li');
      item.textContent = line.slice(1).trim();
      activeList.appendChild(item);
      continue;
    }

    activeList = null;
    const row = document.createElement('div');
    row.className = 'yc-confirm-message-line';
    row.textContent = line;
    element.appendChild(row);
  }
}

// ✅ Custom confirmation dialog (replaces ugly browser confirm())
function showConfirmDialog(icon, title, message, confirmText = 'OK', cancelText = 'Cancel') {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'yc-confirm-modal';
    modal.innerHTML = `
      <div class="yc-confirm-backdrop"></div>
      <div class="yc-confirm-content">
        <div class="yc-confirm-icon"></div>
        <h3 class="yc-confirm-title"></h3>
        <div class="yc-confirm-message"></div>
        <div class="yc-confirm-buttons">
          <button class="yc-confirm-btn cancel"></button>
          <button class="yc-confirm-btn confirm"></button>
        </div>
      </div>
    `;

    if (!document.getElementById('yc-confirm-styles')) {
      const style = document.createElement('style');
      style.id = 'yc-confirm-styles';
      style.textContent = `
        .yc-confirm-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 999999; display: flex; align-items: center; justify-content: center; }
        .yc-confirm-backdrop { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); backdrop-filter: blur(2px); }
        .yc-confirm-content { position: relative; background: white; border-radius: 12px; padding: 24px; width: calc(100% - 28px); max-width: 332px; max-height: calc(100vh - 24px); overflow-y: auto; margin: 0 14px; box-sizing: border-box; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
        .yc-confirm-icon { font-size: 40px; margin-bottom: 12px; }
        .yc-confirm-title { font-size: 18px; font-weight: 600; margin: 0 0 8px 0; color: #333; }
        .yc-confirm-message { font-size: 14px; color: #666; margin: 0 0 20px 0; line-height: 1.5; white-space: pre-line; }
        .yc-confirm-message.has-bullets { text-align: left; white-space: normal; }
        .yc-confirm-message-line { margin: 0 0 6px 0; }
        .yc-confirm-message-spacer { height: 6px; }
        .yc-confirm-message-list { margin: 4px 0 10px 0; padding-left: 18px; list-style-position: outside; text-align: left; }
        .yc-confirm-message-list li { margin: 4px 0; padding-left: 2px; }
        .yc-confirm-buttons { display: flex; gap: 8px; }
        .yc-confirm-btn { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .yc-confirm-btn.cancel { background: #e0e0e0; color: #333; }
        .yc-confirm-btn.cancel:hover { background: #d0d0d0; }
        .yc-confirm-btn.confirm { background: #f44336; color: white; }
        .yc-confirm-btn.confirm:hover { background: #d32f2f; }
        .yc-confirm-btn.confirm:disabled { background: #cbd5e1; color: #64748b; cursor: not-allowed; }
        .yc-confirm-checkbox-wrap { display: flex; align-items: flex-start; gap: 8px; text-align: left; margin: -4px 0 18px; padding: 10px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0; color: #334155; font-size: 13px; line-height: 1.35; }
        .yc-confirm-checkbox-wrap input { flex: 0 0 auto; width: 16px; height: 16px; margin-top: 1px; accent-color: #ef4444; }
      `;
      document.head.appendChild(style);
    }

    modal.querySelector('.yc-confirm-icon').textContent = icon;
    modal.querySelector('.yc-confirm-title').textContent = title;
    renderConfirmMessage(modal.querySelector('.yc-confirm-message'), message);
    modal.querySelector('.yc-confirm-btn.cancel').textContent = cancelText;
    modal.querySelector('.yc-confirm-btn.confirm').textContent = confirmText;

    document.body.appendChild(modal);

    const handleClose = (confirmed) => {
      modal.remove();
      resolve(confirmed);
    };

    modal.querySelector('.yc-confirm-btn.cancel').addEventListener('click', () => handleClose(false));
    modal.querySelector('.yc-confirm-btn.confirm').addEventListener('click', () => handleClose(true));
    modal.querySelector('.yc-confirm-backdrop').addEventListener('click', () => handleClose(false));
  });
}

function closeConfirmDialogs() {
  document.querySelectorAll('.yc-confirm-modal').forEach((modal) => modal.remove());
}

function showCheckboxConfirmDialog(icon, title, message, confirmText = 'Yes', cancelText = 'Go back', checkboxText = 'Are you sure?') {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'yc-confirm-modal';
    modal.innerHTML = `
      <div class="yc-confirm-backdrop"></div>
      <div class="yc-confirm-content">
        <div class="yc-confirm-icon"></div>
        <h3 class="yc-confirm-title"></h3>
        <div class="yc-confirm-message"></div>
        <label class="yc-confirm-checkbox-wrap">
          <input type="checkbox" />
          <span></span>
        </label>
        <div class="yc-confirm-buttons">
          <button class="yc-confirm-btn cancel"></button>
          <button class="yc-confirm-btn confirm" disabled></button>
        </div>
      </div>
    `;

    if (!document.getElementById('yc-confirm-styles')) {
      const style = document.createElement('style');
      style.id = 'yc-confirm-styles';
      style.textContent = `
        .yc-confirm-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 999999; display: flex; align-items: center; justify-content: center; }
        .yc-confirm-backdrop { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); backdrop-filter: blur(2px); }
        .yc-confirm-content { position: relative; background: white; border-radius: 12px; padding: 24px; width: calc(100% - 28px); max-width: 332px; max-height: calc(100vh - 24px); overflow-y: auto; margin: 0 14px; box-sizing: border-box; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
        .yc-confirm-icon { font-size: 40px; margin-bottom: 12px; }
        .yc-confirm-title { font-size: 18px; font-weight: 600; margin: 0 0 8px 0; color: #333; }
        .yc-confirm-message { font-size: 14px; color: #666; margin: 0 0 20px 0; line-height: 1.5; white-space: pre-line; }
        .yc-confirm-message.has-bullets { text-align: left; white-space: normal; }
        .yc-confirm-message-line { margin: 0 0 6px 0; }
        .yc-confirm-message-spacer { height: 6px; }
        .yc-confirm-message-list { margin: 4px 0 10px 0; padding-left: 18px; list-style-position: outside; text-align: left; }
        .yc-confirm-message-list li { margin: 4px 0; padding-left: 2px; }
        .yc-confirm-buttons { display: flex; gap: 8px; }
        .yc-confirm-btn { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .yc-confirm-btn.cancel { background: #e0e0e0; color: #333; }
        .yc-confirm-btn.cancel:hover { background: #d0d0d0; }
        .yc-confirm-btn.confirm { background: #f44336; color: white; }
        .yc-confirm-btn.confirm:hover { background: #d32f2f; }
        .yc-confirm-btn.confirm:disabled { background: #cbd5e1; color: #64748b; cursor: not-allowed; }
        .yc-confirm-checkbox-wrap { display: flex; align-items: flex-start; gap: 8px; text-align: left; margin: -4px 0 18px; padding: 10px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0; color: #334155; font-size: 13px; line-height: 1.35; }
        .yc-confirm-checkbox-wrap input { flex: 0 0 auto; width: 16px; height: 16px; margin-top: 1px; accent-color: #ef4444; }
      `;
      document.head.appendChild(style);
    }

    modal.querySelector('.yc-confirm-icon').textContent = icon;
    modal.querySelector('.yc-confirm-title').textContent = title;
    renderConfirmMessage(modal.querySelector('.yc-confirm-message'), message);
    modal.querySelector('.yc-confirm-checkbox-wrap span').textContent = checkboxText;
    modal.querySelector('.yc-confirm-btn.cancel').textContent = cancelText;
    modal.querySelector('.yc-confirm-btn.confirm').textContent = confirmText;

    document.body.appendChild(modal);

    const checkbox = modal.querySelector('.yc-confirm-checkbox-wrap input');
    const confirmButton = modal.querySelector('.yc-confirm-btn.confirm');
    checkbox.addEventListener('change', () => {
      confirmButton.disabled = !checkbox.checked;
    });

    const handleClose = (confirmed) => {
      modal.remove();
      resolve(confirmed);
    };

    modal.querySelector('.yc-confirm-btn.cancel').addEventListener('click', () => handleClose(false));
    confirmButton.addEventListener('click', () => handleClose(true));
    modal.querySelector('.yc-confirm-backdrop').addEventListener('click', () => handleClose(false));
  });
}

// UI Elements
const elements = {
  loginPrompt: null,
  userProfileBox: null,
  userAvatar: null,
  userName: null,
  userPlan: null,
  googleSignIn: null,
  signInProgressMessage: null,
  signOutBtn: null,
  browserSupportWarning: null,
  browserSupportWarningText: null,
  browserSupportWarningClose: null,
  // Subscription elements
  usageSection: null,
  usageBar: null,
  usageText: null,
  upgradeBtn: null,
  manageBtn: null,
  billingSettingsBtn: null,
  billingSettingsPanel: null,
  billingSettingsBackBtn: null,
  billingSettingsStatus: null,
  billingPaymentMethodText: null,
  billingUpdatePaymentMethodBtn: null,
  billingChangePlanBtn: null,
  billingCancelSubscriptionBtn: null,
  billingRemovePaymentMethodBtn: null,
  billingDeleteAccountBtn: null,
  resetDate: null,
  premiumBadge: null,
  // Help elements
  helpBtn: null,
  helpPanel: null,
  helpCloseBtn: null,
  troubleshootingCard: null,
  troubleshootingToggleBtn: null,
  troubleshootingToggleIcon: null,
  troubleshootingBody: null,
  diagnosticsStartBtn: null,
  diagnosticsAnalyzeBtn: null,
  diagnosticsCopyBtn: null,
  diagnosticsClearBtn: null,
  diagnosticsStatus: null,
  diagnosticsResults: null,
  diagnosticsSupportTicketLink: null,
  helpSupportTicketLink: null,
  extensionVersion: null,
  // Plan features elements
  planInfoBtn: null,
  planInfoTooltip: null,
  tooltipPlanTitle: null,
  tooltipFeaturesList: null,
  // Gemini API section collapse controls
  apiKeySection: null,
  apiSectionContent: null,
  apiSectionToggleBtn: null,
  apiSectionToggleArrow: null
};

const YOUCHORDS_WEBSITE_ORIGIN = 'https://www.you-chords.com';
const MIN_SUPPORTED_CHROMIUM_MAJOR = 127;
const BROWSER_SUPPORT_WARNING_DISMISSED_KEY = 'yc_browser_support_warning_dismissed_v1';
const API_KEY_TUTORIAL_URL = 'https://www.youtube.com/watch?v=Oa64UysYHqk';
const POPUP_TOUR_SEEN_STORAGE_KEY = 'yc_popup_tour_seen_v1';
const POPUP_TOUR_PENDING_STORAGE_KEY = 'yc_popup_tour_pending_v1';
const TROUBLESHOOTING_EXPANDED_STORAGE_KEY = 'yc_troubleshooting_expanded_v1';
const DIAGNOSTICS_ACTIVE_STORAGE_KEY = 'yc_diagnostics_active_v1';
const DIAGNOSTICS_LAST_REPORT_STORAGE_KEY = 'yc_diagnostics_last_report_v1';
const DIAGNOSTICS_DURATION_MS = 10 * 60 * 1000;
let lastDiagnosticsReportText = '';
let diagnosticsCopyFeedbackTimer = null;

const popupTourState = {
  active: false,
  steps: [],
  index: 0,
  flowStartIndex: 0,
  flowTotalSteps: 0,
  overlay: null,
  highlight: null,
  card: null,
  titleEl: null,
  descriptionEl: null,
  counterEl: null,
  prevBtn: null,
  nextBtn: null,
  cleanupFns: [],
  positionTimerId: null
};

function isPopupElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
}

function ensurePopupTourStyles() {
  if (document.getElementById('yc-popup-tour-style')) return;
  const style = document.createElement('style');
  style.id = 'yc-popup-tour-style';
  style.textContent = `
    #yc-popup-tour-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: rgba(0, 0, 0, 0.52);
    }
    #yc-popup-tour-highlight {
      position: fixed;
      border: 2px solid #3ea6ff;
      border-radius: 10px;
      box-shadow: 0 0 0 3px rgba(62, 166, 255, 0.22), 0 0 14px rgba(62, 166, 255, 0.5);
      pointer-events: none;
      z-index: 2147483647;
    }
    #yc-popup-tour-card {
      position: fixed;
      width: min(240px, calc(100vw - 16px));
      max-height: min(58vh, 260px);
      overflow-y: auto;
      color: #fff;
      background: rgba(12, 12, 12, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
      padding: 10px;
      z-index: 2147483647;
      font-family: Arial, sans-serif;
    }
    #yc-popup-tour-card h4 {
      margin: 0 0 8px 0;
      font-size: 14px;
      line-height: 1.3;
    }
    #yc-popup-tour-card p {
      margin: 0;
      color: #ddd;
      font-size: 12px;
      line-height: 1.35;
    }
    .yc-popup-tour-footer {
      margin-top: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .yc-popup-tour-counter {
      font-size: 11px;
      color: #aaa;
    }
    .yc-popup-tour-actions {
      display: flex;
      gap: 6px;
    }
    .yc-popup-tour-btn {
      border: 0;
      border-radius: 8px;
      padding: 6px 9px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .yc-popup-tour-btn-ghost {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }
    .yc-popup-tour-btn-primary {
      background: #3ea6ff;
      color: #041321;
    }
    .yc-popup-tour-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }
  `;
  document.head.appendChild(style);
}

async function getPopupTourSeen() {
  const result = await chrome.storage.local.get([POPUP_TOUR_SEEN_STORAGE_KEY]);
  const value = result?.[POPUP_TOUR_SEEN_STORAGE_KEY];
  if (value === true) return true;
  return !!(value && value.seen === true);
}

function setPopupTourSeen() {
  chrome.storage.local.set({
    [POPUP_TOUR_SEEN_STORAGE_KEY]: {
      seen: true,
      seenAt: Date.now(),
      version: 1
    }
  });
}

function getPopupTourStepDefs() {
  const accountTarget = isPopupElementVisible(document.getElementById('userProfileBox'))
    ? '#userProfileBox'
    : '#googleSignIn';

  return [
    {
      selector: accountTarget,
      title: 'Account Area',
      description: 'Sign in here, manage your plan/subscription details, and see your chords usage bar.'
    },
    {
      selector: '#apiKeyInput',
      title: 'Gemini API Key',
      description: 'Paste your Gemini API key here to enable AI transcription.'
    },
    {
      selector: '#saveApiKeyBtn',
      title: 'Save Key',
      description: 'Save after entering a valid API key.'
    },
    {
      selector: '.api-help-actions',
      title: 'Need Help?',
      description: 'Use the tutorial if you are not sure how to get the key.'
    },
    {
      selector: '#helpBtn',
      title: 'Help & FAQ',
      description: 'Open quick answers for common issues.'
    }
  ];
}

function collectPopupTourSteps() {
  return getPopupTourStepDefs()
    .map(step => {
      const el = document.querySelector(step.selector);
      if (!isPopupElementVisible(el)) return null;
      const rect = el.getBoundingClientRect();
      return { ...step, __top: rect.top, __left: rect.left };
    })
    .filter(Boolean)
    .sort((a, b) => (a.__top - b.__top) || (a.__left - b.__left))
    .map(({ __top, __left, ...step }) => step);
}

function popupTourClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanupPopupTourDom() {
  if (popupTourState.positionTimerId) {
    clearInterval(popupTourState.positionTimerId);
    popupTourState.positionTimerId = null;
  }
  popupTourState.cleanupFns.forEach(fn => {
    try { fn(); } catch (e) { }
  });
  popupTourState.cleanupFns = [];
  popupTourState.overlay?.remove();
  popupTourState.highlight?.remove();
  popupTourState.card?.remove();
  popupTourState.overlay = null;
  popupTourState.highlight = null;
  popupTourState.card = null;
  popupTourState.titleEl = null;
  popupTourState.descriptionEl = null;
  popupTourState.counterEl = null;
  popupTourState.prevBtn = null;
  popupTourState.nextBtn = null;
  popupTourState.flowStartIndex = 0;
  popupTourState.flowTotalSteps = 0;
  popupTourState.steps = [];
  popupTourState.index = 0;
}

function stopPopupTour({ markSeen = false } = {}) {
  if (!popupTourState.active) {
    cleanupPopupTourDom();
    return;
  }
  popupTourState.active = false;
  cleanupPopupTourDom();
  if (markSeen) setPopupTourSeen();
}

function getCurrentPopupTourTarget() {
  const step = popupTourState.steps[popupTourState.index];
  if (!step) return null;
  const el = document.querySelector(step.selector);
  return isPopupElementVisible(el) ? el : null;
}

function positionPopupTour() {
  if (!popupTourState.active || !popupTourState.card || !popupTourState.highlight) return;
  const target = getCurrentPopupTourTarget();
  if (!target) {
    stopPopupTour({ markSeen: true });
    return;
  }
  const rect = target.getBoundingClientRect();
  const pad = 5;
  popupTourState.highlight.style.left = `${Math.round(rect.left - pad)}px`;
  popupTourState.highlight.style.top = `${Math.round(rect.top - pad)}px`;
  popupTourState.highlight.style.width = `${Math.round(rect.width + pad * 2)}px`;
  popupTourState.highlight.style.height = `${Math.round(rect.height + pad * 2)}px`;

  const cardRect = popupTourState.card.getBoundingClientRect();
  const viewportPad = 10;
  let top = rect.bottom + 10;
  if (top + cardRect.height > window.innerHeight - viewportPad) {
    top = rect.top - cardRect.height - 10;
  }
  top = popupTourClamp(top, viewportPad, window.innerHeight - cardRect.height - viewportPad);

  let left = rect.left + rect.width / 2 - cardRect.width / 2;
  left = popupTourClamp(left, viewportPad, window.innerWidth - cardRect.width - viewportPad);

  popupTourState.card.style.left = `${Math.round(left)}px`;
  popupTourState.card.style.top = `${Math.round(top)}px`;
}

function renderPopupTourStep() {
  if (!popupTourState.active) return;
  const step = popupTourState.steps[popupTourState.index];
  if (!step) {
    stopPopupTour({ markSeen: true });
    return;
  }
  popupTourState.titleEl.textContent = step.title;
  popupTourState.descriptionEl.textContent = step.description;
  const currentStepNumber = popupTourState.flowStartIndex + popupTourState.index + 1;
  const totalSteps = popupTourState.flowTotalSteps > 0
    ? popupTourState.flowTotalSteps
    : (popupTourState.flowStartIndex + popupTourState.steps.length);
  popupTourState.counterEl.textContent = `Step ${currentStepNumber}/${totalSteps}`;
  popupTourState.prevBtn.disabled = popupTourState.index === 0;
  popupTourState.nextBtn.textContent = popupTourState.index === popupTourState.steps.length - 1 ? 'Done' : 'Next';
  positionPopupTour();
}

async function startPopupTour(force = false, flowMeta = null) {
  if (popupTourState.active) return;
  if (!force) {
    const seen = await getPopupTourSeen();
    if (seen) return;
  }

  const steps = collectPopupTourSteps();
  if (steps.length === 0) return;

  ensurePopupTourStyles();
  cleanupPopupTourDom();

  const overlay = document.createElement('div');
  overlay.id = 'yc-popup-tour-overlay';

  const highlight = document.createElement('div');
  highlight.id = 'yc-popup-tour-highlight';

  const card = document.createElement('div');
  card.id = 'yc-popup-tour-card';
  card.innerHTML = `
    <h4></h4>
    <p></p>
    <div class="yc-popup-tour-footer">
      <span class="yc-popup-tour-counter"></span>
      <div class="yc-popup-tour-actions">
        <button class="yc-popup-tour-btn yc-popup-tour-btn-ghost yc-popup-tour-skip">Skip</button>
        <button class="yc-popup-tour-btn yc-popup-tour-btn-ghost yc-popup-tour-prev">Back</button>
        <button class="yc-popup-tour-btn yc-popup-tour-btn-primary yc-popup-tour-next">Next</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(highlight);
  document.body.appendChild(card);

  popupTourState.active = true;
  popupTourState.steps = steps;
  popupTourState.index = 0;
  popupTourState.flowStartIndex = Number.isFinite(flowMeta?.flowStartIndex) ? flowMeta.flowStartIndex : 0;
  popupTourState.flowTotalSteps = Number.isFinite(flowMeta?.flowTotalSteps) ? flowMeta.flowTotalSteps : 0;
  popupTourState.overlay = overlay;
  popupTourState.highlight = highlight;
  popupTourState.card = card;
  popupTourState.titleEl = card.querySelector('h4');
  popupTourState.descriptionEl = card.querySelector('p');
  popupTourState.counterEl = card.querySelector('.yc-popup-tour-counter');
  popupTourState.prevBtn = card.querySelector('.yc-popup-tour-prev');
  popupTourState.nextBtn = card.querySelector('.yc-popup-tour-next');

  const skipBtn = card.querySelector('.yc-popup-tour-skip');

  const onSkip = () => stopPopupTour({ markSeen: true });
  const onPrev = () => {
    if (popupTourState.index > 0) {
      popupTourState.index -= 1;
      renderPopupTourStep();
    }
  };
  const onNext = () => {
    if (popupTourState.index >= popupTourState.steps.length - 1) {
      stopPopupTour({ markSeen: true });
      return;
    }
    popupTourState.index += 1;
    renderPopupTourStep();
  };
  const onResize = () => positionPopupTour();
  const onScroll = () => positionPopupTour();
  const onKeydown = (e) => {
    if (!popupTourState.active) return;
    if (e.key === 'Escape') stopPopupTour({ markSeen: true });
  };

  skipBtn.addEventListener('click', onSkip);
  popupTourState.prevBtn.addEventListener('click', onPrev);
  popupTourState.nextBtn.addEventListener('click', onNext);
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKeydown, { passive: true });

  popupTourState.cleanupFns.push(() => skipBtn.removeEventListener('click', onSkip));
  popupTourState.cleanupFns.push(() => popupTourState.prevBtn?.removeEventListener('click', onPrev));
  popupTourState.cleanupFns.push(() => popupTourState.nextBtn?.removeEventListener('click', onNext));
  popupTourState.cleanupFns.push(() => window.removeEventListener('resize', onResize));
  popupTourState.cleanupFns.push(() => window.removeEventListener('scroll', onScroll));
  popupTourState.cleanupFns.push(() => window.removeEventListener('keydown', onKeydown));

  popupTourState.positionTimerId = setInterval(() => {
    if (!popupTourState.active) return;
    positionPopupTour();
  }, 250);

  renderPopupTourStep();
}

async function maybeStartPopupTourFromPending() {
  const result = await chrome.storage.local.get([
    POPUP_TOUR_PENDING_STORAGE_KEY,
    POPUP_TOUR_SEEN_STORAGE_KEY
  ]);
  const pendingValue = result?.[POPUP_TOUR_PENDING_STORAGE_KEY];
  const pending = pendingValue === true || !!pendingValue?.pending;

  if (!pending) return;
  await chrome.storage.local.remove([POPUP_TOUR_PENDING_STORAGE_KEY]);

  const flowStartIndex = Number.isFinite(pendingValue?.completedButtonsSteps)
    ? pendingValue.completedButtonsSteps
    : 0;
  const flowTotalSteps = Number.isFinite(pendingValue?.totalFlowSteps)
    ? pendingValue.totalFlowSteps
    : 0;

  setTimeout(() => {
    startPopupTour(true, { flowStartIndex, flowTotalSteps }).catch((err) => {
      console.warn('[Popup Tour] Failed to start:', err);
    });
  }, 350);
}

window.__ycStartPopupTour = () => startPopupTour(true);
window.addEventListener('beforeunload', () => {
  stopPopupTour({ markSeen: false });
});

// Plan configurations
// Plans: Free, Basic, Starter, Pro - paid plans include all features
const PLANS = {
  free: { name: 'Free', class: 'free', chordsLimit: 7 },
  basic: { name: 'Basic', class: 'basic', chordsLimit: 100 },
  starter: { name: 'Starter', class: 'starter', chordsLimit: 300 },
  pro: { name: 'PRO', class: 'pro', chordsLimit: 1000 }
};

// Plan features for info popup
const PLAN_FEATURES = {
  free: [
    { text: 'UP TO 7 SONGS TOTAL (FREE PLAN LIMIT)', included: true, emphasis: true },
    { text: 'Songs up to 6 minutes', included: true },
    { text: 'All features included', included: true },
    { text: '24/7 Support', included: true },
    { text: 'Practice tools', included: true },
    { text: 'All chord modes (R/R+/H/H+)', included: true },
    { text: 'Auto Pitch Fix', included: true },
    { text: 'Capo Position', included: true },
    { text: 'YouTube Captions', included: true },
    { text: 'Gemini Transcription<br>(with your API key)', included: true }
  ],
  basic: [
    { text: '100 chords/month', included: true },
    { text: 'Songs up to 35 minutes', included: true },
    { text: '24/7 Support', included: true },
    { text: 'Practice Tools', included: true },
    { text: 'All chord modes (R/R+/H/H+)', included: true },
    { text: 'Auto Pitch Fix', included: true },
    { text: 'Capo Position', included: true },
    { text: 'YouTube Captions', included: true },
    { text: 'Gemini Transcription<br>(with your API key)', included: true },
    { text: 'Fair usage applies', included: true }
  ],
  starter: [
    { text: '300 chords/month', included: true },
    { text: 'Songs up to 35 minutes', included: true },
    { text: '24/7 Support', included: true },
    { text: 'Practice Tools', included: true },
    { text: 'All chord modes (R/R+/H/H+)', included: true },
    { text: 'Auto Pitch Fix', included: true },
    { text: 'Capo Position', included: true },
    { text: 'YouTube Captions', included: true },
    { text: 'Gemini Transcription<br>(with your API key)', included: true },
    { text: 'Fair usage applies', included: true }
  ],
  pro: [
    { text: '1,000 chords/month', included: true },
    { text: 'Songs up to 35 minutes', included: true },
    { text: '24/7 Support', included: true },
    { text: 'Practice Tools', included: true },
    { text: 'All chord modes (R/R+/H/H+)', included: true },
    { text: 'Auto Pitch Fix', included: true },
    { text: 'Capo Position', included: true },
    { text: 'YouTube Captions', included: true },
    { text: 'Gemini Transcription<br>(with your API key)', included: true }
  ]
};

// Initialize elements after DOM loads
function initElements() {
  elements.loginPrompt = document.getElementById('loginPrompt');
  elements.userProfileBox = document.getElementById('userProfileBox');
  elements.userAvatar = document.getElementById('userAvatar');
  elements.userName = document.getElementById('userName');
  elements.userPlan = document.getElementById('userPlan');
  elements.googleSignIn = document.getElementById('googleSignIn');
  elements.signInProgressMessage = document.getElementById('signInProgressMessage');
  elements.signOutBtn = document.getElementById('signOutBtn');
  elements.browserSupportWarning = document.getElementById('browserSupportWarning');
  elements.browserSupportWarningText = document.getElementById('browserSupportWarningText');
  elements.browserSupportWarningClose = document.getElementById('browserSupportWarningClose');
  // Subscription elements
  elements.usageSection = document.getElementById('usageSection');
  elements.usageBar = document.getElementById('usageBar');
  elements.usageText = document.getElementById('usageText');
  elements.upgradeBtn = document.getElementById('upgradeBtn');
  elements.manageBtn = document.getElementById('manageBtn');
  elements.billingSettingsBtn = document.getElementById('billingSettingsBtn');
  elements.billingSettingsPanel = document.getElementById('billingSettingsPanel');
  elements.billingSettingsBackBtn = document.getElementById('billingSettingsBackBtn');
  elements.billingSettingsStatus = document.getElementById('billingSettingsStatus');
  elements.billingPaymentMethodText = document.getElementById('billingPaymentMethodText');
  elements.billingUpdatePaymentMethodBtn = document.getElementById('billingUpdatePaymentMethodBtn');
  elements.billingChangePlanBtn = document.getElementById('billingChangePlanBtn');
  elements.billingCancelSubscriptionBtn = document.getElementById('billingCancelSubscriptionBtn');
  elements.billingRemovePaymentMethodBtn = document.getElementById('billingRemovePaymentMethodBtn');
  elements.billingDeleteAccountBtn = document.getElementById('billingDeleteAccountBtn');
  elements.resetDate = document.getElementById('resetDate');
  elements.premiumBadge = document.getElementById('premiumBadge');
  // Help elements
  elements.helpBtn = document.getElementById('helpBtn');
  elements.helpPanel = document.getElementById('helpPanel');
  elements.helpCloseBtn = document.getElementById('helpCloseBtn');
  elements.troubleshootingCard = document.getElementById('troubleshootingCard');
  elements.troubleshootingToggleBtn = document.getElementById('troubleshootingToggleBtn');
  elements.troubleshootingToggleIcon = document.getElementById('troubleshootingToggleIcon');
  elements.troubleshootingBody = document.getElementById('troubleshootingBody');
  elements.diagnosticsStartBtn = document.getElementById('diagnosticsStartBtn');
  elements.diagnosticsAnalyzeBtn = document.getElementById('diagnosticsAnalyzeBtn');
  elements.diagnosticsCopyBtn = document.getElementById('diagnosticsCopyBtn');
  elements.diagnosticsClearBtn = document.getElementById('diagnosticsClearBtn');
  elements.diagnosticsStatus = document.getElementById('diagnosticsStatus');
  elements.diagnosticsResults = document.getElementById('diagnosticsResults');
  elements.diagnosticsSupportTicketLink = document.getElementById('diagnosticsSupportTicketLink');
  elements.helpSupportTicketLink = document.getElementById('helpSupportTicketLink');
  elements.extensionVersion = document.getElementById('extensionVersion');
  // Plan features elements
  elements.planInfoBtn = document.getElementById('planInfoBtn');
  elements.planInfoTooltip = document.getElementById('planInfoTooltip');
  elements.tooltipPlanTitle = document.getElementById('tooltipPlanTitle');
  elements.tooltipFeaturesList = document.getElementById('tooltipFeaturesList');
  // Gemini API section collapse controls
  elements.apiKeySection = document.getElementById('apiKeySection');
  elements.apiSectionContent = document.getElementById('apiSectionContent');
  elements.apiSectionToggleBtn = document.getElementById('apiSectionToggleBtn');
  elements.apiSectionToggleArrow = document.getElementById('apiSectionToggleArrow');
}

function buildConsentPayload(source) {
  return {
    accepted: true,
    version: CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
    source
  };
}

function normalizeStoredConsent(consent, source = 'popup_stored_consent') {
  if (!consent || consent.accepted !== true) return null;
  if (typeof consent.version !== 'string' || consent.version.trim() !== CONSENT_VERSION) return null;

  const acceptedAt = new Date(consent.acceptedAt || Date.now());
  if (Number.isNaN(acceptedAt.getTime())) return null;

  const consentSource = typeof consent.source === 'string' && consent.source.trim()
    ? consent.source.trim()
    : source;

  return {
    accepted: true,
    version: CONSENT_VERSION,
    acceptedAt: acceptedAt.toISOString(),
    source: consentSource
  };
}

async function getStoredConsentFromLocal() {
  try {
    const result = await chrome.storage.local.get([CONSENT_STORAGE_KEY]);
    return normalizeStoredConsent(result?.[CONSENT_STORAGE_KEY]);
  } catch (error) {
    console.warn('[Popup] Failed to read stored consent:', error);
    return null;
  }
}

function setPopupConsentVisibility(show) {
  const error = document.querySelector('.consent-error');
  const notice = document.querySelector('.consent-notice');
  if (error) {
    error.style.display = 'none';
  }
  if (notice) {
    notice.style.display = '';
  }
  updatePopupConsentGate();
}

function renderExtensionVersion() {
  if (!elements.extensionVersion) return;
  const version = chrome.runtime.getManifest?.().version || '';
  if (!version) {
    elements.extensionVersion.hidden = true;
    return;
  }
  elements.extensionVersion.textContent = `v${version}`;
  elements.extensionVersion.title = `YouChords extension version ${version}`;
}

async function syncPopupConsentUI() {
  const storedConsent = await getStoredConsentFromLocal();
  setPopupConsentVisibility(!storedConsent);
}

function getPopupConsentPayloadIfChecked(source = 'popup_signin') {
  return buildConsentPayload(source);
}

function markPopupConsentRequired() {
  const error = document.querySelector('.consent-error');
  if (error) {
    error.textContent = 'Could not record sign-in consent. Please try again.';
    error.style.display = 'block';
  }
  updatePopupConsentGate();
  showToast('⚠️', 'Could not record sign-in consent. Please try again.', 'error');
}

function getPopupSignInFailureMessage(error) {
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
}

function updatePopupConsentGate() {
  const signInBtn = elements.googleSignIn || document.getElementById('googleSignIn');
  if (!signInBtn) return;
  signInBtn.disabled = false;
  signInBtn.setAttribute('aria-disabled', 'false');
  signInBtn.title = '';
}

function setSignInBusy(isBusy) {
  if (elements.googleSignIn) {
    elements.googleSignIn.disabled = !!isBusy;
    elements.googleSignIn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    elements.googleSignIn.innerHTML = isBusy
      ? '<span class="spinner"></span>Signing in...'
      : '<img src="images/icons/google-icon.svg" alt="Google" class="google-icon">Sign in with Google';
  }
  if (elements.signInProgressMessage) {
    elements.signInProgressMessage.hidden = !isBusy;
  }
}

// Update UI based on user state
function updateUserUI(user) {
  if (user) {
    elements.loginPrompt.style.display = 'none';
    elements.userProfileBox.style.display = 'block';
    elements.userAvatar.src = user.photoURL || 'images/icons/default-avatar.svg';
    elements.userName.textContent = user.displayName || 'User';

    // Get subscription info from JWT (more accurate than user object)
    const subInfo = getSubscriptionInfo();
    if (subInfo) {
      updateSubscriptionUI(subInfo);
    } else {
      // Fallback to user object
      updateSubscriptionUI({
        plan: user.plan || 'free',
        chordsUsed: 0,
        chordsLimit: 7
      });
    }

    // Save user to storage
    chrome.storage.sync.set({ user: user });
  } else {
    elements.loginPrompt.style.display = 'block';
    elements.userProfileBox.style.display = 'none';
    elements.usageSection.style.display = 'none';
    if (elements.bonusSection) elements.bonusSection.style.display = 'none';

    // Clear user from storage
    chrome.storage.sync.remove('user');
  }
}

function setAuthBootstrapPending(isPending) {
  if (!document.body) return;
  if (isPending) {
    document.body.classList.add('auth-pending');
  } else {
    document.body.classList.remove('auth-pending');
  }
}

function clearResetDateInteraction() {
  if (!elements.resetDate) return;
  cleanupRenewalFormatMenuListeners();
  elements.resetDate.onclick = null;
  elements.resetDate.onkeydown = null;
  elements.resetDate.classList.remove('is-clickable');
  elements.resetDate.classList.remove('has-format-toggle');
  elements.resetDate.classList.remove('is-menu-open');
  elements.resetDate.closest('.user-profile-box')?.classList.remove('renewal-menu-active');
  elements.resetDate.removeAttribute('role');
  elements.resetDate.removeAttribute('tabindex');
  elements.resetDate.removeAttribute('title');
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function formatRenewalDatePart(date, dateFormat = 'local') {
  const day = padDatePart(date.getDate());
  const month = padDatePart(date.getMonth() + 1);
  const year = date.getFullYear();
  const monthLong = date.toLocaleString(undefined, { month: 'long' });
  const monthShort = date.toLocaleString(undefined, { month: 'short' });

  if (dateFormat === 'dmy') {
    return `${day}/${month}/${year}`;
  }

  if (dateFormat === 'mdy') {
    return `${month}/${day}/${year}`;
  }

  if (dateFormat === 'iso') {
    return `${year}-${month}-${day}`;
  }

  if (dateFormat === 'monthLongDayYear') {
    return `${monthLong} ${day}, ${year}`;
  }

  if (dateFormat === 'monthShortDayYear') {
    return `${monthShort} ${day}, ${year}`;
  }

  if (dateFormat === 'dayMonthLongYear') {
    return `${day} ${monthLong} ${year}`;
  }

  if (dateFormat === 'dayMonthShortYear') {
    return `${day} ${monthShort} ${year}`;
  }

  if (dateFormat === 'monthLongDayYearNoComma') {
    return `${monthLong} ${day} ${year}`;
  }

  if (dateFormat === 'monthShortDayYearNoComma') {
    return `${monthShort} ${day} ${year}`;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatRenewalTimePart(date, timeFormat = 'local') {
  const options = {
    hour: timeFormat === '24h' ? '2-digit' : 'numeric',
    minute: '2-digit'
  };

  if (timeFormat === '24h') {
    options.hour12 = false;
  } else if (timeFormat === '12h') {
    options.hour12 = true;
  }

  return date.toLocaleTimeString(undefined, options);
}

function formatRenewalDate(date, options = {}) {
  const dateFormat = RENEWAL_DATE_FORMATS.includes(options.dateFormat) ? options.dateFormat : 'local';
  const timeFormat = RENEWAL_TIME_FORMATS.includes(options.timeFormat) ? options.timeFormat : 'local';
  const showTime = options.showTime !== false;
  const datePart = formatRenewalDatePart(date, dateFormat);
  if (!showTime) return datePart;
  return `${datePart}, ${formatRenewalTimePart(date, timeFormat)}`;
}

function shouldShowRenewalTime() {
  try {
    return localStorage.getItem(RENEWAL_DATE_SHOW_TIME_KEY) !== 'false';
  } catch (error) {
    console.warn('[Popup] Failed reading renewal date preference:', error);
    return true;
  }
}

function saveShowRenewalTime(showTime) {
  try {
    localStorage.setItem(RENEWAL_DATE_SHOW_TIME_KEY, showTime ? 'true' : 'false');
  } catch (error) {
    console.warn('[Popup] Failed saving renewal date preference:', error);
  }
}

function getRenewalFormatPreferences() {
  try {
    const rawDateFormat = localStorage.getItem(RENEWAL_DATE_FORMAT_KEY) || 'local';
    const rawTimeFormat = localStorage.getItem(RENEWAL_TIME_FORMAT_KEY) || 'local';
    return {
      showTime: shouldShowRenewalTime(),
      dateFormat: RENEWAL_DATE_FORMATS.includes(rawDateFormat) ? rawDateFormat : 'local',
      timeFormat: RENEWAL_TIME_FORMATS.includes(rawTimeFormat) ? rawTimeFormat : 'local'
    };
  } catch (error) {
    console.warn('[Popup] Failed reading renewal date format preferences:', error);
    return { showTime: true, dateFormat: 'local', timeFormat: 'local' };
  }
}

function saveRenewalFormatPreferences(preferences) {
  try {
    saveShowRenewalTime(preferences.showTime !== false);
    localStorage.setItem(
      RENEWAL_DATE_FORMAT_KEY,
      RENEWAL_DATE_FORMATS.includes(preferences.dateFormat) ? preferences.dateFormat : 'local'
    );
    localStorage.setItem(
      RENEWAL_TIME_FORMAT_KEY,
      RENEWAL_TIME_FORMATS.includes(preferences.timeFormat) ? preferences.timeFormat : 'local'
    );
  } catch (error) {
    console.warn('[Popup] Failed saving renewal date format preferences:', error);
  }
}

function positionRenewalFormatMenu(menu, anchor) {
  if (!menu || !anchor) return;

  const margin = 8;
  const gap = 6;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 330;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight || 520;
  const anchorRect = anchor.getBoundingClientRect();
  const menuWidth = Math.min(238, Math.max(210, viewportWidth - margin * 2));

  menu.style.width = `${menuWidth}px`;
  menu.style.maxHeight = '';
  menu.style.visibility = 'hidden';

  const naturalHeight = menu.scrollHeight || 260;
  const spaceBelow = viewportHeight - anchorRect.bottom - margin - gap;
  const spaceAbove = anchorRect.top - margin - gap;
  const openAbove = spaceBelow < 210 && spaceAbove > spaceBelow;
  const availableHeight = Math.max(160, openAbove ? spaceAbove : spaceBelow);
  const menuHeight = Math.min(naturalHeight, availableHeight, 310);
  const left = Math.min(
    Math.max(margin, anchorRect.right - menuWidth),
    Math.max(margin, viewportWidth - menuWidth - margin)
  );
  const top = openAbove
    ? Math.max(margin, anchorRect.top - menuHeight - gap)
    : Math.min(anchorRect.bottom + gap, viewportHeight - menuHeight - margin);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.round(menuHeight)}px`;
  menu.style.visibility = '';
}

// Update subscription UI
function updateSubscriptionUI(subInfo) {
  const formatNumber = (value) => {
    const num = Number(value) || 0;
    return num.toLocaleString('en-US');
  };

  // Get values from subscription info (from JWT)
  const plan = subInfo?.plan || 'free';
  const chordsUsed = subInfo?.chordsUsed || 0;
  const chordsLimit = subInfo?.chordsLimit ?? 5;
  const blocked = !!subInfo?.blocked;
  const blockedReason = subInfo?.blockedReason || 'payment dispute';

  // Processing credits (for display)
  const processingChordsUsed = subInfo?.processingChordsUsed || 0;
  const processingChordsLimit = subInfo?.processingChordsLimit || 0;

  const planConfig = PLANS[plan] || PLANS.free;

  if (blocked) {
    elements.userPlan.textContent = 'Blocked';
    elements.userPlan.style.color = '#ef4444';

    if (elements.premiumBadge) {
      elements.premiumBadge.style.display = 'none';
    }
    if (elements.manageBtn) {
      elements.manageBtn.style.display = 'none';
    }
    if (elements.billingSettingsBtn) {
      elements.billingSettingsBtn.style.display = 'none';
    }
    if (elements.billingSettingsPanel) {
      elements.billingSettingsPanel.style.display = 'none';
    }
    if (elements.upgradeBtn) {
      elements.upgradeBtn.style.display = 'none';
    }
    if (elements.usageSection) {
      elements.usageSection.style.display = 'none';
    }

    if (elements.resetDate) {
      clearResetDateInteraction();
      elements.resetDate.style.display = 'block';
      elements.resetDate.style.color = '#ef4444';
      elements.resetDate.textContent = `Account suspended (${blockedReason}). Contact billing@you-chords.com`;
    }
    return;
  }

  // Update plan name under user name
  elements.userPlan.textContent = planConfig.name;
  elements.userPlan.style.color = '';

  // Show/hide upgrade button, manage button and premium badge
  const isPremium = plan !== 'free';
  if (elements.premiumBadge) {
    elements.premiumBadge.style.display = isPremium ? 'block' : 'none';
  }

  // Show manage button for paid users
  if (elements.manageBtn) {
    elements.manageBtn.style.display = isPremium ? 'block' : 'none';
  }
  if (elements.billingSettingsBtn) {
    elements.billingSettingsBtn.style.display = isPremium ? 'block' : 'none';
  }
  if (!isPremium && elements.billingSettingsPanel) {
    elements.billingSettingsPanel.style.display = 'none';
  }

  // Show upgrade button only for free users. Paid users manage changes from Billing/Account.
  elements.upgradeBtn.style.display = isPremium ? 'none' : 'block';
  elements.upgradeBtn.textContent = 'Upgrade';

  // Determine what usage to show based on plan
  let showUsage = false;
  let usageText = '';
  let percentage = 0;

  if (plan === 'free') {
    // Free: show chords usage
    showUsage = true;
    percentage = (chordsUsed / chordsLimit) * 100;
    const hasRemainingChords = chordsUsed < chordsLimit;
    usageText = hasRemainingChords
      ? `🎁 ${chordsUsed}/${chordsLimit}`
      : `${chordsUsed}/${chordsLimit}`;
  } else if (isPremium) {
    // Paid plans: show processing chords usage
    showUsage = true;
    const effectiveLimit = processingChordsLimit > 0 ? processingChordsLimit : (planConfig.chordsLimit || 1000);
    percentage = (processingChordsUsed / effectiveLimit) * 100;
    usageText = `${formatNumber(processingChordsUsed)}/${formatNumber(effectiveLimit)} chords`;
  }

  if (showUsage && elements.usageSection) {
    elements.usageSection.style.display = 'block';
    elements.usageBar.style.width = Math.min(percentage, 100) + '%';
    elements.usageText.textContent = usageText;

    // Update bar color based on usage
    elements.usageBar.classList.remove('warning', 'critical');
    if (percentage >= 100) {
      elements.usageBar.classList.add('critical');
    } else if (percentage >= 80) {
      elements.usageBar.classList.add('warning');
    }
  } else if (elements.usageSection) {
    elements.usageSection.style.display = 'none';
  }

  // Show reset/renew date for paid plans
  if (elements.resetDate) {
    clearResetDateInteraction();
    const renewalAt = subInfo?.renewalAt;
    const cancelPending = subInfo?.cancelPending;

    if (renewalAt && isPremium) {
      const date = new Date(renewalAt);
      const formatted = formatRenewalDate(date, { showTime: false });
      if (cancelPending) {
        elements.resetDate.innerHTML = `Until: ${formatted}<br><a href="#" id="renewLink" style="color: #22c55e; text-decoration: underline; font-size: 11px;">Renew subscription</a>`;
        elements.resetDate.style.color = '#f59e0b';
        setTimeout(() => {
          const renewLink = document.getElementById('renewLink');
          if (renewLink) {
            renewLink.addEventListener('click', (e) => {
              e.preventDefault();
              handleRenewSubscription();
            });
          }
        }, 0);
      } else {
        let renewalPrefs = getRenewalFormatPreferences();
        let isFormatMenuOpen = false;
        const closeFormatMenu = () => {
          if (!isFormatMenuOpen) return;
          isFormatMenuOpen = false;
          renderRenewalDate();
        };
        const renderRenewalDate = () => {
          cleanupRenewalFormatMenuListeners();
          elements.resetDate.textContent = '';
          elements.resetDate.classList.add('has-format-toggle');
          elements.resetDate.classList.toggle('is-menu-open', isFormatMenuOpen);
          elements.resetDate.closest('.user-profile-box')?.classList.toggle('renewal-menu-active', isFormatMenuOpen);

          const row = document.createElement('span');
          row.className = 'renewal-format-row';

          const label = document.createElement('span');
          label.className = 'renewal-format-label';
          label.textContent = `Renew: ${formatRenewalDate(date, renewalPrefs)}`;

          const menuButton = document.createElement('button');
          menuButton.type = 'button';
          menuButton.className = 'renewal-format-toggle';
          menuButton.title = 'Change date and time format';
          menuButton.setAttribute('aria-label', 'Change renewal date and time format');
          menuButton.setAttribute('aria-expanded', isFormatMenuOpen ? 'true' : 'false');

          const icon = document.createElement('span');
          icon.className = 'renewal-format-icon';
          icon.setAttribute('aria-hidden', 'true');
          icon.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/>
              <path d="M12 7.5V12L15 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          `;

          menuButton.appendChild(icon);
          menuButton.addEventListener('click', (event) => {
            event.stopPropagation();
            isFormatMenuOpen = !isFormatMenuOpen;
            renderRenewalDate();
          });

          row.append(label, menuButton);
          elements.resetDate.appendChild(row);

          if (isFormatMenuOpen) {
            const menu = document.createElement('div');
            menu.className = 'renewal-format-menu';
            menu.addEventListener('click', (event) => event.stopPropagation());

            const createSection = (titleText, items) => {
              const section = document.createElement('div');
              section.className = 'renewal-format-section';

              const heading = document.createElement('div');
              heading.className = 'renewal-format-section-title';
              heading.textContent = titleText;
              section.appendChild(heading);

              const options = document.createElement('div');
              options.className = 'renewal-format-options';
              items.forEach((item) => {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = `renewal-format-option${item.active ? ' is-active' : ''}`;
                option.textContent = item.label;
                option.addEventListener('click', () => {
                  renewalPrefs = item.nextPrefs(renewalPrefs);
                  saveRenewalFormatPreferences(renewalPrefs);
                  isFormatMenuOpen = false;
                  renderRenewalDate();
                });
                options.appendChild(option);
              });
              section.appendChild(options);
              return section;
            };

            menu.appendChild(createSection('Date', [
              {
                label: 'Auto',
                active: renewalPrefs.dateFormat === 'local',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'local' })
              },
              {
                label: 'DD/MM/YYYY',
                active: renewalPrefs.dateFormat === 'dmy',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'dmy' })
              },
              {
                label: 'MM/DD/YYYY',
                active: renewalPrefs.dateFormat === 'mdy',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'mdy' })
              },
              {
                label: 'YYYY-MM-DD',
                active: renewalPrefs.dateFormat === 'iso',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'iso' })
              },
              {
                label: 'March 05, 2026',
                active: renewalPrefs.dateFormat === 'monthLongDayYear',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'monthLongDayYear' })
              },
              {
                label: 'Mar 05, 2026',
                active: renewalPrefs.dateFormat === 'monthShortDayYear',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'monthShortDayYear' })
              },
              {
                label: '05 March 2026',
                active: renewalPrefs.dateFormat === 'dayMonthLongYear',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'dayMonthLongYear' })
              },
              {
                label: '05 Mar 2026',
                active: renewalPrefs.dateFormat === 'dayMonthShortYear',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'dayMonthShortYear' })
              },
              {
                label: 'March 05 2026',
                active: renewalPrefs.dateFormat === 'monthLongDayYearNoComma',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'monthLongDayYearNoComma' })
              },
              {
                label: 'Mar 05 2026',
                active: renewalPrefs.dateFormat === 'monthShortDayYearNoComma',
                nextPrefs: (prefs) => ({ ...prefs, dateFormat: 'monthShortDayYearNoComma' })
              }
            ]));

            menu.appendChild(createSection('Time', [
              {
                label: 'Auto',
                active: renewalPrefs.showTime !== false && renewalPrefs.timeFormat === 'local',
                nextPrefs: (prefs) => ({ ...prefs, showTime: true, timeFormat: 'local' })
              },
              {
                label: '24h',
                active: renewalPrefs.showTime !== false && renewalPrefs.timeFormat === '24h',
                nextPrefs: (prefs) => ({ ...prefs, showTime: true, timeFormat: '24h' })
              },
              {
                label: 'AM/PM',
                active: renewalPrefs.showTime !== false && renewalPrefs.timeFormat === '12h',
                nextPrefs: (prefs) => ({ ...prefs, showTime: true, timeFormat: '12h' })
              },
              {
                label: 'Hide',
                active: renewalPrefs.showTime === false,
                nextPrefs: (prefs) => ({ ...prefs, showTime: false })
              }
            ]));

            document.body.appendChild(menu);
            renewalFormatMenuElement = menu;
            positionRenewalFormatMenu(menu, menuButton);

            const handleOutsidePointerDown = (event) => {
              const target = event.target;
              if (menu.contains(target) || menuButton.contains(target)) return;
              closeFormatMenu();
            };
            const handleEscape = (event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeFormatMenu();
            };

            setTimeout(() => {
              if (!isFormatMenuOpen || !document.body.contains(menu) || !document.body.contains(menuButton)) return;
              document.addEventListener('pointerdown', handleOutsidePointerDown, true);
              document.addEventListener('keydown', handleEscape, true);
              renewalFormatMenuCleanup = () => {
                document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
                document.removeEventListener('keydown', handleEscape, true);
              };
            }, 0);
          }
        };

        renderRenewalDate();
        elements.resetDate.style.color = '';
      }
      elements.resetDate.style.display = 'block';
    } else {
      clearResetDateInteraction();
      elements.resetDate.style.display = 'none';
    }
  }
}

// Handle upgrade button click
async function handleUpgrade() {
  const jwt = await getPopupJwtFromAnyStorage();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }
  await markUpgradePending('popup_upgrade_button');
  chrome.tabs.create({ url: buildWebsiteSessionUrl('/upgrade', jwt) });
}

// Handle manage subscription button click
async function handleManageSubscription() {
  const jwt = await getPopupJwtFromAnyStorage();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }
  await markSubscriptionStateDirty('popup_manage_subscription');
  chrome.tabs.create({ url: buildWebsiteSessionUrl('/account', jwt) });
}

async function handlePopupChangePlan(event) {
  event?.preventDefault();
  const jwt = await getPopupJwtFromAnyStorage();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  await markSubscriptionStateDirty('popup_change_plan');
  chrome.tabs.create({ url: buildWebsiteSessionUrl('/upgrade', jwt) });
}

function setBillingSettingsStatus(message = '', tone = 'info') {
  if (!elements.billingSettingsStatus) return;
  elements.billingSettingsStatus.textContent = message || '';
  elements.billingSettingsStatus.className = 'billing-settings-status';
  if (message) {
    elements.billingSettingsStatus.classList.add(tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'info');
  }
}

function setBillingPaymentMethodLoading(isLoading) {
  elements.billingPaymentMethodText?.classList.toggle('loading', !!isLoading);
}

function restoreBillingSettingsActionControls() {
  if (elements.billingSettingsBackBtn) {
    elements.billingSettingsBackBtn.disabled = false;
  }
  if (elements.billingUpdatePaymentMethodBtn) {
    elements.billingUpdatePaymentMethodBtn.disabled = !canUpdatePaymentMethodFromBillingData(billingSettingsData);
  }
  if (elements.billingChangePlanBtn) {
    elements.billingChangePlanBtn.disabled = false;
  }
  if (elements.billingRemovePaymentMethodBtn) {
    elements.billingRemovePaymentMethodBtn.disabled =
      !!billingSettingsData?.paymentMethodRemovalRequested || !billingSettingsData?.canRemovePaymentMethod;
  }
  if (elements.billingCancelSubscriptionBtn) {
    elements.billingCancelSubscriptionBtn.disabled = !!billingSettingsData?.cancelPending;
  }
  if (elements.billingDeleteAccountBtn) {
    elements.billingDeleteAccountBtn.disabled = false;
  }
}

function setBillingSettingsActionBusy(isBusy, message) {
  const busyMessage = message || 'Processing with Paddle... Please keep this popup open until this finishes.';
  if (isBusy) {
    setBillingSettingsStatus(busyMessage, 'info');
  }

  const actionButtons = [
    elements.billingSettingsBackBtn,
    elements.billingUpdatePaymentMethodBtn,
    elements.billingChangePlanBtn,
    elements.billingCancelSubscriptionBtn,
    elements.billingRemovePaymentMethodBtn,
    elements.billingDeleteAccountBtn
  ];
  actionButtons.forEach((button) => {
    if (button) button.disabled = !!isBusy;
  });

  if (!isBusy) {
    restoreBillingSettingsActionControls();
  }
}

function setRenewSubscriptionBusy(isBusy) {
  const renewLink = document.getElementById('renewLink');
  if (!renewLink) return;

  if (isBusy) {
    renewLink.dataset.originalText = renewLink.dataset.originalText || renewLink.textContent || 'Renew subscription';
    renewLink.textContent = 'Renewing...';
    renewLink.style.pointerEvents = 'none';
    renewLink.setAttribute('aria-disabled', 'true');
    return;
  }

  renewLink.textContent = renewLink.dataset.originalText || 'Renew subscription';
  renewLink.style.pointerEvents = '';
  renewLink.removeAttribute('aria-disabled');
  delete renewLink.dataset.originalText;
}

function parseBrowserMajorFromUserAgent() {
  const ua = navigator.userAgent || '';
  const edgeMatch = ua.match(/\bEdg\/(\d+)/);
  if (edgeMatch) {
    return { name: 'Microsoft Edge', id: 'edge', major: Number(edgeMatch[1]) };
  }

  const chromeMatch = ua.match(/\bChrome\/(\d+)/);
  if (chromeMatch) {
    return { name: 'Chrome', id: 'chrome', major: Number(chromeMatch[1]) };
  }

  const chromiumMatch = ua.match(/\bChromium\/(\d+)/);
  if (chromiumMatch) {
    return { name: 'Chromium browser', id: 'chromium', major: Number(chromiumMatch[1]) };
  }

  return { name: 'this browser', id: 'unknown', major: null };
}

function getPopupBrowserSupportInfo() {
  const info = parseBrowserMajorFromUserAgent();
  const major = Number(info.major || 0);
  return {
    ...info,
    isOld: Number.isFinite(major) && major > 0 && major < MIN_SUPPORTED_CHROMIUM_MAJOR,
    warningKey: `${info.id || 'unknown'}:${major || 'unknown'}`
  };
}

function hideBrowserSupportWarning() {
  if (elements.browserSupportWarning) {
    elements.browserSupportWarning.hidden = true;
  }
}

async function maybeShowBrowserSupportWarning() {
  const info = getPopupBrowserSupportInfo();
  if (!info.isOld) {
    hideBrowserSupportWarning();
    return;
  }

  const stored = await chrome.storage.local.get([BROWSER_SUPPORT_WARNING_DISMISSED_KEY]);
  if (stored?.[BROWSER_SUPPORT_WARNING_DISMISSED_KEY] === info.warningKey) {
    hideBrowserSupportWarning();
    return;
  }

  if (elements.browserSupportWarningText) {
    elements.browserSupportWarningText.textContent =
      `${info.name} ${info.major} may not fully support YouChords. Please update to version ${MIN_SUPPORTED_CHROMIUM_MAJOR}+ for the smoothest experience.`;
  }
  if (elements.browserSupportWarning) {
    elements.browserSupportWarning.hidden = false;
  }
}

async function handleBrowserSupportWarningDismiss() {
  const info = getPopupBrowserSupportInfo();
  await chrome.storage.local.set({ [BROWSER_SUPPORT_WARNING_DISMISSED_KEY]: info.warningKey });
  hideBrowserSupportWarning();
}

function getPopupJwt() {
  return localStorage.getItem('youchords_jwt');
}

function buildWebsiteSessionUrl(path, jwtOverride = '') {
  const url = new URL(path, YOUCHORDS_WEBSITE_ORIGIN);
  const jwt = jwtOverride || getPopupJwt();
  if (jwt) {
    url.searchParams.set('jwt', jwt);
  }
  return url.toString();
}

async function getPopupJwtFromAnyStorage() {
  const localJwt = getPopupJwt();
  if (localJwt) return localJwt;

  try {
    const result = await chrome.storage.local.get(['youchords_jwt']);
    const storageJwt = typeof result?.youchords_jwt === 'string' ? result.youchords_jwt : '';
    if (storageJwt) {
      localStorage.setItem('youchords_jwt', storageJwt);
      return storageJwt;
    }
  } catch (_) {
    // ignore storage read failures; the caller will show a sign-in message
  }

  return '';
}

async function handleOpenSupportTickets(event) {
  event?.preventDefault?.();
  const jwt = await getPopupJwtFromAnyStorage();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }
  chrome.tabs.create({ url: buildWebsiteSessionUrl('/support-tickets', jwt) });
}

let billingSettingsData = null;

const DELETE_ACCOUNT_POPUP_WARNING = 'This will permanently delete your account and all associated data. You will immediately lose access to YouChords, including creating chords and processing new songs. Your subscription will also be cancelled immediately. This action cannot be undone. To use YouChords again later, you will need a new account and a new paid subscription at the full current price.';

function getPopupBillingPeriodEndLabel() {
  const renewalAt = billingSettingsData?.renewalAt || getSubscriptionInfo()?.renewalAt;
  if (!renewalAt) return 'the end of your current billing period';

  const renewalDate = new Date(renewalAt);
  if (Number.isNaN(renewalDate.getTime())) {
    return 'the end of your current billing period';
  }

  return formatRenewalDate(renewalDate, { showTime: false });
}

function buildCancelSubscriptionDetailsMessage() {
  const periodEnd = getPopupBillingPeriodEndLabel();
  return [
    'What happens when you cancel:',
    '',
    '• Your subscription will not renew',
    `• You keep all your credits until ${periodEnd}`,
    '• Your account and data remain intact',
    '• You can resubscribe anytime'
  ].join('\n');
}

function buildRemovePaymentDetailsMessage(methodLabel) {
  const periodEnd = getPopupBillingPeriodEndLabel();
  return [
    `Payment method to remove:\n${methodLabel}`,
    '',
    'Important: removing your payment method also cancels your subscription renewal.',
    '',
    'What happens when you remove it:',
    '',
    '• Your saved payment method will be removed from Paddle when Paddle allows it.',
    '• Your subscription will not renew.',
    `• You keep paid access until ${periodEnd}.`,
    '• If Paddle still needs the payment method for the active billing period, removal will finish automatically once Paddle allows it.',
    '• You can add a new payment method later and renew/resume your subscription.'
  ].join('\n');
}

function canUpdatePaymentMethodFromBillingData(data) {
  if (!data) return false;
  if (data.canUpdatePaymentMethod === true) return true;
  if (data.canUpdatePaymentMethod === false) return false;
  return data.canRemovePaymentMethod === true;
}

async function confirmPopupFinalBillingAction(title, message, confirmText, checkboxText) {
  return showCheckboxConfirmDialog(
    '⚠️',
    title,
    message,
    confirmText,
    'Go back',
    checkboxText
  );
}

async function fetchBillingPaymentMethodsSnapshot(jwt) {
  const response = await fetch(`${API_BASE_URL}/api/billing/payment-methods`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Could not load billing details.');
  }
  billingSettingsData = data;
  return data;
}

async function fetchBillingPaymentMethods() {
  const jwt = getPopupJwt();
  if (!jwt) {
    setBillingSettingsStatus('Please sign in first.', 'error');
    return;
  }

  if (elements.billingPaymentMethodText) {
    elements.billingPaymentMethodText.textContent = 'Loading from Paddle...';
  }
  setBillingPaymentMethodLoading(true);
  if (elements.billingUpdatePaymentMethodBtn) {
    elements.billingUpdatePaymentMethodBtn.disabled = true;
  }
  if (elements.billingChangePlanBtn) {
    elements.billingChangePlanBtn.disabled = true;
  }
  if (elements.billingRemovePaymentMethodBtn) {
    elements.billingRemovePaymentMethodBtn.disabled = true;
  }
  if (elements.billingCancelSubscriptionBtn) {
    elements.billingCancelSubscriptionBtn.disabled = true;
  }
  setBillingSettingsStatus('', 'info');

  try {
    const data = await fetchBillingPaymentMethodsSnapshot(jwt);
    const methods = Array.isArray(data.paymentMethods) ? data.paymentMethods : [];
    const label = methods.length
      ? methods.map((method) => method.label || method.shortLabel || 'Payment method').join(', ')
      : 'Paddle did not expose saved payment method details yet.';
    if (elements.billingPaymentMethodText) {
      elements.billingPaymentMethodText.textContent = label;
    }
    setBillingPaymentMethodLoading(false);
    if (elements.billingUpdatePaymentMethodBtn) {
      const canUpdate = canUpdatePaymentMethodFromBillingData(data);
      elements.billingUpdatePaymentMethodBtn.disabled = !canUpdate;
      elements.billingUpdatePaymentMethodBtn.title = canUpdate
        ? 'Open Paddle checkout to update your saved payment method.'
        : 'No active paid subscription payment method can be updated.';
    }
    if (elements.billingChangePlanBtn) {
      elements.billingChangePlanBtn.disabled = false;
      elements.billingChangePlanBtn.title = 'Open YouChords plans to switch between Basic, Starter, and Pro.';
    }
    if (elements.billingRemovePaymentMethodBtn) {
      const canRemove = !!data.canRemovePaymentMethod && !data.paymentMethodRemovalRequested;
      elements.billingRemovePaymentMethodBtn.disabled = !canRemove;
      elements.billingRemovePaymentMethodBtn.title = data.paymentMethodRemovalRequested
        ? 'Payment method removal was already requested.'
        : (!data.canRemovePaymentMethod ? 'No active paid subscription payment method is available.' : '');
    }
    if (elements.billingCancelSubscriptionBtn) {
      elements.billingCancelSubscriptionBtn.disabled = !!data.cancelPending;
      elements.billingCancelSubscriptionBtn.title = data.cancelPending
        ? 'Subscription cancellation is already pending.'
        : '';
    }
    if (data.paymentMethodRemovalRequested) {
      setBillingSettingsStatus('Payment method removal is already requested. You will keep access until the end of the billing period.', 'info');
    } else if (data.warning) {
      setBillingSettingsStatus(data.warning, 'info');
    }
  } catch (error) {
    console.warn('[Popup] Failed to load billing payment methods:', error);
    if (elements.billingPaymentMethodText) {
      elements.billingPaymentMethodText.textContent = 'Could not load payment method details.';
    }
    setBillingPaymentMethodLoading(false);
    if (elements.billingRemovePaymentMethodBtn) {
      elements.billingRemovePaymentMethodBtn.disabled = true;
    }
    if (elements.billingChangePlanBtn) {
      elements.billingChangePlanBtn.disabled = false;
    }
    if (elements.billingUpdatePaymentMethodBtn) {
      elements.billingUpdatePaymentMethodBtn.disabled = true;
    }
    if (elements.billingCancelSubscriptionBtn) {
      elements.billingCancelSubscriptionBtn.disabled = false;
    }
    setBillingSettingsStatus(error?.message || 'Could not load payment method details.', 'error');
  }
}

async function handleBillingSettingsOpen(event) {
  event?.preventDefault();
  const jwt = getPopupJwt();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  const panelIsOpen = elements.billingSettingsPanel?.style.display === 'block';
  if (panelIsOpen) {
    handleBillingSettingsClose();
    return;
  }

  if (elements.billingSettingsPanel) {
    elements.billingSettingsPanel.style.display = 'block';
  }
  await fetchBillingPaymentMethods();
}

function handleBillingSettingsClose(event) {
  event?.preventDefault();
  if (elements.billingSettingsPanel) {
    elements.billingSettingsPanel.style.display = 'none';
  }
  setBillingSettingsStatus('', 'info');
}

async function handlePopupUpdatePaymentMethod(event) {
  event?.preventDefault();
  const jwt = getPopupJwt();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  try {
    setBillingSettingsActionBusy(true, 'Preparing payment method update... Please keep this popup open until the new tab opens.');
    const response = await fetch(`${API_BASE_URL}/api/billing/update-payment-method`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success || !data.url) {
      throw new Error(data.error || 'Could not open payment method update.');
    }

    await markSubscriptionStateDirty('popup_update_payment_method');
    setBillingSettingsStatus('Payment method update opened. Complete it in the new tab.', 'info');
    chrome.tabs.create({ url: data.url });
  } catch (error) {
    setBillingSettingsStatus(error?.message || 'Could not open payment method update.', 'error');
    showToast('❌', error?.message || 'Could not open payment method update', 'error');
  } finally {
    setBillingSettingsActionBusy(false);
  }
}

async function handlePopupCancelSubscription(event) {
  event?.preventDefault();
  const jwt = getPopupJwt();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  const confirmed = await showConfirmDialog(
    '⚠️',
    'Cancel Subscription',
    buildCancelSubscriptionDetailsMessage(),
    'Cancel subscription',
    'Keep subscription'
  );
  if (!confirmed) return;

  const finalConfirmed = await confirmPopupFinalBillingAction(
    'Are you sure?',
    'Final confirmation: your subscription renewal will be cancelled. You will keep paid access until the end of your current billing period.',
    'Yes, cancel renewal',
    'Are you sure? I understand the subscription will not renew.'
  );
  if (!finalConfirmed) return;

  try {
    setBillingSettingsActionBusy(true, 'Cancelling subscription... Please keep this popup open until this finishes.');
    const response = await fetch(`${API_BASE_URL}/api/cancel-subscription`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Failed to cancel subscription.');
    }
    await markSubscriptionStateDirty('popup_cancel_subscription');
    billingSettingsData = {
      ...(billingSettingsData || {}),
      cancelPending: true
    };
    setBillingSettingsStatus('Subscription cancellation requested. You keep paid access until the end of the billing period.', 'success');
    showToast('✓', 'Subscription cancellation requested', 'success');
    await handleRefresh();
  } catch (error) {
    setBillingSettingsStatus(error?.message || 'Failed to cancel subscription.', 'error');
    showToast('❌', error?.message || 'Failed to cancel subscription', 'error');
  } finally {
    setBillingSettingsActionBusy(false);
  }
}

async function handlePopupRemovePaymentMethod(event) {
  event?.preventDefault();
  const jwt = getPopupJwt();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  const methodLabel = elements.billingPaymentMethodText?.textContent || 'your saved payment method';
  const confirmed = await showConfirmDialog(
    '⚠️',
    'Remove Payment Method + Cancel Renewal',
    buildRemovePaymentDetailsMessage(methodLabel),
    'Remove payment',
    'Keep payment method'
  );
  if (!confirmed) return;

  const finalConfirmed = await confirmPopupFinalBillingAction(
    'Are you sure?',
    'Final confirmation: this will CANCEL your subscription renewal and remove, or request removal of, your saved payment method.',
    'Yes, remove payment',
    'Are you sure? I understand removing the payment method also cancels subscription renewal.'
  );
  if (!finalConfirmed) return;

  try {
    setBillingSettingsActionBusy(true, 'Removing payment method... Please keep this popup open until this finishes.');
    const response = await fetch(`${API_BASE_URL}/api/billing/remove-payment-method`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ source: 'popup_billing_settings' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to remove payment method.');
    }
    await markSubscriptionStateDirty('popup_remove_payment_method');
    const message = data.removalStatus === 'removed'
      ? 'Payment method removed. Subscription renewal cancelled.'
      : 'Renewal cancelled. Payment method removal will complete when Paddle allows it.';
    setBillingSettingsStatus(message, data.removalStatus === 'removed' ? 'success' : 'info');
    showToast('✓', 'Billing updated', 'success');
    await fetchBillingPaymentMethods();
    await handleRefresh();
  } catch (error) {
    setBillingSettingsStatus(error?.message || 'Failed to remove payment method.', 'error');
    showToast('❌', error?.message || 'Failed to remove payment method', 'error');
  } finally {
    setBillingSettingsActionBusy(false);
  }
}

async function handlePopupDeleteAccount(event) {
  event?.preventDefault();
  const jwt = getPopupJwt();
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  const confirmed = await showConfirmDialog(
    '🗑️',
    'Delete Account',
    DELETE_ACCOUNT_POPUP_WARNING,
    'Delete account',
    'Keep account'
  );
  if (!confirmed) return;

  const finalConfirmed = await showCheckboxConfirmDialog(
    '🗑️',
    'Are you sure?',
    'Final confirmation: account deletion will start now, your access will be removed, and this action cannot be undone.',
    'Yes, delete account',
    'Go back',
    'Are you sure? I understand this action cannot be undone.'
  );
  if (!finalConfirmed) return;

  try {
    setBillingSettingsActionBusy(true, 'Deleting account... Please keep this popup open until this finishes.');
    const response = await fetch(`${API_BASE_URL}/api/delete-account`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || 'Failed to delete account.');
    }
    showToast('✓', 'Account deletion started', 'success');
    localStorage.removeItem('youchords_jwt');
    await chrome.storage.local.remove(['youchords_jwt']);
    chrome.tabs.create({ url: 'https://www.youtube.com/?yc_status=deleted' });
    window.close();
  } catch (error) {
    setBillingSettingsStatus(error?.message || 'Failed to delete account.', 'error');
    showToast('❌', error?.message || 'Failed to delete account', 'error');
  } finally {
    setBillingSettingsActionBusy(false);
  }
}

function handleWatchApiTutorial(event) {
  event?.preventDefault();
  chrome.tabs.create({ url: API_KEY_TUTORIAL_URL });
}

async function cleanupRemovedGeminiGuideChatStorage() {
  const cleanupKey = 'geminiGuideChatRemovedCleanupDone';
  try {
    const result = await chrome.storage.local.get([cleanupKey]);
    if (result[cleanupKey]) return;

    const databaseDeleted = await new Promise((resolve) => {
      if (!globalThis.indexedDB?.deleteDatabase) {
        resolve(true);
        return;
      }
      const request = indexedDB.deleteDatabase('youchords_gemini_guide_chat');
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    });

    await chrome.storage.local.remove(['geminiGuideChatModel']);
    if (databaseDeleted) {
      await chrome.storage.local.set({ [cleanupKey]: true });
    }
  } catch (error) {
    console.warn('[Popup] Failed to clean removed Gemini guide chat storage:', error);
  }
}

// Handle renew subscription (resume cancelled subscription)
async function handleRenewSubscription() {
  const jwt = localStorage.getItem('youchords_jwt');
  if (!jwt) {
    showToast('❌', 'Please sign in first', 'error');
    return;
  }

  try {
    JSON.parse(atob(jwt.split('.')[1]));
  } catch (e) {
    showToast('❌', 'Invalid session', 'error');
    return;
  }

  try {
    const billingSnapshot = billingSettingsData || await fetchBillingPaymentMethodsSnapshot(jwt);
    if (billingSnapshot?.paymentMethodRemovalRequested) {
      const confirmed = await showConfirmDialog(
        '⚠️',
        'Renew with current payment method?',
        [
          'You previously requested to remove your payment method.',
          '',
          'Renewing will cancel that removal request and keep using the current payment method on file for future renewals.',
          '',
          'If you want to use a different card, choose Update Payment Method first.'
        ].join('\n'),
        'Renew with current method',
        'Cancel'
      );
      if (!confirmed) {
        showToast('ℹ️', 'Renew cancelled. Update payment method first if needed.', 'info');
        return;
      }
      closeConfirmDialogs();
    }
  } catch (error) {
    console.warn('[Popup] Could not verify payment method removal state before renew:', error);
  }

  setRenewSubscriptionBusy(true);
  if (elements.billingSettingsPanel?.style.display === 'block') {
    setBillingSettingsActionBusy(true, 'Renewing subscription... Please keep this popup open until this finishes.');
  }
  showToast('⏳', 'Renewing subscription... Keep this popup open until it finishes.', 'info');

  try {
    // 1. Resume subscription
    const response = await fetch(`${API_BASE_URL}/api/resume-subscription`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to renew subscription');
    }

    if (data.paymentMethodRemovalRequestCancelled) {
      billingSettingsData = {
        ...(billingSettingsData || {}),
        paymentMethodRemovalRequested: false,
        paymentMethodRemovalStatus: null
      };
    }

    closeConfirmDialogs();

    // 2. Refresh JWT to get updated cancelPending status
    const idResult = await chrome.storage.local.get(['youchords_device_id', 'youchords_device_fingerprint']);
    const refreshResponse = await fetch(`${API_BASE_URL}/refreshJWT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`
      },
      body: JSON.stringify({
        deviceId: idResult?.youchords_device_id || null,
        fingerprint: idResult?.youchords_device_fingerprint || null
      })
    });

    const refreshData = await refreshResponse.json();

    if (refreshData.success && refreshData.jwt) {
      // Update JWT in localStorage and chrome.storage
      localStorage.setItem('youchords_jwt', refreshData.jwt);
      chrome.storage.local.set({ 'youchords_jwt': refreshData.jwt });
    }

    showToast('✅', 'Subscription renewed!', 'success');

    // Reload popup to show updated status
    setTimeout(() => {
      window.location.reload();
    }, 1000);

  } catch (error) {
    console.error('Renew error:', error);
    setRenewSubscriptionBusy(false);
    setBillingSettingsActionBusy(false);
    showToast('❌', error.message || 'Failed to renew', 'error');
  }
}

// Handle Help button click
async function handleHelpOpen() {
  elements.helpPanel.style.display = 'block';
  const activeState = await getActiveDiagnosticsState();
  await syncTroubleshootingExpandedState(!!activeState);
  await syncDiagnosticsUiFromStorage(activeState);
}

// Handle Help close button click
function handleHelpClose() {
  elements.helpPanel.style.display = 'none';
  // Collapse all FAQ items
  document.querySelectorAll('.faq-item').forEach(item => {
    item.classList.remove('expanded');
  });
}

function setTroubleshootingExpanded(isExpanded) {
  const expanded = !!isExpanded;
  elements.troubleshootingCard?.classList.toggle('collapsed', !expanded);
  if (elements.troubleshootingBody) {
    elements.troubleshootingBody.hidden = !expanded;
  }
  if (elements.troubleshootingToggleBtn) {
    elements.troubleshootingToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

async function setTroubleshootingExpandedAndPersist(isExpanded) {
  setTroubleshootingExpanded(isExpanded);
  await chrome.storage.local.set({ [TROUBLESHOOTING_EXPANDED_STORAGE_KEY]: !!isExpanded });
}

async function syncTroubleshootingExpandedState(forceExpanded = false) {
  if (forceExpanded) {
    await setTroubleshootingExpandedAndPersist(true);
    return;
  }

  const result = await chrome.storage.local.get([TROUBLESHOOTING_EXPANDED_STORAGE_KEY]);
  setTroubleshootingExpanded(result?.[TROUBLESHOOTING_EXPANDED_STORAGE_KEY] === true);
}

async function handleTroubleshootingToggle() {
  const currentlyExpanded = elements.troubleshootingToggleBtn?.getAttribute('aria-expanded') === 'true';
  await setTroubleshootingExpandedAndPersist(!currentlyExpanded);
}

function setDiagnosticsStatus(message = '', tone = 'info') {
  if (!elements.diagnosticsStatus) return;
  elements.diagnosticsStatus.textContent = message || '';
  elements.diagnosticsStatus.className = 'diagnostics-status';
  if (message) {
    elements.diagnosticsStatus.classList.add(tone);
  }
}

function renderDiagnosticsResults(findings = []) {
  if (!elements.diagnosticsResults) return;

  if (!Array.isArray(findings) || findings.length === 0) {
    elements.diagnosticsResults.hidden = true;
    elements.diagnosticsResults.textContent = '';
    return;
  }

  elements.diagnosticsResults.hidden = false;
  elements.diagnosticsResults.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'diagnostics-result-title';
  title.textContent = 'Suggested fixes';

  const list = document.createElement('ul');
  list.className = 'diagnostics-result-list';
  findings.forEach((finding) => {
    const item = document.createElement('li');
    item.textContent = finding;
    list.appendChild(item);
  });

  elements.diagnosticsResults.append(title, list);
}

function getFindingsFromDiagnosticsReport(reportText = '') {
  if (!reportText) return [];
  try {
    const parsedReport = JSON.parse(reportText);
    if (!Array.isArray(parsedReport?.findings)) return [];
    return parsedReport.findings
      .filter((finding) => typeof finding === 'string' && finding.trim())
      .map((finding) => finding.trim());
  } catch (_) {
    return [];
  }
}

function resetDiagnosticsCopyButtonLabel() {
  if (diagnosticsCopyFeedbackTimer) {
    clearTimeout(diagnosticsCopyFeedbackTimer);
    diagnosticsCopyFeedbackTimer = null;
  }
  if (!elements.diagnosticsCopyBtn) return;
  elements.diagnosticsCopyBtn.textContent = elements.diagnosticsCopyBtn.dataset.defaultText || 'Copy report';
  elements.diagnosticsCopyBtn.classList.remove('copied');
}

function showDiagnosticsCopyFeedback() {
  if (!elements.diagnosticsCopyBtn) return;
  if (!elements.diagnosticsCopyBtn.dataset.defaultText) {
    elements.diagnosticsCopyBtn.dataset.defaultText = elements.diagnosticsCopyBtn.textContent || 'Copy report';
  }
  elements.diagnosticsCopyBtn.textContent = 'Copied!';
  elements.diagnosticsCopyBtn.classList.add('copied');

  if (diagnosticsCopyFeedbackTimer) {
    clearTimeout(diagnosticsCopyFeedbackTimer);
  }
  diagnosticsCopyFeedbackTimer = setTimeout(() => {
    resetDiagnosticsCopyButtonLabel();
  }, 1800);
}

function setDiagnosticsButtonMode(isActive) {
  if (elements.diagnosticsStartBtn) {
    elements.diagnosticsStartBtn.textContent = isActive ? '■ Abort diagnostics' : '▶ Start diagnostics';
    elements.diagnosticsStartBtn.classList.toggle('abort', !!isActive);
    elements.diagnosticsStartBtn.classList.toggle('primary', !isActive);
  }
  if (elements.diagnosticsAnalyzeBtn) {
    elements.diagnosticsAnalyzeBtn.textContent = 'Finished';
  }
}

async function getActiveDiagnosticsState() {
  const stored = await chrome.storage.local.get([DIAGNOSTICS_ACTIVE_STORAGE_KEY]);
  const state = stored?.[DIAGNOSTICS_ACTIVE_STORAGE_KEY];
  const expiresAt = Number(state?.expiresAt || 0);

  if (!state?.active || !expiresAt || Date.now() >= expiresAt) {
    if (state) {
      await chrome.storage.local.remove([DIAGNOSTICS_ACTIVE_STORAGE_KEY]);
    }
    return null;
  }

  return state;
}

async function syncDiagnosticsUiFromStorage(activeState = null) {
  if (!elements.diagnosticsStatus) return;

  if (!activeState) {
    activeState = await getActiveDiagnosticsState();
  }
  if (activeState) {
    setDiagnosticsButtonMode(true);
    setDiagnosticsStatus(
      'Diagnostics is running. Perform the action that is not working, then come back here and click Finished.',
      'info'
    );
    return;
  }

  setDiagnosticsButtonMode(false);

  const stored = await chrome.storage.local.get([DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]);
  const storedReport = stored?.[DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]?.report || '';
  if (storedReport) {
    lastDiagnosticsReportText = storedReport;
    const findings = getFindingsFromDiagnosticsReport(storedReport);
    renderDiagnosticsResults(findings);
    if (elements.diagnosticsCopyBtn) elements.diagnosticsCopyBtn.disabled = false;
    await setTroubleshootingExpandedAndPersist(true);
    setDiagnosticsStatus('A previous diagnostic report is ready. You can copy it or start a new diagnosis.', 'success');
  } else {
    renderDiagnosticsResults([]);
    if (elements.diagnosticsCopyBtn) elements.diagnosticsCopyBtn.disabled = true;
  }
}

function getSafePopupPlanInfo() {
  const subInfo = getSubscriptionInfo();
  return {
    signedIn: !!getPopupJwt(),
    plan: subInfo?.plan || 'unknown',
    blocked: !!subInfo?.blocked,
    cancelPending: !!subInfo?.cancelPending
  };
}

function safeDecodeJwtPayload(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized));
  } catch (_) {
    return null;
  }
}

function getJwtExpiryInfo(payload) {
  const expRaw = Number(payload?.exp || 0);
  if (!Number.isFinite(expRaw) || expRaw <= 0) {
    return {
      hasExpiry: false,
      expired: true,
      expiresInMinutes: null
    };
  }

  const expMs = expRaw > 1e12 ? expRaw : expRaw * 1000;
  const expiresInMinutes = Math.round((expMs - Date.now()) / 60000);
  return {
    hasExpiry: true,
    expired: expMs <= Date.now(),
    expiresInMinutes
  };
}

function buildSafeAuthDiagnosticInfo(storageData = {}) {
  const localJwt = getPopupJwt();
  const storageJwt = storageData?.youchords_jwt || null;
  const selectedJwt = localJwt || storageJwt || null;
  const payload = safeDecodeJwtPayload(selectedJwt);
  const expiry = getJwtExpiryInfo(payload);
  const subscriptionDirty = storageData?.[SUBSCRIPTION_STATE_DIRTY_KEY];
  const upgradePending = storageData?.[UPGRADE_PENDING_KEY];

  return {
    hasLocalJwt: !!localJwt,
    hasStorageJwt: !!storageJwt,
    hasAnyJwt: !!selectedJwt,
    localStorageMismatch: !!(localJwt && storageJwt && localJwt !== storageJwt),
    localMissingStorageExists: !localJwt && !!storageJwt,
    jwtReadable: !!payload,
    jwtExpired: !!selectedJwt && expiry.expired,
    jwtExpiresInMinutes: expiry.expiresInMinutes,
    jwtPlan: payload?.plan || null,
    jwtBlocked: !!payload?.blocked,
    jwtCancelPending: !!payload?.cancelPending,
    jwtDeletionPending: !!payload?.deletionPending,
    jwtHasUserId: !!(payload?.odI || payload?.uid || payload?.sub),
    subscriptionStateDirty: !!subscriptionDirty?.active,
    upgradePending: !!upgradePending?.active
  };
}

function getSafeUrlInfo(rawUrl) {
  try {
    const url = new URL(rawUrl || '');
    return {
      host: url.hostname,
      path: url.pathname,
      videoId: url.searchParams.get('v') || null
    };
  } catch (_) {
    return { host: 'unknown', path: 'unknown', videoId: null };
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve({ success: false, error: 'No active tab' });
      return;
    }

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message || 'Could not reach YouTube tab'
        });
        return;
      }
      resolve(response || { success: false, error: 'No response from YouTube tab' });
    });
  });
}

async function collectPopupDiagnosticSnapshot() {
  const [tab, apiSettings] = await Promise.all([
    getActiveTab(),
    chrome.storage.local.get([
      'geminiApiKey',
      'geminiApiKeys',
      'geminiApiKeyStatus',
      'youchords_jwt',
      SUBSCRIPTION_STATE_DIRTY_KEY,
      UPGRADE_PENDING_KEY
    ])
  ]);

  const activeKeys = Array.isArray(apiSettings.geminiApiKeys)
    ? apiSettings.geminiApiKeys.filter((keyData) => keyData && keyData.active !== false && keyData.status !== 'disabled').length
    : 0;

  return {
    at: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || 'unknown',
    popup: {
      ...getSafePopupPlanInfo(),
      auth: buildSafeAuthDiagnosticInfo(apiSettings),
      hasGeminiApiKey: !!apiSettings.geminiApiKey || activeKeys > 0,
      geminiApiKeyStatus: apiSettings.geminiApiKeyStatus || (apiSettings.geminiApiKey ? 'saved' : 'not_set'),
      activeGeminiKeys: activeKeys
    },
    activeTab: tab ? {
      id: tab.id,
      url: getSafeUrlInfo(tab.url),
      isYoutube: /^https?:\/\/([^/]+\.)?youtube\.com\//i.test(tab.url || '')
    } : null
  };
}

function buildDiagnosticsFindings(snapshot) {
  const findings = [];
  const popup = snapshot?.popup || {};
  const auth = popup?.auth || {};
  const tab = snapshot?.activeTab || null;
  const content = snapshot?.content || null;

  if (!auth.hasAnyJwt) {
    findings.push('You are not signed in. Sign in with Google first, then try the action again.');
  } else if (auth.localMissingStorageExists) {
    findings.push('Your session exists but the popup did not load it yet. Close and reopen the popup, or click the refresh button, then try again.');
  } else if (auth.localStorageMismatch) {
    findings.push('Your popup session is out of sync with the extension session. Click the refresh button in the popup, or sign out and sign in again if it does not update.');
  } else if (!auth.jwtReadable) {
    findings.push('Your saved session could not be read correctly. Sign out, sign in again with Google, then try the action again.');
  } else if (auth.jwtExpired) {
    findings.push('Your session looks expired. Click the refresh button in the popup. If it still fails, sign out and sign in again.');
  } else if (!auth.jwtHasUserId) {
    findings.push('Your session is missing account identity data. Sign out and sign in again to refresh the account session.');
  }

  if (auth.subscriptionStateDirty) {
    findings.push('Your billing or subscription state recently changed. Click the refresh button in the popup before trying again.');
  }

  if (auth.upgradePending && popup.plan === 'free') {
    findings.push('An upgrade flow was recently started but the popup still shows Free. Click refresh, then reopen the popup if needed.');
  }

  if (popup.blocked) {
    findings.push('Your account looks restricted. Open a support ticket from your profile or contact billing support.');
  }

  if (popup.cancelPending) {
    findings.push('Your subscription renewal is cancelled, but your current access should continue until the billing period ends.');
  }

  if (!popup.hasGeminiApiKey) {
    findings.push('If the problem is AI transcription, add a valid Gemini API key in the popup and save it.');
  }

  if (!tab?.isYoutube) {
    findings.push('Open a YouTube video page, start the song, then run diagnostics again.');
  } else if (!tab.url.videoId) {
    findings.push('The current YouTube page is not a video page. Open a song video and try again.');
  }

  if (tab?.isYoutube && !content?.success) {
    findings.push('The YouTube page did not answer the diagnostic request. Refresh the YouTube tab and wait until the player appears.');
  }

  if (content?.success) {
    const page = content.snapshot || {};
    if (!page.video?.exists) {
      findings.push('YouTube video player was not found. Refresh the page, wait for the player, then try YouChords again.');
    } else if ((page.video.readyState || 0) < 2) {
      findings.push('The YouTube video is still loading. Wait until the video starts playing, then click the YouChords button again.');
    }

    if (page.player?.exists && !page.player?.hasControls) {
      findings.push('YouTube player controls were not ready. Move the mouse over the video, wait a moment, then try again.');
    }

    if (page.buttons?.missing?.length >= 4 || page.buttons?.present?.settings === false) {
      findings.push('Most YouChords buttons are not visible yet. Wait a few seconds or refresh the YouTube page.');
    }

    if (page.progress?.active) {
      findings.push('A YouChords process still appears to be running. Wait for it to finish before starting another action.');
    }

    if (page.features?.carouselActive || page.features?.panelActive || page.features?.subtitlesVisible) {
      findings.push('A YouChords feature is currently open. If it looks stuck, close it, refresh YouTube, and try again.');
    }

    if (Array.isArray(page.recentErrors) && page.recentErrors.length > 0) {
      const lastError = page.recentErrors[page.recentErrors.length - 1];
      findings.push(`Recent YouChords issue detected: ${lastError.message || 'Unknown error'}. Try refreshing the page and repeating the action.`);

      const authRelatedError = page.recentErrors.find((event) => {
        const text = `${event?.type || ''} ${event?.message || ''}`.toLowerCase();
        return /\b(auth|jwt|token|session|sign.?in|401|403|unauthorized|forbidden)\b/.test(text);
      });
      if (authRelatedError) {
        findings.push('The recent issue looks related to sign-in or account session. Click the popup refresh button, then try again. If it repeats, sign out and sign in again.');
      }
    }

    if (page.auth?.authLoaded === false && auth.hasAnyJwt && !auth.jwtExpired) {
      findings.push('The YouTube tab has not loaded the account module yet. Click the YouChords button again, or refresh the YouTube tab if nothing happens.');
    }

    if (page.auth?.hasCachedJwt === false && auth.hasAnyJwt && !auth.jwtExpired) {
      findings.push('The popup has a session, but this YouTube tab does not see it yet. Refresh the YouTube tab and try again.');
    }
  }

  if (findings.length === 0) {
    findings.push('No obvious issue was detected. Try refreshing YouTube and repeating the action. If it still happens, open a support ticket and attach the diagnostic report.');
  }

  findings.push('If you cannot solve it yourself, please open a ticket from your account profile. A ticket is the best option. If you email support@you-chords.com, include the account email you used to sign up so we can identify your user.');
  return findings;
}

function buildDiagnosticsReport(snapshot, findings) {
  const report = {
    generatedAt: new Date().toISOString(),
    note: 'No JWT, API keys, payment details, or full private data are included.',
    findings,
    snapshot
  };
  return JSON.stringify(report, null, 2);
}

async function clearActiveDiagnosticsInCurrentTab(tab = null) {
  const activeTab = tab || await getActiveTab();
  if (activeTab?.id && /^https?:\/\/([^/]+\.)?youtube\.com\//i.test(activeTab.url || '')) {
    await sendMessageToTab(activeTab.id, { action: 'YC_DIAGNOSTICS_CLEAR' });
  }
}

async function abortDiagnostics(message = 'Diagnostics aborted. No report was created.') {
  lastDiagnosticsReportText = '';
  await chrome.storage.local.remove([
    DIAGNOSTICS_ACTIVE_STORAGE_KEY,
    DIAGNOSTICS_LAST_REPORT_STORAGE_KEY
  ]);
  await clearActiveDiagnosticsInCurrentTab();

  if (elements.diagnosticsCopyBtn) elements.diagnosticsCopyBtn.disabled = true;
  resetDiagnosticsCopyButtonLabel();
  renderDiagnosticsResults([]);
  setDiagnosticsButtonMode(false);
  setDiagnosticsStatus(message, 'warning');
}

async function handleDiagnosticsStart() {
  const activeState = await getActiveDiagnosticsState();
  if (activeState) {
    await abortDiagnostics('Diagnostics aborted. Start again whenever you need it.');
    return;
  }

  const startedAt = Date.now();
  const expiresAt = startedAt + DIAGNOSTICS_DURATION_MS;
  await chrome.storage.local.remove([DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]);
  await chrome.storage.local.set({
    [DIAGNOSTICS_ACTIVE_STORAGE_KEY]: {
      active: true,
      startedAt,
      expiresAt
    }
  });

  const tab = await getActiveTab();
  if (tab?.id && /^https?:\/\/([^/]+\.)?youtube\.com\//i.test(tab.url || '')) {
    await sendMessageToTab(tab.id, {
      action: 'YC_DIAGNOSTICS_START',
      startedAt,
      expiresAt
    });
  }

  lastDiagnosticsReportText = '';
  if (elements.diagnosticsCopyBtn) elements.diagnosticsCopyBtn.disabled = true;
  resetDiagnosticsCopyButtonLabel();
  renderDiagnosticsResults([]);
  await setTroubleshootingExpandedAndPersist(true);
  setDiagnosticsButtonMode(true);
  setDiagnosticsStatus(
    'Diagnostics started. Perform the action that is not working, then come back here and click Finished.',
    'info'
  );
  await showConfirmDialog(
    '🔎',
    'Diagnostics started',
    'Now go back to YouTube and perform the action that is not working.\n\nWhen you are done, open this Help panel again and click Finished.',
    'Got it',
    'Close'
  );
}

async function handleDiagnosticsAnalyze() {
  setDiagnosticsStatus('Finishing diagnostics and checking the current YouTube tab...', 'info');

  const snapshot = await collectPopupDiagnosticSnapshot();
  if (snapshot.activeTab?.isYoutube && snapshot.activeTab?.id) {
    snapshot.content = await sendMessageToTab(snapshot.activeTab.id, {
      action: 'YC_DIAGNOSTICS_SNAPSHOT'
    });
  } else {
    snapshot.content = { success: false, error: 'Active tab is not YouTube' };
  }

  const findings = buildDiagnosticsFindings(snapshot);
  lastDiagnosticsReportText = buildDiagnosticsReport(snapshot, findings);
  await chrome.storage.local.set({
    [DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]: {
      createdAt: Date.now(),
      report: lastDiagnosticsReportText
    }
  });
  await chrome.storage.local.remove([DIAGNOSTICS_ACTIVE_STORAGE_KEY]);
  if (snapshot.activeTab?.isYoutube && snapshot.activeTab?.id) {
    await clearActiveDiagnosticsInCurrentTab({ id: snapshot.activeTab.id, url: `https://www.youtube.com${snapshot.activeTab.url?.path || '/'}` });
  }

  renderDiagnosticsResults(findings);
  if (elements.diagnosticsCopyBtn) elements.diagnosticsCopyBtn.disabled = false;
  resetDiagnosticsCopyButtonLabel();
  setDiagnosticsButtonMode(false);
  setDiagnosticsStatus('Diagnosis ready. Try the suggested fixes first. If needed, copy the report and attach it to support.', 'success');
}

async function handleDiagnosticsCopy() {
  if (!lastDiagnosticsReportText) {
    const stored = await chrome.storage.local.get([DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]);
    lastDiagnosticsReportText = stored?.[DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]?.report || '';
  }

  if (!lastDiagnosticsReportText) {
    setDiagnosticsStatus('Click Finished first, then copy the report.', 'warning');
    return;
  }

  await copyAiGuidePromptToClipboard(lastDiagnosticsReportText);
  showDiagnosticsCopyFeedback();
  setDiagnosticsStatus('Diagnostic report copied. If you still need help, open a support ticket from your profile. If you email support@you-chords.com, include the account email you used to sign up.', 'success');
}

async function handleDiagnosticsClear() {
  lastDiagnosticsReportText = '';
  await chrome.storage.local.remove([DIAGNOSTICS_ACTIVE_STORAGE_KEY, DIAGNOSTICS_LAST_REPORT_STORAGE_KEY]);
  await clearActiveDiagnosticsInCurrentTab();

  if (elements.diagnosticsCopyBtn) elements.diagnosticsCopyBtn.disabled = true;
  resetDiagnosticsCopyButtonLabel();
  renderDiagnosticsResults([]);
  setDiagnosticsButtonMode(false);
  setDiagnosticsStatus('Diagnostics cleared.', 'info');
}

// Handle Plan Info button click - toggle tooltip
function handlePlanInfoToggle(e) {
  e.stopPropagation();
  const isVisible = elements.planInfoTooltip.style.display === 'block';

  if (isVisible) {
    elements.planInfoTooltip.style.display = 'none';
  } else {
    // Populate and show tooltip
    const subInfo = getSubscriptionInfo();
    const plan = subInfo?.plan || 'free';
    const planConfig = PLANS[plan] || PLANS.free;
    const features = PLAN_FEATURES[plan] || PLAN_FEATURES.free;

    // Update title
    elements.tooltipPlanTitle.textContent = `Your Plan: ${planConfig.name}`;

    // Build features list
    let html = '';
    features.forEach(feature => {
      const iconClass = feature.included ? 'included' : 'not-included';
      const icon = feature.included ? '✓' : '✗';
      const emphasisClass = feature.emphasis ? 'feature-emphasis' : '';
      html += `<li class="${iconClass} ${emphasisClass}"><span class="feature-icon">${icon}</span>${feature.text}</li>`;
    });

    // Add "Everything unlocked!" for paid plans
    if (plan !== 'free') {
      html += `<li class="all-unlocked">🎉 Everything unlocked!</li>`;
    }

    elements.tooltipFeaturesList.innerHTML = html;

    // Position tooltip relative to button
    const btnRect = elements.planInfoBtn.getBoundingClientRect();
    const tooltipWidth = 180; // matches tooltip width from CSS

    // Position below button, centered
    const left = btnRect.left + (btnRect.width / 2) - (tooltipWidth / 2);
    const top = btnRect.bottom + 8;

    elements.planInfoTooltip.style.left = `${left}px`;
    elements.planInfoTooltip.style.top = `${top}px`;
    elements.planInfoTooltip.style.display = 'block';
  }
}

// Close tooltip when clicking outside
function handleDocumentClick(e) {
  if (elements.planInfoTooltip &&
    elements.planInfoTooltip.style.display === 'block' &&
    !e.target.closest('#planInfoBtn') &&
    !e.target.closest('#planInfoTooltip')) {
    elements.planInfoTooltip.style.display = 'none';
  }
}

// Handle FAQ item click (toggle expand/collapse)
function handleFaqClick(e) {
  const faqItem = e.target.closest('.faq-item');
  if (faqItem) {
    // Close other items
    document.querySelectorAll('.faq-item').forEach(item => {
      if (item !== faqItem) item.classList.remove('expanded');
    });
    // Toggle current item
    faqItem.classList.toggle('expanded');
  }
}

// Handle FAQ Upgrade link click
async function handleFaqUpgradeClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const jwt = await getPopupJwtFromAnyStorage();
  if (jwt) {
    await markUpgradePending('popup_faq_upgrade');
    chrome.tabs.create({ url: buildWebsiteSessionUrl('/upgrade', jwt) });
  } else {
    // User not logged in - go to pricing page
    chrome.tabs.create({ url: 'https://www.you-chords.com/pricing' });
  }
}

// Handle Google Sign In
async function handleSignIn() {
  const consent = getPopupConsentPayloadIfChecked('popup_signin');
  setSignInBusy(true);

  try {
    const result = await signInWithGoogle(consent);

    if (result.success) {
      await syncPopupConsentUI();
      updateUserUI(result.user);
      showToast('✅', `Welcome, ${result.user.displayName || 'User'}!`, 'success');

      // Notify all YouTube tabs to refresh auth
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, function (tabs) {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            command: 'authUpdated',
            jwt: localStorage.getItem('youchords_jwt')
          }).catch(() => { });
        });
      });
    } else {
      if (result.error === 'CONSENT_REQUIRED') {
        markPopupConsentRequired();
      } else {
        showToast('❌', getPopupSignInFailureMessage(result.error), 'error');
      }
    }
  } catch (error) {
    console.error('[Popup] Sign in failed:', error);
    showToast('❌', getPopupSignInFailureMessage(error?.message || error), 'error');
  } finally {
    setSignInBusy(false);
    updatePopupConsentGate();
  }
}

// Handle Sign Out
async function handleSignOut() {
  const result = await signOutUser();

  if (result.success) {
    // Clear only cached user identity in sync storage.
    // Keep unrelated sync preferences intact.
    await chrome.storage.sync.remove('user');
    await chrome.storage.local.remove([SUBSCRIPTION_STATE_DIRTY_KEY]);
    console.log('[Popup] 🔒 Cleared chrome.storage.sync user cache');

    await syncPopupConsentUI();
    billingSettingsData = null;
    handleBillingSettingsClose();
    updateUserUI(null);
    setAuthBootstrapPending(false);
    showToast('👋', 'Signed out successfully', 'info');
  } else {
    showToast('❌', 'Sign out failed', 'error');
  }
}

// ============================================
// API Key Management
// ============================================

// Default Gemini prompt
const DEFAULT_PROMPT = {
  id: 'default',
  title: 'Sentence Timing',
  prompt: '', // 🔒 Hidden from user - actual prompt is hardcoded
  isDefault: true,
  canDelete: false
};

// 🆕 Translation "prompt" (pseudo-prompt for UI)
const TRANSLATION_PROMPT = {
  id: 'translation',
  title: 'Translation',
  prompt: '', // 🔒 Hidden from user - actual prompt is generated dynamically
  isTranslation: true,
  canDelete: false
};

// Built-in custom prompt (ready-made)
const ABOUT_SONG_PROMPT = {
  id: 'about-song',
  title: 'What is this video about?',
  prompt: 'Tell me what this video is about and answer in: ____',
  isBuiltInCustom: true,
  useTranscriptBased: true,
  useVideoAnalysis: false,
  useGoogleSearch: false,
  useUrlContext: false,
  thinkingLevel: 'MINIMAL',
  canDelete: false
};

// 🔒 Maximum number of custom prompts allowed
const MAX_CUSTOM_PROMPTS = 20;
const PROMPT_DISCLAIMER_KEY = 'promptDisclaimerAccepted';
const HIGHLIGHT_PROMPT_DISCLAIMER_KEY = 'highlightPromptDisclaimer';
const ABOUT_SONG_LANGUAGE_KEY = 'aboutSongLanguage';
const PROMPT_COLLAPSED_STATE_KEY = 'promptCollapsedState';
const GEMINI_GLOBAL_MODEL_KEY = 'geminiGlobalModel';
const GEMINI_ALLOW_PAID_MODELS_KEY = 'geminiAllowPaidModels';
const GEMINI_API_SECTION_COLLAPSED_KEY = 'geminiApiSectionCollapsed';
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const MODEL_MODE_GLOBAL = 'global';

// Strongest -> weakest (as requested)
const GEMINI_MODEL_OPTIONS = [
  {
    id: 'gemini-3.1-pro-preview',
    uiLabel: 'Gemini 3.1 Pro Preview',
    billingLabel: 'NOT FREE',
    paid: true
  },
  {
    id: 'gemini-3.1-pro-preview-customtools',
    uiLabel: 'Gemini 3.1 Pro Preview (Custom Tools)',
    billingLabel: 'NOT FREE',
    paid: true
  },
  {
    id: 'gemini-3-flash-preview',
    uiLabel: 'Gemini 3 Flash Preview',
    billingLabel: 'FREE',
    paid: false
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    uiLabel: 'Gemini 3.1 Flash Lite Preview',
    billingLabel: 'FREE',
    paid: false
  }
];

const GEMINI_MODEL_BY_ID = new Map(GEMINI_MODEL_OPTIONS.map((model) => [model.id, model]));

function getGeminiModelMeta(modelId) {
  return GEMINI_MODEL_BY_ID.get(modelId) || GEMINI_MODEL_BY_ID.get(DEFAULT_GEMINI_MODEL);
}

function isPaidGeminiModel(modelId) {
  return getGeminiModelMeta(modelId)?.paid === true;
}

function normalizeGlobalGeminiModel(modelId, allowPaidModels = false) {
  if (!GEMINI_MODEL_BY_ID.has(modelId)) return DEFAULT_GEMINI_MODEL;
  if (!allowPaidModels && isPaidGeminiModel(modelId)) return DEFAULT_GEMINI_MODEL;
  return modelId;
}

function normalizePromptModelOverride(modelOverride, allowPaidModels = false) {
  if (!modelOverride || modelOverride === MODEL_MODE_GLOBAL) return MODEL_MODE_GLOBAL;
  if (!GEMINI_MODEL_BY_ID.has(modelOverride)) return MODEL_MODE_GLOBAL;
  if (!allowPaidModels && isPaidGeminiModel(modelOverride)) return MODEL_MODE_GLOBAL;
  return modelOverride;
}

function getEffectivePromptModel(prompt, globalModel, allowPaidModels = false) {
  const override = normalizePromptModelOverride(prompt?.modelOverride, allowPaidModels);
  if (override === MODEL_MODE_GLOBAL) return normalizeGlobalGeminiModel(globalModel, allowPaidModels);
  return override;
}

function formatModelLabel(modelId) {
  const meta = getGeminiModelMeta(modelId);
  return `${meta.uiLabel} (${meta.billingLabel})`;
}

async function loadAllowPaidGeminiModels() {
  const result = await chrome.storage.local.get([GEMINI_ALLOW_PAID_MODELS_KEY]);
  return result[GEMINI_ALLOW_PAID_MODELS_KEY] === true;
}

async function saveAllowPaidGeminiModels(allowPaidModels) {
  await chrome.storage.local.set({ [GEMINI_ALLOW_PAID_MODELS_KEY]: allowPaidModels === true });
}

async function loadGlobalGeminiModel(allowPaidModels = false) {
  const result = await chrome.storage.local.get([GEMINI_GLOBAL_MODEL_KEY]);
  const normalized = normalizeGlobalGeminiModel(result[GEMINI_GLOBAL_MODEL_KEY], allowPaidModels);
  if (result[GEMINI_GLOBAL_MODEL_KEY] && result[GEMINI_GLOBAL_MODEL_KEY] !== normalized) {
    await chrome.storage.local.set({ [GEMINI_GLOBAL_MODEL_KEY]: normalized });
  }
  return normalized;
}

async function saveGlobalGeminiModel(modelId, allowPaidModels = false) {
  const normalized = normalizeGlobalGeminiModel(modelId, allowPaidModels);
  await chrome.storage.local.set({ [GEMINI_GLOBAL_MODEL_KEY]: normalized });
  return normalized;
}

function populateModelSelectOptions(selectElement, globalModel, selectedValue = MODEL_MODE_GLOBAL, includeGlobalOption = true, allowPaidModels = false) {
  if (!selectElement) return;
  const resolvedGlobal = normalizeGlobalGeminiModel(globalModel, allowPaidModels);
  const normalizedSelected = selectedValue === MODEL_MODE_GLOBAL
    ? MODEL_MODE_GLOBAL
    : normalizeGlobalGeminiModel(selectedValue, allowPaidModels);

  selectElement.innerHTML = '';

  if (includeGlobalOption) {
    const globalOption = document.createElement('option');
    globalOption.value = MODEL_MODE_GLOBAL;
    globalOption.textContent = `Use Global (${formatModelLabel(resolvedGlobal)})`;
    selectElement.appendChild(globalOption);
  }

  GEMINI_MODEL_OPTIONS.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    const isLockedPaidModel = model.paid === true && !allowPaidModels;
    option.textContent = isLockedPaidModel
      ? `${model.uiLabel} (${model.billingLabel} - enable paid models)`
      : `${model.uiLabel} (${model.billingLabel})`;
    option.disabled = isLockedPaidModel;
    option.classList.toggle('locked-paid-model-option', isLockedPaidModel);
    option.title = isLockedPaidModel
      ? 'Enable "Allow paid Gemini models" to select this model'
      : `${model.uiLabel} (${model.billingLabel})`;
    selectElement.appendChild(option);
  });

  if (!includeGlobalOption && normalizedSelected === MODEL_MODE_GLOBAL) {
    selectElement.value = resolvedGlobal;
  } else {
    selectElement.value = normalizedSelected;
  }
}

// 🔒 Actual default prompt (hidden from users)
const ACTUAL_DEFAULT_PROMPT = 'תמלל את הסרטון הזה עם זמנים מדויקים. החזר JSON array בפורמט: [{"start": 0.0, "end": 3.5, "text": "..."}]';

// ============================================
// Custom Prompts Management
// ============================================

function normalizePromptSelectionState(prompts, showDefault, selectedCustomPromptId, showTranslation) {
  let normalizedShowDefault = showDefault === true;
  let normalizedShowTranslation = showTranslation === true;
  let normalizedSelectedCustomPromptId = selectedCustomPromptId || null;
  let changed = false;

  // If selected custom prompt no longer exists, clear it.
  if (
    normalizedSelectedCustomPromptId &&
    !prompts.some((prompt) => prompt.id === normalizedSelectedCustomPromptId)
  ) {
    normalizedSelectedCustomPromptId = null;
    changed = true;
  }

  // Hard invariant: at least one prompt source must be selected.
  if (!normalizedShowDefault && !normalizedShowTranslation && !normalizedSelectedCustomPromptId) {
    normalizedShowDefault = true;
    changed = true;
  }

  return {
    showDefault: normalizedShowDefault,
    showTranslation: normalizedShowTranslation,
    selectedCustomPromptId: normalizedSelectedCustomPromptId,
    changed
  };
}

// Load prompts from storage
async function loadPrompts() {
  try {
    const result = await chrome.storage.local.get([
      'geminiPrompts',
      'showDefault',
      'showTranslation',
      'selectedCustomPromptId',
      'selectedPromptId',
      PROMPT_DISCLAIMER_KEY,
      GEMINI_ALLOW_PAID_MODELS_KEY
    ]);

    let prompts = result.geminiPrompts || [];
    const allowPaidModels = result[GEMINI_ALLOW_PAID_MODELS_KEY] === true;
    let promptsChanged = false;

    // Ensure default prompt exists
    const hasDefault = prompts.some(p => p.id === 'default');
    if (!hasDefault) {
      prompts.unshift(DEFAULT_PROMPT);
      await chrome.storage.local.set({ geminiPrompts: prompts });
      console.log('[Prompts] Added default prompt to storage');
    }

    // 🆕 Ensure translation prompt exists (after default)
    const hasTranslation = prompts.some(p => p.id === 'translation');
    if (!hasTranslation) {
      const defaultIndex = prompts.findIndex(p => p.id === 'default');
      prompts.splice(defaultIndex + 1, 0, TRANSLATION_PROMPT);
      await chrome.storage.local.set({ geminiPrompts: prompts });
      console.log('[Prompts] Added translation prompt to storage');
    }

    // Ensure built-in "about-song" prompt exists (after translation)
    const hasAboutSong = prompts.some((p) => p.id === ABOUT_SONG_PROMPT.id);
    if (!hasAboutSong) {
      const translationIndex = prompts.findIndex((p) => p.id === 'translation');
      const insertAt = translationIndex >= 0 ? translationIndex + 1 : 2;
      prompts.splice(insertAt, 0, ABOUT_SONG_PROMPT);
      await chrome.storage.local.set({ geminiPrompts: prompts });
      console.log('[Prompts] Added built-in about-song prompt to storage');
    }

    // Enforce immutable fields for built-in prompts
    prompts = prompts.map((prompt) => {
      let normalizedPrompt = prompt;
      if (prompt.id === 'default') normalizedPrompt = { ...prompt, ...DEFAULT_PROMPT, canDelete: false, isDefault: true };
      if (prompt.id === 'translation') normalizedPrompt = { ...prompt, ...TRANSLATION_PROMPT, canDelete: false, isTranslation: true };
      if (prompt.id === ABOUT_SONG_PROMPT.id) normalizedPrompt = { ...prompt, ...ABOUT_SONG_PROMPT, canDelete: false, isBuiltInCustom: true };

      const originalOverride = normalizedPrompt.modelOverride;
      const normalizedOverride = normalizePromptModelOverride(originalOverride, allowPaidModels);
      if (normalizedOverride === MODEL_MODE_GLOBAL) {
        if (originalOverride) {
          normalizedPrompt = { ...normalizedPrompt };
          delete normalizedPrompt.modelOverride;
          promptsChanged = true;
        }
      } else {
        if (originalOverride !== normalizedOverride) promptsChanged = true;
        normalizedPrompt.modelOverride = normalizedOverride;
      }
      return normalizedPrompt;
    });

    if (promptsChanged) {
      await chrome.storage.local.set({ geminiPrompts: prompts });
      console.log('[Prompts] 🔒 Removed paid Gemini model selections because paid models are disabled');
    }

    // 🎯 Migration: Convert old format to new format
    let showDefault = result.showDefault;
    let selectedCustomPromptId = result.selectedCustomPromptId;

    if (showDefault === undefined && result.selectedPromptId) {
      // Old format detected - migrate
      if (result.selectedPromptId === 'default') {
        showDefault = true;
        selectedCustomPromptId = null;
      } else {
        showDefault = false;
        selectedCustomPromptId = result.selectedPromptId;
      }
      // Save migrated data
      await chrome.storage.local.set({ showDefault, selectedCustomPromptId });
      console.log('[Prompts] 🔄 Migrated old format to new format');
    }

    // Default values if nothing is set
    if (showDefault === undefined) showDefault = true;
    if (selectedCustomPromptId === undefined) selectedCustomPromptId = null;
    const rawShowTranslation = result.showTranslation === true;

    const normalizedSelection = normalizePromptSelectionState(
      prompts,
      showDefault,
      selectedCustomPromptId,
      rawShowTranslation
    );

    showDefault = normalizedSelection.showDefault;
    selectedCustomPromptId = normalizedSelection.selectedCustomPromptId;

    if (normalizedSelection.changed) {
      await chrome.storage.local.set({
        showDefault,
        showTranslation: normalizedSelection.showTranslation,
        selectedCustomPromptId
      });
      console.log('[Prompts] 🔧 Normalized selection state after load');
    }

    const promptDisclaimerAccepted = result[PROMPT_DISCLAIMER_KEY] === true;

    console.log('[Prompts] 🔍 Loaded from storage:', {
      count: prompts.length,
      showDefault,
      selectedCustomPromptId,
      promptDisclaimerAccepted,
      prompts: prompts.map(p => ({ id: p.id, title: p.title }))
    });

    return { prompts, showDefault, selectedCustomPromptId, promptDisclaimerAccepted };
  } catch (error) {
    console.error('[Prompts] Error loading prompts:', error);
    return {
      prompts: [DEFAULT_PROMPT, TRANSLATION_PROMPT, ABOUT_SONG_PROMPT],
      showDefault: true,
      selectedCustomPromptId: null,
      promptDisclaimerAccepted: false
    };
  }
}

// Save prompts to storage
async function savePrompts(prompts, showDefault, selectedCustomPromptId) {
  try {
    await chrome.storage.local.set({
      geminiPrompts: prompts,
      showDefault,
      selectedCustomPromptId
    });
    console.log('[Prompts] ✅ Saved prompts:', {
      count: prompts.length,
      showDefault,
      selectedCustomPromptId,
      prompts: prompts.map(p => ({ id: p.id, title: p.title }))
    });
  } catch (error) {
    console.error('[Prompts] Error saving prompts:', error);
  }
}

async function sanitizePaidGeminiModelSelections() {
  await loadGlobalGeminiModel(false);
  const result = await chrome.storage.local.get(['geminiPrompts']);
  const prompts = Array.isArray(result.geminiPrompts) ? result.geminiPrompts : [];
  let changed = false;
  const sanitizedPrompts = prompts.map((prompt) => {
    if (!isPaidGeminiModel(prompt?.modelOverride)) return prompt;
    changed = true;
    const nextPrompt = { ...prompt };
    delete nextPrompt.modelOverride;
    return nextPrompt;
  });

  if (changed) {
    await chrome.storage.local.set({ geminiPrompts: sanitizedPrompts });
  }
}

async function confirmEnablePaidGeminiModels() {
  return showConfirmDialog(
    '⚠️',
    'Paid Gemini models',
    'Some Gemini models may use billable Google API quota through your own API key.\n\nEnable this only if you understand that Google may charge your account for usage.',
    'Yes, enable',
    'No'
  );
}

async function renderPaidGeminiModelsControl() {
  const paidModelsCheckbox = document.getElementById('allowPaidGeminiModelsCheckbox');
  if (!paidModelsCheckbox) return false;

  const allowPaidModels = await loadAllowPaidGeminiModels();
  paidModelsCheckbox.checked = allowPaidModels;

  if (!paidModelsCheckbox.dataset.bound) {
    paidModelsCheckbox.dataset.bound = '1';
    paidModelsCheckbox.addEventListener('click', (e) => e.stopPropagation());
    paidModelsCheckbox.addEventListener('change', async (e) => {
      e.stopPropagation();

      if (paidModelsCheckbox.checked) {
        paidModelsCheckbox.checked = false;
        const confirmed = await confirmEnablePaidGeminiModels();
        if (!confirmed) {
          await saveAllowPaidGeminiModels(false);
          await sanitizePaidGeminiModelSelections();
          showToast('ℹ️', 'Paid Gemini models remain disabled.', 'info');
          await renderPrompts();
          return;
        }

        await saveAllowPaidGeminiModels(true);
        paidModelsCheckbox.checked = true;
        showToast('⚠️', 'Paid Gemini models enabled.', 'info');
        await renderPrompts();
        return;
      }

      await saveAllowPaidGeminiModels(false);
      await sanitizePaidGeminiModelSelections();
      showToast('✅', 'Paid Gemini models disabled.', 'success');
      await renderPrompts();
    });
  }

  return allowPaidModels;
}

async function ensurePaidGeminiModelAllowed(modelId) {
  if (!isPaidGeminiModel(modelId)) return true;
  if (await loadAllowPaidGeminiModels()) return true;
  showToast('⚠️', 'Enable paid Gemini models first.', 'error');
  return false;
}

async function renderGlobalModelControl(promptDisclaimerAccepted) {
  const globalModelSelect = document.getElementById('globalGeminiModelSelect');
  if (!globalModelSelect) return DEFAULT_GEMINI_MODEL;

  const allowPaidModels = await renderPaidGeminiModelsControl();
  const globalModel = await loadGlobalGeminiModel(allowPaidModels);
  populateModelSelectOptions(globalModelSelect, globalModel, globalModel, false, allowPaidModels);

  globalModelSelect.disabled = !promptDisclaimerAccepted;
  globalModelSelect.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
  globalModelSelect.title = promptDisclaimerAccepted
    ? 'Select default Gemini model for all prompts'
    : 'Accept prompt responsibility first';

  if (!globalModelSelect.dataset.bound) {
    globalModelSelect.dataset.bound = '1';
    globalModelSelect.addEventListener('click', (e) => e.stopPropagation());
    globalModelSelect.addEventListener('change', async (e) => {
      if (!(await ensurePromptDisclaimerAccepted())) {
        await renderPrompts();
        return;
      }
      const selectedModel = normalizeGlobalGeminiModel(e.target.value, await loadAllowPaidGeminiModels());
      if (!(await ensurePaidGeminiModelAllowed(selectedModel))) {
        await renderPrompts();
        return;
      }
      await saveGlobalGeminiModel(selectedModel, await loadAllowPaidGeminiModels());
      const selectedMeta = getGeminiModelMeta(selectedModel);
      showToast('🤖', `Global model: ${selectedMeta.uiLabel}`, 'success');
      await renderPrompts();
    });
  }

  return globalModel;
}

function createPromptModelRow(prompt, globalModel, promptDisclaimerAccepted) {
  const row = document.createElement('div');
  row.className = 'prompt-model-row translation-settings';
  row.addEventListener('click', (e) => e.stopPropagation());

  const allowPaidModels = document.getElementById('allowPaidGeminiModelsCheckbox')?.checked === true;
  const effectiveModel = getEffectivePromptModel(prompt, globalModel, allowPaidModels);
  const effectiveMeta = getGeminiModelMeta(effectiveModel);

  const label = document.createElement('div');
  label.className = 'prompt-model-row-label';
  label.textContent = `Model (${effectiveMeta.billingLabel}):`;

  const select = document.createElement('select');
  select.className = 'prompt-model-row-select';
  const selectedValue = normalizePromptModelOverride(prompt.modelOverride, allowPaidModels);
  populateModelSelectOptions(select, globalModel, selectedValue, true, allowPaidModels);
  select.disabled = !promptDisclaimerAccepted;
  select.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
  select.title = promptDisclaimerAccepted
    ? 'Select model for this prompt'
    : 'Accept prompt responsibility first';

  select.addEventListener('click', (e) => e.stopPropagation());
  select.addEventListener('change', async (e) => {
    e.stopPropagation();

    if (!(await ensurePromptDisclaimerAccepted())) {
      await renderPrompts();
      return;
    }

    const selection = e.target.value;
    const normalizedSelection = selection === MODEL_MODE_GLOBAL
      ? MODEL_MODE_GLOBAL
      : normalizeGlobalGeminiModel(selection, await loadAllowPaidGeminiModels());

    if (normalizedSelection !== MODEL_MODE_GLOBAL && !(await ensurePaidGeminiModelAllowed(normalizedSelection))) {
      await renderPrompts();
      return;
    }

    const { prompts, showDefault, selectedCustomPromptId } = await loadPrompts();
    const promptIndex = prompts.findIndex((p) => p.id === prompt.id);
    if (promptIndex === -1) return;

    if (normalizedSelection === MODEL_MODE_GLOBAL) {
      delete prompts[promptIndex].modelOverride;
    } else {
      prompts[promptIndex].modelOverride = normalizedSelection;
    }

    await savePrompts(prompts, showDefault, selectedCustomPromptId);
    const selectedModel = normalizedSelection === MODEL_MODE_GLOBAL
      ? normalizeGlobalGeminiModel(globalModel, await loadAllowPaidGeminiModels())
      : normalizedSelection;
    const selectedMeta = getGeminiModelMeta(selectedModel);
    showToast('🤖', `${prompt.title}: ${selectedMeta.uiLabel}`, 'success');
    await renderPrompts();
  });

  row.appendChild(label);
  row.appendChild(select);
  return row;
}

async function isPromptDisclaimerAccepted() {
  const result = await chrome.storage.local.get([PROMPT_DISCLAIMER_KEY]);
  return result[PROMPT_DISCLAIMER_KEY] === true;
}

function highlightPromptDisclaimerControl() {
  applyGeminiApiSectionCollapsedState(false);
  chrome.storage.local.set({ [GEMINI_API_SECTION_COLLAPSED_KEY]: false });

  const checkbox = document.getElementById('promptDisclaimerCheckbox');
  const target = checkbox?.closest('.prompt-disclaimer-label') || checkbox;
  if (!target) return false;

  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('prompt-disclaimer-highlight');
  checkbox?.focus();

  setTimeout(() => {
    target.classList.remove('prompt-disclaimer-highlight');
  }, 4300);

  return true;
}

function maybeHighlightPromptDisclaimerFromFlag() {
  chrome.storage.local.get([HIGHLIGHT_PROMPT_DISCLAIMER_KEY], (result) => {
    if (!result?.[HIGHLIGHT_PROMPT_DISCLAIMER_KEY]) return;

    setTimeout(() => {
      const highlighted = highlightPromptDisclaimerControl();
      if (highlighted) {
        showToast('⚠️', 'Accept prompt responsibility before Gemini can run', 'info');
      }
      chrome.storage.local.remove([HIGHLIGHT_PROMPT_DISCLAIMER_KEY]);
    }, 280);
  });
}

async function openAiTranscriptionMenuOnActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/youtube\.com/.test(tab.url)) {
      return false;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'openAiTranscriptionSettings' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Popup] Could not open AI Transcription menu:', chrome.runtime.lastError.message);
        return;
      }
      if (!response?.success) {
        console.warn('[Popup] AI Transcription menu did not open:', response?.error || 'unknown error');
      }
    });

    return true;
  } catch (error) {
    console.warn('[Popup] Failed to request AI Transcription menu:', error);
    return false;
  }
}

async function ensurePromptDisclaimerAccepted() {
  const accepted = await isPromptDisclaimerAccepted();
  if (!accepted) {
    showToast('⚠️', 'Please accept prompt responsibility first', 'error');
    highlightPromptDisclaimerControl();
  }
  return accepted;
}

function showPromptResponsibilityApprovalModal() {
  return new Promise((resolve) => {
    const existing = document.getElementById('prompt-responsibility-approval-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'prompt-responsibility-approval-modal';
    modal.innerHTML = `
      <div class="pr-modal-backdrop"></div>
      <div class="pr-modal-content" role="dialog" aria-modal="true" aria-labelledby="prModalTitle">
        <h3 id="prModalTitle" class="pr-modal-title">Prompt Usage Responsibility</h3>
        <p class="pr-modal-subtitle">
          Before enabling Gemini Auto/Always, please review what this approval means:
        </p>
        <div class="pr-modal-scroll">
          <ul class="pr-modal-list">
            <li>Gemini requests are sent directly from your browser to Google using your API key.</li>
            <li>Requests may include video reference, selected prompt, model, language settings, and enabled AI options.</li>
            <li>If enabled, translation, transcript-based mode, video analysis, search, and URL context may be included in request content.</li>
            <li>Your Gemini API key is stored locally in your browser.</li>
            <li>YouChords does not store your Gemini API key.</li>
            <li>Google pricing, quota, terms, and privacy policy apply to your account.</li>
            <li>You are responsible for prompt content, privacy impact, and any Gemini-related costs.</li>
          </ul>
          <p class="pr-modal-note">
            By clicking "I Understand & Approve", you confirm you understand and accept this responsibility.
          </p>
        </div>
        <div class="pr-modal-actions">
          <button type="button" class="pr-btn pr-btn-cancel">Cancel</button>
          <button type="button" class="pr-btn pr-btn-approve">I Understand & Approve</button>
        </div>
      </div>
    `;

    if (!document.getElementById('prompt-responsibility-approval-style')) {
      const style = document.createElement('style');
      style.id = 'prompt-responsibility-approval-style';
      style.textContent = `
        #prompt-responsibility-approval-modal {
          position: fixed;
          inset: 0;
          z-index: 10002;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        #prompt-responsibility-approval-modal .pr-modal-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.62);
          backdrop-filter: blur(2px);
        }
        #prompt-responsibility-approval-modal .pr-modal-content {
          position: relative;
          width: calc(100% - 24px);
          max-width: 360px;
          background: #ffffff;
          border-radius: 12px;
          border: 1px solid #e5e7eb;
          box-shadow: 0 16px 48px rgba(15, 23, 42, 0.28);
          padding: 16px;
          box-sizing: border-box;
        }
        #prompt-responsibility-approval-modal .pr-modal-title {
          margin: 0 0 6px;
          font-size: 16px;
          color: #111827;
        }
        #prompt-responsibility-approval-modal .pr-modal-subtitle {
          margin: 0 0 10px;
          font-size: 12px;
          color: #374151;
          line-height: 1.4;
        }
        #prompt-responsibility-approval-modal .pr-modal-scroll {
          max-height: 235px;
          overflow-y: auto;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 10px 10px 8px;
          background: #fafafa;
        }
        #prompt-responsibility-approval-modal .pr-modal-list {
          margin: 0;
          padding-left: 16px;
          font-size: 12px;
          line-height: 1.45;
          color: #1f2937;
        }
        #prompt-responsibility-approval-modal .pr-modal-list li {
          margin-bottom: 7px;
        }
        #prompt-responsibility-approval-modal .pr-modal-note {
          margin: 8px 0 0;
          font-size: 11px;
          line-height: 1.4;
          color: #4b5563;
        }
        #prompt-responsibility-approval-modal .pr-modal-actions {
          margin-top: 12px;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        #prompt-responsibility-approval-modal .pr-btn {
          border: none;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.14s ease, box-shadow 0.14s ease, transform 0.14s ease;
        }
        #prompt-responsibility-approval-modal .pr-btn-cancel {
          background: #e5e7eb;
          color: #374151;
        }
        #prompt-responsibility-approval-modal .pr-btn-cancel:hover {
          background: #d9dde3;
          box-shadow: 0 1px 4px rgba(15, 23, 42, 0.16);
          transform: translateY(-1px);
        }
        #prompt-responsibility-approval-modal .pr-btn-approve {
          background: linear-gradient(135deg, #16a34a, #15803d);
          color: #ffffff;
        }
        #prompt-responsibility-approval-modal .pr-btn-approve:hover {
          background: linear-gradient(135deg, #22c55e, #16a34a);
          box-shadow: 0 2px 6px rgba(22, 163, 74, 0.26);
          transform: translateY(-1px);
        }
      `;
      document.head.appendChild(style);
    }

    const close = (approved) => {
      modal.remove();
      resolve(approved);
    };

    modal.querySelector('.pr-modal-backdrop')?.addEventListener('click', () => close(false));
    modal.querySelector('.pr-btn-cancel')?.addEventListener('click', () => close(false));
    modal.querySelector('.pr-btn-approve')?.addEventListener('click', () => close(true));
    document.body.appendChild(modal);
    modal.querySelector('.pr-btn-approve')?.focus();
  });
}

async function handlePromptDisclaimerToggle(isAccepted) {
  const checkbox = document.getElementById('promptDisclaimerCheckbox');
  const currentlyAccepted = await isPromptDisclaimerAccepted();

  if (isAccepted) {
    if (currentlyAccepted) return;
    const approved = await showPromptResponsibilityApprovalModal();
    if (!approved) {
      await chrome.storage.local.set({ [PROMPT_DISCLAIMER_KEY]: false });
      if (checkbox) checkbox.checked = false;
      showToast('ℹ️', 'Approval canceled. Gemini remains blocked.', 'info');
      await renderPrompts();
      return;
    }

    await chrome.storage.local.set({ [PROMPT_DISCLAIMER_KEY]: true });
    showToast('✅', 'Prompt responsibility approved', 'success');
    await renderPrompts();
    return;
  }

  if (!currentlyAccepted) {
    if (checkbox) checkbox.checked = false;
    return;
  }

  await chrome.storage.local.set({ [PROMPT_DISCLAIMER_KEY]: false });
  showToast('ℹ️', 'Prompt responsibility removed. Gemini is blocked.', 'info');
  await renderPrompts();
}

async function loadPromptCollapsedState() {
  const result = await chrome.storage.local.get([PROMPT_COLLAPSED_STATE_KEY]);
  return result[PROMPT_COLLAPSED_STATE_KEY] || {};
}

async function savePromptCollapsedState(collapsedState) {
  await chrome.storage.local.set({ [PROMPT_COLLAPSED_STATE_KEY]: collapsedState });
}

async function togglePromptCollapsed(promptId) {
  const collapsedState = await loadPromptCollapsedState();
  collapsedState[promptId] = !collapsedState[promptId];
  await savePromptCollapsedState(collapsedState);
  await renderPrompts();
}

async function setAllPromptsCollapsed(isCollapsed) {
  const { prompts } = await loadPrompts();
  const collapsedState = await loadPromptCollapsedState();
  prompts.forEach((prompt) => {
    collapsedState[prompt.id] = isCollapsed;
  });
  await savePromptCollapsedState(collapsedState);
  await renderPrompts();
}

function getActivePromptTitles(prompts, showDefault, showTranslation, selectedCustomPromptId) {
  if (!Array.isArray(prompts) || prompts.length === 0) return [];

  const promptById = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const activeTitles = [];

  if (showDefault) {
    activeTitles.push(promptById.get('default')?.title || 'Default');
  }

  if (showTranslation) {
    activeTitles.push(promptById.get('translation')?.title || 'Translation');
  }

  if (selectedCustomPromptId) {
    const selectedPrompt = promptById.get(selectedCustomPromptId);
    if (selectedPrompt?.title) {
      activeTitles.push(selectedPrompt.title);
    }
  }

  return [...new Set(activeTitles.filter(Boolean))];
}

function updateApiCollapsedPromptSummary(prompts, showDefault, showTranslation, selectedCustomPromptId, promptDisclaimerAccepted) {
  const summaryEl = document.getElementById('apiCollapsedPromptSummary');
  if (!summaryEl) return;

  const activeTitles = getActivePromptTitles(prompts, showDefault, showTranslation, selectedCustomPromptId);
  if (activeTitles.length === 0) {
    summaryEl.hidden = true;
    summaryEl.replaceChildren();
    summaryEl.removeAttribute('title');
    summaryEl.classList.remove('active');
    summaryEl.classList.remove('blocked');
    return;
  }

  summaryEl.replaceChildren();
  const statusLine = document.createElement('div');
  statusLine.className = 'api-collapsed-prompt-summary-status';

  const statusDot = document.createElement('span');
  statusDot.className = 'api-collapsed-prompt-summary-dot';

  const statusText = document.createElement('span');
  const hasMultipleActivePrompts = activeTitles.length > 1;
  statusText.textContent = promptDisclaimerAccepted
    ? hasMultipleActivePrompts
      ? 'Active prompts'
      : 'Active prompt'
    : 'Prompt selected - approval needed';

  statusLine.append(statusDot, statusText);
  summaryEl.appendChild(statusLine);

  activeTitles.forEach((title) => {
    const line = document.createElement('div');
    line.className = 'api-collapsed-prompt-summary-item';
    line.textContent = title;
    summaryEl.appendChild(line);
  });
  summaryEl.title = `${statusText.textContent}\n${activeTitles.map((title) => `• ${title}`).join('\n')}`;
  summaryEl.hidden = false;
  summaryEl.classList.toggle('active', promptDisclaimerAccepted);
  summaryEl.classList.toggle('blocked', !promptDisclaimerAccepted);
}

// Render prompts list
async function renderPrompts() {
  const promptsList = document.getElementById('promptsList');
  if (!promptsList) return;

  const { prompts, showDefault, selectedCustomPromptId, promptDisclaimerAccepted } = await loadPrompts();

  // 🆕 Load translation state
  const translationResult = await chrome.storage.local.get(['showTranslation']);
  const showTranslation = translationResult.showTranslation || false;
  const collapsedState = await loadPromptCollapsedState();

  updateApiCollapsedPromptSummary(
    prompts,
    showDefault,
    showTranslation,
    selectedCustomPromptId,
    promptDisclaimerAccepted
  );

  const promptDisclaimerCheckbox = document.getElementById('promptDisclaimerCheckbox');
  if (promptDisclaimerCheckbox) {
    promptDisclaimerCheckbox.checked = promptDisclaimerAccepted;
  }

  const addPromptBtn = document.getElementById('addPromptBtn');
  if (addPromptBtn) {
    addPromptBtn.disabled = !promptDisclaimerAccepted;
    addPromptBtn.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
    addPromptBtn.title = promptDisclaimerAccepted
      ? 'Add new prompt'
      : 'Accept prompt responsibility first';
  }

  const expandAllPromptsBtn = document.getElementById('expandAllPromptsBtn');
  if (expandAllPromptsBtn) {
    expandAllPromptsBtn.disabled = !promptDisclaimerAccepted;
    expandAllPromptsBtn.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
    expandAllPromptsBtn.title = promptDisclaimerAccepted
      ? 'Expand all prompts'
      : 'Accept prompt responsibility first';
  }

  const minimizeAllPromptsBtn = document.getElementById('minimizeAllPromptsBtn');
  if (minimizeAllPromptsBtn) {
    minimizeAllPromptsBtn.disabled = !promptDisclaimerAccepted;
    minimizeAllPromptsBtn.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
    minimizeAllPromptsBtn.title = promptDisclaimerAccepted
      ? 'Minimize all prompts'
      : 'Accept prompt responsibility first';
  }

  const globalModel = await renderGlobalModelControl(promptDisclaimerAccepted);

  promptsList.innerHTML = '';

  prompts.forEach(prompt => {
    const item = document.createElement('div');
    item.className = 'prompt-item';

    const isDefault = prompt.id === 'default';
    const isTranslation = prompt.id === 'translation';
    const isCollapsed = collapsedState[prompt.id] === true;

    // 🆕 Determine if selected based on type
    let isSelected;
    if (isDefault) {
      isSelected = showDefault;
    } else if (isTranslation) {
      isSelected = showTranslation;
    } else {
      isSelected = prompt.id === selectedCustomPromptId;
    }

    if (isSelected) item.classList.add('selected');
    if (isDefault) item.classList.add('default');
    if (isTranslation) item.classList.add('translation');
    if (isCollapsed) item.classList.add('collapsed');
    if (!promptDisclaimerAccepted) item.classList.add('disabled');
    item.dataset.promptId = prompt.id;

    const content = document.createElement('div');
    content.className = 'prompt-content';

    const titleRow = document.createElement('div');
    titleRow.className = 'prompt-item-title';

    const title = document.createElement('div');
    title.className = 'prompt-item-title-main';
    title.textContent = prompt.title;
    if (prompt.isDefault) {
      const badge = document.createElement('span');
      badge.className = 'default-badge';
      badge.textContent = 'DEFAULT';
      title.appendChild(badge);
    }
    // 🆕 Translation badge
    if (prompt.isTranslation) {
      const badge = document.createElement('span');
      badge.className = 'translation-badge';
      badge.textContent = 'TRANSLATION';
      badge.style.cssText = `
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 9px;
        margin-left: 6px;
        font-weight: 600;
      `;
      title.appendChild(badge);
    }

    // ✅ Add icons for custom prompts based on enabled features
    if (!prompt.isDefault) {
      let icons = '';
      if (prompt.useTranscriptBased) icons += '📝';
      if (prompt.useVideoAnalysis) icons += '🎥';
      if (prompt.useGoogleSearch) icons += '🔎';
      if (prompt.useUrlContext) icons += '📖';

      if (icons) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'prompt-icons';
        iconSpan.textContent = ' ' + icons;
        iconSpan.style.marginLeft = '6px';
        title.appendChild(iconSpan);
      }
    }

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'prompt-collapse-btn';
    collapseBtn.title = isCollapsed ? 'Expand prompt' : 'Minimize prompt';
    collapseBtn.textContent = isCollapsed ? '▸' : '▾';
    collapseBtn.disabled = !promptDisclaimerAccepted;
    collapseBtn.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
    collapseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await ensurePromptDisclaimerAccepted())) return;
      await togglePromptCollapsed(prompt.id);
    });

    titleRow.appendChild(title);
    titleRow.appendChild(collapseBtn);

    const text = document.createElement('div');
    text.className = 'prompt-item-text';

    if (!isCollapsed) {

    // 🆕 Translation prompt - show language selector with boxed button + options
    if (prompt.isTranslation) {
      // 🔧 Add class to prevent click bubbling to parent
      text.classList.add('translation-settings');

      // Load settings from storage
      chrome.storage.local.get([
        'translationLanguage',
        'translationIncludeOriginal',
        'translationSecondaryLanguage'
      ], (result) => {
        const langCode = result.translationLanguage || 'he'; // default Hebrew
        const includeOriginal = result.translationIncludeOriginal || false;
        const secondaryLang = result.translationSecondaryLanguage || null;

        const lang = window.getLanguageByCode ? window.getLanguageByCode(langCode) : { name: 'Hebrew', nativeName: 'עברית' };

        // Container for all translation options
        text.style.color = '#aaa';
        text.style.display = 'flex';
        text.style.flexDirection = 'column';
        text.style.gap = '8px';
        text.style.width = '100%';

        // Row 1: Include Original Toggle
        const includeOriginalRow = document.createElement('div');
        includeOriginalRow.style.cssText = `
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
        `;

        const includeOriginalCheckbox = document.createElement('input');
        includeOriginalCheckbox.type = 'checkbox';
        includeOriginalCheckbox.checked = includeOriginal;
        includeOriginalCheckbox.style.cursor = 'pointer';

        const includeOriginalLabel = document.createElement('label');
        includeOriginalLabel.textContent = 'Include original transcription';
        includeOriginalLabel.style.cursor = 'pointer';
        includeOriginalLabel.style.opacity = secondaryLang ? '0.5' : '1';

        includeOriginalCheckbox.addEventListener('change', async (e) => {
          e.stopPropagation();
          const newValue = e.target.checked;
          console.log('[Translation] Include original changing to:', newValue);
          
          // If enabling Include Original, clear secondary language
          if (newValue) {
            await chrome.storage.local.set({ 
              translationIncludeOriginal: true,
              translationSecondaryLanguage: null 
            });
            console.log('[Translation] Include original enabled, secondary language cleared');
          } else {
            await chrome.storage.local.set({ translationIncludeOriginal: false });
            console.log('[Translation] Include original disabled');
          }
          
          await renderPrompts(); // Re-render to update UI
        });

        includeOriginalLabel.addEventListener('click', (e) => {
          e.stopPropagation();
          // Always allow clicking - no more blocking
          includeOriginalCheckbox.checked = !includeOriginalCheckbox.checked;
          includeOriginalCheckbox.dispatchEvent(new Event('change'));
        });

        includeOriginalRow.appendChild(includeOriginalCheckbox);
        includeOriginalRow.appendChild(includeOriginalLabel);

        // Row 2: Primary Language
        const primaryLangRow = document.createElement('div');
        primaryLangRow.style.cssText = `
          display: flex;
          align-items: center;
          gap: 6px;
        `;

        const primaryLabel = document.createElement('span');
        primaryLabel.textContent = 'Primary Language:';
        primaryLabel.style.cursor = 'default';

        const langButton = document.createElement('span');
        langButton.textContent = `${lang.name} (${lang.nativeName}) ▼`;
        langButton.style.cssText = `
          border: 1px solid #ddd;
          padding: 2px 6px;
          border-radius: 3px;
          cursor: pointer;
          display: inline-block;
          transition: all 0.15s ease;
        `;

        langButton.addEventListener('mouseenter', () => {
          langButton.style.borderColor = '#999';
          langButton.style.backgroundColor = '#f5f5f5';
        });
        langButton.addEventListener('mouseleave', () => {
          langButton.style.borderColor = '#ddd';
          langButton.style.backgroundColor = 'transparent';
        });

        langButton.addEventListener('click', (e) => {
          e.stopPropagation();
          showLanguageSelector(langButton, langCode, 'primary');
        });

        primaryLangRow.appendChild(primaryLabel);
        primaryLangRow.appendChild(langButton);

        // Row 3: Secondary Language
        const secondaryLangRow = document.createElement('div');
        secondaryLangRow.style.cssText = `
          display: flex;
          align-items: center;
          gap: 6px;
        `;

        if (secondaryLang) {
          // Show selected secondary language with remove button
          const secondaryLabel = document.createElement('span');
          secondaryLabel.textContent = 'Secondary Language:';
          secondaryLabel.style.cursor = 'default';

          const secondaryLangObj = window.getLanguageByCode ? window.getLanguageByCode(secondaryLang) : { name: secondaryLang, nativeName: secondaryLang };

          const secondaryLangButton = document.createElement('span');
          secondaryLangButton.textContent = `${secondaryLangObj.name} (${secondaryLangObj.nativeName})`;
          secondaryLangButton.style.cssText = `
            border: 1px solid #ddd;
            padding: 2px 6px;
            border-radius: 3px;
            display: inline-block;
            cursor: pointer;
            transition: all 0.2s ease;
          `;

          // 🆕 Make secondary language button clickable to change language
          secondaryLangButton.addEventListener('mouseenter', () => {
            secondaryLangButton.style.background = '#f0f0f0';
          });

          secondaryLangButton.addEventListener('mouseleave', () => {
            secondaryLangButton.style.background = '';
          });

          secondaryLangButton.addEventListener('click', (e) => {
            e.stopPropagation();
            showLanguageSelector(secondaryLangButton, null, 'secondary');
          });

          const removeBtn = document.createElement('button');
          removeBtn.innerHTML = '🗑️';
          removeBtn.title = 'Remove secondary language';
          removeBtn.style.cssText = `
            background: transparent;
            color: inherit;
            border: none;
            cursor: pointer;
            font-size: 16px;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
          `;

          removeBtn.addEventListener('mouseenter', () => {
            removeBtn.style.transform = 'scale(1.2)';
          });

          removeBtn.addEventListener('mouseleave', () => {
            removeBtn.style.transform = 'scale(1)';
          });

          removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            // ✅ Show confirmation dialog (same as custom prompt delete)
            const confirmed = await showConfirmDialog(
              '🗑️',
              'Remove Secondary Language',
              'Are you sure you want to remove the secondary language?',
              'Remove',
              'Cancel'
            );

            if (!confirmed) return;

            await chrome.storage.local.set({ translationSecondaryLanguage: null });
            console.log('[Translation] Removed secondary language');
            await renderPrompts();
            showToast('🗑️', 'Secondary language removed', 'info');
          });

          secondaryLangRow.appendChild(secondaryLabel);
          secondaryLangRow.appendChild(secondaryLangButton);
          secondaryLangRow.appendChild(removeBtn);
        } else {
          // Show "Add another language" button
          const addBtn = document.createElement('button');
          addBtn.textContent = '+ Add another language';
          addBtn.style.cssText = `
            background: ${includeOriginal ? '#ccc' : '#4285f4'};
            color: white;
            border: none;
            border-radius: 3px;
            padding: 4px 8px;
            cursor: pointer;
            font-size: 11px;
            opacity: ${includeOriginal ? '0.5' : '1'};
          `;

          addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            
            // If Include Original is ON, turn it OFF first
            if (includeOriginal) {
              await chrome.storage.local.set({ translationIncludeOriginal: false });
              console.log('[Translation] Include original disabled (switching to secondary language)');
              await renderPrompts(); // Re-render to update UI state
            }
            
            showLanguageSelector(addBtn, null, 'secondary');
          });

          secondaryLangRow.appendChild(addBtn);
        }

        text.appendChild(includeOriginalRow);
        text.appendChild(primaryLangRow);
        text.appendChild(secondaryLangRow);

        // Row 4: Thinking Level
        const thinkingLevelRow = document.createElement('div');
        thinkingLevelRow.style.cssText = `
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          margin-top: 4px;
        `;

        // Prevent click from propagating to parent (prompt-item)
        thinkingLevelRow.addEventListener('click', (e) => {
          e.stopPropagation();
        });

        const thinkingLabel = document.createElement('span');
        thinkingLabel.textContent = 'Thinking Level:';
        thinkingLabel.style.cursor = 'default';

        // Load current thinking level
        chrome.storage.local.get(['translationThinkingLevel'], (thinkingResult) => {
          const currentLevel = thinkingResult.translationThinkingLevel || 'MINIMAL';

          const thinkingDropdown = document.createElement('select');
          thinkingDropdown.style.cssText = `
            border: 1px solid #ddd;
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
            background: white;
            font-size: 11px;
          `;

          const levels = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
          levels.forEach(level => {
            const option = document.createElement('option');
            option.value = level;
            option.textContent = level;
            if (level === currentLevel) option.selected = true;
            thinkingDropdown.appendChild(option);
          });

          // Prevent click from propagating to parent (prompt-item)
          thinkingDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
          });

          thinkingDropdown.addEventListener('change', async (e) => {
            e.stopPropagation();
            await chrome.storage.local.set({ translationThinkingLevel: e.target.value });
            console.log('[Translation] Thinking level:', e.target.value);
            showToast('🧠', `Thinking level set to ${e.target.value}`, 'success');
          });

          thinkingLevelRow.appendChild(thinkingLabel);
          thinkingLevelRow.appendChild(thinkingDropdown);
          text.appendChild(thinkingLevelRow);
        });

        // Row 5: Info Note + Refresh Button
        const refreshRow = document.createElement('div');
        refreshRow.style.cssText = `
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid #eee;
        `;

        // Refresh button
        const refreshBtn = document.createElement('button');
        refreshBtn.innerHTML = '🔄 Refresh Current Video';
        refreshBtn.title = 'Delete cached translation and regenerate with new settings';
        refreshBtn.style.cssText = `
          background: #f5f5f5;
          color: #555;
          border: 1px solid #ddd;
          border-radius: 4px;
          padding: 6px 10px;
          cursor: pointer;
          font-size: 11px;
          transition: all 0.2s ease;
          font-weight: 500;
        `;

        refreshBtn.addEventListener('mouseenter', () => {
          refreshBtn.style.background = '#e8e8e8';
          refreshBtn.style.borderColor = '#999';
        });

        refreshBtn.addEventListener('mouseleave', () => {
          refreshBtn.style.background = '#f5f5f5';
          refreshBtn.style.borderColor = '#ddd';
        });

        refreshBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          
          // Get current video ID
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.url) {
            showToast('❌', 'No YouTube video found', 'error');
            return;
          }

          const videoIdMatch = tab.url.match(/[?&]v=([^&]+)/);
          if (!videoIdMatch) {
            showToast('❌', 'Not on a YouTube video page', 'error');
            return;
          }

          const videoId = videoIdMatch[1];

          // Get current translation settings from popup
          const currentSettings = await chrome.storage.local.get([
            'translationLanguage',
            'translationIncludeOriginal',
            'translationSecondaryLanguage'
          ]);

          // Send message to content script to check and refresh translation
          chrome.tabs.sendMessage(tab.id, {
            action: 'refreshTranslation',
            videoId: videoId,
            currentSettings: {
              language: currentSettings.translationLanguage || 'he',
              includeOriginal: currentSettings.translationIncludeOriginal || false,
              secondaryLanguage: currentSettings.translationSecondaryLanguage || null
            }
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Popup] Error sending message:', chrome.runtime.lastError);
              showToast('❌', 'Failed to refresh translation', 'error');
              return;
            }

            if (response && response.success) {
              if (response.unchanged) {
                showToast('ℹ️', 'Settings unchanged, translation is already up to date', 'info');
              } else {
                showToast('✅', 'Translation cache cleared. Open carousel to regenerate.', 'success');
              }
            } else {
              showToast('❌', response.error || 'Failed to clear translation cache', 'error');
            }
          });
        });

        refreshRow.appendChild(refreshBtn);
        text.appendChild(refreshRow);
        text.appendChild(createPromptModelRow(prompt, globalModel, promptDisclaimerAccepted));

        if (!promptDisclaimerAccepted) {
          text.style.pointerEvents = 'none';
          text.style.opacity = '0.6';
        }
      });
    }
    // Built-in about-song prompt
    else if (prompt.isBuiltInCustom) {
      text.classList.add('translation-settings');
      text.style.color = '#aaa';
      text.style.display = 'flex';
      text.style.flexDirection = 'column';
      text.style.gap = '8px';
      text.style.width = '100%';

      const intro = document.createElement('div');
      intro.textContent = prompt.prompt;
      intro.style.fontSize = '11px';
      intro.style.lineHeight = '1.35';

      const languageRow = document.createElement('div');
      languageRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
      `;

      const languageLabel = document.createElement('span');
      languageLabel.textContent = 'Answer language:';

      const languageButton = document.createElement('span');
      languageButton.style.cssText = `
        border: 1px solid #ddd;
        padding: 2px 6px;
        border-radius: 3px;
        cursor: pointer;
        display: inline-block;
        transition: all 0.15s ease;
      `;

      chrome.storage.local.get([ABOUT_SONG_LANGUAGE_KEY], (langResult) => {
        const langCode = langResult[ABOUT_SONG_LANGUAGE_KEY] || 'en';
        const langObj = window.getLanguageByCode ? window.getLanguageByCode(langCode) : null;
        const label = langObj ? `${langObj.name} (${langObj.nativeName})` : langCode.toUpperCase();
        languageButton.textContent = `${label} ▼`;

        languageButton.addEventListener('click', (e) => {
          e.stopPropagation();
          showLanguageSelector(languageButton, langCode, 'aboutSong');
        });
      });

      languageButton.addEventListener('mouseenter', () => {
        languageButton.style.borderColor = '#999';
        languageButton.style.backgroundColor = '#f5f5f5';
      });
      languageButton.addEventListener('mouseleave', () => {
        languageButton.style.borderColor = '#ddd';
        languageButton.style.backgroundColor = 'transparent';
      });

      languageRow.appendChild(languageLabel);
      languageRow.appendChild(languageButton);

      const refreshRow = document.createElement('div');
      refreshRow.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #eee;
      `;

      const refreshBtn = document.createElement('button');
      refreshBtn.innerHTML = '🔄 Refresh Current Video';
      refreshBtn.title = 'Delete cached response and regenerate with current about-video language';
      refreshBtn.style.cssText = `
        background: #f5f5f5;
        color: #555;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 11px;
        transition: all 0.2s ease;
        font-weight: 500;
      `;

      refreshBtn.addEventListener('mouseenter', () => {
        refreshBtn.style.background = '#e8e8e8';
        refreshBtn.style.borderColor = '#999';
      });

      refreshBtn.addEventListener('mouseleave', () => {
        refreshBtn.style.background = '#f5f5f5';
        refreshBtn.style.borderColor = '#ddd';
      });

      refreshBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) {
          showToast('❌', 'No YouTube video found', 'error');
          return;
        }

        const videoIdMatch = tab.url.match(/[?&]v=([^&]+)/);
        if (!videoIdMatch) {
          showToast('❌', 'Not on a YouTube video page', 'error');
          return;
        }

        const videoId = videoIdMatch[1];

        const currentPromptResult = await chrome.storage.local.get([
          ABOUT_SONG_LANGUAGE_KEY,
          'selectedCustomPromptId'
        ]);

        chrome.tabs.sendMessage(
          tab.id,
          {
            action: 'refreshAboutSongPrompt',
            videoId,
            promptId: ABOUT_SONG_PROMPT.id,
            language: currentPromptResult[ABOUT_SONG_LANGUAGE_KEY] || 'en',
            selectedCustomPromptId: currentPromptResult.selectedCustomPromptId || null
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Popup] Error sending about-song refresh message:', chrome.runtime.lastError);
              showToast('❌', 'Failed to refresh custom prompt', 'error');
              return;
            }

            if (response && response.success) {
              if (response.regenerated) {
                showToast('✅', 'About-video prompt regenerated with current language', 'success');
              } else if (response.deleted) {
                showToast('ℹ️', 'Cache cleared. Select this prompt and open panel to regenerate.', 'info');
              } else {
                showToast('ℹ️', 'No cached response found. Open panel to generate.', 'info');
              }
            } else {
              showToast('❌', response?.error || 'Failed to refresh prompt', 'error');
            }
          }
        );
      });

      refreshRow.appendChild(refreshBtn);

      text.appendChild(intro);
      text.appendChild(languageRow);
      text.appendChild(refreshRow);
      text.appendChild(createPromptModelRow(prompt, globalModel, promptDisclaimerAccepted));

      if (!promptDisclaimerAccepted) {
        text.style.pointerEvents = 'none';
        text.style.opacity = '0.6';
      }
    }
    // 🔒 Don't show default prompt text to users
    else {
      text.style.display = 'flex';
      text.style.flexDirection = 'column';
      text.style.gap = '6px';
      text.style.overflow = 'visible';
      text.style.textOverflow = 'initial';
      text.style.webkitLineClamp = 'unset';
      text.style.lineClamp = 'unset';
      text.style.webkitBoxOrient = 'initial';
      const summaryText = document.createElement('div');
      summaryText.textContent = prompt.isDefault ? '(Transcribes with precise sentence timings)' : prompt.prompt;
      summaryText.style.whiteSpace = 'pre-wrap';
      text.appendChild(summaryText);
      text.appendChild(createPromptModelRow(prompt, globalModel, promptDisclaimerAccepted));
    }
    }

    content.appendChild(titleRow);
    if (!isCollapsed) {
      content.appendChild(text);
    }

    item.appendChild(content);

    // Add edit and delete buttons ONLY for custom prompts (not default, not translation)
    if (!isCollapsed && !prompt.isDefault && !prompt.isTranslation && prompt.canDelete !== false) {
      const actions = document.createElement('div');
      actions.className = 'prompt-actions';

      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'prompt-action-btn edit';
      editBtn.innerHTML = '✏️';
      editBtn.title = 'Edit prompt';
      editBtn.disabled = !promptDisclaimerAccepted;
      editBtn.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlePromptEdit(prompt.id);
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'prompt-action-btn delete';
      deleteBtn.innerHTML = '🗑️';
      deleteBtn.title = 'Delete prompt';
      deleteBtn.disabled = !promptDisclaimerAccepted;
      deleteBtn.style.opacity = promptDisclaimerAccepted ? '1' : '0.45';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlePromptDelete(prompt.id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      item.appendChild(actions);
    }

    // Click on item to toggle
    item.addEventListener('click', (e) => {
      // 🔧 Ignore clicks from translation settings (checkboxes, language selectors, etc.)
      if (!e.target.closest('.prompt-actions') && !e.target.closest('.translation-settings')) {
        (async () => {
          if (!(await ensurePromptDisclaimerAccepted())) return;
          handlePromptToggle(prompt.id, !isSelected);
        })();
      }
    });

    promptsList.appendChild(item);
  });
}

// Handle prompt toggle (checkbox)
async function handlePromptToggle(promptId, isChecked) {
  if (!(await ensurePromptDisclaimerAccepted())) return;

  const { prompts, showDefault, selectedCustomPromptId } = await loadPrompts();

  const isDefault = promptId === 'default';
  const isTranslation = promptId === 'translation';

  let newShowDefault = showDefault;
  let newSelectedCustomPromptId = selectedCustomPromptId;
  let newShowTranslation = false;

  // Load current translation state
  const translationResult = await chrome.storage.local.get(['showTranslation']);
  newShowTranslation = translationResult.showTranslation || false;

  if (isDefault) {
    // Toggle default
    newShowDefault = isChecked;
    // 🎯 DEFAULT and TRANSLATION are mutually exclusive
    if (isChecked && newShowTranslation) {
      newShowTranslation = false; // Auto-disable translation
      console.log('[Prompts] 🔄 Auto-disabled translation (mutually exclusive with default)');
    }
  } else if (isTranslation) {
    // Toggle translation
    newShowTranslation = isChecked;
    // 🎯 TRANSLATION and DEFAULT are mutually exclusive
    if (isChecked && newShowDefault) {
      newShowDefault = false; // Auto-disable default
      console.log('[Prompts] 🔄 Auto-disabled default (mutually exclusive with translation)');
    }
  } else {
    // Toggle custom
    if (isChecked) {
      newSelectedCustomPromptId = promptId;
    } else {
      newSelectedCustomPromptId = null;
    }
  }

  // 🔒 Validation: At least one must be selected
  // If CUSTOM exists, allow disabling both DEFAULT and TRANSLATION
  // If no CUSTOM, require at least DEFAULT or TRANSLATION
  if (!newShowDefault && !newShowTranslation && !newSelectedCustomPromptId) {
    showToast('⚠️', 'At least one prompt must be selected', 'error');
    await renderPrompts(); // Re-render to reset checkbox
    return;
  }

  // Save translation state
  await chrome.storage.local.set({ showTranslation: newShowTranslation });

  // If prompt is selected, force it to expand (not minimized)
  if (isChecked) {
    const collapsedState = await loadPromptCollapsedState();
    if (collapsedState[promptId]) {
      collapsedState[promptId] = false;
      await savePromptCollapsedState(collapsedState);
    }
  }

  await savePrompts(prompts, newShowDefault, newSelectedCustomPromptId);
  await renderPrompts();

  console.log('[Prompts] ✅ Toggled prompt:', {
    promptId,
    isChecked,
    showDefault: newShowDefault,
    showTranslation: newShowTranslation,
    selectedCustomPromptId: newSelectedCustomPromptId
  });

  // 🆕 Notify only the active YouTube tab about prompt change
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (activeTab && activeTab.url && activeTab.url.includes('youtube.com')) {
      console.log('[Prompts] 📤 Sending promptChanged to active tab:', activeTab.id);
      
      chrome.tabs.sendMessage(activeTab.id, {
        command: 'promptChanged',
        showDefault: newShowDefault,
        showTranslation: newShowTranslation,
        selectedCustomPromptId: newSelectedCustomPromptId
      }).catch((error) => {
        // Ignore errors (tab might not have content script loaded)
        console.log('[Prompts] Could not send to active tab:', error.message);
      });
    } else {
      console.log('[Prompts] ℹ️ Active tab is not YouTube - skipping notification');
    }
  } catch (error) {
    console.warn('[Prompts] Failed to notify active tab:', error);
  }
}

// Handle prompt delete
async function handlePromptDelete(promptId) {
  if (!(await ensurePromptDisclaimerAccepted())) return;

  // ✅ Use custom confirmation instead of browser's ugly confirm()
  const confirmed = await showConfirmDialog(
    '🗑️',
    'Delete Prompt',
    'Are you sure you want to delete this prompt? This action cannot be undone.',
    'Delete',
    'Cancel'
  );

  if (!confirmed) return;

  const { prompts, showDefault, selectedCustomPromptId } = await loadPrompts();
  const targetPrompt = prompts.find((p) => p.id === promptId);
  if (!targetPrompt || targetPrompt.canDelete === false) {
    showToast('⚠️', 'This built-in prompt cannot be deleted', 'error');
    return;
  }
  const filtered = prompts.filter(p => p.id !== promptId);

  // If deleted prompt was selected, deselect it
  let newSelectedCustomPromptId = selectedCustomPromptId === promptId ? null : selectedCustomPromptId;
  let newShowDefault = showDefault === true;
  const translationResult = await chrome.storage.local.get(['showTranslation']);
  const newShowTranslation = translationResult.showTranslation === true;

  // Hard invariant: deleting a custom prompt must never leave "nothing selected".
  if (!newShowDefault && !newShowTranslation && !newSelectedCustomPromptId) {
    newShowDefault = true;
  }

  await savePrompts(filtered, newShowDefault, newSelectedCustomPromptId);
  await chrome.storage.local.set({ showDefault: newShowDefault });
  const collapsedState = await loadPromptCollapsedState();
  delete collapsedState[promptId];
  await savePromptCollapsedState(collapsedState);
  await renderPrompts();
  showToast('🗑️', 'Prompt deleted', 'info');
}

// Handle prompt edit
async function handlePromptEdit(promptId) {
  if (!(await ensurePromptDisclaimerAccepted())) return;

  const { prompts } = await loadPrompts();
  const prompt = prompts.find(p => p.id === promptId);

  if (!prompt) {
    showToast('⚠️', 'Prompt not found', 'error');
    return;
  }
  if (prompt.canDelete === false) {
    showToast('⚠️', 'This built-in prompt cannot be edited', 'error');
    return;
  }

  // Open form in edit mode
  showPromptForm(prompt);
}

// Show add/edit prompt form
function showPromptForm(editPrompt = null) {
  const form = document.getElementById('promptForm');
  const formTitle = document.getElementById('formTitle');
  const titleInput = document.getElementById('promptTitleInput');
  const textInput = document.getElementById('promptTextInput');
  const transcriptBasedCheckbox = document.getElementById('promptTranscriptBasedCheckbox');
  const videoAnalysisCheckbox = document.getElementById('promptVideoAnalysisCheckbox');
  const googleSearchCheckbox = document.getElementById('promptGoogleSearchCheckbox');
  const videoResolutionGroup = document.getElementById('videoResolutionGroup');
  const videoResolutionSelect = document.getElementById('videoResolution');
  const promptModelSelect = document.getElementById('promptModelSelect');
  const promptModelGroup = document.getElementById('promptModelGroup');
  const saveBtn = document.getElementById('formSaveBtn');

  if (!form) return;

  // 🔒 Check if we've reached the limit (only for new prompts, not edits)
  if (!editPrompt) {
    chrome.storage.local.get(['geminiPrompts'], (result) => {
      const prompts = result.geminiPrompts || [];
      const customPromptsCount = prompts.filter(
        p => !p.isDefault && !p.isTranslation && p.canDelete !== false
      ).length;

      if (customPromptsCount >= MAX_CUSTOM_PROMPTS) {
        showToast('⚠️', `Maximum ${MAX_CUSTOM_PROMPTS} custom prompts allowed`, 'error');
        return;
      }

      // Continue with showing the form
      void showFormContent();
    });
  } else {
    // Edit mode - no limit check needed
    void showFormContent();
  }

  async function showFormContent() {
    // Set form mode (add or edit)
    const urlContextCheckbox = document.getElementById('promptUrlContextCheckbox');
    const thinkingLevelSelect = document.getElementById('thinkingLevel');
    const allowPaidModels = await loadAllowPaidGeminiModels();
    const globalModel = await loadGlobalGeminiModel(allowPaidModels);

    if (promptModelSelect) {
      const selectedModel = editPrompt
        ? normalizePromptModelOverride(editPrompt.modelOverride, allowPaidModels)
        : MODEL_MODE_GLOBAL;
      populateModelSelectOptions(promptModelSelect, globalModel, selectedModel, true, allowPaidModels);
    }

    if (editPrompt) {
      formTitle.textContent = 'Edit Prompt';
      titleInput.value = editPrompt.title;
      textInput.value = editPrompt.prompt;
      if (transcriptBasedCheckbox) transcriptBasedCheckbox.checked = editPrompt.useTranscriptBased === true;
      videoAnalysisCheckbox.checked = editPrompt.useVideoAnalysis || false;
      googleSearchCheckbox.checked = editPrompt.useGoogleSearch || false;
      if (urlContextCheckbox) urlContextCheckbox.checked = editPrompt.useUrlContext || false;
      if (transcriptBasedCheckbox?.checked) {
        videoAnalysisCheckbox.checked = false;
      }
      videoResolutionSelect.value = editPrompt.videoResolution || 'medium';
      thinkingLevelSelect.value = editPrompt.thinkingLevel || 'MEDIUM';
      // Show/hide resolution dropdown based on video analysis
      videoResolutionGroup.style.display = editPrompt.useVideoAnalysis ? 'block' : 'none';
      saveBtn.dataset.editId = editPrompt.id; // Store ID for editing

      // 🔒 EDIT MODE: Disable prompt content, video analysis, google search, url context, resolution, and thinking level
      // Only allow editing the title to prevent cache confusion
      textInput.disabled = true;
      textInput.style.opacity = '0.6';
      textInput.style.cursor = 'not-allowed';
      if (transcriptBasedCheckbox) {
        transcriptBasedCheckbox.disabled = true;
        transcriptBasedCheckbox.style.cursor = 'not-allowed';
        transcriptBasedCheckbox.parentElement.style.cursor = 'not-allowed';
      }
      videoAnalysisCheckbox.disabled = true;
      videoAnalysisCheckbox.style.cursor = 'not-allowed';
      videoAnalysisCheckbox.parentElement.style.cursor = 'not-allowed';
      googleSearchCheckbox.disabled = true;
      googleSearchCheckbox.style.cursor = 'not-allowed';
      googleSearchCheckbox.parentElement.style.cursor = 'not-allowed';
      if (urlContextCheckbox) {
        urlContextCheckbox.disabled = true;
        urlContextCheckbox.style.cursor = 'not-allowed';
        urlContextCheckbox.parentElement.style.cursor = 'not-allowed';
      }
      videoResolutionSelect.disabled = true;
      videoResolutionSelect.style.cursor = 'not-allowed';
      thinkingLevelSelect.disabled = true;
      thinkingLevelSelect.style.cursor = 'not-allowed';
      if (promptModelSelect) {
        promptModelSelect.disabled = false;
        promptModelSelect.style.cursor = 'pointer';
      }
      if (promptModelGroup) {
        promptModelGroup.style.cursor = 'default';
        promptModelGroup.style.opacity = '1';
      }
      
      // 🔒 Disable entire Thinking Level container
      const thinkingLevelGroup = document.getElementById('thinkingLevelGroup');
      if (thinkingLevelGroup) {
        thinkingLevelGroup.style.cursor = 'not-allowed';
        thinkingLevelGroup.style.opacity = '0.6';
      }
    } else {
      formTitle.textContent = 'New Prompt';
      titleInput.value = '';
      textInput.value = '';
      if (transcriptBasedCheckbox) transcriptBasedCheckbox.checked = true; // Default: ON
      videoAnalysisCheckbox.checked = false; // ✅ Default: OFF
      googleSearchCheckbox.checked = false; // ✅ Default: OFF
      if (urlContextCheckbox) urlContextCheckbox.checked = false; // ✅ Default: OFF
      videoResolutionSelect.value = 'medium'; // Default to medium
      thinkingLevelSelect.value = 'MINIMAL'; // Default to MINIMAL
      videoResolutionGroup.style.display = 'none'; // Hidden by default
      delete saveBtn.dataset.editId; // Clear edit ID

      // ✅ NEW MODE: Enable all fields
      textInput.disabled = false;
      textInput.style.opacity = '1';
      textInput.style.cursor = 'text';
      if (transcriptBasedCheckbox) {
        transcriptBasedCheckbox.disabled = false;
        transcriptBasedCheckbox.style.cursor = 'pointer';
        transcriptBasedCheckbox.parentElement.style.cursor = 'pointer';
      }
      videoAnalysisCheckbox.disabled = false;
      videoAnalysisCheckbox.style.cursor = 'pointer';
      videoAnalysisCheckbox.parentElement.style.cursor = 'pointer';
      googleSearchCheckbox.disabled = false;
      googleSearchCheckbox.style.cursor = 'pointer';
      googleSearchCheckbox.parentElement.style.cursor = 'pointer';
      if (urlContextCheckbox) {
        urlContextCheckbox.disabled = false;
        urlContextCheckbox.style.cursor = 'pointer';
        urlContextCheckbox.parentElement.style.cursor = 'pointer';
      }
      videoResolutionSelect.disabled = false;
      videoResolutionSelect.style.cursor = 'pointer';
      thinkingLevelSelect.disabled = false;
      thinkingLevelSelect.style.cursor = 'pointer';
      if (promptModelSelect) {
        promptModelSelect.disabled = false;
        promptModelSelect.style.cursor = 'pointer';
      }
      if (promptModelGroup) {
        promptModelGroup.style.cursor = 'default';
        promptModelGroup.style.opacity = '1';
      }
      
      // ✅ Enable entire Thinking Level container
      const thinkingLevelGroup = document.getElementById('thinkingLevelGroup');
      if (thinkingLevelGroup) {
        thinkingLevelGroup.style.cursor = 'default';
        thinkingLevelGroup.style.opacity = '1';
      }
    }

    if (transcriptBasedCheckbox?.checked && videoAnalysisCheckbox.checked) {
      videoAnalysisCheckbox.checked = false;
    }
    videoResolutionGroup.style.display = videoAnalysisCheckbox.checked ? 'block' : 'none';

    form.style.display = 'block';
    titleInput.focus();
  }
}

// Hide prompt form
function hidePromptForm() {
  const form = document.getElementById('promptForm');
  if (form) form.style.display = 'none';
}

// Handle save prompt
async function handleSavePrompt() {
  if (!(await ensurePromptDisclaimerAccepted())) return;

  const titleInput = document.getElementById('promptTitleInput');
  const textInput = document.getElementById('promptTextInput');
  const transcriptBasedCheckbox = document.getElementById('promptTranscriptBasedCheckbox');
  const videoAnalysisCheckbox = document.getElementById('promptVideoAnalysisCheckbox');
  const googleSearchCheckbox = document.getElementById('promptGoogleSearchCheckbox');
  const urlContextCheckbox = document.getElementById('promptUrlContextCheckbox');
  const videoResolutionSelect = document.getElementById('videoResolution');
  const promptModelSelect = document.getElementById('promptModelSelect');
  const saveBtn = document.getElementById('formSaveBtn');

  if (!titleInput || !textInput) return;

  const title = titleInput.value.trim();
  const promptText = textInput.value.trim();
  const useTranscriptBased = transcriptBasedCheckbox?.checked === true;
  const useVideoAnalysis = videoAnalysisCheckbox.checked;
  const normalizedUseVideoAnalysis = useTranscriptBased ? false : useVideoAnalysis;
  const useGoogleSearch = googleSearchCheckbox.checked;
  const useUrlContext = urlContextCheckbox.checked;
  const videoResolution = videoResolutionSelect.value; // 'medium' or 'high'
  const thinkingLevel = document.getElementById('thinkingLevel').value; // 'LOW', 'MEDIUM', or 'HIGH'
  const allowPaidModels = await loadAllowPaidGeminiModels();
  const modelSelection = promptModelSelect?.value || MODEL_MODE_GLOBAL;
  const modelOverride = modelSelection === MODEL_MODE_GLOBAL
    ? null
    : normalizeGlobalGeminiModel(modelSelection, allowPaidModels);

  if (modelOverride && !(await ensurePaidGeminiModelAllowed(modelOverride))) {
    return;
  }

  if (!title) {
    showToast('⚠️', 'Please enter a title', 'error');
    return;
  }

  if (!promptText) {
    showToast('⚠️', 'Please enter a prompt', 'error');
    return;
  }

  const { prompts, showDefault, selectedCustomPromptId } = await loadPrompts();
  const editId = saveBtn.dataset.editId;

  // 🔍 Check for duplicate title
  const duplicatePrompt = prompts.find(p =>
    p.title.trim().toLowerCase() === title.toLowerCase() &&
    p.id !== editId // Exclude current prompt when editing
  );

  if (duplicatePrompt) {
    showToast('⚠️', 'A prompt with this title already exists', 'error');
    return;
  }

  if (editId) {
    // 🎯 Edit mode - update title + model only (keep prompt, tools and resolution unchanged)
    const promptIndex = prompts.findIndex(p => p.id === editId);
    if (promptIndex !== -1) {
      prompts[promptIndex].title = title;
      if (modelOverride) {
        prompts[promptIndex].modelOverride = modelOverride;
      } else {
        delete prompts[promptIndex].modelOverride;
      }
      // 🔒 DON'T update: prompt text and tool settings to prevent cache confusion
      await savePrompts(prompts, showDefault, selectedCustomPromptId);
      await renderPrompts();
      hidePromptForm();
      showToast('✅', 'Prompt updated!', 'success');
    } else {
      showToast('⚠️', 'Prompt not found', 'error');
    }
  } else {
    // 🎯 Add mode - create new prompt
    const newId = 'custom-' + Date.now();

    const newPrompt = {
      id: newId,
      title,
      prompt: promptText,
      useTranscriptBased: useTranscriptBased, // ✅ Save transcript-only preference
      useVideoAnalysis: normalizedUseVideoAnalysis, // ✅ Save video analysis preference
      videoResolution: normalizedUseVideoAnalysis ? videoResolution : null, // ✅ Save resolution only if video analysis is ON
      useGoogleSearch: useGoogleSearch, // ✅ Save Google Search preference
      useUrlContext: useUrlContext, // ✅ Save URL Context preference
      thinkingLevel: thinkingLevel, // ✅ Save thinking level
      modelOverride: modelOverride, // ✅ Per-prompt model override (or global when null)
      isDefault: false,
      canDelete: true
    };

    prompts.push(newPrompt);
    // Auto-select the newly created custom prompt (keep default if it was selected)
    await savePrompts(prompts, showDefault, newId);
    await renderPrompts();
    hidePromptForm();
    showToast('✅', 'Prompt saved and selected!', 'success');
  }
}

// ============================================
// API Key Management
// ============================================

function applyGeminiApiSectionCollapsedState(isCollapsed) {
  if (!elements.apiKeySection || !elements.apiSectionContent || !elements.apiSectionToggleBtn) return;

  elements.apiKeySection.classList.toggle('api-section-collapsed', isCollapsed);
  document.body?.classList.toggle('gemini-api-collapsed', isCollapsed);

  const nextTitle = isCollapsed ? 'Expand Gemini API section' : 'Minimize Gemini API section';
  elements.apiSectionToggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  elements.apiSectionToggleBtn.setAttribute('aria-label', nextTitle);
  elements.apiSectionToggleBtn.setAttribute('title', nextTitle);

  if (elements.apiSectionToggleArrow) {
    elements.apiSectionToggleArrow.textContent = isCollapsed ? '▸' : '▾';
  }
}

async function initGeminiApiSectionCollapse() {
  try {
    const result = await chrome.storage.local.get([GEMINI_API_SECTION_COLLAPSED_KEY]);
    const isCollapsed = result?.[GEMINI_API_SECTION_COLLAPSED_KEY] === true;
    applyGeminiApiSectionCollapsedState(isCollapsed);
  } catch (error) {
    console.warn('[API] Failed to load Gemini API section collapse state:', error);
    applyGeminiApiSectionCollapsedState(false);
  }
}

async function handleGeminiApiSectionToggle() {
  try {
    const currentlyCollapsed = elements.apiKeySection?.classList.contains('api-section-collapsed') === true;
    const nextCollapsed = !currentlyCollapsed;
    applyGeminiApiSectionCollapsedState(nextCollapsed);
    await chrome.storage.local.set({ [GEMINI_API_SECTION_COLLAPSED_KEY]: nextCollapsed });
  } catch (error) {
    console.warn('[API] Failed to persist Gemini API section collapse state:', error);
  }
}

// Validate Gemini API Key
async function validateGeminiApiKey(apiKey) {
  try {
    console.log('[API] Validating Gemini API key...');

    // Simple GET request to list available models
    // This doesn't consume tokens and works with any valid API key
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );

    if (response.ok) {
      const data = await response.json();
      console.log('[API] ✅ API key is valid. Available models:', data.models?.length || 0);
      return { valid: true };
    } else {
      const error = await response.json();
      console.log('[API] ❌ API key is invalid:', error);
      return { valid: false, error: error.error?.message || 'Invalid API key' };
    }
  } catch (error) {
    console.error('[API] ❌ Validation error:', error);
    return { valid: false, error: error.message };
  }
}

// Update API status badge
function updateApiStatus(status, text) {
  const apiStatus = document.getElementById('apiStatus');
  if (!apiStatus) return;

  // Remove all status classes
  apiStatus.classList.remove('not-set', 'active', 'invalid', 'testing');

  // Add new status class
  apiStatus.classList.add(status);

  // Update text
  const statusText = apiStatus.querySelector('span:last-child');
  if (statusText) {
    statusText.textContent = text;
  }
}

// Load saved API key
async function loadApiKey() {
  try {
    const result = await chrome.storage.local.get(['geminiApiKey', 'geminiApiKeyStatus']);

    if (result.geminiApiKey) {
      console.log('[API] Loaded saved API key');
      const apiKeyInput = document.getElementById('apiKeyInput');
      const saveBtn = document.getElementById('saveApiKeyBtn');

      if (apiKeyInput) {
        apiKeyInput.value = result.geminiApiKey;
        apiKeyInput.classList.add('has-value');
      }

      if (saveBtn) {
        saveBtn.disabled = false;
      }

      // Update status
      const status = result.geminiApiKeyStatus || 'active';
      const statusText = status === 'active' ? 'Active' : 'Not Set';
      updateApiStatus(status, statusText);
    }
  } catch (error) {
    console.error('[API] Error loading API key:', error);
  }
}

// Handle Save API Key
async function handleSaveApiKey() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveBtn = document.getElementById('saveApiKeyBtn');

  if (!apiKeyInput || !saveBtn) return;

  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    showToast('⚠️', 'Please enter an API key', 'error');
    return;
  }

  // Disable button and show testing status
  saveBtn.disabled = true;
  saveBtn.textContent = 'Testing...';
  updateApiStatus('testing', 'Testing...');

  // Validate API key
  const result = await validateGeminiApiKey(apiKey);

  if (result.valid) {
    // Save to chrome.storage.local
    await chrome.storage.local.set({
      geminiApiKey: apiKey,
      geminiApiKeyStatus: 'active',
      geminiApiKeyValidatedAt: Date.now(),
      [HIGHLIGHT_PROMPT_DISCLAIMER_KEY]: true
    });

    updateApiStatus('active', 'Active');
    openAiTranscriptionMenuOnActiveTab();
    showToast('✅', 'API key saved. Accept prompt responsibility, then choose Auto/Always.', 'success');
    console.log('[API] ✅ API key saved');
  } else {
    updateApiStatus('invalid', 'Invalid');
    showToast('❌', result.error || 'Invalid API key', 'error');
    console.log('[API] ❌ API key validation failed');
  }

  // Re-enable button
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save';
}

// Handle Clear API Key
async function handleClearApiKey() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveBtn = document.getElementById('saveApiKeyBtn');

  if (!apiKeyInput) return;

  // Check if there are other API keys
  const keys = await loadApiKeys();
  const activeKeys = keys.filter(k => k.active !== false);
  const hasCurrentDefaultKey = apiKeyInput.value.trim().length > 0;

  // Ask confirmation to prevent accidental clear
  if (hasCurrentDefaultKey) {
    const clearMessage = activeKeys.length > 0
      ? 'Are you sure you want to clear the DEFAULT API key? Another saved key will be promoted to DEFAULT.'
      : 'Are you sure you want to clear the DEFAULT API key?';
    const confirmed = await showConfirmDialog('⚠️', 'Clear API Key', clearMessage, 'Clear', 'Cancel');
    if (!confirmed) return;
  }

  // Clear input
  apiKeyInput.value = '';
  apiKeyInput.classList.remove('has-value');

  if (saveBtn) {
    saveBtn.disabled = true;
  }

  // Remove from storage
  await chrome.storage.local.remove(['geminiApiKey', 'geminiApiKeyStatus', 'geminiApiKeyValidatedAt']);

  // If there are other keys, promote the first one to DEFAULT
  if (activeKeys.length > 0) {
    const firstKey = activeKeys[0];
    
    // Set the first key as the new DEFAULT
    await chrome.storage.local.set({
      geminiApiKey: firstKey.key,
      geminiApiKeyStatus: 'active',
      geminiApiKeyValidatedAt: Date.now()
    });

    // Remove the promoted key from multi-keys array
    const updatedKeys = keys.filter(k => k.id !== firstKey.id);
    await chrome.storage.local.set({ geminiApiKeys: updatedKeys });

    // Update status
    updateApiStatus('active', 'Active');
    
    // Show informative message
    showToast('🔄', `"${firstKey.name || 'Key'}" is now your DEFAULT key`, 'success');
    console.log(`[API] Promoted "${firstKey.name}" to DEFAULT`);
    
    // Reload the input with the new default key
    apiKeyInput.value = firstKey.key;
    apiKeyInput.classList.add('has-value');
    if (saveBtn) {
      saveBtn.disabled = true; // Already saved
    }
  } else {
    // No other keys, just clear
    updateApiStatus('not-set', 'Not Set');
    showToast('🗑️', 'API key cleared', 'info');
    console.log('[API] API key cleared');
  }
}

// Handle Toggle API Key Visibility
function handleToggleApiKeyVisibility() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const eyeIcon = document.querySelector('.eye-icon');
  const eyeOffIcon = document.querySelector('.eye-off-icon');

  if (!apiKeyInput || !eyeIcon || !eyeOffIcon) return;

  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    eyeIcon.style.display = 'none';
    eyeOffIcon.style.display = 'block';
  } else {
    apiKeyInput.type = 'password';
    eyeIcon.style.display = 'block';
    eyeOffIcon.style.display = 'none';
  }
}

// Handle API Key Input Change
function handleApiKeyInputChange() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveBtn = document.getElementById('saveApiKeyBtn');

  if (!apiKeyInput || !saveBtn) return;

  const hasValue = apiKeyInput.value.trim().length > 0;
  saveBtn.disabled = !hasValue;

  if (hasValue) {
    apiKeyInput.classList.add('has-value');
  } else {
    apiKeyInput.classList.remove('has-value');
  }
}

// ============================================
// Multi API Key Management
// ============================================

// Load all API keys from storage
async function loadApiKeys() {
  try {
    const result = await chrome.storage.local.get(['geminiApiKeys']);
    return result.geminiApiKeys || [];
  } catch (error) {
    console.error('[API] Error loading API keys:', error);
    return [];
  }
}

// Save all API keys to storage
async function saveApiKeys(keys) {
  try {
    await chrome.storage.local.set({ geminiApiKeys: keys });
    console.log('[API] Saved', keys.length, 'API keys');
  } catch (error) {
    console.error('[API] Error saving API keys:', error);
  }
}

// Update multi-key status display
async function updateMultiKeyStatus() {
  const apiMultiStatus = document.getElementById('apiMultiStatus');
  const multiKeyCount = document.getElementById('multiKeyCount');

  if (!apiMultiStatus || !multiKeyCount) return;

  // Load multi-keys
  const keys = await loadApiKeys();
  const activeMultiKeys = keys.filter(k => k.active !== false);

  // Check primary key
  const primaryResult = await chrome.storage.local.get(['geminiApiKey']);
  const hasPrimaryKey = !!primaryResult.geminiApiKey;

  // Count total (primary + multi) - filter out duplicates
  let totalCount = hasPrimaryKey ? 1 : 0;

  // Add multi-keys that are not the same as primary
  activeMultiKeys.forEach(k => {
    if (k.key !== primaryResult.geminiApiKey) {
      totalCount++;
    }
  });

  if (totalCount > 0) {
    apiMultiStatus.style.display = 'flex';
    multiKeyCount.textContent = `${totalCount} Key${totalCount > 1 ? 's' : ''} Active`;
  } else {
    apiMultiStatus.style.display = 'none';
  }
}

// Generate unique ID for API key
function generateKeyId() {
  return 'key_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Mask API key for display
function maskApiKey(key) {
  if (!key || key.length < 10) return '***';
  return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

// Get status badge HTML
function getStatusBadge(status) {
  const statuses = {
    active: { text: '✅ Active', class: 'active' },
    error: { text: '❌ Error', class: 'error' },
    'rate-limited': { text: '⚠️ Rate Limited', class: 'rate-limited' },
    disabled: { text: '⏸️ Disabled', class: 'disabled' }
  };
  const s = statuses[status] || statuses.active;
  return `<span class="api-key-status-badge ${s.class}">${s.text}</span>`;
}

// Render API keys list in management panel
async function renderApiKeysList() {
  const apiKeysList = document.getElementById('apiKeysList');
  if (!apiKeysList) return;

  const keys = await loadApiKeys();

  // 🔑 Get primary key (DEFAULT)
  const primaryResult = await chrome.storage.local.get(['geminiApiKey']);
  const primaryKey = primaryResult.geminiApiKey;

  // Build all keys array (primary first, then multi-keys)
  let allKeys = [];

  // Add primary key as DEFAULT (if exists)
  if (primaryKey) {
    allKeys.push({
      id: 'default',
      name: 'DEFAULT',
      key: primaryKey,
      active: true,
      status: 'active',
      isDefault: true
    });
  }

  // Add multi-keys (filter out if same as primary)
  keys.forEach(k => {
    if (k.key !== primaryKey) {
      allKeys.push(k);
    }
  });

  if (allKeys.length === 0) {
    apiKeysList.innerHTML = `
      <div class="api-keys-empty">
        <div class="api-keys-empty-icon">🔑</div>
        <div>No API keys yet</div>
        <div style="font-size: 11px; margin-top: 4px; color: #aaa;">Add your first key below</div>
      </div>
    `;
    return;
  }

  apiKeysList.innerHTML = allKeys.map((keyData, index) => `
    <div class="api-key-card${keyData.isDefault ? ' default-key' : ''}" data-key-id="${escapeHtml(String(keyData.id || ''))}">
      <div class="api-key-card-header">
        <div class="api-key-name">
          <span class="api-key-name-icon">🔑</span>
          <span>${escapeHtml(keyData.name || `Key ${index + 1}`)}</span>
        </div>
        <div class="api-key-actions">
          ${keyData.isDefault ? '' : `
            <button class="api-key-action-btn edit" data-key-id="${escapeHtml(String(keyData.id || ''))}" data-key-name="${escapeHtml(keyData.name || '')}" title="Edit">✏️</button>
            <button class="api-key-action-btn delete" data-key-id="${escapeHtml(String(keyData.id || ''))}" title="Delete">🗑️</button>
          `}
        </div>
      </div>
      <div class="api-key-info">
        <span class="api-key-masked">${escapeHtml(maskApiKey(String(keyData.key || '')))}</span>
        ${getStatusBadge(keyData.status || 'active')}
      </div>
      ${keyData.lastError ? `<div style="font-size: 10px; color: #f44336; margin-top: 4px;">${escapeHtml(String(keyData.lastError))}</div>` : ''}
    </div>
  `).join('');

  // Add edit button listeners
  apiKeysList.querySelectorAll('.api-key-action-btn.edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyId = btn.dataset.keyId;
      const keyName = btn.dataset.keyName;
      handleEditApiKey(keyId, keyName);
    });
  });

  // Add delete button listeners
  apiKeysList.querySelectorAll('.api-key-action-btn.delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyId = btn.dataset.keyId;
      handleDeleteApiKey(keyId);
    });
  });
}

// Show API Management Panel
function showApiManagementPanel() {
  const panel = document.getElementById('apiManagementPanel');
  if (panel) {
    panel.style.display = 'block';
    panel.scrollTop = 0; // Scroll panel content to top
    window.scrollTo(0, 0); // Scroll window to top
    document.body.scrollTop = 0; // For Safari
    renderApiKeysList();
  }
}

// Hide API Management Panel
function hideApiManagementPanel() {
  const panel = document.getElementById('apiManagementPanel');
  const addKeyForm = document.getElementById('addKeyForm');
  if (panel) panel.style.display = 'none';
  if (addKeyForm) addKeyForm.style.display = 'none';
}

// Currently editing key ID (null if adding new)
let editingKeyId = null;

// Show Add/Edit Key Form
function showAddKeyForm(keyData = null) {
  const addKeyForm = document.getElementById('addKeyForm');
  const addKeyBtn = document.getElementById('addApiKeyBtn');
  const keyNameInput = document.getElementById('keyNameInput');
  const keyValueInput = document.getElementById('keyValueInput');
  const formTitle = document.getElementById('addKeyFormTitle');

  // Set edit mode
  editingKeyId = keyData ? keyData.id : null;

  if (addKeyForm) {
    addKeyForm.style.display = 'block';

    // Update title based on mode
    if (formTitle) {
      formTitle.textContent = keyData ? 'Edit Key' : 'Add New Key';
    }

    if (keyNameInput) {
      keyNameInput.value = keyData ? keyData.name || '' : '';
      keyNameInput.focus();
    }
    if (keyValueInput) {
      keyValueInput.value = keyData ? keyData.key || '' : '';
    }
  }
  if (addKeyBtn) addKeyBtn.style.display = 'none';
}

// Hide Add/Edit Key Form
function hideAddKeyForm() {
  const addKeyForm = document.getElementById('addKeyForm');
  const addKeyBtn = document.getElementById('addApiKeyBtn');
  const formTitle = document.getElementById('addKeyFormTitle');

  if (addKeyForm) addKeyForm.style.display = 'none';
  if (addKeyBtn) addKeyBtn.style.display = 'flex';
  if (formTitle) formTitle.textContent = 'Add New Key';

  // Reset edit mode
  editingKeyId = null;
}

// Handle Add/Edit API Key (save key)
async function handleAddNewApiKey() {
  const keyNameInput = document.getElementById('keyNameInput');
  const keyValueInput = document.getElementById('keyValueInput');
  const addKeySaveBtn = document.getElementById('addKeySaveBtn');

  if (!keyNameInput || !keyValueInput) return;

  const name = keyNameInput.value.trim();
  const key = keyValueInput.value.trim();

  if (!name) {
    showToast('⚠️', 'Please enter a key name', 'error');
    keyNameInput.focus();
    return;
  }

  if (!key) {
    showToast('⚠️', 'Please enter an API key', 'error');
    keyValueInput.focus();
    return;
  }

  // Disable button and show loading
  if (addKeySaveBtn) {
    addKeySaveBtn.disabled = true;
    addKeySaveBtn.textContent = 'Testing...';
  }

  // Load existing keys
  const keys = await loadApiKeys();

  // Check if we're in edit mode
  const isEditMode = editingKeyId !== null;
  const existingKeyIndex = isEditMode ? keys.findIndex(k => k.id === editingKeyId) : -1;

  // Get the current key value for comparison (in edit mode, skip duplicate check if key unchanged)
  const currentKeyValue = isEditMode && existingKeyIndex !== -1 ? keys[existingKeyIndex].key : null;
  const isKeyChanged = currentKeyValue !== key;

  // Only validate if key changed or adding new
  if (isKeyChanged) {
    // Validate API key
    const result = await validateGeminiApiKey(key);

    if (!result.valid) {
      showToast('❌', result.error || 'Invalid API key', 'error');
      if (addKeySaveBtn) {
        addKeySaveBtn.disabled = false;
        addKeySaveBtn.textContent = 'Save';
      }
      return;
    }

    // 🔒 Check for duplicates in multi-keys (skip current key in edit mode)
    const isDuplicateMulti = keys.some(k => k.key === key && k.id !== editingKeyId);
    if (isDuplicateMulti) {
      showToast('⚠️', 'This API key already exists', 'error');
      if (addKeySaveBtn) {
        addKeySaveBtn.disabled = false;
        addKeySaveBtn.textContent = 'Save';
      }
      return;
    }

    // 🔒 Check for duplicate with primary key
    const primaryResult = await chrome.storage.local.get(['geminiApiKey']);
    if (primaryResult.geminiApiKey && primaryResult.geminiApiKey === key) {
      showToast('⚠️', 'This key is already set as primary', 'error');
      if (addKeySaveBtn) {
        addKeySaveBtn.disabled = false;
        addKeySaveBtn.textContent = 'Save';
      }
      return;
    }
  }

  if (isEditMode && existingKeyIndex !== -1) {
    // Update existing key
    keys[existingKeyIndex].name = name;
    keys[existingKeyIndex].key = key;
    if (isKeyChanged) {
      keys[existingKeyIndex].status = 'active';
      keys[existingKeyIndex].lastError = null;
    }

    await saveApiKeys(keys);
    await updateMultiKeyStatus();
    await renderApiKeysList();
    hideAddKeyForm();
    showToast('✏️', 'API key updated!', 'success');
    console.log('[API] ✏️ API key updated:', name);
  } else {
    // Add new key
    keys.push({
      id: generateKeyId(),
      name: name,
      key: key,
      active: true,
      status: 'active',
      lastError: null,
      createdAt: Date.now()
    });

    await saveApiKeys(keys);
    await updateMultiKeyStatus();
    await renderApiKeysList();
    hideAddKeyForm();
    showToast('✅', 'API key added!', 'success');
    console.log('[API] ✅ New API key added:', name);
  }

  // Re-enable button
  if (addKeySaveBtn) {
    addKeySaveBtn.disabled = false;
    addKeySaveBtn.textContent = 'Save';
  }
}

// Handle Edit API Key - opens form with pre-filled data
async function handleEditApiKey(keyId) {
  const keys = await loadApiKeys();
  const keyData = keys.find(k => k.id === keyId);

  if (!keyData) {
    showToast('⚠️', 'Key not found', 'error');
    return;
  }

  // Open form with existing data
  showAddKeyForm(keyData);
}

// Handle Delete API Key
async function handleDeleteApiKey(keyId) {
  const confirmed = await showConfirmDialog(
    '🗑️',
    'Delete API Key',
    'Are you sure you want to delete this API key? This action cannot be undone.',
    'Delete',
    'Cancel'
  );
  if (!confirmed) return;

  const keys = await loadApiKeys();
  const filtered = keys.filter(k => k.id !== keyId);

  await saveApiKeys(filtered);
  await updateMultiKeyStatus();
  await renderApiKeysList();
  showToast('🗑️', 'API key deleted', 'info');
  console.log('[API] API key deleted:', keyId);
}


// Initialize popup
async function init() {
  initElements();
  renderExtensionVersion();
  setAuthBootstrapPending(true);
  await maybeShowBrowserSupportWarning();
  await syncPopupConsentUI();

  // 🔧 FIX: Load languages list early so renderPrompts() can display correct language names
  if (!window.LANGUAGES) {
    try {
      await import(chrome.runtime.getURL('utils/languagesList.js'));
    } catch (e) {
      console.warn('[Popup] Could not load languages list:', e);
    }
  }

  // Check if account was deleted from website - need to clean up popup's localStorage
  const cleanupCheck = await chrome.storage.local.get(['popupNeedsCleanup']);
  if (cleanupCheck.popupNeedsCleanup) {
    console.log('[Popup] Cleanup flag detected - clearing localStorage');
    localStorage.clear();
    await chrome.storage.local.remove(['popupNeedsCleanup']);
    // Show signed out UI
    updateUserUI(null);
    setAuthBootstrapPending(false);
    showToast('🗑️', 'Account deleted', 'deleted');
    return;
  }

  const initialUserHydrationPromise = (async () => {
    const result = await chrome.storage.sync.get(['user']);
    console.log('[Popup] 🔍 chrome.storage.sync.user:', result.user ? 'EXISTS' : 'NULL');

    if (result.user) {
      console.log('[Popup] ✅ Found cached user in chrome.storage.sync');
      updateUserUI(result.user);
      return result.user;
    }

    console.log('[Popup] 🔍 No cached user, calling getCurrentUser()...');
    const user = await getCurrentUser();
    console.log('[Popup] 🔍 getCurrentUser() returned:', user ? 'USER' : 'NULL');
    updateUserUI(user);
    return user;
  })().catch((error) => {
    console.error('[Popup] Initial user hydration failed:', error);
    updateUserUI(null);
    return null;
  }).finally(() => {
    setAuthBootstrapPending(false);
  });

  void initialUserHydrationPromise.then(async (user) => {
    if (!user) return;
    const refreshedByDirtyFlag = await maybeAutoRefreshSubscriptionStateDirty();
    if (refreshedByDirtyFlag) {
      const refreshedInfo = getSubscriptionInfo();
      if (refreshedInfo) {
        updateSubscriptionUI(refreshedInfo);
      }
    }
    await maybeAutoRefreshAfterPendingUpgrade();
  }).catch((error) => {
    console.warn('[Popup] Background subscription refresh failed:', error);
  });

  // Check if we should open API management panel (from error modal)
  const urlParams = new URLSearchParams(window.location.search);
  const apiMgmtCheck = await chrome.storage.local.get(['openApiManagementOnPopup']);
  if (apiMgmtCheck.openApiManagementOnPopup || urlParams.get('openApiManagement') === 'true') {
    console.log('[Popup] Opening API management panel from redirect');
    await chrome.storage.local.remove(['openApiManagementOnPopup']);
    // Delay to ensure DOM is ready
    setTimeout(() => {
      showApiManagementPanel();
      showAddKeyForm(); // Also open the add form directly
    }, 100);
  }

  // Still setup event listeners
  elements.googleSignIn?.addEventListener('click', handleSignIn);
  elements.browserSupportWarningClose?.addEventListener('click', handleBrowserSupportWarningDismiss);
  elements.signOutBtn?.addEventListener('click', handleSignOut);
  elements.upgradeBtn?.addEventListener('click', handleUpgrade);
  elements.manageBtn?.addEventListener('click', handleManageSubscription);
  elements.billingSettingsBtn?.addEventListener('click', handleBillingSettingsOpen);
  elements.billingSettingsBackBtn?.addEventListener('click', handleBillingSettingsClose);
  elements.billingUpdatePaymentMethodBtn?.addEventListener('click', handlePopupUpdatePaymentMethod);
  elements.billingChangePlanBtn?.addEventListener('click', handlePopupChangePlan);
  elements.billingCancelSubscriptionBtn?.addEventListener('click', handlePopupCancelSubscription);
  elements.billingRemovePaymentMethodBtn?.addEventListener('click', handlePopupRemovePaymentMethod);
  elements.billingDeleteAccountBtn?.addEventListener('click', handlePopupDeleteAccount);
  elements.helpBtn?.addEventListener('click', handleHelpOpen);
  elements.helpCloseBtn?.addEventListener('click', handleHelpClose);
  elements.troubleshootingToggleBtn?.addEventListener('click', handleTroubleshootingToggle);
  elements.diagnosticsStartBtn?.addEventListener('click', handleDiagnosticsStart);
  elements.diagnosticsAnalyzeBtn?.addEventListener('click', handleDiagnosticsAnalyze);
  elements.diagnosticsCopyBtn?.addEventListener('click', handleDiagnosticsCopy);
  elements.diagnosticsClearBtn?.addEventListener('click', handleDiagnosticsClear);
  elements.diagnosticsSupportTicketLink?.addEventListener('click', handleOpenSupportTickets);
  elements.helpSupportTicketLink?.addEventListener('click', handleOpenSupportTickets);
  const activeDiagnosticsState = await getActiveDiagnosticsState();
  await syncTroubleshootingExpandedState(!!activeDiagnosticsState);
  await syncDiagnosticsUiFromStorage(activeDiagnosticsState);
  elements.planInfoBtn?.addEventListener('click', handlePlanInfoToggle);
  elements.planInfoTooltip?.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', handleDocumentClick);
  document.querySelector('.faq-list')?.addEventListener('click', handleFaqClick);
  document.getElementById('faqUpgradeLink')?.addEventListener('click', handleFaqUpgradeClick);

  // API Management listeners
  document.getElementById('apiManageBtn')?.addEventListener('click', showApiManagementPanel);
  document.getElementById('apiManagementCloseBtn')?.addEventListener('click', hideApiManagementPanel);
  document.getElementById('addApiKeyBtn')?.addEventListener('click', showAddKeyForm);
  document.getElementById('addKeyFormCloseBtn')?.addEventListener('click', hideAddKeyForm);
  document.getElementById('addKeyCancelBtn')?.addEventListener('click', hideAddKeyForm);
  document.getElementById('addKeySaveBtn')?.addEventListener('click', handleAddNewApiKey);

  // Refresh button listener
  document.getElementById('refreshBtn')?.addEventListener('click', handleRefresh);

  // API Key event listeners (main input)
  document.getElementById('apiKeyInput')?.addEventListener('input', handleApiKeyInputChange);
  document.getElementById('saveApiKeyBtn')?.addEventListener('click', handleSaveApiKey);
  document.getElementById('clearApiKeyBtn')?.addEventListener('click', handleClearApiKey);
  document.getElementById('toggleApiKeyBtn')?.addEventListener('click', handleToggleApiKeyVisibility);
  document.getElementById('apiSectionToggleBtn')?.addEventListener('click', handleGeminiApiSectionToggle);
  document.getElementById('watchApiTutorialBtn')?.addEventListener('click', handleWatchApiTutorial);
  await initGeminiApiSectionCollapse();
  await cleanupRemovedGeminiGuideChatStorage();

  // Load saved API key
  await loadApiKey();

  // Update multi-key status
  await updateMultiKeyStatus();

  // Toggle visibility for Add Key Form
  const toggleKeyValueBtn = document.getElementById('toggleKeyValueBtn');
  if (toggleKeyValueBtn) {
    toggleKeyValueBtn.addEventListener('click', () => {
      const keyValueInput = document.getElementById('keyValueInput');
      const eyeIcon = toggleKeyValueBtn.querySelector('.eye-icon');
      const eyeOffIcon = toggleKeyValueBtn.querySelector('.eye-off-icon');

      if (keyValueInput) {
        const isPassword = keyValueInput.type === 'password';
        keyValueInput.type = isPassword ? 'text' : 'password';

        if (eyeIcon && eyeOffIcon) {
          eyeIcon.style.display = isPassword ? 'none' : 'block';
          eyeOffIcon.style.display = isPassword ? 'block' : 'none';
        }
      }
    });
  }

  // Custom Prompts event listeners
  const addPromptBtn = document.getElementById('addPromptBtn');
  const formCloseBtn = document.getElementById('formCloseBtn');
  const formCancelBtn = document.getElementById('formCancelBtn');
  const formSaveBtn = document.getElementById('formSaveBtn');
  const transcriptBasedCheckbox = document.getElementById('promptTranscriptBasedCheckbox');
  const videoAnalysisCheckbox = document.getElementById('promptVideoAnalysisCheckbox');
  const videoResolutionGroup = document.getElementById('videoResolutionGroup');
  const promptDisclaimerCheckbox = document.getElementById('promptDisclaimerCheckbox');
  const expandAllPromptsBtn = document.getElementById('expandAllPromptsBtn');
  const minimizeAllPromptsBtn = document.getElementById('minimizeAllPromptsBtn');

  if (addPromptBtn) {
    addPromptBtn.addEventListener('click', async () => {
      if (!(await ensurePromptDisclaimerAccepted())) return;
      showPromptForm();
    });
  }

  if (promptDisclaimerCheckbox) {
    promptDisclaimerCheckbox.addEventListener('change', async (e) => {
      await handlePromptDisclaimerToggle(e.target.checked);
    });
  }

  if (expandAllPromptsBtn) {
    expandAllPromptsBtn.addEventListener('click', async () => {
      if (!(await ensurePromptDisclaimerAccepted())) return;
      await setAllPromptsCollapsed(false);
    });
  }

  if (minimizeAllPromptsBtn) {
    minimizeAllPromptsBtn.addEventListener('click', async () => {
      if (!(await ensurePromptDisclaimerAccepted())) return;
      await setAllPromptsCollapsed(true);
    });
  }

  if (formCloseBtn) {
    formCloseBtn.addEventListener('click', hidePromptForm);
  }

  if (formCancelBtn) {
    formCancelBtn.addEventListener('click', hidePromptForm);
  }

  if (formSaveBtn) {
    formSaveBtn.addEventListener('click', handleSavePrompt);
  }

  // Mutually exclusive: transcript-based mode OR video analysis mode
  const syncPromptInputModes = (changedBy = null) => {
    if (!transcriptBasedCheckbox || !videoAnalysisCheckbox || !videoResolutionGroup) return;

    if (changedBy === 'transcript' && transcriptBasedCheckbox.checked) {
      videoAnalysisCheckbox.checked = false;
    } else if (changedBy === 'video' && videoAnalysisCheckbox.checked) {
      transcriptBasedCheckbox.checked = false;
    } else if (transcriptBasedCheckbox.checked && videoAnalysisCheckbox.checked) {
      videoAnalysisCheckbox.checked = false;
    }

    videoResolutionGroup.style.display = videoAnalysisCheckbox.checked ? 'block' : 'none';
  };

  if (transcriptBasedCheckbox && videoAnalysisCheckbox && videoResolutionGroup) {
    transcriptBasedCheckbox.addEventListener('change', () => syncPromptInputModes('transcript'));
    videoAnalysisCheckbox.addEventListener('change', () => syncPromptInputModes('video'));
    syncPromptInputModes();
  }

  // Load and render prompts
  await renderPrompts();

  await initialUserHydrationPromise;
}

// ============================================
// Language Selector for Translation
// ============================================

async function showLanguageSelector(targetElement, currentLangCode, type = 'primary') {
  // Load languages list
  if (!window.LANGUAGES) {
    await import(chrome.runtime.getURL('utils/languagesList.js'));
  }

  // Remove existing dropdown if any
  const existingDropdown = document.querySelector('.language-dropdown-popup');
  if (existingDropdown) existingDropdown.remove();

  // Create dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'language-dropdown-popup';
  dropdown.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 8px;
    z-index: 10000;
    max-height: 300px;
    width: 250px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  `;

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '🔍 Search language...';
  searchInput.style.cssText = `
    width: 100%;
    padding: 8px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: white;
    font-size: 13px;
    margin-bottom: 8px;
    box-sizing: border-box;
  `;

  // Languages list container
  const listContainer = document.createElement('div');
  listContainer.style.cssText = `
    overflow-y: auto;
    max-height: 250px;
  `;

  // Render languages
  function renderLanguages(query = '') {
    const languages = window.searchLanguages ? window.searchLanguages(query) : window.LANGUAGES;
    listContainer.innerHTML = '';

    languages.forEach(lang => {
      const item = document.createElement('div');
      item.className = 'language-item';
      item.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
        color: ${lang.code === currentLangCode ? '#667eea' : '#fff'};
        background: ${lang.code === currentLangCode ? 'rgba(102, 126, 234, 0.1)' : 'transparent'};
      `;
      item.textContent = `${lang.code === currentLangCode ? '✓ ' : ''}${lang.name} (${lang.nativeName})`;

      item.addEventListener('mouseenter', () => {
        if (lang.code !== currentLangCode) {
          item.style.background = 'rgba(255,255,255,0.1)';
        }
      });

      item.addEventListener('mouseleave', () => {
        if (lang.code !== currentLangCode) {
          item.style.background = 'transparent';
        }
      });

      item.addEventListener('click', async () => {
        if (type === 'aboutSong') {
          await chrome.storage.local.set({ [ABOUT_SONG_LANGUAGE_KEY]: lang.code });
          console.log('[AboutSong] Selected answer language:', lang.name, lang.code);
          dropdown.remove();
          await renderPrompts();
          return;
        }

        // Validation: Secondary language cannot be same as primary
        if (type === 'secondary') {
          const primaryResult = await chrome.storage.local.get(['translationLanguage']);
          const primaryLang = primaryResult.translationLanguage || 'he';

          if (lang.code === primaryLang) {
            // Show error message inside popup
            showPopupError('Secondary language must be different from primary language');
            return; // Don't save
          }
        }

        // Save selected language based on type
        if (type === 'secondary') {
          await chrome.storage.local.set({ translationSecondaryLanguage: lang.code });
          console.log('[Translation] Selected secondary language:', lang.name, lang.code);
        } else {
          // Validation: If changing primary, check if it's same as secondary
          const secondaryResult = await chrome.storage.local.get(['translationSecondaryLanguage']);
          const secondaryLang = secondaryResult.translationSecondaryLanguage;

          if (secondaryLang && lang.code === secondaryLang) {
            // Auto-remove secondary language
            await chrome.storage.local.set({ translationSecondaryLanguage: null });
            console.log('[Translation] Auto-removed secondary language (same as new primary)');
          }

          await chrome.storage.local.set({ translationLanguage: lang.code });
          console.log('[Translation] Selected primary language:', lang.name, lang.code);

          // Update button text (targetElement is the boxed button)
          if (targetElement.tagName !== 'BUTTON') {
            targetElement.textContent = `${lang.name} (${lang.nativeName}) ▼`;
          }
        }

        // Close dropdown
        dropdown.remove();

        // Re-render prompts to update selection
        await renderPrompts();
        await renderPrompts();
      });

      listContainer.appendChild(item);
    });
  }

  // Initial render
  renderLanguages();

  // Search handler
  searchInput.addEventListener('input', (e) => {
    renderLanguages(e.target.value);
  });

  // Assemble dropdown
  dropdown.appendChild(searchInput);
  dropdown.appendChild(listContainer);

  // Append to body (centered via CSS - no manual positioning needed)
  document.body.appendChild(dropdown);

  // Focus search input
  searchInput.focus();

  // Close on click outside
  const closeHandler = (e) => {
    if (!dropdown.contains(e.target) && e.target !== targetElement) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closeHandler);
  }, 100);
}

// Run when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await init();
    await maybeStartPopupTourFromPending();
    maybeHighlightUpgradeButtonFromFlag();
    maybeHighlightSignInButtonFromFlag();
    maybeHighlightPromptDisclaimerFromFlag();
  } catch (error) {
    console.error('[Popup] Init failed:', error);
    setAuthBootstrapPending(false);
  }

  // Check for highlight flag and animate API input
  chrome.storage.local.get(['highlightGeminiInput'], (result) => {
    if (result.highlightGeminiInput) {
      console.log('[Popup] Highlight flag detected, animating API input');

      // Wait a bit for elements to be fully rendered
      setTimeout(() => {
        // Ensure Gemini API section is visible before focusing/highlighting input
        applyGeminiApiSectionCollapsedState(false);
        chrome.storage.local.set({ [GEMINI_API_SECTION_COLLAPSED_KEY]: false });

        const apiInput = document.getElementById('apiKeyInput');
        if (apiInput) {
          // Add shake animation
          apiInput.classList.add('shake-highlight');

          // Focus on input
          apiInput.focus();

          // Remove animation after it completes
          setTimeout(() => {
            apiInput.classList.remove('shake-highlight');
          }, 1000);
        }

        // Clear the flag
        chrome.storage.local.remove(['highlightGeminiInput']);
      }, 300);
    }
  });
});

// Manual Refresh button handler
async function handleRefresh() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (!refreshBtn) return;

  // Show loading state
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');

  try {
    // Get current JWT
    const currentJwt = localStorage.getItem('youchords_jwt');
    if (!currentJwt) {
      showToast('⚠️', 'Please sign in first', 'error');
      return;
    }

    // Call refreshJWT endpoint
    const idResult = await chrome.storage.local.get(['youchords_device_id', 'youchords_device_fingerprint']);
    const response = await fetch(`${API_BASE_URL}/refreshJWT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentJwt}`
      },
      body: JSON.stringify({
        deviceId: idResult?.youchords_device_id || null,
        fingerprint: idResult?.youchords_device_fingerprint || null
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.jwt) {
        // Update JWT in storage (triggers Silent Sync)
        await chrome.storage.local.set({ youchords_jwt: data.jwt });
        localStorage.setItem('youchords_jwt', data.jwt);

        // Update UI
        const subInfo = getSubscriptionInfo();
        if (subInfo) {
          updateSubscriptionUI(subInfo);
        }

        showToast('✅', 'Subscription refreshed!', 'success');
      } else {
        showToast('❌', 'Failed to refresh', 'error');
      }
    } else {
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
          : null);

      if (errorData?.needsRelogin || response.status === 401) {
        showToast('⚠️', 'Session expired. Please sign in again.', 'error');
        return;
      }

      if (errorData?.rateLimited || response.status === 429) {
        const message = retryAfterSec
          ? `Too many refresh attempts. Please try again in ${retryAfterSec}s.`
          : 'Too many refresh attempts. Please wait and try again.';
        showToast('⏳', message, 'error');
        return;
      }

      if (errorData?.blocked) {
        await chrome.storage.local.set({
          youchords_account_blocked_state: {
            blocked: true,
            reason: errorData.blockedReason || errorData.error || 'payment dispute',
            at: new Date().toISOString()
          }
        });

        updateSubscriptionUI({
          plan: 'free',
          blocked: true,
          blockedReason: errorData.blockedReason || errorData.error || 'payment dispute'
        });
        showToast('⛔', 'Account is suspended', 'error');
      } else {
        const serverMessage = typeof errorData?.error === 'string' && errorData.error.trim()
          ? errorData.error.trim()
          : `Server error (${response.status})`;
        showToast('❌', serverMessage, 'error');
      }
    }
  } catch (error) {
    console.error('[Popup] Refresh error:', error);
    showToast('❌', 'Refresh failed. Check your connection and try again.', 'error');
  } finally {
    // Remove loading state
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}

// Silent Sync: Listen for JWT changes from background.js
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes[HIGHLIGHT_PROMPT_DISCLAIMER_KEY]?.newValue === true) {
    maybeHighlightPromptDisclaimerFromFlag();
  }

  if (namespace === 'local' && changes.youchords_jwt) {
    const newJwt = changes.youchords_jwt.newValue;
    const oldJwt = changes.youchords_jwt.oldValue;
    console.log('[Popup] JWT changed via Silent Sync');

    if (newJwt) {
      // Update localStorage for compatibility
      localStorage.setItem('youchords_jwt', newJwt);

      // Update UI with new subscription info
      const subInfo = getSubscriptionInfo();
      if (subInfo) {
        updateSubscriptionUI(subInfo);

        // Determine what kind of change this is
        if (!oldJwt) {
          // First sign in - no toast needed (handled by sign in flow)
        } else {
          // Compare old and new plans
          try {
            const oldPayload = JSON.parse(atob(oldJwt.split('.')[1]));
            const newPayload = JSON.parse(atob(newJwt.split('.')[1]));

            if (oldPayload.plan !== newPayload.plan) {
              // Plan changed - this is an upgrade/downgrade
              if (newPayload.plan !== 'free') {
                showToast('🎉', 'Subscription updated!', 'success');
              } else {
                showToast('📋', 'Plan changed to Free', 'info');
              }
            }
            // If plan is the same, it's just a refresh - no toast needed
          } catch (e) {
            console.error('Error comparing JWTs:', e);
          }
        }
      }
    } else {
      // JWT was removed (logout/account deleted)
      localStorage.removeItem('youchords_jwt');
      updateUserUI(null);
      showToast('👋', 'Signed out', 'info');
    }
  }
});


// ═══════════════════════════════════════════════════════════
// API Concurrency Dropdown
// ═══════════════════════════════════════════════════════════

const concurrencyDropdownBtn = document.getElementById('concurrencyDropdownBtn');
const concurrencyDropdownMenu = document.getElementById('concurrencyDropdownMenu');
const concurrencyOptions = document.querySelectorAll('.concurrency-option');

// Concurrency mode data
const concurrencyModes = {
  conservative: {
    icon: '🐢',
    text: 'Conservative (1 request)',
    value: 'conservative'
  },
  balanced: {
    icon: '⚡',
    text: 'Balanced (2 requests)',
    value: 'balanced'
  },
  aggressive: {
    icon: '🚀',
    text: 'Aggressive (3 requests)',
    value: 'aggressive'
  }
};

// Load saved concurrency mode
chrome.storage.local.get(['geminiConcurrencyMode'], (result) => {
  const mode = result.geminiConcurrencyMode || 'balanced';
  updateConcurrencyButton(mode);
  updateSelectedOption(mode);
});

// Toggle dropdown
concurrencyDropdownBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = concurrencyDropdownMenu.style.display === 'block';

  if (isOpen) {
    concurrencyDropdownMenu.style.display = 'none';
    concurrencyDropdownBtn.classList.remove('open');
  } else {
    concurrencyDropdownMenu.style.display = 'block';
    concurrencyDropdownBtn.classList.add('open');
  }
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!concurrencyDropdownBtn.contains(e.target) && !concurrencyDropdownMenu.contains(e.target)) {
    concurrencyDropdownMenu.style.display = 'none';
    concurrencyDropdownBtn.classList.remove('open');
  }
});

// Handle option selection
concurrencyOptions.forEach(option => {
  option.addEventListener('click', () => {
    const value = option.getAttribute('data-value');

    // Save to storage
    chrome.storage.local.set({ geminiConcurrencyMode: value }, () => {
      console.log('[Popup] Concurrency mode saved:', value);
    });

    // Update UI
    updateConcurrencyButton(value);
    updateSelectedOption(value);

    // Close dropdown
    concurrencyDropdownMenu.style.display = 'none';
    concurrencyDropdownBtn.classList.remove('open');
  });
});

function updateConcurrencyButton(mode) {
  const modeData = concurrencyModes[mode];
  if (modeData) {
    document.querySelector('.concurrency-current-icon').textContent = modeData.icon;
    document.querySelector('.concurrency-current-text').textContent = modeData.text;
  }
}

function updateSelectedOption(mode) {
  concurrencyOptions.forEach(option => {
    if (option.getAttribute('data-value') === mode) {
      option.classList.add('selected');
    } else {
      option.classList.remove('selected');
    }
  });
}


// ═══════════════════════════════════════════════════════════
// Popup Error Message (stays inside popup)
// ═══════════════════════════════════════════════════════════

function showPopupError(message) {
  // Remove existing error if any
  const existingError = document.querySelector('.popup-error-message');
  if (existingError) existingError.remove();

  // Create error message
  const errorDiv = document.createElement('div');
  errorDiv.className = 'popup-error-message';
  errorDiv.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: linear-gradient(135deg, #ff4444 0%, #cc0000 100%);
    color: white;
    padding: 16px 20px;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(255, 68, 68, 0.4);
    z-index: 10001;
    max-width: 220px;
    text-align: center;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.4;
    animation: popupErrorSlideIn 0.3s ease-out;
  `;

  const iconDiv = document.createElement('div');
  iconDiv.style.fontSize = '24px';
  iconDiv.style.marginBottom = '8px';
  iconDiv.textContent = '⚠️';

  const messageDiv = document.createElement('div');
  messageDiv.textContent = String(message || '');

  errorDiv.appendChild(iconDiv);
  errorDiv.appendChild(messageDiv);

  // Add animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes popupErrorSlideIn {
      from {
        opacity: 0;
        transform: translate(-50%, -50%) scale(0.8);
      }
      to {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
    }
    @keyframes popupErrorSlideOut {
      from {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      to {
        opacity: 0;
        transform: translate(-50%, -50%) scale(0.8);
      }
    }
  `;

  if (!document.getElementById('popup-error-styles')) {
    style.id = 'popup-error-styles';
    document.head.appendChild(style);
  }

  document.body.appendChild(errorDiv);

  // Auto remove after 2.5 seconds
  setTimeout(() => {
    errorDiv.style.animation = 'popupErrorSlideOut 0.3s ease-out';
    setTimeout(() => errorDiv.remove(), 300);
  }, 2500);

  // Click to dismiss
  errorDiv.addEventListener('click', () => {
    errorDiv.style.animation = 'popupErrorSlideOut 0.3s ease-out';
    setTimeout(() => errorDiv.remove(), 300);
  });
}
