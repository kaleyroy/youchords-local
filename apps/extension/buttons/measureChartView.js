/* yc-module-scope */
// Measure Chart View (小节视图) — 按小节(measure/bar)展示和弦并与歌词同步
// 两种时序来源(Source 选择器,默认 Auto,有管线数据即自动用管线):
//   推算版:恒定 BPM 均匀网格。小节起点 = offset + n × (60/BPM × beatsPerBar)
//           初始 BPM 由和弦变化间隔中位数估算(假设每小节 2 次换和弦),用户可 ×2/÷2/手输修正。
//   管线版:local-companion madmom downbeat 真实时间数组(非均匀网格),
//           小节边界 = 相邻 downbeat;数据随和弦 JSON 下发(beatsData)。
// 检测拍号空间 [3,4];6/8 歌曲请切回推算模式手选 Beats=6。
// 仅在 "Transcribe & Chords" 面板内接管 .lyrics-chords-content;默认关闭时零行为变化。
(function () {
'use strict';

// ───────────────────────────────────────────────
// 0. 常量与状态
// ───────────────────────────────────────────────
const DEFAULT_SETTINGS = { bpm: 120, beatsPerBar: 4, offset: 0, source: 'auto' };
const BPM_MIN = 40;
const BPM_MAX = 240;
const VALID_BEATS = [3, 4, 6];
const VALID_SOURCES = ['auto', 'inferred', 'pipeline'];
const LOCAL_KEY_PREFIX = 'yc_measure_';   // chrome.storage.local, per video
const SYNC_KEY = 'measureViewEnabled';    // chrome.storage.sync, global
const SAVE_DEBOUNCE_MS = 300;
const MIN_CHORD_DELTA = 0.05;             // 秒,过滤同点重复和弦
const MIN_PIPELINE_BEATS = 4;             // 管线拍点少于此数视为无数据
const PICKUP_MEASURE_MAX = 0.5;           // 首 downbeat 前留 pickup 小节的阈值(秒)

const state = {
  enabled: false,            // 视图当前接管面板内容
  container: null,           // 被接管的容器(.lyrics-chords-content / #defaultLyricsSection)
  videoId: null,
  settings: { ...DEFAULT_SETTINGS },
  settingsLoadedFor: null,   // 已为哪个 videoId 加载/估算过设置
  settingsFromArchive: false, // 当前设置是否来自存档(否则为估算值,和弦到位后应重估)
  chords: [],                // [{ name, time }] 视频时间轴,已排序
  words: [],                 // [{ word, start, end }] 字幕时间轴,已排序
  beatsData: null,           // 管线下发 { bpm, meter, beats:[{time,pos}] };旧缓存为 null
  pipeline: null,            // 构建时缓存 { info:{beats,meter,bpm}|null, mode:'pipeline'|'inferred' }
  measures: [],              // [{ n, start, chordSlots[beat][], words[] }]
  // 高亮缓存(索引未变则不碰 DOM)
  lastMeasureIdx: null,
  lastWordIdx: null,
  lastChordIdx: null,
  lastScrollMeasureIdx: null,
  // 基础设施
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

// ───────────────────────────────────────────────
// 2. 小节数学(恒定 BPM 均匀网格)
// ───────────────────────────────────────────────
function beatDur() { return 60 / state.settings.bpm; }
function measureDur() { return beatDur() * state.settings.beatsPerBar; }
function measureStart(n) { return state.settings.offset + n * measureDur(); }
function measureIndex(t) {
  return Math.floor((t - state.settings.offset) / measureDur());
}
function clampBpm(bpm) { return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)); }

// 初始 BPM 估算:相邻和弦间隔中位数 → 假设每小节 2 次换和弦
function estimateBpmFromChords(chords, beatsPerBar) {
  if (!Array.isArray(chords) || chords.length < 2) return DEFAULT_SETTINGS.bpm;
  const times = chords.map((c) => c.time).sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > MIN_CHORD_DELTA) deltas.push(d);
  }
  if (!deltas.length) return DEFAULT_SETTINGS.bpm;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.round(clampBpm((60 * beatsPerBar) / (2 * median)));
}

