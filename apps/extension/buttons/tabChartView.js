/* yc-module-scope */
// TAB Chart View (六线谱视图) — 吉他弹唱谱样式:和弦图 + 六线谱扫弦节奏 + 按拍对齐的歌词
// ─────────────────────────────────────────────────────────────────────────────
// 布局仿印刷弹唱谱(每个 system 一行):
//   [小节号行] [和弦图行(换和弦处)] [六线谱 + 扫弦箭头行] [歌词行(按拍列对齐)]
// 四行共享同一套 grid 列定义(每拍一列),保证和弦图/扫弦/歌词纵向对齐。
//
// 时序引擎与 Measure 视图同源(推算恒定 BPM 网格 / madmom 管线 downbeat),
// 并共用 yc_measure_<videoId> 存档(BPM/拍号/Offset/Source 两视图互通),
// 本视图私有设置(扫弦模式/和弦图开关/每行小节数)存 yc_tab_<videoId>。
// 与 Measure 视图互斥接管面板内容;默认关闭时零行为变化。
(function () {
'use strict';

// ───────────────────────────────────────────────
// 0. 常量与状态
// ───────────────────────────────────────────────
const DEFAULT_TIMING = { bpm: 120, beatsPerBar: 4, offset: 0, source: 'auto' };
const DEFAULT_TAB_SETTINGS = { pattern: 'dduudu', diagrams: true, bars: 4, sections: true };
const BPM_MIN = 40;
const BPM_MAX = 240;
const VALID_BEATS = [3, 4, 6];
const VALID_SOURCES = ['auto', 'inferred', 'pipeline'];
const TIMING_KEY_PREFIX = 'yc_measure_'; // 与 Measure 视图共用
const TAB_KEY_PREFIX = 'yc_tab_';        // 本视图私有
const SYNC_KEY = 'tabViewEnabled';       // 全局开关(chrome.storage.sync)
const SAVE_DEBOUNCE_MS = 300;
const MIN_CHORD_DELTA = 0.05;
const MIN_PIPELINE_BEATS = 4;
const PICKUP_MEASURE_MAX = 0.5;
const MAX_HELD_FILL = 3;                 // 长音填格最多填充小节数

// 扫弦模式:steps 为一小节内的拍下方向序列('' = 不扫);divisions = 每拍细分(2=八分)
// 高亮时按「小节内第几个细分槽」取模,模式每小节循环(乐句上更自然)
const PATTERNS = {
  none:    { label: 'Off', divisions: 1, steps: [] },
  quarter: { label: '↓  ↓  ↓  ↓', divisions: 1, steps: ['D'] },
  eighth:  { label: '↓ ↑ ↓ ↑', divisions: 2, steps: ['D', 'U'] },
  dduudu:  { label: '↓ ·↓↑ ·↑↓↑ (D DU UDU)', divisions: 2, steps: ['D', '', 'D', 'U', '', 'U', 'D', 'U'] },
  waltz:   { label: '↓ ·↓↑ ·↑ (D DU U)', divisions: 2, steps: ['D', '', 'D', 'U', '', 'U'] },
};
const DEFAULT_PATTERN = 'dduudu';
const VALID_PATTERNS = Object.keys(PATTERNS);
const VALID_BARS = [2, 4];

const state = {
  enabled: false,
  container: null,
  videoId: null,
  timing: { ...DEFAULT_TIMING },        // bpm/beatsPerBar/offset/source(与 Measure 视图共用存档)
  tabSettings: { ...DEFAULT_TAB_SETTINGS },
  settingsLoadedFor: null,
  settingsFromArchive: false,
  chords: [],                            // [{ name, time, gi }] 已排序
  words: [],                             // [{ word, start, end, wi }] 已排序
  sections: [],                          // [{ name, time }]
  beatsData: null,
  pipeline: null,                        // { info, mode }
  measures: [],                          // [{ n, start, beatTimes[], beatOffset, slots[{chords[],words[]}] }]
  // 高亮缓存
  lastMeasureIdx: null,
  lastWordIdx: null,
  lastChordIdx: null,
  lastSectionIdx: null,
  lastSlotKey: null,
  lastScrollMeasureIdx: null,
  // 基础设施
  saveTimingTimer: null,
  saveTabTimer: null,
  cssInjected: false,
  globalListenersAttached: false,
  resizeObserver: null,
  positionsCache: new Map(),             // 和弦名 → positions 数组 | null(无指法)
  positionsTextPromise: null,            // chords.complete.js 文本只拉一次
};

// ───────────────────────────────────────────────
// 1. 环境辅助(与 Measure 视图同口径)
// ───────────────────────────────────────────────
function getVideoEl() {
  return document.querySelector('video.html5-main-video') || document.querySelector('video');
}

function getVideoId() {
  const fromChords = window.chordsDisplay?.currentSongData?.videoId;
  if (fromChords) return fromChords;
  try {
    return new URL(window.location.href).searchParams.get('v') || 'default';
  } catch {
    return 'default';
  }
}

function subtitleOffset() {
  const o = Number(window.subtitleState?.timing_offset);
  return Number.isFinite(o) ? o : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function displayName(raw) {
  let nm = raw || '';
  if (window.getCapoChord) {
    try { nm = window.getCapoChord(nm, 'panel'); } catch { /* keep raw */ }
  }
  if (window.chordRenderer?.getDisplayChordName) {
    try { nm = window.chordRenderer.getDisplayChordName(nm); } catch { /* keep */ }
  }
  return nm;
}

function binarySearchLast(arr, t, key) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ───────────────────────────────────────────────
// 2. 时序引擎(与 Measure 视图同源,共用 yc_measure_ 存档)
// ───────────────────────────────────────────────
function beatDur() { return 60 / state.timing.bpm; }
function measureDur() { return beatDur() * effBeats(); }
function measureStart(n) { return state.timing.offset + n * measureDur(); }
function measureIndex(t) { return Math.floor((t - state.timing.offset) / measureDur()); }
function clampBpm(bpm) { return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)); }

// 生效拍号:管线模式用检测 meter(合法时),否则用设置值
function effBeats() {
  const info = state.pipeline?.mode === 'pipeline' ? state.pipeline.info : null;
  return info && VALID_BEATS.includes(info.meter) ? info.meter : state.timing.beatsPerBar;
}

function estimateBpmFromChords(chords, beatsPerBar) {
  if (!Array.isArray(chords) || chords.length < 2) return DEFAULT_TIMING.bpm;
  const times = chords.map((c) => c.time).sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > MIN_CHORD_DELTA) deltas.push(d);
  }
  if (!deltas.length) return DEFAULT_TIMING.bpm;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.round(clampBpm((60 * beatsPerBar) / (2 * median)));
}

