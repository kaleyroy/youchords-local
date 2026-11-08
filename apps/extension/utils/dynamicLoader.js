// =============================================================
//  YouChords – dynamicLoader.js  (ESM + dependsOn + Retry + Prefetch)
//  Chrome 112+ | Manifest v3 | Lazy-Load מודולים ב-import()
// =============================================================

/* eslint-disable no-console */
const DEBUG = false;      // הפעל true בעת פיתוח
const MAX_RETRIES = 3;          // ניסיונות ל-import
const RETRY_DELAY = 2000;       // ms בין ניסיונות

// -------------------------------------------------------------
// 1. הגדרת קבוצות מודולים ותלויות
// -------------------------------------------------------------
const MODULE_GROUPS = {
  /* ---------- Local companion ---------- */
  auth: {
    files: [
      'config/local-config.js',
      'local/auth.js'
    ],
    dependsOn: []
  },

  /* ---------- בסיס משותף ---------- */
  shared: {
    files: [
      'utils/databaseManager.js',
      'utils/chordEditsManager.js',
      'utils/validatorModule.js'
    ],
    dependsOn: []
  },

  /* ---------- מודול חילוץ ---------- */
  extractor: {
    files: [
      'utils/extractorModule.js'
    ],
    dependsOn: ['shared']
  },

  /* ---------- קרוסל אקורדים ---------- */
  carousel: {
    files: [
      'utils/keyEstimator.js',
      'utils/chordRenderer.js',
      'buttons/carouselSubtitles.js',
      'buttons/languageSelector.js',
      'buttons/chordCarousel.js',
      'buttons/settings/Chords/sizesMenu.js',
      'buttons/diceIcon.js',
      'buttons/capoIcon.js',
      'buttons/audioManager.js',
      'buttons/settings/Tuning/tuningAlert.js'
    ],
    dependsOn: []
  },

  /* ---------- תצוגת כפתורים / אקורדים ---------- */
  buttonsDisplay: {
    files: [
      'buttons/settings/buttons_display/buttonsDisplay.js',
      'utils/keyEstimator.js',
      'buttons/chordsDisplay.js',
      'buttons/subtitleButton.js' // נטען תמיד - קובץ קטן ולא רץ עד לחיצה
    ],
    dependsOn: []
  },

  /* ---------- כפתורי פעולה ---------- */
  chords: {
    files: ['buttons/chordsButton.js'],
    dependsOn: ['extractor', 'buttonsDisplay', 'lyricsChords'] // lyricsChords נדרש עבור ensurePanelSubset
  },
  subtitles: {
    files: [], // הקובץ כבר נטען ב-buttonsDisplay
    dependsOn: ['extractor', 'buttonsDisplay']
  },
  lyricsChords: {
    files: [
      'utils/keyEstimator.js',
      'utils/geminiTranscription.js',
      'utils/youtubeSubtitles.js',
      'buttons/languageSelector.js',
      'buttons/diceIcon.js',
      'buttons/capoIcon.js',
      'buttons/lyricsAndChordsButton.js',
      'buttons/fullscreenPanelHandler.js',
      'buttons/fullscreenPanelStyles.css'
    ],
    dependsOn: ['extractor', 'buttonsDisplay']
  },

  /* ---------- Chord Explorer ---------- */
  chordExplorer: {
    files: ['buttons/chordExplorer.js'],
    dependsOn: ['carousel']
  },

  /* ---------- Guitar Tuner ---------- */
  tuner: {
    files: ['buttons/tuner.js'],
    dependsOn: []
  },

  settings: {
    files: [
      'buttons/settings/index.js',
      'buttons/settings/buttons_display/buttonsDisplay.js',
      'buttons/settings/subtitles/subtitleMenu.js',

      // ► Subtitle
      'buttons/settings/subtitles/fontSize.js',
      'buttons/settings/subtitles/fontColorMenu.js',
      'buttons/settings/subtitles/fontOpacityMenu.js',

      // ► Highlight-word
      'buttons/settings/subtitles/wordHighlightTextColorMenu.js',
      'buttons/settings/subtitles/highlightColorMenu.js',
      'buttons/settings/subtitles/highlightColorOpacityMenu.js',

      // ► Subtitle box
      'buttons/settings/subtitles/backgroundColorMenu.js',
      'buttons/settings/subtitles/backgroundOpacityMenu.js',

      // ► Chords Mode
      'buttons/settings/Chords_Mode/chordsModeMenu.js',

      // ► Chords options
      'buttons/settings/Chords/progressBarsMenu.js',
      'buttons/settings/Chords/subtitlesInChordsMenu.js',
      'buttons/settings/Chords/activeChordPositionMenu.js',
      'buttons/settings/Chords/chordsLocationMenu.js',
      'buttons/settings/Chords/carouselColorsMenu.js',
      'buttons/settings/Chords/sizesMenu.js', // Also in carousel group for instant loading
      'buttons/settings/Chords/visualIndicatorsMenu.js',
      'buttons/settings/Chords/primaryChordsPositionMenu.js',
      'buttons/settings/Chords/carouselSubtitlesFontMenu.js',

      // ► Reset-to-default
      'buttons/settings/reset_to_default/resetToDefaultButton.js',
      'buttons/settings/reset_to_default/resetToDefault.js',
      'buttons/settings/reset_to_default/clearChordPositions.js',

      // ► Wipe All Data
      'buttons/settings/wipe_data/wipeAllData.js',

      // ► Clear Video Cache
      'buttons/settings/clear_video_cache/clearVideoCache.js',

      // ► Lyrics & Chords settings
      'buttons/settings/lyricsAndChords/lyricsAndChordsPastWordsMenu.js',
      'buttons/settings/lyricsAndChords/lyricsAndChordsFontMenu.js',
      'buttons/settings/lyricsAndChords/verseChorusColorsMenu.js',
      'buttons/settings/lyricsAndChords/spacingMenu.js'
    ],
    dependsOn: []
  },

  /* ---------- preload ראשוני – כפתור הגדרות בלבד ---------- */
  buttons: {
    files: [
      'buttons/settings/settingsButton.js'
    ],
    dependsOn: []
  }
};

