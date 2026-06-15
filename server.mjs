// income-radar local server: dashboard + JSON API + periodic refresh (localhost only)
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refreshAll } from './fetch.mjs';
import { runHotelChecks, readWatches, writeWatches } from './hotels.mjs';
import { runOfferQueue } from './offers.mjs';
import { generateOfferDraft, generateBountyAnalysis, personalizeTemplate } from './llm.mjs';
import { loadOutreach, saveOutreach, addLead, generateOutreachDraft, bulkGenerateDrafts, getOutreachStats, scrapeLocalBusinesses } from './outreach.mjs';
import { loadContent, saveContent, generatePost, generateContentCalendar, generateBatchPosts, getContentIdeas, getContentStats } from './content.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));

const ITEMS = join(ROOT, 'data', 'items.json');
const STATE = join(ROOT, 'data', 'state.json');
const DRAFTS = join(ROOT, 'data', 'drafts.json');
const QUEUE = join(ROOT, 'data', 'queue.json');
const WINRATES = join(ROOT, 'data', 'winrates.json');
const STREAMS = join(ROOT, 'data', 'streams.json');
const OUTREACH_FILE = join(ROOT, 'data', 'outreach.json');

// Maksymalny realistyczny pulap miesieczny per strumien (USD). Sluzy do liczenia
// totalPotential w /api/stats - sumujemy pulapy tylko strumieni o statusie 'active'.
// Liczby ostrozne: median z research_ai_automated_earning, nie cherry-pick.
const STREAM_POTENTIAL = {
  freelance: 5000,
  bounty: 3000,
  hackathons: 5000,
  upwork: 6000,
  airdrops: 2000,
  bugbounty: 8000,
  fiverr: 2000,
  outreach: 4000,
  content: 1500,
  microsaas: 10000,
  telegram: 1000,
  voiceover: 1500,
  pod: 2000,
  music: 1500,
  youtube: 5000,
  coldemail: 8000,
  n8n: 6000,
  prompts: 1000,
  labeling: 800,
  saas: 20000,
};

// Domyslna zawartosc data/streams.json - zapisywana raz przy pierwszym starcie,
// gdy plik nie istnieje. activatedAt dla 'active' = fixed historyczny timestamp,
// zeby ledger/wykresy mialy stabilny punkt odniesienia (nie zmienia sie przy restarcie).
const DEFAULT_STREAMS = {
  streams: [
    { id: 'freelance',  name: 'Freelance Speed-Apply',     status: 'active',  activatedAt: 1734259200000, earnings: 0 },
    { id: 'bounty',     name: 'Open-source Bounties',      status: 'active',  activatedAt: 1734259200000, earnings: 0 },
    { id: 'hackathons', name: 'Hackathons (Devpost)',      status: 'active',  activatedAt: 1734259200000, earnings: 0 },
    { id: 'upwork',     name: 'Upwork Jobs',               status: 'active',  activatedAt: 1734259200000, earnings: 0 },
    { id: 'airdrops',   name: 'Airdrops/Testnets',         status: 'active',  activatedAt: 1734259200000, earnings: 0 },
    { id: 'bugbounty',  name: 'Bug Bounty (HackerOne)',    status: 'setup',   activatedAt: null,          earnings: 0 },
    { id: 'fiverr',     name: 'Fiverr Gigs',               status: 'setup',   activatedAt: null,          earnings: 0 },
    { id: 'outreach',   name: 'Cold Email Outreach',       status: 'ready',   activatedAt: null,          earnings: 0, setupUrl: '/outreach' },
    { id: 'content',    name: 'Content Marketing',         status: 'ready',   activatedAt: null,          earnings: 0, setupUrl: '/content' },
    { id: 'microsaas',  name: 'Micro-SaaS',                status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'telegram',   name: 'Telegram Bot',              status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'voiceover',  name: 'AI Voiceover',              status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'pod',        name: 'Print on Demand',           status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'music',      name: 'AI Music',                  status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'youtube',    name: 'YouTube Faceless',          status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'coldemail',  name: 'Cold Email Agency',         status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'n8n',        name: 'n8n Automation Agency',     status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'prompts',    name: 'Prompt Marketplace',        status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'labeling',   name: 'Data Labeling',             status: 'planned', activatedAt: null,          earnings: 0 },
    { id: 'saas',       name: 'income-radar SaaS',         status: 'planned', activatedAt: null,          earnings: 0 },
  ],
};

let refreshing = null;
let lastIds = null;
// rolling buffer ostatnich N czasow pipeline'u (ms) - liczymy fetch + drafts;
// /api/stats.pipelineSpeed = srednia z tego okna (proxy "ile czasu od zrodla do gotowego szkicu")
const pipelineSamples = [];
const PIPELINE_SAMPLE_CAP = 50;

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

// ---------- Telegram alerty: hierarchia waznosci ----------
// TIER1 (fire): 'hot' + (>= $100 LUB skillMatch >= 2) - okazja z drugiej rzedu wymagajaca akcji.
// TIER2 (star): kazda inna kombinacja 'hot'/'ok' z budzetem lub dopasowaniem - warto rzucic okiem.
// Wszystko ponizej (verdict 'crowd'/'unknown' bez dopasowania) cisza, zeby alerty zachowaly sygnal.
function fmtCompetition(c) {
  if (!c) return '?';
  const parts = [];
  if (c.offers !== null && c.offers !== undefined) parts.push(`${c.offers} offers`);
  if (c.claims !== null && c.claims !== undefined) parts.push(`${c.claims} claims`);
  if (c.trying !== null && c.trying !== undefined) parts.push(`${c.trying} trying`);
  return parts.length ? parts.join(' / ') : '?';
}

