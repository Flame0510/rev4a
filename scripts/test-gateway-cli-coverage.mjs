#!/usr/bin/env node
/** Keep Rev4a's Gateway CLI invocations behind the in-container token wrapper. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const allowlist = [
  { file: 'lib/agent-images.ts', pattern: /^\['openclaw', '--version'\]$/, reason: 'Reads the installed CLI version.' },
  { file: 'lib/agent-update.ts', pattern: /^\['openclaw', '--version'\]$/, reason: 'Reads the installed CLI version after an update.' },
  { file: 'lib/credentials/native.ts', pattern: /^\['openclaw', '--version'\]$/, reason: 'Checks the installed CLI version for native delivery.' },
  { file: 'lib/agent-plugins.ts', pattern: /^\['openclaw', 'plugins', 'list', '--json'\]$/, reason: 'Reads installed plugin metadata.' },
  { file: 'lib/credentials/mongodb.ts', pattern: /^\['openclaw', 'skills', 'info', MONGODB_SKILL, '--json'\]$/, reason: 'Reads the local skill and its requirements.' },
  { file: 'lib/subscription-login.ts', pattern: /^const LOGIN_CMD = \x60timeout \$\{LOGIN_TIMEOUT_S\} script -e -qfc "openclaw models auth login --provider openai --device-code" \/dev\/null\x60;$/, reason: 'Performs provider sign-in and writes local auth state.' },
  { file: 'lib/credentials/managed.ts', pattern: /^"openclaw secrets store list 2>\/dev\/null \| grep -o 'github-setup-\[a-f0-9\].+' \| sort -u \|"$/, reason: 'Reads the local secret-store inventory inside the wrapped handoff sweep.' },
  { file: 'lib/credentials/native.ts', pattern: /^export const SECRETS_RELOAD_ARGV: readonly string\[\] = \['openclaw', 'secrets', 'reload'\];$/, reason: 'Describes the plan. Execution uses secretsReloadExecArgv.' },
  { file: 'lib/claude-lean-tools.ts', pattern: /^\s*'create_goal', 'get_goal', 'update_goal', 'intent', 'transcripts', 'codex_plugins', 'openclaw',$/, reason: 'OpenClaw is a Codex tool name in this filter.' },
  { file: 'lib/channel-pairing-store.js', pattern: /^'\/usr\/local\/lib\/node_modules\/openclaw'$/, reason: 'Locates the installed pairing SDK package.' },
];

const wrappers = new Set(['gatewayCliArgv', 'gatewayShellScript', 'gatewayCliScript']);
const gatewayCommands = [
  'config patch', 'config set', 'config unset', 'secrets store set', 'secrets store rm',
  'secrets store delete', 'secrets reload', 'pairing', 'devices', 'gateway call', 'channels',
  'cron', 'sessions', 'approvals', 'nodes', 'agent', 'models list', 'status --usage', 'dashboard',
];

// A shell template can hide the executable in an interpolation. Match the command at a
// shell boundary, with optional global flags between the executable and the command.
const gatewayCommandPattern = '(?:' + gatewayCommands.map((command) => command.replaceAll(' ', '\\s+')).join('|') + ')\\b';
const interpolatedCommand = new RegExp(
  String.raw`(?:^|[\n;|&("'])\s*["']?(?:__expression__|\$\{[^}]+\}|\$[\w]+)["']?\s+(?:--[\w-]+(?:[ =][^\s;|&]+)?\s+)*`
  + gatewayCommandPattern,
);
const gatewayCommandPrefix = new RegExp('^' + gatewayCommandPattern);
const openClawLiteral = /(?:^(?:.*\/)?openclaw$|\bopenclaw\s|\bopenclaw['"](?=\s|[),;]|$))/;
const root = path.resolve(import.meta.dirname, '..');
const options = { allowJs: true, noResolve: true, noLib: true, types: [] };

function scan(source, checker, matched) {
  const file = path.relative(root, source.fileName).split(path.sep).join('/');
  if (file === 'lib/gateway-cli.ts') return [];
  const entries = allowlist.filter((entry) => entry.file === file);
  const violations = [];
  const references = new Map();
  function collect(node) {
    if (ts.isIdentifier(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        if (!references.has(symbol)) references.set(symbol, []);
        references.get(symbol).push(node);
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(source);

  // Follow named shell fragments only when every use goes through a wrapper.
  function wrapped(node, seen = new Set()) {
    if (seen.has(node)) return false;
    seen.add(node);
    const parent = node.parent;
    if (ts.isCallExpression(parent)) {
      return ts.isIdentifier(parent.expression) && wrappers.has(parent.expression.text)
        && parent.arguments.includes(node);
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === node) {
      const uses = references.get(checker.getSymbolAtLocation(parent.name));
      return Boolean(uses?.length && uses.every((use) => wrapped(use, new Set(seen))));
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'join'
      && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      return wrapped(parent.parent, seen);
    }
    if (ts.isArrayLiteralExpression(parent) || ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)
      || ts.isParenthesizedExpression(parent) || ts.isBinaryExpression(parent) || ts.isSpreadElement(parent)) {
      return wrapped(parent, seen);
    }
    return false;
  }

  // The AST leaves out source comments. String contents, including embedded scripts, are checked.
  function visit(node) {
    const content = ts.isTemplateExpression(node)
      ? node.head.text + node.templateSpans.map((span) => '__expression__' + span.literal.text).join('')
      : ts.isStringLiteralLike(node) ? node.text : '';
    const spreadCommand = ts.isArrayLiteralExpression(node) && node.elements.length > 1
      && ts.isSpreadElement(node.elements[0]) && gatewayCommandPrefix.test(node.elements.slice(1)
        .map((word) => ts.isStringLiteralLike(word) ? word.text : '').join(' '));
    if (openClawLiteral.test(content) || interpolatedCommand.test(content) || spreadCommand) {
      const start = node.getStart(source);
      const { line } = source.getLineAndCharacterOfPosition(start);
      const lineText = source.text.slice(source.getPositionOfLineAndCharacter(line, 0)).split(/\r?\n/, 1)[0];
      const entry = entries.find((candidate) => candidate.pattern.test(node.getText(source))
        || candidate.pattern.test(node.parent.getText(source)) || candidate.pattern.test(lineText));
      if (entry) matched.add(entry);
      else if (!wrapped(node)) violations.push(file + ':' + (line + 1) + ' unwrapped OpenClaw CLI');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

const rejected = [
  "dockerExec(container, ['openclaw', 'config', 'patch', '--stdin']);",
  "const cli = 'openclaw'; dockerExec(container, [cli, 'config', 'patch']);",
  "dockerExec(container, ['openclaw', ...args]);",
  'dockerExec(container, [...base, "config", "patch"]);',
  "dockerExec(container, ['openclaw', sub, 'patch']);",
  'dockerExecShell(container, "openclaw --profile x config patch");',
  'dockerExecShell(container, `${cliName} config patch`);',
  "dockerExecShell(container, 'openclaw pairing list');",
  "const reused = 'openclaw devices list'; gatewayShellScript(reused); dockerExecShell(container, reused);",
  "dockerExecShell(container, 'openclaw ' + 'gateway call someMethod');",
  'const executable = `openclaw`; dockerExec(container, [executable, "config", "set"]);',
  'dockerExecShell(container, `${cliName} config set k v`);',
  'dockerExecShell(container, `${cliName} config unset k`);',
  'dockerExecShell(container, `${cliName} agent --message hello`);',
  'dockerExecShell(container, \'${cliName} config patch\');',
];
const accepted = [
  "dockerExec(container, gatewayCliArgv(['config', 'patch', '--stdin']));",
  "const script = ['openclaw cron list', 'echo done'].join('; ');",
  'dockerExecShell(container, gatewayShellScript(script));',
  'dockerExecShell(container, gatewayShellScript(`${cliName} config patch`));',
  'dockerExec(container, gatewayCliArgv([...flags, "config", "patch"]));',
  "// Example of a bare call: ['openclaw', 'config', 'patch']",
];

function scanFixture(lines) {
  const file = path.join(root, 'gateway-cli-coverage-fixture.ts');
  const host = ts.createCompilerHost(options);
  host.getSourceFile = () => ts.createSourceFile(file, lines.join('\n'), ts.ScriptTarget.Latest, true);
  const program = ts.createProgram([file], options, host);
  return scan(program.getSourceFile(file), program.getTypeChecker(), new Set());
}

function report(violations) {
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  }
}

if (process.argv.includes('--rejected-fixture')) {
  report(scanFixture(rejected));
} else {
  const control = spawnSync(process.execPath, [import.meta.filename, '--rejected-fixture'], { encoding: 'utf8' });
  assert.equal(control.status, 1);
  assert.deepEqual(control.stderr.trim().split('\n'), rejected.map((_, i) =>
    'gateway-cli-coverage-fixture.ts:' + (i + 1) + ' unwrapped OpenClaw CLI'));
  assert.deepEqual(scanFixture(accepted), []);
  console.log('Controls passed: every bare fixture was flagged with exit 1, and wrapped calls passed.');

  const files = ['instrumentation.ts', 'server.js'].map((file) => path.join(root, file));
  for (const dir of ['lib', 'app']) {
    for (const entry of readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(path.join(entry.parentPath, entry.name));
    }
  }
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const matched = new Set();
  const violations = files.flatMap((file) => scan(program.getSourceFile(file), checker, matched));
  for (const entry of allowlist) {
    if (!matched.has(entry)) violations.push(entry.file + ': stale allowlist entry. ' + entry.reason);
  }
  report(violations);
  if (!violations.length) console.log('Gateway CLI coverage passed.');
}
