// income-radar outreach: cold outreach engine - leady, personalizowane szablony, pipeline statusow.
// ZERO zaleznosci npm. Storage: data/outreach.json (zwykly JSON, zapis przez writeFile).
// LLM: callClaude (./llm.mjs) - generuje 1 zdanie personalizacji wstawiane w {personalization} szablonu.
// Scraper: curl podproces (Google /search?tbm=lcl) - best-effort, czesto blokowany przez consent wall.
//
// Schemat data/outreach.json:
// {
//   "leads": [{
//     "id":"lead-xxx", "name":"Firma ABC", "email":"kontakt@firma.pl",
//     "source":"manual|scraped|linkedin", "industry":"e-commerce",
//     "status":"new|drafted|sent|replied|converted|dead",
//     "pitch":"automation|bot|scraping|website",
//     "draftSubject":null, "draftBody":null, "templateId":null,
//     "sentAt":null, "createdAt":1234567890, "notes":"", "website":null
//   }],
//   "templates": [{ "id":"tpl-cold-pl", "name":"...", "subject":"...", "body":"..." }],
//   "stats": { "totalSent":0, "replies":0, "converted":0, "revenue":0 }
// }
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callClaude } from './llm.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTREACH = join(ROOT, 'data', 'outreach.json');

// Domyslny stan pliku - 3 szablony (PL cold, EN cold, follow-up) + pusta lista leadow.
// Trzymane jako stala, klonowane przed zwrotem (immutable safety).
const DEFAULT_DATA = {
  leads: [],
  templates: [
    {
      id: 'tpl-cold-pl',
      name: 'Cold PL',
      subject: 'Automatyzacja {industry} - oszczedz 10h/tydzien',
      body: 'Dzien dobry,\n\nWidzialem {name} i mam pomysl jak zautomatyzowac {pitch}.\n\n{personalization}\n\nMoge pokazac demo na zywo - trixer666.github.io\n\nPatryk',
    },
    {
      id: 'tpl-cold-en',
      name: 'Cold EN',
      subject: 'Save 10h/week with {pitch} automation',
      body: 'Hi,\n\nI noticed {name} could benefit from {pitch} automation.\n\n{personalization}\n\nLive demos at trixer666.github.io\n\nBest, Patryk',
    },
    {
      id: 'tpl-followup',
      name: 'Follow-up',
      subject: 'Re: {prevSubject}',
      body: 'Czesc,\n\nPisze ponownie w sprawie automatyzacji. Mam gotowe demo pod {industry}: {demoUrl}\n\nPatryk',
    },
  ],
  stats: { totalSent: 0, replies: 0, converted: 0, revenue: 0 },
};

// Wczytuje data/outreach.json. Brak pliku -> tworzy z domyslnym schematem i zapisuje.
// Defensywnie uzupelnia brakujace pola (migracje, czesciowo uszkodzone pliki nie wywalaja serwera).
export async function loadOutreach() {
  try {
    const raw = await readFile(OUTREACH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.leads)) data.leads = [];
    if (!Array.isArray(data.templates) || data.templates.length === 0) {
      data.templates = JSON.parse(JSON.stringify(DEFAULT_DATA.templates));
    }
    if (!data.stats || typeof data.stats !== 'object') {
      data.stats = { totalSent: 0, replies: 0, converted: 0, revenue: 0 };
    }
    return data;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const fresh = JSON.parse(JSON.stringify(DEFAULT_DATA));
      await saveOutreach(fresh);
      return fresh;
    }
    throw e;
  }
}

// Zapis na dysk z mkdir -p data/. Pretty-print zeby plik byl edytowalny recznie.
export async function saveOutreach(data) {
  await mkdir(dirname(OUTREACH), { recursive: true });
  await writeFile(OUTREACH, JSON.stringify(data, null, 2), 'utf8');
}

// Krotki, unikalny id leada (base36 czasu + 4 znaki losowe). Czytelny w logach.
function newLeadId() {
  return 'lead-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Dodaje lead do pliku. Wymagane: name. Reszta defaultuje sensownie.
// Zwraca utworzony obiekt (z wygenerowanym id i createdAt).
export async function addLead(lead = {}) {
  const data = await loadOutreach();
  const created = {
    id: lead.id || newLeadId(),
    name: String(lead.name || 'unknown').slice(0, 200),
    email: lead.email || null,
    source: lead.source || 'manual',
    industry: lead.industry || 'general',
    status: lead.status || 'new',
    pitch: lead.pitch || 'automation',
    draftSubject: null,
    draftBody: null,
    templateId: null,
    sentAt: null,
    createdAt: lead.createdAt || Date.now(),
    notes: lead.notes || '',
    website: lead.website || null,
  };
  data.leads.push(created);
  await saveOutreach(data);
  return created;
}

// Podstawia {var} wartoscia z dict. Brakujacy klucz zostawia tag - widac od razu czego brakuje.
function fillVars(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) =>
    (vars[k] !== undefined && vars[k] !== null && vars[k] !== '') ? String(vars[k]) : '{' + k + '}'
  );
}

