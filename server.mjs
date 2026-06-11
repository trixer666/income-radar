// income-radar local server: dashboard + JSON API + periodic refresh (localhost only)
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refreshAll } from './fetch.mjs';
import { runHotelChecks, readWatches, writeWatches } from './hotels.mjs';

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

// pojedyncza wiadomosc Telegram (uzywana przez radar i straznika hoteli)
async function tgSend(c, text) {
  if (!c.telegramToken || !c.telegramChatId) return;
  await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: c.telegramChatId, text, disable_web_page_preview: true }),
  }).catch(e => console.error('[telegram]', e.message));
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

// ---------- AUTO-szkice 24/7: serwer sam pisze baze oferty dla swiezych, pasujacych zlecen ----------
// Szablon wypelniany danymi zlecenia; przed wyslaniem wymaga 30 s personalizacji ([SPERSONALIZUJ]).
function autoDraftBody(it) {
  const skills = (it.langs || []).join(', ');
  if (it.source === 'useme') {
    const budzet = it.amountText && it.amountText !== '?' ? ` (widelki ogloszenia: ${it.amountText})` : '';
    return `Dzien dobry,\n\nzajme sie tym: "${it.title}". Robie dokladnie takie rzeczy - automatyzacje, scrapery, boty i panele webowe (Node.js/JavaScript, SQL).\n\nJak pracuje:\n- najpierw doprecyzowuje zakres i podaje stala wycene${budzet}\n- realizacja etapami, podglad postepu na biezaco\n- kod + instrukcja uruchomienia i wsparcie po wdrozeniu\n\nPortfolio: github.com/trixer666 (m.in. income-radar - wlasny system scrapingu i automatyzacji).\n\nPytania:\n1. [SPERSONALIZUJ: 1 konkretne pytanie o zakres z opisu zlecenia]\n2. Jaki termin jest graniczny?\n\nMoge zaczac od razu.\nPozdrawiam, Patryk`;
  }
  return `Hi,\n\nI can deliver "${it.title}". I build exactly this kind of work: automation, scrapers, bots and web dashboards (Node.js/JavaScript${skills ? ', ' + skills : ''}).\n\nHow I work:\n- scope confirmation + fixed quote first\n- staged delivery with progress previews\n- clean code + setup instructions + post-delivery support\n\nPortfolio: github.com/trixer666 (incl. income-radar - my own multi-source scraping/automation system).\n\nQuestions:\n1. [PERSONALIZE: one specific scope question from the brief]\n2. What is your hard deadline?\n\nI can start immediately.\nBest, Patryk`;
}

async function autoDrafts(payload) {
  if (!payload) return;
  const drafts = await readJson(DRAFTS, {});
  const state = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} });
  let added = 0;
  for (const it of payload.items) {
    if (added >= 10) break;
    if (!['useme', 'freelancer'].includes(it.source)) continue;
    if (drafts[it.id] || (state.itemStatus[it.id] || '') !== '') continue;
    const fresh = it.ageDays === null || it.ageDays === undefined || it.ageDays <= 7;
    const fit = (it.skillMatch || 0) >= 1 && it.verdict !== 'crowd';
    if (!fresh || !fit) continue;
    drafts[it.id] = { ts: Date.now(), kind: 'auto', title: it.title, url: it.url, body: autoDraftBody(it) };
    state.itemStatus[it.id] = 'szkic';
    state.statusTs = state.statusTs || {};
    state.statusTs[it.id] = Date.now();
    added++;
  }
  if (added) {
    await writeFile(DRAFTS, JSON.stringify(drafts, null, 1), 'utf8');
    await writeFile(STATE, JSON.stringify(state, null, 1), 'utf8');
    console.log(`[auto-draft] +${added}`);
  }
}

function doRefresh() {
  if (!refreshing) {
    refreshing = refreshAll()
      .then(p => Promise.all([notifyTelegram(p), autoDrafts(p)]))
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
        statusTs: { ...(cur.statusTs || {}), ...(incoming.statusTs || {}) },
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
    if (url.pathname === '/api/watches' && req.method === 'GET') {
      const c = await freshCfg();
      const watches = await readWatches();
      for (const w of watches) w.rebookUrl = c.affiliateWrap ? c.affiliateWrap.replace('{url}', encodeURIComponent(w.url)) : w.url;
      return send(res, 200, watches);
    }
    if (url.pathname === '/api/watches' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { url: wurl, label } = JSON.parse(body || '{}');
      if (!/^https?:\/\//.test(wurl || '')) return send(res, 400, { error: 'zly url' });
      const watches = await readWatches();
      const w = {
        id: 'w' + Date.now(),
        url: wurl,
        label: (label || '').slice(0, 80) || null,
        checkin: (/[?&]checkin=(\d{4}-\d{2}-\d{2})/.exec(wurl) || [])[1] || null,
        checkout: (/[?&]checkout=(\d{4}-\d{2}-\d{2})/.exec(wurl) || [])[1] || null,
        baselinePrice: null, lastPrice: null, minPrice: null, lastAlertPrice: null,
        status: 'new', lastCheck: null, history: [],
        addedAt: Date.now(),
      };
      watches.push(w);
      await writeWatches(watches);
      const c = await freshCfg();
      // pierwszy pomiar od razu - baseline na zywo
      await runHotelChecks(c, { force: true, onlyId: w.id, notify: (t) => tgSend(c, t) });
      return send(res, 200, await readWatches());
    }
    if (url.pathname === '/api/watches/del' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      await writeWatches((await readWatches()).filter(w => w.id !== id));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/watches/check' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      const c = await freshCfg();
      await runHotelChecks(c, { force: true, onlyId: id || null, notify: (t) => tgSend(c, t) });
      return send(res, 200, await readWatches());
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

// straznik hoteli: tykamy co 10 min, realna kadencja per-watch wg hotelCheckMinutes (domyslnie 180)
let hotelBusy = false;
setInterval(async () => {
  if (hotelBusy) return;
  hotelBusy = true;
  try {
    const c = await freshCfg();
    await runHotelChecks(c, { notify: (t) => tgSend(c, t) });
  } catch (e) { console.error('[hotele]', e.message); }
  finally { hotelBusy = false; }
}, 10 * 60 * 1000);