// 归一化管线 beatsData → { beats:[{time,pos}], meter, bpm };不可用返回 null
function getPipelineBeats() {
  const data = state.beatsData;
  const raw = Array.isArray(data?.beats) ? data.beats : [];
  const beats = raw
    .filter((b) => b && Number.isFinite(Number(b.time)) && Number.isInteger(Number(b.pos)) && b.pos >= 1)
    .map((b) => ({ time: Number(b.time), pos: Number(b.pos) }))
    .sort((a, b) => a.time - b.time);
  if (beats.length < MIN_PIPELINE_BEATS || !beats.some((b) => b.pos === 1)) return null;

  let meter = Number(data?.meter);
  if (![3, 4, 6].includes(meter)) {
    const lens = [];
    let count = 0;
    for (const b of beats) {
      if (b.pos === 1) {
        if (count > 0) lens.push(count);
        count = 1;
      } else count++;
    }
    if (count > 0) lens.push(count);
    meter = 4;
    if (lens.length) {
      const freq = new Map();
      for (const l of lens) freq.set(l, (freq.get(l) || 0) + 1);
      meter = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  let bpm = Number(data?.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    const deltas = [];
    for (let i = 1; i < beats.length; i++) {
      const d = beats[i].time - beats[i - 1].time;
      if (d > 0.2 && d < 2) deltas.push(d);
    }
    deltas.sort((a, b) => a - b);
    bpm = deltas.length ? 60 / deltas[Math.floor(deltas.length / 2)] : 0;
  }

  return { beats, meter, bpm: Math.round(bpm * 10) / 10 };
}

function refreshPipelineState() {
  const info = getPipelineBeats();
  const mode = state.timing.source === 'inferred' ? 'inferred' : (info ? 'pipeline' : 'inferred');
  state.pipeline = { info, mode };
}

// ───────────────────────────────────────────────
// 3. 设置持久化(timing 共用 yc_measure_,tab 私有 yc_tab_)
// ───────────────────────────────────────────────
function normalizeTiming(raw) {
  const bpm = Number(raw?.bpm);
  const beats = Number(raw?.beatsPerBar);
  const offset = Number(raw?.offset);
  const source = String(raw?.source || '');
  return {
    bpm: Number.isFinite(bpm) ? clampBpm(bpm) : DEFAULT_TIMING.bpm,
    beatsPerBar: VALID_BEATS.includes(beats) ? beats : DEFAULT_TIMING.beatsPerBar,
    offset: Number.isFinite(offset) ? offset : DEFAULT_TIMING.offset,
    source: VALID_SOURCES.includes(source) ? source : DEFAULT_TIMING.source,
  };
}

function normalizeTabSettings(raw) {
  const pattern = String(raw?.pattern || '');
  const bars = Number(raw?.bars);
  return {
    pattern: VALID_PATTERNS.includes(pattern) ? pattern : DEFAULT_PATTERN,
    diagrams: raw?.diagrams !== false,
    bars: VALID_BARS.includes(bars) ? bars : DEFAULT_TAB_SETTINGS.bars,
    sections: raw?.sections !== false,
  };
}

// 读合并:yc_measure_ 存档可能被 Measure 视图整对象覆写(白名单字段),读后合并写回不丢 tab 字段
async function loadSettings(videoId) {
  const timingKey = TIMING_KEY_PREFIX + videoId;
  const tabKey = TAB_KEY_PREFIX + videoId;
  try {
    const got = await chrome.storage.local.get([timingKey, tabKey]);
    const savedTiming = got?.[timingKey];
    const hasArchive = !!(savedTiming && Number.isFinite(Number(savedTiming.bpm)));
    state.settingsFromArchive = hasArchive;
    state.timing = hasArchive ? normalizeTiming(savedTiming) : { ...DEFAULT_TIMING };
    state.tabSettings = normalizeTabSettings(got?.[tabKey]);
    if (!hasArchive) {
      state.timing.bpm = estimateBpmFromChords(state.chords, state.timing.beatsPerBar);
      scheduleSaveTiming();
    }
  } catch (err) {
    console.warn('[TabChart] Failed to load settings:', err);
    state.timing = { ...DEFAULT_TIMING };
    state.tabSettings = { ...DEFAULT_TAB_SETTINGS };
  }
  state.settingsLoadedFor = videoId;
}

// 合并写:先读现值再覆写 timing 字段,保留 Measure 视图可能写入的其他键
function scheduleSaveTiming() {
  clearTimeout(state.saveTimingTimer);
  state.saveTimingTimer = setTimeout(() => {
    const key = TIMING_KEY_PREFIX + (state.videoId || 'default');
    try {
      chrome.storage.local.get(key, (got) => {
        chrome.storage.local.set({ [key]: { ...got?.[key], ...state.timing } });
      });
    } catch (err) {
      console.warn('[TabChart] Failed to save timing:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

function scheduleSaveTab() {
  clearTimeout(state.saveTabTimer);
  state.saveTabTimer = setTimeout(() => {
    const key = TAB_KEY_PREFIX + (state.videoId || 'default');
    try {
      chrome.storage.local.set({ [key]: { ...state.tabSettings } });
    } catch (err) {
      console.warn('[TabChart] Failed to save tab settings:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ───────────────────────────────────────────────
// 4. 数据提取(在 combinedData 被释放前同步完成)
// ───────────────────────────────────────────────
// 残缺括号片段(自动字幕把 [Verse 2] 拆词后的 "[Verse" / "2]")→ 不进歌词格
function isBracketFragment(text) {
  return /^\[[^\]]*$/.test(text) || /^[^\[]*\]$/.test(text);
}

function extractData(combinedData, authoritativeChords) {
  let chords = [];
  if (Array.isArray(authoritativeChords) && authoritativeChords.length) {
    chords = authoritativeChords
      .filter((c) => c && Number.isFinite(Number(c.time)))
      .map((c) => ({ name: c.name || c.chord || '', time: Number(c.time) }));
  } else if (Array.isArray(combinedData)) {
    const seen = new Set();
    for (const line of combinedData) {
      let lineChords = line?.chords;
      if (!Array.isArray(lineChords) || !lineChords.length) {
        lineChords = [];
        for (const pair of (line?.wordChordPairs || [])) {
          if (pair && !pair.isChordGap) lineChords.push(...(pair.chords || []));
        }
      }
      for (const ch of lineChords) {
        const t = Number(ch?.time);
        const nm = ch?.chord || ch?.name || '';
        if (Number.isFinite(t) && !seen.has(t)) {
          seen.add(t);
          chords.push({ name: nm, time: t });
        }
      }
    }
  }
  chords.sort((a, b) => a.time - b.time);
  chords.forEach((c, gi) => { c.gi = gi; });

  const words = [];
  // 自动字幕常把段落标记([Verse 2] 等)烤成普通词且不带标记位:
  // 整行文本是 [Tag] 样式 → 收集为额外界标(交给 extractSections 并入段落时间轴)
  const bracketSections = [];
  if (Array.isArray(combinedData)) {
    for (const line of combinedData) {
      if (line?.isSectionMarker) continue;
      const lineWords = line?.words || [];
      const joined = lineWords.map((w) => String(w?.word || w?.text || '').trim()).join(' ').replace(/\s+/g, ' ').trim();
      const looksLikeTag = joined.startsWith('[') && joined.endsWith(']') && joined.length > 2;
      if (line?.isInstrumental || looksLikeTag) {
        const name = parseInstrumentalName(joined) || (line?.isInstrumental ? parseInstrumentalName(line.text) : null);
        if (name && Number.isFinite(Number(line.start))) {
          bracketSections.push({ name, time: Number(line.start) });
          continue;   // 该行不产词
        }
      }
      for (const w of lineWords) {
        const text = String(w?.word || w?.text || '').trim();
        const start = Number(w?.start);
        if (text && Number.isFinite(start) && !isBracketFragment(text)) {
          const end = Number(w?.end);
          words.push({ word: text, start, end: Number.isFinite(end) ? end : start });
        }
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  words.forEach((w, wi) => { w.wi = wi; });

  return { chords, words, sections: extractSections(combinedData, bracketSections) };
}

function parseInstrumentalName(text) {
  const m = String(text || '').trim().match(/^\[\s*(.+?)\s*\]$/);
  return m ? m[1].trim() : null;
}

function extractSections(combinedData, extraInstrumental = []) {
  if (!Array.isArray(combinedData) || !combinedData.length) return [];
  const markers = [];
  const instrumental = [...extraInstrumental];
  for (const line of combinedData) {
    if (!line || !Number.isFinite(Number(line.start))) continue;
    if (line.isSectionMarker && line.markerName) {
      markers.push({ name: String(line.markerName), time: Number(line.start) });
    } else if (line.isInstrumental && line.text) {
      const name = parseInstrumentalName(line.text);
      if (name) instrumental.push({ name, time: Number(line.start) });
    }
  }
  markers.sort((a, b) => a.time - b.time);
  if (markers.length) {
    const merged = [...markers];
    for (const s of instrumental) {
      const dup = merged.some(
        (m) => Math.abs(m.time - s.time) <= 1.5 || (m.name === s.name && Math.abs(m.time - s.time) <= 2.5)
      );
      if (!dup) merged.push(s);
    }
    merged.sort((a, b) => a.time - b.time);
    return merged;
  }

  // 无真实标记:自动字幕烤入的 [Tag] 行 / instrumental 行也可作段落轴(同名同时刻去重)
  if (instrumental.length) {
    instrumental.sort((a, b) => a.time - b.time);
    const merged = [];
    for (const s of instrumental) {
      const dup = merged.some(
        (m) => Math.abs(m.time - s.time) <= 1.5 || (m.name === s.name && Math.abs(m.time - s.time) <= 2.5)
      );
      if (!dup) merged.push(s);
    }
    if (merged.length) return merged;
  }
  return deriveSectionsFromMetadata(combinedData);
}

function deriveSectionsFromMetadata(lines) {
  const sections = [];
  let label = null;
  for (const line of lines) {
    if (!line || !Number.isFinite(Number(line.start))) continue;
    if (line.isSectionMarker) continue;
    let cur = null;
    if (line.isInstrumental && line.text) {
      cur = parseInstrumentalName(line.text) || 'Instrumental';
    } else if (line.isChorus) {
      cur = 'Chorus';
    } else if (Number.isInteger(line.verseNumber) && line.verseNumber > 0) {
      cur = `Verse ${line.verseNumber}`;
    }
    if (!cur || cur === label) continue;
    sections.push({ name: cur, time: Number(line.start) });
    label = cur;
  }
  const distinct = new Set(sections.map((s) => s.name));
  if (distinct.size < 2) return [];
  return sections;
}

// 和弦库兜底(与 Measure 视图同源的 "t:name,…" 文本格式)
function parseChordText(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const part of text.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const t = parseFloat(part.slice(0, idx));
    const name = part.slice(idx + 1).trim();
    if (Number.isFinite(t) && name) out.push({ time: t, name });
  }
  return out.sort((a, b) => a.time - b.time);
}

function pickChordTextByMode(data) {
  if (!data) return null;
  const mode = window.chordsMode || 'regular';
  if (data.chordText && typeof data.chordText === 'object') {
    return data.chordText[mode] || data.chordText.regular || null;
  }
  switch (mode) {
    case 'regularPlus': return data.chordTextRegularPlus || data.chordText || null;
    case 'harmonic': return data.chordTextHarmonic || data.chordText || null;
    case 'harmonicPlus': return data.chordTextHarmonicPlus || data.chordText || null;
    default: return typeof data.chordText === 'string' ? data.chordText : null;
  }
}

async function pullChordsFromDb(videoId) {
  try {
    let data = null;
    if (window.databaseManager?.loadFromDatabase) {
      data = await window.databaseManager.loadFromDatabase('chords', videoId);
    }
    if (!data) data = window.chordTextsCache?.[videoId];
    const parsed = parseChordText(pickChordTextByMode(data));
    return parsed.length ? { chords: parsed, beatsData: data?.beatsData || null } : null;
  } catch (err) {
    console.warn('[TabChart] chord library pull failed:', err);
    return null;
  }
}

// ───────────────────────────────────────────────
// 5. 小节网格(每小节 bpb 个拍槽;管线版拍点钳到均匀槽位)
// ───────────────────────────────────────────────
function buildMeasures() {
  refreshPipelineState();
  if (state.pipeline.mode === 'pipeline' && state.pipeline.info) {
    buildMeasuresFromDownbeats(state.pipeline.info);
  } else {
    buildUniformMeasures();
  }
  applyHeldWords();
}

function newMeasure(n, start, bpb, beatOffset) {
  return {
    n,
    start,
    beatTimes: Array.from({ length: bpb }, (_, i) => start + i * (measureDur() / bpb)),
    beatOffset,                              // 全曲第几拍(推算扫弦细分序号用)
    slots: Array.from({ length: bpb }, () => ({ chords: [], words: [] })),
  };
}

// 词落入小节内哪一拍:取 <= t 的最后一拍(管线版拍点非均匀,beatTimes 已按真实拍点生成)
function slotColFor(measure, t) {
  const bpb = measure.slots.length;
  let col = binarySearchLast(measure.beatTimes.map((x) => ({ time: x })), t, 'time');
  if (col < 0) col = 0;
  return Math.min(bpb - 1, col);
}

function buildUniformMeasures() {
  const bpb = state.timing.beatsPerBar;
  let maxT = 0;
  if (state.chords.length) maxT = state.chords[state.chords.length - 1].time;
  if (state.words.length) maxT = Math.max(maxT, state.words[state.words.length - 1].end - subtitleOffset());
  const lastN = Math.max(0, measureIndex(maxT));

  const measures = [];
  for (let n = 0; n <= lastN; n++) measures.push(newMeasure(n, measureStart(n), bpb, n * bpb));
  const clampN = (idx) => Math.max(0, Math.min(measures.length - 1, idx));

  state.chords.forEach((ch) => {
    const n = clampN(measureIndex(ch.time));
    measures[n].slots[slotColFor(measures[n], ch.time)].chords.push(ch);
  });
  state.words.forEach((w) => {
    const n = clampN(measureIndex(w.start - subtitleOffset()));
    measures[n].slots[slotColFor(measures[n], w.start - subtitleOffset())].words.push({ ...w });
  });
  state.measures = measures;
}

function buildMeasuresFromDownbeats(info) {
  const bpb = effBeats();
  const offset = state.timing.offset;
  const beats = info.beats.map((b) => ({ ...b, time: b.time + offset }));

  const starts = [];
  let lastStart = -Infinity;
  for (const b of beats) {
    if (b.pos === 1 && b.time - lastStart > MIN_CHORD_DELTA) {
      starts.push(b.time);
      lastStart = b.time;
    }
  }
  if (!starts.length) {
    state.measures = [];
    return;
  }
  if (starts[0] > PICKUP_MEASURE_MAX) starts.unshift(0);

  const measures = starts.map((start, n) => newMeasure(n, start, bpb, n * bpb));
  const clampN = (idx) => Math.max(0, Math.min(measures.length - 1, idx));

  // 每小节真实拍点 → beatTimes(pickup 不足 bpb 拍时按均分补齐,超出并入末拍)
  measures.forEach((m, i) => {
    const next = measures[i + 1]?.start ?? m.start + measureDur();
    const own = beats.filter((b) => b.time >= m.start && b.time < next).map((b) => b.time);
    if (own.length >= bpb) {
      m.beatTimes = own.slice(0, bpb);
    } else if (own.length > 1) {
      m.beatTimes = own.slice();
      const last = own[own.length - 1];
      const step = (next - last) / (bpb - own.length + 1);
      for (let k = own.length; k < bpb; k++) m.beatTimes.push(last + step * (k - own.length + 1));
    } else {
      m.beatTimes = Array.from({ length: bpb }, (_, k) => m.start + (k * (next - m.start)) / bpb);
    }
  });

  state.chords.forEach((ch) => {
    const n = clampN(binarySearchLast(measures, ch.time, 'start'));
    measures[n].slots[slotColFor(measures[n], ch.time)].chords.push(ch);
  });
  state.words.forEach((w) => {
    const t = w.start - subtitleOffset();
    const n = clampN(binarySearchLast(measures, t, 'start'));
    measures[n].slots[slotColFor(measures[n], t)].words.push({ ...w });
  });
  state.measures = measures;
}

// 长音填格:某词与下一词相隔 ≥2 小节时,中间空小节用淡化该词填充(不跨段)
function applyHeldWords() {
  if (!state.measures.length || !state.words.length) return;
  const showSections = state.tabSettings.sections !== false && state.sections.length > 0;

  const wiToN = new Map();
  for (const m of state.measures) {
    for (const slot of m.slots) {
      for (const w of slot.words) {
        if (Number.isInteger(w.wi)) wiToN.set(w.wi, m.n);
      }
    }
  }
  const placed = [...wiToN.entries()].sort((a, b) => a[0] - b[0]);

  for (let k = 0; k < placed.length - 1; k++) {
    const [wi, n] = placed[k];
    const [, nextN] = placed[k + 1];
    if (nextN - n < 2) continue;
    const word = state.words[wi]?.word;
    if (!word) continue;
    const secN = showSections ? binarySearchLast(state.sections, state.measures[n].start, 'time') : -1;
    let fills = 0;
    for (let m = n + 1; m < nextN && fills < MAX_HELD_FILL; m++) {
      if (showSections) {
        const sIdx = binarySearchLast(state.sections, state.measures[m].start, 'time');
        if (sIdx > secN) break;
      }
      state.measures[m].slots[0].words.push({ word, held: true });
      fills++;
    }
  }
}

// ───────────────────────────────────────────────
// 6. 和弦指法库(和弦图数据源)
// ───────────────────────────────────────────────
// positions 元素:{frets,fingers,barres,capo}(面板解析态)或 "frets|fingers|barres|capo" 原始串
function lookupLocalPositions(name) {
  const subset = window.PANEL_SUBSET?.chords;
  if (subset && subset[name]) return subset[name];
  const fromDb = window.chordsDisplay?.currentSongData?.chordPositions;
  if (fromDb && fromDb[name]) return fromDb[name];
  return null;
}

// 拉一次 chords.complete.js 文本,按名正则抽取(面板同款做法,避免整库驻留内存)
async function fetchPositionsFromLibrary(names) {
  if (!state.positionsTextPromise) {
    state.positionsTextPromise = window.ycLoader?.text?.('data/chords.complete.js') || Promise.resolve('');
    state.positionsTextPromise.catch(() => { state.positionsTextPromise = null; });
  }
  let source = '';
  try { source = await state.positionsTextPromise; } catch { source = ''; }
  if (!source) return;

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of names) {
    if (!name) continue;   // names 只含缺失项,直接覆写占位 null
    const entry = source.match(new RegExp(`"${esc(name)}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    if (entry) {
      const positions = [];
      const re = /"((?:\\.|[^"\\])*)"/g;
      let m;
      while ((m = re.exec(entry[1])) !== null) positions.push(m[1]);
      state.positionsCache.set(name, positions.length ? positions : null);
    } else {
      state.positionsCache.set(name, null);
    }
  }
}

// 异步补齐缺失指法并回填 DOM 占位
function ensureDiagramPositions(names) {
  const missing = [];
  for (const nm of names) {
    if (nm === 'N' || nm === '') continue;
    if (state.positionsCache.has(nm)) continue;
    const local = lookupLocalPositions(nm);
    if (local && (Array.isArray(local) ? local.length : true)) {
      state.positionsCache.set(nm, local);
    } else {
      missing.push(nm);
    }
  }
  if (!missing.length) return;

  // 先置 null 占位(本轮内防止重复收集),文本到位后回填 DOM
  missing.forEach((nm) => state.positionsCache.set(nm, null));
  fetchPositionsFromLibrary(missing).then(() => {
    if (!state.enabled || !state.container) return;
    state.container.querySelectorAll('[data-diag]').forEach((el) => {
      if (el.dataset.filled === '1') return;
      const nm = el.dataset.diag;
      const svg = positionsCacheGet(nm);
      el.dataset.filled = '1';
      el.innerHTML = svg || `<span class="yc-t-diag-none" title="No fingering in library">♪</span>`;
    });
  });
}

function positionsCacheGet(name) {
  const positions = state.positionsCache.get(name);
  if (!positions || !positions.length) return null;
  const first = Array.isArray(positions) ? positions[0] : positions;
  return buildDiagramSvg(first);
}

// 紧凑指法 → 迷你和弦图 SVG(6 弦 4 品,含 x/o 标记/横按/起始品号;currentColor 随主题)
function buildDiagramSvg(position) {
  if (!position) return null;
  const raw = typeof position === 'string' ? position : `${position.frets || ''}|${position.fingers || ''}|${position.barres || ''}`;
  const [fretsStr = '', , barresStr = ''] = String(raw).split('|');
  const decode = (ch) => (ch === 'x' ? null : ch >= 'a' && ch <= 'z' ? ch.charCodeAt(0) - 87 : parseInt(ch, 10));
  const frets = fretsStr.slice(0, 6).split('').map(decode);
  if (!frets.length) return null;

  const numeric = frets.filter((f) => f !== null && !isNaN(f) && f > 0);
  const startFret = numeric.length ? Math.min(...numeric) : 1;
  const NUM_FRETS = 4;

  // 几何(W×H 适配 4 品迷你图)
  const W = 48, H = 54;
  const x0 = 8, x1 = W - 5;
  const markY = 7;                 // x/o 标记行
  const nutY = 13;
  const bottomY = H - 4;
  const fretH = (bottomY - nutY) / NUM_FRETS;
  const strX = (i) => x0 + (i * (x1 - x0)) / 5;

  let s = `<svg class="yc-t-diagsvg" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;

  // 品丝(横线)与弦(竖线)
  for (let f = 0; f <= NUM_FRETS; f++) {
    const y = nutY + f * fretH;
    const isNut = f === 0 && startFret === 1;
    s += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"${isNut ? ' class="nut"' : ''}/>`;
  }
  for (let i = 0; i < 6; i++) {
    s += `<line x1="${strX(i)}" x2="${strX(i)}" y1="${nutY}" y2="${bottomY}"/>`;
  }
  // 起始品号(>1 品的和弦)
  if (startFret > 1) {
    s += `<text x="${x0 - 2}" y="${nutY + fretH * 0.75}" text-anchor="end">${startFret}</text>`;
  }

  // 空弦/闷弦标记
  frets.forEach((f, i) => {
    const x = strX(i);
    if (f === 0) s += `<circle cx="${x}" cy="${markY}" r="2.1" class="open"/>`;
    else if (f === null) s += `<text x="${x}" y="${markY + 2.4}" text-anchor="middle" class="mute">×</text>`;
  });

  // 横按(barres):同一品 ≥2 弦 → 圆头粗线,覆盖弦不再单独画点
  const covered = new Set();
  const barreList = String(barresStr).match(/\d+|[a-z]/gi) || [];
  barreList.forEach((b) => {
    const fret = isNaN(b) ? b.charCodeAt(0) - 87 : parseInt(b, 10);
    const strings = frets.map((f, i) => (f === fret ? i : -1)).filter((i) => i >= 0);
    if (strings.length < 2) return;
    const y = nutY + (fret - startFret + 0.5) * fretH;
    const from = Math.min(...strings), to = Math.max(...strings);
    s += `<line x1="${strX(from)}" x2="${strX(to)}" y1="${y}" y2="${y}" class="barre"/>`;
    strings.forEach((i) => covered.add(i));
  });

  // 按弦点
  frets.forEach((f, i) => {
    if (f === null || f === 0 || covered.has(i)) return;
    if (f < startFret || f >= startFret + NUM_FRETS) return; // 超出显示窗口的品省略(极少见)
    const cx = strX(i);
    const cy = nutY + (f - startFret + 0.5) * fretH;
    s += `<circle cx="${cx}" cy="${cy}" r="3.3" class="dot"/>`;
  });

  s += '</svg>';
  return s;
}

// ───────────────────────────────────────────────
// 7. 渲染
// ───────────────────────────────────────────────
function patternInfo() {
  return PATTERNS[state.tabSettings.pattern] || PATTERNS[DEFAULT_PATTERN];
}

// 词 → 高亮/点击可用的 span 序列(长音填格词淡化且不可点)
function wordSpansHtml(words) {
  return words.map((w) => (
    w.held
      ? `<span class="yc-t-word yc-t-word-held">${escapeHtml(w.word)}</span>`
      : `<span class="yc-t-word" data-wi="${w.wi}" data-time="${w.start.toFixed(3)}">${escapeHtml(w.word)}</span>`
  )).join(' ');
}

function buildToolbarHtml() {
  const t = state.timing;
  const mode = state.pipeline?.mode || 'inferred';
  const info = mode === 'pipeline' ? state.pipeline.info : null;
  const bpmVal = info ? info.bpm.toFixed(1) : Math.round(t.bpm);
  const beatsVal = info && VALID_BEATS.includes(info.meter) ? info.meter : t.beatsPerBar;
  const pat = patternInfo();
  return `
    <div class="yc-t-toolbar"${mode === 'pipeline' ? ' data-mode="pipeline"' : ''}>
      <label class="yc-t-tb-item">Source
        <select class="yc-t-src-select" title="Timing source — Pipeline: real madmom downbeats; Estimate: inferred constant-BPM grid">
          <option value="auto"${t.source === 'auto' ? ' selected' : ''}>Auto</option>
          <option value="inferred"${t.source === 'inferred' ? ' selected' : ''}>Estimate</option>
          <option value="pipeline"${t.source === 'pipeline' ? ' selected' : ''}>Pipeline</option>
        </select>
      </label>
      <label class="yc-t-tb-item">BPM
        <input type="number" class="yc-t-bpm-input" min="${BPM_MIN}" max="${BPM_MAX}" step="1" value="${bpmVal}">
      </label>
      <button class="yc-t-tb-btn yc-t-bpm-half" title="Halve BPM">÷2</button>
      <button class="yc-t-tb-btn yc-t-bpm-double" title="Double BPM">×2</button>
      <button class="yc-t-tb-btn yc-t-bpm-auto" title="Estimate BPM from chord changes">Auto</button>
      <label class="yc-t-tb-item">Beats
        <select class="yc-t-beats-select">
          <option value="3"${beatsVal === 3 ? ' selected' : ''}>3</option>
          <option value="4"${beatsVal === 4 ? ' selected' : ''}>4</option>
          <option value="6"${beatsVal === 6 ? ' selected' : ''}>6</option>
        </select>
      </label>
      <span class="yc-t-tb-item">Offset
        <button class="yc-t-tb-btn yc-t-offset-minus" title="Shift grid 0.5s earlier">−0.5</button>
        <span class="yc-t-offset-val">${t.offset.toFixed(1)}s</span>
        <button class="yc-t-tb-btn yc-t-offset-plus" title="Shift grid 0.5s later">+0.5</button>
      </span>
      <label class="yc-t-tb-item" title="Strumming pattern shown on the TAB staff">Strum
        <select class="yc-t-pattern-select">
          ${VALID_PATTERNS.map((id) => `<option value="${id}"${state.tabSettings.pattern === id ? ' selected' : ''}>${escapeHtml(PATTERNS[id].label)}</option>`).join('')}
        </select>
      </label>
      <button class="yc-t-tb-btn yc-t-diagrams-toggle${state.tabSettings.diagrams !== false ? ' yc-t-on' : ''}" title="Toggle chord diagrams">Diagrams</button>
      <button class="yc-t-tb-btn yc-t-bars-toggle" title="Measures per system">Bars ${state.tabSettings.bars}</button>
      <button class="yc-t-tb-btn yc-t-sections-toggle${state.tabSettings.sections !== false ? ' yc-t-on' : ''}" title="Toggle section headers">Sections</button>
      ${info ? `<span class="yc-t-src-info" title="Detected by local pipeline (madmom RNN+DBN)">🎼 ${info.bpm.toFixed(1)} BPM · ${info.meter}/${info.meter === 6 ? 8 : 4} · madmom</span>` : ''}
    </div>
    <div class="yc-t-legend">🎸 TAB staff shows strum direction${pat.steps.length ? ` — pattern: <b>${escapeHtml(pat.label)}</b>` : ' (pattern off)'} · click any word / measure to seek</div>`;
}

// 单个 system(一行谱):四行共享同一套固定列宽(对齐的根基:
// fr/max-content 下各行内容宽不同会导致列边界漂移,故列宽统一由 JS 计算的 --yc-t-colw 决定)
function buildSystemHtml(sysMeasures, sysIndex) {
  const bpb = sysMeasures[0]?.slots.length || effBeats();
  const totalCols = sysMeasures.length * bpb;
  const showDiagrams = state.tabSettings.diagrams !== false;
  const pat = patternInfo();
  const div = pat.divisions;

  // 换和弦点:遍历所有槽位,和弦与前一槽不同 → 该槽记和弦图/名字
  let prevGi = -1;
  const chordMarks = []; // { col, name, gi, time }
  sysMeasures.forEach((m, mi) => {
    m.slots.forEach((slot, col) => {
      if (!slot.chords.length) return;
      const ch = slot.chords[slot.chords.length - 1]; // 槽内最后一个和弦生效
      if (ch.gi !== prevGi) {
        chordMarks.push({ col: mi * bpb + col, name: ch.name, gi: ch.gi, time: ch.time });
        prevGi = ch.gi;
      }
    });
  });

  let html = `<div class="yc-t-system" data-sys="${sysIndex}"><div class="yc-t-sys-scroll"><div class="yc-t-sys-body" style="--yc-t-cols:${totalCols};--yc-t-div:${div}">`;

  // 行 1:小节号
  html += '<div class="yc-t-nums">';
  sysMeasures.forEach((m, mi) => {
    html += `<span class="yc-t-num yc-t-cell" data-m="${m.n}" data-start="${m.start.toFixed(3)}" style="grid-column:${mi * bpb + 1} / span ${bpb}">${m.n + 1}</span>`;
  });
  html += '</div>';

  // 行 2:和弦图(或和弦名 chip)
  html += `<div class="yc-t-diagrams${showDiagrams ? '' : ' yc-t-diagrams-off'}">`;
  for (let c = 0; c < totalCols; c++) html += '<i class="yc-t-cell yc-t-dcell" aria-hidden="true"></i>'; // 占位网格
  if (chordMarks.length) {
    for (const mark of chordMarks) {
      if (mark.name === 'N' || !mark.name) continue;
      const disp = displayName(mark.name);
      const svg = positionsCacheGet(mark.name);
      html += `<span class="yc-t-diag yc-t-cell" data-m="${sysMeasures[Math.floor(mark.col / bpb)].n}" data-gi="${mark.gi}" data-time="${mark.time.toFixed(3)}" style="grid-column:${mark.col + 1}" title="${escapeHtml(disp)}">`
        + `<span class="yc-t-diag-name">${escapeHtml(disp)}</span>`
        + `<span class="yc-t-diag-box"${svg ? '' : ` data-diag="${escapeHtml(mark.name)}"`}>${svg || ''}</span>`
        + '</span>';
    }
  }
  html += '</div>';

  // 行 3:六线谱 + 扫弦箭头(箭头格也是同列网格)
  html += '<div class="yc-t-staff">';
  html += '<svg class="yc-t-lines" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">'
    + Array.from({ length: 6 }, (_, i) => `<line x1="0" x2="100" y1="${i * 6.2 + 0.9}" y2="${i * 6.2 + 0.9}"/>`).join('')
    + '</svg>';
  html += '<div class="yc-t-slots">';
  sysMeasures.forEach((m, mi) => {
    for (let col = 0; col < bpb; col++) {
      for (let sub = 0; sub < div; sub++) {
        const step = pat.steps.length ? pat.steps[(col * div + sub) % pat.steps.length] : '';
        const arrow = step === 'D' ? '<svg class="yc-t-ar" viewBox="0 0 10 26" aria-hidden="true"><path d="M5 2 V21"/><path class="head" d="M1.5 17.5 L5 22.5 L8.5 17.5"/></svg>'
          : step === 'U' ? '<svg class="yc-t-ar up" viewBox="0 0 10 26" aria-hidden="true"><path d="M5 24 V5"/><path class="head" d="M1.5 8.5 L5 3.5 L8.5 8.5"/></svg>'
          : '';
        // 小节线只画在末拍最后一个细分格(避免同一边框堆叠)
        const isBarline = col === bpb - 1 && sub === div - 1;
        html += `<span class="yc-t-slot yc-t-cell${isBarline ? ' yc-t-barline' : ''}" data-m="${m.n}" data-col="${col}" data-sub="${sub}" data-key="${m.n}-${col}-${sub}" data-start="${m.beatTimes[col].toFixed(3)}">${arrow}</span>`;
      }
    }
  });
  html += '</div></div>';

  // 行 4:歌词 —— 稀疏(词数 ≤ 拍数)逐拍落格保证对齐;
  // 过密(快唱段多词同拍,36px 拍格装不下)整小节合并为流式格,词内联排布保可读
  html += '<div class="yc-t-lyrics">';
  sysMeasures.forEach((m, mi) => {
    const wordCount = m.slots.reduce((n, s) => n + s.words.length, 0);
    if (wordCount > bpb) {
      const flowWords = m.slots.flatMap((s) => s.words);
      html += `<span class="yc-t-lcell yc-t-cell yc-t-lflow yc-t-barline" data-m="${m.n}" style="grid-column:${mi * bpb + 1} / span ${bpb}">${wordSpansHtml(flowWords)}</span>`;
      return;
    }
    for (let col = 0; col < bpb; col++) {
      const lastCol = col === bpb - 1;
      html += `<span class="yc-t-lcell yc-t-cell${lastCol ? ' yc-t-barline' : ''}" data-m="${m.n}">${wordSpansHtml(m.slots[col].words)}</span>`;
    }
  });
  html += '</div>';

  html += '</div></div></div>';
  return html;
}

function renderView() {
  const container = state.container;
  if (!container) return;
  ensureCss();

  if (!state.chords.length) {
    container.innerHTML = '<div class="yc-t-empty">No chords in library for this video — open the Chords panel once to analyze, then reopen this view</div>';
    resetHighlightCache();
    return;
  }

  const scrollTop = container.scrollTop;

  let html = '<div class="yc-tab-view">';
  html += buildToolbarHtml();
  html += '<div class="yc-t-grid">';

  const showSections = state.tabSettings.sections !== false && state.sections.length > 0;
  const barsPerSys = VALID_BARS.includes(state.tabSettings.bars) ? state.tabSettings.bars : 4;
  let lastSectionIdx = -1;
  let sysIndex = 0;

  for (let i = 0; i < state.measures.length; i += barsPerSys) {
    const sysMeasures = state.measures.slice(i, i + barsPerSys);
    if (showSections) {
      const sIdx = binarySearchLast(state.sections, sysMeasures[0].start, 'time');
      if (sIdx >= 0 && sIdx !== lastSectionIdx) {
        const s = state.sections[sIdx];
        html += `<div class="yc-t-section" data-si="${sIdx}">${escapeHtml(s.name)}</div>`;
        lastSectionIdx = sIdx;
      }
    }
    html += buildSystemHtml(sysMeasures, sysIndex++);
  }
  html += '</div></div>';

  container.innerHTML = html;
  container.scrollTop = scrollTop;
  bindToolbar(container);
  bindGridClicks(container);
  resetHighlightCache();
  fitColumnWidth();
  observeResize();

  // 异步补齐缺指法的和弦图
  ensureDiagramPositions([...new Set(state.chords.map((c) => c.name).filter((n) => n && n !== 'N'))]);
}

// 固定列宽计算:优先铺满容器(和弦图/歌词有呼吸空间),下限 36px 触发横向滚动
function fitColumnWidth() {
  const root = state.container?.querySelector('.yc-tab-view');
  if (!root) return;
  const bpb = effBeats();
  const barsPerSys = VALID_BARS.includes(state.tabSettings.bars) ? state.tabSettings.bars : 4;
  const totalCols = barsPerSys * bpb;
  const avail = Math.max(120, (state.container.clientWidth || 360) - 26);
  const colw = Math.max(36, Math.floor(avail / totalCols));
  root.style.setProperty('--yc-t-colw', `${colw}px`);
}

// 面板宽度变化(手动拉宽/全屏) → 只重算列宽,不重建 DOM
function observeResize() {
  if (typeof ResizeObserver === 'undefined' || !state.container) return;
  if (state.resizeObserver) state.resizeObserver.disconnect();
  state.resizeObserver = new ResizeObserver(() => {
    if (!state.enabled) return;
    fitColumnWidth();
  });
  state.resizeObserver.observe(state.container);
}

function resetHighlightCache() {
  state.lastMeasureIdx = null;
  state.lastWordIdx = null;
  state.lastChordIdx = null;
  state.lastSectionIdx = null;
  state.lastSlotKey = null;
  state.lastScrollMeasureIdx = null;
}

// ───────────────────────────────────────────────
// 8. 工具条与网格交互
// ───────────────────────────────────────────────
function setBpm(bpm) {
  state.timing.bpm = clampBpm(Math.round(bpm));
  scheduleSaveTiming();
  rebuildAndRender();
}

function setBeats(beats) {
  if (!VALID_BEATS.includes(beats)) return;
  state.timing.beatsPerBar = beats;
  scheduleSaveTiming();
  rebuildAndRender();
}

function setSource(source) {
  if (!VALID_SOURCES.includes(source)) return;
  state.timing.source = source;
  scheduleSaveTiming();
  rebuildAndRender();
}

function shiftOffset(delta) {
  state.timing.offset = Math.round((state.timing.offset + delta) * 10) / 10;
  scheduleSaveTiming();
  rebuildAndRender();
}

function rebuildAndRender() {
  buildMeasures();
  renderView();
  const video = getVideoEl();
  if (video) updateHighlight(video.currentTime);
}

function bindToolbar(container) {
  const root = container.querySelector('.yc-tab-view');
  if (!root) return;

  const bpmInput = root.querySelector('.yc-t-bpm-input');
  bpmInput?.addEventListener('change', () => {
    const v = parseFloat(bpmInput.value);
    if (Number.isFinite(v)) setBpm(v);
  });
  root.querySelector('.yc-t-bpm-half')?.addEventListener('click', () => setBpm(state.timing.bpm / 2));
  root.querySelector('.yc-t-bpm-double')?.addEventListener('click', () => setBpm(state.timing.bpm * 2));
  root.querySelector('.yc-t-bpm-auto')?.addEventListener('click', () => {
    setBpm(estimateBpmFromChords(state.chords, state.timing.beatsPerBar));
  });
  root.querySelector('.yc-t-beats-select')?.addEventListener('change', (e) => setBeats(parseInt(e.target.value, 10)));
  root.querySelector('.yc-t-src-select')?.addEventListener('change', (e) => setSource(e.target.value));
  root.querySelector('.yc-t-offset-minus')?.addEventListener('click', () => shiftOffset(-0.5));
  root.querySelector('.yc-t-offset-plus')?.addEventListener('click', () => shiftOffset(0.5));

  root.querySelector('.yc-t-pattern-select')?.addEventListener('change', (e) => {
    const id = e.target.value;
    if (!VALID_PATTERNS.includes(id)) return;
    state.tabSettings.pattern = id;
    scheduleSaveTab();
    rebuildAndRender();
  });
  root.querySelector('.yc-t-diagrams-toggle')?.addEventListener('click', (e) => {
    state.tabSettings.diagrams = state.tabSettings.diagrams === false;
    scheduleSaveTab();
    rebuildAndRender();
    e.currentTarget?.classList?.toggle('yc-t-on', state.tabSettings.diagrams !== false);
  });
  root.querySelector('.yc-t-bars-toggle')?.addEventListener('click', (e) => {
    state.tabSettings.bars = state.tabSettings.bars === 4 ? 2 : 4;
    scheduleSaveTab();
    rebuildAndRender();
    e.currentTarget.textContent = `Bars ${state.tabSettings.bars}`;
  });
  root.querySelector('.yc-t-sections-toggle')?.addEventListener('click', (e) => {
    state.tabSettings.sections = state.tabSettings.sections === false;
    scheduleSaveTab();
    rebuildAndRender();
    e.currentTarget?.classList?.toggle('yc-t-on', state.tabSettings.sections !== false);
  });
}

function bindGridClicks(container) {
  const grid = container.querySelector('.yc-t-grid');
  if (!grid) return;
  grid.addEventListener('click', (event) => {
    const video = getVideoEl();
    if (!video) return;
    const wordEl = event.target.closest('.yc-t-word:not(.yc-t-word-held)');
    if (wordEl) {
      const t = parseFloat(wordEl.dataset.time);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t - subtitleOffset());
      return;
    }
    const diagEl = event.target.closest('.yc-t-diag');
    if (diagEl) {
      const t = parseFloat(diagEl.dataset.time);
      if (Number.isFinite(t)) { video.currentTime = Math.max(0, t); return; }
    }
    const cellEl = event.target.closest('.yc-t-cell[data-start]');
    if (cellEl) {
      const t = parseFloat(cellEl.dataset.start);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t);
    }
  });
}

// ───────────────────────────────────────────────
// 9. 播放高亮同步
// ───────────────────────────────────────────────
function findMeasureIndex(t) {
  if (state.pipeline?.mode === 'pipeline') {
    return binarySearchLast(state.measures, t, 'start');
  }
  return measureIndex(t);
}

// 当前扫弦细分槽 key:小节内插值出第几拍的第几个细分
function findSlotKey(t) {
  const mIdx = findMeasureIndex(t);
  if (mIdx < 0 || mIdx >= state.measures.length) return null;
  const m = state.measures[mIdx];
  const bpb = m.slots.length;
  let col = 0;
  for (let i = 0; i < bpb; i++) {
    if (m.beatTimes[i] <= t) col = i;
    else break;
  }
  const beatStart = m.beatTimes[col];
  const beatEnd = col < bpb - 1 ? m.beatTimes[col + 1] : beatStart + beatDur();
  const frac = beatEnd > beatStart ? (t - beatStart) / (beatEnd - beatStart) : 0;
  const sub = Math.min(patternInfo().divisions - 1, Math.max(0, Math.floor(frac * patternInfo().divisions)));
  return `${m.n}-${col}-${sub}`;
}

function updateHighlight(currentTime) {
  if (!state.enabled || !state.container) return;
  const grid = state.container.querySelector('.yc-t-grid');
  if (!grid) return;

  let mIdx = findMeasureIndex(currentTime);
  if (mIdx >= state.measures.length) mIdx = state.measures.length - 1;

  const wIdx = binarySearchLast(state.words, currentTime + subtitleOffset(), 'start');
  const cIdx = binarySearchLast(state.chords, currentTime, 'time');
  const slotKey = findSlotKey(currentTime);

  // 当前小节:所有行中 data-m 匹配的格子着色(跨行高亮一整小节)
  if (mIdx !== state.lastMeasureIdx) {
    grid.querySelectorAll('.yc-t-cell.yc-t-mactive').forEach((el) => el.classList.remove('yc-t-mactive'));
    if (mIdx >= 0) {
      const cells = grid.querySelectorAll(`.yc-t-cell[data-m="${mIdx}"]`);
      cells.forEach((el) => el.classList.add('yc-t-mactive'));
      if (cells.length) maybeScrollToActive(cells[0], mIdx);
    }
    state.lastMeasureIdx = mIdx;
  }

  // 当前扫弦槽(节奏指示)
  if (slotKey !== state.lastSlotKey) {
    grid.querySelectorAll('.yc-t-slot.yc-t-slot-active').forEach((el) => el.classList.remove('yc-t-slot-active'));
    if (slotKey) {
      const el = grid.querySelector(`.yc-t-slot[data-key="${slotKey}"]`);
      if (el) el.classList.add('yc-t-slot-active');
    }
    state.lastSlotKey = slotKey;
  }

  // 当前词
  if (wIdx !== state.lastWordIdx) {
    grid.querySelectorAll('.yc-t-word.yc-t-active').forEach((el) => el.classList.remove('yc-t-active'));
    if (wIdx >= 0) {
      const el = grid.querySelector(`.yc-t-word[data-wi="${wIdx}"]`);
      if (el) el.classList.add('yc-t-active');
    }
    state.lastWordIdx = wIdx;
  }

  // 当前和弦(换和弦点上的和弦图)
  if (cIdx !== state.lastChordIdx) {
    grid.querySelectorAll('.yc-t-diag.yc-t-active').forEach((el) => el.classList.remove('yc-t-active'));
    if (cIdx >= 0) {
      const el = grid.querySelector(`.yc-t-diag[data-gi="${cIdx}"]`);
      if (el) el.classList.add('yc-t-active');
    }
    state.lastChordIdx = cIdx;
  }

  // 段落头
  if (state.sections.length) {
    const sIdx = binarySearchLast(state.sections, currentTime, 'time');
    if (sIdx !== state.lastSectionIdx) {
      grid.querySelectorAll('.yc-t-section.yc-t-active').forEach((el) => el.classList.remove('yc-t-active'));
      if (sIdx >= 0) {
        const el = grid.querySelector(`.yc-t-section[data-si="${sIdx}"]`);
        if (el) el.classList.add('yc-t-active');
      }
      state.lastSectionIdx = sIdx;
    }
  }

  // 补发预览面板时间事件(被本视图提前 return 跳过的原逻辑)
  if (window.ycChordsPreviewPanel?.isVisible) {
    window.dispatchEvent(
      new CustomEvent('yc:timeUpdate', { detail: { time: currentTime, isScrubbing: false } })
    );
  }
}

function autoScrollWanted() {
  const syncTog = document.querySelector('#sync-youtube-toggle');
  const autoTog = document.querySelector('#auto-scroll-toggle');
  return syncTog?.classList.contains('active') || autoTog?.classList.contains('active');
}

function maybeScrollToActive(cell, measureIdx) {
  if (!autoScrollWanted()) return;
  if (state.lastScrollMeasureIdx === measureIdx) return;
  state.lastScrollMeasureIdx = measureIdx;
  try {
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  } catch {
    cell.scrollIntoView();
  }
}

// ───────────────────────────────────────────────
// 10. 全局事件
// ───────────────────────────────────────────────
function attachGlobalListenersOnce() {
  if (state.globalListenersAttached) return;
  state.globalListenersAttached = true;

  const rerenderOnCapo = () => {
    if (!state.enabled) return;
    buildMeasures();
    renderView();
    const video = getVideoEl();
    if (video) updateHighlight(video.currentTime);
  };
  window.addEventListener('yc:capoChanged', rerenderOnCapo);
  window.addEventListener('yc:capoFeatureToggled', rerenderOnCapo);
  window.addEventListener('yc:keyTransposeChanged', rerenderOnCapo);

  window.addEventListener('yc:panelClosing', () => {
    state.enabled = false;
    state.container = null;
    state.chords = [];
    state.words = [];
    state.sections = [];
    state.beatsData = null;
    state.pipeline = null;
    state.measures = [];
    state.resizeObserver?.disconnect();
    resetHighlightCache();
  });

  window.addEventListener('yc:timeUpdate', (e) => {
    if (!state.enabled || !e.detail?.isScrubbing) return;
    const t = Number(e.detail.time);
    if (Number.isFinite(t)) updateHighlight(t);
  });
}

// ───────────────────────────────────────────────
// 11. 对外接口
// ───────────────────────────────────────────────
function onContentRendered(combinedData, authoritativeChords, container) {
  if (!window.tabViewEnabled) return;
  state.enabled = true;
  state.container = container || document.querySelector('.yt-lyrics-chords-panel .lyrics-chords-content');
  state.videoId = getVideoId();

  const data = extractData(combinedData, authoritativeChords);
  state.chords = data.chords;
  state.words = data.words;
  state.sections = data.sections;
  state.beatsData = window.chordsDisplay?.currentSongData?.beatsData || null;

  attachGlobalListenersOnce();

  const applySettingsAndRender = () => {
    if (state.settingsLoadedFor !== state.videoId) {
      state.timing = {
        ...DEFAULT_TIMING,
        bpm: estimateBpmFromChords(state.chords, DEFAULT_TIMING.beatsPerBar),
      };
      state.tabSettings = { ...DEFAULT_TAB_SETTINGS };
      state.settingsFromArchive = false;
      rebuildAndRender();
      loadSettings(state.videoId).then(rebuildAndRender).catch(() => {});
    } else {
      rebuildAndRender();
    }
  };

  if (!state.chords.length) {
    const vid = state.videoId;
    console.log('[TabChart] authoritative/inline chords empty — pulling from chord library…');
    pullChordsFromDb(vid).then((pulled) => {
      if (!pulled || state.enabled === false || state.videoId !== vid) return;
      pulled.chords.forEach((c, gi) => { c.gi = gi; });
      state.chords = pulled.chords;
      state.beatsData = pulled.beatsData;
      console.log('[TabChart] 🎸', pulled.chords.length, 'chords loaded from chord library');
      if (!state.settingsFromArchive) {
        state.timing.bpm = estimateBpmFromChords(state.chords, state.timing.beatsPerBar);
        scheduleSaveTiming();
      }
      applySettingsAndRender();
    });
  }
  applySettingsAndRender();
}

// 开关入口:与 Measure 视图互斥(面板内容只能被一个视图接管)
window.toggleTabView = async function () {
  const next = !window.tabViewEnabled;
  window.tabViewEnabled = next;

  const syncUpdate = { [SYNC_KEY]: next };
  if (next) {
    window.measureViewEnabled = false;
    syncUpdate.measureViewEnabled = false;
  }
  try {
    await chrome.storage.sync.set(syncUpdate);
  } catch (err) {
    console.warn('[TabChart] Failed to persist toggle:', err);
  }

  const tabToggleEl = document.querySelector('#tab-view-toggle');
  if (tabToggleEl) tabToggleEl.classList.toggle('active', next);
  if (next) {
    const measureToggleEl = document.querySelector('#measure-view-toggle');
    if (measureToggleEl) measureToggleEl.classList.remove('active');
  }

  if (!next) {
    state.enabled = false;
    state.container = null;
    state.chords = [];
    state.words = [];
    state.beatsData = null;
    state.pipeline = null;
    state.measures = [];
    state.resizeObserver?.disconnect();
    resetHighlightCache();
  }

  if (typeof window.refreshLyricsChordsPanel === 'function') {
    try {
      await window.refreshLyricsChordsPanel();
    } catch (err) {
      console.warn('[TabChart] Panel refresh failed:', err);
    }
  }
};

window.ycTabChart = {
  get isEnabled() { return state.enabled; },
  toggle: window.toggleTabView,
  onContentRendered,
  updateHighlight,
  onPanelClosing() {
    state.enabled = false;
    state.container = null;
    resetHighlightCache();
  },
};

// ───────────────────────────────────────────────
// 12. 初始化:读全局开关镜像到 window
// ───────────────────────────────────────────────
try {
  chrome.storage.sync.get([SYNC_KEY], (result) => {
    window.tabViewEnabled = result?.[SYNC_KEY] === true;
  });
} catch {
  window.tabViewEnabled = false;
}

// ───────────────────────────────────────────────
// 13. 样式(注入一次;currentColor 让六线谱/和弦图随主题变色)
// ───────────────────────────────────────────────
function ensureCss() {
  if (state.cssInjected || document.getElementById('yc-tab-chart-style')) {
    state.cssInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'yc-tab-chart-style';
  style.textContent = `
    .yc-tab-view { padding: 8px 12px 32px; --yc-t-colw: 44px; }
    .yc-t-toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 6px 8px; margin-bottom: 6px;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
      font-size: 12px;
    }
    .yc-t-tb-item { display: flex; align-items: center; gap: 4px; color: inherit; }
    .yc-t-bpm-input {
      width: 56px; background: transparent; color: inherit;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
      padding: 2px 4px; font-size: 12px;
    }
    .yc-t-tb-btn {
      background: transparent; color: inherit; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
      padding: 2px 6px; font-size: 11px;
    }
    .yc-t-tb-btn:hover { background: rgba(127,127,127,0.25); }
    .yc-t-tb-btn.yc-t-on { border-color: #3ea6ff; color: #3ea6ff; }
    .yc-t-beats-select, .yc-t-src-select, .yc-t-pattern-select {
      background: transparent; color: inherit;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
    }
    .yc-t-beats-select option, .yc-t-src-select option, .yc-t-pattern-select option { color: #111; }
    .yc-t-offset-val { min-width: 38px; text-align: center; }
    .yc-t-src-info { margin-inline-start: auto; font-size: 11px; opacity: 0.75; white-space: nowrap; }
    .yc-t-toolbar[data-mode="pipeline"] .yc-t-tb-item > .yc-t-bpm-input,
    .yc-t-toolbar[data-mode="pipeline"] .yc-t-bpm-half,
    .yc-t-toolbar[data-mode="pipeline"] .yc-t-bpm-double,
    .yc-t-toolbar[data-mode="pipeline"] .yc-t-bpm-auto,
    .yc-t-toolbar[data-mode="pipeline"] .yc-t-beats-select { opacity: 0.35; pointer-events: none; }
    .yc-t-legend { font-size: 11px; opacity: 0.65; margin: 0 2px 10px; }

    /* ── system:四行同列网格(固定列宽,行间严格对齐) ── */
    .yc-t-system { margin-bottom: 18px; }
    .yc-t-sys-scroll { overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
    .yc-t-sys-body { display: block; min-width: 100%; width: max-content; }
    .yc-t-nums, .yc-t-diagrams, .yc-t-slots, .yc-t-lyrics {
      display: grid;
      grid-template-columns: repeat(var(--yc-t-cols), var(--yc-t-colw));
    }
    .yc-t-num {
      font-size: 9px; font-style: italic; opacity: 0.5;
      padding-inline-start: 2px; cursor: pointer;
    }
    .yc-t-cell { min-width: 0; }

    /* 和弦图行 */
    .yc-t-diagrams { position: relative; min-height: 68px; align-items: end; }
    .yc-t-diagrams-off { min-height: 18px; }
    .yc-t-diagrams-off .yc-t-diag-box { display: none; }
    .yc-t-dcell { grid-row: 1; }
    .yc-t-diag {
      grid-row: 1; position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center;
      justify-self: center; cursor: pointer;
      padding: 0 2px; border-radius: 5px;
    }
    .yc-t-diag-name {
      font-size: 11px; font-weight: 700; white-space: nowrap;
      margin-bottom: 1px;
    }
    .yc-t-diag-box { display: block; line-height: 0; }
    .yc-t-diag-box .yc-t-diag-none { font-size: 16px; opacity: 0.4; }
    .yc-t-diagsvg { width: min(48px, calc(var(--yc-t-colw) + 16px)); height: auto; }
    .yc-t-diagsvg line { stroke: currentColor; stroke-width: 1; }
    .yc-t-diagsvg line.nut { stroke-width: 3; }
    .yc-t-diagsvg line.barre { stroke: currentColor; stroke-width: 3.4; stroke-linecap: round; }
    .yc-t-diagsvg circle { fill: none; stroke: currentColor; stroke-width: 1; }
    .yc-t-diagsvg circle.dot { fill: currentColor; stroke: none; }
    .yc-t-diagsvg text { fill: currentColor; font-size: 6.5px; font-family: inherit; }
    .yc-t-diag.yc-t-active {
      background: rgba(62,166,255,0.14);
      box-shadow: 0 0 0 1px #3ea6ff;
    }
    .yc-t-diag:hover { background: rgba(127,127,127,0.18); }

    /* 六线谱行 */
    .yc-t-staff { position: relative; min-height: 34px; }
    .yc-t-lines {
      position: absolute; inset: 1px 0; width: 100%; height: 32px;
      color: inherit; opacity: 0.55; pointer-events: none;
    }
    .yc-t-lines line { stroke: currentColor; stroke-width: 1; vector-effect: non-scaling-stroke; }
    /* 扫弦行:每拍拆成 --yc-t-div 个细分列(列宽 colw/div),节拍边界与其他行严格对齐;
       格子数 = 列数,杜绝 grid 折行(旧版 2× 格子挤进拍列会折成两行压住歌词) */
    .yc-t-slots {
      position: relative; height: 34px;
      grid-template-columns: repeat(calc(var(--yc-t-cols) * var(--yc-t-div, 1)), calc(var(--yc-t-colw) / var(--yc-t-div, 1)));
      grid-auto-rows: 34px;
    }
    .yc-t-slot {
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; align-self: stretch;
    }
    .yc-t-slot.yc-t-barline { border-inline-end: 1px solid currentColor; }
    .yc-t-ar { width: 9px; height: 26px; color: currentColor; opacity: 0.8; }
    .yc-t-ar path { stroke: currentColor; stroke-width: 1.6; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .yc-t-slot.yc-t-slot-active .yc-t-ar { color: #3ea6ff; opacity: 1; filter: drop-shadow(0 0 3px rgba(62,166,255,0.9)); }
    .yc-t-slot.yc-t-slot-active { background: rgba(62,166,255,0.12); }
    .yc-t-slot:hover { background: rgba(127,127,127,0.2); }

    /* 歌词行 */
    .yc-t-lcell {
      padding: 1px 3px; font-size: 12px; line-height: 1.3;
      overflow-wrap: anywhere; cursor: default;
    }
    /* 过密小节的流式格:整小节宽度内联排词,不再逐拍折行堆叠 */
    .yc-t-lflow { font-size: 11px; line-height: 1.25; padding: 1px 4px; }
    .yc-t-lflow .yc-t-word { padding: 0; }
    .yc-t-lcell.yc-t-barline { border-inline-end: 1px solid rgba(127,127,127,0.35); }
    .yc-t-word { cursor: pointer; border-radius: 3px; padding: 0 1px; }
    .yc-t-word:hover { background: rgba(127,127,127,0.25); }
    .yc-t-word.yc-t-active { color: #3ea6ff; font-weight: 600; }
    .yc-t-word.yc-t-word-held { opacity: 0.45; cursor: default; }
    .yc-t-word.yc-t-word-held:hover { background: transparent; }

    /* 当前小节跨行着色 */
    .yc-t-cell.yc-t-mactive { background: rgba(62,166,255,0.08); }
    .yc-t-num.yc-t-mactive { opacity: 1; color: #3ea6ff; font-weight: 700; }

    /* 段落头 */
    .yc-t-section {
      display: flex; align-items: center; gap: 8px;
      margin-top: 8px; padding: 2px 2px 0;
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; opacity: 0.7;
    }
    .yc-t-section::after { content: ""; flex: 1; height: 1px; background: currentColor; opacity: 0.25; }
    .yc-t-section.yc-t-active { opacity: 1; color: #3ea6ff; }
    .yc-t-empty { padding: 24px; text-align: center; opacity: 0.6; }

    /* RTL:谱面从右往左 */
    .yt-lyrics-chords-rtl .yc-t-sys-body,
    .yt-lyrics-chords-rtl .yc-t-slots,
    .yt-lyrics-chords-rtl .yc-t-lyrics,
    .yt-lyrics-chords-rtl .yc-t-nums,
    .yt-lyrics-chords-rtl .yc-t-diagrams { direction: rtl; }

    /* 亮色主题 */
    .yt-lyrics-chords-panel.sepia-theme .yc-t-toolbar,
    .yt-lyrics-chords-panel.light-theme .yc-t-toolbar { border-color: rgba(0,0,0,0.18); }
    .yt-lyrics-chords-panel.sepia-theme .yc-t-bpm-input,
    .yt-lyrics-chords-panel.sepia-theme .yc-t-tb-btn,
    .yt-lyrics-chords-panel.sepia-theme .yc-t-beats-select,
    .yt-lyrics-chords-panel.sepia-theme .yc-t-src-select,
    .yt-lyrics-chords-panel.sepia-theme .yc-t-pattern-select,
    .yt-lyrics-chords-panel.light-theme .yc-t-bpm-input,
    .yt-lyrics-chords-panel.light-theme .yc-t-tb-btn,
    .yt-lyrics-chords-panel.light-theme .yc-t-beats-select,
    .yt-lyrics-chords-panel.light-theme .yc-t-src-select,
    .yt-lyrics-chords-panel.light-theme .yc-t-pattern-select { border-color: rgba(0,0,0,0.25); }
    .yt-lyrics-chords-panel.sepia-theme .yc-t-lcell.yc-t-barline,
    .yt-lyrics-chords-panel.light-theme .yc-t-lcell.yc-t-barline { border-color: rgba(0,0,0,0.25); }
    .yt-lyrics-chords-panel.sepia-theme .yc-t-word.yc-t-active,
    .yt-lyrics-chords-panel.sepia-theme .yc-t-slot.yc-t-slot-active .yc-t-ar,
    .yt-lyrics-chords-panel.sepia-theme .yc-t-num.yc-t-mactive,
    .yt-lyrics-chords-panel.light-theme .yc-t-word.yc-t-active,
    .yt-lyrics-chords-panel.light-theme .yc-t-slot.yc-t-slot-active .yc-t-ar,
    .yt-lyrics-chords-panel.light-theme .yc-t-num.yc-t-mactive { color: #1e6fd9; }
    .yt-lyrics-chords-panel.sepia-theme .yc-t-diag.yc-t-active,
    .yt-lyrics-chords-panel.light-theme .yc-t-diag.yc-t-active { box-shadow: 0 0 0 1px #1e6fd9; background: rgba(30,111,217,0.12); }
    .yt-lyrics-chords-panel.sepia-theme .yc-t-cell.yc-t-mactive,
    .yt-lyrics-chords-panel.light-theme .yc-t-cell.yc-t-mactive { background: rgba(30,111,217,0.08); }
    .yt-lyrics-chords-panel.sepia-theme .yc-t-tb-btn.yc-t-on,
    .yt-lyrics-chords-panel.light-theme .yc-t-tb-btn.yc-t-on { color: #1e6fd9; border-color: #1e6fd9; }
  `;
  document.head.appendChild(style);
  state.cssInjected = true;
}
})();
