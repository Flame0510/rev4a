'use strict';

const { dirname, resolve } = require('node:path');

function tokenize(text) {
  const tokens = [];
  // Quoted arguments, comments, and placeholders stay opaque to the block scanner.
  const pattern = /#[^\r\n]*|"(?:[^"\\]|\\[\s\S])*"|`[^`]*`|[^\s"]+/g;
  for (let match; (match = pattern.exec(text)); ) {
    const value = match[0];
    if (value.startsWith('#')) continue;
    if (/^<<[\w-]+$/.test(value)) {
      const marker = value.slice(2);
      const tail = text.slice(match.index + value.length);
      const end = new RegExp(`\\r?\\n[ \\t]*${marker}(?=\\r?\\n|$)`).exec(tail);
      if (!end) throw new Error('The main Caddyfile has an unterminated heredoc.');
      pattern.lastIndex = match.index + value.length + end.index + end[0].length;
      tokens.push({ value: '<heredoc>', start: match.index, end: pattern.lastIndex });
      continue;
    }
    const quoted = value.startsWith('"') || value.startsWith('`');
    tokens.push({ value: quoted ? value.slice(1, -1) : value, start: match.index, end: match.index + value.length,
      brace: !quoted && (value === '{' || value === '}') });
  }
  return tokens;
}

function sameLine(text, a, b) {
  return !/[\r\n]/.test(text.slice(a.end, b.start));
}

/** Inspect only top-level blocks/imports. Keep all original source slices for the actual edit. */
function scanCaddyfile(text, { requireBlocks = false } = {}) {
  const tokens = tokenize(text);
  const blocks = [];
  const imports = [];
  let header = [];
  let depth = 0;
  let open = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.brace && token.value === '{') {
      if (depth++ === 0) open = i;
    } else if (token.brace && token.value === '}') {
      if (--depth < 0) throw new Error('The main Caddyfile has an unmatched closing brace.');
      if (depth === 0) {
        blocks.push({ header, open: tokens[open], close: token, body: tokens.slice(open + 1, i) });
        header = [];
      }
    } else if (depth === 0) {
      if (!header.length && token.value === 'import') {
        const target = tokens[i + 1];
        if (target && sameLine(text, token, target)) imports.push(target.value);
        while (tokens[i + 1] && sameLine(text, token, tokens[i + 1])) i++;
      } else {
        header.push(token);
      }
    }
  }
  if (depth) throw new Error('The main Caddyfile has an unclosed block.');
  if (requireBlocks && header.length) throw new Error('Wrap existing Caddy sites in braces before running domain setup.');
  return { blocks, imports };
}

function onDemandOptions(text, global) {
  const body = global?.body ?? [];
  let depth = 0;
  let options;
  for (let i = 0; i < body.length; i++) {
    const token = body[i];
    if (token.brace) {
      depth += token.value === '{' ? 1 : -1;
    } else if (depth === 0 && token.value === 'on_demand_tls' && (i === 0 || !sameLine(text, body[i - 1], token))) {
      const start = body[i + 1];
      if (options || !start?.brace || start.value !== '{') throw new Error('Use one braced on_demand_tls global option.');
      options = { start };
    } else if (depth === 1 && options && (token.value === 'ask' || token.value === 'permission')) {
      // Only collect directives belonging to the on_demand_tls block.
      if (options.closed) continue;
      if (token.value === 'permission') {
        options.permission = true;
        continue;
      }
      const target = body[i + 1];
      if (options.ask || !target || target.brace || !sameLine(text, token, target)) {
        throw new Error('Caddy has an ambiguous on-demand TLS ask directive.');
      }
      options.ask = target;
      i++;
    }
    if (options && depth === 0 && token.brace && token.value === '}') options.closed = true;
  }
  return options;
}

const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Caddy uses Go's filepath.Glob. Match one path segment at a time, including its character classes. */
function matchesSegment(pattern, value) {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i - 1] !== '*') regex += '.*';
    } else if (char === '?') {
      regex += '.';
    } else if (char === '[') {
      const start = ++i;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++;
        i++;
      }
      const group = pattern.slice(start, i);
      if (i === pattern.length || !group || group === '^') return false;
      regex += '[' + group + ']';
    } else if (char === '\\') {
      if (++i === pattern.length) return false;
      regex += literal(pattern[i]);
    } else {
      regex += literal(char);
    }
  }
  try { return new RegExp(`^${regex}$`, 'u').test(value); }
  catch { return false; }
}

function hasCaddyImport(imports, { main, file }) {
  const target = file.split('/');
  return imports.some(pattern => {
    const absolute = resolve(dirname(main), pattern);
    if (absolute === file) return true;
    if (!/[?*\[]/.test(pattern)) return false;
    const parts = absolute.split('/');
    if (parts.at(-1).startsWith('*') && target.at(-1).startsWith('.')) return false;
    return parts.length === target.length && parts.every((part, index) => matchesSegment(part, target[index]));
  });
}

module.exports = { hasCaddyImport, onDemandOptions, scanCaddyfile };
