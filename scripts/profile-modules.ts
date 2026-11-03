#!/usr/bin/env node
/**
 * Resource profile of the built app per rack configuration, for humans:
 *
 *   npm run profile:modules                    table for every scenario the rack supports
 *   npm run profile:modules -- --save-baseline  also record tests/golden/profile-baseline.json
 *   npm run profile:modules -- --play-ms 8000 --json out/profile.json
 *
 * Needs a build (npm run build) and a browser (npm run setup). See
 * tests/e2e/profile.test.ts for the assertions and docs/PLUGIN_ARCHITECTURE_PLAN.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchChromium } from './lib/launchBrowser.mjs';
import { PROFILE_SCENARIOS, type ProfileFile, ResourceProbe, type ScenarioReport, formatDelta, formatReports, openScenario, rackIsEditable, serveDist } from './lib/resourceProbe.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.TROPICFLOW_DIST || path.join(ROOT, 'dist');
const BASELINE = path.join(ROOT, 'tests/golden/profile-baseline.json');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const playMs = Number(opt('--play-ms', '4000'));
const jsonOut = opt('--json', '');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`no build at ${DIST}; run "npm run build" first`);
  process.exit(1);
}

const server = await serveDist(DIST);
const port = (server.address() as { port: number }).port;
const { browser, label } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`browser: ${label} (${browser.version()})`);
const base = `http://localhost:${port}`;
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const first = await openScenario(context, base, PROFILE_SCENARIOS[0]);
const editable = await rackIsEditable(first);
await first.close();
if (!editable) console.log('rack is not editable yet: only the "all" scenario can run');

const reports: ScenarioReport[] = [];
for (const scenario of PROFILE_SCENARIOS) {
  if (scenario.needsEditableRack && !editable) continue;
  process.stdout.write(`${scenario.name} ... `);
  const page = await openScenario(context, base, scenario);
  const probe = await ResourceProbe.attach(page, browser);
  reports.push(await probe.runScenario(scenario.name, playMs));
  await page.close();
  console.log('done');
}
await browser.close();
server.close();

console.log();
console.log(formatReports(reports));

const file: ProfileFile = { recordedAt: new Date().toISOString(), browser: browser.version(), playMs, reports };
if (fs.existsSync(BASELINE) && !flag('--save-baseline')) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as ProfileFile;
  console.log(`\nagainst the baseline of ${baseline.recordedAt}:`);
  for (const r of reports) {
    const ref = baseline.reports.find((b) => b.scenario === r.scenario);
    if (!ref) continue;
    console.log(`  ${r.scenario}:`);
    for (const line of formatDelta(ref, r)) console.log(`    ${line}`);
  }
}
if (flag('--save-baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(file, null, 2) + '\n');
  console.log(`\nbaseline saved to ${path.relative(ROOT, BASELINE)}`);
}
if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(file, null, 2) + '\n');
  console.log(`written ${jsonOut}`);
}