// Prompt systemowy dla personalizacji - 1 konkretne zdanie, bez frazesow, bez podpisu.
const PERSO_SYSTEM = `Jestes Patrykiem - freelancer developer (trixer666.github.io, github.com/trixer666).
Piszesz cold outreach do potencjalnego klienta. Twoje zadanie: JEDNO konkretne zdanie (max 25 slow) wyjasniajace
dlaczego TEN konkretny biznes zyska na proponowanej automatyzacji.
ZASADY: bez frazesow ("w dzisiejszym dynamicznym swiecie", "synergia", "elevate"), bez powitan, bez podpisu,
bez markdownu, bez cudzyslowow wokol zdania. Polski tekst BEZ polskich znakow diakrytycznych
(a c e l n o s z z zamiast a c e l n o s z z). Zwracasz TYLKO to jedno zdanie.`;

// Generuje personalizowany szkic outreach: szablon (subject + body) z {placeholderami}
// + 1 zdanie LLM wstawione w {personalization}.
// Krok 1: szablon po templateId.
// Krok 2: zbierz {name},{industry},{pitch},{prevSubject},{demoUrl} z lead + opts.
// Krok 3: callClaude (sonnet, 30s, $0.02) o jedno zdanie - fallback do generycznego gdy LLM offline.
// Krok 4: fillVars na subject + body.
// Zwraca { ok:true, subject, body, llmUsed:bool } lub { ok:false, error }.
export async function generateOutreachDraft(lead, templateId, opts = {}) {
  if (!lead || !lead.name) return { ok: false, error: 'lead-bez-name' };
  if (!templateId) return { ok: false, error: 'brak-templateId' };
  const data = await loadOutreach();
  const tpl = data.templates.find(t => t.id === templateId);
  if (!tpl) return { ok: false, error: 'brak-templatu:' + templateId };

  const vars = {
    name: lead.name,
    industry: lead.industry || 'general',
    pitch: lead.pitch || 'automation',
    prevSubject: opts.prevSubject || lead.lastSubject || 'wczesniejsza wiadomosc',
    demoUrl: opts.demoUrl || 'https://trixer666.github.io',
    personalization: '', // wypelnione przez LLM ponizej
  };

  // Prompt skladany z faktow o leadzie - im wiecej kontekstu, tym celniejsze zdanie.
  const prompt = `LEAD: ${lead.name}
BRANZA: ${vars.industry}
PROPOZYCJA: ${vars.pitch}` +
    (lead.website ? `\nSTRONA: ${lead.website}` : '') +
    (lead.notes ? `\nNOTATKI: ${lead.notes}` : '') +
    `\n\nNapisz JEDNO zdanie (max 25 slow) - konkretna obserwacja dlaczego ${lead.name} zyska na ${vars.pitch}.
Zwroc TYLKO to jedno zdanie. Zero wstepow, zero podpisu, zero cudzyslowow.`;

  const r = await callClaude(prompt, {
    system: PERSO_SYSTEM,
    model: opts.model || 'claude-sonnet-4-20250514',
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.02,
  });

  // Sanityzacja odpowiedzi: pierwsza linia, bez otaczajacych cudzyslowow.
  // Fallback: krotkie generyczne zdanie - lepiej wyslac dobry default niz "{personalization}" jako tag.
  const personalization = (r.ok && r.text)
    ? r.text.trim().replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '').split('\n')[0].trim()
    : `Firmy typu ${vars.industry} traca kilka godzin tygodniowo na zadaniach, ktore mozna w pelni zautomatyzowac.`;

  vars.personalization = personalization;
  const subject = fillVars(tpl.subject, vars);
  const body = fillVars(tpl.body, vars);
  return { ok: true, subject, body, llmUsed: !!r.ok };
}

// Generuje szkice dla wielu leadow SEKWENCYJNIE (rate-limit-friendly).
// Twardy cap = 5 na wywolanie - dluzsze listy dziel po stronie callera.
// Zapisuje draftSubject/draftBody/templateId do leada i podnosi status new->drafted.
// Wynik: [{ leadId, ok, subject?, body?, error? }, ...].
export async function bulkGenerateDrafts(leadIds, templateId, opts = {}) {
  const list = Array.isArray(leadIds) ? leadIds.slice(0, 5) : [];
  if (list.length === 0) return [];
  const data = await loadOutreach();
  const tpl = data.templates.find(t => t.id === templateId);
  if (!tpl) return list.map(id => ({ leadId: id, ok: false, error: 'brak-templatu:' + templateId }));

  const results = [];
  for (const id of list) {
    const lead = data.leads.find(l => l.id === id);
    if (!lead) { results.push({ leadId: id, ok: false, error: 'brak-leada' }); continue; }
    const draft = await generateOutreachDraft(lead, templateId, opts);
    if (draft.ok) {
      lead.draftSubject = draft.subject;
      lead.draftBody = draft.body;
      lead.templateId = templateId;
      if (lead.status === 'new') lead.status = 'drafted';
      results.push({ leadId: id, ok: true, subject: draft.subject, body: draft.body });
    } else {
      results.push({ leadId: id, ok: false, error: draft.error });
    }
  }
  await saveOutreach(data);
  return results;
}

