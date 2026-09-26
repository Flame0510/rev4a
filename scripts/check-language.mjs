#!/usr/bin/env node
/**
 * Fails when Italian words appear in tracked files: the project is 100% English — code,
 * identifiers, comments, docs, UI strings (AGENTS.md §2.1).
 *
 * The word list is deliberately conservative: only words that are **not** English words.
 * `come`, `per`, `non`, `la`, `al` are left out on purpose, they would fire on
 * English text; the list is content words plus unmistakable function words. A line
 * carrying `lang-ok` is skipped, for the legitimate case where the Italian is the point
 * (a fixture, a note about the rule):
 *
 *   // lang-ok: the exact text a user reported
 *
 * It catches Italian *words*, not Italian thinking written in English, and it never
 * translates: the fix is manual. Run by CI on every push to main and every pull request,
 * again by the release workflow before publishing, and available locally as
 * `npm run check:language` (and as a pre-commit hook, `.githooks/pre-commit`).
 *
 * Usage:
 *   node scripts/check-language.mjs            # every tracked file
 *   node scripts/check-language.mjs --staged   # only what is staged (a pre-commit hook)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WORDS = [
  // Content words, where English and Italian cannot be confused.
  'listino', 'prezzo', 'prezzi', 'catalogo', 'modello', 'modelli', 'parametri', 'dimensione',
  'sessione', 'sessioni', 'caricamento', 'schermata', 'impostazioni', 'cronologia', 'velocita',
  'chiudi', 'annulla', 'elimina', 'aggiungi', 'rimuovi', 'salva', 'avvia', 'ferma',
  'errore', 'attenzione', 'conferma', 'avviso', 'messaggio', 'messaggi', 'scheda', 'schede',
  'utente', 'utenti', 'righe', 'tasto', 'tasti', 'finestra', 'finestre', 'valore', 'valori',
  'numero', 'numeri', 'giornata', 'lavoro', 'sotto', 'sopra', 'tra', 'fra', 'senza', 'anche',
  'questo', 'questa', 'questi', 'queste', 'perche', 'quando', 'molto', 'poco', 'deve', 'devono',
  'possono', 'viene', 'vengono', 'fatto', 'fatta', 'gia', 'solo', 'tutti', 'tutte', 'ogni',
  'essere', 'fare', 'dove', 'nuovo', 'nuova', 'vecchio', 'vecchia', 'davvero', 'invece',
  'inoltre', 'quindi', 'della', 'delle', 'degli', 'nella', 'nelle', 'negli', 'dalla', 'dalle',
  'dallo', 'allo', 'alla', 'sul', 'sulla', 'nessuno', 'nessuna', 'adesso', 'subito', 'oggi', 'ieri',
  // Added 2026-09-24, after three lines survived the list above — one of them a UI string
  // ('Include OpenRouter e altri provider…' in the system-health recommendations).
  'compila', 'compilare', 'compilato', 'pubblica', 'pubblico', 'pubblicare', 'pubblicato',
  'altro', 'altra', 'altri', 'altre', 'giorno', 'giorni', 'mese', 'settimana', 'settimane',
  'aggiorna', 'aggiornare', 'aggiornamento', 'aggiornato', 'controllo', 'controlla', 'controllare',
  'verifica', 'verificare', 'esempio', 'esempi', 'funziona', 'funzione', 'funzioni',
  'creare', 'cancella', 'cancellare', 'scarica', 'scaricare', 'usare', 'usato', 'utilizzo',
  'riga', 'parola', 'parole', 'elenco', 'codice', 'chiave', 'chiavi', 'prova', 'risultato',
  'risultati', 'stesso', 'stessa', 'stessi', 'stesse', 'ancora', 'sempre', 'dopo', 'forse',
  'puoi', 'posso', 'siamo', 'abbiamo', 'erano', 'servono', 'vuole', 'vuoi', 'quale', 'quali',
  'disponibile', 'necessario', 'corretto', 'sbagliato', 'mancante', 'vuoto', 'ultimo', 'ultima',
  'italiano', 'italiana', 'italiane', 'inglese', 'pero', 'cosi', 'piu', 'ecco', 'grazie',
  // Added after a later review found UI labels, alert text and a doc line the list above
  // missed (session drawer, lineage and dashboard toolbars, system-health alerts).
  'stato', 'tipo', 'costo', 'costi', 'durata', 'inizio', 'aggiorn', 'azioni', 'recenti',
  'grafo', 'reimposta', 'periodo', 'agenti', 'agente', 'apri', 'soglia', 'coprire',
  'contenuti', 'allinea', 'allineare', 'campioni', 'consecutivi',
];

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json', '.sh', '.yml', '.yaml', '.css', '.html'];
/** Lockfiles: generated, huge, and never the place a word is written by hand. */
const IGNORED = new Set(['package-lock.json', 'scripts/check-language.mjs']);
const MARKER = 'lang-ok';

const staged = process.argv.includes('--staged');
const gitArgs = staged
  ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
  : ['ls-files'];
const files = execFileSync('git', gitArgs, { encoding: 'utf-8' }).split('\n').filter(Boolean);
const pattern = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'i');

const hits = [];
for (const file of files) {
  if (IGNORED.has(file) || !EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    continue; // unreadable or binary
  }
  text.split('\n').forEach((line, index) => {
    if (line.includes(MARKER)) return;
    const match = line.match(pattern);
    if (match) hits.push({ file, line: index + 1, word: match[0].toLowerCase(), text: line.trim().slice(0, 120) });
  });
}

if (hits.length === 0) {
  console.log(`✓ No Italian words in ${files.length} tracked file(s).`);
  process.exit(0);
}

console.error(`✗ ${hits.length} line(s) contain Italian words (the project is 100% English):\n`);
for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  [${hit.word}]  ${hit.text}`);
console.error('\n  Rewrite the line in English, or add `lang-ok` to it when the Italian is the point.');
process.exit(1);
