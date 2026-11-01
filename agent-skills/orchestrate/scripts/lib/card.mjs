// The card format the skill owns, the same for every tracker. The coordinator writes the content (what to do, which
// files, how to check it); `orch card` writes it in the tracker's format and refuses a card the loop could not work:
// no acceptance criteria, owned files that are missing or too broad, a code card that cannot carry a test.
//
// A card as JSON (the coordinator writes this file, then runs orch card new|split|normalise --from <file>):
//   { "title": "…", "goal": "…", "acceptance": ["…", "…"], "owned": ["app/x/**", "tests/e2e/03-x.spec.ts"],
//     "kind": "code|test|content|migration", "parent": "SB-62", "dependencies": ["SB-61"], "checks": ["…"],
//     "external": ["image-generation"], "noTests": "why no test", "priority": "high|medium|low", "labels": ["…"] }
import { firstOverlap, matchesAny } from './glob.mjs';
import { concreteExample, isMigrationPath, ownsSourceCode, ownsTestFile } from './harness.mjs';
import { ownedShare } from './select.mjs';
import { OrchError } from './util.mjs';

export const KINDS = ['code', 'test', 'content', 'migration'];
const PRIORITIES = ['high', 'medium', 'low'];
const STRINGS = ['title', 'goal', 'kind', 'parent', 'noTests', 'priority'];
const LISTS = ['acceptance', 'owned', 'dependencies', 'checks', 'external', 'labels'];
const FIELDS = [...STRINGS, ...LISTS];

const text = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

/**
 * A card from JSON input, with defaults. Unknown fields and wrong types are errors, never coerced: a typo or an
 * object where a string belongs would otherwise land in the tracker as "[object Object]" or vanish.
 */
export function cardFromInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OrchError('a card is a JSON object');
  const unknown = Object.keys(input).filter(k => !FIELDS.includes(k));
  if (unknown.length) throw new OrchError(`unknown card field(s): ${unknown.join(', ')} (fields: ${FIELDS.join(', ')})`);
  const bad = [];
  for (const k of STRINGS) if (input[k] != null && typeof input[k] !== 'string') bad.push(`${k} must be a string`);
  for (const k of LISTS) {
    const v = input[k];
    if (v == null) continue;
    if (!Array.isArray(v)) { bad.push(`${k} must be a list of strings`); continue; }
    v.forEach((x, i) => {
      if (typeof x !== 'string') bad.push(`${k}[${i}] must be a string`);
      else if (/[\r\n]/.test(x)) bad.push(`${k}[${i}] has a line break (one line per item)`);
    });
  }
  if (bad.length) throw new OrchError(`card: ${bad.join('; ')}`);
  const list = k => (input[k] ?? []).map(x => x.trim()).filter(Boolean);
  return {
    title: text(input.title), goal: String(input.goal ?? '').trim(), acceptance: list('acceptance').map(text),
    owned: list('owned'), kind: text(input.kind) || 'code', parent: text(input.parent) || null,
    dependencies: list('dependencies'), checks: list('checks'), external: list('external'),
    noTests: text(input.noTests) || null, priority: 'priority' in input && input.priority === null ? null : text(input.priority) || 'medium', labels: list('labels'),
  };
}

/**
 * Problems of a card against the project. errors block the write; warnings are printed for the coordinator.
 * ctx: { cfg, tracked (repo files), tasks (tracker.list()), selfId (when checking an existing card) }
 */