// Statystyki pipeline'u - liczone z lead.status + revenue z data.stats.
// conversionRate liczone od wyslanych (sent + replied + converted), nie od wszystkich leadow.
export async function getOutreachStats() {
  const data = await loadOutreach();
  const buckets = { new: 0, drafted: 0, sent: 0, replied: 0, converted: 0, dead: 0 };
  for (const l of data.leads) {
    if (buckets[l.status] !== undefined) buckets[l.status]++;
  }
  const totalLeads = data.leads.length;
  const sentLike = buckets.sent + buckets.replied + buckets.converted;
  const conversionRate = sentLike > 0 ? +((buckets.converted / sentLike) * 100).toFixed(2) : 0;
  const replyRate = sentLike > 0 ? +(((buckets.replied + buckets.converted) / sentLike) * 100).toFixed(2) : 0;
  return {
    totalLeads,
    new: buckets.new,
    drafted: buckets.drafted,
    sent: buckets.sent,
    replied: buckets.replied,
    converted: buckets.converted,
    dead: buckets.dead,
    totalSent: sentLike,
    conversionRate, // %
    replyRate,      // %
    revenue: Number(data.stats?.revenue || 0),
  };
}

// curl podproces - ten sam wzorzec co fetchBrief() w llm.mjs.
// Node fetch dostaje 403/429 od Google (TLS fingerprint + brak cookies), curl przechodzi czesciej.
function fetchTextCurl(url, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const args = [
      '-sL', '--max-time', String(Math.max(2, Math.ceil(timeoutMs / 1000))),
      '-H', 'User-Agent: ' + UA,
      '-H', 'Accept: text/html,application/xhtml+xml',
      '-H', 'Accept-Language: pl-PL,pl;q=0.9,en;q=0.8',
      url,
    ];
    const proc = spawn('curl', args, { shell: false, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve(null); }, timeoutMs + 3_000);
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => { clearTimeout(timer); resolve(out || null); });
  });
}

// Best-effort scraper Google /search?tbm=lcl - parsuje hosty z /url?q=... + tytuly z <h3>.
// Google CZESTO blokuje (consent wall, captcha, 429) - przy zerze trafien zwraca [] (NIE rzuca).
// Zwraca [{ name, website, email:null, industry: query, source:'scraped' }].
export async function scrapeLocalBusinesses(query, city) {
  if (!query) return [];
  const q = encodeURIComponent((String(query) + (city ? ' ' + city : '')).trim());
  const url = `https://www.google.com/search?q=${q}&tbm=lcl&hl=pl`;
  const html = await fetchTextCurl(url, 15_000);
  if (!html || html.length < 500) return [];

  // Consent wall / sorry page = zero szans bez sesji cookies - wracaj z pusta lista.
  if (/consent\.google\.com|\/sorry\/|Before you continue|Zanim przejdziesz do Google/i.test(html)) {
    return [];
  }

  const leads = [];
  const seenHost = new Set();
  const seenName = new Set();

  // Strategia 1: zewnetrzne linki w wynikach (Google opakowuje je w /url?q=URL&...).
  // Pomijamy google-internal (maps, support, aclk, policies) i cache.
  const linkRe = /\/url\?q=(https?:\/\/[^&"'<>\s]+)/g;
  let m;
  while ((m = linkRe.exec(html)) !== null && leads.length < 20) {
    let raw;
    try { raw = decodeURIComponent(m[1]); } catch { continue; }
    if (/google\.[a-z.]+\/(?:maps|search|support|aclk|policies|preferences|setprefs|imgres)/i.test(raw)) continue;
    if (/webcache\.googleusercontent|gstatic\.com|googleusercontent\.com/i.test(raw)) continue;
    let host;
    try { host = new URL(raw).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!host) continue;
    if (host === 'google.com' || host.endsWith('.google.com')) continue;
    if (seenHost.has(host)) continue;
    seenHost.add(host);
    // Nazwa = przyblizenie z hosta (Google ciagle zmienia DOM - bez stabilnego selectora nazwy).
    const guessed = host.split('.')[0].replace(/[-_]+/g, ' ').trim();
    seenName.add(guessed.toLowerCase());
    leads.push({
      name: guessed,
      website: 'https://' + host,
      email: null,
      industry: String(query),
      source: 'scraped',
    });
  }

  // Strategia 2: dorzucic czyste nazwy z <h3> gdy linkow malo (czesto biznesy lokalne
  // pokazuja sie BEZ klikalnego linku do strony - tylko karta Maps).
  if (leads.length < 10) {
    const titleRe = /<h3[^>]*>([^<]{3,80})<\/h3>/g;
    let t;
    while ((t = titleRe.exec(html)) !== null && leads.length < 20) {
      const name = t[1]
        .replace(/&amp;/g, '&')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
      leads.push({
        name,
        website: null,
        email: null,
        industry: String(query),
        source: 'scraped',
      });
    }
  }

  return leads;
}
