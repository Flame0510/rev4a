// Tracker adapter for Trello: one board, its open lists are the statuses, one card per task. Same calls as the
// Backlog.md adapter: list, get, setStatus, comment, create, update.
//
// A task's id is <idPrefix>-<idShort> (RDZ-123): Trello's board number, unique and stable (shortLinks are
// case-sensitive and the skill compares ids without case). The card's own fields for the loop live in one block at
// the very end of the description, written and read only by the skill:
//
//   <!-- orch: written by the orchestrate skill, change it with orch card -->
//   ```orch
//   { "kind": "code", "owned": ["app/x/**"], "acceptance": [{ "text": "…", "done": false }], "dependencies": [],
//     "parent": null, "checks": [], "external": [], "noTests": null, "harnesses": [] }
//   ```
//
// The rest of the description is the card's goal. Config (cfg.tracker):
//   { "kind": "trello", "board": "<board id>", "idPrefix": "RDZ", "credentials": "~/.config/trello/config.json",
//     "status": { "todo": "Backlog", "inProgress": "In Progress", "inCheck": "In Progress", "done": "In Review",
//                 "blocked": null },
//     "filter": { "label": "Sito", "mode": "only" | "exclude" },
//     "priority": { "labels": { "P1-Critico": "high", "P2-Normale": "medium", "P3-Minore": "low" },
//                   "create": { "high": "P1-Critico", "medium": "P2-Normale", "low": "P3-Minore" }, "bracket": true } }
// The filter splits one board between two repositories: with "only" this repository works the cards with the label
// (and new cards get it), with "exclude" the cards without it (and a card can never be given it from here).
// Credentials: the file ({ "apiKey"|"key", "token" }) or TRELLO_KEY / TRELLO_TOKEN; sent only in an Authorization
// header, never echoed in an error. TRELLO_API_BASE overrides the API address (the tests point it at a local mock).
import fs from 'node:fs';
import os from 'node:os';
import { httpSync } from '../lib/http-sync.mjs';
import { OrchError } from '../lib/util.mjs';

const BLOCK_NOTE = '<!-- orch: written by the orchestrate skill, change it with orch card -->';
const FENCE = /^<!-- orch: written by the orchestrate skill, change it with orch card -->\n```orch\n([\s\S]*?)\n```[^\S\n]*(?:\n|$)/;
const MAX_DESC = 16384;
const BRACKET = /^\[(P\d)\]\s*/;

export function detect() { return null; } // nothing in a repository says which board: orch init asks

// A credential is a token of printable characters; anything else (a pasted newline, a space) would end up in an
// HTTP library's error text, so it is refused here without echoing the value.
function credentials(tc) {
  const check = (v, what) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (!/^[\x21-\x7e]+$/.test(s)) throw new OrchError(`the Trello ${what} has characters a token cannot have (spaces, line breaks, non-ASCII): fix it where it is stored`);
    return s;
  };
  if (Boolean(process.env.TRELLO_KEY) !== Boolean(process.env.TRELLO_TOKEN)) {
    throw new OrchError('set both TRELLO_KEY and TRELLO_TOKEN, or neither (then the credentials file is used)');
  }
  if (process.env.TRELLO_KEY && process.env.TRELLO_TOKEN) {
    return { key: check(process.env.TRELLO_KEY, 'key (TRELLO_KEY)'), token: check(process.env.TRELLO_TOKEN, 'token (TRELLO_TOKEN)') };
  }
  const file = (tc.credentials || '~/.config/trello/config.json').replace(/^~(?=\/)/, os.homedir());
  if (!fs.existsSync(file)) throw new OrchError(`no Trello credentials: ${file} is missing and TRELLO_KEY/TRELLO_TOKEN are not set`);
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new OrchError(`${file} is not valid JSON`); }
  const key = check(c.apiKey ?? c.key, `key in ${file}`); const token = check(c.token, `token in ${file}`);
  if (!key || !token) throw new OrchError(`${file} needs "apiKey" (or "key") and "token"`);
  return { key, token };
}

// The skill's block is the last occurrence of its exact note line followed by an orch fence. The skill writes it at
// the end; text a person added after it (a note at the bottom of the card) is part of the goal, and the next write
// puts the block back at the end. Any other "<!-- orch: …" comment or orch fence is the person's text.
function parseBlock(desc) {
  const text = String(desc ?? '').replace(/\r\n/g, '\n');
  const at = text.lastIndexOf(BLOCK_NOTE);
  const m = at >= 0 ? text.slice(at).match(FENCE) : null;
  if (!m) return { goal: text.trim(), block: null, error: null };
  const goal = [text.slice(0, at).trim(), text.slice(at + m[0].length).trim()].filter(Boolean).join('\n\n');
  try {
    const block = JSON.parse(m[1]);
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('not an object');
    return { goal, block, error: null };
  } catch (e) {
    return { goal, block: null, error: `the orch block is not valid JSON (${e.message}): fix it on the card, or rewrite it with orch card normalise --from` };
  }
}

const list = v => (Array.isArray(v) ? v.map(String) : []);

