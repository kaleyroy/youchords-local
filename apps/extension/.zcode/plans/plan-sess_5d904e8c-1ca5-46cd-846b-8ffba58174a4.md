# 跳过登录、解锁全部功能

## 根因
本地 fork 移除了云端后端和 background.js 的登录处理器，但内容脚本中遗留了 3 处云版登录拦截。其中 2 处检查 `chrome.storage.local['youchords_jwt']`（本地构建无人写入，永远为空），导致 "Sign In Required" 弹窗；弹窗登录按钮又因 background.js 无监听器而报 "Could not reach YouChords"。

## 修改内容（2 处删除，均为纯删除完整代码块，变量无后续引用，已验证安全）

### 1. `apps/extension/buttons/lyricsAndChordsButton.js:2284-2295`
删除 `openLyricsChordsPanel()` 中的 JWT 拦截块（即用户遇到的 "Subtitles & Chords" 弹窗来源），替换为一行注释说明本地版通过配对令牌授权、无需登录：
```js
// Local build: no cloud sign-in — the local companion authorizes via the pairing token.
```

### 2. `apps/extension/content.js:6896-6907`
删除 `toggleChords()` 中的同款 JWT 拦截块，同样替换为一行注释。

## 无需改动的部分（已验证）
- 配额检查 `checkQuotaLocal()`（local/auth.js:130）本地恒返回 `allowed: true`，其 `not_logged_in` 分支为死代码，不会触发
- 字幕按钮入口（subtitleButton.js:2804）用 `getJWTPayload()` 判断，本地返回真值对象，本来就通过
- `validatorModule.js` 的 JWT 解码有 try/catch 兜底，且优先走 `ycAuth.getSubscriptionInfo()`（返回 pro），不受影响

## 验证
1. 用 `node --check`（复制为 .mjs 以支持 ESM 语法）对两个修改文件做语法检查
2. 用户侧验证：在 `chrome://extensions` 点击"重新加载"扩展 → 刷新 YouTube 页面 → 点击 Subtitles & Chords 按钮，应直接打开面板而不再弹登录框；和弦处理走本地 Docker companion（127.0.0.1:8765）

## 注意事项
- 若 Chrome 中加载的未打包扩展路径是 `%LOCALAPPDATA%\YouChordsLocal`（install.ps1 的安装副本）而非本仓库目录，需将修改同步到该目录（或让 Chrome 改为本仓库的 `apps/extension`）；**不要重新运行 install.ps1**，它会从 GitHub 重新下载并覆盖本地修改