#!/usr/bin/env node
// schema-diff.mjs (--from-image <image> | --from-schema <file>) (--to-image <image> | --to-schema <file>)
//                 [--config <openclaw.json>] [--out <file.md>] [--work <dir>]
//
// Compares the full openclaw.json schema of two releases, read with `openclaw config schema --json`
// from the agent images (local tags such as openclaw-agent-base:2026.9.9; run with no network), or
// from files saved earlier (offline and in tests). Writes schema-diff.md and schema-diff.json:
// every config path removed, retyped, with enum options dropped, or with a new default; paths
// named in FROM that TO accepts only through a generic map, grouped by parent ("12 per-channel keys
// now under a generic map" is one line); and the open objects of TO (`additionalProperties: {}`),
// under which any path is accepted but nothing is checked.
// The keys Rev4a itself writes and reads are checked by rev4a-deps.mjs, from references/deps.json.
//
// With --config (an openclaw.json from a real agent, e.g. a snapshot's file.openclaw-json.raw) it
// also lists the paths that agent sets which the target schema no longer knows, the paths that sit
// under an open object (accepted, not checked), and — with --to-image — runs
// `openclaw config validate --json` on a COPY of that file inside the target image: the file is
// copied in with `docker cp` (a bind mount from the temp folder is empty on Colima and on a
// snap-installed Docker, and validating a missing file is a false pass), with no network. Values
// redacted by snapshot.mjs (`<redacted>`) are listed, and a validation error on one of them is
// reported as "not judged".
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, Untrustworthy, firstJson, flattenSchema, loadSchema, main, run, schemaLookup, workDir, writeReport,
} from './lib.mjs';

const USAGE = `usage: schema-diff.mjs (--from-image <image> | --from-schema <file>) (--to-image <image> | --to-schema <file>) [options]

  --config <file>   an agent's openclaw.json: list the paths TO does not know; validate it in --to-image
  --out <file.md>   report path (default <work>/schema-diff.md); schema-diff.json is written next to it
  --work <dir>      run directory (default $REV4A_UPGRADE_WORK/run or <tmpdir>/rev4a-openclaw-upgrade/run)

Exit: 0 report written; 1 usage/env error; 2 a schema could not be read, or validation could not run.`;
const SPEC = { 'from-image': 'string', 'to-image': 'string', 'from-schema': 'string', 'to-schema': 'string', config: 'string', out: 'string', work: 'string' };

const rootsOf = (list) => list.filter((k) => !list.some((o) => o !== k && (k.startsWith(`${o}.`) || k.startsWith(`${o}[]`))));
const parentOf = (k) => k.replace(/(\.[^.]+|\[\])$/, '');

