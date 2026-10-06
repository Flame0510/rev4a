#!/usr/bin/env node
/**
 * Tests for the image-revision logic in lib/image-revision.js — which exact build of an
 * agent image a local `openclaw-agent-base:<version>` is, and whether it matches the
 * revision the release pins. Pure logic over fake image lists: no Docker, no network. Run
 *
 *   node scripts/test-image-revisions.mjs
 *
 * Tests lib/image-revision.js, the CommonJS rule that lib/agent-versions.ts and bin/rev4a.js
 * share. Exits non-zero on a failing case.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const rev = require('../lib/image-revision.js');
const table = JSON.parse(readFileSync(new URL('../lib/agent-versions.json', import.meta.url), 'utf8'));
const REPO = table.localRepository;
// Same shapes as the typed wrappers in lib/agent-versions.ts.
const pinnedImageRevision = (v) => rev.pinnedRevision(table.supported.find((e) => e.version === v));
const registryImageTag = (v) => rev.registryTag(v, pinnedImageRevision(v));
const localRevisionRef = (v, sha) => rev.revisionRef(REPO, v, sha);
const localImageRevision = (v, images, pin = pinnedImageRevision(v)) => rev.localImageRevision(REPO, v, images, pin);
const imageRevisionStatus = (v, images, pin = pinnedImageRevision(v)) => rev.revisionStatus(REPO, v, images, pin);
const isRevisionTag = rev.isRevisionTag;
// Mirrors VERSION_RE / parseOpenClawVersion in lib/agent-versions.ts.
const parseOpenClawVersion = (text) => {
  const m = /(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?/.exec(text ?? '');
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] !== undefined ? `-${Number(m[4])}` : ''}` : null;
};

delete process.env.REV4A_AGENT_IMAGE_REGISTRY;

const R = REPO;
const img = (id, ...tags) => ({ id, tags: tags.map((t) => `${R}:${t}`) });
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

test('the release pins 2026.9.3 to 3513098', () => {
  assert.equal(pinnedImageRevision('2026.9.3'), '3513098');
  assert.equal(registryImageTag('2026.9.3'), '2026.9.3-3513098');
  assert.equal(pinnedImageRevision('2099.1.1'), null);
  assert.equal(registryImageTag('2099.1.1'), '2099.1.1');
});

test('a registry override ignores the pin', () => {
  process.env.REV4A_AGENT_IMAGE_REGISTRY = 'localhost:5000/x';
  try {
    assert.equal(pinnedImageRevision('2026.9.3'), null);
    assert.equal(registryImageTag('2026.9.3'), '2026.9.3');
  } finally {
    delete process.env.REV4A_AGENT_IMAGE_REGISTRY;
  }
});

test('missing: no image, or only another version', () => {
  assert.equal(imageRevisionStatus('2026.9.3', [], '3513098'), 'missing');
  assert.equal(imageRevisionStatus('2026.9.3', [img('a', '2026.9.2')], '3513098'), 'missing');
  assert.equal(imageRevisionStatus('2026.9.3', [img('a', 'latest')], '3513098'), 'missing');
});

test('current: the version image carries the pinned rev tag', () => {
  const images = [img('a', '2026.9.3', '2026.9.3-rev.3513098')];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'current');
  assert.equal(localImageRevision('2026.9.3', images), '3513098');
});

test('outdated: no rev tag (image downloaded before revisions)', () => {
  const images = [img('a', '2026.9.3')];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'outdated');
  assert.equal(localImageRevision('2026.9.3', images), null);
});

test('outdated: another revision', () => {
  const images = [img('a', '2026.9.3', '2026.9.3-rev.abcdef1')];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'outdated');
  assert.equal(localImageRevision('2026.9.3', images), 'abcdef1');
});

test('no pin: present is current whatever its tags', () => {
  assert.equal(imageRevisionStatus('2026.9.3', [img('a', '2026.9.3')], null), 'current');
  assert.equal(imageRevisionStatus('2026.9.3', [img('a', '2026.9.3', '2026.9.3-rev.abcdef1')], null), 'current');
  assert.equal(imageRevisionStatus('2026.9.3', [], null), 'missing');
});

test('an all-digit sha is a revision, never a version', () => {
  assert.equal(parseOpenClawVersion('2026.9.3-rev.3513098'), '2026.9.3');
  assert.equal(isRevisionTag('2026.9.3-rev.3513098'), true);
  assert.equal(isRevisionTag('2026.9.3-3513098'), false);
  assert.equal(isRevisionTag('2026.9.3'), false);
  assert.equal(isRevisionTag('2026.9.3-rev.nothex'), false);
  assert.equal(localRevisionRef('2026.9.3', '3513098'), `${R}:2026.9.3-rev.3513098`);
  const images = [img('a', '2026.9.3', '2026.9.3-rev.3513098')];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'current');
  // Not a rev tag: this would be read as another version, so it must not count.
  assert.equal(imageRevisionStatus('2026.9.3', [img('a', '2026.9.3', '2026.9.3-3513098')], '3513098'), 'outdated');
});

test('a rev tag on a different image id does not count', () => {
  const images = [img('new', '2026.9.3'), img('old', '2026.9.3-rev.3513098')];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'outdated');
  assert.equal(localImageRevision('2026.9.3', images), null);
});

test('several versions are judged independently', () => {
  const images = [
    img('a', '2026.9.3', '2026.9.3-rev.3513098'),
    img('b', '2026.9.2'),
    img('c', '2026.9.1', '2026.9.1-rev.1111111'),
  ];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'current');
  assert.equal(imageRevisionStatus('2026.9.2', images, '2222222'), 'outdated');
  assert.equal(imageRevisionStatus('2026.9.1', images, '1111111'), 'current');
  assert.equal(imageRevisionStatus('2026.9.0', images, '0000000'), 'missing');
});

test('after a rebuild download the old image keeps only its rev tag', () => {
  const images = [img('new', '2026.9.3', '2026.9.3-rev.3513098'), img('old', '2026.9.3-rev.abcdef1')];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'current');
  assert.equal(localImageRevision('2026.9.3', images), '3513098');
});

test('several rev tags: current when any is the pin, in either order', () => {
  const a = [img('a', '2026.9.3', '2026.9.3-rev.3513098', '2026.9.3-rev.abcdef123456')];
  const b = [img('a', '2026.9.3', '2026.9.3-rev.abcdef123456', '2026.9.3-rev.3513098')];
  for (const images of [a, b]) {
    assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'current');
    assert.equal(localImageRevision('2026.9.3', images, '3513098'), '3513098');
  }
  // No pin among them: outdated, and local reports one of the others (the first).
  const c = [img('a', '2026.9.3', '2026.9.3-rev.1111111', '2026.9.3-rev.2222222')];
  assert.equal(imageRevisionStatus('2026.9.3', c, '3513098'), 'outdated');
  assert.equal(localImageRevision('2026.9.3', c, '3513098'), '1111111');
});

test('identity revision: 12 hex chars of the image id, accepted as a rev tag', () => {
  const sha = rev.identityRevision('sha256:0123456789abcdef0123456789abcdef');
  assert.equal(sha, '0123456789ab');
  assert.equal(isRevisionTag(`2026.9.3-rev.${sha}`), true);
  const images = [img('x', '2026.9.3', `2026.9.3-rev.${sha}`)];
  assert.equal(imageRevisionStatus('2026.9.3', images, '3513098'), 'outdated');
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
