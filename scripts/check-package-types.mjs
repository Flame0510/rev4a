#!/usr/bin/env node
/**
 * Typecheck the npm tarball from a package path under node_modules. TypeScript resolves
 * CommonJS imports differently there than in the repository, so a local build alone
 * cannot catch a missing sibling .d.ts file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'rev4a-package-types-'));
// Runs on a normal exit and on process.exit(1); a finally block would not see the latter.
process.on('exit', () => rmSync(temp, { recursive: true, force: true }));

const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], {
  cwd: root,
  encoding: 'utf8',
}));
const packageDir = join(temp, 'node_modules', ...name.split('/'));
mkdirSync(packageDir, { recursive: true });
execFileSync('tar', ['-xzf', join(temp, packed.filename), '-C', packageDir, '--strip-components=1']);

const packedManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const shrinkwrapPath = join(packageDir, 'npm-shrinkwrap.json');
if (!existsSync(shrinkwrapPath)) {
  console.error('npm-shrinkwrap.json is missing from the npm tarball.');
  process.exit(1);
}
const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, 'utf8'));
if (shrinkwrap.version !== packedManifest.version || shrinkwrap.packages?.['']?.version !== packedManifest.version) {
  console.error('The published dependency lock does not match the package version.');
  process.exit(1);
}
const buildDependencies = [
  'typescript', '@types/node', '@types/react', '@types/react-dom',
  '@types/d3', '@types/ws', '@types/better-sqlite3',
];
const missingBuildDependencies = buildDependencies.filter((dep) => !packedManifest.dependencies?.[dep] || !shrinkwrap.packages?.[`node_modules/${dep}`]);
if (missingBuildDependencies.length) {
  console.error(`Global builds need these production dependencies: ${missingBuildDependencies.join(', ')}`);
  process.exit(1);
}
if (packedManifest.dependencies.next !== shrinkwrap.packages?.['node_modules/next']?.version) {
  console.error('Pin Next.js to the version in the published dependency lock.');
  process.exit(1);
}

const libDir = join(packageDir, 'lib');
function missingDeclarations(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return missingDeclarations(file);
    if (!/\.(?:js|mjs)$/.test(entry.name)) return [];
    return existsSync(file.replace(/\.(?:js|mjs)$/, '.d.ts')) ? [] : [file.slice(libDir.length + 1)];
  });
}
const missing = missingDeclarations(libDir);
if (missing.length) {
  console.error(`Missing declaration files in the npm tarball: ${missing.join(', ')}`);
  process.exit(1);
}

// Use the checkout's installed dependencies, but keep the project itself under
// node_modules so TS follows the same package-resolution path as the global install.
symlinkSync(join(root, 'node_modules'), join(packageDir, 'node_modules'), 'dir');
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false'], {
  cwd: packageDir,
  stdio: 'inherit',
});
console.log(`Package-path typecheck passed for ${name}.`);