function fmtTier1(it) {
  const skills = (it.langs || []).filter(Boolean).join(', ') || 'general';
  return `\u{1F525} HIGH VALUE \u00B7 ${it.source}\n${it.amountText} \u00B7 ${it.title}\nCompetition: ${fmtCompetition(it.competition)}\nSkills: ${skills}\n${it.url}\n\n[Draft ready \u2014 check panel]`;
}

function fmtTier2(it) {
  return `\u{2B50} ${it.source} \u00B7 ${it.amountText}\n${it.title}\n${it.url}`;
}

// powiadomienia Telegram o swiezych okazjach (dziala przy zamknietej przegladarce)
async function notifyTelegram(payload) {
  const c = await freshCfg();
  if (!c.telegramToken || !c.telegramChatId || !payload) return;
  const ids = new Set(payload.items.map(i => i.id));
  if (lastIds) {
    const tier1 = [], tier2 = [];
    for (const it of payload.items) {
      if (lastIds.has(it.id)) continue;
      const amt = it.amountUSD || 0;
      const skill = it.skillMatch || 0;
      if (it.verdict === 'hot' && (amt >= 100 || skill >= 2)) tier1.push(it);
      else if (it.verdict === 'hot' || (it.verdict === 'ok' && amt >= 100) || skill >= 2) tier2.push(it);
    }
    // TIER1 ma pierwszenstwo do limitu 8 - krzyk fajerwerkow nie powinien byc zagluszany.
    const queue = [
      ...tier1.map(it => ({ it, tier: 1 })),
      ...tier2.map(it => ({ it, tier: 2 })),
    ].slice(0, 8);
    for (const { it, tier } of queue) {
      const text = tier === 1 ? fmtTier1(it) : fmtTier2(it);
      await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.telegramChatId, text, disable_web_page_preview: true }),
      }).catch(e => console.error('[telegram]', e.message));
    }
  }
  lastIds = ids;
}

// ---------- AUTO-szkice 24/7: serwer sam pisze baze oferty/analizy dla swiezych, pasujacych pozycji ----------
// Szablon useme/freelancer wypelniany danymi zlecenia; przed wyslaniem wymaga personalizacji
// ([SPERSONALIZUJ]) - moze ja dorabia personalizeTemplate, jak nie wyjdzie zostaje na manualne 30 s.
function autoDraftBody(it) {
  const skills = (it.langs || []).join(', ');
  if (it.source === 'useme') {
    const budzet = it.amountText && it.amountText !== '?' ? ` (widelki ogloszenia: ${it.amountText})` : '';
    return `Dzien dobry,\n\nzajme sie tym: "${it.title}". Robie dokladnie takie rzeczy - automatyzacje, scrapery, boty i panele webowe (Node.js/JavaScript, SQL).\n\nJak pracuje:\n- najpierw doprecyzowuje zakres i podaje stala wycene${budzet}\n- realizacja etapami, podglad postepu na biezaco\n- kod + instrukcja uruchomienia i wsparcie po wdrozeniu\n\nPortfolio na zywo: trixer666.github.io (kod: github.com/trixer666/income-radar).\n\nPytania:\n1. [SPERSONALIZUJ: 1 konkretne pytanie o zakres z opisu zlecenia]\n2. Jaki termin jest graniczny?\n\nMoge zaczac od razu.\nPozdrawiam, Patryk`;
  }
  return `Hi,\n\nI can deliver "${it.title}". I build exactly this kind of work: automation, scrapers, bots and web dashboards (Node.js/JavaScript${skills ? ', ' + skills : ''}).\n\nHow I work:\n- scope confirmation + fixed quote first\n- staged delivery with progress previews\n- clean code + setup instructions + post-delivery support\n\nLive portfolio: trixer666.github.io/en.html (code: github.com/trixer666/income-radar).\n\nQuestions:\n1. [PERSONALIZE: one specific scope question from the brief]\n2. What is your hard deadline?\n\nI can start immediately.\nBest, Patryk`;
}

// Komentarz pod issue/PR na GitHubie - pierwsze klepniecie maintainera (przed wyslaniem PR).
// Wycena czasu po kwocie - klient widzi konkret, my unikamy obietnic z kosmosu.
function bountyCommentDraft(it, analysis = null) {
  const amt = it.amountUSD || 0;
  const est = amt >= 500 ? '2-5 days' : amt >= 100 ? '1-2 days' : 'a few hours';
  let approach = null;
  if (analysis) {
    // Wyciagamy pierwszy konkretny akapit po naglowku "approach"/"plan"/"propozycja"/"podejscie"
    const m = /(?:APPROACH|PLAN|PROPOZYCJA|PODEJSCIE)[^\n]*\n+([^\n]{20,400})/i.exec(analysis);
    if (m) approach = m[1].trim();
  }
  if (!approach) {
    approach = `I'll trace the failing path from the issue, isolate the root cause, and ship a minimal patch with a regression test that locks the fix in.`;
  }
  return `Hi! I've analyzed this issue and identified the root cause.\n\n**Proposed approach:**\n${approach}\n\n**Estimated time:** ${est}\n\nI'd like to work on this. Should I submit a PR?\n\n\u2014 Patryk (github.com/trixer666)`;
}

