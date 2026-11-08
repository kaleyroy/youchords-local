/* yc-module-scope */
(function () {
/**
 * Video Validator Module - YouChords (2025-05-full)
 * ------------------------------------------------
 * • בודק אם סרטון YouTube מכיל תוכן מוזיקלי
 * • בודק אם יש כתוביות ואקורדים ב-IndexedDB
 * • API מצומצם: validateVideo, checkChordsInIndexedDB, checkSubtitlesInIndexedDB
 */

// =============== פונקציות פנימיות ===============

const MIN_VIDEO_DURATION_SECONDS = 15;
const MAX_VIDEO_DURATION_SECONDS = 35 * 60;
const FREE_PROCESSING_MAX_VIDEO_DURATION_SECONDS = 6 * 60;
const VIDEO_DURATION_ERROR_MESSAGE =
  "Only videos between 15 seconds and 35 minutes are supported";
const MUSIC_VIDEO_DURATION_ERROR_MESSAGE =
  "Only music videos between 15 seconds and 35 minutes are supported";
const FREE_PROCESSING_DURATION_ERROR_MESSAGE =
  "Free users can process music videos up to 6 minutes. Upgrade to a paid plan for songs up to 35 minutes.";
const FREE_PROCESSING_DURATION_CODE = 'free_duration_limit';
const MAX_PROCESSING_DURATION_CODE = 'max_duration_limit';
const MANUAL_MUSIC_RETRY_MESSAGE =
  "If this is actually a song, press Like once. If it's already liked, turn Like off and on once, then try again.\n\nNote: The Like only helps verify the song. You can remove it afterward if you want.";
const MANUAL_MUSIC_RETRY_TOAST_MS = 10000;
const AMBIGUOUS_MUSIC_CATEGORIES = new Set([
  "people & blogs",
  "entertainment",
  "film & animation"
]);
const BLOCKED_NON_MUSIC_CATEGORIES = new Set([
  "gaming",
  "sports",
  "news",
  "news & politics",
  "science & technology",
  "education",
  "autos & vehicles",
  "travel & events",
  "howto & style",
  "pets & animals",
  "comedy"
]);

function normalizePlanForDuration(plan) {
  const value = String(plan || '').trim().toLowerCase();
  return ['basic', 'starter', 'pro'].includes(value) ? 'pro' : 'free';
}

function decodeYcJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch (error) {
    if (window.DEBUG) console.warn('[VideoValidator] Failed to decode JWT payload:', error);
    return null;
  }
}

async function getPlanForProcessingDuration(options = {}) {
  if (options.plan) return normalizePlanForDuration(options.plan);

  try {
    const subInfo = window.ycAuth?.getSubscriptionInfo?.();
    if (subInfo?.plan) return normalizePlanForDuration(subInfo.plan);
  } catch (error) {
    if (window.DEBUG) console.warn('[VideoValidator] Failed to read ycAuth plan:', error);
  }

  try {
    const cachedJwt = window.__ycGetCachedJwt?.();
    const cachedPayload = decodeYcJwtPayload(cachedJwt);
    if (cachedPayload?.plan) return normalizePlanForDuration(cachedPayload.plan);
  } catch (error) {
    if (window.DEBUG) console.warn('[VideoValidator] Failed to read cached JWT plan:', error);
  }

  try {
    const asyncJwt = await window.__ycGetJwtAsync?.();
    const asyncPayload = decodeYcJwtPayload(asyncJwt);
    if (asyncPayload?.plan) return normalizePlanForDuration(asyncPayload.plan);
  } catch (error) {
    if (window.DEBUG) console.warn('[VideoValidator] Failed to read async JWT plan:', error);
  }

  return 'free';
}

function getDurationValidationFailure(seconds, options = {}, plan = 'free') {
  const durationSeconds = Number(seconds);
  if (!Number.isFinite(durationSeconds)) return null;

  const enforceProcessingDurationLimit = shouldEnforceProcessingDurationLimit(options);
  const allowLongVideo = options.allowLongVideo === true && !enforceProcessingDurationLimit;

  if (durationSeconds < MIN_VIDEO_DURATION_SECONDS) {
    return VIDEO_DURATION_ERROR_MESSAGE;
  }

  if (!allowLongVideo && durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    return {
      message: VIDEO_DURATION_ERROR_MESSAGE,
      validationCode: MAX_PROCESSING_DURATION_CODE,
      unsupportedDuration: true
    };
  }

  if (
    enforceProcessingDurationLimit &&
    normalizePlanForDuration(plan) === 'free' &&
    durationSeconds > FREE_PROCESSING_MAX_VIDEO_DURATION_SECONDS
  ) {
    return {
      message: FREE_PROCESSING_DURATION_ERROR_MESSAGE,
      validationCode: FREE_PROCESSING_DURATION_CODE,
      upgradeRequired: true
    };
  }

  return null;
}

function buildDurationValidationFailureResult(durationFailure, videoId, durationSeconds) {
  const failure = typeof durationFailure === 'string'
    ? { message: durationFailure }
    : { ...(durationFailure || {}) };

  return {
    isValid: false,
    message: failure.message || VIDEO_DURATION_ERROR_MESSAGE,
    videoId,
    durationSeconds,
    validationCode: failure.validationCode || 'duration_limit',
    upgradeRequired: failure.upgradeRequired === true,
    unsupportedDuration: failure.unsupportedDuration === true
  };
}

function shouldEnforceProcessingDurationLimit(options = {}) {
  return options.durationContext === 'processing' ||
    options.enforceProcessingDurationLimit === true;
}

function getManualMusicRetryState() {
  if (!window.ycManualMusicRetryState) {
    window.ycManualMusicRetryState = {
      videoId: null,
      shown: false
    };
  }

  return window.ycManualMusicRetryState;
}

function hasManualMusicRetryBeenShown(videoId) {
  const state = getManualMusicRetryState();
  return state.videoId === videoId && state.shown === true;
}

function markManualMusicRetryShown(videoId) {
  const state = getManualMusicRetryState();
  state.videoId = videoId;
  state.shown = true;
}

function isAmbiguousMusicCategory(category) {
  if (!category) return false;
  return AMBIGUOUS_MUSIC_CATEGORIES.has(String(category).toLowerCase());
}

function getLikeSignalSnapshot() {
  const host =
    document.querySelector("like-button-view-model lottie-component") ||
    document.querySelector("like-button-renderer lottie-component") ||
    document.querySelector(
      "ytd-menu-renderer like-button-view-model lottie-component"
    );

  const likeButton =
    document.querySelector("like-button-view-model button[aria-pressed]") ||
    document.querySelector("like-button-renderer button[aria-pressed]") ||
    document.querySelector(
      "like-button-view-model [role='button'][aria-pressed]"
    ) ||
    document.querySelector(
      "like-button-renderer [role='button'][aria-pressed]"
    );

  const snapshot = {
    likeButtonFound: !!likeButton,
    likeSvgFound: false,
    liked: String(likeButton?.getAttribute("aria-pressed") || "").toLowerCase() === "true",
    clipPathCount: null,
    likeHiddenColoredGroups: 0
  };

  if (!host) {
    return snapshot;
  }

  const root = host.shadowRoot || host;
  const svg = root.querySelector("svg") || host.querySelector("svg");
  if (!svg) {
    return snapshot;
  }

  snapshot.likeSvgFound = true;
  snapshot.clipPathCount = svg.querySelectorAll("clipPath").length;

  const normalizeColor = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");

  const isInterestingColor = (value) => {
    const color = normalizeColor(value);
    if (!color) return false;
    if (
      color === "none" ||
      color === "transparent" ||
      color === "rgba(0,0,0,0)"
    ) {
      return false;
    }
    if (
      color === "white" ||
      color === "#fff" ||
      color === "#ffffff" ||
      color === "rgb(255,255,255)" ||
      color === "rgba(255,255,255,1)"
    ) {
      return false;
    }
    return true;
  };

  const isHiddenNode = (element) => {
    for (let node = element; node && node !== svg; node = node.parentElement) {
      const styleAttr = String(node.getAttribute("style") || "").toLowerCase();
      const displayAttr = String(node.getAttribute("display") || "").toLowerCase();
      const opacityAttr = String(node.getAttribute("opacity") || "").toLowerCase();

      if (
        styleAttr.includes("display: none") ||
        displayAttr === "none" ||
        opacityAttr === "0"
      ) {
        return true;
      }
    }
    return false;
  };

  snapshot.likeHiddenColoredGroups = [...svg.querySelectorAll("g")].filter((group) => {
    if (!isHiddenNode(group)) return false;

    const paths = [...group.querySelectorAll("path")];
    if (paths.length < 2) return false;

    const colors = paths.flatMap((path) => [
      normalizeColor(path.getAttribute("fill")),
      normalizeColor(path.getAttribute("stroke"))
    ]);

    return colors.some(isInterestingColor);
  }).length;

  return snapshot;
}

function getManualLikeMusicOverride() {
  const signals = getLikeSignalSnapshot();
  const matched = Boolean(
    signals.liked &&
      signals.clipPathCount === 2 &&
      signals.likeHiddenColoredGroups === 4
  );

  return { matched, signals };
}

/**
 * Function to format duration in seconds to a readable string
 * @param {number} seconds - duration in seconds
 * @return {string} - formatted string
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds} seconds`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes} minutes, ${secs} seconds`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours} hours, ${minutes} minutes, ${secs} seconds`;
  }
}

/**
 * פונקציה לקבלת משך הזמן של סרטון YouTube
 * @param {string} videoId - מזהה הסרטון
 * @return {Promise<Object>} - אובייקט עם משך הזמן בשניות ובפורמט קריא
 */
async function getVideoDuration(videoId) {
  try {
    const url = "https://www.youtube.com/youtubei/v1/player";

    const headers = {
      "Content-Type": "application/json"
    };

    const payload = {
      "context": {
        "client": {
          "clientName": "WEB",
          "clientVersion": "2.20260120.01.00",
          "hl": "en",
          "gl": "US"
        }
      },
      "videoId": videoId
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();

      // מנסה לקבל משך זמן מ-videoDetails
      if (data.videoDetails && data.videoDetails.lengthSeconds) {
        const seconds = parseInt(data.videoDetails.lengthSeconds);
        const formattedDuration = formatDuration(seconds);
        return { seconds, formattedDuration };
      }
    }

    return { seconds: null, formattedDuration: "Unknown" };
  } catch (error) {
    console.error("Error getting video duration:", error);
    return { seconds: null, formattedDuration: "Error" };
  }
}

/**
 * פונקציה לבדיקה האם הסרטון מכיל תוכן מוזיקלי
 * מבוסס על deep_scan_for_music_icon מהקוד המקורי
 * @param {string} videoId - מזהה הסרטון
 * @return {Promise<Object>} - אובייקט עם תוצאות הבדיקה
 */
async function isMusicVideo(videoId) {
  try {
    // ========== שלב 0: בדיקת Music Badge ב-DOM (5ms) ==========
    console.log('[isMusicVideo] ⚡ Step 0: Quick Music Badge check...');

    let blockedCategorySignal = null;
    let detectedCategory = null;
    let manualRetryEligible = false;
    try {
      const allBadges = document.querySelectorAll('.yt-spec-touch-feedback-shape__fill');

      for (const badge of allBadges) {
        const parent = badge.closest('a, button, [role="button"]');
        const text = parent?.textContent?.trim() || '';

        // בדוק אם זה בדיוק "Music" ובתוך אזור המידע
        if (text.toLowerCase() === 'music') {
          const isInDescription = parent?.closest('#description, ytd-watch-metadata, #info-container');

          if (isInDescription) {
            console.log('[isMusicVideo] ✅ Music badge found in DOM - IT\'S MUSIC! (5ms)');
            return { isMusic: true, category: "Music (DOM - Badge)" };
          }
        }
      }
      console.log('[isMusicVideo] ⚠️ No Music badge in DOM - checking category API...');
    } catch (domError) {
      console.warn('[isMusicVideo] Music badge check failed:', domError.message);
    }

    // ========== שלב 1: YouTube Regular API - Category Check (200ms) ==========
    console.log('[isMusicVideo] 📺 Step 1: Checking category via YouTube API...');

    try {
      const regularPayload = {
        "context": {
          "client": {
            "clientName": "WEB",
            "clientVersion": "2.20260120.01.00",
            "hl": "en",
            "gl": "US"
          }
        },
        "videoId": videoId
      };

      const headers = {
        "Content-Type": "application/json"
      };

      const categoryResponse = await fetch("https://www.youtube.com/youtubei/v1/player", {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(regularPayload)
      });

      if (categoryResponse.ok) {
        const categoryData = await categoryResponse.json();
        const category = categoryData.microformat?.playerMicroformatRenderer?.category;

        console.log('[isMusicVideo] 📊 Category from API:', category);

        if (category) {
          detectedCategory = category;
          const categoryLower = category.toLowerCase();

          // ✅ אם זה Music - בטוח מוזיקה!
          if (categoryLower === 'music') {
            console.log('[isMusicVideo] ✅ Category is Music - IT\'S MUSIC! (200ms)');
            return { isMusic: true, category: "Music (API - Category)" };
          }

          if (BLOCKED_NON_MUSIC_CATEGORIES.has(categoryLower)) {
            console.log('[isMusicVideo] 🚫 Category is blocked:', category, '- marking signal and continuing to WEB_REMIX...');
            blockedCategorySignal = `Not Music (Blocked Category: ${category})`;
          } else if (isAmbiguousMusicCategory(categoryLower)) {
            manualRetryEligible = true;
            console.log('[isMusicVideo] ⚠️ Category is ambiguous and manual retry is allowed:', category);
            console.log('[isMusicVideo] ⏩ Continuing to WEB_REMIX for stronger verification...');
          } else {
            console.log('[isMusicVideo] ℹ️ Category is not blocked, but manual retry is disabled for:', category);
            console.log('[isMusicVideo] ⏩ Continuing to WEB_REMIX without manual retry fallback...');
          }
        }
      }
    } catch (apiError) {
      console.warn('[isMusicVideo] Category API check failed:', apiError.message);
    }

    // ========== שלב 1.5: בדיקת clipPath ב-Like Button (1ms) ==========
    console.log('[isMusicVideo] 🎨 Step 1.5: Checking Like button animation (clipPath)...');

    let clipPathCount = null;

    try {
      const lottie = document.querySelector('like-button-view-model lottie-component');

      if (lottie) {
        console.log('[isMusicVideo] ✅ Like button found in DOM');

        // 🔧 Optimized: Use DOM query instead of regex on innerHTML (avoids creating large strings)
        clipPathCount = lottie.querySelectorAll('clipPath').length;

        console.log('[isMusicVideo] 🔍 clipPath count:', clipPathCount);

        if (clipPathCount > 2) {
          // ❌ אנימציה מורכבת = YouTube רגיל = לא מוזיקה!
          console.log('%c[isMusicVideo] ❌ Complex Like animation detected (clipPath > 2) - observational only', 'color:#FF0000; font-weight:bold');
          console.log('[isMusicVideo] 📊 This is a regular YouTube video with rich animation');
          console.log('[isMusicVideo] ⏩ Continuing to WEB_REMIX for final verification...');
        } else if (clipPathCount === 2) {
          manualRetryEligible = true;
          console.log('%c[isMusicVideo] 🤔 Simple Like animation (clipPath = 2) - observational only', 'color:#FFA500; font-weight:bold');
          console.log('[isMusicVideo] 👍 clipPath = 2 enables manual Like retry fallback if final verification stays inconclusive');
          console.log('[isMusicVideo] ⏩ Continuing to YouTube Music WEB API for verification...');
        } else {
          console.log('[isMusicVideo] ⚠️ Unexpected clipPath count:', clipPathCount, '- continuing to WEB API...');
        }
      } else {
        console.log('[isMusicVideo] ⚠️ Like button not found in DOM (page still loading or YouTube Music)');
        console.log('[isMusicVideo] ⏩ Continuing to YouTube Music WEB API...');
      }
    } catch (clipPathError) {
      console.warn('[isMusicVideo] clipPath check failed:', clipPathError.message);
      console.log('[isMusicVideo] ⏩ Continuing to YouTube Music WEB API...');
    }

    // ========== שלב 2: YouTube Music APIs (500ms) ==========
    console.log('[isMusicVideo] 🎵 Step 2: Checking YouTube Music APIs...');


    // נקודות קצה - משתמשים ב-YouTube Music API!
    const endpoints = {
      musicPlayer: "https://music.youtube.com/youtubei/v1/player",
      regularPlayer: "https://www.youtube.com/youtubei/v1/player"
    };

    const headers = {
      "Content-Type": "application/json"
    };

    // Payload ל-YouTube Music - WEB_REMIX client
    const musicPayload = {
      "context": {
        "client": {
          "clientName": "WEB_REMIX",  // YouTube Music Web Client
          "clientVersion": "1.20260121.03.00",  // Updated January 2026
          "hl": "en",
          "gl": "US"
        }
      },
      "videoId": videoId
    };

    // שמור את כל הנתונים מהתשובות

    // ========== שלב 2: YouTube Music WEB Client API ==========
    console.log('[isMusicVideo] 🎵 Step 2: Checking YouTube Music WEB_REMIX client...');

    const maxRetries = 3;  // 🔧 מקסימום 3 ניסיונות (לא 10!)
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;

      try {
        console.log(`[isMusicVideo] 🎵 WEB_REMIX attempt ${attempt}/${maxRetries}...`);
        // music.youtube.com is cross-origin from a www.youtube.com page; since
        // Chrome 85 content-script fetches follow the page's CORS rules, so this
        // probe must go through the background service worker (host_permissions).
        const musicResponse = await window.ycLoader.postJson(endpoints.musicPlayer, musicPayload);

        if (musicResponse.ok) {
          const musicData = musicResponse.json || {};

          // 🐛 DEBUG: הדפסת התשובה המלאה
          console.log('%c[🐛 DEBUG] Full YouTube Music API Response:', 'color:#FF00FF; font-weight:bold');
          console.log('%c[🐛 DEBUG] playabilityStatus:', 'color:#FF00FF', musicData.playabilityStatus);
          console.log('%c[🐛 DEBUG] videoDetails:', 'color:#FF00FF', musicData.videoDetails);
          console.log('%c[🐛 DEBUG] Full response object:', 'color:#FF00FF', musicData);

          const playabilityStatus = musicData.playabilityStatus?.status;
          const reason = musicData.playabilityStatus?.reason || 'N/A';

          console.log('[isMusicVideo] 🎵 WEB_REMIX playability:', playabilityStatus, '| reason:', reason);

          // 🎯 בדיקה ראשונה: האם יש musicVideoType? (חשוב יותר מ-playabilityStatus!)
          if (musicData.videoDetails?.musicVideoType) {
            const musicVideoType = musicData.videoDetails.musicVideoType.toString().toUpperCase();
            console.log('[isMusicVideo] 🔍 musicVideoType =', musicVideoType);

            if (musicVideoType.includes('PODCAST')) {
              console.log('[isMusicVideo] ⚠️ It\'s a PODCAST - not music');
              return { isMusic: false, category: "Podcast" };
            }

            // ✅ יש musicVideoType → זה מוזיקה! (גם אם UNPLAYABLE)
            console.log('[isMusicVideo] ✅ Has musicVideoType - IT\'S MUSIC! (even if UNPLAYABLE)');
            return { isMusic: true, category: "Music (YouTube Music - has musicVideoType)" };
          }

          // ✅ תשובה וודאית: OK = מוזיקה!
          if (playabilityStatus === 'OK') {
            console.log('[isMusicVideo] ✅ Video is playable in YouTube Music (OK) - IT\'S MUSIC!');
            return { isMusic: true, category: "Music (YouTube Music WEB)" };
          }

          // ❌ תשובה וודאית: UNPLAYABLE (אבל לא "page not ready")
          if (playabilityStatus === 'UNPLAYABLE') {
            const subreason = JSON.stringify(musicData.playabilityStatus?.errorScreen || {});
            const isPageNotReady = subreason.includes('page needs to be reloaded') ||
              subreason.includes('Page needs to be reloaded');

            if (isPageNotReady && attempt < maxRetries) {
              // 🔄 רק "page not ready" - ממשיכים לנסות
              console.log(`[isMusicVideo] ⏳ Page not ready, waiting 1s and retrying...`);
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }

            // ❌ UNPLAYABLE (לא "page not ready" או נגמרו הניסיונות) - ממשיכים לפאלבק
            console.log('[isMusicVideo] ⚠️ Video is UNPLAYABLE in YouTube Music WEB_REMIX - checking final result...');
            break;  // ← שונה מ-return! ממשיכים לפאלבק
          }

          // 🤔 סטטוס לא צפוי - עוצרים
          console.log('[isMusicVideo] 🔍 Unexpected status:', playabilityStatus, '- stopping retries');
          break;

        } else {
          // ❌ HTTP error - עוצרים
          console.log(`[isMusicVideo] ⚠️ WEB_REMIX returned HTTP ${musicResponse.status} - stopping retries`);
          break;
        }
      } catch (e) {
        console.warn("[isMusicVideo] WEB_REMIX attempt failed:", e.message);
        // ❌ שגיאת רשת - עוצרים
        break;
      }
    }

    // אם הגענו לכאן - נכשלנו לקבל תשובה וודאית
    console.warn(`[isMusicVideo] ⚠️ Could not get definitive answer from YouTube Music API`);

    if (manualRetryEligible) {
      const manualOverride = getManualLikeMusicOverride();
      console.log('[isMusicVideo] 👍 Manual Like override check:', manualOverride.signals);

      if (manualOverride.matched) {
        console.log('[isMusicVideo] ✅ Manual Like override matched - treating ambiguous video as music');
        return {
          isMusic: true,
          category: `Music (Manual Like Override: ${detectedCategory || 'Ambiguous'})`,
          manualRetryEligible: true,
          manualLikeOverride: true,
          manualLikeOverrideSignal: manualOverride.signals
        };
      }

      // Local build: processing runs on the user's own companion, so an
      // inconclusive probe with ambiguous signals defaults to ALLOW.
      console.log('[isMusicVideo] ✅ Local build: inconclusive probe - allowing by default');
      return {
        isMusic: true,
        category: blockedCategorySignal
          ? `Music (Local default; ambiguous: ${blockedCategorySignal})`
          : 'Music (Local default: YouTube Music probe inconclusive)',
        manualRetryEligible: false,
        manualLikeOverrideSignal: manualOverride.signals
      };
    }

    if (blockedCategorySignal) {
      return { isMusic: false, category: blockedCategorySignal, manualRetryEligible: false };
    }

    console.log('[isMusicVideo] ✅ Local build: probe inconclusive - allowing by default');
    return { isMusic: true, category: 'Music (Local default: YouTube Music probe inconclusive)', manualRetryEligible: false };

  } catch (error) {
    console.error("Error analyzing music content:", error);
    // Local build: never block processing on internal errors
    return { isMusic: true, category: 'Music (Local default: probe error)', manualRetryEligible: false };
  }
}

