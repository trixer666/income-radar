// income-radar hotels: straznik rezerwacji
// Pilnuje cen hoteli (Booking i podobne) przez CDP w debug-chrome (port 9333).
// Zero zaleznosci: HTTP endpointy /json/* + wbudowany WebSocket (Node >= 21).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WATCHES = join(ROOT, 'data', 'watches.json');

export async function readWatches() {
  try { return JSON.parse(await readFile(WATCHES, 'utf8')); } catch { return []; }
}

export async function writeWatches(w) {
  await writeFile(WATCHES, JSON.stringify(w, null, 1), 'utf8');
}

async function cdpAvailable(cdpUrl) {
  try { return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}

// W przegladarce: zbierz kandydatow cen (selektory Booking + generyczny fallback po tekscie)
// i zwroc najnizsza sensowna (najtanszy dostepny pokoj = cena do przebookowania).
const PRICE_EXPR = `(() => {
  const nums = [];
  const push = (t) => {
    const m = String(t || '').replace(/[\\u00a0\\u202f\\s]/g, '').match(/(\\d{2,6})(?:[.,]\\d{2})?(?:zl|z\\u0142|PLN)|(?:zl|z\\u0142|PLN)(\\d{2,6})/i);
    if (m) { const v = Number(m[1] || m[2]); if (v >= 50 && v <= 99999) nums.push(v); }
  };
  for (const el of document.querySelectorAll('[data-testid*="price" i], .prco-valign-middle-helper, .bui-price-display__value')) push(el.textContent);
  if (!nums.length) {
    for (const m of document.body.innerText.matchAll(/([\\d\\u00a0\\u202f\\s]{2,9})(?:zl|z\\u0142|PLN)/gi)) push(m[0]);
  }
  return JSON.stringify({ title: document.title.slice(0, 100), min: nums.length ? Math.min(...nums) : null, count: nums.length });
})()`;

// Otwiera karte, czeka na ceny (polling), zamyka karte. Zwraca { ok, price, title } lub { ok:false, error }.
export async function checkPrice(cdpUrl, url) {
  if (!(await cdpAvailable(cdpUrl))) return { ok: false, error: 'chrome-offline' };
  let tab;
  try {
    tab = await (await fetch(`${cdpUrl}/json/new?` + encodeURIComponent(url), { method: 'PUT' })).json();
  } catch (e) { return { ok: false, error: 'tab-open: ' + e.message }; }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws-connect')); });
    let mid = 0;
    const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const cdp = (method, params) => new Promise((res) => {
      const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    });
    let best = null, title = '';
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const r = await cdp('Runtime.evaluate', { expression: PRICE_EXPR, returnByValue: true });
      const v = JSON.parse(r?.result?.result?.value || 'null');
      if (v && v.min) { best = v.min; title = v.title; if (v.count >= 3 || i >= 4) break; }
    }
    if (!best) return { ok: false, error: 'no-price' };
    return { ok: true, price: best, title };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { ws.close(); } catch {}
    fetch(`${cdpUrl}/json/close/${tab.id}`).catch(() => {});
  }
}

// Przebieg po wszystkich watchach. notify(text) -> Telegram. force/onlyId do recznego "sprawdz teraz".
export async function runHotelChecks(cfg, { force = false, onlyId = null, notify = null } = {}) {
  const watches = await readWatches();
  const now = Date.now();
  const interval = (cfg.hotelCheckMinutes ?? 180) * 60e3;
  let changed = false;
  for (const w of watches) {
    if (onlyId && w.id !== onlyId) continue;
    if (w.checkin && new Date(w.checkin + 'T23:59:59') < new Date()) {
      if (w.status !== 'expired') { w.status = 'expired'; changed = true; }
      continue;
    }
    if (!force && w.lastCheck && now - w.lastCheck < interval) continue;
    const res = await checkPrice(cfg.cdpUrl ?? 'http://127.0.0.1:9333', w.url);
    w.lastCheck = Date.now();
    changed = true;
    if (!res.ok) {
      w.status = res.error === 'chrome-offline' ? 'chrome-offline' : 'error';
      w.lastError = res.error;
      if (res.error === 'chrome-offline') break; // bez Chrome nie ma co mielic dalej
      continue;
    }
    w.status = 'active';
    delete w.lastError;
    if (!w.title && res.title) w.title = res.title.replace(/\s*\(aktualne.*$/i, '').slice(0, 90);
    w.lastPrice = res.price;
    if (w.baselinePrice === null || w.baselinePrice === undefined) w.baselinePrice = res.price;
    w.minPrice = Math.min(w.minPrice ?? res.price, res.price);
    (w.history = w.history || []).push({ ts: Date.now(), price: res.price });
    if (w.history.length > 200) w.history = w.history.slice(-200);
    // alert: spadek wzgledem ostatnio alertowanej (albo bazowej) ceny
    const ref = w.lastAlertPrice ?? w.baselinePrice;
    const drop = ref - res.price;
    const dropPct = ref ? (drop / ref) * 100 : 0;
    if (drop >= (cfg.hotelDropMinPLN ?? 30) && dropPct >= (cfg.hotelDropMinPct ?? 5)) {
      w.lastAlertPrice = res.price;
      const link = cfg.affiliateWrap ? cfg.affiliateWrap.replace('{url}', encodeURIComponent(w.url)) : w.url;
      const label = w.label || w.title || 'rezerwacja';
      await notify?.(`🏨 CENA SPADŁA: ${label}\n${ref} zł → ${res.price} zł (−${Math.round(drop)} zł / −${dropPct.toFixed(1)}%)\nPrzebookuj (sprawdź darmowe anulowanie!): ${link}`);
    }
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000)); // ludzkie tempo miedzy hotelami
  }
  if (changed) await writeWatches(watches);
  return watches;
}
