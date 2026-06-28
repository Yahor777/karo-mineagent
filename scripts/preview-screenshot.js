const { chromium } = require('playwright');
const path = require('node:path');

const PROJECT_ROOT = 'D:/проекты/karo-mine'.replace(/\//g, path.sep);
const TARGET_URL = 'file:///' + (PROJECT_ROOT + path.sep + 'scripts' + path.sep + 'webview-preview.html').replace(/\\/g, '/');
const OUT_DIR = PROJECT_ROOT + path.sep + 'scripts';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // Узкий viewport — VS Code sidebar обычно ~400px.
  await page.setViewportSize({ width: 420, height: 720 });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
  // Ждём auto-emitted approvalRequest (600ms в preview) + рендер.
  await page.waitForTimeout(1100);

  // 1. Approval modal (появляется автоматически из mock после ready).
  await page.screenshot({ path: OUT_DIR + path.sep + 'preview-approval-modal.png', fullPage: true });
  console.log('saved preview-approval-modal.png');

  // Закрываем модалку (deny), открываем subagents panel.
  await page.click('#approvalDeny');
  await page.waitForTimeout(300);
  await page.click('#toggleSubAgents');
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT_DIR + path.sep + 'preview-subagents-list.png', fullPage: true });
  console.log('saved preview-subagents-list.png');

  // Открываем форму добавления.
  await page.click('#addSubAgentBtn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT_DIR + path.sep + 'preview-subagent-form.png', fullPage: true });
  console.log('saved preview-subagent-form.png');

  // Этап 3: индикатор Blockbench. Превью-мост шлёт status:"connected" при ready.
  await page.waitForSelector('#blockbenchChip[data-status="connected"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT_DIR + path.sep + 'preview-blockbench-connected.png', fullPage: true });
  const chipLabel = await page.locator('#blockbenchChip .blockbench-label').textContent().catch(() => '');
  console.log('saved preview-blockbench-connected.png (label:', chipLabel, ')');

  // Клик по чипу → preview-мост шлёт disconnect → статус "disconnected".
  await page.click('#blockbenchChip');
  await page.waitForSelector('#blockbenchChip[data-status="disconnected"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT_DIR + path.sep + 'preview-blockbench-disconnected.png', fullPage: true });
  const chipLabelAfter = await page.locator('#blockbenchChip .blockbench-label').textContent().catch(() => '');
  console.log('saved preview-blockbench-disconnected.png (label:', chipLabelAfter, ')');

  await browser.close();
})();