// ───────────────────────────────────────────────
// 2b. 管线 downbeat 数据(madmom 检测,随和弦记录下发)
// ───────────────────────────────────────────────
// 归一化 beatsData → { beats:[{time,pos}] 已排序, meter, bpm };不可用返回 null
function getPipelineBeats() {
  const data = state.beatsData;
  const raw = Array.isArray(data?.beats) ? data.beats : [];
  const beats = raw
    .filter((b) => b && Number.isFinite(Number(b.time)) && Number.isInteger(Number(b.pos)) && b.pos >= 1)
    .map((b) => ({ time: Number(b.time), pos: Number(b.pos) }))
    .sort((a, b) => a.time - b.time);
  if (beats.length < MIN_PIPELINE_BEATS || !beats.some((b) => b.pos === 1)) return null;

  // meter:优先管线检测值;缺失按相邻 downbeat 间拍数众数推导
  let meter = Number(data?.meter);
  if (![3, 4, 6].includes(meter)) {
    const lens = [];
    let count = 0;
    for (const b of beats) {
      if (b.pos === 1) {
        if (count > 0) lens.push(count);
        count = 1;
      } else {
        count++;
      }
    }
    if (count > 0) lens.push(count);
    meter = 4;
    if (lens.length) {
      const freq = new Map();
      for (const l of lens) freq.set(l, (freq.get(l) || 0) + 1);
      meter = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  // bpm:优先管线检测值;缺失按拍间隔中位数换算
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

// 刷新管线状态缓存(每次 buildMeasures 前调用,避免逐帧重算):
// inferred 显式锁定推算;auto/pipeline 有数据用管线,无数据回退推算(工具条提示)
function refreshPipelineState() {
  const info = getPipelineBeats();
  const mode = state.settings.source === 'inferred' ? 'inferred' : (info ? 'pipeline' : 'inferred');
  state.pipeline = { info, mode };
}

// ───────────────────────────────────────────────
// 3. 设置持久化(每视频 local,开关全局 sync)
// ───────────────────────────────────────────────
function normalizeSettings(raw) {
  const bpm = Number(raw?.bpm);
  const beats = Number(raw?.beatsPerBar);
  const offset = Number(raw?.offset);
  const source = String(raw?.source || '');
  return {
    bpm: Number.isFinite(bpm) ? clampBpm(bpm) : DEFAULT_SETTINGS.bpm,
    beatsPerBar: VALID_BEATS.includes(beats) ? beats : DEFAULT_SETTINGS.beatsPerBar,
    offset: Number.isFinite(offset) ? offset : DEFAULT_SETTINGS.offset,
    source: VALID_SOURCES.includes(source) ? source : DEFAULT_SETTINGS.source,
  };
}

async function loadSettings(videoId) {
  const key = LOCAL_KEY_PREFIX + videoId;
  try {
    const got = await chrome.storage.local.get(key);
    const saved = got?.[key];
    const hasArchive = !!(saved && Number.isFinite(Number(saved.bpm)));
    state.settingsFromArchive = hasArchive;
    if (hasArchive) {
      state.settings = normalizeSettings(saved);
    } else {
      // 无存档:估算并立即保存
      state.settings = {
        ...DEFAULT_SETTINGS,
        bpm: estimateBpmFromChords(state.chords, DEFAULT_SETTINGS.beatsPerBar),
      };
      scheduleSave();
    }
  } catch (err) {
    console.warn('[MeasureChart] Failed to load settings:', err);
    state.settings = { ...DEFAULT_SETTINGS };
  }
  state.settingsLoadedFor = videoId;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    const key = LOCAL_KEY_PREFIX + (state.videoId || 'default');
    try {
      chrome.storage.local.set({ [key]: { ...state.settings } });
    } catch (err) {
      console.warn('[MeasureChart] Failed to save settings:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ───────────────────────────────────────────────
// 4. 数据提取(在 combinedData 被释放前同步完成)
// ───────────────────────────────────────────────
function extractData(combinedData, authoritativeChords) {
  // 和弦:权威列表优先;否则从行内 chords 汇总(按时间去重)
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
        // 某些流程只把和弦挂在 wordChordPairs 上
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

  // 歌词词:跳过 chordGap 空占位
  const words = [];
  if (Array.isArray(combinedData)) {
    for (const line of combinedData) {
      for (const w of (line?.words || [])) {
        const text = String(w?.word || w?.text || '').trim();
        const start = Number(w?.start);
        if (text && Number.isFinite(start)) {
          const end = Number(w?.end);
          words.push({ word: text, start, end: Number.isFinite(end) ? end : start });
        }
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  return { chords, words };
}

// 4b. 和弦库兜底源(与 chordsDisplay._parseChordText 同格式 "t:name,t:name,…")
// 权威源(chordsDisplay.currentSongData)依赖 Chords 按钮激活;内联和弦受面板
// 显示策略抑制(YouTube 词级字幕 / 无 wordSRT)。两者皆空时直接读 IndexedDB。
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

// 按 chords mode 选文本(兼容 chordText 对象格式与旧版平铺字段)
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

// 兜底:直接从和弦库拉取。DB 记录优先——chordTextsCache 只存文本字段,无 beatsData
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
    console.warn('[MeasureChart] chord library pull failed:', err);
    return null;
  }
}

// ───────────────────────────────────────────────
// 5. 构建小节网格(按生效来源分派:管线真实 downbeat / 推算均匀网格)
// ───────────────────────────────────────────────
function buildMeasures() {
  refreshPipelineState();
  if (state.pipeline.mode === 'pipeline') {
    buildMeasuresFromDownbeats(state.pipeline.info);
  } else {
    buildUniformMeasures();
  }
}

// 推算版:恒定 BPM 均匀网格
function buildUniformMeasures() {
  const { chords, words } = state;
  const bd = beatDur();
  const bpb = state.settings.beatsPerBar;

  // 覆盖到最后一处数据所在小节
  let maxT = 0;
  if (chords.length) maxT = chords[chords.length - 1].time;
  if (words.length) maxT = Math.max(maxT, words[words.length - 1].end - subtitleOffset());
  const lastN = Math.max(0, measureIndex(maxT));

  const measures = [];
  for (let n = 0; n <= lastN; n++) {
    measures.push({
      n,
      start: measureStart(n),
      chordSlots: Array.from({ length: bpb }, () => []),
      words: [],
    });
  }
  const clampN = (idx) => Math.max(0, Math.min(measures.length - 1, idx));

  // 和弦 → 小节 + 拍位(offset 之前钳到第 0 小节)
  chords.forEach((ch, gi) => {
    const n = clampN(measureIndex(ch.time));
    const local = ch.time - measures[n].start;
    const beat = Math.max(0, Math.min(bpb - 1, Math.floor(local / bd)));
    measures[n].chordSlots[beat].push({ ...ch, gi });
  });

  // 词 → 小节(字幕时间转视频时间后落格)
  words.forEach((w, wi) => {
    const n = clampN(measureIndex(w.start - subtitleOffset()));
    measures[n].words.push({ ...w, wi });
  });

  state.measures = measures;
}

// 管线版:小节边界 = 相邻 downbeat 真实时间(整体加 settings.offset,允许微调)。
// 首 downbeat 前留不完整 pickup 小节;每小节槽位数 = 小节内实际拍数(容忍检测抖动)
function buildMeasuresFromDownbeats(info) {
  const { chords, words } = state;
  const offset = state.settings.offset;
  const beats = info.beats.map((b) => ({ ...b, time: b.time + offset }));

  // 小节起点:downbeat 时间(去重防相邻重复检测)
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

  const measures = starts.map((start, n) => ({
    n,
    start,
    beatObjs: [],   // 本小节实际拍点 [{time,pos}],定和弦槽位用
    chordSlots: [],
    words: [],
  }));
  const clampN = (idx) => Math.max(0, Math.min(measures.length - 1, idx));

  // 拍点 → 小节(首 downbeat 前的拍点钳入第 0 小节)
  beats.forEach((b) => {
    const n = clampN(binarySearchLast(measures, b.time, 'start'));
    measures[n].beatObjs.push(b);
  });
  measures.forEach((m) => {
    m.chordSlots = Array.from({ length: Math.max(1, m.beatObjs.length) }, () => []);
  });

  // 和弦 → 小节 + 槽位(取小节内先前最近拍点;超出末拍钳最后槽)
  chords.forEach((ch, gi) => {
    const n = clampN(binarySearchLast(measures, ch.time, 'start'));
    const m = measures[n];
    const bIdx = binarySearchLast(m.beatObjs, ch.time, 'time');
    const slot = bIdx < 0 ? 0 : Math.min(m.chordSlots.length - 1, bIdx);
    m.chordSlots[slot].push({ ...ch, gi });
  });

  // 词 → 小节(字幕时间转视频时间后落格)
  words.forEach((w, wi) => {
    const n = clampN(binarySearchLast(measures, w.start - subtitleOffset(), 'start'));
    measures[n].words.push({ ...w, wi });
  });

  state.measures = measures;
}

// ───────────────────────────────────────────────
// 6. 渲染
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

function buildToolbarHtml() {
  const s = state.settings;
  const mode = state.pipeline?.mode || 'inferred';
  const info = mode === 'pipeline' ? state.pipeline.info : null;
  // 管线模式:BPM/拍号展示检测值(控件禁用,仅 Offset 保留微调)
  const bpmVal = info ? info.bpm.toFixed(1) : Math.round(s.bpm);
  const beatsVal = info && VALID_BEATS.includes(info.meter) ? info.meter : s.beatsPerBar;
  return `
    <div class="yc-m-toolbar"${mode === 'pipeline' ? ' data-mode="pipeline"' : ''}>
      <label class="yc-m-tb-item">Source
        <select class="yc-m-src-select" title="Timing source — Pipeline: real madmom downbeats; Estimate: inferred constant-BPM grid">
          <option value="auto"${s.source === 'auto' ? ' selected' : ''}>Auto</option>
          <option value="inferred"${s.source === 'inferred' ? ' selected' : ''}>Estimate</option>
          <option value="pipeline"${s.source === 'pipeline' ? ' selected' : ''}>Pipeline</option>
        </select>
      </label>
      <label class="yc-m-tb-item">BPM
        <input type="number" class="yc-m-bpm-input" min="${BPM_MIN}" max="${BPM_MAX}" step="1" value="${bpmVal}">
      </label>
      <button class="yc-m-tb-btn yc-m-bpm-half" title="Halve BPM">÷2</button>
      <button class="yc-m-tb-btn yc-m-bpm-double" title="Double BPM">×2</button>
      <button class="yc-m-tb-btn yc-m-bpm-auto" title="Estimate BPM from chord changes">Auto</button>
      <label class="yc-m-tb-item">Beats
        <select class="yc-m-beats-select">
          <option value="3"${beatsVal === 3 ? ' selected' : ''}>3</option>
          <option value="4"${beatsVal === 4 ? ' selected' : ''}>4</option>
          <option value="6"${beatsVal === 6 ? ' selected' : ''}>6</option>
        </select>
      </label>
      <span class="yc-m-tb-item">Offset
        <button class="yc-m-tb-btn yc-m-offset-minus" title="Shift grid 0.5s earlier">−0.5</button>
        <span class="yc-m-offset-val">${s.offset.toFixed(1)}s</span>
        <button class="yc-m-tb-btn yc-m-offset-plus" title="Shift grid 0.5s later">+0.5</button>
      </span>
      ${info ? `<span class="yc-m-src-info" title="Detected by local pipeline (madmom RNN+DBN)">🎼 ${info.bpm.toFixed(1)} BPM · ${info.meter}/${info.meter === 6 ? 8 : 4} · madmom</span>` : ''}
    </div>
    ${s.source === 'pipeline' && !info ? `
    <div class="yc-m-src-hint">
      <span>No pipeline beats for this video (old cache) — showing estimated grid</span>
      <button class="yc-m-tb-btn yc-m-reanalyze" title="Delete cached analysis and re-run the local pipeline (downloads audio again)">Re-analyze</button>
    </div>` : ''}`;
}

function renderView() {
  const container = state.container;
  if (!container) return;
  ensureCss();

  if (!state.chords.length) {
    container.innerHTML = '<div class="yc-m-empty">No chords in library for this video — open the Chords panel once to analyze, then reopen this view</div>';
    resetHighlightCache();
    return;
  }

  const scrollTop = container.scrollTop;

  let html = '<div class="yc-measure-view">';
  html += buildToolbarHtml();
  html += `<div class="yc-m-grid">`;
  for (const m of state.measures) {
    // 槽位数取每小节实际值(推算版恒等于 beatsPerBar;管线版容忍检测抖动)
    const slots = m.chordSlots.length;
    html += `<div class="yc-m-box" data-n="${m.n}" data-start="${m.start.toFixed(3)}">`;
    html += `<div class="yc-m-num">${m.n + 1}</div>`;
    html += `<div class="yc-m-chords" style="grid-template-columns:repeat(${slots},minmax(0,1fr))">`;
    for (let b = 0; b < slots; b++) {
      html += '<div class="yc-m-slot">';
      for (const ch of m.chordSlots[b]) {
        html += `<span class="yc-m-chord" data-ci="${ch.gi}" data-time="${ch.time.toFixed(3)}">${escapeHtml(displayName(ch.name))}</span>`;
      }
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="yc-m-words">';
    for (const w of m.words) {
      // 词间必须留空白:纯 inline span 连续拼接无换行点,整节歌词会单行溢出
      html += `<span class="yc-m-word" data-wi="${w.wi}" data-time="${w.start.toFixed(3)}">${escapeHtml(w.word)}</span> `;
    }
    html += '</div>';
    html += '</div>';
  }
  html += '</div></div>';

  container.innerHTML = html;
  container.scrollTop = scrollTop;   // 重渲(BPM 调整/capo)保持滚动位置
  bindToolbar(container);
  bindGridClicks(container);
  resetHighlightCache();
}

function resetHighlightCache() {
  state.lastMeasureIdx = null;
  state.lastWordIdx = null;
  state.lastChordIdx = null;
  state.lastScrollMeasureIdx = null;
}

// ───────────────────────────────────────────────
// 7. 工具条与网格交互
// ───────────────────────────────────────────────
function setBpm(bpm, rerenderNow = true) {
  state.settings.bpm = clampBpm(Math.round(bpm));
  scheduleSave();
  if (rerenderNow) rebuildAndRender();
}

function setBeats(beats) {
  if (!VALID_BEATS.includes(beats)) return;
  state.settings.beatsPerBar = beats;
  scheduleSave();
  rebuildAndRender();
}

function setSource(source) {
  if (!VALID_SOURCES.includes(source)) return;
  state.settings.source = source;
  scheduleSave();
  rebuildAndRender();
}

// 旧缓存无节拍数据时的「重新分析」。两段式:
// ① 删本地记录重取——伴侣缓存若已含节拍数据(如上次分析在 downbeat 上线后)则秒回;
// ② 取回的数据仍无 beats → 伴侣缓存也是旧的,删缓存重跑完整分析(含 downbeat 检测)
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
    if (ok && !record?.beatsData) {
      console.log('[MeasureChart] companion cache lacks beats — re-running full analysis');
      await window.ycAuth?.deleteCachedResult?.(vid);
      ok = await pullFromCompanion();
    }
    if (ok && window.chordsDisplay?.activate) {
      try { await window.chordsDisplay.activate(vid); } catch (err) {
        console.warn('[MeasureChart] chordsDisplay refresh failed:', err);
      }
    }
  } catch (err) {
    console.warn('[MeasureChart] Re-analyze failed:', err);
  }
  // 面板重建 → onContentRendered 拿到新 currentSongData(含 beatsData)
  if (typeof window.refreshLyricsChordsPanel === 'function') {
    try { await window.refreshLyricsChordsPanel(); } catch (err) {
      console.warn('[MeasureChart] Panel refresh failed:', err);
    }
  }
}

function shiftOffset(delta) {
  state.settings.offset = Math.round((state.settings.offset + delta) * 10) / 10;
  scheduleSave();
  rebuildAndRender();
}

function rebuildAndRender() {
  buildMeasures();
  renderView();
  const video = getVideoEl();
  if (video) updateHighlight(video.currentTime);
}

function bindToolbar(container) {
  const root = container.querySelector('.yc-measure-view');
  if (!root) return;

  const bpmInput = root.querySelector('.yc-m-bpm-input');
  bpmInput?.addEventListener('change', () => {
    const v = parseFloat(bpmInput.value);
    if (Number.isFinite(v)) setBpm(v);
  });

  root.querySelector('.yc-m-bpm-half')?.addEventListener('click', () => setBpm(state.settings.bpm / 2));
  root.querySelector('.yc-m-bpm-double')?.addEventListener('click', () => setBpm(state.settings.bpm * 2));
  root.querySelector('.yc-m-bpm-auto')?.addEventListener('click', () => {
    setBpm(estimateBpmFromChords(state.chords, state.settings.beatsPerBar));
  });
  root.querySelector('.yc-m-beats-select')?.addEventListener('change', (e) => {
    setBeats(parseInt(e.target.value, 10));
  });
  root.querySelector('.yc-m-src-select')?.addEventListener('change', (e) => {
    setSource(e.target.value);
  });
  const reanalyzeBtn = root.querySelector('.yc-m-reanalyze');
  reanalyzeBtn?.addEventListener('click', () => triggerReanalyze(reanalyzeBtn));
  root.querySelector('.yc-m-offset-minus')?.addEventListener('click', () => shiftOffset(-0.5));
  root.querySelector('.yc-m-offset-plus')?.addEventListener('click', () => shiftOffset(0.5));
}

function bindGridClicks(container) {
  const grid = container.querySelector('.yc-m-grid');
  if (!grid) return;
  grid.addEventListener('click', (event) => {
    const video = getVideoEl();
    if (!video) return;
    // 词:字幕时间 → 视频时间后跳转
    const wordEl = event.target.closest('.yc-m-word');
    if (wordEl) {
      const t = parseFloat(wordEl.dataset.time);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t - subtitleOffset());
      return;
    }
    // 小节框:跳到小节起点
    const boxEl = event.target.closest('.yc-m-box');
    if (boxEl) {
      const t = parseFloat(boxEl.dataset.start);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t);
    }
  });
}

// ───────────────────────────────────────────────
// 8. 播放高亮同步
// ───────────────────────────────────────────────
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

// 当前小节索引:管线版对真实小节起点二分;推算版等差网格取整(offset 前 → -1 不高亮)
function findMeasureIndex(t) {
  if (state.pipeline?.mode === 'pipeline') {
    return binarySearchLast(state.measures, t, 'start');
  }
  return measureIndex(t);
}

function updateHighlight(currentTime) {
  if (!state.enabled || !state.container) return;
  const grid = state.container.querySelector('.yc-m-grid');
  if (!grid) return;

  // 当前小节
  let mIdx = findMeasureIndex(currentTime);
  if (mIdx >= state.measures.length) mIdx = state.measures.length - 1;

  // 当前词(与面板口径一致:word.start <= currentTime + 字幕偏移)
  const wIdx = binarySearchLast(state.words, currentTime + subtitleOffset(), 'start');
  // 当前和弦
  const cIdx = binarySearchLast(state.chords, currentTime, 'time');

  // 小节高亮 + 自动滚动
  if (mIdx !== state.lastMeasureIdx) {
    grid.querySelectorAll('.yc-m-box.yc-m-active').forEach((el) => el.classList.remove('yc-m-active'));
    if (mIdx >= 0) {
      const box = grid.querySelector(`.yc-m-box[data-n="${mIdx}"]`);
      if (box) {
        box.classList.add('yc-m-active');
        maybeScrollToActive(box, mIdx);
      }
    }
    state.lastMeasureIdx = mIdx;
  }

  // 词高亮
  if (wIdx !== state.lastWordIdx) {
    grid.querySelectorAll('.yc-m-word.yc-m-active').forEach((el) => el.classList.remove('yc-m-active'));
    if (wIdx >= 0) {
      const el = grid.querySelector(`.yc-m-word[data-wi="${wIdx}"]`);
      if (el) el.classList.add('yc-m-active');
    }
    state.lastWordIdx = wIdx;
  }

  // 和弦高亮
  if (cIdx !== state.lastChordIdx) {
    grid.querySelectorAll('.yc-m-chord.yc-m-active').forEach((el) => el.classList.remove('yc-m-active'));
    if (cIdx >= 0) {
      const el = grid.querySelector(`.yc-m-chord[data-ci="${cIdx}"]`);
      if (el) el.classList.add('yc-m-active');
    }
    state.lastChordIdx = cIdx;
  }

  // 补发预览面板时间事件(原逻辑在 updateLyricsChordsHighlight 尾部,被本视图提前 return 跳过)
  if (window.ycChordsPreviewPanel?.isVisible) {
    window.dispatchEvent(
      new CustomEvent('yc:timeUpdate', { detail: { time: currentTime, isScrubbing: false } })
    );
  }
}

// 尊重面板 Sync with YouTube / Auto scroll 开关
function autoScrollWanted() {
  const syncTog = document.querySelector('#sync-youtube-toggle');
  const autoTog = document.querySelector('#auto-scroll-toggle');
  return syncTog?.classList.contains('active') || autoTog?.classList.contains('active');
}

function maybeScrollToActive(box, measureIdx) {
  if (!autoScrollWanted()) return;
  if (state.lastScrollMeasureIdx === measureIdx) return;
  state.lastScrollMeasureIdx = measureIdx;
  try {
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch {
    box.scrollIntoView();
  }
}

// ───────────────────────────────────────────────
// 9. 全局事件(capo/移调重渲、面板关闭清理、拖动即时高亮)
// ───────────────────────────────────────────────
function attachGlobalListenersOnce() {
  if (state.globalListenersAttached) return;
  state.globalListenersAttached = true;

  // Capo / 移调只更新 DOM 和弦名,不重跑面板渲染 → 本视图自行重渲
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

  // 面板关闭:清引用,保留开关偏好(重开面板经 onContentRendered 自动恢复)
  window.addEventListener('yc:panelClosing', () => {
    state.enabled = false;
    state.container = null;
    state.chords = [];
    state.words = [];
    state.beatsData = null;
    state.pipeline = null;
    state.measures = [];
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

// loadLyricsChordsContent 渲染完成后的接管钩子(须在 combinedData 释放前同步调用)
function onContentRendered(combinedData, authoritativeChords, container) {
  if (!window.measureViewEnabled) return;
  state.enabled = true;
  state.container = container || document.querySelector('.yt-lyrics-chords-panel .lyrics-chords-content');
  state.videoId = getVideoId();

  const data = extractData(combinedData, authoritativeChords);
  state.chords = data.chords;
  state.words = data.words;
  state.beatsData = window.chordsDisplay?.currentSongData?.beatsData || null;

  attachGlobalListenersOnce();

  const applySettingsAndRender = () => {
    if (state.settingsLoadedFor !== state.videoId) {
      // 先以估算值立即渲染,存档加载后修正
      state.settings = {
        ...DEFAULT_SETTINGS,
        bpm: estimateBpmFromChords(state.chords, DEFAULT_SETTINGS.beatsPerBar),
      };
      state.settingsFromArchive = false;
      rebuildAndRender();
      loadSettings(state.videoId).then(rebuildAndRender).catch(() => {});
    } else {
      rebuildAndRender();
    }
  };

  if (!state.chords.length) {
    // 双弱源皆空 → 异步直读和弦库;期间先渲空态,到位后重渲
    const vid = state.videoId;
    console.log('[MeasureChart] authoritative/inline chords empty — pulling from chord library…');
    pullChordsFromDb(vid).then((pulled) => {
      if (!pulled || state.enabled === false || state.videoId !== vid) return;
      state.chords = pulled.chords;
      state.beatsData = pulled.beatsData;
      console.log('[MeasureChart] 🎸', pulled.chords.length, 'chords loaded from chord library');
      // 设置仍为估算值(无存档)时,以真实和弦重估 BPM
      if (!state.settingsFromArchive) {
        state.settings.bpm = estimateBpmFromChords(state.chords, state.settings.beatsPerBar);
        scheduleSave();
      }
      applySettingsAndRender();
    });
  }
  applySettingsAndRender();
}

// 开关入口(面板 Measure toggle 调用):翻转偏好并触发面板重渲
window.toggleMeasureView = async function () {
  const next = !window.measureViewEnabled;
  window.measureViewEnabled = next;
  try {
    await chrome.storage.sync.set({ [SYNC_KEY]: next });
  } catch (err) {
    console.warn('[MeasureChart] Failed to persist toggle:', err);
  }
  const toggleEl = document.querySelector('#measure-view-toggle');
  if (toggleEl) toggleEl.classList.toggle('active', next);

  if (!next) {
    state.enabled = false;
    state.container = null;
    state.chords = [];
    state.words = [];
    state.beatsData = null;
    state.pipeline = null;
    state.measures = [];
    resetHighlightCache();
  }

  // 统一经 refreshLyricsChordsPanel 重建内容:
  // 开 → hook 触发 onContentRendered 接管;关 → 原始歌词列表恢复并失效旧缓存
  if (typeof window.refreshLyricsChordsPanel === 'function') {
    try {
      await window.refreshLyricsChordsPanel();
    } catch (err) {
      console.warn('[MeasureChart] Panel refresh failed:', err);
    }
  }
};

window.ycMeasureChart = {
  get isEnabled() { return state.enabled; },
  toggle: window.toggleMeasureView,
  onContentRendered,
  updateHighlight,
  onPanelClosing() {
    state.enabled = false;
    state.container = null;
    resetHighlightCache();
  },
};

// ───────────────────────────────────────────────
// 11. 初始化:读全局开关镜像到 window
// ───────────────────────────────────────────────
try {
  chrome.storage.sync.get([SYNC_KEY], (result) => {
    window.measureViewEnabled = result?.[SYNC_KEY] === true;
  });
} catch {
  window.measureViewEnabled = false;
}

// ───────────────────────────────────────────────
// 12. 样式(注入一次;主题/RTL 经面板类继承)
// ───────────────────────────────────────────────
function ensureCss() {
  if (state.cssInjected || document.getElementById('yc-measure-chart-style')) {
    state.cssInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'yc-measure-chart-style';
  style.textContent = `
    .yc-measure-view { padding: 8px 12px 32px; }
    .yc-m-toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 6px 8px; margin-bottom: 10px;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
      font-size: 12px;
    }
    .yc-m-tb-item { display: flex; align-items: center; gap: 4px; color: inherit; }
    .yc-m-bpm-input {
      width: 56px; background: transparent; color: inherit;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
      padding: 2px 4px; font-size: 12px;
    }
    .yc-m-tb-btn {
      background: transparent; color: inherit; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
      padding: 2px 6px; font-size: 11px;
    }
    .yc-m-tb-btn:hover { background: rgba(127,127,127,0.25); }
    .yc-m-beats-select {
      background: transparent; color: inherit;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
    }
    .yc-m-beats-select option { color: #111; }
    .yc-m-src-select {
      background: transparent; color: inherit;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
    }
    .yc-m-src-select option { color: #111; }
    .yc-m-offset-val { min-width: 38px; text-align: center; }
    .yc-m-src-info {
      margin-inline-start: auto; font-size: 11px; opacity: 0.75;
      white-space: nowrap;
    }
    /* 管线模式:BPM/拍号由检测结果决定,推算控件禁用(Offset 保留微调) */
    .yc-m-toolbar[data-mode="pipeline"] .yc-m-tb-item > .yc-m-bpm-input,
    .yc-m-toolbar[data-mode="pipeline"] .yc-m-bpm-half,
    .yc-m-toolbar[data-mode="pipeline"] .yc-m-bpm-double,
    .yc-m-toolbar[data-mode="pipeline"] .yc-m-bpm-auto,
    .yc-m-toolbar[data-mode="pipeline"] .yc-m-beats-select {
      opacity: 0.35; pointer-events: none;
    }
    .yc-m-src-hint {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 4px 8px; margin-bottom: 10px;
      border: 1px dashed rgba(255,255,255,0.25); border-radius: 8px;
      font-size: 11px; opacity: 0.9;
    }
    .yc-m-src-hint .yc-m-reanalyze { flex-shrink: 0; }
    .yc-m-src-hint .yc-m-reanalyze:disabled { opacity: 0.5; cursor: default; }

    .yc-m-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
    .yc-m-box {
      position: relative; min-height: 52px;
      border: 1px solid rgba(255,255,255,0.22); border-radius: 6px;
      padding: 4px 6px 6px; cursor: pointer;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .yc-m-num {
      position: absolute; top: 2px; inset-inline-end: 5px;
      font-size: 9px; opacity: 0.45;
    }
    .yc-m-chords { display: grid; gap: 2px; margin-top: 10px; min-height: 16px; }
    .yc-m-slot { min-width: 0; }
    .yc-m-chord {
      font-size: 12px; font-weight: 600; color: #3ea6ff;
      white-space: nowrap; display: inline-block; margin-inline-end: 3px;
    }
    .yc-m-chord.yc-m-active { text-decoration: underline; text-underline-offset: 2px; }
    .yc-m-words {
      margin-top: 3px; font-size: 12px; line-height: 1.35;
      overflow-wrap: break-word; /* 超长单词兜底断行,防止横向溢出压到相邻小节 */
    }
    .yc-m-word { cursor: pointer; border-radius: 3px; padding: 0 1px; }
    .yc-m-word:hover { background: rgba(127,127,127,0.25); }
    .yc-m-word.yc-m-active { color: #3ea6ff; font-weight: 600; }
    .yc-m-box.yc-m-active { border-color: #3ea6ff; box-shadow: inset 0 0 0 1px #3ea6ff; }
    .yc-m-empty { padding: 24px; text-align: center; opacity: 0.6; }

    /* RTL:行内小节从右往左 */
    .yt-lyrics-chords-rtl .yc-m-grid,
    .yt-lyrics-chords-rtl .yc-m-chords { direction: rtl; }

    /* 亮色主题(sepia / light):深色边框与下拉选项 */
    .yt-lyrics-chords-panel.sepia-theme .yc-m-toolbar,
    .yt-lyrics-chords-panel.light-theme .yc-m-toolbar { border-color: rgba(0,0,0,0.18); }
    .yt-lyrics-chords-panel.sepia-theme .yc-m-bpm-input,
    .yt-lyrics-chords-panel.sepia-theme .yc-m-tb-btn,
    .yt-lyrics-chords-panel.sepia-theme .yc-m-beats-select,
    .yt-lyrics-chords-panel.sepia-theme .yc-m-src-select,
    .yt-lyrics-chords-panel.light-theme .yc-m-bpm-input,
    .yt-lyrics-chords-panel.light-theme .yc-m-tb-btn,
    .yt-lyrics-chords-panel.light-theme .yc-m-beats-select,
    .yt-lyrics-chords-panel.light-theme .yc-m-src-select { border-color: rgba(0,0,0,0.25); }
    .yt-lyrics-chords-panel.sepia-theme .yc-m-src-hint,
    .yt-lyrics-chords-panel.light-theme .yc-m-src-hint { border-color: rgba(0,0,0,0.22); }
    .yt-lyrics-chords-panel.sepia-theme .yc-m-box,
    .yt-lyrics-chords-panel.light-theme .yc-m-box { border-color: rgba(0,0,0,0.22); }
    .yt-lyrics-chords-panel.sepia-theme .yc-m-word.yc-m-active,
    .yt-lyrics-chords-panel.light-theme .yc-m-word.yc-m-active { color: #1e6fd9; }
  `;
  document.head.appendChild(style);
  state.cssInjected = true;
}
})();
