#!/usr/bin/env node
/**
 * Browser check for the Agents page layout (UI-3): the list and the detail scroll on a phone,
 * the last list item and the bottom of the detail can be brought into view, and the desktop
 * split view still scrolls both columns. Needs a RUNNING Rev4a instance (it starts none).
 *
 *   REV4A_BASE_URL=http://localhost:3750 REV4A_COOKIE=<value of the rev4a_token cookie> \
 *   REV4A_SHOTS=/tmp/ui-shots node scripts/ui-check-agents-mobile.mjs
 *
 * Environment:
 *   REV4A_BASE_URL  base URL of the instance (default http://localhost:3750)
 *   REV4A_COOKIE    value of the `rev4a_token` cookie (log in once and copy it from the browser)
 *   REV4A_SHOTS     directory for the screenshots (default ./ui-check-shots)
 *   REV4A_SIMULATE_CARDS  clone the first card N times in the DOM (no API call) so the list-scroll
 *                   assertion runs even with few agents
 *   PW_CHANNEL      browser channel (default `chrome`; set to `chromium` for Playwright's own build)
 *
 * Exit code 1 when an assertion fails. With too few agents to overflow the list, the scroll
 * assertion is reported as SKIP (the "fits above the bottom navigation" and "last item in view"
 * assertions still run): create a few agents, or accept the skip, to exercise the scroll itself.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.REV4A_BASE_URL || 'http://localhost:3750').replace(/\/$/, '');
const COOKIE = process.env.REV4A_COOKIE || '';
const SHOTS = path.resolve(process.env.REV4A_SHOTS || './ui-check-shots');
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const BOTTOM_NAV = 72; // .app-shell__content padding-bottom on a phone (without the safe area)

if (!COOKIE) { console.error('REV4A_COOKIE is required (the rev4a_token cookie value).'); process.exit(2); }
fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'phone-390x844', width: 390, height: 844, mobile: true },
  { name: 'fold-cover-344x882', width: 344, height: 882, mobile: true },
  { name: 'desktop-1400x900', width: 1400, height: 900, mobile: false },
];

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const skip = (m) => console.log(`  SKIP  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));

/** Marks the scroll region with this data-testid as the one the helpers measure. */
async function useScroller(page, testid) {
  return page.evaluate((id) => {
    document.querySelectorAll('[data-ui-check-scroller]').forEach((e) => e.removeAttribute('data-ui-check-scroller'));
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return false;
    el.setAttribute('data-ui-check-scroller', '');
    return true;
  }, testid);
}

const metrics = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-ui-check-scroller]');
  const r = el.getBoundingClientRect();
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top: r.top, bottom: r.bottom };
});

async function wheelScroll(page) {
  const m = await metrics(page);
  await page.mouse.move(Math.min(40, page.viewportSize().width / 2), (m.top + m.bottom) / 2);
  await page.mouse.wheel(0, 400);
  // Wait for the scroll to land (up to 3 s) instead of a fixed pause.
  await page.waitForFunction((before) => document.querySelector('[data-ui-check-scroller]').scrollTop > before, m.scrollTop, { timeout: 3000 }).catch(() => {});
}

/** Waits until the region's scrollHeight has not changed for 1 s (the detail loads its sections late). */
async function waitSettled(page) {
  let last = -1, since = Date.now();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const h = await page.evaluate(() => document.querySelector('[data-ui-check-scroller]').scrollHeight);
    if (h !== last) { last = h; since = Date.now(); } else if (Date.now() - since >= 1000) return;
    await page.waitForTimeout(150);
  }
}