// -------------------------------------------------------------
// 2. ניהול מצב טעינה
// -------------------------------------------------------------
const loaded = new Set();     // קבצים שכבר בזיכרון
const loadingProm = new Map();     // path → Promise
let aborted = false;         // true → אל תטען קבצים חדשים
const injectedCSS = new Set();     // CSS files already injected via ycLoader

/* --- מפסקי חיים של הטאב ----------------------------------- */
window.addEventListener('pagehide', () => {          // הדף עוזב / הולך ל-BFCache
  aborted = true;
  DEBUG && console.log('[Loader] pagehide → aborted = true');
}, { once: true, passive: true }); // Added passive: true

window.addEventListener('pageshow', () => {          // חזרנו מה-BFCache או טעינה מחדש
  aborted = false;
  DEBUG && console.log('[Loader] pageshow → reset aborted');
}, { passive: true }); // Added passive: true

window.addEventListener('visibilitychange', () => {  // מעבר טאב
  if (document.visibilityState === 'hidden') {
    aborted = true;
    DEBUG && console.log('[Loader] hidden → aborted = true');
  } else if (document.visibilityState === 'visible') {
    aborted = false;
    DEBUG && console.log('[Loader] visible → aborted = false');
  }
}, { passive: true }); // Added passive: true

// -------------------------------------------------------------
// 3. Prefetch לקבצי shared  (Latency 0 בלחיצה ראשונה)
// -------------------------------------------------------------
// דגל שמציין אם כבר בוצע prefetch לקבצים המשותפים
let sharedPrefetched = false;

// פונקציה לטעינה מראש של קבצים משותפים - תיקרא רק בלחיצה הראשונה
// הערה: בעבר נוצרו תגי link[rel=prefetch] לכתובות chrome-extension://
// שנחסמו על ידי הדפדפן — הטעינה עצמה עוברת כעת דרך ycLoader
// (chrome.scripting.executeScript בעולם ה-ISOLATED), ולכן אין
// עוד צורך ב-prefetch אמיתי; שומרים על ה-API לצורך תאימות.
function prefetchShared() {
  if (sharedPrefetched) {
    if (DEBUG) console.log('[dynamicLoader] Shared files already prefetched');
    return Promise.resolve();
  }

  if (DEBUG) console.log('[dynamicLoader] Prefetching shared files on demand');

  sharedPrefetched = true;
  return Promise.resolve();
}

