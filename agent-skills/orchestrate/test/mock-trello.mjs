// A local stand-in for the Trello REST API, for test/e2e-trello.mjs: node test/mock-trello.mjs <state.json>.
// It serves the board in the state file, applies writes to it, and records every request (method, path, whether the
// Authorization header was right, whether a credential appeared in the URL). Prints the port on its first line.
// A card created with "FAIL-CREATE" in its name gets a 500 (all-or-none create); archiving a card whose name has
// "FAIL-ARCHIVE" gets a 500 (an incomplete rollback); board "HTML" answers with a non-JSON page.
import fs from 'node:fs';
import http from 'node:http';

const file = process.argv[2];
const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = s => fs.writeFileSync(file, JSON.stringify(s, null, 2));
const AUTH = 'OAuth oauth_consumer_key="test-key", oauth_token="test-token"'; // secret-ok: test fixture
let nextId = 1000;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; }).on('end', () => {
    const s = load();
    const url = new URL(req.url, 'http://x');
    s.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization === AUTH, leak: /test-key|test-token/.test(req.url) });
    const send = (code, data) => { save(s); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== AUTH) return send(401, { message: 'invalid token' });
    const json = body ? JSON.parse(body) : {};
    let m;
    if (url.pathname.startsWith('/boards/HTML/')) { save(s); res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>maintenance</html>'); }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/boards\/([^/]+)\/lists$/))) {
      return send(200, s.lists.filter(l => url.searchParams.get('filter') !== 'open' || !l.closed).map(({ id, name }) => ({ id, name })));
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/boards\/([^/]+)\/labels$/))) return send(200, s.labels);
    if (req.method === 'GET' && (m = url.pathname.match(/^\/boards\/([^/]+)\/cards\/open$/))) return send(200, s.cards.filter(c => !c.closed));
    if (req.method === 'POST' && url.pathname === '/cards') {
      if (/FAIL-CREATE/.test(json.name)) return send(500, { message: 'server error' });
      const card = {
        id: `c${nextId++}`, idShort: Math.max(0, ...s.cards.map(c => c.idShort)) + 1, shortLink: `L${nextId}`, name: json.name,
        desc: json.desc ?? '', idList: json.idList, idLabels: String(json.idLabels ?? '').split(',').filter(Boolean), pos: 1e6 + nextId, closed: false,
      };
      card.shortUrl = `https://trello.com/c/${card.shortLink}`;
      s.cards.push(card);
      return send(200, card);
    }
    if (req.method === 'PUT' && (m = url.pathname.match(/^\/cards\/([^/]+)$/))) {
      const card = s.cards.find(c => c.id === m[1]);
      if (!card) return send(404, { message: 'no card' });
      if (json.closed && /FAIL-ARCHIVE/.test(card.name)) return send(500, { message: 'server error' });
      for (const k of ['name', 'desc', 'idList', 'closed']) if (k in json) card[k] = json[k];
      if ('idLabels' in json) card.idLabels = String(json.idLabels).split(',').filter(Boolean);
      return send(200, card);
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/cards\/([^/]+)\/actions\/comments$/))) {
      s.comments.push({ card: m[1], text: json.text });
      return send(200, { id: `a${nextId++}` });
    }
    return send(404, { message: `no route ${req.method} ${url.pathname}` });
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