/**
 * פונקציה לבדיקה אם יש כבר מידע בIndexedDB 
 * @param {string} videoId - מזהה הסרטון
 * @param {string} dbName - שם מסד הנתונים לבדיקה
 * @param {string} storeName - שם החנות במסד הנתונים
 * @return {Promise<boolean>} - האם יש מידע בIndexedDB
 */
async function checkInIndexedDB(videoId, dbName, storeName) {
  return new Promise((resolve) => {
    try {
      // פתיחת מסד הנתונים
      const request = indexedDB.open(dbName, 1);

      request.onerror = (event) => {
        console.error(`Error opening IndexedDB ${dbName}:`, event);
        resolve(false);
      };

      request.onsuccess = (event) => {
        const db = event.target.result;

        // אם אין חנות מתאימה, אין לנו מידע שמור
        if (!db.objectStoreNames.contains(storeName)) {
          resolve(false);
          return;
        }

        // בדיקה אם קיים ערך עם המפתח המבוקש
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const getRequest = store.get(videoId);

        getRequest.onsuccess = () => {
          // אם יש ערך (getRequest.result לא undefined), יש לנו מידע
          resolve(getRequest.result !== undefined);
        };

        getRequest.onerror = () => {
          console.error(`Error checking ${videoId} in ${dbName}/${storeName}`);
          resolve(false);
        };
      };
    } catch (error) {
      console.error(`Error checking IndexedDB ${dbName}:`, error);
      resolve(false);
    }
  });
}