// -------------------------------------------------------------
// 4. טעינת קובץ יחיד עם ycLoader (executeScript) + Retry
// -------------------------------------------------------------
async function loadFile(path, attempt = 1) {
  if (loaded.has(path)) return;

  // איפוס יזום של aborted אם הטאב גלוי
  if (document.visibilityState === 'visible') {
    if (aborted) {
      aborted = false;
      DEBUG && console.log('[Loader] Reset aborted to false - tab is visible now for path:', path);
    }
  } else if (aborted) {
    // --- START: MODIFICATION FOR WARNING LOGIC ---
    // בדוק אם זו טעינה קריטית או חלק מאתחול ראשוני
    // קבצי shared או קבצים בנתיב שמתחיל ב-buttons/ ייחשבו כפחות מדאיגים להדפסת אזהרה מלאה
    const isSharedFile = MODULE_GROUPS.shared.files.includes(path);
    const isButtonRelatedFile = path.startsWith('buttons/');

    if (isSharedFile || isButtonRelatedFile) {
      // עבור קבצים אלו, אולי לא נדפיס אזהרה, או נדפיס הודעת מידע עדינה יותר אם DEBUG מופעל
      if (DEBUG) console.info('[Loader] Info: Loading initial/shared file', path, 'while tab might be briefly hidden/aborted.');
    } else {
      // עבור קבצים אחרים, נשמור על האזהרה המקורית
      console.warn('[Loader] Warning: Loading', path, 'while tab is supposed to be hidden/closed');
    }
    // --- END: MODIFICATION FOR WARNING LOGIC ---
    // הטעינה ממשיכה בכל מקרה
  }

  if (loadingProm.has(path)) return loadingProm.get(path);

  // הזרקה דרך גשר ההרשאות (chrome.scripting.executeScript ב-ISOLATED world)
  // — לא עובר דרך web_accessible_resources, שהוכח כלא אמין
  const prom = window.ycLoader.js(path)
    .then(() => {
      if (DEBUG) console.log('[Loader] Loaded', path);
      loaded.add(path);
      loadingProm.delete(path);
      return window; // תאימות לממשק הקודם (מודול/namespace)
    })
    .catch(async err => {
      // בדוק שוב את aborted לפני ניסיון חוזר, כי ייתכן שהטאב באמת נסגר/עזב
      if (attempt < MAX_RETRIES && !aborted) { // Check aborted again here
        if (DEBUG) console.warn(`[Loader] Retry ${attempt} →`, path);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        return loadFile(path, attempt + 1);
      }
      loadingProm.delete(path);
      console.error('[Loader] Failed', path, err);
      // אם הטעינה נכשלה בגלל aborted, אולי נרצה לזרוק שגיאה ספציפית יותר או לא לזרוק כלל
      if (aborted) {
        console.warn('[Loader] Load failed for', path, 'likely because the tab was closed/hidden definitively.');
        // אפשר להחזיר Promise.reject(new Error('Load aborted due to tab state'))
        // או פשוט לא לזרוק כדי לא להפריע לתהליכים אחרים אם זה לא קריטי
      }
      throw err; // זרוק את השגיאה המקורית אם זה לא בגלל aborted או אם רוצים שהיא תופץ
    });

  loadingProm.set(path, prom);
  return prom;
}

// -------------------------------------------------------------
// 5. טעינת קבוצה (רקורסיבי)
// -------------------------------------------------------------
async function loadGroup(name) {
  const group = MODULE_GROUPS[name];
  if (!group) throw new Error(`Module group '${name}' not found`);

  // קודם טוענים את התלויות
  for (const dep of group.dependsOn) {
    await loadGroup(dep);
  }

  // ואז את קבצי הקבוצה עצמה
  for (const file of group.files) {
    // CSS files should use loadCSS, not loadFile (import() doesn't work with CSS)
    if (file.endsWith('.css')) {
      await loadCSS(file);
    } else {
      await loadFile(file);
    }
  }
}

// -------------------------------------------------------------
// 6. Utilities שנצרכים ב-content.js / buttons
// -------------------------------------------------------------
const ensureDatabaseManagerLoaded = () =>
  loadGroup('shared').then(() => window.databaseManager);

