// income-radar local server: dashboard + JSON API + periodic refresh (localhost only)
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refreshAll } from './fetch.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));

const ITEMS = join(ROOT, 'data', 'items.json');
const STATE = join(ROOT, 'data', 'state.json');
const DRAFTS = join(ROOT, 'data', 'drafts.json');

let refreshing = null;
let lastIds = null;

// swiezy config bez restartu (token Telegrama mozna dopisac w locie)
async function freshCfg() {
  try { return JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8')); } catch { return cfg; }
}

// powiadomienia Telegram o swiezych okazjach (dziala przy zamknietej przegladarce)
async function notifyTelegram(payload) {
  const c = await freshCfg();
  if (!c.telegramToken || !c.telegramChatId || !payload) return;
  const ids = new Set(payload.items.map(i => i.id));
  if (lastIds) {
    const fresh = payload.items.filter(i => !lastIds.has(i.id)
      && (i.verdict === 'hot' || (i.verdict === 'ok' && (i.amountUSD || 0) >= 100) || (i.skillMatch || 0) >= 2));
    for (const it of fresh.slice(0, 5)) {
      await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.telegramChatId, text: `${it.amountText} · ${it.source}\n${it.title}\n${it.url}`, disable_web_page_preview: true }),
      }).catch(e => console.error('[telegram]', e.message));
    }
  }
  lastIds = ids;
}

function doRefresh() {
  if (!refreshing) {
    refreshing = refreshAll()
      .then(p => notifyTelegram(p))
      .catch(e => console.error('[refresh]', e.message))
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

function send(res, code, body, type = 'application/json') {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, await readFile(join(ROOT, 'public', 'index.html')), 'text/html');
    }
    if (url.pathname === '/api/items') {
      const data = await readJson(ITEMS, { updatedAt: 0, counts: {}, items: [] });
      const c = await freshCfg();
      data.tg = !!(c.telegramToken && c.telegramChatId);
      return send(res, 200, data);
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} }));
    }
    if (url.pathname === '/api/state' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const incoming = JSON.parse(body || '{}');
      const cur = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} });
      const next = {
        itemStatus: { ...cur.itemStatus, ...(incoming.itemStatus || {}) },
        accounts: { ...cur.accounts, ...(incoming.accounts || {}) },
        ledger: { ...(cur.ledger || {}), ...(incoming.ledger || {}) },
      };
      for (const [k, v] of Object.entries(next.itemStatus)) if (v === null || v === '') delete next.itemStatus[k];
      for (const [k, v] of Object.entries(next.ledger)) if (v === null) delete next.ledger[k];
      await writeFile(STATE, JSON.stringify(next, null, 1), 'utf8');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/drafts' && req.method === 'GET') {
      return send(res, 200, await readJson(DRAFTS, {}));
    }
    if (url.pathname === '/api/drafts' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const incoming = JSON.parse(body || '{}');
      const cur = await readJson(DRAFTS, {});
      const next = { ...cur, ...incoming };
      for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
      await writeFile(DRAFTS, JSON.stringify(next, null, 1), 'utf8');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      await doRefresh();
      return send(res, 200, await readJson(ITEMS, { items: [] }));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`income-radar: http://127.0.0.1:${cfg.port} (odswiezanie co ${cfg.refreshMinutes} min)`);
});

doRefresh();
setInterval(doRefresh, Math.max(2, cfg.refreshMinutes) * 60 * 1000);
