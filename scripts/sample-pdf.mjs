// A single-page PDF wrapping the original CC0 score image, for PDF-specific OMR acceptance.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const image = await readFile('public/samples/first-light.png');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>@page{size:A4 landscape;margin:12mm}body{margin:0}img{display:block;width:100%;height:auto}</style></head><body><img alt="First Light original CC0 exercise" src="data:image/png;base64,${image.toString('base64')}"></body></html>`);
  await page.locator('img').evaluate(image => image.decode());
  await page.pdf({ path: 'public/samples/first-light.pdf', preferCSSPageSize: true, printBackground: true });
  console.log('Generated public/samples/first-light.pdf from the actual CC0 score image');
} finally { await browser.close(); }