const ensureAuthLoaded = () =>
  loadGroup('auth').then(() => window.ycAuth);

const ensureButtonsLoaded = () => loadGroup('buttons');

function ensureButtonLoaded(type) {
  const map = { chords: 'chords', subtitle: 'subtitles', settings: 'settings', lyricsChords: 'lyricsChords', tuner: 'tuner', chordExplorer: 'chordExplorer' };
  return map[type] ? loadGroup(map[type])
    : Promise.reject(new Error('Unknown button type'));
}

const preloadAllButtons = () => ensureButtonsLoaded();

// -------------------------------------------------------------
// 7. טעינת קבצי CSS דינמית
// -------------------------------------------------------------
/**
 * טעינת קובץ CSS דינמית (דרך chrome.scripting.insertCSS — ללא תלות
 * ב-web_accessible_resources)
 * @param {string} path - נתיב לקובץ CSS
 * @returns {Promise<void>}
 */
function loadCSS(path) {
  if (injectedCSS.has(path)) {
    DEBUG && console.log(`[dynamicLoader] CSS כבר נטען: ${path}`);
    return Promise.resolve();
  }

  return window.ycLoader.css(path)
    .then(() => {
      injectedCSS.add(path);
      DEBUG && console.log(`[dynamicLoader] CSS נטען בהצלחה: ${path}`);
    })
    .catch((err) => {
      console.error(`[dynamicLoader] שגיאה בטעינת CSS: ${path}`, err);
      throw err;
    });
}

// -------------------------------------------------------------
// 8. ניקוי באפר המודולים
// -------------------------------------------------------------

/**
 * ניקוי המטמון של מודולים שנטענו כדי לחסוך זיכרון
 * נקרא במעבר בין סרטונים ומנקה ממדים גרפיים מיותרים
 */
function clearCache() {
  // ניקוי נתונים של מודולים שנטענו
  if (window.chordCarousel?.clearCache) { // Check if function exists
    window.chordCarousel.clearCache();
  }

  // ניקוי תמונות בזיכרון של דיאגרמות אקורדים
  if (window.chordRenderer?.clearImageCache) { // Check if function exists
    window.chordRenderer.clearImageCache();
  }

  // ניקוי דאטה של שירים שהתקבלו מהשרת
  if (window.chordsDisplay?.clearSongCache) { // Check if function exists
    window.chordsDisplay.clearSongCache();
  }

  // הסרת קישורי prefetch שנוצרו בעבר (ליתר ביטחון — לא נוצרים עוד)
  document.querySelectorAll('link[rel="prefetch"][href^="chrome-extension:"]').forEach(link => {
    try {
      link.remove();
    } catch (e) { /* ignore */ }
  });

  // GC hint
  if (window.gc) {
    try {
      window.gc();
      DEBUG && console.log('[dynamicLoader] GC hint sent');
    } catch (e) {
      // רוב הדפדפנים לא מאפשרים גישה ל-gc()
    }
  }

  DEBUG && console.log('[dynamicLoader] Cache cleared');
}

// -------------------------------------------------------------
// 9. פונקציות עזר נוספות
// -------------------------------------------------------------

/**
 * בדיקה אם CSS כבר נטען (דרך הגשר — תגי link כבר לא נוצרים)
 * @param {string} path - נתיב לקובץ CSS
 * @returns {boolean} - האם ה-CSS נטען
 */
function isCSSLoaded(path) {
  return injectedCSS.has(path);
}

// -------------------------------------------------------------
// 10. חשיפת API ל-window
// -------------------------------------------------------------
window.dynamicLoader = {
  loadFile,
  loadGroup,
  prefetchShared,
  // sharedPrefetched, // This is internal state, not usually needed on API
  get isSharedPrefetched() { return sharedPrefetched; }, // Expose as a getter if needed
  ensureDatabaseManagerLoaded,
  ensureAuthLoaded,
  ensureButtonsLoaded,
  ensureButtonLoaded,
  preloadAllButtons,
  loadCSS,
  isCSSLoaded,  // הוספת הפונקציה החדשה
  clearCache
};

if (DEBUG) console.log('[Loader] dynamicLoader initialised');
