// =============================================================
//  YouChords – loaderBridge.js  (privileged load bridge)
//  所有扩展资源加载统一经后台 service worker 执行：
//  - JS  → chrome.scripting.executeScript（ISOLATED world，无需 WAR）
//  - CSS → chrome.scripting.insertCSS（无需 WAR）
//  - 文本/字节 → 后台 fetch（扩展自身 origin，无需 WAR）
//  - 跨域 JSON POST → 后台 fetch（host_permissions 豁免 CORS）
//  背景：MV3 中 content script 的请求归因到宿主页面，
//  chrome-extension:// 模块加载受 web_accessible_resources 闸门
//  （Chrome 153 上不可靠），跨域 fetch 受页面 CORS 限制。
// =============================================================

/* eslint-disable no-console */

function ycBridgeSend(message) {
  return new Promise((resolve, reject) => {
    let runtime;
    try {
      runtime = chrome.runtime;
    } catch (e) {
      reject(new Error('YouChords was reloaded — please refresh this YouTube page (F5).'));
      return;
    }
    if (!runtime?.id) {
      reject(new Error('YouChords context is invalidated — please refresh this YouTube page (F5).'));
      return;
    }
    try {
      runtime.sendMessage(message, (response) => {
        const lastError = runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (response && response.ok === true) {
          resolve(response);
        } else {
          reject(new Error((response && response.error) || 'Background bridge failed'));
        }
      });
    } catch (e) {
      // 扩展重载后旧 content script 调用 sendMessage 会直接 throw
      reject(new Error('YouChords context is invalidated — please refresh this YouTube page (F5).'));
    }
  });
}

window.ycLoader = {
  /**
   * 在当前标签页的 ISOLATED world 注入扩展内 JS 文件（classic script）
   * @param {string} path - 扩展内相对路径，如 'utils/databaseManager.js'
   */
  js(path) {
    return ycBridgeSend({ type: 'YC_INJECT_JS', path }).then(() => undefined);
  },

  /**
   * 在当前标签页注入扩展内 CSS 文件
   * @param {string} path - 扩展内相对路径，如 'css/countdown.css'
   */
  css(path) {
    return ycBridgeSend({ type: 'YC_INJECT_CSS', path }).then(() => undefined);
  },

  /**
   * 读取扩展内文本资源（svg / json / js 源码等）
   * @param {string} path - 扩展内相对路径
   * @returns {Promise<string>}
   */
  text(path) {
    return ycBridgeSend({ type: 'YC_FETCH_TEXT', path }).then(r => r.text);
  },

  /**
   * 读取扩展内二进制资源（.json.gz 等）
   * @param {string} path - 扩展内相对路径
   * @returns {Promise<Uint8Array>}
   */
  bytes(path) {
    return ycBridgeSend({ type: 'YC_FETCH_BYTES', path }).then(r => new Uint8Array(r.bytes));
  },

  /**
   * 经后台发起跨域 JSON POST（host_permissions 豁免 CORS，
   * 供 music.youtube.com 等探测接口使用）
   * @param {string} url - 完整 URL
   * @param {object} payload - JSON 请求体
   * @returns {Promise<{status:number, ok:boolean, json:object}>}
   */
  postJson(url, payload) {
    return ycBridgeSend({ type: 'YC_POST_JSON', url, payload }).then(r => ({
      ok: r.httpOk,
      status: r.status,
      json: r.json
    }));
  },

  /**
   * 经后台发起任意 JSON 请求(自定义 method/headers,不带 cookies)。
   * 供本地 companion(127.0.0.1)使用——content script 直连 http://127.0.0.1
   * 会被归因到 https 宿主页并触发 PNA/Unsafe attempt 拦截。
   * @param {string} url - 完整 URL
   * @param {{method?:string, headers?:object, body?:string|null}} [opts]
   * @returns {Promise<{status:number, ok:boolean, json:object|null}>}
   */
  fetchJson(url, opts = {}) {
    return ycBridgeSend({
      type: 'YC_FETCH_JSON',
      url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body ?? null
    }).then(r => ({
      ok: r.httpOk,
      status: r.status,
      json: r.json
    }));
  }
};

if (window.DEBUG) console.log('[loaderBridge] ycLoader initialised');
