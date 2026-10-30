#!/usr/bin/env node
/**
 * Environment check (diagnose only):  npm run check
 * To fix things automatically use:    npm run setup
 * (Not to be confused with "npm doctor", npm's built-in command.)
 * Plain JavaScript with no dependencies so it runs even when the install is broken.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const noBrowser = process.argv.includes('--no-browser');
const require = createRequire(path.join(ROOT, 'package.json'));
const problems = [];
const log = (s) => { if (!quiet) console.log(s); };

// 1. Node version
const major = Number(process.versions.node.split('.')[0]);
if (major < 22 || (major === 22 && Number(process.versions.node.split('.')[1]) < 18)) problems.push(`Node ${process.versions.node} found; Node >= 22.18 is required (it runs TypeScript tests natively) - https://nodejs.org`);
else log(`ok  node ${process.versions.node}`);

// 2. dependencies present?
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const missing = [];
for (const dep of Object.keys(pkg.dependencies)) {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', dep))) missing.push(dep);
}
if (missing.length) {
  problems.push(`dependencies not installed: ${missing.join(', ')}\n    fix: npm install`);
} else {
  log(`ok  dependencies installed (vite, typescript, playwright, ...)`);
}

// 3. Local binaries reachable via npm scripts
for (const bin of ['vite', 'tsc']) {
  const p = path.join(ROOT, 'node_modules', '.bin', bin);
  if (!fs.existsSync(p) && !fs.existsSync(p + '.cmd')) problems.push(`node_modules/.bin/${bin} is missing - run: npm install`);
}

// 4. Browsers: actually try to launch every candidate and report why each fails.
if (!missing.includes('playwright') && !noBrowser) {
  try {
    const { chromium } = require('playwright');
    const { surveyBrowsers, envNameWarnings } = await import('./lib/launchBrowser.mjs');
    for (const w of envNameWarnings()) problems.push(w);
    const report = await surveyBrowsers(chromium);
    const working = report.filter((r) => r.ok);
    if (!quiet) {
      console.log(`browsers for the audio tests:`);
      for (const r of report) console.log(`  ${r.ok ? 'ok ' : '-- '} ${r.label}: ${r.detail}`);
    }
    if (working.length === 0) {
      const libs = report.some((r) => /shared librar/.test(r.detail));
      problems.push(
        `No Chromium could be started for the end-to-end tests.` +
          (libs
            ? `\n    A browser binary exists but system libraries are missing.` +
              `\n    - with sudo on Debian/Ubuntu: sudo npx playwright install-deps chromium` +
              `\n    - otherwise use an already-installed browser: TROPICFLOW_CHANNEL=chrome (or msedge/chromium),` +
              `\n      or TROPICFLOW_CHROMIUM=/path/to/chrome` +
              `\n    - or run inside docker: mcr.microsoft.com/playwright:v1.56.1-noble`
            : `\n    - npm run setup   (downloads one and saves the choice)` +
              `\n    - or use an already-installed browser: TROPICFLOW_CHANNEL=chrome (or msedge/chromium),` +
              `\n      or TROPICFLOW_CHROMIUM=/path/to/chrome`)
      );
    } else if (!quiet) {
      log(`ok  ${working.length} browser(s) can run the end-to-end tests (first: ${working[0].label})`);
    }
  } catch (err) {
    problems.push(`playwright could not be loaded: ${err.message}\n    fix: npm install`);
  }
}

if (problems.length) {
  console.log('\nTROPICFLOW doctor found problems:\n');
  for (const p of problems) console.log(`  - ${p}\n`);
  if (!quiet) process.exit(1);
} else {
  log('\nAll good. Try: npm run dev | npm test');
}
if (problems.length && !quiet) {
  console.log('Most of this can be fixed automatically with:  npm run setup');
}
