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
      // 5. Hardware bridge capabilities of that browser (informational): Web MIDI, a MIDI service, audio inputs.
      try {
        const { launchChromium } = await import('./lib/launchBrowser.mjs');
        const caps = await surveyHardwareBridge(launchChromium, chromium);
        console.log(`hardware bridge in that browser (served from http://localhost, a secure context):`);
        for (const line of caps) console.log(`  ${line}`);
      } catch (err) {
        console.log(`  -- could not survey the hardware bridge capabilities: ${err.message}`);
      }
    }
  } catch (err) {
    problems.push(`playwright could not be loaded: ${err.message}\n    fix: npm install`);
  }
}

/**
 * Open a blank page on localhost in the working browser and ask it about
 * Web MIDI (API present? does requestMIDIAccess resolve, and with how many
 * inputs?) and audio capture (getUserMedia present? how many audio inputs?).
 * The app's MIDI BRIDGE and SENSE modules depend on these; the e2e tests
 * fake them, so this is the one place that reports the real situation.
 */
async function surveyHardwareBridge(launchChromium, chromium) {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { browser } = await launchChromium(chromium);
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['midi', 'microphone']).catch(() => undefined);
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.address().port}/`);
    return await page.evaluate(async () => {
      const lines = [];
      lines.push(`${window.isSecureContext ? 'ok ' : '-- '} secure context: ${window.isSecureContext}`);
      if (typeof navigator.requestMIDIAccess !== 'function') {
        lines.push('-- Web MIDI: API not available in this browser (MIDI BRIDGE works with the computer keys only)');
      } else {
        const timeout = new Promise((_r, reject) => setTimeout(() => reject(new Error('timed out (a permission prompt?)')), 4000));
        try {
          const access = await Promise.race([navigator.requestMIDIAccess(), timeout]);
          const names = [];
          access.inputs.forEach((i) => names.push(i.name || i.id));
          lines.push(`ok  Web MIDI: ready, ${names.length} input device(s)${names.length ? `: ${names.join(', ')}` : ' (plug in a keyboard; hot-plug is detected)'}`);
        } catch (err) {
          const name = err && err.name ? err.name : '';
          lines.push(`-- Web MIDI: ${name === 'NotAllowedError' || name === 'SecurityError' ? 'permission refused' : name === 'InvalidStateError' ? 'no MIDI service on this system (headless / container)' : String(err && err.message ? err.message : err)} - the app will show this on the MIDI BRIDGE card`);
        }
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        lines.push('-- microphone: getUserMedia not available (SENSE works with the virtual voice only)');
      } else {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter((d) => d.kind === 'audioinput');
          lines.push(`${inputs.length ? 'ok ' : '--'} microphone: getUserMedia available, ${inputs.length} audio input(s)${inputs.length ? '' : ' (SENSE works with the virtual voice; the e2e tests use a fake device)'}`);
        } catch (err) {
          lines.push(`-- microphone: ${String(err && err.message ? err.message : err)}`);
        }
      }
      return lines;
    });
  } finally {
    await browser.close();
    server.close();
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
