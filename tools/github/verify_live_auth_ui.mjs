import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const APPS = [
  ['Aiko', 'https://aiko.todadjp.workers.dev'],
  ['SRKL', 'https://srkl-engine.todadjp.workers.dev'],
];
const LUTH_HOST = 'luth.blueprint-ninjastudios.workers.dev';
const report = ['Production browser UI check (public unauthenticated routes only)'];
const failures = [];

const browser = await chromium.launch({ headless: true });
for (const [name, address] of APPS) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let emailStage = 'page_load';
  try {
    const gateResponse = await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 40000 });
    report.push(name + ': app document HTTP ' + String(gateResponse?.status() ?? 0));
    emailStage = 'login_choice';
    const emailChoice = page.getByRole('link', { name: /continue with email/i });
    const googleChoice = page.getByRole('link', { name: /continue with google/i });
    await emailChoice.waitFor({ state: 'visible', timeout: 40000 });
    await googleChoice.waitFor({ state: 'visible', timeout: 15000 });
    const gateCopy = await page.locator('body').innerText();
    if (/SIGN IN TO WORKSPACE/i.test(gateCopy) || /^\s*OR\s*$/m.test(gateCopy)) {
      throw new Error('GATE_REDUNDANT_COPY');
    }
    report.push(name + ': minimal login choices PASS');

    emailStage = 'email_start';
    await emailChoice.click();
    emailStage = 'hosted_email_form';
    await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 45000 });
    emailStage = 'email_form_contract';
    await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
    if (new URL(page.url()).hostname !== LUTH_HOST) throw new Error('EMAIL_NOT_LUTH');
    const emailCopy = await page.locator('body').innerText();
    if (/SIGN IN TO WORKSPACE/i.test(emailCopy) || /^\s*OR\s*$/m.test(emailCopy)) {
      throw new Error('EMAIL_REDUNDANT_COPY');
    }
    if (await page.getByRole('button', { name: /google/i }).count() > 0 ||
        await page.getByRole('link', { name: /google/i }).count() > 0) {
      throw new Error('EMAIL_HAS_GOOGLE_OPTION');
    }
    emailStage = 'create_account_toggle';
    await page.getByRole('button', { name: /create account/i }).first().click();
    if (!(await page.locator('input[type="text"]').count())) throw new Error('CREATE_ACCOUNT_FIELDS_MISSING');
    if (await page.getByRole('button', { name: /google/i }).count() > 0) {
      throw new Error('CREATE_ACCOUNT_HAS_GOOGLE');
    }
    await page.getByRole('button', { name: /^sign in$/i }).first().click();
    await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
    report.push(name + ': signed email intent -> email/password + create account only PASS');
  } catch (error) {
    const safe = ['GATE_REDUNDANT_COPY', 'EMAIL_REDUNDANT_COPY', 'EMAIL_HAS_GOOGLE_OPTION',
      'CREATE_ACCOUNT_FIELDS_MISSING', 'CREATE_ACCOUNT_HAS_GOOGLE', 'EMAIL_NOT_LUTH'];
    const category = error instanceof Error && /Timeout/i.test(error.message) ? 'TIMEOUT' :
      error instanceof Error && /net::|ERR_/i.test(error.message) ? 'NETWORK' : 'OTHER';
    const code = error instanceof Error && safe.includes(error.message) ? error.message :
      'BROWSER_EMAIL_' + emailStage.toUpperCase() + '_' + category;
    failures.push(name + ':' + code);
  } finally {
    await context.close();
  }

  const googleContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const googlePage = await googleContext.newPage();
  let googleStage = 'page_load';
  try {
    const googleGate = await googlePage.goto(address, { waitUntil: 'domcontentloaded', timeout: 40000 });
    report.push(name + ': Google gate document HTTP ' + String(googleGate?.status() ?? 0));
    googleStage = 'google_button';
    const googleChoice = googlePage.getByRole('link', { name: /continue with google/i });
    await googleChoice.waitFor({ state: 'visible', timeout: 40000 });
    const chooser = googlePage.waitForURL(
      url => url.hostname === 'accounts.google.com',
      { timeout: 50000 },
    );
    googleStage = 'google_handoff';
    await googleChoice.click();
    await chooser;
    report.push(name + ': Google option reaches Google PASS');
  } catch (error) {
    const category = error instanceof Error && /Timeout/i.test(error.message) ? 'TIMEOUT' :
      error instanceof Error && /net::|ERR_/i.test(error.message) ? 'NETWORK' : 'OTHER';
    failures.push(name + ':GOOGLE_' + googleStage.toUpperCase() + '_' + category);
  } finally {
    await googleContext.close();
  }
}
await browser.close();
report.push('Failed assertions: ' + failures.length);
for (const failure of failures) report.push('FAIL: ' + failure);
await writeFile('/tmp/atax-auth-ui-evidence.txt', report.join('\n') + '\n');
process.stdout.write(report.join('\n') + '\n');
if (failures.length) process.exitCode = 1;
