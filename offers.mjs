// income-radar offers: silnik skladania ofert na Useme przez CDP (debug-chrome, port 9333).
// Koduje wiedze zdobyta w boju: min 7 dni roboczych, usuniecie nadmiarowych etapow,
// przeniesienie praw (protocol), opis przez Input.insertText (trusted - edytor go przyjmuje).
// Zero zaleznosci: HTTP /json/* + wbudowany WebSocket (Node >= 21). Brama: wysyla TYLKO
// pozycje, ktore uzytkownik zatwierdzil statusem 'do-wyslania' (chyba ze podano jobId wprost).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DRAFTS = join(ROOT, 'data', 'drafts.json');
const STATE = join(ROOT, 'data', 'state.json');
const MIN_DAYS = 7; // Useme: minimum 7 dni roboczych - ponizej walidator odrzuca

async function cdpAvailable(cdpUrl) {
  try { return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}

// Wypelnia pola formularza oferty: prawa autorskie, payment, work_days (clamp >=7),
// usuwa nadmiarowe etapy (zostawia 1), wypelnia etap-0. Zwraca diag.
function fillExpr(o) {
  const days = Math.max(MIN_DAYS, Number(o.days) || MIN_DAYS);
  const pay = String(o.pay);
  const name = JSON.stringify(o.name).slice(1, -1);
  return `(() => {
    const react = (sel, val) => {
      const el = document.querySelector(sel); if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const last = el.value;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      if (el._valueTracker) el._valueTracker.setValue(last === val ? '_' + val : last);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    };
    // usun nadmiarowe etapy (zostaw 1)
    for (let k = 0; k < 6; k++) {
      const b = [...document.querySelectorAll('button,a,[role=button]')].filter(x => /^usu/i.test((x.textContent || '').trim()));
      if (!b.length) break; b[b.length - 1].click();
    }
    document.querySelector('input[name="copyright_transfer"][value="protocol"]')?.click();
    document.querySelector('input[name="stages-0-copyright_transfer"][value="protocol"]')?.click();
    react('[name="payment"]', '${pay}');
    react('[name="work_days"]', '${days}');
    react('#id_work_days', '${days}');
    react('#id_stages-0-name', '${name}');
    react('#id_stages-0-payment', '${pay}');
    react('#id_stages-0-work_days', '${days}');
    return JSON.stringify({ wd: document.querySelector('#id_work_days')?.value, pay: document.querySelector('[name="payment"]')?.value });
  })()`;
}

const FOCUS_EDITOR = `(() => {
  const ed = document.querySelector('[contenteditable=true]');
  if (!ed) return 'no-editor';
  ed.focus();
  const sel = window.getSelection(), r = document.createRange();
  r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  return ed.textContent.length;
})()`;

const CLICK_NEXT = `(() => { const b = [...document.querySelectorAll('button,input[type=submit]')].find(x => /Przejd. do podsumowania/i.test((x.textContent || x.value || ''))); if (!b) return 'no-btn'; b.scrollIntoView({block:'center'}); b.click(); return 'clicked'; })()`;
const CLICK_SEND = `(() => { const b = [...document.querySelectorAll('button,input[type=submit]')].find(x => /^Wy.lij$/i.test((x.textContent || x.value || '').trim())); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`;

// Sklada (lub w dryRun: przygotowuje do podsumowania) ofertę na zlecenie jobId.
// o = { pay, days, name, desc, demo }. Zwraca { ok, sent, stage, error }.
export async function submitOffer(cdpUrl, jobId, o, { dryRun = false } = {}) {
  if (!(await cdpAvailable(cdpUrl))) return { ok: false, error: 'chrome-offline' };
  const url = `https://useme.com/pl/jobs/${jobId}/offer/start/`;
  let tab;
  try { tab = await (await fetch(`${cdpUrl}/json/new?` + encodeURIComponent(url), { method: 'PUT' })).json(); }
  catch (e) { return { ok: false, error: 'tab-open: ' + e.message }; }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws-connect')); });
    let mid = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const cdp = (method, params) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evalJs = async (expr) => JSON.parse((await cdp('Runtime.evaluate', { expression: `JSON.stringify(${expr})`, returnByValue: true }))?.result?.result?.value || 'null');
    const loc = async () => (await cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.result?.value || '';

    await new Promise(r => setTimeout(r, 3500));
    // brama profilu
    const gated = (await cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }))?.result?.result?.value || '';
    if (/tylko freelancerzy|Uzupe.nij O mnie/i.test(gated)) return { ok: false, error: 'profil-niekompletny' };

    // wypelnij pola (3x dla pewnosci React)
    const desc = o.demo ? `${o.desc}\n\nDemo na zywo: ${o.demo}` : o.desc;
    for (let i = 0; i < 2; i++) { await cdp('Runtime.evaluate', { expression: fillExpr(o) }); await new Promise(r => setTimeout(r, 300)); }
    // opis: focus edytora + trusted insert (omija blokade syntetycznych eventow)
    await cdp('Runtime.evaluate', { expression: FOCUS_EDITOR });
    await cdp('Input.insertText', { text: desc });
    await new Promise(r => setTimeout(r, 400));
    await cdp('Runtime.evaluate', { expression: fillExpr(o) }); // ponow pola na wypadek re-renderu

    // do podsumowania (retry)
    let onSummary = false;
    for (let i = 0; i < 3; i++) { await cdp('Runtime.evaluate', { expression: CLICK_NEXT }); await new Promise(r => setTimeout(r, 3500)); if (/summary/.test(await loc())) { onSummary = true; break; } }
    if (!onSummary) {
      const errs = await evalJs(`[...document.querySelectorAll('[aria-invalid=true],.errorlist li')].map(x=>x.name||x.id||x.textContent.trim()).slice(0,5)`);
      return { ok: false, stage: 'fill', error: 'brak-podsumowania', errs };
    }
    if (dryRun) return { ok: true, sent: false, stage: 'summary-dry' };
    await cdp('Runtime.evaluate', { expression: CLICK_SEND });
    await new Promise(r => setTimeout(r, 4000));
    const sent = /finish/.test(await loc());
    return { ok: sent, sent, stage: sent ? 'finish' : 'send-failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { ws.close(); } catch {}
    fetch(`${cdpUrl}/json/close/${tab.id}`).catch(() => {});
  }
}