export function createTracker(root, tc) {
  if (!tc.board) throw new OrchError('tracker.board is not set (the Trello board id)');
  const prefix = String(tc.idPrefix || 'TR').toUpperCase();
  const API = (process.env.TRELLO_API_BASE || 'https://api.trello.com/1').replace(/\/$/, '');
  let creds = null;
  let cache = null; // one read of the board per command; dropped after every write

  function call(method, p, json) {
    creds ??= credentials(tc);
    const r = httpSync({
      method, url: `${API}${p}`, json, secrets: [creds.key, creds.token],
      headers: { Authorization: `OAuth oauth_consumer_key="${creds.key}", oauth_token="${creds.token}"` }, // secret-ok: header template, the values come from the environment
    });
    const where = `Trello ${method} ${p.split('?')[0]}`;
    if (r.status < 200 || r.status > 299) throw new OrchError(`${where}: ${r.status} ${String(r.text).slice(0, 200)}`);
    if (r.data === null) throw new OrchError(`${where}: the answer is not JSON (a proxy or an outage page?)`);
    return r.data;
  }

  function board() {
    if (cache) return cache;
    const lists = call('GET', `/boards/${tc.board}/lists?filter=open&fields=name`);
    const labels = call('GET', `/boards/${tc.board}/labels?fields=name,color&limit=1000`);
    const cards = call('GET', `/boards/${tc.board}/cards/open?fields=name,desc,idList,idLabels,idShort,shortLink,pos`);
    if (![lists, labels, cards].every(Array.isArray)) throw new OrchError(`Trello board ${tc.board}: unexpected answer (not a list)`);
    cache = { lists, labels, cards, listName: new Map(lists.map(l => [l.id, l.name])), labelName: new Map(labels.map(l => [l.id, l.name])) };
    return cache;
  }

  // Open lists only: a board keeps archived lists with the same names, and a name→id map must not pick one.
  function listId(name) {
    const hits = board().lists.filter(l => l.name === name);
    if (!hits.length) throw new OrchError(`no open list "${name}" on the board (open lists: ${board().lists.map(l => l.name).join(', ')})`);
    if (hits.length > 1) throw new OrchError(`${hits.length} open lists are named "${name}": rename one`);
    return hits[0].id;
  }

  function labelId(name) {
    const hits = board().labels.filter(l => l.name === name);
    if (!hits.length) throw new OrchError(`no label "${name}" on the board (labels: ${board().labels.map(l => l.name).filter(Boolean).join(', ')})`);
    return hits[0].id;
  }

  const priorityOf = name => tc.priority?.labels?.[name] ?? null;
  const isPriorityLabel = name => priorityOf(name) !== null;
  const filterLabel = tc.filter?.label ?? null;
  const excludeMode = filterLabel && tc.filter.mode === 'exclude';
  // [P2] in a name → the priority of the label the config creates for P2, when no priority label says otherwise.
  const bracketPriority = name => {
    const p = name.match(BRACKET)?.[1];
    return p ? Object.entries(tc.priority?.create ?? {}).find(([, l]) => l.startsWith(p))?.[0] ?? null : null;
  };

  function inScope(card) {
    if (!filterLabel) return true;
    const has = card.idLabels.some(id => board().labelName.get(id) === filterLabel);
    return excludeMode ? !has : has;
  }

  function toTask(card) {
    const { goal, block, error } = parseBlock(card.desc);
    const labelNames = card.idLabels.map(id => board().labelName.get(id)).filter(Boolean);
    const b = block ?? {};
    const acceptance = Array.isArray(b.acceptance) ? b.acceptance : [];
    return {
      id: `${prefix}-${card.idShort}`, title: card.name.replace(BRACKET, ''), status: board().listName.get(card.idList) ?? '',
      dependencies: list(b.dependencies), ownedFiles: list(b.owned), checks: list(b.checks), harnesses: list(b.harnesses),
      noTests: b.noTests ? String(b.noTests) : null, parent: b.parent ? String(b.parent) : null,
      priority: ['high', 'medium', 'low'].find(p => labelNames.some(n => priorityOf(n) === p)) ?? bracketPriority(card.name),
      ordinal: Number.isFinite(card.pos) ? card.pos : null,
      kind: b.kind ? String(b.kind) : null, external: list(b.external),
      labels: labelNames.filter(n => !isPriorityLabel(n) && n !== filterLabel),
      blockError: error,
      description: goal,
      acceptance: acceptance.map((a, i) => `- [${a?.done ? 'x' : ' '}] #${i + 1} ${typeof a === 'string' ? a : a?.text ?? ''}`).join('\n'),
      plan: '', cardId: card.id, shortLink: card.shortLink,
    };
  }

  function find(id) {
    const m = String(id).match(new RegExp(`^${prefix.replace(/[^A-Z0-9]/g, c => `\\${c}`)}-(\\d+)$`, 'i'));
    // A card outside the filter belongs to the other repository: not found here, so it cannot be started from here.
    const card = m && board().cards.find(c => c.idShort === Number(m[1]) && inScope(c));
    if (!card) throw new OrchError(`task ${id} not found on the board${filterLabel ? ` for this repository (${excludeMode ? 'without' : 'with'} label "${filterLabel}")` : ''} (ids look like ${prefix}-123)`);
    return card;
  }

  function renderDesc(card, { ticked = new Set(), harnesses = [] } = {}) {
    const block = {
      kind: card.kind, owned: card.owned, acceptance: card.acceptance.map(t => ({ text: t, done: ticked.has(t) })),
      dependencies: card.dependencies, parent: card.parent, checks: card.checks, external: card.external, noTests: card.noTests,
      ...(harnesses.length ? { harnesses } : {}),
    };
    const desc = `${card.goal}\n\n${BLOCK_NOTE}\n\`\`\`orch\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
    if (desc.length > MAX_DESC) throw new OrchError(`the card description would be ${desc.length} characters; Trello allows ${MAX_DESC}`);
    return desc;
  }

  // The [Pn] bracket follows the priority when the config writes brackets; otherwise a name keeps the bracket it has.
  function cardName(card, currentName = '') {
    const p = tc.priority?.create?.[card.priority]?.match(/^(P\d)/)?.[1];
    const kept = currentName.match(BRACKET)?.[0] ?? '';
    if (p && (tc.priority?.bracket || kept)) return `[${p}] ${card.title}`; // an existing bracket never contradicts the label
    return `${kept}${card.title}`;
  }

  // Labels for a card: the ones nobody manages here stay (unnamed color labels, the filter label), the priority label
  // follows card.priority (unchanged when the card has none), the named ones follow card.labels.
  function labelIds(card, current = []) {
    if (excludeMode && card.labels.includes(filterLabel)) {
      throw new OrchError(`label "${filterLabel}" moves a card to the other repository: this one works the cards without it`);
    }
    const name = id => board().labelName.get(id);
    const ids = current.filter(id => !name(id) || name(id) === filterLabel || (!card.priority && isPriorityLabel(name(id))));
    const pLabel = tc.priority?.create?.[card.priority];
    if (pLabel) ids.push(labelId(pLabel));
    for (const n of card.labels) if (n !== filterLabel) ids.push(labelId(n));
    if (filterLabel && !excludeMode) ids.push(labelId(filterLabel));
    return [...new Set(ids)];
  }

  return {
    kind: 'trello',
    statuses() { return board().lists.map(l => l.name); },
    list() { return board().cards.filter(inScope).map(toTask).map(({ description, acceptance, plan, ...t }) => t); },
    get(id) { return toTask(find(id)); },
    setStatus(id, status) {
      if (!status) return; // a status the board has no list for (e.g. blocked: null) is a comment only
      const card = find(id);
      const target = listId(status);
      if (card.idList === target) return;
      call('PUT', `/cards/${card.id}`, { idList: target });
      cache = null;
    },
    comment(id, line) {
      const clean = String(line).replace(/\s+/g, ' ').trim().slice(0, 1000);
      call('POST', `/cards/${find(id).id}/actions/comments`, { text: `orch: ${clean}` });
    },
    // All or none: lists, labels and descriptions are prepared for every card before the first write; when a create
    // fails, the cards this call made are archived (never deleted), and the message says exactly what is left.
    create(cards, status) {
      const planned = cards.map(card => ({ idList: listId(status), name: cardName(card), desc: renderDesc(card), idLabels: labelIds(card).join(',') }));
      const made = [];
      try {
        for (const p of planned) made.push(call('POST', '/cards', { ...p, pos: 'bottom' }));
      } catch (e) {
        const left = [];
        for (const c of made) { try { call('PUT', `/cards/${c.id}`, { closed: true }); } catch { left.push(`${prefix}-${c.idShort}`); } }
        cache = null;
        const archived = made.length - left.length;
        throw new OrchError(`creating the cards failed (${e.message}); `
          + `${made.length ? `archived ${archived} of the ${made.length} made before it` : 'none was made'}`
          + `${left.length ? `; still open, archive them by hand: ${left.join(', ')}` : ''}`
          + `${/timed out/.test(e.message) ? '; a request that timed out may still have made its card: check the board' : ''}`);
      }
      cache = null;
      return made.map(c => ({ id: `${prefix}-${c.idShort}`, file: c.shortUrl ?? `https://trello.com/c/${c.shortLink}` }));
    },
    update(id, card) {
      const current = find(id);
      const { block: old, error } = parseBlock(current.desc);
      if (error) process.stderr.write(`orch: ${prefix}-${current.idShort}: replacing an orch block that was not valid JSON\n`);
      const ticked = new Set((Array.isArray(old?.acceptance) ? old.acceptance : []).filter(a => a?.done).map(a => a.text));
      call('PUT', `/cards/${current.id}`, {
        name: cardName(card, current.name), desc: renderDesc(card, { ticked, harnesses: list(old?.harnesses) }),
        idLabels: labelIds(card, current.idLabels).join(','),
      });
      cache = null;
    },
  };
}
