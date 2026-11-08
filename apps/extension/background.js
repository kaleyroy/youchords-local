chrome.runtime.onInstalled.addListener(() => {
  console.info('[YouChords Local] Extension installed.');
});

// -------------------------------------------------------------
// 特权加载桥：content script 经此注入 JS/CSS、读取扩展资源、
// 发起跨域探测请求。所有处理器须在 SW 顶层同步注册。
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  (async () => {
    try {
      const tabId = sender?.tab?.id;

      switch (message.type) {
        case 'YC_INJECT_JS': {
          if (tabId == null) throw new Error('No sender tab for YC_INJECT_JS');
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [message.path]
          });
          sendResponse({ ok: true });
          break;
        }

        case 'YC_INJECT_CSS': {
          if (tabId == null) throw new Error('No sender tab for YC_INJECT_CSS');
          await chrome.scripting.insertCSS({
            target: { tabId },
            files: [message.path]
          });
          sendResponse({ ok: true });
          break;
        }

        case 'YC_FETCH_TEXT': {
          const response = await fetch(chrome.runtime.getURL(message.path));
          if (!response.ok) throw new Error(`Fetch ${message.path} failed: ${response.status}`);
          sendResponse({ ok: true, text: await response.text() });
          break;
        }

        case 'YC_FETCH_BYTES': {
          const response = await fetch(chrome.runtime.getURL(message.path));
          if (!response.ok) throw new Error(`Fetch ${message.path} failed: ${response.status}`);
          const buffer = await response.arrayBuffer();
          sendResponse({ ok: true, bytes: Array.from(new Uint8Array(buffer)) });
          break;
        }

        case 'YC_POST_JSON': {
          // credentials:'include' + host_permissions lets the extension send
          // the user's YouTube cookies cross-origin — without them YouTube's
          // player API answers cookieless probes with bot-walls.
          const response = await fetch(message.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(message.payload)
          });
          let json = null;
          try {
            json = await response.json();
          } catch (e) {
            // 非 JSON 响应时保留 null
          }
          sendResponse({ ok: true, status: response.status, httpOk: response.ok, json });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true; // 异步 sendResponse
});