const jobIdFromUrl = (u) => (/\/jobs\/[^,]+,(\d+)\//.exec(u || '') || [])[1] || (/\/jobs\/(\d+)\//.exec(u || '') || [])[1] || null;

// Przetwarza kolejke: pozycje (drafts) ze statusem 'do-wyslania'. notify -> Telegram.
// onlyJobId wymusza pojedyncza pozycje (pomija brame statusu). dryRun -> bez wyslania.
export async function runOfferQueue(cfg, items, { dryRun = false, onlyJobId = null, notify = null } = {}) {
  const cdpUrl = cfg.cdpUrl ?? 'http://127.0.0.1:9333';
  const drafts = JSON.parse(await readFile(DRAFTS, 'utf8').catch(() => '{}'));
  const state = JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));
  state.itemStatus = state.itemStatus || {}; state.statusTs = state.statusTs || {};
  const byId = new Map(items.map(i => [i.id, i]));
  const results = [];
  for (const [itemId, d] of Object.entries(drafts)) {
    const it = byId.get(itemId);
    if (!it || it.source !== 'useme') continue;
    const jobId = jobIdFromUrl(it.url);
    if (!jobId) continue;
    if (onlyJobId) { if (jobId !== String(onlyJobId)) continue; }
    else if ((state.itemStatus[itemId] || '') !== 'do-wyslania') continue;
    const o = {
      pay: d.payment || it.amountUSD || 1000,
      days: d.days || MIN_DAYS,
      name: (d.title || it.title || 'Oferta').slice(0, 80),
      desc: d.body || '',
      demo: d.demo || null,
    };
    const r = await submitOffer(cdpUrl, jobId, o, { dryRun });
    results.push({ jobId, ...r });
    if (r.sent && !dryRun) {
      state.itemStatus[itemId] = 'wyslane'; state.statusTs[itemId] = Date.now();
      await notify?.(`📨 Oferta wyslana: ${o.name} (${o.pay} zl)\n${it.url}`);
    } else if (r.error === 'chrome-offline') break;
    await new Promise(r => setTimeout(r, 2500));
  }
  if (!dryRun) await writeFile(STATE, JSON.stringify(state, null, 1), 'utf8');
  return results;
}
