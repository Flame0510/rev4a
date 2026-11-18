#!/usr/bin/env node
/**
 * Secret fields must never receive the browser's saved dashboard password. Seen live 2026-11-18 on a new
 * domain: the agents' Gateway Token field showed the panel password (autofill), and a Save would have
 * synced it to every agent. Secret inputs say autoComplete="new-password"; the login says
 * "current-password".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

for (const file of ['app/components/PasswordInput.tsx', 'app/agents/ChannelManager.tsx', 'app/wizard/PageClient.tsx']) {
  const source = read(file);
  assert.match(source, /autoComplete="new-password"/, `${file}: secret field must not be autofilled with the login password`);
  assert.match(source, /data-1p-ignore="true"/, `${file}: password managers told to ignore the field`);
}
assert.match(read('app/login/page.tsx'), /autoComplete="current-password"/, 'login field marked as the real password');

// Every type="password" input outside the login/setup pages carries the guard.
const dirs = ['app'];
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (/\.tsx$/.test(entry.name) && !/^app\/(login|setup)\//.test(rel)) {
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        if (/type=["']password["']|type=\{[^}]*password/.test(line)) {
          const window = lines.slice(i, i + 8).join('\n');
          if (!/autoComplete="new-password"/.test(window)) offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
  }
};
for (const dir of dirs) walk(dir);
assert.deepEqual(offenders, [], `password inputs without autoComplete="new-password": ${offenders.join(', ')}`);
console.log('secret fields are never autofilled with the dashboard password');
