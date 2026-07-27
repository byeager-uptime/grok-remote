#!/usr/bin/env node
/**
 * Visual + functional QA for the phone Remote shell.
 * Run against a live server (default Tailscale bind):
 *   BASE=http://100.92.95.79:7910 node scripts/visual-remote-qa.mjs
 *
 * Requires playwright installed somewhere importable, e.g.:
 *   npm i -g playwright && npx playwright install chromium
 * or NODE_PATH=/tmp/node_modules
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://100.92.95.79:7910';
const OUT = process.env.OUT || '/tmp/rr-qa';
fs.mkdirSync(OUT, { recursive: true });

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-se', width: 375, height: 667 },
  { name: 'ipad', width: 820, height: 1180 },
  { name: 'wide', width: 1280, height: 800 },
];

const browser = await chromium.launch({ headless: true });
const results = [];
let fail = 0;

async function qa({ name, width, height }) {
  const page = await browser.newPage({
    viewport: { width, height },
    isMobile: width <= 430,
    hasTouch: width <= 430,
    deviceScaleFactor: width <= 430 ? 3 : 2,
  });
  const checks = {};
  const mark = (k, v) => {
    checks[k] = !!v;
    if (!v) fail++;
  };

  await page.goto(`${BASE}/#/remote`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const layout = await page.evaluate(() => {
    const app = document.querySelector('.rr-app');
    const body = document.body;
    const overflowX =
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ||
      body.scrollWidth > body.clientWidth + 1 ||
      (app && app.scrollWidth > app.clientWidth + 1);
    const appRect = app?.getBoundingClientRect();
    return {
      innerW: window.innerWidth,
      appW: appRect?.width,
      overflowX,
      threadCount: document.querySelectorAll('.rr-thread').length,
      stuckDots: document.querySelectorAll('.rr-st--stuck').length,
      banner: document.querySelector('.rr-banner')?.textContent || null,
    };
  });

  mark('noHorizontalOverflow', !layout.overflowX && layout.appW <= layout.innerW + 1);
  mark('appFillsPhone', width > 600 || layout.appW >= layout.innerW - 2);
  mark('hasThreads', layout.threadCount >= 1);
  mark('noFalseStuckBanner', !layout.banner || !/need you/i.test(layout.banner));

  await page.screenshot({ path: path.join(OUT, `${name}-home.png`) });

  await page.locator('.rr-thread').first().click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, `${name}-thread-local.png`) });

  const threadLocal = await page.evaluate(() => {
    const text = (document.querySelector('#rr-thread-body') || document.body).innerText || '';
    return {
      hasContent: !!(document.querySelector('.rr-msg-user') || document.querySelector('.rr-msg-asst') || document.querySelector('.rr-quote')),
      emptySeed: /No prior turns seeded/i.test(text),
      workBar: !!document.querySelector('.rr-work-bar'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      text: text.slice(0, 300),
    };
  });
  mark('localThreadHasContent', threadLocal.hasContent);
  mark('localNotEmptySeedBug', !threadLocal.emptySeed);
  mark('threadNoOverflow', !threadLocal.overflowX);
  mark('workBarPresent', threadLocal.workBar);

  await page.goto(`${BASE}/#/remote`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const cloud = page.locator('.rr-thread', { hasText: 'Cloudflare' }).first();
  if (await cloud.count()) {
    await cloud.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `${name}-thread-cloud.png`) });
    const cloudT = await page.evaluate(() => {
      const text = (document.querySelector('#rr-thread-body') || document.body).innerText || '';
      return {
        infoBanner: !!document.querySelector('.rr-info-banner'),
        softStuck: !!document.querySelector('.rr-soft-stuck'),
        text: text.slice(0, 300),
      };
    });
    mark('cloudOpens', true);
    mark('cloudNotFalseStuck', !cloudT.softStuck);
    mark('cloudHasInfo', cloudT.infoBanner || /Cloud archive|no local|transcript/i.test(cloudT.text));
  }

  await page.goto(`${BASE}/#/remote/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}-new.png`) });
  mark('newSheet', (await page.locator('.rr-sheet').count()) > 0);

  results.push({ name, width, height, layout, threadLocal, checks });
  for (const [k, v] of Object.entries(checks)) {
    console.log(v ? 'PASS' : 'FAIL', name, k);
  }
  await page.close();
}

for (const v of viewports) await qa(v);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
console.log('TOTAL_FAILS', fail);
console.log('shots in', OUT);
await browser.close();
process.exit(fail ? 1 : 0);