/**
 * פונקציה לבדיקה אם יש כבר כתוביות לסרטון ב-IndexedDB
 * @param {string} videoId - מזהה הסרטון
 * @return {Promise<boolean>} - האם יש כתוביות בIndexedDB
 */
async function checkSubtitlesInIndexedDB(videoId) {
  try {
    if (!videoId) {
      console.error('Cannot check subtitles: videoId is missing');
      return false;
    }

    const aiSettings = await chrome.storage.local.get(['aiTranscriptionMode']);
    const aiMode = aiSettings.aiTranscriptionMode || 'off';

    // בדיקה אם יש כתוביות במסד הנתונים
    let subtitlesData = await window.databaseManager.loadFromDatabase('subtitles', videoId);
    if (subtitlesData && window.databaseManager?.normalizeSubtitlesForActiveMode) {
      subtitlesData = await window.databaseManager.normalizeSubtitlesForActiveMode(subtitlesData, aiMode);
    }

    const hasDefaultByMode = !!(
      subtitlesData?.hasActiveDefault ||
      (subtitlesData?.sentenceSRT && subtitlesData.sentenceSRT.trim() !== '')
    );
    const hasWordLevel = !!(subtitlesData?.wordSRT && subtitlesData.wordSRT.trim() !== '');

    // אם נמצאו כתוביות ויש בהן תוכן (משפטים או מילים)
    if (subtitlesData && (hasDefaultByMode || hasWordLevel)) {
      console.log(`Found subtitles in IndexedDB for video ${videoId}`);
      return true;
    }

    console.log(`No subtitles found in IndexedDB for video ${videoId}`);
    return false;
  } catch (error) {
    console.error(`Error checking subtitles in IndexedDB:`, error);
    return false;
  }
}

