/**
 * Robust Chromium launcher shared by the render harness, the UI tests and
 * `npm run doctor`. Plain JavaScript so the doctor can run without tsx.
 *
 * Tries, in order:
 *   1. TROPICFLOW_CHROMIUM=/path/to/chrome        (explicit executable)
 *   2. TROPICFLOW_CHANNEL=chrome|msedge|chromium  (installed system browser)
 *   3. the choice saved by `npm run setup` (.tropicflow/browser.json)
 *   4. Playwright's own Chromium download
 *   5. system browsers via Playwright channels (chrome, msedge, chromium)
 *   6. common install paths of Chrome/Chromium
 * and reports every attempt with the *full* error when all of them fail,
 * plus an `ldd` check for missing shared libraries on Linux.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Browser choice persisted by `npm run setup` (gitignored). */
export const BROWSER_CONFIG_PATH = path.join(ROOT, '.tropicflow', 'browser.json');

export function readSavedBrowser() {
  try {
    return JSON.parse(fs.readFileSync(BROWSER_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveBrowser(choice) {
  fs.mkdirSync(path.dirname(BROWSER_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(BROWSER_CONFIG_PATH, JSON.stringify(choice, null, 2) + '\n');
}

const SYSTEM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** Warn about near-misses of the env var name (e.g. TROPLICFLOW_CHROM). */
export function envNameWarnings(env = process.env) {
  const warnings = [];
  for (const key of Object.keys(env)) {
    if (key === 'TROPICFLOW_CHROMIUM' || key === 'TROPICFLOW_CHANNEL' || key === 'TROPICFLOW_DIST') continue;
    if (/TROP/i.test(key) && /CHROM|CHANNEL/i.test(key)) {
      warnings.push(`environment variable "${key}" looks like a misspelling; the exact name is TROPICFLOW_CHROMIUM (path) or TROPICFLOW_CHANNEL (chrome|msedge|chromium).`);
    }
  }
  return warnings;
}

/** Missing shared libraries of an ELF executable, via ldd (Linux only). */
export function missingSharedLibraries(executablePath) {
  if (os.platform() !== 'linux' || !executablePath || !fs.existsSync(executablePath)) return [];
  try {
    const out = execSync(`ldd "${executablePath}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out
      .split('\n')
      .filter((l) => /not found/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

function candidates(playwrightChromium, env = process.env) {
  const list = [];
  if (env.TROPICFLOW_CHROMIUM) list.push({ label: `TROPICFLOW_CHROMIUM=${env.TROPICFLOW_CHROMIUM}`, options: { executablePath: env.TROPICFLOW_CHROMIUM } });
  if (env.TROPICFLOW_CHANNEL) list.push({ label: `TROPICFLOW_CHANNEL=${env.TROPICFLOW_CHANNEL}`, options: { channel: env.TROPICFLOW_CHANNEL } });
  const saved = readSavedBrowser();
  if (saved && (saved.executablePath || saved.channel)) {
    list.push({
      label: `saved by "npm run setup" (${saved.executablePath ?? 'channel ' + saved.channel})`,
      options: saved.executablePath ? { executablePath: saved.executablePath } : { channel: saved.channel },
      executablePath: saved.executablePath,
    });
  }
  let bundled = null;
  try { bundled = playwrightChromium.executablePath(); } catch { /* ignore */ }
  list.push({ label: `Playwright Chromium (${bundled ?? 'not downloaded'})`, options: {}, executablePath: bundled });
  for (const channel of ['chrome', 'msedge', 'chromium']) list.push({ label: `system browser channel "${channel}"`, options: { channel } });
  for (const p of SYSTEM_PATHS) if (fs.existsSync(p)) list.push({ label: `system browser at ${p}`, options: { executablePath: p }, executablePath: p });
  return list;
}

/**
 * Launch a Chromium. Resolves { browser, label }. Rejects with a detailed,
 * actionable report when nothing works.
 * @param {import('playwright').BrowserType} chromium
 * @param {import('playwright').LaunchOptions} [launchOptions]
 */
export async function launchChromium(chromium, launchOptions = {}) {
  const attempts = [];
  for (const c of candidates(chromium)) {
    const exe = c.options.executablePath ?? c.executablePath;
    if (exe && !fs.existsSync(exe)) {
      attempts.push({ label: c.label, error: `executable does not exist: ${exe}` });
      continue;
    }
    try {
      // Headless-friendly defaults: tiny /dev/shm in containers and absent GPUs are common.
      const args = ['--disable-dev-shm-usage', '--disable-gpu', ...(launchOptions.args ?? [])];
      const browser = await chromium.launch({ ...launchOptions, args, ...c.options });
      return { browser, label: c.label };
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      const missing = missingSharedLibraries(exe);
      if (missing.length) message += `\n      missing shared libraries: ${missing.join(', ')}`;
      attempts.push({ label: c.label, error: message });
    }
  }
  throw new Error(formatFailure(attempts));
}

function formatFailure(attempts) {
  const lines = ['Could not start any Chromium for the audio tests. Attempts:'];
  for (const a of attempts) {
    lines.push(`  - ${a.label}`);
    for (const l of a.error.split('\n')) lines.push(`      ${l}`);
  }
  for (const w of envNameWarnings()) lines.push(`  ! ${w}`);
  const sharedLibs = attempts.some((a) => /shared librar|cannot open shared object|error while loading/i.test(a.error));
  lines.push('');
  lines.push('How to fix (pick one):');
  if (sharedLibs) {
    lines.push('  * The browser binary exists but system libraries are missing.');
    lines.push('    - Debian/Ubuntu with sudo:   sudo npx playwright install-deps chromium');
    lines.push('    - Without sudo / other distro: use a browser that is already installed on this machine:');
    lines.push('        TROPICFLOW_CHANNEL=chrome npm run test:e2e      (or msedge / chromium)');
    lines.push('        TROPICFLOW_CHROMIUM=/path/to/your/chrome npm run test:e2e');
    lines.push('    - Or run the tests inside the official image that has all libraries:');
    lines.push('        docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.56.1-noble npm run test:e2e');
  } else {
    lines.push('  * Download Playwright\'s Chromium:            npx playwright install chromium   (npm run setup)');
    lines.push('  * Or use a browser already on this machine:  TROPICFLOW_CHANNEL=chrome npm run test:e2e');
    lines.push('                                               TROPICFLOW_CHROMIUM=/path/to/chrome npm run test:e2e');
  }
  lines.push('  Or let it be fixed automatically:           npm run setup');
  lines.push('  Diagnose only:                               npm run check   (note: "npm doctor" is a different, built-in npm command)');
  return lines.join('\n');
}

/** Human-readable survey of browser candidates for the doctor. */
export async function surveyBrowsers(chromium) {
  const report = [];
  for (const c of candidates(chromium)) {
    const exe = c.options.executablePath ?? c.executablePath;
    if (exe && !fs.existsSync(exe)) {
      report.push({ label: c.label, ok: false, detail: 'executable does not exist' });
      continue;
    }
    try {
      const browser = await chromium.launch({ ...c.options });
      const version = browser.version();
      await browser.close();
      report.push({ label: c.label, ok: true, detail: `launches (version ${version})`, options: exe ? { executablePath: exe } : c.options });
    } catch (err) {
      const missing = missingSharedLibraries(exe);
      const lines = (err instanceof Error ? err.message : String(err)).split('\n').map((l) => l.trim()).filter(Boolean);
      const msg = lines.find((l) => /shared object|shared librar|not found|doesn't exist|does not exist|No such file|ENOENT/i.test(l)) ?? lines[0] ?? 'launch failed';
      report.push({ label: c.label, ok: false, detail: missing.length ? `missing shared libraries: ${missing.join(', ')}` : msg });
    }
  }
  return report;
}