const OFFER_SOURCES = new Set(['useme', 'freelancer', 'upwork', 'fiverr']);
const BOUNTY_SOURCES = new Set(['opire', 'algora', 'github', 'h1bounty']);

async function autoDrafts(payload) {
  if (!payload) return;
  const drafts = await readJson(DRAFTS, {});
  const queue = await readJson(QUEUE, []);
  const queueIds = new Set(queue.map(q => q.id));
  const state = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} });
  const cLocal = await freshCfg();
  const llmCap = cLocal.llmPerRun ?? 8;
  const llmBountyCap = cLocal.llmBountyPerRun ?? 5;
  let added = 0, llmCalls = 0, llmBountyCalls = 0, queueAdded = 0;
  for (const it of payload.items) {
    if (added >= 20) break;
    if (drafts[it.id] || (state.itemStatus[it.id] || '') !== '') continue;
    const fresh = it.ageDays === null || it.ageDays === undefined || it.ageDays <= 7;
    const fit = (it.skillMatch || 0) >= 1 && it.verdict !== 'crowd';
    if (!fresh || !fit) continue;

    let body = null, kind = 'auto', comment = null, analysis = null;
    const src = it.source;

    if (OFFER_SOURCES.has(src)) {
      // Pelna oferta: najpierw LLM, fallback do szablonu z [SPERSONALIZUJ].
      if (llmCalls < llmCap) {
        llmCalls++;
        const r = await generateOfferDraft(it).catch(e => ({ ok: false, error: e.message }));
        if (r.ok && r.body) { body = r.body; kind = 'llm-oferta'; console.log(`[llm-draft] +${it.id}`); }
        else console.log(`[llm-draft] fallback ${it.id}: ${r.error || '?'}`);
      }
      if (!body) {
        body = autoDraftBody(it);
        // Auto-podstawienie konkretnego pytania pod [SPERSONALIZUJ] na podstawie briefu.
        const p = await personalizeTemplate(body, it).catch(() => null);
        if (p && p.ok && p.body) { body = p.body; kind = 'auto+brief'; console.log(`[personalize] +${it.id}`); }
      }
    } else if (BOUNTY_SOURCES.has(src) || src === 'devpost') {
      // Analiza GO/NO-GO + (dla bounty GitHubowych) gotowy komentarz pod issue.
      // Bez LLM nie ma sensownego fallbacku - pomijamy do nastepnego cyklu z budzetem.
      if (llmBountyCalls < llmBountyCap) {
        llmBountyCalls++;
        const r = await generateBountyAnalysis(it).catch(e => ({ ok: false, error: e.message }));
        if (r.ok && r.body) {
          body = r.body; kind = 'analiza'; analysis = r.body;
          console.log(`[llm-bounty] +${it.id} verdict=${r.verdict || '?'}`);
        } else {
          console.log(`[llm-bounty] skip ${it.id}: ${r.error || '?'}`);
        }
      }
      if (body && BOUNTY_SOURCES.has(src)) comment = bountyCommentDraft(it, analysis);
    } else {
      continue;
    }

    if (!body) continue;
    drafts[it.id] = { ts: Date.now(), kind, title: it.title, url: it.url, body };
    if (comment) drafts[it.id].comment = comment;
    state.itemStatus[it.id] = 'szkic';
    state.statusTs = state.statusTs || {};
    state.statusTs[it.id] = Date.now();
    // sklejony szkic ladujemy do kolejki wysylki - panel pozwala manualnie zatwierdzic
    // lub skipnac przed faktycznym wyslaniem. id deterministyczne, zeby nie dublowac.
    const qid = 'q-' + it.id;
    if (!queueIds.has(qid)) {
      queue.push({
        id: qid,
        itemId: it.id,
        platform: it.source,
        draftBody: body,
        comment: comment || null,
        status: 'ready',
        priority: it.score || 0,
        createdAt: Date.now(),
        sentAt: null,
      });
      queueIds.add(qid);
      queueAdded++;
    }
    added++;
  }
  if (added) {
    await writeFile(DRAFTS, JSON.stringify(drafts, null, 1), 'utf8');
    await writeFile(STATE, JSON.stringify(state, null, 1), 'utf8');
    console.log(`[auto-draft] +${added}`);
  }
  if (queueAdded) {
    await writeFile(QUEUE, JSON.stringify(queue, null, 1), 'utf8');
    console.log(`[queue] +${queueAdded}`);
  }
}