/**
 * פונקציה לבדיקה אם יש כבר אקורדים לסרטון ב-IndexedDB
 * @param {string} videoId - מזהה הסרטון
 * @return {Promise<boolean>} - האם יש אקורדים בIndexedDB
 */
async function checkChordsInIndexedDB(videoId) {
  try {
    if (!videoId) {
      console.error('Cannot check chords: videoId is missing');
      return false;
    }

    // בדיקה אם יש אקורדים במסד הנתונים
    const chordsData = await window.databaseManager.loadFromDatabase('chords', videoId);

    // אם נמצאו אקורדים ויש בהם תוכן
    if (chordsData && chordsData.chordText && chordsData.chordText.trim() !== '') {
      console.log(`Found chords in IndexedDB for video ${videoId}`);
      return true;
    }

    console.log(`No chords found in IndexedDB for video ${videoId}`);
    return false;
  } catch (error) {
    console.error(`Error checking chords in IndexedDB:`, error);
    return false;
  }
}

/**
 * פונקציה ראשית לבדיקת סרטון עם מנגנון קאשינג
 * @param {string} url - כתובת URL של סרטון YouTube
 * @param {Object} options - אפשרויות נוספות
 * @param {boolean} options.allowNonMusic - האם לאפשר סרטונים שאינם מוזיקה (ברירת מחדל: false)
 * @param {boolean} options.allowLongVideo - האם לאפשר סרטונים מעל 35 דקות מחוץ לעיבוד אקורדים (ברירת מחדל: false)
 * @param {string} options.durationContext - "processing" אוכף גם מגבלת Free של 6 דקות
 * @return {Promise<Object>} - אובייקט עם תוצאות הבדיקה
 */
