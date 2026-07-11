import { LOCAL_CONFIG } from './config/local-config.js';

const dot = document.getElementById('status-dot');
const title = document.getElementById('status-title');
const detail = document.getElementById('status-detail');

async function checkCompanion() {
  dot.className = 'dot checking';
  title.textContent = 'Checking local companion...';
  detail.textContent = 'Docker must be running.';
  try {
    const response = await fetch(`${LOCAL_CONFIG.baseUrl}/v1/health`, {
      headers: { Authorization: `Bearer ${LOCAL_CONFIG.pairingToken}` }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    dot.className = 'dot online';
    title.textContent = 'Local companion is ready';
    detail.textContent = `Version ${health.version}. Audio stays on this computer.`;
  } catch (error) {
    dot.className = 'dot offline';
    title.textContent = 'Local companion is not available';
    detail.textContent = 'Start Docker Desktop, then run install.ps1 again.';
  }
}

document.getElementById('retry').addEventListener('click', checkCompanion);
document.getElementById('open-youtube').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.youtube.com/' });
});

checkCompanion();
