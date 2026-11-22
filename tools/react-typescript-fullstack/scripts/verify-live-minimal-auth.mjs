import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const luth = 'https://luth.blueprint-ninjastudios.workers.dev';
const apps = [
  ['Aiko', 'https://aiko.todadjp.workers.dev'],
  ['SRKL', 'https://srkl-engine.todadjp.workers.dev'],
];
const lines = ['Live browser: canonical minimal auth UI'];
let failures = 0;
const browser = await chromium.launch({ headless: true });

async function verify(name, base) {
  const context = await browser.newContext({ acceptDownloads: false });
  try {
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const emailLink = page.getByRole('link', { name: /continue with email/i });
    const googleLink = page.getByRole('link', { name: /continue with google/i });
    await emailLink.waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await googleLink.isVisible(), true, 'GOOGLE_CHOICE_ABSENT');
    const section = page.locator('[data-frnl-component="LuthOidcGate"] section').first();
    const words = await section.innerText();
    assert(!/sign in to workspace/i.test(words), 'WORKSPACE_SIGNIN_COPY_PRESENT');
    assert(!/\bOR\b/i.test(words), 'OR_DIVIDER_PRESENT');
    lines.push(name + ': minimal choice screen PASSED');

    await emailLink.click();
    await page.waitForURL(url => url.origin === new URL(luth).origin, { timeout: 30000 });
    const email = page.getByRole('textbox', { name: /email address/i });
    await email.waitFor({ state: 'visible', timeout: 20000 });
    await page.getByLabel('Password', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: /continue with google|sign up with google/i }).count(), 0, 'GOOGLE_INSIDE_EMAIL_FORM');
    assert.equal(await page.getByRole('link', { name: /continue with google|sign up with google/i }).count(), 0, 'GOOGLE_LINK_INSIDE_EMAIL_FORM');
    await page.getByRole('button', { name: /create account/i }).first().click();
    await page.getByRole('textbox', { name: /full name/i }).waitFor({ state: 'visible', timeout: 10000 });
    lines.push(name + ': email-only Luth form + create account PASSED');
  } finally {
    await context.close();
  }

  const googleContext = await browser.newContext({ acceptDownloads: false });
  try {
    const googlePage = await googleContext.newPage();
    await googlePage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const go = googlePage.getByRole('link', { name: /continue with google/i });
    await go.waitFor({ state: 'visible', timeout: 20000 });
    await go.click();
    await googlePage.waitForURL(url => url.hostname === 'accounts.google.com', { timeout: 40000 });
    lines.push(name + ': Google account handoff PASSED');
  } finally {
    await googleContext.close();
  }
}

try {
  for (const [name, base] of apps) {
    try { await verify(name, base); }
    catch (error) {
      failures += 1;
      const allowed = new Set([
        'GOOGLE_CHOICE_ABSENT','WORKSPACE_SIGNIN_COPY_PRESENT','OR_DIVIDER_PRESENT',
        'GOOGLE_INSIDE_EMAIL_FORM','GOOGLE_LINK_INSIDE_EMAIL_FORM',
      ]);
      const msg = String(error?.message || '');
      const signal = [...allowed].find(code => msg.includes(code));
      lines.push(name + ': FAILED (' + (signal || 'BROWSER_NAVIGATION_OR_FORM_CHECK') + ')');
    }
  }
} finally {
  await browser.close();
}
lines.push('Failed app checks: ' + failures);
await fs.writeFile('/tmp/atax-auth-minimal-browser-report.txt', lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (failures > 0) process.exitCode = 1;
