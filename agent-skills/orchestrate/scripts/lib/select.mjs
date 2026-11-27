// Which tasks can start now. A task is eligible when it is in the "todo" status, every dependency is done,
// it lists its owned files, it does not own most of the repository, and none of its owned files may overlap
// a task already in progress or in check. Advice (no test file owned, nothing verifies it) does not block.
import { firstOverlap, matchesAny } from './glob.mjs';
import { isMigrationPath, readiness } from './harness.mjs';

const RANK = { high: 0, medium: 1, low: 2 };
// A card that is or carries a migration (its kind, or a migration file it owns) never runs beside another one.
const isMigration = t => t.kind === 'migration' || t.ownedFiles.some(isMigrationPath);
const num = id => Number(String(id).match(/(\d+)$/)?.[1] ?? Infinity);

export function ownedShare(globs, tracked) {
  if (!tracked.length || !globs.length) return 0;
  return tracked.filter(f => matchesAny(globs, f)).length / tracked.length;
}

// Whether card c depends on the card `target` (upper case), directly or through its dependencies.
function waitsFor(c, target, byId, seen = new Set()) {
  for (const d of c.dependencies) {
    const k = String(d).toUpperCase();
    if (k === target) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    const dep = byId.get(k);
    if (dep && waitsFor(dep, target, byId, seen)) return true;
  }
  return false;
}

export function evaluate(tasks, cfg, tracked) {
  const S = cfg.tracker.status;
  const byId = new Map(tasks.map(t => [t.id.toUpperCase(), t]));
  const active = tasks.filter(t => t.status === S.inProgress || t.status === S.inCheck);
  return tasks
    .filter(t => t.status === S.todo)
    .map(t => {
      const reasons = [];
      for (const d of t.dependencies) {
        const dep = byId.get(String(d).toUpperCase());
        if (!dep) reasons.push(`dependency ${d} not found`);
        else if (dep.status !== S.done) reasons.push(`waits for ${dep.id} (${dep.status})`);
      }
      // A split card closes its children: it starts only when they are all done.
      // (a child that itself waits for the parent, directly or through other cards, is not counted: neither could start)
      const open = tasks.filter(c => c.parent && c.parent.toUpperCase() === t.id.toUpperCase() && c.status !== S.done
        && !waitsFor(c, t.id.toUpperCase(), byId));
      if (open.length) reasons.push(`closes its split cards, still open: ${open.map(c => `${c.id} (${c.status})`).join(', ')}`);
      if (t.blockError) reasons.push(t.blockError);
      else if (!t.ownedFiles.length) reasons.push('no modified_files: list the files it may change');
      else {
        const share = ownedShare(t.ownedFiles, tracked);
        if (share > cfg.limits.maxOwnedShare) reasons.push(`too broad: owns ${Math.round(share * 100)}% of the tracked files, split it`);
        for (const a of active) {
          if (!a.ownedFiles.length) { reasons.push(`${a.id} is ${a.status} without modified_files (may touch anything)`); continue; }
          const hit = firstOverlap(t.ownedFiles, a.ownedFiles);
          if (hit) reasons.push(`overlaps ${a.id} (${a.status}): ${hit[0]} / ${hit[1]}`);
        }
      }
      if (isMigration(t)) for (const a of active.filter(isMigration)) reasons.push(`migration cards run one at a time: ${a.id} is ${a.status}`);
      return { task: t, reasons, advice: readiness(cfg, t) };
    })
    .sort((x, y) => (RANK[x.task.priority] ?? 3) - (RANK[y.task.priority] ?? 3)
      || (x.task.ordinal ?? Infinity) - (y.task.ordinal ?? Infinity)
      || num(x.task.id) - num(y.task.id));
}
