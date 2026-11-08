#!/usr/bin/env node
/**
 * SEC-15: filename boundaries and the real promote handler against a temporary host folder.
 * Docker and auth are stubbed; no Docker, running server, network or real Rev4a data is used.
 * Boundaries: helper.sh, .hidden, ...., ..env and 255-byte names pass; traversal, dot paths,
 * separators, NUL, CR/LF, empty and 256-byte names fail. Exactly 1 MiB passes; +1 is skipped
 * for extras and returns 413 for SKILL.md. At most 200 safe extra reads are attempted.
 * Round 2: 150,000 listed extras retain exact skipped counts with only 50 sampled names;
 * regular-file/dangling-link directories return 403; realpath catches swapped ancestors;
 * O_NOFOLLOW refuses final-file symlinks introduced after lstat for SKILL.md and extras.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import names from '../lib/skill-promote-names.js';

const { isSafeSkillPromoteName, SKILL_PROMOTE_MAX_FILE_BYTES: MAX_BYTES, SKILL_PROMOTE_MAX_EXTRA_FILES: MAX_FILES } = names;
const source = fs.readFileSync(new URL('../app/api/skills/promote/route.js', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log(`EXECUTED: ${label} — PASS`);
}

async function fixture(fn, { skillName = 'demo', listing = '', listingError = null, files = {}, skill = '# From the agent\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-promote-'));
  const shared = path.join(root, 'data', 'shared', 'shared-skills');
  const dir = path.join(shared, skillName);
  const outside = path.join(root, 'data', '.env');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'host sentinel');
  const reads = [];
  const writes = [];
  const descriptors = new Map();
  const state = {
    listing, listingError, files: { 'SKILL.md': skill, ...files }, beforeRead: null, beforeOpen: null,
    beforeRealpath: null, writeError: null, denied: null,
  };
  const deps = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    fs: {
      ...fs,
      realpathSync(file) {
        state.beforeRealpath?.(file);
        return fs.realpathSync(file);
      },
      openSync(file, flags, mode) {
        assert.equal(flags, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
        assert.equal(mode, 0o644);
        assert.ok(file.startsWith(path.resolve(dir) + path.sep), file);
        state.beforeOpen?.(file);
        const fd = fs.openSync(file, flags, mode);
        descriptors.set(fd, file);
        return fd;
      },
      writeFileSync(fd, data, ...args) {
        assert.equal(typeof fd, 'number', 'writes must use the no-follow descriptor');
        const file = descriptors.get(fd);
        assert.ok(file, 'descriptor must have been opened by the route');
        assert.ok(!fs.lstatSync(dir).isSymbolicLink());
        assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(shared) + path.sep));
        assert.ok(!fs.lstatSync(file).isSymbolicLink());
        if (state.writeError) throw state.writeError;
        writes.push(file);
        return fs.writeFileSync(fd, data, ...args);
      },
      closeSync(fd) {
        assert.ok(descriptors.delete(fd), 'close the opened descriptor exactly once');
        return fs.closeSync(fd);
      },
    },
    path,
    child_process: { execFileSync(command, argv, options) {
      assert.equal(command, 'docker');
      if (argv[0] === 'inspect') return 'agent-test\n';
      assert.equal(argv[0], 'exec');
      assert.equal(argv[1], 'agent-test');
      if (argv[2] === 'ls') {
        if (state.listingError) throw Object.assign(new Error('ls failed'), { code: state.listingError });
        if (Buffer.byteLength(state.listing) > options.maxBuffer) throw Object.assign(new Error('Output buffer exceeded'), { code: 'ENOBUFS' });
        return state.listing;
      }
      assert.equal(argv[2], 'cat');
      const prefix = `/root/.openclaw/workspace/skills/${skillName}/`;
      assert.ok(argv[3].startsWith(prefix));
      const name = argv[3].slice(prefix.length);
      reads.push(name);
      state.beforeRead?.(name);
      assert.equal(options.maxBuffer, MAX_BYTES + 1, 'container output must be bounded');
      assert.equal(options.encoding, undefined, 'measure raw bytes, including binary and UTF-8');
      const value = state.files[name];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error('Missing source file');
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes.length > options.maxBuffer) throw Object.assign(new Error('Output buffer exceeded'), { code: 'ENOBUFS' });
      return bytes;
    } },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => state.denied },
    '@/lib/agent-names': { describeAgent: name => name },
    '@/lib/rev4a-paths': { SHARED_SKILLS_DIR: shared },
    '@/lib/rev4a-skills': { isRev4aOwnedSkill: name => /^rev4a-/i.test(name) },
    '@/lib/skill-files': { CONTAINER_NAME_RE: /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/ },
    '@/lib/skill-promote-names': names,
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, Buffer, Error,
    require: name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; },
  }, { filename: 'skills/promote/route.js' });
  const promote = async (body = {}) => {
    const response = await mod.exports.POST({ json: async () => ({ containerName: 'agent-test', skillName, ...body }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  try {
    await fn({ root, shared, dir, outside, reads, writes, state, promote });
    assert.equal(descriptors.size, 0, 'all destination descriptors are closed, including on write failure');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'host sentinel', 'host data outside the skill folder is untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await test('plain filename boundaries, including UTF-8 bytes rather than character count', () => {
  for (const name of ['helper.sh', '.hidden', '....', '..env', 'with space.txt', 'a'.repeat(255), 'é'.repeat(127) + 'a']) {
    assert.equal(isSafeSkillPromoteName(name), true, JSON.stringify(name));
  }
  for (const name of ['../../../.env', '..', '.', 'a/b', 'a\\b', 'x\0y', '', 'a\nb', 'a\rb', 'a'.repeat(256), 'é'.repeat(128), null, 7, {}]) {
    assert.equal(isSafeSkillPromoteName(name), false, JSON.stringify(name));
  }
});

await test('malicious listing cannot escape; skipped names retain their exact JSON-escaped value', async () => {
  const bad = ['../../../.env', '..', '.', 'a/b', 'a\\b', 'x\0y', '', 'a\rb', 'quote"\rname', 'a'.repeat(256), '../../../'];
  const good = ['helper.sh', '.hidden', '....', '..env', 'a'.repeat(255), ' padded '];
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.skipped, bad.map(n => n.length > 120 ? `${n.slice(0, 120)}…` : n), 'long names are truncated in the sample');
    assert.equal(r.body.extraCopied, good.length);
    assert.deepEqual(s.reads, ['SKILL.md', ...good], 'unsafe entries never reach cat');
    assert.equal(r.body.destPath, path.join(s.dir, 'SKILL.md'));
    for (const name of good) assert.equal(fs.readFileSync(path.join(s.dir, name), 'utf8'), name);
    assert.equal(fs.readFileSync(r.body.destPath, 'utf8'), '# From the agent\n');
    assert.ok(r.text.includes('x\\u0000y'));
    assert.ok(r.text.includes('quote\\"\\rname'));
  }, { listing: [...bad, 'scripts/', 'SKILL.md', ...good].join('\n') + '\n', files: Object.fromEntries(good.map(n => [n, n])) });
});

await test('exactly 1 MiB extra is copied; +1, buffer overflow and read failure are skipped; later extras survive', async () => {
  assert.equal(MAX_BYTES, 1024 * 1024);
  const exact = Buffer.alloc(MAX_BYTES, 0xff);
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.extraCopied, 2);
    assert.deepEqual(r.body.skipped, ['over.bin', 'overflow.bin', 'missing.txt']);
    assert.deepEqual(fs.readFileSync(path.join(s.dir, 'exact.bin')), exact, 'binary bytes survive unchanged');
    assert.equal(fs.readFileSync(path.join(s.dir, 'later.txt'), 'utf8'), 'later');
    for (const name of r.body.skipped) assert.ok(!fs.existsSync(path.join(s.dir, name)));
  }, { listing: 'exact.bin\nover.bin\noverflow.bin\nmissing.txt\nlater.txt\n', files: {
    'exact.bin': exact, 'over.bin': Buffer.alloc(MAX_BYTES + 1), 'overflow.bin': Buffer.alloc(MAX_BYTES + 4096), 'later.txt': 'later',
  } });
});

await test('exactly 1 MiB SKILL.md is allowed; +1 and buffer overflow return 413 without writes', async () => {
  await fixture(async s => {
    assert.equal((await s.promote()).status, 200);
    assert.equal(fs.statSync(path.join(s.dir, 'SKILL.md')).size, MAX_BYTES);
  }, { skill: Buffer.alloc(MAX_BYTES) });
  for (const size of [MAX_BYTES + 1, MAX_BYTES + 4096]) {
    await fixture(async s => {
      const r = await s.promote();
      assert.equal(r.status, 413);
      assert.deepEqual(s.writes, []);
      assert.ok(!fs.existsSync(s.shared));
    }, { skill: Buffer.alloc(size) });
  }
});

await test('file size is measured in bytes for multibyte content too', async () => {
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.body.extraCopied, 1);
    assert.deepEqual(r.body.skipped, ['over.txt']);
    assert.equal(fs.statSync(path.join(s.dir, 'exact.txt')).size, MAX_BYTES);
  }, { listing: 'exact.txt\nover.txt\n', files: { 'exact.txt': 'é'.repeat(MAX_BYTES / 2), 'over.txt': 'é'.repeat(MAX_BYTES / 2) + 'a' } });
});

await test('200 extras allowed, 201st skipped without a read; failures count but unsafe names do not', async () => {
  assert.equal(MAX_FILES, 200);
  const good = Array.from({ length: MAX_FILES + 1 }, (_, i) => `file-${i}`);
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.extraCopied, 199);
    assert.deepEqual(r.body.skipped, ['../bad', 'file-200', 'file-0']);
    assert.equal(r.body.skippedCount, 3);
    assert.deepEqual(s.reads, ['SKILL.md', ...good.slice(0, MAX_FILES)]);
    assert.ok(fs.existsSync(path.join(s.dir, 'file-199')));
    assert.ok(!fs.existsSync(path.join(s.dir, 'file-200')));
  }, { listing: ['../bad', ...good].join('\n') + '\n', files: Object.fromEntries(good.slice(1).map(n => [n, 'ok'])) });
});

await test('50,000 listed files copy the first 200 and report 49,800 skipped with only 50 names', async () => {
  const listed = Array.from({ length: 50_000 }, (_, i) => `file-${i}`);
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.extraCopied, MAX_FILES);
    assert.equal(r.body.skippedCount, listed.length - MAX_FILES);
    assert.deepEqual(r.body.skipped, listed.slice(MAX_FILES, MAX_FILES + 50));
    assert.deepEqual(s.reads, ['SKILL.md', ...listed.slice(0, MAX_FILES)]);
    assert.equal(s.writes.length, MAX_FILES + 1);
  }, { listing: listed.join('\n') + '\n', files: Object.fromEntries(listed.slice(0, MAX_FILES).map(n => [n, 'ok'])) });
});

await test('a listing over 1 MiB returns 413 and a failed listing 502, with no writes (never "no extra files")', async () => {
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 413);
    assert.equal(s.writes.length, 0);
  }, { listing: 'x'.repeat(200).concat('\n').repeat(6000) });
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 502);
    assert.equal(s.writes.length, 0);
  }, { listingError: 'EIO' });
});

await test('a 1 MiB unsafe name is reported as a 121-character sample', async () => {
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.skippedCount, 1);
    assert.equal(r.body.skipped[0].length, 121);
    assert.ok(r.text.length < 4096, `response is ${r.text.length} bytes`);
  }, { listing: 'a/'.repeat(250_000) + 'b\n' });
});

await test('unsafe entries cap the skipped sample too, without consuming the safe-file allowance', async () => {
  await fixture(async s => {
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.extraCopied, 1);
    assert.equal(r.body.skippedCount, 100);
    assert.deepEqual(r.body.skipped, Array(50).fill('../bad'));
    assert.deepEqual(s.reads, ['SKILL.md', 'helper.sh']);
  }, { listing: '../bad\n'.repeat(100) + 'helper.sh\n', files: { 'helper.sh': 'ok' } });
});

await test('existing and dangling extra symlinks are skipped while a regular extra is overwritten', async () => {
  await fixture(async s => {
    fs.mkdirSync(s.dir, { recursive: true });
    fs.symlinkSync(s.outside, path.join(s.dir, 'linked'));
    const absent = path.join(s.root, 'absent');
    fs.symlinkSync(absent, path.join(s.dir, 'dangling'));
    fs.mkdirSync(path.join(s.dir, 'directory'));
    fs.writeFileSync(path.join(s.dir, 'regular'), 'old');
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.equal(r.body.extraCopied, 1);
    assert.deepEqual(r.body.skipped, ['linked', 'dangling', 'directory']);
    assert.ok(!fs.existsSync(absent));
    assert.ok(fs.lstatSync(path.join(s.dir, 'linked')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(s.dir, 'regular'), 'utf8'), 'new');
  }, { listing: 'linked\ndangling\ndirectory\nregular\n', files: { linked: 'bad', dangling: 'bad', directory: 'bad', regular: 'new' } });
});

await test('SKILL.md symlinks, including dangling links, return 403 without writing', async () => {
  for (const dangling of [false, true]) {
    await fixture(async s => {
      fs.mkdirSync(s.dir, { recursive: true });
      const target = dangling ? path.join(s.root, 'absent') : s.outside;
      fs.symlinkSync(target, path.join(s.dir, 'SKILL.md'));
      assert.equal((await s.promote()).status, 403);
      assert.deepEqual(s.writes, []);
      if (dangling) assert.ok(!fs.existsSync(target));
    });
  }
});

await test('destination, shared root and nested parent symlinks cannot redirect writes or mkdir', async () => {
  for (const level of ['destination', 'shared', 'parent']) {
    await fixture(async s => {
      const target = path.join(s.root, 'elsewhere');
      fs.mkdirSync(target);
      const link = level === 'shared' ? s.shared : level === 'parent' ? path.join(s.shared, 'team') : s.dir;
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, 'dir');
      assert.equal((await s.promote()).status, 403);
      assert.deepEqual(s.writes, []);
      assert.deepEqual(fs.readdirSync(target), [], 'no child directory created through the symlink');
    }, { skillName: level === 'parent' ? 'team/demo' : 'demo' });
  }
});

await test('destination, shared root and nested parent regular files or dangling symlinks return 403', async () => {
  for (const level of ['destination', 'shared', 'parent']) {
    for (const dangling of [false, true]) {
      await fixture(async s => {
        const dest = level === 'shared' ? s.shared : level === 'parent' ? path.join(s.shared, 'team') : s.dir;
        const absent = path.join(s.root, 'absent');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (dangling) fs.symlinkSync(absent, dest, 'dir');
        else fs.writeFileSync(dest, 'existing file');
        const r = await s.promote();
        assert.equal(r.status, 403, `${level}, dangling=${dangling}`);
        assert.deepEqual(s.writes, []);
        assert.ok(!fs.existsSync(absent));
        if (!dangling) assert.equal(fs.readFileSync(dest, 'utf8'), 'existing file');
      }, { skillName: level === 'parent' ? 'team/demo' : 'demo' });
    }
  }
});

await test('realpath confines writes when a nested ancestor is swapped before SKILL.md or an extra', async () => {
  for (const phase of ['skill', 'extra']) {
    // A sibling sharing the root prefix must also fail the separator-aware check.
    for (const targetType of ['outside', 'sibling-prefix']) {
      await fixture(async s => {
        const target = targetType === 'outside' ? path.join(s.root, 'elsewhere') : s.shared + '-evil';
        const targetDir = path.join(target, 'demo');
        fs.mkdirSync(targetDir, { recursive: true });
        const swap = () => {
          fs.renameSync(path.join(s.shared, 'team'), path.join(s.shared, 'team-original'));
          fs.symlinkSync(target, path.join(s.shared, 'team'), 'dir');
          assert.ok(fs.lstatSync(s.dir).isDirectory(), 'the leaf itself is still a real directory');
        };
        if (phase === 'skill') {
          s.state.beforeRealpath = () => {
            s.state.beforeRealpath = null;
            swap();
          };
        } else {
          s.state.beforeRead = name => { if (name === 'helper.sh') swap(); };
        }
        const r = await s.promote();
        assert.equal(r.status, phase === 'skill' ? 403 : 200);
        if (phase === 'extra') {
          assert.deepEqual(r.body.skipped, ['helper.sh']);
          assert.equal(r.body.skippedCount, 1);
        }
        assert.equal(s.writes.length, phase === 'skill' ? 0 : 1);
        assert.deepEqual(fs.readdirSync(targetDir), [], 'no writes through the swapped ancestor');
      }, { skillName: 'team/demo', listing: 'helper.sh\n', files: { 'helper.sh': 'bad' } });
    }
  }
});

await test('O_NOFOLLOW blocks SKILL.md and extra symlinks introduced between lstat and open', async () => {
  for (const name of ['SKILL.md', 'helper.sh']) {
    for (const dangling of [false, true]) {
      await fixture(async s => {
        fs.mkdirSync(s.dir, { recursive: true });
        fs.writeFileSync(path.join(s.dir, name), 'old');
        const target = dangling ? path.join(s.root, 'absent') : s.outside;
        let swapped = false;
        s.state.beforeOpen = file => {
          if (path.basename(file) !== name) return;
          fs.unlinkSync(file);
          fs.symlinkSync(target, file);
          swapped = true;
        };
        const r = await s.promote();
        assert.ok(swapped, 'race must be injected after the destination checks');
        assert.equal(r.status, name === 'SKILL.md' ? 403 : 200);
        if (name !== 'SKILL.md') {
          assert.deepEqual(r.body.skipped, [name]);
          assert.equal(r.body.skippedCount, 1);
          assert.equal(r.body.extraCopied, 1, 'a later safe extra still succeeds');
          assert.equal(fs.readFileSync(path.join(s.dir, 'later'), 'utf8'), 'ok');
        }
        assert.ok(fs.lstatSync(path.join(s.dir, name)).isSymbolicLink());
        if (dangling) assert.ok(!fs.existsSync(target));
      }, { listing: 'helper.sh\nlater\n', files: { 'helper.sh': 'bad', later: 'ok' } });
    }
  }
});

await test('destination descriptors close even when writing SKILL.md or an extra fails', async () => {
  for (const name of ['SKILL.md', 'helper.sh']) {
    await fixture(async s => {
      s.state.beforeOpen = file => {
        if (path.basename(file) === name) s.state.writeError = new Error('Injected disk failure');
      };
      const r = await s.promote();
      assert.equal(r.status, name === 'SKILL.md' ? 500 : 200);
      if (name !== 'SKILL.md') {
        assert.deepEqual(r.body.skipped, [name]);
        assert.equal(r.body.skippedCount, 1);
      }
    }, { listing: 'helper.sh\n', files: { 'helper.sh': 'ok' } });
  }
});

await test('destination directory is checked again after reading an extra', async () => {
  await fixture(async s => {
    const target = path.join(s.root, 'elsewhere');
    fs.mkdirSync(target);
    s.state.beforeRead = name => {
      if (name === 'helper.sh') {
        fs.renameSync(s.dir, s.dir + '-original');
        fs.symlinkSync(target, s.dir, 'dir');
      }
    };
    const r = await s.promote();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.skipped, ['helper.sh']);
    assert.equal(s.writes.length, 1, 'only SKILL.md was written before the directory changed');
    assert.deepEqual(fs.readdirSync(target), []);
  }, { listing: 'helper.sh\n', files: { 'helper.sh': 'bad' } });
});

await test('nested skill names and repeated promotion still work with an empty skipped array', async () => {
  await fixture(async s => {
    const first = await s.promote();
    assert.equal(first.status, 200);
    assert.equal(first.body.overwritten, false);
    assert.deepEqual(first.body.skipped, []);
    assert.equal(first.body.skippedCount, 0);
    s.state.files['SKILL.md'] = '# Updated\n';
    const second = await s.promote();
    assert.equal(second.status, 200);
    assert.equal(second.body.overwritten, true);
    assert.equal(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), '# Updated\n');
  }, { skillName: 'team/demo' });
});

await test('auth, container validation, reserved skills and missing SKILL.md still prevent writes', async () => {
  await fixture(async s => {
    s.state.denied = Response.json({ error: 'Unauthorized' }, { status: 401 });
    assert.equal((await s.promote()).status, 401);
    s.state.denied = null;
    assert.equal((await s.promote({ containerName: 'a/b' })).status, 400);
    assert.equal((await s.promote({ skillName: '../escape' })).status, 400);
    assert.equal((await s.promote({ skillName: 'rev4a-owned' })).status, 403);
    delete s.state.files['SKILL.md'];
    assert.equal((await s.promote()).status, 404);
    assert.deepEqual(s.writes, []);
  });
});

console.log(`\n${passed} skill promote tests passed`);