// ---------- WIN-RATE: skutecznosc per zrodlo i per liczba pasujacych skilli ----------
// Liczymy tylko statusy koncowe: 'wygrane'/'wyplacone' = win, 'przegrane' = loss.
// Pozycje wciaz w grze (szkic/wyslane/odpowiedz) nie wchodza w bilans, zeby
// rate nie skakal w gore za samo wyslanie oferty.
async function updateWinRates(state) {
  const itemsData = await readJson(ITEMS, { items: [] });
  const skillById = new Map((itemsData.items || []).map(i => [i.id, i.skillMatch || 0]));
  const bySource = {};
  const bySkillCount = {};
  const bump = (bucket, key, win) => {
    bucket[key] = bucket[key] || { wins: 0, losses: 0, rate: 0 };
    if (win) bucket[key].wins++; else bucket[key].losses++;
  };
  for (const [id, status] of Object.entries(state.itemStatus || {})) {
    const win = status === 'wygrane' || status === 'wyplacone';
    const loss = status === 'przegrane';
    if (!win && !loss) continue;
    const source = (id.split(':')[0] || 'unknown');
    bump(bySource, source, win);
    const sk = skillById.get(id) ?? 0;
    const bucket = sk >= 3 ? '3+' : String(sk);
    bump(bySkillCount, bucket, win);
  }
  const finalize = (b) => {
    for (const v of Object.values(b)) {
      const n = v.wins + v.losses;
      v.rate = n ? Number((v.wins / n).toFixed(3)) : 0;
    }
  };
  finalize(bySource);
  finalize(bySkillCount);
  const out = { bySource, bySkillCount, lastUpdated: Date.now() };
  await writeFile(WINRATES, JSON.stringify(out, null, 1), 'utf8');
  return out;
}

// ---------- helpery czasowe + queue I/O ----------
function startOfTodayMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeekMs() { return Date.now() - 7 * 24 * 3600 * 1000; }
function fmtUSD(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }
async function loadQueue() { return await readJson(QUEUE, []); }
async function saveQueue(q) { await writeFile(QUEUE, JSON.stringify(q, null, 1), 'utf8'); }

// ---------- DAILY SUMMARY ----------
// Raz dziennie ~20:00 lokalnie: krotki rekap dnia przez Telegram. Idempotentne:
// state.lastDailySummary trzyma znacznik wyslanej dzisiaj wiadomosci.
function pickTopOpportunity(items) {
  let best = null;
  for (const it of items || []) {
    if (!it || it.verdict === 'crowd') continue;
    if (!best || (it.score || 0) > (best.score || 0)) best = it;
  }
  return best;
}

async function dailySummary() {
  const c = await freshCfg();
  if (!c.telegramToken || !c.telegramChatId) return;
  const itemsData = await readJson(ITEMS, { updatedAt: 0, items: [] });
  const state = await readJson(STATE, { itemStatus: {}, ledger: {}, statusTs: {} });
  const drafts = await readJson(DRAFTS, {});
  const queue = await readJson(QUEUE, []);

  const dayStart = startOfTodayMs();
  const newItems = (itemsData.items || []).filter(i => (i.firstSeen || 0) >= dayStart).length;
  const draftsToday = Object.values(drafts).filter(d => (d.ts || 0) >= dayStart).length;
  const sentToday = queue.filter(q => q.status === 'sent' && (q.sentAt || 0) >= dayStart).length;

  const sv = Object.values(state.itemStatus || {});
  const won = sv.filter(s => s === 'wygrane' || s === 'wyplacone').length;
  const lost = sv.filter(s => s === 'przegrane').length;
  const ratePct = (won + lost) ? Math.round(100 * won / (won + lost)) : null;

  // earnings dnia z agregatora - obsluguje zarowno tablicowy ledger jak i stary obiektowy
  const earnSnap = await computeEarnings().catch(() => null);
  const earnings = earnSnap ? earnSnap.today : 0;

  const top = pickTopOpportunity(itemsData.items);
  const dateStr = new Date().toISOString().slice(0, 10);
  const lines = [
    `\u{1F4CA} Daily Summary \u2014 ${dateStr}`,
    `New items: ${newItems}`,
    `Drafts generated: ${draftsToday}`,
    `Sent: ${sentToday}`,
    `Win rate: ${ratePct === null ? 'n/a' : ratePct + '%'}`,
    `Earnings today: ${fmtUSD(earnings)}`,
  ];
  if (top) {
    lines.push('');
    lines.push('Top opportunity:');
    lines.push(`${top.title} \u2014 ${top.amountText || '?'}`);
    lines.push(top.url);
  }
  await tgSend(c, lines.join('\n'));
  console.log(`[daily] summary sent (new=${newItems} drafts=${draftsToday} sent=${sentToday})`);
}

async function maybeDailySummary() {
  const now = new Date();
  if (now.getHours() < 20) return;
  const state = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} });
  const lastTs = state.lastDailySummary || 0;
  if (lastTs && new Date(lastTs).toDateString() === now.toDateString()) return;
  await dailySummary();
  // re-read przed zapisem, zeby nie nadpisac swiezych mutacji statusu z innego writera
  const fresh = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} });
  fresh.lastDailySummary = Date.now();
  await writeFile(STATE, JSON.stringify(fresh, null, 1), 'utf8');
}