async function validateVideo(url, options = {}) {
  try {
    const { allowNonMusic = false } = options;

    const videoId = window.ycUtils.extractVideoId(url);
    if (!videoId) {
      return { isValid: false, message: 'Invalid YouTube URL' };
    }

    // Always validate from fresh data without using cached results

    // בדיקה אם יש כבר תוצאות בIndexedDB
    const hasChords = await checkChordsInIndexedDB(videoId);
    if (hasChords) {
      return { isValid: true, message: 'Chords found in database', videoId, isMusic: true, durationSeconds: null };
    }

    // 🎯 בדיקה אם הסרטון מכיל תוכן מוזיקלי (לפני בדיקת משך זמן!)
    const musicResult = await isMusicVideo(videoId);
    console.log(`[validateVideo] Music check result: ${musicResult.isMusic ? 'Music' : 'Not Music'} (Category: ${musicResult.category})`);

    // 🎯 אם allowNonMusic: true וזה לא מוזיקה → דלג על בדיקת משך זמן!
    if (allowNonMusic && !musicResult.isMusic) {
      console.log(`[validateVideo] Non-music video with allowNonMusic=true - skipping duration check`);
      return {
        isValid: true,
        isMusic: false,
        message: 'Valid video (non-music, no duration limit)',
        videoId,
        musicCategory: musicResult.category,
        manualRetryEligible: !!musicResult.manualRetryEligible,
        manualRetryMessage: musicResult.manualRetryMessage || null,
        toastDurationMs: musicResult.toastDurationMs || null
      };
    }

    // בדיקת משך הזמן של הסרטון (רק לסרטוני מוזיקה או כשallowNonMusic=false)
    console.log(`[validateVideo] Checking duration for ${musicResult.isMusic ? 'music' : 'non-music'} video...`);
    let durationSeconds = null;
    const durationPlan = shouldEnforceProcessingDurationLimit(options)
      ? await getPlanForProcessingDuration(options)
      : 'pro';
    try {
      // טעינת הפונקציה לבדיקת אורך הסרטון באופן לוקאלי
      await window.ycLoader.js('utils/videoMetaLocal.js');
      const { getLocalDuration } = window;
      // בדיקת אורך הסרטון באופן מקומי
      const seconds = await getLocalDuration(videoId);

      if (seconds !== null) {
        durationSeconds = seconds;
        const durationFailure = getDurationValidationFailure(seconds, options, durationPlan);
        if (durationFailure) {
          return buildDurationValidationFailureResult(durationFailure, videoId, durationSeconds);
        }
      } else {
        // אם לא הצלחנו לקבל את האורך באופן לוקאלי, ננסה דרך ה-API
        const { seconds: apiSeconds } = await getVideoDuration(videoId, options);
        durationSeconds = apiSeconds;
        const durationFailure = getDurationValidationFailure(apiSeconds, options, durationPlan);
        if (durationFailure) {
          return buildDurationValidationFailureResult(durationFailure, videoId, durationSeconds);
        }
      }
    } catch (error) {
      if (window.DEBUG) console.log(`[VideoValidator] Error during duration check: ${error.message}`);
      // אם נכשלנו בבדיקה הלוקאלית וגם ב-API, נמשיך בתהליך בהנחה שהסרטון תקין
    }

    // אם allowNonMusic: true → תמיד מצליח (מחזיר isMusic לצורך מידע)
    if (allowNonMusic) {
      console.log(`[validateVideo] allowNonMusic=true - allowing ${musicResult.isMusic ? 'music' : 'non-music'} video`);
      return {
        isValid: true,
        isMusic: musicResult.isMusic,
        message: musicResult.isMusic ? 'Valid music video' : 'Valid video (non-music)',
        videoId,
        durationSeconds,
        musicCategory: musicResult.category,
        manualRetryEligible: !!musicResult.manualRetryEligible,
        manualRetryMessage: musicResult.manualRetryMessage || null,
        toastDurationMs: musicResult.toastDurationMs || null,
        manualLikeOverride: !!musicResult.manualLikeOverride
      };
    }

    // אם allowNonMusic: false → חוסם סרטונים שאינם מוזיקה (התנהגות מקורית)
    if (!musicResult.isMusic) {
      console.log(`[validateVideo] allowNonMusic=false - blocking non-music video (Category: ${musicResult.category})`);
      if (musicResult.manualRetryEligible) {
        if (hasManualMusicRetryBeenShown(videoId)) {
          return {
            isValid: false,
            message: MUSIC_VIDEO_DURATION_ERROR_MESSAGE,
            videoId,
            musicCategory: musicResult.category,
            manualRetryEligible: false,
            validationCode: 'manual_like_retry_exhausted'
          };
        }

        markManualMusicRetryShown(videoId);
        return {
          isValid: false,
          message: musicResult.manualRetryMessage || MANUAL_MUSIC_RETRY_MESSAGE,
          videoId,
          musicCategory: musicResult.category,
          manualRetryEligible: true,
          manualRetryMessage: musicResult.manualRetryMessage || MANUAL_MUSIC_RETRY_MESSAGE,
          toastDurationMs: musicResult.toastDurationMs || MANUAL_MUSIC_RETRY_TOAST_MS,
          validationCode: 'manual_like_retry'
        };
      }

      return {
        isValid: false,
        message: MUSIC_VIDEO_DURATION_ERROR_MESSAGE,
        videoId,
        musicCategory: musicResult.category,
        manualRetryEligible: false
      };
    }

    // תוצאה חיובית - סרטון מוזיקה
    return {
      isValid: true,
      isMusic: true,
      message: 'Valid music video',
      videoId,
      durationSeconds,
      musicCategory: musicResult.category,
      manualRetryEligible: !!musicResult.manualRetryEligible,
      manualLikeOverride: !!musicResult.manualLikeOverride
    };
  } catch (error) {
    console.error('Error validating video:', error);
    return { isValid: false, message: 'Error validating video', error: error.message };
  }
}

