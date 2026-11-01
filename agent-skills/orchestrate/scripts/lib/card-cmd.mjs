// orch card — cards are created and changed only through here, in the skill's format (lib/card.mjs).
//   orch card new --from <card.json> [--dry-run]          validate, then create one card (status todo)
//   orch card split <id> --from <cards.json> [--dry-run]  validate all, then create them as children of <id>
//   orch card check <id>                                  what the card lacks for the loop (exit 2 on errors)
//   orch card normalise <id> [--from <card.json>]         without --from: the card as JSON plus what it lacks;
//                                                         with --from: validate, then rewrite the card's own fields
// The coordinator writes the JSON (content); the script owns the format and refuses what the loop could not work.
import fs from 'node:fs';
import { cardFromInput, cardFromTask, report, validateCard } from './card.mjs';
import { git, OrchError, readJson } from './util.mjs';

function readInput(file) {
  if (!file || file === true) throw new OrchError('needs --from <file.json> (the card written by the coordinator)');
  if (!fs.existsSync(file)) throw new OrchError(`no file ${file}`);
  return readJson(file);
}

export async function cmdCard(root, { pos, flags }, { cfg, tracker, out }) {
  const [sub, id] = pos;
  const tracked = git(['ls-files'], root).split('\n').filter(Boolean);
  const tasks = tracker.list();
  const ctx = { cfg, tracked, tasks };
  const dry = flags['dry-run'] === true;

  if (sub === 'new' || sub === 'split') {
    if (sub === 'split' && !id) throw new OrchError('orch card split <id> --from <cards.json>');
    if (sub === 'split' && !tasks.some(t => t.id.toUpperCase() === id.toUpperCase())) throw new OrchError(`no card ${id}`);
    const raw = readInput(flags.from);
    const inputs = sub === 'split' ? (Array.isArray(raw) ? raw : [raw]) : [raw];
    if (sub === 'new' && Array.isArray(raw)) throw new OrchError('orch card new takes one card; several cards of one parent: orch card split <parent>');
    if (sub === 'split' && inputs.length < 2) throw new OrchError('a split makes at least two cards');
    const cards = inputs.map(i => cardFromInput(sub === 'split' ? { ...i, parent: id } : i));
    const lines = []; let errors = 0;
    cards.forEach((c, i) => {
      const r = validateCard(c, ctx);
      errors += r.errors.length;
      lines.push(...report(`card ${i + 1} "${c.title.slice(0, 50)}"`, r));
    });
    // Cards of one split must not overlap each other: they could not run side by side.
    if (sub === 'split') {
      const { firstOverlap } = await import('./glob.mjs');
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
        const hit = firstOverlap(cards[i].owned, cards[j].owned);
        if (hit) lines.push(`WARN  cards ${i + 1} and ${j + 1} overlap (${hit[0]} / ${hit[1]}): they will run one after the other`);
      }
    }
    if (errors) {
      out(...lines, `nothing written: ${errors} error(s)`, 'next: fix the JSON and run the same command again');
      process.exitCode = 2; return;
    }
    if (dry) { out(...lines, `valid: ${cards.length} card(s), nothing written (--dry-run)`); return; }
    const made = tracker.create(cards, cfg.tracker.status.todo);
    out(...lines, ...made.map(m => `created ${m.id}: ${m.file}`), 'next: orch next');
    return;
  }

  if (sub === 'check' || sub === 'normalise') {
    if (!id) throw new OrchError(`orch card ${sub} <id>`);
    const task = tracker.get(id);
    if (sub === 'normalise' && flags.from) {
      const card = cardFromInput(readInput(flags.from));
      const r = validateCard(card, { ...ctx, selfId: task.id });
      if (r.errors.length) { out(...report(task.id, r), 'nothing written', 'next: fix the JSON and run the same command again'); process.exitCode = 2; return; }
      if (dry) { out(...report(task.id, r), `valid, nothing written (--dry-run)`); return; }
      tracker.update(task.id, card);
      out(...report(task.id, r), `updated ${task.id} in the card format`, 'next: orch card check ' + task.id);
      return;
    }
    const card = cardFromTask(task, cfg);
    const r = validateCard(card, { ...ctx, selfId: task.id });
    if (task.blockError) r.errors.unshift(`${task.blockError} (the fields below are empty because it could not be read)`);
    if (sub === 'check') {
      out(...report(task.id, r), r.errors.length ? `${task.id}: ${r.errors.length} error(s)` : `${task.id}: ok`,
        r.errors.length ? `next: orch card normalise ${task.id} (fill what is missing)` : null);
      process.exitCode = r.errors.length ? 2 : 0;
      return;
    }
    out(JSON.stringify(card, null, 2), ...report(task.id, r),
      `next: write this JSON to a file with what is missing filled in, then: orch card normalise ${task.id} --from <file>`);
    return;
  }
  throw new OrchError('orch card new|split|check|normalise (see SKILL.md, "Cards")');
}
