#!/usr/bin/env node
/**
 * Zero-thought environment setup:  npm run setup
 *
 *  1. installs dependencies if they are missing
 *  2. finds a Chromium that launches; if none, downloads Playwright's
 *     (and tries to install its system libraries when needed)
 *  3. saves the working browser to .tropicflow/browser.json so every test
 *     and script uses it automatically - no environment variable needed
 *
 * Plain JavaScript, no dependencies, so it runs even on a broken install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const step = (msg) => console.log(`\n==> ${msg}`);
const run = (cmd, args, opts = {}) => {
  console.log(`    $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  return r.status === 0;
};

// 1. Node version
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Node ${process.versions.node} found; Node >= 22.18 is required (https://nodejs.org).`);
  process.exit(1);
}

// 2. dependencies
step('checking dependencies');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const missing = Object.keys(pkg.dependencies).filter((d) => !fs.existsSync(path.join(ROOT, 'node_modules', d)));
if (missing.length) {
  console.log(`    missing: ${missing.join(', ')}`);
  if (!run(npm, ['install'])) {
    console.error('npm install failed; fix the error above and re-run npm run setup.');
    process.exit(1);
  }
} else {
  console.log('    all present');
}

// 3. A browser that launches
const { chromium } = require('playwright');
const { surveyBrowsers, saveBrowser, BROWSER_CONFIG_PATH, envNameWarnings } = await import('./lib/launchBrowser.mjs');
for (const w of envNameWarnings()) console.log(`    ! ${w}`);

async function findWorking(label) {
  step(`looking for a browser that launches (${label})`);
  const report = await surveyBrowsers(chromium);
  for (const r of report) console.log(`    ${r.ok ? 'ok ' : '-- '} ${r.label}: ${r.detail}`);
  return { working: report.find((r) => r.ok) ?? null, report };
}

let { working, report } = await findWorking('already installed');

if (!working) {
  step("none found: downloading Playwright's Chromium");
  run(npx, ['playwright', 'install', 'chromium']);
  ({ working, report } = await findWorking('after download'));
}

if (!working && report.some((r) => /shared librar/.test(r.detail))) {
  step('browser downloaded but system libraries are missing: trying to install them');
  const ok = run(npx, ['playwright', 'install-deps', 'chromium']);
  if (!ok) {
    console.log('    could not install libraries without privileges; trying with sudo');
    run('sudo', ['-n', npx, 'playwright', 'install-deps', 'chromium']) ||
      run('sudo', [npx, 'playwright', 'install-deps', 'chromium']);
  }
  ({ working, report } = await findWorking('after installing libraries'));
}

if (!working) {
  console.error(`
No browser could be made to work automatically. Options:
  * Install Google Chrome / Chromium / Edge on this machine, then re-run: npm run setup
  * Install the libraries listed above with your package manager (needs root), then re-run
  * Run the end-to-end tests in Docker:  docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.56.1-noble npm run test:e2e
The unit tests (npm run test:unit) need no browser.`);
  process.exit(1);
}

saveBrowser(working.options ?? {});
step(`done: using ${working.label}`);
console.log(`    saved to ${path.relative(ROOT, BROWSER_CONFIG_PATH)} (all tests and scripts use it automatically)`);
console.log(`    next:  npm test        (or: npm run test:unit / npm run test:e2e / npm run dev)`);