await main(USAGE, SPEC, async (args) => {
  const fromSrc = args['from-schema'] ? { file: args['from-schema'] } : args['from-image'] ? { image: args['from-image'] } : null;
  const toSrc = args['to-schema'] ? { file: args['to-schema'] } : args['to-image'] ? { image: args['to-image'] } : null;
  if (!fromSrc || !toSrc) throw new UsageError(`a FROM and a TO schema are required\n\n${USAGE}`);
  const label = (s) => s.file ? path.basename(s.file) : s.image;
  const outMd = args.out ? path.resolve(args.out) : path.join(workDir(args), 'schema-diff.md');

  console.error(`reading schemas from ${label(fromSrc)} and ${label(toSrc)} …`);
  const fa = flattenSchema(loadSchema(fromSrc));
  const fb = flattenSchema(loadSchema(toSrc));
  if (fa.size < 50 || fb.size < 50) throw new Untrustworthy(`a schema is suspiciously small (${fa.size} / ${fb.size} paths)`);
  const facts = { from: label(fromSrc), to: label(toSrc), paths: { from: fa.size, to: fb.size } };
  const L = [];
  const out = (s = '') => L.push(s);
  out(`# openclaw.json schema: ${facts.from} → ${facts.to}`);
  out();
  out(`Paths: ${fa.size} → ${fb.size}.`);
  out();

  // Removed: FROM paths TO accepts neither by name nor through a map. Under an open object of TO
  // they are still accepted (unchecked): listed apart, since a free-form object may ignore them.
  const lookB = new Map([...fa.keys()].map((k) => [k, schemaLookup(fb, k)]));
  const removed = [...fa.keys()].filter((k) => lookB.get(k).status === 'missing').sort();
  const intoOpen = [...fa.keys()].filter((k) => lookB.get(k).status === 'open' && !fa.get(k).open).sort();
  const viaMap = [...fa.keys()].filter((k) => !k.includes('<key>') && lookB.get(k).status === 'map').sort();
  facts.removed = rootsOf(removed);
  facts.removedPaths = removed.length;
  facts.intoOpen = rootsOf(intoOpen);
  // Group generalisations by parent: `messages.queue.byChannel.telegram`, `.discord`… → one line.
  const groups = new Map();
  for (const k of rootsOf(viaMap)) { const p = parentOf(k); groups.set(p, [...(groups.get(p) ?? []), k.slice(p.length + 1)]); }
  facts.viaMap = [...groups].map(([parent, keys]) => ({ parent, keys }));

  out(`## Removed paths (${facts.removed.length} subtrees, ${removed.length} paths)`);
  out();
  out(facts.removed.length ? facts.removed.map((k) => `- \`${k}\``).join('\n') : 'None.');
  out();
  out(`## Named in FROM, now only under an open object in TO (${facts.intoOpen.length} subtrees)`);
  out();
  out('Accepted but no longer checked: the key may be ignored. Read each.');
  out();
  out(facts.intoOpen.length ? facts.intoOpen.slice(0, 80).map((k) => `- \`${k}\` (open at \`${lookB.get(k).at}\`)`).join('\n') : 'None.');
  out();
  out(`## Named in FROM, accepted in TO through a generic map (${facts.viaMap.length} parents)`);
  out();
  out('A per-id map replacing named keys is usually harmless: read each.');
  out();
  out(facts.viaMap.length ? facts.viaMap.slice(0, 80).map((g) => g.keys.length > 3 ? `- \`${g.parent}\`: ${g.keys.length} named keys now under a generic map (${g.keys.slice(0, 4).map((k) => `\`${k}\``).join(', ')}…)` : g.keys.map((k) => `- \`${g.parent}.${k}\``).join('\n')).join('\n') : 'None.');
  out();

  facts.changed = [];
  for (const [k, a] of fa) {
    const b = fb.get(k);
    if (!b) continue;
    const typesLost = [...a.types].filter((t) => !b.types.has(t));
    const optionsLost = [...a.enum].filter((e) => !b.enum.has(e));
    const defaultChanged = a.default !== b.default && (a.default !== undefined || b.default !== undefined);
    if (typesLost.length || optionsLost.length || defaultChanged) facts.changed.push({ path: k, typesLost, optionsLost, ...(defaultChanged ? { defaultFrom: a.default ?? null, defaultTo: b.default ?? null } : {}) });
  }
  out(`## Changed paths (${facts.changed.length})`);
  out();
  out('A lost option or type breaks configs that use it; a changed default changes every agent that never set the key.');
  out();
  out(facts.changed.length ? facts.changed.map((c) => `- \`${c.path}\`${c.typesLost.length ? ` types lost: ${c.typesLost.join(', ')};` : ''}${c.optionsLost.length ? ` options lost: ${c.optionsLost.join(', ')};` : ''}${'defaultTo' in c ? ` default ${c.defaultFrom ?? '(none)'} → ${c.defaultTo ?? '(none)'}` : ''}`).join('\n') : 'None.');
  out();

  const added = [...fb.keys()].filter((k) => !fa.has(k));
  const withDefault = added.filter((k) => fb.get(k).default !== undefined);
  facts.added = { subtrees: rootsOf(added).length, paths: added.length, withDefault: withDefault.map((k) => ({ path: k, default: fb.get(k).default })) };
  out(`## Added (${facts.added.subtrees} subtrees, ${added.length} paths; ${withDefault.length} with a default)`);
  out();
  out(withDefault.length ? withDefault.slice(0, 80).map((k) => `- \`${k}\` default ${fb.get(k).default}`).join('\n') : 'No new path carries a default.');
  out();
  facts.openInTo = [...fb].filter(([, v]) => v.open).map(([k]) => k).sort();
  out(`## Open objects in TO (${facts.openInTo.length}): anything below them is accepted and not checked`);
  out();
  out(`<details><summary>list</summary>\n\n${facts.openInTo.map((k) => `- \`${k}\``).join('\n')}\n\n</details>`);
  out();

  if (args.config) {
    const cfgPath = path.resolve(args.config);
    const text = fs.readFileSync(cfgPath, 'utf8');
    const cfg = firstJson(text);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new UsageError(`${cfgPath} holds no JSON object`);
    // Leaf paths the agent sets, in the schema notation (data keys matched through <key>).
    const leaves = new Set(); const redacted = new Set();
    const walk = (v, p) => {
      if (Array.isArray(v)) { if (!v.length) leaves.add(p); v.slice(0, 20).forEach((x) => walk(x, `${p}[]`)); return; }
      if (v && typeof v === 'object') { const e = Object.entries(v); if (!e.length) leaves.add(p); for (const [k, x] of e) walk(x, p ? `${p}.${k}` : k); return; }
      leaves.add(p);
      if (typeof v === 'string' && /<redacted/.test(v)) redacted.add(p);
    };
    walk(cfg, '');
    const status = (map, p) => schemaLookup(map, p).status;
    const unknownInTo = [...leaves].filter((p) => status(fa, p) !== 'missing' && status(fb, p) === 'missing');
    const unchecked = [...leaves].filter((p) => status(fb, p) === 'open');
    const neither = [...leaves].filter((p) => status(fa, p) === 'missing' && status(fb, p) === 'missing');
    facts.config = { file: cfgPath, leaves: leaves.size, unknownInTo, unchecked, unknownInBoth: neither, redacted: [...redacted] };
    out(`## This agent's config against the target schema (${cfgPath})`);
    out();
    out(`Leaf paths set: ${leaves.size}. Known to FROM but not to TO: **${unknownInTo.length}**. Under an open object (accepted, unchecked): ${unchecked.length}. Unknown to both: ${neither.length}.`);
    if (unknownInTo.length) out(unknownInTo.map((p) => `- \`${p}\``).join('\n'));
    if (neither.length) { out(); out(`Unknown to both schemas (plugin config the bare schema lacks, or a key both releases reject): ${neither.map((p) => `\`${p}\``).join(', ')}`); }
    if (unchecked.length) { out(); out(`Accepted without a check: ${unchecked.map((p) => `\`${p}\``).join(', ')}`); }
    if (redacted.size) { out(); out(`Redacted values (a validation error there is not judged): ${[...redacted].map((p) => `\`${p}\``).join(', ')}`); }
    out();

    facts.config.validate = { ran: false };
    if (toSrc.image) {
      out('The validation below runs in a bare container: plugins installed on the agent volume (codex) are missing, so an error about their config can be a false alarm.');
      // create + cp + start: the file is inside the container, whatever the Docker VM shares.
      const create = run('docker', ['create', '--network', 'none', '--entrypoint', 'sh', toSrc.image, '-c',
        'test -s /root/.openclaw/openclaw.json || { echo "openclaw.json missing in the container" >&2; exit 97; }; exec openclaw config validate --json'], { timeoutMs: 120_000 });
      if (create.rc !== 0) throw new Untrustworthy(`docker create ${toSrc.image} failed: ${create.out.slice(-300)}`);
      const cid = create.stdout.trim();
      let v;
      try {
        const tmpDir = fs.mkdtempSync(path.join(path.dirname(outMd), '.schema-config-'));
        try {
          fs.mkdirSync(path.join(tmpDir, '.openclaw'));
          fs.writeFileSync(path.join(tmpDir, '.openclaw', 'openclaw.json'), JSON.stringify(cfg, null, 2));
          const cp = run('docker', ['cp', path.join(tmpDir, '.openclaw'), `${cid}:/root/`], { timeoutMs: 60_000 });
          if (cp.rc !== 0) throw new Untrustworthy(`docker cp into ${cid} failed: ${cp.out.slice(-300)}`);
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
        v = run('docker', ['start', '-a', cid], { timeoutMs: 300_000 });
      } finally { run('docker', ['rm', '-f', cid], { timeoutMs: 60_000 }); }
      if (v.rc === 97) throw new Untrustworthy('the config did not reach the container: validation would check a missing file');
      const answer = firstJson(v.stdout);
      const issues = Array.isArray(answer?.issues ?? answer?.errors) ? (answer.issues ?? answer.errors) : [];
      const issuePath = (i) => (Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''));
      const judged = issues.filter((i) => ![...redacted].some((r) => issuePath(i).replace(/\.\d+/g, '[]') === r || issuePath(i) === r));
      facts.config.validate = { ran: true, image: toSrc.image, rc: v.rc, valid: answer?.valid ?? (v.rc === 0), issues: issues.length, judgedIssues: judged.length, answer: answer ?? v.out.slice(-1500) };
      out();
      out(`\`openclaw config validate --json\` in ${toSrc.image}: rc ${v.rc}, ${issues.length} issue(s), ${judged.length} not on a redacted value`);
      out('```');
      out(JSON.stringify(answer ?? v.out.slice(-1500), null, 2).slice(0, 3000));
      out('```');
    } else {
      out('**Not validated:** pass --to-image to run `openclaw config validate` on this config with the target release.');
    }
    out();
  }

  writeReport(outMd, L.join('\n'), facts);
  return 0;
});
