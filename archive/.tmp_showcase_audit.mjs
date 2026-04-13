import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const requests = [];
const consoleMessages = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('report.pdf') || url.includes('imaging_hidden') || url.includes('/api/') || url.includes('/default-case/') || url.includes('.nii')) requests.push({ method:req.method(), url, type:req.resourceType() });
});
page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
await page.goto('https://heartvalvepro.edu.kg/demo?case=showcase', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(8000);
const summary = await page.evaluate(() => ({
  body: document.body.innerText,
  viewportTexts: Array.from(document.querySelectorAll('.viewport-footer')).map(el => el.textContent?.replace(/\s+/g,' ').trim()),
  meas: document.getElementById('measurement-grid')?.textContent?.replace(/\s+/g,' ').trim() || null,
  planning: document.getElementById('planning-grid')?.textContent?.replace(/\s+/g,' ').trim() || null,
}));
console.log(JSON.stringify({summary,requests,consoleMessages}, null, 2));
await browser.close();
