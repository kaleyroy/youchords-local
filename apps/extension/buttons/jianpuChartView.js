/* yc-module-scope */
// Jianpu Chart View (简谱视图) — 歌词 ↔ 唱名级数(1=do 2=re …)对照
// 两种数据模式(工具栏徽章区分):
//   旋律模式: local-companion Basic Pitch 旋律音符(melodyData)→ jianpurender
//             渲染标准简谱(级数+八度点+下划线/附点/延音线+休止+调号拍号+歌词对齐),
//             音高/时值来自模型 note events(真实 onset/offset),拍数由 madmom 节拍量化。
//   推算模式: 无 melodyData(旧缓存/管线未升级)时逐词标注和弦根音级数+唱名+词时长
//             量化时值(下划线/附点/延音线/休止),徽章标注「推算」;不伪造旋律。
// 调性: keyEstimator 估计,工具栏可手动覆盖;小调按歌本惯例 1=关系大调(如 Am → 1=C)。
// 与 Measure/TAB 互斥接管面板;默认关闭时零行为变化。
(function () {
'use strict';

// ───────────────────────────────────────────────
// 0. 常量与状态
// ───────────────────────────────────────────────
const DEFAULT_SETTINGS = { tonicOverride: null, modeOverride: null, solfegeRow: true, durationMarks: true, sections: true };
const LOCAL_KEY_PREFIX = 'yc_jianpu_';    // chrome.storage.local, per video
const SYNC_KEY = 'jianpuViewEnabled';     // chrome.storage.sync, global
const SAVE_DEBOUNCE_MS = 300;
const MIN_CHORD_DELTA = 0.05;             // 秒,过滤同点重复和弦
const MIN_MELODY_NOTES = 4;               // 旋律音符少于此数视为无数据 → 推算模式
const MIN_BEAT_DUR = 0.25;                // 秒,拍长下限(防 0 除/异常 BPM)
const MAX_BEAT_DUR = 1.5;                 // 秒,拍长上限
const VALID_BEATS = [3, 4, 6];
const VENDOR_PATH = 'vendor/jianpurender.iife.js'; // 暴露 window.jr (JianpuSVGRender)

// 音名 → pitch class(与 keyEstimator/chordRenderer 同口径,均用 ♯ 拼法)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
const NOTE_TO_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const ROOT_RE = /^([A-G](?:#|b|♯|♭)?)(.*)$/;
// 自然大调:级数 → 距主音半音数
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
// 非自然音级 → 就近唱名记法(歌本惯用 ♯1/♭3/♯4/♯5/♭7)
const CHROMATIC_DEGREE = {
  1: { degree: 1, acc: 1 },
  3: { degree: 3, acc: -1 },
  6: { degree: 4, acc: 1 },
  8: { degree: 5, acc: 1 },
  10: { degree: 7, acc: -1 },
};
const ACC_LABEL = { 1: '♯', '-1': '♭', 0: '' };
const SOLFEGE = { 1: 'do', 2: 're', 3: 'mi', 4: 'fa', 5: 'sol', 6: 'la', 7: 'si' };

const state = {
  enabled: false,           // 视图当前接管面板内容
  container: null,          // 被接管的容器(.lyrics-chords-content / #defaultLyricsSection)
  videoId: null,
  settings: { ...DEFAULT_SETTINGS },
  settingsLoadedFor: null,
  chords: [],               // [{ name, time }] 视频时间轴,已排序
  words: [],                // [{ word, start, end }] 字幕时间轴(扁平),已排序
  wiBase: new Map(),        // 词对象 → 扁平全局索引(行内词与扁平词同引用)
  lines: [],                // 行级歌词(推算模式布局用,含 chords/isInstrumental)
  sections: [],             // [{ name, time }] 段落时间轴
  beatsData: null,          // 管线下发 { bpm, meter, beats:[{time,pos}] }
  melodyData: null,         // Basic Pitch { engine, notes:[{start,dur,midi,conf}] }
  mode: 'estimate',         // 'melody' | 'estimate'
  rows: [],                 // 旋律模式分行的实例 [{ inst, div, startBeat, endBeat, notes }] (jianpurender 不换行,按小节切多段纵向堆叠)
  jrTime: [],               // 全部行音符拼接的秒时间轴(高亮二分用)
  jrRefs: [],               // jrTime[i] → { rowIdx, note }(与 jrTime 同长)
  // 高亮缓存(索引未变则不碰 DOM)
  lastWordIdx: null,
  lastChordIdx: null,
  lastLineIdx: null,
  lastSectionIdx: null,
  lastNoteIdx: null,
  lastRowIdx: null,
  lastScrollLineIdx: null,
  // 基础设施
  renderToken: 0,           // 异步旋律渲染的竞态令牌
  saveTimer: null,
  cssInjected: false,
  globalListenersAttached: false,
};

// ───────────────────────────────────────────────
// 1. 环境辅助
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

// 字幕时间轴 → 视频时间轴的偏移(与 getAdjustedSubtitleTime 口径一致)
function subtitleOffset() {
  const o = Number(window.subtitleState?.timing_offset);
  return Number.isFinite(o) ? o : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// 返回最后一个 key(arr 元素字段值)<= t 的索引,无则 -1
function binarySearchLast(arr, t, key) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// 数值数组版
function binarySearchLastNum(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ───────────────────────────────────────────────
// 2. 乐理:级数 / 唱名 / 调性
// ───────────────────────────────────────────────
// 相对主音(1)的 pitch class → { degree 1-7, acc -1|0|1 }
function degreeInfoForPc(pc, onePc) {
  const rel = (((pc - onePc) % 12) + 12) % 12;
  const scaleIdx = MAJOR_SCALE.indexOf(rel);
  if (scaleIdx >= 0) return { degree: scaleIdx + 1, acc: 0 };
  return CHROMATIC_DEGREE[rel] || { degree: 1, acc: 0 };
}

// 和弦根音解析 → { pc, suffix } | null(slash 和弦取 / 前)
function parseRoot(name) {
  let nm = String(name || '').trim();
  const slash = nm.indexOf('/');
  if (slash > 0) nm = nm.slice(0, slash);
  const m = ROOT_RE.exec(nm);
  if (!m) return null;
  const root = FLAT_TO_SHARP[m[1]] || m[1];
  const pc = NOTE_TO_PC[root];
  return pc === undefined ? null : { pc, suffix: m[2] || '' };
}

// 级数记谱后缀:小三和弦 m / 减三 ° / 其余(maj/sus/add/5…)不加
function numeralSuffix(suffix) {
  const s = String(suffix || '');
  if (/^m(?!aj)/i.test(s)) return 'm';
  if (/^(dim|°|o\b)/i.test(s)) return '°';
  return '';
}

// 和弦名 → { numeral: '♯4', solfege: 'fa', label: '♯4m' }(相对当前调的 1)
function chordDegree(chordName, key) {
  const root = parseRoot(chordName);
  if (!root) return null;
  const info = degreeInfoForPc(root.pc, key.onePc);
  const acc = ACC_LABEL[info.acc] || '';
  const suffix = numeralSuffix(root.suffix);
  return {
    numeral: `${acc}${info.degree}`,
    solfege: `${acc}${SOLFEGE[info.degree]}`,
    label: `${acc}${info.degree}${suffix}`,
  };
}

// chords 拼回 "t:name,…" 供 keyEstimator
function chordsToText(chords) {
  return (chords || [])
    .filter((c) => c && Number.isFinite(c.time) && c.name)
    .map((c) => `${c.time.toFixed(3)}:${c.name}`)
    .join(',');
}

// 调性解析:估计值(keyEstimator)+ 手动覆盖;小调 1=关系大调(主音+3半音)
function resolveKey() {
  let est = null;
  try {
    est = window.ycKeyEstimator?.estimateKeyFromChordText?.(chordsToText(state.chords)) || null;
  } catch { /* 估计失败走默认 C 大调 */ }

  const estTonicPc = est?.key ? (NOTE_TO_PC[FLAT_TO_SHARP[est.key] || est.key] ?? 0) : 0;
  const tonicPc = Number.isInteger(state.settings.tonicOverride)
    ? state.settings.tonicOverride
    : estTonicPc;
  const mode = state.settings.modeOverride === 'major' || state.settings.modeOverride === 'minor'
    ? state.settings.modeOverride
    : (est?.mode === 'minor' ? 'minor' : 'major');
  const minor = mode === 'minor';
  const onePc = minor ? (tonicPc + 3) % 12 : tonicPc;

  let label = `1=${NOTE_NAMES[onePc]}`;
  if (minor) label += ` (${NOTE_NAMES[tonicPc]}m)`;
  let estLabel = '';
  if (est && !state.settings.tonicOverride && !state.settings.modeOverride) {
    estLabel = est.isLowConfidence ? '估计·低置信' : '估计';
  } else if (state.settings.tonicOverride !== null || state.settings.modeOverride) {
    estLabel = '手动';
  }
  return { tonicPc, mode, onePc, minor, label, estLabel };
}

// ───────────────────────────────────────────────
// 3. 节拍 / 时值
// ───────────────────────────────────────────────
// 初始 BPM 估算:相邻和弦间隔中位数 → 假设每小节 2 次换和弦(与 Measure 视图同法)
function estimateBpmFromChords(chords, beatsPerBar) {
  if (!Array.isArray(chords) || chords.length < 2) return 120;
  const times = chords.map((c) => c.time).sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > MIN_CHORD_DELTA) deltas.push(d);
  }
  if (!deltas.length) return 120;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.round(Math.min(240, Math.max(40, (60 * beatsPerBar) / (2 * median))));
}

function clampBpm(bpm) { return Math.min(240, Math.max(40, bpm)); }

// 拍信息:{ bpm, meter, firstBeat }(firstBeat 用于旋律模式对齐小节线;null=未知)
function beatInfo() {
  const data = state.beatsData;
  const raw = Array.isArray(data?.beats) ? data.beats : [];
  const beats = raw
    .filter((b) => b && Number.isFinite(Number(b.time)) && Number.isInteger(Number(b.pos)) && b.pos >= 1)
    .map((b) => ({ time: Number(b.time), pos: Number(b.pos) }))
    .sort((a, b) => a.time - b.time);

  if (beats.length >= 4) {
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
    bpm = clampBpm(Math.round(bpm * 10) / 10);
    const meter = VALID_BEATS.includes(Number(data?.meter)) ? Number(data.meter) : 4;
    return { bpm, meter, firstBeat: beats[0].time };
  }

  return { bpm: estimateBpmFromChords(state.chords, 4), meter: 4, firstBeat: null };
}

// 词时长(拍)→ 时值记号(推算模式;阈值与档位见计划,边界留容差防抖)
function durationMark(durBeats) {
  if (!Number.isFinite(durBeats) || durBeats <= 0) return {};
  if (durBeats >= 1.75) return { dashes: Math.min(3, Math.max(1, Math.round(durBeats) - 1)) };
  if (durBeats >= 1.25) return { dot: true };
  if (durBeats >= 0.75) return {};
  if (durBeats >= 0.375) return { underline: 1 };
  return { underline: 2 };
}

// ───────────────────────────────────────────────
// 4. 设置持久化(每视频 local,开关全局 sync)
// ───────────────────────────────────────────────
function normalizeSettings(raw) {
  const tonic = Number.isInteger(raw?.tonicOverride) ? raw.tonicOverride : null;
  const mode = raw?.modeOverride === 'major' || raw?.modeOverride === 'minor' ? raw.modeOverride : null;
  return {
    tonicOverride: tonic !== null && tonic >= 0 && tonic <= 11 ? tonic : null,
    modeOverride: mode,
    solfegeRow: raw?.solfegeRow !== false,      // 旧存档缺 key → 默认开
    durationMarks: raw?.durationMarks !== false,
    sections: raw?.sections !== false,
  };
}

async function loadSettings(videoId) {
  const key = LOCAL_KEY_PREFIX + videoId;
  try {
    const got = await chrome.storage.local.get(key);
    state.settings = normalizeSettings(got?.[key]);
  } catch (err) {
    console.warn('[JianpuChart] Failed to load settings:', err);
    state.settings = { ...DEFAULT_SETTINGS };
  }
  state.settingsLoadedFor = videoId;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.renderToken++;   // 使未完成的异步渲染失效,避免覆盖新设置的结果
  state.saveTimer = setTimeout(() => {
    const key = LOCAL_KEY_PREFIX + (state.videoId || 'default');
    try {
      chrome.storage.local.set({ [key]: { ...state.settings } });
    } catch (err) {
      console.warn('[JianpuChart] Failed to save settings:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ───────────────────────────────────────────────
// 5. 数据提取(在 combinedData 被释放前同步完成)
// ───────────────────────────────────────────────
// CJK 逐字拆分:自动字幕按空格切分,中文歌词一个"词"常是整个短语(甚至整段副歌),
// 简谱一字一音/TAB 逐字对齐都需要字级粒度 → 纯 CJK 短语(允许 ≤2 个标点)按字均分词内时间
function splitCjkWords(words) {
  const out = [];
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  for (const w of words) {
    const chars = [...String(w?.word ?? '')];
    const cjkCount = chars.filter((c) => CJK.test(c)).length;
    if (cjkCount >= 2 && chars.length <= cjkCount + 2) {    // 纯 CJK 短语(尾部标点)
      const start = Number(w.start);
      const end = Number.isFinite(Number(w.end)) ? Number(w.end) : start;
      const step = chars.length > 0 ? Math.max(0, end - start) / chars.length : 0;
      chars.forEach((c, i) => out.push({ word: c, start: start + i * step, end: start + (i + 1) * step }));
    } else {
      out.push(w);
    }
  }
  return out;
}

function extractData(combinedData, authoritativeChords) {
  // 和弦:权威列表优先;否则从行内 chords 汇总(按时间去重)——与 Measure 视图同法
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

  // 词(扁平) + 行(推算模式布局):跳过段落标记行,保留间奏行(渲染和弦 chip)
  const words = [];
  const lines = [];
  if (Array.isArray(combinedData)) {
    for (const line of combinedData) {
      if (!line || !Number.isFinite(Number(line.start))) continue;
      if (line.isSectionMarker) continue;
      const lineWords = [];
      for (const w of (line?.words || [])) {
        const text = String(w?.word || w?.text || '').trim();
        const start = Number(w?.start);
        if (text && Number.isFinite(start)) {
          const end = Number(w?.end);
          for (const sw of splitCjkWords([{ word: text, start, end: Number.isFinite(end) ? end : start }])) {
            lineWords.push(sw);
            words.push(sw);   // 行内词与扁平词同引用(wiBase 依赖)
          }
        }
      }
      const chordsInLine = (Array.isArray(line?.chords) ? line.chords : [])
        .filter((ch) => ch && Number.isFinite(Number(ch.time)))
        .map((ch) => ({ time: Number(ch.time), name: ch.name || ch.chord || '' }))
        .filter((ch) => ch.name);
      if (lineWords.length || chordsInLine.length) {
        const endNum = Number(line.end);
        lines.push({
          start: Number(line.start),
          end: Number.isFinite(endNum) && endNum > 0
            ? endNum
            : (lineWords.length ? lineWords[lineWords.length - 1].end : Number(line.start)),
          words: lineWords,
          chords: chordsInLine,
          isInstrumental: !!line.isInstrumental,
        });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  lines.sort((a, b) => a.start - b.start);
  // 词对象 → 扁平全局索引(行内词与扁平词是同一对象引用,高亮 data-wi 用)
  const wiBase = new Map();
  words.forEach((w, wi) => wiBase.set(w, wi));

  return { chords, words, lines, sections: extractSections(combinedData), wiBase };
}

// 段落时间轴(与 Measure 视图同法:真实标记优先,元数据兜底)
function parseInstrumentalName(text) {
  const m = String(text || '').trim().match(/^\[\s*(.+?)\s*\]$/);
  return m ? m[1].trim() : null;
}

function extractSections(combinedData) {
  if (!Array.isArray(combinedData) || !combinedData.length) return [];
  const markers = [];
  const instrumental = [];
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

// 和弦库兜底源(与 Measure 视图同法,额外带出 melodyData)
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
    return parsed.length
      ? { chords: parsed, beatsData: data?.beatsData || null, melodyData: data?.melodyData || null }
      : null;
  } catch (err) {
    console.warn('[JianpuChart] chord library pull failed:', err);
    return null;
  }
}

// ───────────────────────────────────────────────
// 6. 渲染(总入口:按数据可用性分派旋律/推算模式)
// ───────────────────────────────────────────────
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

function hasMelody() {
  return Array.isArray(state.melodyData?.notes) && state.melodyData.notes.length >= MIN_MELODY_NOTES;
}

function renderView() {
  const container = state.container;
  if (!container) return;
  ensureCss();
  destroyRenderer();

  if (!state.chords.length && !hasMelody()) {
    container.innerHTML = '<div class="yc-j-empty">No chords in library for this video — open the Chords panel once to analyze, then reopen this view</div>';
    resetHighlightCache();
    return;
  }

  const key = resolveKey();
  state.mode = hasMelody() ? 'melody' : 'estimate';

  // 工具栏 + 占位主体(旋律模式异步填充分数)
  container.innerHTML = `
    <div class="yc-jianpu-view">
      ${buildToolbarHtml(key)}
      ${buildHintHtml()}
      <div class="yc-j-body" data-mode="${state.mode}">
        <div class="yc-j-loading">${state.mode === 'melody' ? '🎼 Rendering melody score…' : ''}</div>
      </div>
    </div>`;
  bindToolbar(container);
  resetHighlightCache();

  if (state.mode === 'melody') {
    renderMelodyBody(key);       // 异步;失败回退推算模式
  } else {
    renderEstimateBody(key);
  }
}

function destroyRenderer() {
  for (const row of state.rows) {
    try { row.inst?.destroy?.(); } catch { /* ignore */ }
  }
  state.rows = [];
  state.jrTime = [];
  state.jrRefs = [];
}

// 无旋律数据时的提示 + 升级入口(与 Measure 视图 Re-analyze 同法)
function buildHintHtml() {
  if (state.mode === 'melody') return '';
  return `
    <div class="yc-j-hint">
      <span>推算模式 — 每词标注和弦根音级数,非真实人声旋律。重新分析(需 local-companion ≥ 旋律版)可获得逐音符简谱</span>
      <button class="yc-j-tb-btn yc-j-reanalyze" title="Delete cached analysis and re-run the local pipeline (adds melody extraction)">Re-analyze</button>
    </div>`;
}

// ───────────────────────────────────────────────
// 6a. 工具栏
// ───────────────────────────────────────────────
function buildToolbarHtml(key) {
  const s = state.settings;
  const keyVal = Number.isInteger(s.tonicOverride)
    ? `${s.tonicOverride}:${s.modeOverride || 'major'}`
    : (s.modeOverride ? `${key.tonicPc}:${s.modeOverride}` : 'auto');
  const melodyCount = hasMelody() ? state.melodyData.notes.length : 0;
  const badge = state.mode === 'melody'
    ? `<span class="yc-j-badge yc-j-badge-melody" title="Basic Pitch melody notes — real pitch & duration">旋律 · ${melodyCount} 音符</span>`
    : '<span class="yc-j-badge yc-j-badge-est" title="Chord-root scale degrees inferred from the estimated key">推算</span>';

  let keyOptions = `<option value="auto"${keyVal === 'auto' ? ' selected' : ''}>Auto${key.estLabel ? ` (${key.estLabel})` : ''}</option>`;
  keyOptions += '<optgroup label="Major">';
  for (let pc = 0; pc < 12; pc++) {
    keyOptions += `<option value="${pc}:major"${keyVal === `${pc}:major` ? ' selected' : ''}>${NOTE_NAMES[pc]} major (1=${NOTE_NAMES[pc]})</option>`;
  }
  keyOptions += '</optgroup><optgroup label="Minor">';
  for (let pc = 0; pc < 12; pc++) {
    const onePc = (pc + 3) % 12;
    keyOptions += `<option value="${pc}:minor"${keyVal === `${pc}:minor` ? ' selected' : ''}>${NOTE_NAMES[pc]} minor (1=${NOTE_NAMES[onePc]})</option>`;
  }
  keyOptions += '</optgroup>';

  // 唱名/时值/段落开关仅推算模式有意义(旋律模式记号由 jianpurender 全量绘制)
  const estToggles = state.mode === 'estimate' ? `
      <button class="yc-j-tb-btn yc-j-solfege-toggle${s.solfegeRow !== false ? ' yc-j-on' : ''}" title="Toggle solfège row (do re mi)">唱名</button>
      <button class="yc-j-tb-btn yc-j-duration-toggle${s.durationMarks !== false ? ' yc-j-on' : ''}" title="Toggle duration marks (underlines / dots / dashes)">时值</button>
      <button class="yc-j-tb-btn yc-j-sections-toggle${s.sections !== false ? ' yc-j-on' : ''}" title="Toggle section headers">Sections</button>` : '';

  return `
    <div class="yc-j-toolbar">
      <label class="yc-j-tb-item">Key
        <select class="yc-j-key-select" title="Scale-degree reference key — Auto uses the estimated song key; minor keys use 1 = relative major (songbook convention)">
          ${keyOptions}
        </select>
      </label>
      <span class="yc-j-tb-item yc-j-key-label">${escapeHtml(key.label)}</span>
      ${badge}
      ${estToggles}
    </div>`;
}

function bindToolbar(container) {
  const root = container.querySelector('.yc-jianpu-view');
  if (!root) return;

  root.querySelector('.yc-j-key-select')?.addEventListener('change', (e) => {
    const val = String(e.target.value || 'auto');
    if (val === 'auto') {
      state.settings.tonicOverride = null;
      state.settings.modeOverride = null;
    } else {
      const [pcStr, mode] = val.split(':');
      const pc = Number(pcStr);
      state.settings.tonicOverride = Number.isInteger(pc) && pc >= 0 && pc <= 11 ? pc : null;
      state.settings.modeOverride = mode === 'minor' ? 'minor' : 'major';
    }
    scheduleSave();
    rebuildAndRender();
  });

  root.querySelector('.yc-j-solfege-toggle')?.addEventListener('click', (e) => {
    state.settings.solfegeRow = state.settings.solfegeRow === false;
    scheduleSave();
    rebuildAndRender();
    e.currentTarget?.classList?.toggle('yc-j-on', state.settings.solfegeRow !== false);
  });
  root.querySelector('.yc-j-duration-toggle')?.addEventListener('click', (e) => {
    state.settings.durationMarks = state.settings.durationMarks === false;
    scheduleSave();
    rebuildAndRender();
    e.currentTarget?.classList?.toggle('yc-j-on', state.settings.durationMarks !== false);
  });
  root.querySelector('.yc-j-sections-toggle')?.addEventListener('click', (e) => {
    state.settings.sections = state.settings.sections === false;
    scheduleSave();
    rebuildAndRender();
    e.currentTarget?.classList?.toggle('yc-j-on', state.settings.sections !== false);
  });
  root.querySelector('.yc-j-reanalyze')?.addEventListener('click', (e) => triggerReanalyze(e.currentTarget));
}

// 旧缓存无旋律数据时的「重新分析」(与 Measure 视图同法,两段式)
async function triggerReanalyze(btn) {
  const vid = state.videoId;
  if (!vid || btn?.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Re-analyzing…';
  }
  try {
    const pullFromCompanion = async () => {
      await window.databaseManager?.deleteFromDatabase?.('chords', vid);
      if (window.chordTextsCache) delete window.chordTextsCache[vid];
      return window.databaseManager?.copyLocalChordsToIndexedDB?.(vid);
    };

    let ok = await pullFromCompanion();
    const record = ok ? await window.databaseManager?.loadFromDatabase?.('chords', vid) : null;
    if (ok && !record?.melodyData) {
      console.log('[JianpuChart] companion cache lacks melody — re-running full analysis');
      await window.ycAuth?.deleteCachedResult?.(vid);
      ok = await pullFromCompanion();
    }
    if (ok && window.chordsDisplay?.activate) {
      try { await window.chordsDisplay.activate(vid); } catch (err) {
        console.warn('[JianpuChart] chordsDisplay refresh failed:', err);
      }
    }
  } catch (err) {
    console.warn('[JianpuChart] Re-analyze failed:', err);
  }
  if (typeof window.refreshLyricsChordsPanel === 'function') {
    try { await window.refreshLyricsChordsPanel(); } catch (err) {
      console.warn('[JianpuChart] Panel refresh failed:', err);
    }
  }
}

// ───────────────────────────────────────────────
// 6b. 推算模式:歌本式小节谱(数字级数+共用下划线+休止+歌词一字一音对齐)
//    布局仿传统歌本:小节竖线分隔、同行多小节 flex 换行、
//    相邻八分/十六分音符共用一条下划线(减时线)、间奏空小节压缩
// ───────────────────────────────────────────────
// 均匀小节网格(推算):原点=管线首拍(对齐检测小节线)或 0,拍长来自管线 BPM/估 BPM
function estimateGrid() {
  const bi = beatInfo();
  const spb = Math.min(MAX_BEAT_DUR, Math.max(MIN_BEAT_DUR, 60 / bi.bpm));
  const beatsPerBar = VALID_BEATS.includes(bi.meter) ? bi.meter : 4;
  const origin = Number.isFinite(bi.firstBeat) ? bi.firstBeat : 0;
  return { spb, beatsPerBar, origin, measureDur: spb * beatsPerBar };
}

// 时值记号(附点/延音线)HTML,拼在数字后
function markExtHtml(mark) {
  if (mark.dot) return '<i class="yc-j-dot">·</i>';
  if (mark.dashes) return `<i class="yc-j-dash">${'—'.repeat(mark.dashes)}</i>`;
  return '';
}

// 单个音符格:上=级数数字(+记号+小字唱名),下=歌词字(一字一音)
function noteCellHtml(cell, showSolfege, showDuration) {
  const mark = showDuration ? durationMark(cell.durBeats) : {};
  const ext = markExtHtml(mark);
  if (cell.kind === 'rest') {
    return `<span class="yc-j-note yc-j-note-rest"><span class="yc-j-num">0${ext}</span><span class="yc-j-lyr">&nbsp;</span></span>`;
  }
  const deg = cell.deg;
  return `<span class="yc-j-note yc-j-word" data-wi="${cell.wi}" data-time="${cell.t.toFixed(3)}">`
    + `<span class="yc-j-num">${deg ? escapeHtml(deg.numeral) : '·'}${ext}`
    + (showSolfege && deg ? `<em class="yc-j-sol">${escapeHtml(deg.solfege)}</em>` : '')
    + '</span>'
    + `<span class="yc-j-lyr">${escapeHtml(cell.word)}</span></span>`;
}

// 相邻同档下划线的音符合用一条减时线(歌本惯例:组内共用横线)
function notesRowHtml(cells, showSolfege, showDuration) {
  let html = '';
  let group = null;   // { level, parts[] }
  const flush = () => {
    if (!group) return;
    html += `<span class="yc-j-ngrp${group.level === 2 ? ' yc-j-g2' : ' yc-j-g1'}">${group.parts.join('')}</span>`;
    group = null;
  };
  for (const cell of cells) {
    const mark = showDuration ? durationMark(cell.durBeats) : {};
    const level = mark.underline || 0;
    const part = noteCellHtml(cell, showSolfege, showDuration);
    if (level > 0) {
      if (!group || group.level !== level) {
        flush();
        group = { level, parts: [part] };
      } else {
        group.parts.push(part);
      }
    } else {
      flush();
      html += part;
    }
  }
  flush();
  return html;
}

function chordChipHtml(chord, key, cIdx) {
  const idx = Number.isInteger(cIdx) ? cIdx : binarySearchLast(state.chords, chord.time, 'time');
  const deg = chordDegree(chord.name, key);
  const label = deg ? `${escapeHtml(displayName(chord.name))}·${escapeHtml(deg.label)}` : escapeHtml(displayName(chord.name));
  return `<span class="yc-j-chord" data-ci="${idx}" data-time="${chord.time.toFixed(3)}">${label}</span>`;
}

function renderEstimateBody(key) {
  const body = state.container?.querySelector('.yc-j-body');
  if (!body) return;

  const { spb, beatsPerBar, origin, measureDur } = estimateGrid();
  const showSections = state.settings.sections !== false && state.sections.length > 0;
  const showSolfege = state.settings.solfegeRow !== false;
  const showDuration = state.settings.durationMarks !== false;
  const off = subtitleOffset();

  if (!state.words.length && !state.chords.length) {
    body.setAttribute('data-mode', 'estimate');
    body.innerHTML = '<div class="yc-j-empty">No lyrics for this video — chord degrees need a lyrics timeline</div>';
    return;
  }

  // 词事件 → 小节 + 小节内拍位(0.25 拍粒度),并挂当前和弦级数
  const wordsByMeasure = new Map();
  state.words.forEach((w, wi) => {
    const videoT = w.start - off;
    const beats = (videoT - origin) / spb;
    const m = Math.max(0, Math.floor(beats / beatsPerBar));
    const cIdx = binarySearchLast(state.chords, videoT, 'time');
    const chord = cIdx >= 0 ? state.chords[cIdx] : null;
    if (!wordsByMeasure.has(m)) wordsByMeasure.set(m, []);
    wordsByMeasure.get(m).push({
      kind: 'word', wi, word: w.word, t: w.start,
      deg: chord ? chordDegree(chord.name, key) : null,
      local: Math.max(0, Math.min(beatsPerBar - 0.25, beats - m * beatsPerBar)),
      durBeats: (w.end - w.start) / spb,
    });
  });

  // 和弦事件 → 小节(chip 排在小节上方)
  const chordsByMeasure = new Map();
  state.chords.forEach((ch, ci) => {
    const m = Math.max(0, Math.floor((ch.time - origin) / measureDur));
    if (!chordsByMeasure.has(m)) chordsByMeasure.set(m, []);
    chordsByMeasure.get(m).push({ ch, ci });
  });

  // 覆盖到最后一处数据所在小节
  let lastM = 0;
  for (const m of wordsByMeasure.keys()) lastM = Math.max(lastM, m);
  for (const m of chordsByMeasure.keys()) lastM = Math.max(lastM, m);

  let html = '<div class="yc-j-mrow">';
  let lastSectionIdx = -1;
  let lastRenderedM = null;   // 压缩长间奏空小节用

  for (let m = 0; m <= lastM; m++) {
    const mStart = origin + m * measureDur;
    const mWords = (wordsByMeasure.get(m) || []).sort((a, b) => a.local - b.local);
    const mChords = chordsByMeasure.get(m) || [];

    // 段落头(通栏):该小节所属段落与上一小节不同时插入
    if (showSections) {
      const sIdx = binarySearchLast(state.sections, mStart + off, 'time');
      if (sIdx >= 0 && sIdx !== lastSectionIdx) {
        const s = state.sections[sIdx];
        html += `</div><div class="yc-j-section" data-si="${sIdx}">${escapeHtml(s.name)}</div><div class="yc-j-mrow">`;
        lastSectionIdx = sIdx;
      }
    }

    // 空小节(无词无和弦):距上一渲染小节 >2 → 省略号压缩;否则整小节休止
    if (!mWords.length && !mChords.length) {
      if (lastRenderedM !== null && m - lastRenderedM > 2 && m !== lastM) {
        html += '<div class="yc-j-m yc-j-mgap">…</div>';
        continue;
      }
      html += `<div class="yc-j-m" data-mi="${m}"><div class="yc-j-mnotes">`
        + `<span class="yc-j-note yc-j-note-rest"><span class="yc-j-num">0${showDuration ? `<i class="yc-j-dash">${'—'.repeat(Math.max(0, beatsPerBar - 1))}</i>` : ''}</span><span class="yc-j-lyr">&nbsp;</span></span>`
        + '</div></div>';
      lastRenderedM = m;
      continue;
    }
    lastRenderedM = m;

    // 小节内音符序列:词前空隙 ≥1 拍 → 休止符
    const cells = [];
    let prevEndLocal = 0;
    for (const e of mWords) {
      const gap = e.local - prevEndLocal;
      if (showDuration && gap >= 1) cells.push({ kind: 'rest', durBeats: Math.min(gap, beatsPerBar) });
      cells.push(e);
      prevEndLocal = Math.max(prevEndLocal, e.local + Math.max(0.25, e.durBeats));
    }

    html += `<div class="yc-j-m" data-mi="${m}">`;
    if (mChords.length) {
      html += `<div class="yc-j-mchords">${mChords.map((c) => chordChipHtml(c.ch, key, c.ci)).join('')}</div>`;
    }
    html += `<div class="yc-j-mnotes">${cells.length ? notesRowHtml(cells, showSolfege, showDuration) : ''}</div>`;
    html += '</div>';
  }
  html += '</div>';

  body.setAttribute('data-mode', 'estimate');
  body.innerHTML = html;
  bindBodyClicks(state.container);
}

// ───────────────────────────────────────────────
// 6c. 旋律模式:jianpurender 标准简谱 SVG
// ───────────────────────────────────────────────
async function ensureJianpuRenderLoaded() {
  if (window.jr?.JianpuSVGRender) return true;
  try {
    await window.ycLoader?.js?.(VENDOR_PATH);
  } catch (err) {
    console.warn('[JianpuChart] Failed to load jianpurender:', err);
  }
  return !!window.jr?.JianpuSVGRender;
}

// 面板主题 → 渲染色
function themeColors() {
  const panel = document.querySelector('.yt-lyrics-chords-panel');
  const light = panel?.classList.contains('sepia-theme') || panel?.classList.contains('light-theme');
  return light
    ? { noteColor: '#333333', activeNoteColor: '#1e6fd9' }
    : { noteColor: '#e8e8e8', activeNoteColor: '#3ea6ff' };
}

// 旋律量化:起止吸附到八分音符网格(慢歌十六分),≤1 格间隙并入前音 → 消除 Basic Pitch 微差导致的碎休止/碎附点
function quantizeMelodyNotes(rawNotes, gridSec, originSec) {
  const events = [];
  for (const n of rawNotes) {
    const startSec = Number(n.start);
    const durSec = Number(n.dur) / 1000;
    if (!Number.isFinite(startSec) || !Number.isFinite(durSec) || durSec <= 0) continue;
    if (startSec < originSec - 0.0625) continue;        // 明显早于管线首拍 → 丢弃
    events.push({ startSec, endSec: startSec + durSec, pitch: Math.round(Number(n.midi)), conf: Number(n.conf) });
  }
  events.sort((a, b) => a.startSec - b.startSec);

  const q = [];
  for (const ev of events) {
    const sIdx = Math.round((ev.startSec - originSec) / gridSec);
    if (sIdx < 0) continue;                             // 吸附后早于首拍 → 丢弃
    const eIdx = Math.max(sIdx + 1, Math.round((ev.endSec - originSec) / gridSec));
    const s = originSec + sIdx * gridSec;
    const e = originSec + eIdx * gridSec;
    const prev = q[q.length - 1];
    if (prev && s <= prev.start) {                      // 同格:留置信度高的
      if ((ev.conf || 0) > (prev.conf || 0)) { prev.pitch = ev.pitch; prev.conf = ev.conf; }
      continue;
    }
    if (prev && s < prev.start + prev.length) prev.length = s - prev.start;  // 重叠裁剪
    q.push({ start: s, length: Math.min(16 * gridSec, e - s), pitch: ev.pitch, conf: ev.conf });
  }
  for (let i = 0; i + 1 < q.length; i++) {              // ≤1 格间隙 → 延音填满(免碎休止)
    const gap = q[i + 1].start - (q[i].start + q[i].length);
    if (gap > 0 && gap <= gridSec + 1e-9) q[i].length += gap;
  }
  return q;
}

// 八度归一:众数八度平移到无点区,离群八度(距主八度 ≥±2,基本是 Basic Pitch 倍频误检)折回主八度邻域
// (镜像库内 mapMidiToJianpu: C 调参考 60,其余 48+pc) → 八度点最多 ±1,贴近歌本外观
function normalizeOctaves(notes, onePc) {
  const refMidi = onePc === 0 ? 60 : 48 + onePc;
  const histo = new Map();
  for (const n of notes) {
    const d = Math.floor((n.pitch - refMidi) / 12);
    histo.set(d, (histo.get(d) || 0) + 1);
  }
  let bestD = 0;
  let bestCount = null;
  histo.forEach((count, d) => {
    const better = bestCount === null
      || count > bestCount
      || (count === bestCount && (Math.abs(d) < Math.abs(bestD) || (Math.abs(d) === Math.abs(bestD) && d > bestD)));
    if (better) { bestCount = count; bestD = d; }
  });
  for (const n of notes) {
    const d0 = Math.floor((n.pitch - refMidi) / 12);
    const target = Math.max(-1, Math.min(1, d0 - bestD));     // 主八度 → 0,离群夹到 ±1
    const shift12 = (target - d0) * 12;
    if (shift12) n.pitch += shift12;
  }
}

// 谱头回退(纯函数):最早内容(音符/歌词)早于管线首拍(弱起人声常见)时,把 origin 回退整数小节
// (保持小节相位;上限 4 小节防脏数据把谱头拉出长串休止)
function extendOrigin(earliestSec, rawOrigin, barSec) {
  if (!Number.isFinite(earliestSec) || !(barSec > 0) || earliestSec >= rawOrigin - 0.2) return rawOrigin;
  const bars = Math.min(4, Math.ceil((rawOrigin - earliestSec) / barSec));
  return bars > 0 ? rawOrigin - bars * barSec : rawOrigin;
}

// 分行规划(纯函数):按小节贪心装行 + 跨行长音裁剪/延续;返回每行行内坐标的音符
// jianpurender 单实例只横向延展,分行由本视图完成(歌本惯例:连线不跨行 → 跨行长音在下一行行首重复数字)
function planMelodyRows(qNotes, beatsPerBar, availW, spb, origin) {
  const lastB = qNotes[qNotes.length - 1].startB + qNotes[qNotes.length - 1].lenB;
  const barCount = Math.ceil((lastB - 1e-6) / beatsPerBar);
  const NOTE_H = 22;
  const slotW = 0.6 * NOTE_H * 1.2 * 1.5 + 3;          // ≈ 库内 estNoteWidth × spacing
  const barNotes = new Array(barCount).fill(0);
  const barExtra = new Array(barCount).fill(0);
  for (const n of qNotes) {
    const b = Math.min(barCount - 1, Math.max(0, Math.floor(n.startB / beatsPerBar)));
    barNotes[b] += 1;
    barExtra[b] += Math.max(0, Math.ceil(n.lenB) - 1) * 4;   // 增时线 — 占宽
  }
  const rowDefs = [];
  for (let b = 0; b < barCount; b++) {
    const w = Math.max(2, barNotes[b]) * slotW + barExtra[b] + 16;
    const cur = rowDefs[rowDefs.length - 1];
    if (!cur || cur.estW + w > availW || cur.endBar - cur.startBar >= 8) {
      rowDefs.push({ startBar: b, endBar: b + 1, estW: w });
    } else {
      cur.endBar = b + 1;
      cur.estW += w;
    }
  }
  const barToRow = new Array(barCount).fill(0);
  rowDefs.forEach((rr, i) => { for (let b = rr.startBar; b < rr.endBar; b++) barToRow[b] = i; });

  const rows = [];
  let carry = null;
  for (let d = 0; d < rowDefs.length; d++) {
    const rowStartB = rowDefs[d].startBar * beatsPerBar;
    const rowEndB = rowDefs[d].endBar * beatsPerBar;
    const picked = carry ? [carry] : [];
    carry = null;
    for (const n of qNotes) {
      if (n.startB < rowStartB) continue;
      if (n.startB >= rowEndB) break;
      picked.push(n);
    }
    // 裁剪跨出本行的长音,延续部分交给下一行
    const lastN = picked[picked.length - 1];
    if (lastN && lastN.startB + lastN.lenB > rowEndB + 1e-9) {
      carry = { startB: rowEndB, lenB: Math.min(16, lastN.startB + lastN.lenB - rowEndB), pitch: lastN.pitch, conf: lastN.conf, sec: origin + rowEndB * spb };
      picked[picked.length - 1] = { ...lastN, lenB: rowEndB - lastN.startB };
    }
    // 空小节行(间奏)也保留:库会画整行休止,歌词条仍可挂词(此前跳过导致器乐段整段消失)
    rows.push({
      defIdx: d,
      startBeat: rowStartB,
      endBeat: rowEndB,
      notes: picked.map((n) => ({
        start: n.startB - rowStartB,
        length: n.lenB,
        pitch: n.pitch,
        intensity: Number.isFinite(n.conf) ? n.conf : 0.8,
        sec: n.sec,
      })),
    });
  }
  return { rows, rowDefs, barCount, barToRow };
}

// 歌词归行(纯函数):每词按自身拍位置落到所属行(行内坐标),不吸附音符
// x 定位由 attachLyricStrip 用渲染后的音符组坐标插值完成——休止区/弱起词也能显示
// (第三轮实测:吸附到音符的方案在 2 拍内无音符时整段丢词,如句首弱起词)
function planMelodyLyrics(words, subOffset, origin, spb, beatsPerBar, plan) {
  const byRow = plan.rowDefs.map((d) => ({
    startBeat: d.startBar * beatsPerBar,
    spanBeats: (d.endBar - d.startBar) * beatsPerBar,
    items: [],
  }));
  for (const w of words) {
    if (!w.word) continue;
    const beat = (w.start - subOffset - origin) / spb;
    if (beat < -0.25) continue;                         // 早于谱头的词丢弃
    const bar = Math.floor((Math.max(0, beat) + 1e-9) / beatsPerBar);
    if (bar < 0 || bar >= plan.barCount) continue;      // 旋律结束后的词丢弃
    const rr = byRow[plan.barToRow[bar]];
    const local = Math.max(0, Math.min(rr.spanBeats, beat - rr.startBeat));
    rr.items.push({ start: local, text: w.word, time: w.start - subOffset });
  }
  return byRow;
}

// 行内自适应:非首行藏 1=X 4/4 顶带并按实测 bbox 压高;超宽行只缩不放(max-width,防 availW 误测时把窄行放大拉伸)
function fitRowSvg(inst, hideSignature) {
  try {
    if (hideSignature) {
      inst.overlaySVG.style.display = 'none';
      const bb = inst.mainG.getBBox();
      const top = Math.max(0, -bb.y) + 2;               // 负 y 内容(高音点/连线)保留头部余量
      const h = Math.ceil(bb.height + top + 4);
      if (h > 0) {
        inst.mainG.setAttribute('transform', `translate(0, ${top})`);
        inst.mainSVG.setAttribute('height', String(h));
        inst.overlaySVG.setAttribute('height', String(h));
      }
    }
    const w = parseFloat(inst.mainSVG.getAttribute('width')) || 0;
    const h = parseFloat(inst.mainSVG.getAttribute('height')) || 0;
    if (w > 0 && h > 0) {
      inst.mainSVG.setAttribute('viewBox', `0 0 ${w} ${h}`);
      inst.mainSVG.style.maxWidth = '100%';             // 超出容器才等比缩,窄行保持原大
      inst.mainSVG.style.height = 'auto';
    }
  } catch { /* 内部结构变化时退化为库原始布局 */ }
}

// 旋律模式歌词自绘:每词按其拍位置换算行内可视 x——以渲染后的音符组坐标为锚点线性插值,
// 行首/行尾按端点斜率外推(弱起词在首音符左侧也能落位);无音符行(纯休止)按行宽比例。
// 矩形坐标已含 max-width 缩放;点击跳转到词的视频时间
function attachLyricStrip(rowDiv, inst, entries, spanBeats) {
  if (!Array.isArray(entries) || !entries.length) return;
  try {
    const divRect = rowDiv.getBoundingClientRect();
    const svgRect = inst.mainSVG.getBoundingClientRect();
    if (!divRect.width || !svgRect.width) return;
    const anchors = [];
    rowDiv.querySelectorAll('g[data-id]').forEach((g) => {
      const id = g.getAttribute('data-id');                 // "<startBeat>-<pitch>"(音符) / "block-<start>"(块,parseFloat→NaN 跳过)
      const cut = id.lastIndexOf('-');
      const startB = parseFloat(id.slice(0, cut));
      if (!Number.isFinite(startB)) return;
      const r = g.getBoundingClientRect();
      anchors.push({ b: startB, x: r.left - divRect.left + r.width / 2 });
    });
    anchors.sort((p, q) => p.b - q.b);
    const beatToX = (b) => {
      const n = anchors.length;
      if (n === 0) return spanBeats > 0 ? (Math.max(0, b) / spanBeats) * svgRect.width : 0;
      if (n === 1) return anchors[0].x + (b - anchors[0].b) * 27;
      let i = 0;
      while (i < n - 2 && b > anchors[i + 1].b) i++;
      const p = anchors[i];
      const q = anchors[i + 1];
      const slope = q.b !== p.b ? (q.x - p.x) / (q.b - p.b) : 27;
      return Math.max(0, Math.min(svgRect.width, p.x + (b - p.b) * slope));
    };
    const strip = document.createElement('div');
    strip.className = 'yc-j-lystrip';
    const placed = [];
    for (const w of entries) {
      const span = document.createElement('span');
      span.className = 'yc-j-mlyr';
      span.textContent = w.text;
      if (Number.isFinite(w.time)) span.dataset.time = String(w.time);
      strip.appendChild(span);
      placed.push([span, beatToX(w.start)]);
    }
    rowDiv.appendChild(strip);
    let prevRight = -Infinity;
    for (const [span, x] of placed) {                       // 插入后实测宽度:居中 + 碰撞右移
      const wPx = span.offsetWidth;
      let left = x - wPx / 2;
      if (left < prevRight + 4) left = prevRight + 4;
      prevRight = left + wPx;
      span.style.left = `${Math.max(0, left)}px`;
    }
  } catch { /* 定位失败时该行无歌词,不影响谱面 */ }
}

async function renderMelodyBody(key) {
  const token = ++state.renderToken;
  const body = state.container?.querySelector('.yc-j-body');
  if (!body) return;

  const ok = await ensureJianpuRenderLoaded();
  if (token !== state.renderToken) return;   // 已被新渲染/设置变更取代
  if (!ok) {
    console.warn('[JianpuChart] jianpurender unavailable — falling back to estimate mode');
    state.mode = 'estimate';
    renderView();
    return;
  }

  // 秒 → 四分音符拍(jianpurender 时间单位);小节相位对齐管线首拍
  const bi = beatInfo();
  const spb = Math.min(MAX_BEAT_DUR, Math.max(MIN_BEAT_DUR, 60 / bi.bpm));
  const rawOrigin = Number.isFinite(bi.firstBeat) ? bi.firstBeat : 0;
  const denom = bi.meter === 6 ? 8 : 4;
  const beatsPerBar = (bi.meter / denom) * 4;           // 以四分音符计(6/8→3)
  const barSec = beatsPerBar * spb;
  const subOff = subtitleOffset();

  // 谱头回退:首拍前已有音符/歌词(弱起人声早于 madmom 首拍)→ origin 回退整数小节,避免开头内容整段消失
  let earliest = Infinity;
  for (const n of state.melodyData.notes) {
    const s = Number(n.start);
    if (Number.isFinite(s)) earliest = Math.min(earliest, s);
  }
  for (const w of state.words) {
    if (w.word) earliest = Math.min(earliest, w.start - subOff);
  }
  const origin = extendOrigin(earliest, rawOrigin, barSec);

  // 量化网格:八分音符(慢歌十六分)
  const gridBeats = bi.bpm < 84 ? 0.25 : 0.5;
  const gridSec = spb * gridBeats;
  const qNotes = quantizeMelodyNotes(state.melodyData.notes, gridSec, origin)
    .map((q) => ({ startB: (q.start - origin) / spb, lenB: q.length / spb, pitch: q.pitch, conf: q.conf, sec: q.start }));
  if (qNotes.length < MIN_MELODY_NOTES) {
    state.mode = 'estimate';
    renderView();
    return;
  }

  // 八度归一 + 离群折叠(八度点最多 ±1)
  normalizeOctaves(qNotes, key.onePc);

  body.setAttribute('data-mode', 'melody');
  body.innerHTML = '<div class="yc-j-score"></div>';
  const scoreDiv = body.querySelector('.yc-j-score');
  if (!scoreDiv) return;

  // 行宽以插入 DOM 后的谱容器实测:空 body 的 clientWidth 可能是旧布局值,
  // 估小 → 每行小节过少 + 行 natural 宽 > availW 触发 width:100% → 整行被放大拉伸
  const availW = Math.max(300, (scoreDiv.clientWidth || body.clientWidth || 800) - 16);

  // 分行:jianpurender 单实例只横向延展 → 按小节贪心装行,每行一个实例纵向堆叠
  const plan = planMelodyRows(qNotes, beatsPerBar, availW, spb, origin);
  const lyricsByRow = planMelodyLyrics(state.words, subOff, origin, spb, beatsPerBar, plan);
  {
    const considered = state.words.filter((w) => w && w.word).length;
    const placed = lyricsByRow.reduce((s, r) => s + r.items.length, 0);
    console.log(`[JianpuChart] melody lyrics: ${placed}/${considered} words placed across ${plan.rows.length} rows`);
  }

  const colors = themeColors();
  const builtRows = [];
  const flatSecs = [];
  const flatRefs = [];
  try {
    plan.rows.forEach((row, r) => {
      const score = {
        notes: row.notes,
        lyrics: [],                                     // 歌词由本视图自绘(attachLyricStrip),不走库的歌词管线
        tempos: [{ start: 0, qpm: Math.round(bi.bpm) }],
        keySignatures: [{ start: 0, key: key.onePc }],
        timeSignatures: [{ start: 0, numerator: bi.meter, denominator: denom }],
      };

      const rowDiv = document.createElement('div');
      rowDiv.className = 'yc-j-row';
      scoreDiv.appendChild(rowDiv);
      const inst = new window.jr.JianpuSVGRender(score, {
        noteHeight: 22,
        noteColor: colors.noteColor,
        activeNoteColor: colors.activeNoteColor,
        scrollType: 0,   // ScrollType.PAGE(滚动由本视图接管)
        onNoteClick: (note) => {
          const video = getVideoEl();
          if (!video) return;
          // note 可能是库内切分后的音符(start 为行内拍数)→ 回秒后跳转
          const t = origin + (row.startBeat + Number(note?.start)) * spb;
          if (Number.isFinite(t)) video.currentTime = Math.max(0, t);
        },
      }, rowDiv);
      fitRowSvg(inst, r > 0);
      const lr = lyricsByRow[row.defIdx];
      attachLyricStrip(rowDiv, inst, lr?.items, lr?.spanBeats || 0);
      builtRows.push({ inst, div: rowDiv, startBeat: row.startBeat, endBeat: row.endBeat, notes: row.notes });
      row.notes.forEach((n) => { flatSecs.push(n.sec); flatRefs.push({ rowIdx: builtRows.length - 1, note: n }); });
    });

    if (!builtRows.length) throw new Error('no rows built');
    if (token !== state.renderToken) {   // 竞态:构造期间被替换
      for (const row of builtRows) { try { row.inst?.destroy?.(); } catch { /* ignore */ } }
      return;
    }
    state.rows = builtRows;
    state.jrTime = flatSecs;
    state.jrRefs = flatRefs;
    const video = getVideoEl();
    if (video) updateHighlight(video.currentTime);
  } catch (err) {
    console.warn('[JianpuChart] JianpuSVGRender failed:', err);
    for (const row of builtRows) { try { row.inst?.destroy?.(); } catch { /* ignore */ } }
    state.mode = 'estimate';
    renderView();
  }
}

// ───────────────────────────────────────────────
// 7. 点击跳转(推算模式)
// ───────────────────────────────────────────────
function bindBodyClicks(container) {
  const body = container?.querySelector('.yc-j-body');
  if (!body) return;
  body.addEventListener('click', (event) => {
    const video = getVideoEl();
    if (!video) return;
    const wordEl = event.target.closest('.yc-j-word');
    if (wordEl) {
      const t = parseFloat(wordEl.dataset.time);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t - subtitleOffset());
      return;
    }
    const mlyrEl = event.target.closest('.yc-j-mlyr');   // 旋律模式自绘歌词(时间为视频时间轴)
    if (mlyrEl) {
      const t = parseFloat(mlyrEl.dataset.time);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t);
      return;
    }
    const chordEl = event.target.closest('.yc-j-chord');
    if (chordEl) {
      const t = parseFloat(chordEl.dataset.time);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t);
    }
  });
}

// ───────────────────────────────────────────────
// 8. 播放高亮同步
// ───────────────────────────────────────────────
function updateHighlight(currentTime) {
  if (!state.enabled || !state.container) return;

  if (state.mode === 'melody') {
    updateMelodyHighlight(currentTime);
  } else {
    updateEstimateHighlight(currentTime);
  }

  // 补发预览面板时间事件(原逻辑在 updateLyricsChordsHighlight 尾部,被本视图提前 return 跳过)
  if (window.ycChordsPreviewPanel?.isVisible) {
    window.dispatchEvent(
      new CustomEvent('yc:timeUpdate', { detail: { time: currentTime, isScrubbing: false } })
    );
  }
}

// 清除一行的播放高亮(库 redraw(null) 会整行重排,这里按其内部规则直接还原颜色)
function clearRowHighlight(row) {
  if (!row?.inst) return;
  try {
    const color = row.inst.config?.noteColor;
    if (!color) return;
    row.inst.mainSVG.querySelectorAll('g[data-id]').forEach((g) => {
      g.querySelectorAll('text, path').forEach((el) => {
        if (el.getAttribute('fill') !== 'none') el.setAttribute('fill', color);
        const stroke = el.getAttribute('stroke');
        if (stroke !== null && stroke !== 'none') el.setAttribute('stroke', color);
      });
    });
  } catch { /* 内部结构变化时忽略 */ }
}

// 旋律模式:当前音符索引变化才 redraw;跨行时清旧行、切行背景、自动滚动
function updateMelodyHighlight(currentTime) {
  if (!state.rows.length || !state.jrTime.length) return;
  const idx = binarySearchLastNum(state.jrTime, currentTime);
  if (idx === state.lastNoteIdx) return;
  const prevIdx = state.lastNoteIdx;
  state.lastNoteIdx = idx;
  const newRef = idx >= 0 ? state.jrRefs[idx] : null;
  const oldRef = prevIdx != null && prevIdx >= 0 && prevIdx < state.jrRefs.length ? state.jrRefs[prevIdx] : null;
  if (oldRef && (!newRef || oldRef.rowIdx !== newRef.rowIdx)) {
    clearRowHighlight(state.rows[oldRef.rowIdx]);
  }
  const rowIdx = newRef ? newRef.rowIdx : -1;
  if (rowIdx !== state.lastRowIdx) {
    state.rows.forEach((row, i) => row.div.classList.toggle('yc-j-row-active', i === rowIdx));
    state.lastRowIdx = rowIdx;
  }
  if (!newRef) return;
  try {
    state.rows[rowIdx].inst.redraw(newRef.note, false);
  } catch { /* 渲染竞态时静默 */ }
  maybeScrollToActive(state.rows[rowIdx].div, rowIdx);
}

// 推算模式:词/和弦 chip/当前小节/段落头 class 切换(小节=网格取整)
function updateEstimateHighlight(currentTime) {
  const body = state.container.querySelector('.yc-j-body');
  if (!body || body.getAttribute('data-mode') !== 'estimate') return;

  const { origin, measureDur } = estimateGrid();
  const wIdx = binarySearchLast(state.words, currentTime + subtitleOffset(), 'start');
  const cIdx = binarySearchLast(state.chords, currentTime, 'time');
  let mIdx = Math.floor((currentTime - origin) / measureDur);
  if (mIdx < 0) mIdx = -1;   // 首拍之前不高亮小节

  if (wIdx !== state.lastWordIdx) {
    body.querySelectorAll('.yc-j-word.yc-j-active').forEach((el) => el.classList.remove('yc-j-active'));
    if (wIdx >= 0) {
      const el = body.querySelector(`.yc-j-word[data-wi="${wIdx}"]`);
      if (el) el.classList.add('yc-j-active');
    }
    state.lastWordIdx = wIdx;
  }

  if (cIdx !== state.lastChordIdx) {
    body.querySelectorAll('.yc-j-chord.yc-j-active').forEach((el) => el.classList.remove('yc-j-active'));
    if (cIdx >= 0) {
      const el = body.querySelector(`.yc-j-chord[data-ci="${cIdx}"]`);
      if (el) el.classList.add('yc-j-active');
    }
    state.lastChordIdx = cIdx;
  }

  if (mIdx !== state.lastLineIdx) {
    body.querySelectorAll('.yc-j-m.yc-j-active').forEach((el) => el.classList.remove('yc-j-active'));
    if (mIdx >= 0) {
      const mEl = body.querySelector(`.yc-j-m[data-mi="${mIdx}"]`);
      if (mEl) {
        mEl.classList.add('yc-j-active');
        maybeScrollToActive(mEl, mIdx);
      }
    }
    state.lastLineIdx = mIdx;
  }

  if (state.sections.length) {
    // 段落时间轴与词同源(字幕时间)→ 同口径比较
    const sIdx = binarySearchLast(state.sections, currentTime + subtitleOffset(), 'time');
    if (sIdx !== state.lastSectionIdx) {
      body.querySelectorAll('.yc-j-section.yc-j-active').forEach((el) => el.classList.remove('yc-j-active'));
      if (sIdx >= 0) {
        const el = body.querySelector(`.yc-j-section[data-si="${sIdx}"]`);
        if (el) el.classList.add('yc-j-active');
      }
      state.lastSectionIdx = sIdx;
    }
  }
}

// 尊重面板 Sync with YouTube / Auto scroll 开关
function autoScrollWanted() {
  const syncTog = document.querySelector('#sync-youtube-toggle');
  const autoTog = document.querySelector('#auto-scroll-toggle');
  return syncTog?.classList.contains('active') || autoTog?.classList.contains('active');
}

function maybeScrollToActive(lineEl, lineIdx) {
  if (!autoScrollWanted()) return;
  if (state.lastScrollLineIdx === lineIdx) return;
  state.lastScrollLineIdx = lineIdx;
  try {
    lineEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch {
    lineEl.scrollIntoView();
  }
}

// ───────────────────────────────────────────────
// 9. 全局事件(capo/移调重渲、面板关闭清理、拖动即时高亮)
// ───────────────────────────────────────────────
function attachGlobalListenersOnce() {
  if (state.globalListenersAttached) return;
  state.globalListenersAttached = true;

  // Capo/移调只影响推算模式的和弦名显示(chips 经 displayName),旋律级数不变 → 重渲即可
  const rerenderOnChange = () => {
    if (!state.enabled) return;
    rebuildAndRender();
  };
  window.addEventListener('yc:capoChanged', rerenderOnChange);
  window.addEventListener('yc:capoFeatureToggled', rerenderOnChange);
  window.addEventListener('yc:keyTransposeChanged', rerenderOnChange);

  // 面板关闭:清引用,保留开关偏好(重开面板经 onContentRendered 自动恢复)
  window.addEventListener('yc:panelClosing', () => {
    state.enabled = false;
    state.container = null;
    state.chords = [];
    state.words = [];
    state.wiBase = new Map();
    state.lines = [];
    state.sections = [];
    state.beatsData = null;
    state.melodyData = null;
    state.renderToken++;
    destroyRenderer();
    resetHighlightCache();
  });

  // 拖动进度条 / 手动滚动期间的分发事件 → 即时高亮
  window.addEventListener('yc:timeUpdate', (e) => {
    if (!state.enabled || !e.detail?.isScrubbing) return;
    const t = Number(e.detail.time);
    if (Number.isFinite(t)) updateHighlight(t);
  });
}

// ───────────────────────────────────────────────
// 10. 对外接口
// ───────────────────────────────────────────────
function resetHighlightCache() {
  state.lastWordIdx = null;
  state.lastChordIdx = null;
  state.lastLineIdx = null;
  state.lastSectionIdx = null;
  state.lastNoteIdx = null;
  state.lastRowIdx = null;
  state.lastScrollLineIdx = null;
}

function rebuildAndRender() {
  renderView();
  const video = getVideoEl();
  if (video) updateHighlight(video.currentTime);
}

// loadLyricsChordsContent 渲染完成后的接管钩子(须在 combinedData 释放前同步调用)
function onContentRendered(combinedData, authoritativeChords, container) {
  if (!window.jianpuViewEnabled) return;
  state.enabled = true;
  state.container = container || document.querySelector('.yt-lyrics-chords-panel .lyrics-chords-content');
  state.videoId = getVideoId();

  const data = extractData(combinedData, authoritativeChords);
  state.chords = data.chords;
  state.words = data.words;
  state.wiBase = data.wiBase;
  state.lines = data.lines;
  state.sections = data.sections;
  state.beatsData = window.chordsDisplay?.currentSongData?.beatsData || null;
  state.melodyData = window.chordsDisplay?.currentSongData?.melodyData || null;

  attachGlobalListenersOnce();

  const applySettingsAndRender = () => {
    if (state.settingsLoadedFor !== state.videoId) {
      rebuildAndRender();   // 先以估计调性立即渲染
      loadSettings(state.videoId).then(rebuildAndRender).catch(() => {});
    } else {
      rebuildAndRender();
    }
  };

  if (!state.chords.length && !hasMelody()) {
    // 双弱源皆空 → 异步直读和弦库(同时带出 melodyData);期间先渲空态,到位后重渲
    const vid = state.videoId;
    console.log('[JianpuChart] authoritative/inline chords empty — pulling from chord library…');
    pullChordsFromDb(vid).then((pulled) => {
      if (!pulled || state.enabled === false || state.videoId !== vid) return;
      state.chords = pulled.chords;
      state.beatsData = pulled.beatsData;
      state.melodyData = pulled.melodyData;
      console.log('[JianpuChart] 🎼', pulled.chords.length, 'chords loaded from chord library');
      applySettingsAndRender();
    });
  }
  applySettingsAndRender();
}

// 开关入口(面板 Jianpu toggle 调用):翻转偏好并触发面板重渲
// 与 Measure/TAB 互斥:面板内容只能被一个视图接管,开启时联动关闭两者
window.toggleJianpuView = async function () {
  const next = !window.jianpuViewEnabled;
  window.jianpuViewEnabled = next;

  const syncUpdate = { [SYNC_KEY]: next };
  if (next) {
    window.measureViewEnabled = false;
    window.tabViewEnabled = false;
    syncUpdate.measureViewEnabled = false;
    syncUpdate.tabViewEnabled = false;
  }
  try {
    await chrome.storage.sync.set(syncUpdate);
  } catch (err) {
    console.warn('[JianpuChart] Failed to persist toggle:', err);
  }
  const toggleEl = document.querySelector('#jianpu-view-toggle');
  if (toggleEl) toggleEl.classList.toggle('active', next);
  if (next) {
    for (const sel of ['#measure-view-toggle', '#tab-view-toggle']) {
      document.querySelector(sel)?.classList.remove('active');
    }
  }

  if (!next) {
    state.enabled = false;
    state.container = null;
    state.chords = [];
    state.words = [];
    state.wiBase = new Map();
    state.lines = [];
    state.sections = [];
    state.beatsData = null;
    state.melodyData = null;
    state.renderToken++;
    destroyRenderer();
    resetHighlightCache();
  }

  // 统一经 refreshLyricsChordsPanel 重建内容:
  // 开 → hook 触发 onContentRendered 接管;关 → 原始歌词列表恢复并失效旧缓存
  if (typeof window.refreshLyricsChordsPanel === 'function') {
    try {
      await window.refreshLyricsChordsPanel();
    } catch (err) {
      console.warn('[JianpuChart] Panel refresh failed:', err);
    }
  }
};

window.ycJianpu = {
  get isEnabled() { return state.enabled; },
  toggle: window.toggleJianpuView,
  onContentRendered,
  updateHighlight,
  onPanelClosing() {
    state.enabled = false;
    state.container = null;
    state.renderToken++;
    destroyRenderer();
    resetHighlightCache();
  },
};

// ───────────────────────────────────────────────
// 11. 初始化:读全局开关镜像到 window
// ───────────────────────────────────────────────
try {
  chrome.storage.sync.get([SYNC_KEY], (result) => {
    window.jianpuViewEnabled = result?.[SYNC_KEY] === true;
  });
} catch {
  window.jianpuViewEnabled = false;
}

// ───────────────────────────────────────────────
// 12. 样式(注入一次;主题/RTL 经面板类继承)
// ───────────────────────────────────────────────
function ensureCss() {
  if (state.cssInjected || document.getElementById('yc-jianpu-chart-style')) {
    state.cssInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'yc-jianpu-chart-style';
  style.textContent = `
    .yc-jianpu-view { padding: 8px 12px 32px; }
    .yc-j-toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 6px 8px; margin-bottom: 10px;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
      font-size: 12px;
    }
    .yc-j-tb-item { display: flex; align-items: center; gap: 4px; color: inherit; }
    .yc-j-key-select {
      max-width: 220px; background: transparent; color: inherit;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
    }
    .yc-j-key-select option, .yc-j-key-select optgroup { color: #111; }
    .yc-j-tb-btn {
      background: transparent; color: inherit; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
      padding: 2px 6px; font-size: 11px;
    }
    .yc-j-tb-btn:hover { background: rgba(127,127,127,0.25); }
    .yc-j-tb-btn.yc-j-on { border-color: #3ea6ff; color: #3ea6ff; }
    .yc-j-key-label { font-weight: 600; white-space: nowrap; }
    .yc-j-badge {
      font-size: 11px; padding: 1px 8px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.25); white-space: nowrap;
    }
    .yc-j-badge-melody { color: #6bd68a; border-color: rgba(107,214,138,0.5); }
    .yc-j-badge-est { color: #e8b45a; border-color: rgba(232,180,90,0.5); }
    .yc-j-hint {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 4px 8px; margin-bottom: 10px;
      border: 1px dashed rgba(255,255,255,0.25); border-radius: 8px;
      font-size: 11px; opacity: 0.9;
    }
    .yc-j-hint .yc-j-reanalyze { flex-shrink: 0; }
    .yc-j-hint .yc-j-reanalyze:disabled { opacity: 0.5; cursor: default; }
    .yc-j-loading { padding: 24px; text-align: center; opacity: 0.6; }
    .yc-j-empty { padding: 24px; text-align: center; opacity: 0.6; }

    /* 旋律模式:分行谱(每行若干小节纵向堆叠;库单实例只横向延展,由视图切行) */
    .yc-j-body[data-mode="melody"] .yc-j-score {
      display: flex; flex-direction: column; gap: 6px; width: 100%;
    }
    .yc-j-body[data-mode="melody"] .yc-j-row { border-radius: 6px; }
    .yc-j-body[data-mode="melody"] .yc-j-row-active { background: rgba(62, 166, 255, 0.08); }
    /* 旋律模式自绘歌词条(词绝对定位在对应音符下方) */
    .yc-j-lystrip { position: relative; height: 20px; margin-top: 1px; }
    .yc-j-mlyr {
      position: absolute; top: 0; white-space: nowrap;
      font-size: 14px; line-height: 20px; opacity: 0.85; cursor: pointer;
    }

    /* 推算模式:歌本式小节谱(小节竖线分隔,同行多小节自动换行) */
    .yc-j-section {
      display: flex; align-items: center; gap: 8px;
      margin: 8px 0 4px; padding: 2px 2px 0;
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; opacity: 0.7;
    }
    .yc-j-section::after {
      content: ""; flex: 1; height: 1px;
      background: currentColor; opacity: 0.25;
    }
    .yc-j-section.yc-j-active { opacity: 1; color: #3ea6ff; }
    .yc-j-mrow { display: flex; flex-wrap: wrap; align-items: stretch; }
    .yc-j-m {
      flex: 1 1 24%; min-width: 86px;
      padding: 1px 5px 4px; margin-bottom: 6px;
      border-inline-end: 1px solid rgba(255,255,255,0.28);
      border-radius: 0;
      transition: background 0.15s ease;
    }
    .yc-j-m.yc-j-active { background: rgba(62,166,255,0.10); }
    /* 长间奏压缩的省略号小节 */
    .yc-j-mgap {
      flex: 0 0 auto; min-width: 34px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0.4; font-size: 12px;
    }
    .yc-j-mchords { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 1px; }
    .yc-j-mnotes { display: flex; flex-wrap: wrap; align-items: flex-start; column-gap: 1px; row-gap: 3px; padding-top: 1px; }
    /* 音符格:上=级数数字(含记号),下=歌词字(一字一音) */
    .yc-j-note {
      display: inline-flex; flex-direction: column; align-items: center;
      cursor: pointer; border-radius: 3px; padding: 0 1px;
      min-width: 1.4em; text-align: center;
    }
    .yc-j-note:hover { background: rgba(127,127,127,0.25); }
    .yc-j-note-rest { opacity: 0.5; cursor: default; }
    .yc-j-note-rest:hover { background: transparent; }
    .yc-j-word.yc-j-active .yc-j-num,
    .yc-j-word.yc-j-active .yc-j-lyr { color: #3ea6ff; font-weight: 700; }
    /* 数字行:固定高度 21px = 共用减时线的定位基准 */
    .yc-j-num {
      display: flex; align-items: flex-end; justify-content: center;
      height: 21px; font-size: 15px; font-weight: 700;
      line-height: 1.15; white-space: nowrap; font-style: normal;
    }
    .yc-j-ngrp .yc-j-num { padding-bottom: 2px; }
    /* 共用减时线(歌本惯例):相邻八分/十六分音符组共用一条横线 */
    .yc-j-ngrp { position: relative; display: inline-flex; }
    .yc-j-ngrp::after {
      content: ""; position: absolute; left: 1px; right: 1px; top: 19px;
      border-top: 1.5px solid currentColor;
    }
    .yc-j-ngrp.yc-j-g2::after { box-shadow: 0 -3.5px 0 currentColor; }
    /* 附点 / 延音线 / 小字唱名 */
    .yc-j-dot { font-style: normal; font-weight: 400; font-size: 12px; opacity: 0.85; }
    .yc-j-dash { font-style: normal; font-weight: 400; font-size: 11px; opacity: 0.85; letter-spacing: -1px; }
    .yc-j-sol { font-style: normal; font-size: 9px; opacity: 0.55; margin-inline-start: 2px; padding-bottom: 2px; }
    .yc-j-lyr { font-size: 11px; line-height: 1.25; opacity: 0.92; max-width: 6em; overflow-wrap: anywhere; }
    .yc-j-chord {
      cursor: pointer; white-space: nowrap; align-self: flex-start;
      font-size: 10px; font-weight: 600; color: #3ea6ff;
      border: 1px solid rgba(62,166,255,0.45); border-radius: 9px;
      padding: 0 5px;
    }
    .yc-j-chord.yc-j-active { background: rgba(62,166,255,0.18); }

    /* RTL:小节与音符行内从右往左 */
    .yt-lyrics-chords-rtl .yc-j-mrow,
    .yt-lyrics-chords-rtl .yc-j-mnotes { direction: rtl; }

    /* 亮色主题(sepia / light):深色边框与强调色 */
    .yt-lyrics-chords-panel.sepia-theme .yc-j-toolbar,
    .yt-lyrics-chords-panel.light-theme .yc-j-toolbar { border-color: rgba(0,0,0,0.18); }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-key-select,
    .yt-lyrics-chords-panel.sepia-theme .yc-j-tb-btn,
    .yt-lyrics-chords-panel.light-theme .yc-j-key-select,
    .yt-lyrics-chords-panel.light-theme .yc-j-tb-btn { border-color: rgba(0,0,0,0.25); }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-hint,
    .yt-lyrics-chords-panel.light-theme .yc-j-hint { border-color: rgba(0,0,0,0.22); }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-m,
    .yt-lyrics-chords-panel.light-theme .yc-j-m { border-inline-end-color: rgba(0,0,0,0.28); }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-m.yc-j-active,
    .yt-lyrics-chords-panel.light-theme .yc-j-m.yc-j-active { background: rgba(30,111,217,0.08); }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-word.yc-j-active .yc-j-num,
    .yt-lyrics-chords-panel.sepia-theme .yc-j-word.yc-j-active .yc-j-lyr,
    .yt-lyrics-chords-panel.light-theme .yc-j-word.yc-j-active .yc-j-num,
    .yt-lyrics-chords-panel.light-theme .yc-j-word.yc-j-active .yc-j-lyr { color: #1e6fd9; }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-section.yc-j-active,
    .yt-lyrics-chords-panel.light-theme .yc-j-section.yc-j-active { color: #1e6fd9; }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-tb-btn.yc-j-on,
    .yt-lyrics-chords-panel.light-theme .yc-j-tb-btn.yc-j-on { color: #1e6fd9; border-color: #1e6fd9; }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-chord,
    .yt-lyrics-chords-panel.light-theme .yc-j-chord { color: #1e6fd9; border-color: rgba(30,111,217,0.45); }
    .yt-lyrics-chords-panel.sepia-theme .yc-j-chord.yc-j-active,
    .yt-lyrics-chords-panel.light-theme .yc-j-chord.yc-j-active { background: rgba(30,111,217,0.15); }
  `;
  document.head.appendChild(style);
  state.cssInjected = true;
}
})();