async function scrollToEnd(page) {
  await page.evaluate(() => { const el = document.querySelector('[data-ui-check-scroller]'); el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
}

/** Last child of the scroller must end inside the scroller once scrolled to the end. */
async function lastChildInView(page, label) {
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-ui-check-scroller]');
    const box = el.getBoundingClientRect();
    const last = [...el.children].filter((c) => c.getBoundingClientRect().height > 0).pop();
    const lb = last.getBoundingClientRect();
    return { lastBottom: lb.bottom, boxBottom: box.bottom };
  });
  check(r.lastBottom <= r.boxBottom + 1, `${label}: last element ends inside the scroll region (${Math.round(r.lastBottom)} <= ${Math.round(r.boxBottom)})`);
  // Nothing may be covered by the floating Wizard / Pulse buttons at the end of the scroll.
  const cover = await page.evaluate(() => {
    const el = document.querySelector('[data-ui-check-scroller]');
    const last = [...el.children].filter((c) => c.getBoundingClientRect().height > 0).pop();
    const b = last.getBoundingClientRect();
    const hits = [];
    for (const [fx, fy] of [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.1, 0.9], [0.9, 0.9]]) {
      const x = b.left + b.width * fx, y = b.top + b.height * fy;
      const top = document.elementFromPoint(x, y);
      if (top && !(top === last || last.contains(top))) hits.push({ x: Math.round(x), y: Math.round(y), by: (top.className && String(top.className)) || top.tagName });
    }
    return hits;
  });
  check(cover.length === 0, `${label}: last element is not covered by floating buttons${cover.length ? ' ' + JSON.stringify(cover) : ''}`);
}

