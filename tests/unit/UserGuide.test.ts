import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUIDE = path.join(ROOT, 'docs', 'USER_GUIDE.html');

describe('user guide', () => {
  const html = fs.readFileSync(GUIDE, 'utf8');

  test('every referenced image exists and is a PNG (regenerate with npm run docs:shots)', () => {
    const refs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 15, `only ${refs.length} images referenced`);
    for (const ref of refs) {
      const file = path.join(path.dirname(GUIDE), ref);
      assert.ok(fs.existsSync(file), `missing ${ref}`);
      const head = fs.readFileSync(file).subarray(0, 8);
      assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${ref} is not a PNG`);
    }
  });

  test('every image has alt text and every TOC link has a target section', () => {
    for (const m of html.matchAll(/<img[^>]*>/g)) assert.match(m[0], /alt="[^"]+"/, `no alt: ${m[0].slice(0, 60)}`);
    const anchors = [...html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    for (const id of anchors) assert.ok(html.includes(`id="${id}"`), `dangling link #${id}`);
  });

  test('uses no external resources (works offline like the app)', () => {
    assert.ok(!/(src|href)="https?:\/\//.test(html), 'external URL found');
    assert.ok(!/@import|url\(https?:/.test(html));
  });
});
