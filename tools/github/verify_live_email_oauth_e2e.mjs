import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const apps = [
  ['Aiko', 'https://aiko.todadjp.workers.dev', 'register'],
  ['SRKL', 'https://srkl-engine.todadjp.workers.dev', 'login'],
];
const email = 'atax-oauth-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
const password = 'T1!' + randomBytes(28).toString('base64url');
const report = ['Signed-in production OAuth browser E2E (synthetic account, no credentials logged)'];
const failures = [];
const browser = await chromium.launch({ headless: true });

async function getAppSession(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/oidc/session', {
      credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, authenticated: body.authenticated === true };
  });
}

for (const [name, app, mode] of apps) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let stage = 'init';
  try {
    stage = 'choice';
    await page.goto(app, { waitUntil: 'domcontentloaded', timeout: 40000 });
    const emailChoice = page.getByRole('link', { name: /continue with email/i });
    await emailChoice.waitFor({ state: 'visible', timeout: 40000 });
    await page.getByRole('link', { name: /continue with google/i }).waitFor({ state: 'visible', timeout: 15000 });
    const gateCopy = await page.locator('body').innerText();
    if (/SIGN IN TO WORKSPACE/i.test(gateCopy) || /^\s*OR\s*$/m.test(gateCopy)) {
      throw new Error('REDUNDANT_GATE_COPY');
    }
    await emailChoice.click();
    stage = 'hosted_email_form';
    await page.locator('form input[type="email"]').waitFor({ state: 'visible', timeout: 40000 });
    const emailFormCopy = await page.locator('body').innerText();
    if (/SIGN IN TO WORKSPACE/i.test(emailFormCopy) || /^\s*OR\s*$/m.test(emailFormCopy)) {
      throw new Error('REDUNDANT_EMAIL_COPY');
    }
    if (new URL(page.url()).hostname !== 'luth.blueprint-ninjastudios.workers.dev') {
      throw new Error('UNEXPECTED_IDENTITY_PROVIDER');
    }
    if (await page.getByRole('button', { name: /google/i }).count()) {
      throw new Error('EMAIL_FORM_HAS_GOOGLE');
    }
    report.push(name + ': minimal gate, email-only form and no OR copy PASS');
    if (mode === 'register') {
      stage = 'register_form';
      await page.getByRole('button', { name: /create account/i }).first().click();
      const firstInput = page.locator('form input').first();
      await firstInput.waitFor({ state: 'visible', timeout: 15000 });
      await firstInput.fill('ATAX OAuth Browser Check');
      if (await page.getByRole('button', { name: /google/i }).count()) {
        throw new Error('ACCOUNT_CREATION_HAS_GOOGLE');
      }
    }
    await page.locator('form input[type="email"]').fill(email);
    await page.locator('form input[type="password"]').fill(password);
    stage = 'submit';
    await page.locator('form button[type="submit"]').click();
    stage = 'first_party_callback';
    await page.waitForURL(url => url.origin === new URL(app).origin && !url.pathname.startsWith('/api/auth/'), { timeout: 65000 });
    stage = 'session';
    const session = await getAppSession(page);
    if (session.status !== 200 || !session.authenticated) throw new Error('APP_SESSION_ABSENT');
    report.push(name + ': OAuth callback + authenticated session PASS');
    stage = 'refresh';
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 });
    const persistent = await getAppSession(page);
    if (persistent.status !== 200 || !persistent.authenticated) throw new Error('SESSION_NOT_PERSISTENT');
    report.push(name + ': session persists after refresh PASS');
    stage = 'logout';
    const logout = await page.evaluate(async () => {
      const response = await fetch('/api/auth/oidc/logout', {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return response.status;
    });
    if (logout !== 200) throw new Error('LOGOUT_FAILED');
    stage = 'revocation';
    const revoked = await getAppSession(page);
    if (revoked.status !== 401 || revoked.authenticated) throw new Error('LOGOUT_SESSION_STILL_ACTIVE');
    report.push(name + ': logout revokes app session PASS');
  } catch {
    failures.push(name + ':' + stage.toUpperCase().replace(/[^A-Z_]/g, '_') + '_FAILED');
  } finally {
    await context.close();
  }
}
await browser.close();
report.push('Failed assertions: ' + failures.length);
for (const error of failures) report.push('FAIL: ' + error);
await writeFile('/tmp/atax-auth-signedin-report.txt', report.join('\n') + '\n');
process.stdout.write(report.join('\n') + '\n');
if (failures.length) process.exitCode = 1;