export function validateCard(card, { cfg, tracked = [], tasks = [], selfId = null }) {
  const errors = []; const warnings = [];
  const byId = new Map(tasks.map(t => [t.id.toUpperCase(), t]));
  if (!card.title) errors.push('title is empty');
  else if (card.title.length > 120) errors.push(`title is ${card.title.length} characters: keep it under 120 (details go in the goal)`);
  if (card.goal.length < 20) errors.push('goal is missing or too short: say what the change must achieve and why');
  if (!KINDS.includes(card.kind)) errors.push(`kind "${card.kind}" is not one of ${KINDS.join(', ')}`);
  if (card.priority !== null && !PRIORITIES.includes(card.priority)) errors.push(`priority "${card.priority}" is not one of ${PRIORITIES.join(', ')}`);

  if (card.parent && card.dependencies.some(d => String(d).toUpperCase() === card.parent.toUpperCase())) {
    errors.push(`depends on ${card.parent}, the card it is split from: that card closes its split cards and waits for them`);
  }
  if (!card.acceptance.length) errors.push('no acceptance criteria: the checker verifies a card criterion by criterion');
  else if (card.acceptance.length > 7) warnings.push(`${card.acceptance.length} acceptance criteria: a card this large rarely passes in one round, consider orch card split`);
  for (const [i, a] of card.acceptance.entries()) if (a.length < 15) errors.push(`acceptance #${i + 1} "${a}" is too vague to check`);

  if (!card.owned.length) errors.push('no owned files: list the files or narrow globs the card may change');
  for (const g of card.owned) {
    if (/^(\*\*?|\.?\/?)$/.test(g) || g === '**/*') errors.push(`owned "${g}" is the whole repository`);
    if (g.includes('\\') || /^[A-Za-z]:/.test(g)) errors.push(`owned "${g}" must use forward slashes, relative to the repository root`);
    else if (g.startsWith('/') || g.split('/').includes('..')) errors.push(`owned "${g}" must be a path inside the repository`);
  }
  if (card.owned.length && tracked.length) {
    const share = ownedShare(card.owned, tracked);
    if (share > cfg.limits.maxOwnedShare) errors.push(`too broad: the owned files cover ${Math.round(share * 100)}% of the repository, split the card`);
    const dead = card.owned.filter(g => !/[*?]/.test(g) && !tracked.includes(g) && !tracked.some(f => f.startsWith(`${g.replace(/\/+$/, '')}/`)));
    if (dead.length) warnings.push(`owned file(s) not in the repository yet (fine if the card creates them): ${dead.join(', ')}`);
  }

  const testRuleOn = cfg.tests.rule !== 'off';
  const source = ownsSourceCode(card.owned, cfg.tests.paths);
  if (card.kind === 'code' && testRuleOn && !card.noTests && source && !ownsTestFile(card.owned, cfg.tests.paths)) {
    errors.push(`a code card must own a test file (${cfg.tests.paths.join(', ')}) or give noTests: <why>`);
  }
  if (card.kind === 'code' && card.owned.length && !source) warnings.push('kind code, but it owns no source file: is it a content or test card?');
  if (card.kind === 'test' && !ownsTestFile(card.owned, cfg.tests.paths)) errors.push('a test card must own the test file(s) it adds');
  if (card.kind === 'migration') {
    const risky = cfg.risk?.paths ?? [];
    if (risky.length && !firstOverlap(card.owned, risky)) {
      warnings.push(`a migration card that owns nothing under risk.paths (${risky.join(', ')}): is the migration file listed?`);
    }
  }
  if (card.kind !== 'migration' && card.owned.some(isMigrationPath)) {
    warnings.push(`kind ${card.kind}, but it owns a migration (${card.owned.filter(isMigrationPath).join(', ')}): it still runs one migration at a time; kind migration fits better`);
  }
  if (card.kind === 'content' && card.checks.length === 0 && testRuleOn) {
    warnings.push('a content card with no check: the gate verifies only the scope (a link or spelling check helps)');
  }

  for (const d of card.dependencies) {
    if (selfId && d.toUpperCase() === selfId.toUpperCase()) errors.push('a card cannot depend on itself');
    else if (!byId.has(d.toUpperCase())) errors.push(`dependency ${d} does not exist`);
  }
  if (card.parent && !byId.has(card.parent.toUpperCase())) errors.push(`parent ${card.parent} does not exist`);
  const S = cfg.tracker.status;
  const family = [selfId, card.parent].filter(Boolean).map(x => x.toUpperCase());
  for (const t of tasks) {
    // A closure card shares files with its children: no warning between a card and its parent or children.
    if (family.includes(t.id.toUpperCase()) || (selfId && t.parent?.toUpperCase() === selfId.toUpperCase())) continue;
    if (![S.inProgress, S.inCheck].includes(t.status) || !t.ownedFiles.length) continue;
    const hit = firstOverlap(card.owned, t.ownedFiles);
    if (hit) warnings.push(`overlaps ${t.id} (${t.status}) on ${hit[0]}: it will wait until ${t.id} is done`);
  }
  const flows = Object.keys(cfg.external?.flows ?? {});
  for (const f of card.external) if (flows.length && !flows.includes(f)) warnings.push(`external flow "${f}" is not declared in the config (external.flows: ${flows.join(', ')})`);
  return { errors, warnings };
}