async function run(page, vp) {
  console.log(`\n== ${vp.name} ==`);
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(`${BASE}/agents`, { waitUntil: 'domcontentloaded' });
  await page.locator('.agent-card').or(page.getByText('No agents found')).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `${vp.name}-list.png`) });

  const cards = await page.locator('.agent-card').count();
  console.log(`  ${cards} agent card(s)`);
  if (cards === 0) { fail('no agents on this instance: cannot check the list'); return; }

  // The page itself must never scroll: one scrolling region inside the shell.
  const doc = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
  check(doc.sh <= doc.ch + 1, `document does not scroll (${doc.sh} <= ${doc.ch})`);

  const simulate = parseInt(process.env.REV4A_SIMULATE_CARDS || '0', 10);
  if (simulate > 0 && vp.mobile) {
    await page.evaluate((n) => {
      const all = document.querySelectorAll('.agent-card');
      const first = all[0], lastCard = all[all.length - 1];
      for (let i = 0; i < n; i++) lastCard.parentElement.insertBefore(first.cloneNode(true), lastCard.nextSibling);
    }, simulate);
    console.log(`  cloned the first card ${simulate} time(s) in the DOM`);
  }

  if (vp.mobile) {
    // The mobile drawer offers Logout (opened, never clicked).
    await page.getByRole('button', { name: 'Menu' }).click();
    const logout = page.locator('.mobile-drawer').getByRole('button', { name: /logout/i });
    await logout.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    await logout.scrollIntoViewIfNeeded().catch(() => {});
    const lb = await logout.boundingBox().catch(() => null);
    check(!!lb && lb.y >= 0 && lb.y + lb.height <= vp.height + 1, `the mobile drawer shows a Logout item, reachable on screen${lb ? ` (y ${Math.round(lb.y)}..${Math.round(lb.y + lb.height)})` : ''}`);
    await page.getByRole('button', { name: 'Close menu' }).click();
    await page.waitForTimeout(400);

    check(await useScroller(page, 'agents-list-scroll'), 'the list sits in the agents-list-scroll region');
    const before = await metrics(page);
    check(before.bottom <= vp.height - BOTTOM_NAV + 2, `list region ends above the bottom navigation (${Math.round(before.bottom)} <= ${vp.height - BOTTOM_NAV})`);
    if (before.scrollHeight > before.clientHeight + 1) {
      await wheelScroll(page);
      const after = await metrics(page);
      check(after.scrollTop > before.scrollTop, `wheel scroll moves the list (scrollTop ${before.scrollTop} -> ${after.scrollTop})`);
      await scrollToEnd(page);
      await lastChildInView(page, 'list');
    } else {
      skip(`list fits without scrolling (${before.scrollHeight} <= ${before.clientHeight}): add agents to exercise the scroll`);
      await lastChildInView(page, 'list');
    }
    // The last card itself can be brought into view.
    await page.locator('.agent-card').last().scrollIntoViewIfNeeded();
    const lastCard = await page.locator('.agent-card').last().boundingBox();
    const reg = await metrics(page);
    check(lastCard.y + lastCard.height <= reg.bottom + 1 && lastCard.y >= reg.top - 1, 'last agent card is fully visible after scrollIntoView');

    // Touch targets of the first card.
    const sw = await page.locator('.agent-card [role=switch]').first().boundingBox();
    check(sw.height >= 44, `status switch is at least 44 px high (${Math.round(sw.height)})`);

    // Tapping the switch must not open the detail (it would show BACK).
    // (We do not toggle: only check the click target does not select by hit-testing the card.)
    const swCenter = { x: sw.x + sw.width / 2, y: sw.y + sw.height / 2 };
    const topEl = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role=switch]') !== null, swCenter);
    check(topEl, 'the switch is on top of the card (a tap on it never selects the agent)');

    // Detail: open the first card by tapping its lower-left area, away from the controls.
    // Scroll first, measure after, so the box is the one on screen.
    await page.locator('.agent-card').first().scrollIntoViewIfNeeded();
    const firstBox = await page.locator('.agent-card').first().boundingBox();
    await page.locator('.agent-card').first().click({ position: { x: firstBox.width / 2, y: firstBox.height - 3 } });
    await page.getByRole('button', { name: /^back$/i }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-detail-top.png`) });
    const detailOk = await useScroller(page, 'agent-detail-scroll');
    await waitSettled(page);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-detail-top.png`) });
    check(detailOk, 'detail scroll region found');
    const d0 = await metrics(page);
    check(d0.bottom <= vp.height - BOTTOM_NAV + 2, `detail region ends above the bottom navigation (${Math.round(d0.bottom)} <= ${vp.height - BOTTOM_NAV})`);
    if (d0.scrollHeight > d0.clientHeight + 1) {
      await wheelScroll(page);
      const d1 = await metrics(page);
      check(d1.scrollTop > d0.scrollTop, `wheel scroll moves the detail (scrollTop ${d0.scrollTop} -> ${d1.scrollTop})`);
    } else {
      skip(`detail fits on this screen (${d0.scrollHeight} <= ${d0.clientHeight})`);
    }
    await scrollToEnd(page);
    await waitSettled(page);
    await scrollToEnd(page);
    const d2 = await metrics(page);
    check(Math.abs(d2.scrollTop + d2.clientHeight - d2.scrollHeight) <= 2, 'detail scrolls to its very bottom');
    await lastChildInView(page, 'detail');
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-detail-bottom.png`) });
  } else {
    // Desktop: both columns scroll on their own (when their content overflows).
    await page.locator('.agent-card__hit').first().click();
    await page.waitForTimeout(800);
    check((await page.locator('.agent-card--selected').count()) === 1, 'the selected card is highlighted');
    const cols = await page.evaluate(() => {
      const card = document.querySelector('.agent-card');
      const left = card.parentElement;
      const right = left.nextElementSibling;
      const info = (e) => ({ oy: getComputedStyle(e).overflowY, sh: e.scrollHeight, ch: e.clientHeight, bottom: e.getBoundingClientRect().bottom });
      return { left: info(left), right: info(right), vh: window.innerHeight };
    });
    for (const side of ['left', 'right']) {
      const c = cols[side];
      check(c.oy === 'auto' && c.bottom <= cols.vh + 1, `${side} column is its own scroll container within the viewport`);
      if (c.sh <= c.ch + 1) skip(`${side} column content fits (${c.sh} <= ${c.ch})`);
    }
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-split.png`) });
  }
}

const browser = await chromium.launch({ channel: CHANNEL === 'chromium' ? undefined : CHANNEL });
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
      deviceScaleFactor: vp.mobile ? 2 : 1,
    });
    await ctx.addCookies([{ name: 'rev4a_token', value: COOKIE, url: BASE }]);
    const page = await ctx.newPage();
    try { await run(page, vp); } catch (e) { fail(`${vp.name}: ${e.message}`); }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\nScreenshots in ${SHOTS}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