/**
 * פונקציה להצגת הודעת שגיאה על גבי הסרטון
 * @param {string} message - הודעת השגיאה
 * @param {number} duration - משך הזמן שההודעה תוצג (ברירת מחדל: 5000)
 */
function showErrorOverlay(message, duration = 5000) {
  // הפונקציה הועברה לקובץ yc-utils.js המרכזי
  // קריאה לפונקציה המרכזית
  if (window.ycUtils && window.ycUtils.showErrorOverlay) {
    window.ycUtils.showErrorOverlay(message, duration);
  } else {
    console.error('[Validator] ycUtils.showErrorOverlay not found');
  }
}

/**
 * מציג הודעת דיבאג על המסך
 * @param {string} message - הודעת הדיבאג
 * @param {number} duration - משך הזמן שההודעה תוצג (ברירת מחדל: 3000)
 */
function showDebugOverlay(message, duration = 3000) {
  // הפונקציה הועברה לקובץ yc-utils.js המרכזי
  // קריאה לפונקציה המרכזית
  if (window.ycUtils && window.ycUtils.showDebugOverlay) {
    window.ycUtils.showDebugOverlay(message, duration);
  } else {
    // אם במצב DEBUG והפונקציה לא נמצאה, נרשום ליומן
    if (window.DEBUG) {
      console.error('[Validator] ycUtils.showDebugOverlay not found');
      console.log(`[Debug] ${message}`);
    }
  }
}

// יצוא פונקציות לשימוש חיצוני
window.videoValidator = {
  validateVideo,
  showErrorOverlay,
  showDebugOverlay,
  hasManualMusicRetryBeenShown,
  markManualMusicRetryShown,
  // extractVideoId הוסר - יש להשתמש ב-window.ycUtils.extractVideoId
  checkSubtitlesInIndexedDB,
  checkChordsInIndexedDB
};
console.log("VideoValidator module loaded successfully", window.videoValidator);

})();