// A card written before kinds existed: a migration folder → migration, only test paths → test, no source code →
// content, otherwise code. Globs are judged by a concrete path they match (app/** → app/x), not by their text.
export function inferKind(owned, cfg) {
  const testPaths = cfg?.tests?.paths ?? [];
  if (!owned.length) return 'code';
  if (owned.some(isMigrationPath)) return 'migration';
  if (testPaths.length && owned.every(g => matchesAny(testPaths, concreteExample(g)))) return 'test';
  return ownsSourceCode(owned, testPaths) ? 'code' : 'content';
}

/** The card as the tracker gave it, back in the JSON shape (for normalise and check). */
export function cardFromTask(task, cfg) {
  const items = String(task.acceptance ?? '').split('\n')
    .map(l => l.match(/^\s*-\s*\[[ xX]\]\s*(?:#\d+\s+)?(.*)$/)?.[1] ?? l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)?.[1])
    .filter(Boolean).map(text);
  return {
    title: task.title ?? '', goal: String(task.description ?? '').trim(), acceptance: items, owned: task.ownedFiles ?? [],
    kind: task.kind || inferKind(task.ownedFiles ?? [], cfg), parent: task.parent ?? null, dependencies: task.dependencies ?? [], checks: task.checks ?? [],
    external: task.external ?? [], noTests: task.noTests ?? null, priority: task.priority || null, labels: task.labels ?? [],
  };
}

/** What the worker or the checker must know about a card's kind and external flows (empty when nothing applies). */
export function cardRules(task, cfg, role = 'worker') {
  const out = [];
  const kind = task.kind || inferKind(task.ownedFiles ?? [], cfg);
  if (kind === 'migration') {
    out.push(role === 'worker'
      ? '- This is a migration card: change only the migration and what it requires; never apply it to a shared or production database yourself (the owner applies it).'
      : '- This is a migration card: check the migration against a local or throwaway database only, never a shared or production one; a FAIL if it was applied to one.');
  }
  for (const f of task.external ?? []) {
    const how = cfg.external?.flows?.[f]?.howToTest;
    const mock = `the project's mock or an intercepted request${how ? ` (${how})` : ''}`;
    out.push(role === 'worker'
      ? `- It touches the external flow "${f}" (a paid or outside service): never call the real service, not even once. Test it with ${mock}; what only the real service can show goes in your report as "MANUAL: ${f} — <what the owner must check>".`
      : `- It touches the external flow "${f}" (a paid or outside service): never call the real service. Verify it with ${mock}; a test or change that would call the real service is a FAIL. List what only the real service can show as "MANUAL: ${f} — <what the owner must check>".`);
  }
  return out.join('\n');
}

export function report(id, { errors, warnings }) {
  return [
    ...errors.map(e => `ERROR ${id}: ${e}`),
    ...warnings.map(w => `WARN  ${id}: ${w}`),
  ];
}