// Pomiar czasu kazdej fazy - latwo zobaczyc gdzie sie pali (fetch zewnetrznych zrodel
// vs lokalne IO LLM-a vs Telegram). Logi trafiaja do konsoli serwera, panel ich nie potrzebuje.
function doRefresh() {
  if (!refreshing) {
    refreshing = (async () => {
      const t0 = Date.now();
      const p = await refreshAll();
      const fetchMs = Date.now() - t0;
      const t1 = Date.now();
      let alertMs = 0, draftMs = 0;
      await Promise.all([
        (async () => { const ta = Date.now(); await notifyTelegram(p); alertMs = Date.now() - ta; })(),
        (async () => { const td = Date.now(); await autoDrafts(p); draftMs = Date.now() - td; })(),
      ]);
      const pipeMs = Date.now() - t1;
      // probka do /api/stats.pipelineSpeed (fetch + drafts = od zrodla do gotowego szkicu)
      pipelineSamples.push(fetchMs + draftMs);
      if (pipelineSamples.length > PIPELINE_SAMPLE_CAP) pipelineSamples.shift();
      maybeDailySummary().catch(e => console.error('[daily]', e.message));
      console.log(`[pipeline] fetch=${fetchMs}ms drafts=${draftMs}ms alerts=${alertMs}ms pipe=${pipeMs}ms total=${Date.now() - t0}ms`);
    })().catch(e => console.error('[refresh]', e.message))
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

// ---------- LEDGER: zarobki to TABLICA wpisow {amount, ts, source, ...} ----------
// Historycznie state.ledger byl obiektem keyowanym po itemId (radar wyplaty);
// teraz to tablica wpisow. ledgerToArray normalizuje stary format bez utraty danych,
// zeby /api/earnings, dailySummary i UI dzialaly niezaleznie od momentu migracji.
function ledgerToArray(raw, statusTs = {}) {
  if (Array.isArray(raw)) return raw.slice();
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const [id, v] of Object.entries(raw)) {
    if (v == null) continue;
    const amount = typeof v === 'number'
      ? v
      : Number(v.amountUSD ?? v.amount ?? v.value ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    out.push({
      id,
      amount,
      amountUSD: amount, // alias dla starego UI ktore czyta e.amountUSD
      ts: Number(v.ts) || statusTs[id] || 0,
      source: v.source || 'radar',
      title: v.title || null,
    });
  }
  return out;
}

// Agregator zarobkow ze wszystkich strumieni: state.ledger (radar + recznie dopisane)
// + outreach.stats.revenue (sprzedaz z cold-outreachu). Zwraca breakdown czasowy
// (today/week/month) plus per-source, plus liczbe wpisow ledgera.
async function computeEarnings() {
  const state = await readJson(STATE, {});
  const items = (await readJson(ITEMS, {})).items || [];
  const outreach = await readJson(OUTREACH_FILE, {});

  // Zrodla: state.ledger (tablica wpisow lub stary obiekt) + outreach.stats.revenue
  const ledger = ledgerToArray(state.ledger, state.statusTs || {});
  const ledgerTotal = ledger.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const outreachRevenue = Number(outreach?.stats?.revenue || 0);

  // Per-stream breakdown
  const streams = {};
  for (const e of ledger) {
    const src = e.source || 'unknown';
    streams[src] = (streams[src] || 0) + (Number(e.amount) || 0);
  }

  // Time-based - granica dnia liczona w lokalnej strefie (radar zyje 24/7 lokalnie)
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const monthAgo = now - 30 * 24 * 3600 * 1000;

  const todayEarnings = ledger.filter(e => (e.ts || 0) >= todayStart.getTime()).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const weekEarnings  = ledger.filter(e => (e.ts || 0) >= weekAgo).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const monthEarnings = ledger.filter(e => (e.ts || 0) >= monthAgo).reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // items uzywany do mozliwego wzbogacania - na razie tylko jako spojny snapshot,
  // unikamy lazy load w pozniejszych callerach (np. dashboardach).
  void items;

  return {
    total: ledgerTotal + outreachRevenue,
    today: todayEarnings,
    week: weekEarnings,
    month: monthEarnings,
    streams,
    outreach: outreachRevenue,
    ledgerEntries: ledger.length,
  };
}

// data/streams.json zarzadzanie. ensureStreamsFile zapisuje DEFAULT_STREAMS przy
// pierwszym uruchomieniu - awarie zapisu nie blokuja serwera, tylko log do konsoli.
async function loadStreams() {
  try { return JSON.parse(await readFile(STREAMS, 'utf8')); } catch { return null; }
}
async function saveStreams(data) {
  await writeFile(STREAMS, JSON.stringify(data, null, 1), 'utf8');
}
async function ensureStreamsFile() {
  const existing = await loadStreams();
  if (existing && Array.isArray(existing.streams) && existing.streams.length) return existing;
  await saveStreams(DEFAULT_STREAMS).catch(e => console.error('[streams] init', e.message));
  return DEFAULT_STREAMS;
}

// Bezpieczny parser body POST - limit 1 MB chroni przed pomylkowym uploadem.
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
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
    // materialy sprzedazowe (demo dla klienta, oferta PDF, skrypty outreachu)
    if (url.pathname.startsWith('/sales/')) {
      const name = url.pathname.slice('/sales/'.length);
      if (!/^[\w.-]+\.(html|md)$/.test(name)) return send(res, 404, { error: 'not found' });
      return send(res, 200, await readFile(join(ROOT, 'sales', name)), name.endsWith('.html') ? 'text/html' : 'text/plain');
    }
    if (url.pathname === '/api/items') {
      const data = await readJson(ITEMS, { updatedAt: 0, counts: {}, items: [] });
      const c = await freshCfg();
      data.tg = !!(c.telegramToken && c.telegramChatId);
      return send(res, 200, data);
    }
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const itemsData = await readJson(ITEMS, { updatedAt: 0, items: [] });
      const state = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: [], statusTs: {} });
      const drafts = await readJson(DRAFTS, {});
      const queue = await readJson(QUEUE, []);
      const stVals = Object.values(state.itemStatus || {});
      // 'wyslane' bazowy licznik, kazdy dalszy etap (odpowiedz/wygrane/przegrane/wyplacone) jest po wyslaniu
      const sent = stVals.filter(s => ['wyslane', 'odpowiedz', 'wygrane', 'przegrane', 'wyplacone'].includes(s)).length;
      const won = stVals.filter(s => ['wygrane', 'wyplacone'].includes(s)).length;
      const lost = stVals.filter(s => s === 'przegrane').length;
      // earnings z agregatora (tablica wpisow + outreach.stats.revenue)
      const earningsSnap = await computeEarnings();
      // sredni czas reakcji klienta: od pierwszego wykrycia pozycji do zmiany statusu na 'odpowiedz' (lub dalej).
      // Bez osobnego pola 'sentAt' to najlepszy proxy jaki mozemy policzyc ze state.json + items.json.
      const tsMap = state.statusTs || {};
      const firstSeen = new Map((itemsData.items || []).map(i => [i.id, i.firstSeen]));
      let totalResp = 0, nResp = 0;
      for (const [id, status] of Object.entries(state.itemStatus || {})) {
        if (!['odpowiedz', 'wygrane', 'przegrane', 'wyplacone'].includes(status)) continue;
        const ts = tsMap[id], fs = firstSeen.get(id);
        if (ts && fs && ts > fs) { totalResp += ts - fs; nResp++; }
      }
      // breakdown po zrodle - panel pokazuje skad ile pozycji wpada
      const sourceBreakdown = {};
      for (const it of itemsData.items || []) {
        const s = it.source || 'unknown';
        sourceBreakdown[s] = (sourceBreakdown[s] || 0) + 1;
      }
      // draftsByKind - po typie generatora: auto / llm-oferta / analiza / auto+brief
      const draftsByKind = {};
      for (const d of Object.values(drafts)) {
        const k = d.kind || 'auto';
        draftsByKind[k] = (draftsByKind[k] || 0) + 1;
      }
      const queueReady = queue.filter(q => q.status === 'ready').length;
      const pipelineSpeed = pipelineSamples.length
        ? Math.round(pipelineSamples.reduce((a, b) => a + b, 0) / pipelineSamples.length)
        : null;
      // strumieni aktywnych - z streams.json. totalPotential = suma pulapow $/msc.
      const streamsData = (await loadStreams()) || DEFAULT_STREAMS;
      const activeList = (streamsData.streams || []).filter(s => s.status === 'active');
      const activeStreams = activeList.length;
      const totalPotential = activeList.reduce((s, st) => s + (STREAM_POTENTIAL[st.id] || 0), 0);
      // outreach + content stats - degrade-soft, blad nie przerywa /api/stats
      const [outreachStats, contentStats] = await Promise.all([
        getOutreachStats().catch(() => ({})),
        getContentStats().catch(() => ({})),
      ]);
      return send(res, 200, {
        lastRefresh: itemsData.updatedAt || 0,
        totalItems: (itemsData.items || []).length,
        draftsGenerated: Object.keys(drafts).length,
        draftsSent: sent,
        earnings: earningsSnap,
        // legacy aliasy zostawione zeby stary UI nie eksplodowal
        todayEarnings: earningsSnap.today,
        weekEarnings: earningsSnap.week,
        winRate: (won + lost) ? won / (won + lost) : null,
        avgResponseTime: nResp ? Math.round(totalResp / nResp) : null,
        sourceBreakdown,
        draftsByKind,
        queueReady,
        pipelineSpeed,
        outreach: outreachStats,
        content: contentStats,
        activeStreams,
        totalPotential,
      });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: {} }));
    }
    if (url.pathname === '/api/state' && req.method === 'POST') {
      const incoming = await readBody(req);
      const cur = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: [], statusTs: {} });
      // ledger: normalizujemy biezacy do tablicy (migracja obiekt->tablica idempotentna)
      let nextLedger = ledgerToArray(cur.ledger, cur.statusTs || {});
      // przychodzace incoming.ledger moze byc:
      // - obiektem {itemId: {amountUSD,...} | number | null} (stary UI radaru)
      // - tablica wpisow {amount,...} (nowy klient)
      // null oznacza usuniecie wpisu o tym id i source='radar'.
      if (incoming.ledger) {
        if (Array.isArray(incoming.ledger)) {
          for (const e of incoming.ledger) {
            const a = Number(e?.amount ?? e?.amountUSD ?? 0);
            if (!Number.isFinite(a) || a === 0) continue;
            nextLedger.push({
              id: e.id || ('e' + Date.now() + Math.random().toString(36).slice(2, 6)),
              amount: a,
              amountUSD: a,
              ts: Number(e.ts) || Date.now(),
              source: e.source || 'manual',
              ...(e.note ? { note: String(e.note).slice(0, 500) } : {}),
              ...(e.title ? { title: String(e.title).slice(0, 200) } : {}),
            });
          }
        } else if (typeof incoming.ledger === 'object') {
          const now = Date.now();
          for (const [id, v] of Object.entries(incoming.ledger)) {
            // usuniecie wszystkich wpisow radaru o tym itemId
            nextLedger = nextLedger.filter(e => !(e.source === 'radar' && e.id === id));
            if (v == null) continue;
            const a = typeof v === 'number'
              ? v
              : Number(v.amountUSD ?? v.amount ?? v.value ?? 0);
            if (!Number.isFinite(a) || a === 0) continue;
            nextLedger.push({
              id,
              amount: a,
              amountUSD: a,
              ts: Number(v.ts) || now,
              source: 'radar',
              title: v.title || null,
            });
          }
        }
      }
      const next = {
        ...cur,
        itemStatus: { ...cur.itemStatus, ...(incoming.itemStatus || {}) },
        accounts: { ...cur.accounts, ...(incoming.accounts || {}) },
        ledger: nextLedger,
        statusTs: { ...(cur.statusTs || {}), ...(incoming.statusTs || {}) },
      };
      for (const [k, v] of Object.entries(next.itemStatus)) if (v === null || v === '') delete next.itemStatus[k];
      await writeFile(STATE, JSON.stringify(next, null, 1), 'utf8');
      // przeliczamy win-rate w tle - nie blokujemy odpowiedzi, blad tylko do konsoli
      updateWinRates(next).catch(e => console.error('[winrates]', e.message));
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
    if (url.pathname === '/api/queue' && req.method === 'GET') {
      const q = await loadQueue();
      // ready idzie na gore, potem approved, sent, skipped; w obrebie - priorytet desc, nowsze wyzej
      const order = { ready: 0, approved: 1, sent: 2, skipped: 3 };
      q.sort((a, b) => {
        const sa = order[a.status] ?? 9, sb = order[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return send(res, 200, q);
    }
    if (url.pathname === '/api/queue/approve' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      const q = await loadQueue();
      const row = q.find(x => x.id === id);
      if (!row) return send(res, 404, { error: 'no such queue id' });
      row.status = 'approved';
      await saveQueue(q);
      return send(res, 200, { ok: true, item: row });
    }
    if (url.pathname === '/api/queue/skip' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      const q = await loadQueue();
      const row = q.find(x => x.id === id);
      if (!row) return send(res, 404, { error: 'no such queue id' });
      row.status = 'skipped';
      await saveQueue(q);
      return send(res, 200, { ok: true, item: row });
    }
    if (url.pathname === '/api/queue/bulk-approve' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { ids = [] } = JSON.parse(body || '{}');
      const want = new Set(ids);
      const q = await loadQueue();
      let n = 0;
      for (const row of q) if (want.has(row.id) && row.status === 'ready') { row.status = 'approved'; n++; }
      if (n) await saveQueue(q);
      return send(res, 200, { ok: true, approved: n });
    }
    if (url.pathname === '/api/winrates' && req.method === 'GET') {
      return send(res, 200, await readJson(WINRATES, { bySource: {}, bySkillCount: {}, lastUpdated: 0 }));
    }
    if (url.pathname === '/api/offers/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { jobId = null, dryRun = false } = JSON.parse(body || '{}');
      const c = await freshCfg();
      const { items } = await readJson(ITEMS, { items: [] });
      const results = await runOfferQueue(c, items, { dryRun, onlyJobId: jobId, notify: (t) => tgSend(c, t) });
      return send(res, 200, { results });
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
    // ---------- OUTREACH API ----------
    if (url.pathname === '/api/outreach' && req.method === 'GET') {
      return send(res, 200, await loadOutreach());
    }
    if (url.pathname === '/api/outreach/stats' && req.method === 'GET') {
      return send(res, 200, await getOutreachStats());
    }
    if (url.pathname === '/api/outreach/lead' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.name) return send(res, 400, { error: 'wymagane: name' });
      const created = await addLead({
        name: String(body.name).slice(0, 200),
        email: body.email ? String(body.email).slice(0, 200) : null,
        source: body.source || 'manual',
        industry: body.industry || null,
        pitch: body.pitch || null,
        website: body.website || null,
        notes: body.notes || '',
      });
      return send(res, 200, { ok: true, lead: created });
    }
    if (url.pathname === '/api/outreach/draft' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.leadId) return send(res, 400, { error: 'wymagane: leadId' });
      const data = await loadOutreach();
      const lead = (data.leads || []).find(l => l.id === body.leadId);
      if (!lead) return send(res, 404, { error: 'no such leadId' });
      const templateId = body.templateId || 'tpl-cold-pl';
      const r = await generateOutreachDraft(lead, templateId);
      if (!r.ok) return send(res, 500, { error: r.error || 'draft-failed' });
      // persist: dopinamy szkic do leada i zapisujemy outreach.json
      lead.draftSubject = r.subject;
      lead.draftBody = r.body;
      lead.templateId = templateId;
      if (lead.status === 'new') lead.status = 'drafted';
      await saveOutreach(data);
      return send(res, 200, { ok: true, draft: r, lead });
    }
    if (url.pathname === '/api/outreach/bulk-draft' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body?.leadIds) ? body.leadIds : [];
      if (!ids.length) return send(res, 400, { error: 'wymagane: leadIds (tablica)' });
      const templateId = body.templateId || 'tpl-cold-pl';
      const results = await bulkGenerateDrafts(ids, templateId);
      return send(res, 200, { results });
    }
    if (url.pathname === '/api/outreach/scrape' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.query) return send(res, 400, { error: 'wymagane: query' });
      const found = await scrapeLocalBusinesses(body.query, body.city || '');
      // dolaczamy znalezione firmy jako leady scraped, tylko unikalne po nazwie
      const data = await loadOutreach();
      const known = new Set((data.leads || []).map(l => (l.name || '').toLowerCase()));
      const added = [];
      for (const f of found) {
        const key = (f.name || '').toLowerCase();
        if (!key || known.has(key)) continue;
        const created = await addLead({
          name: f.name,
          email: null,
          source: 'scraped',
          industry: f.industry || body.query,
          website: f.website || null,
        });
        added.push(created);
        known.add(key);
      }
      return send(res, 200, { found: found.length, added: added.length, leads: added });
    }

    // ---------- CONTENT API ----------
    if (url.pathname === '/api/content' && req.method === 'GET') {
      return send(res, 200, await loadContent());
    }
    if (url.pathname === '/api/content/stats' && req.method === 'GET') {
      return send(res, 200, await getContentStats());
    }
    if (url.pathname === '/api/content/generate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.platform || !body.topic) return send(res, 400, { error: 'wymagane: platform, topic' });
      const r = await generatePost({
        platform: body.platform,
        type: body.type || 'post',
        topic: body.topic,
        style: body.style || null,
      });
      if (!r.ok) return send(res, 500, { error: r.error || 'generate-failed' });
      // persist: dolaczamy do data.posts + saveContent (modul nie zapisuje sam)
      const data = await loadContent();
      data.posts = Array.isArray(data.posts) ? data.posts : [];
      data.posts.push(r.post);
      data.stats = data.stats || { totalCreated: 0, published: 0 };
      data.stats.totalCreated = (data.stats.totalCreated || 0) + 1;
      await saveContent(data);
      return send(res, 200, { ok: true, post: r.post });
    }
    if (url.pathname === '/api/content/calendar' && req.method === 'POST') {
      const body = await readBody(req);
      const days = Number(body?.days) || 7;
      const calendar = await generateContentCalendar(days);
      // persist do data.calendar zeby UI mogl wyswietlic plan
      const data = await loadContent();
      data.calendar = calendar;
      await saveContent(data);
      return send(res, 200, { ok: true, days, calendar });
    }
    if (url.pathname === '/api/content/ideas' && req.method === 'POST') {
      const body = await readBody(req);
      const niche = body?.niche || 'automatyzacja Node.js';
      const ideas = await getContentIdeas(niche);
      return send(res, 200, { niche, ideas });
    }

    // ---------- EARNINGS API ----------
    if (url.pathname === '/api/earnings' && req.method === 'GET') {
      return send(res, 200, await computeEarnings());
    }
    if (url.pathname === '/api/earnings/add' && req.method === 'POST') {
      const body = await readBody(req);
      const amount = Number(body?.amount);
      const source = body?.source ? String(body.source).slice(0, 60) : null;
      if (!Number.isFinite(amount) || amount === 0) return send(res, 400, { error: 'wymagane: amount (liczba != 0)' });
      if (!source) return send(res, 400, { error: 'wymagane: source' });
      const cur = await readJson(STATE, { itemStatus: {}, accounts: {}, ledger: [], statusTs: {} });
      const arr = ledgerToArray(cur.ledger, cur.statusTs || {});
      const entry = {
        id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6),
        amount,
        amountUSD: amount,
        source,
        ts: Date.now(),
      };
      if (body.note) entry.note = String(body.note).slice(0, 500);
      arr.push(entry);
      cur.ledger = arr;
      await writeFile(STATE, JSON.stringify(cur, null, 1), 'utf8');
      // dopisujemy earnings do streams.json (jesli source pasuje do znanego strumienia)
      try {
        const streamsData = (await loadStreams()) || DEFAULT_STREAMS;
        const st = (streamsData.streams || []).find(s => s.id === source);
        if (st) {
          st.earnings = (Number(st.earnings) || 0) + amount;
          await saveStreams(streamsData);
        }
      } catch (e) { console.error('[earnings] streams update', e.message); }
      const snap = await computeEarnings();
      return send(res, 200, { ok: true, entry, earnings: snap });
    }

    // ---------- STREAMS API ----------
    if (url.pathname === '/api/streams' && req.method === 'GET') {
      return send(res, 200, await ensureStreamsFile());
    }
    if (url.pathname === '/api/streams/activate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.id) return send(res, 400, { error: 'wymagane: id' });
      const data = await ensureStreamsFile();
      const st = (data.streams || []).find(s => s.id === body.id);
      if (!st) return send(res, 404, { error: 'no such stream id' });
      st.status = 'active';
      st.activatedAt = Date.now();
      await saveStreams(data);
      return send(res, 200, { ok: true, stream: st });
    }
    if (url.pathname === '/api/streams/deactivate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.id) return send(res, 400, { error: 'wymagane: id' });
      const data = await ensureStreamsFile();
      const st = (data.streams || []).find(s => s.id === body.id);
      if (!st) return send(res, 404, { error: 'no such stream id' });
      st.status = 'planned';
      st.activatedAt = null;
      await saveStreams(data);
      return send(res, 200, { ok: true, stream: st });
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

// streams.json zakladane przy starcie, jezeli go nie ma (idempotentne na restartach)
ensureStreamsFile().catch(e => console.error('[streams] init failed:', e.message));
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
