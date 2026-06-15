// income-radar content: AI-driven content pipeline for promoting Patryk's services.
// Generuje posty social, watki, artykuly, pomysly i kalendarz na wiele platform.
// Zero zaleznosci npm. callClaude (llm.mjs) odpala `claude -p` jako podproces.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callClaude } from './llm.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, 'data', 'content.json');
const MODEL = 'claude-sonnet-4-20250514';

// Bazowy system prompt - tozsamosc autora i ramy stylu (te same dla wszystkich generacji).
const SYSTEM = `Jestes Patryk (trixer666.github.io) - developer automatyzacji i botow.
Tworzysz posty na social media promujace Twoje uslugi.
Styl: konkretny, techniczny, z demo/przykladami, zero frazesow AI.
Jezyk: polski (bez polskich znakow diakrytycznych) lub angielski (wg platform).
W kazdym poscie subtelnie wspomnij trixer666.github.io lub github.com/trixer666.`;

// Reguly per platforma - doklejane do user promptu w generatePost.
// Klucz w lowercase, fallback w generatePost gdy platforma nieznana.
const PLATFORM_RULES = {
  twitter: 'PLATFORMA TWITTER/X: max 280 znakow w sumie (twardy limit), 2-3 hashtagi na koncu, CTA z linkiem trixer666.github.io. Bez markdownu. Dla zasiegu preferuj EN.',
  linkedin: 'PLATFORMA LINKEDIN: ton profesjonalny, 3-5 akapitow w formacie case study (problem -> rozwiazanie -> wynik liczbowy). Jeden link do portfolio lub repo na koncu. Bez gwiazdek/markdownu.',
  reddit: 'PLATFORMA REDDIT: najpierw POMOZ konkretem - rozwiaz problem OP, dopiero potem wspomnij wlasny projekt naturalnie ("zrobilem cos podobnego: link"). Nie spamuj. Markdown tylko `inline code`.',
  devto: 'PLATFORMA DEV.TO: format tutoriala technicznego - krotki intro, sekcje 1-2-3, fragmenty kodu w ``` blokach, link do repo github.com/trixer666 na koncu. Jezyk EN.',
  facebook: 'PLATFORMA FACEBOOK: ton kazualny, konwersacyjny, 1-2 emoji dozwolone, krotki akapit + CTA. Jezyk PL.',
};

// Krotki nieblokujacy id - "post-" + base36 timestamp + 4 znaki losowe.
// Wystarczajaco unikalny dla naszego volume'u (kilkadziesiat postow dziennie max).
function makeId() {
  return 'post-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function defaultContent() {
  return {
    posts: [],
    calendar: [],
    stats: { totalCreated: 0, published: 0 },
  };
}

// Wyciaga JSON z odpowiedzi LLM. Toleruje ```json fence i tekst przed/po.
// Zwraca sparsowany obiekt/tablice lub null gdy nie ma sensownego JSON.
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {}
  // Fallback: znajdz pierwszy [ albo { i ostatni domykajacy.
  const firstObj = candidate.indexOf('{');
  const firstArr = candidate.indexOf('[');
  let start = -1, close = '';
  if (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) { start = firstArr; close = ']'; }
  else if (firstObj >= 0) { start = firstObj; close = '}'; }
  if (start < 0) return null;
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

// Czyta data/content.json. Brak pliku/zly JSON -> tworzy plik z domyslna struktura.
// Migruje stare snapshoty doklejajac brakujace pola, zeby caller nie musial sprawdzac kazdego klucza.
export async function loadContent() {
  try {
    const raw = await readFile(CONTENT, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.posts)) data.posts = [];
    if (!Array.isArray(data.calendar)) data.calendar = [];
    if (!data.stats || typeof data.stats !== 'object') data.stats = { totalCreated: 0, published: 0 };
    if (typeof data.stats.totalCreated !== 'number') data.stats.totalCreated = data.posts.length;
    if (typeof data.stats.published !== 'number') data.stats.published = 0;
    return data;
  } catch {
    const d = defaultContent();
    try { await mkdir(dirname(CONTENT), { recursive: true }); } catch {}
    try { await writeFile(CONTENT, JSON.stringify(d, null, 2), 'utf8'); } catch {}
    return d;
  }
}

// Zapis pelnej struktury content (proste zastapienie - plik jest maly).
export async function saveContent(data) {
  try { await mkdir(dirname(CONTENT), { recursive: true }); } catch {}
  await writeFile(CONTENT, JSON.stringify(data, null, 2), 'utf8');
}

// Generuje pojedynczy post zgodnie z regulami platformy.
// opts: { platform, type, topic, style? }. Zwraca { ok, post } lub { ok:false, error }.
// Nie zapisuje do pliku - caller decyduje czy push do posts[] + saveContent.
export async function generatePost(opts = {}) {
  const { platform, type, topic, style } = opts || {};
  if (!platform || !type || !topic) return { ok: false, error: 'wymagane pola: platform, type, topic' };
  const key = String(platform).toLowerCase();
  const rules = PLATFORM_RULES[key] || `PLATFORMA ${key.toUpperCase()}: zwykly post, konkretny, z linkiem do portfolio trixer666.github.io.`;
  const styleHint = style ? `\nDODATKOWY STYL/TON: ${style}` : '';
  const userPrompt = `${rules}
TYP TRESCI: ${type}
TEMAT: ${topic}${styleHint}

Napisz JEDEN ${type} na temat "${topic}" zgodnie z zasadami platformy ${key}.
Zwroc TYLKO tresc posta - bez naglowkow "oto post:", bez nawiasow z komentarzami,
bez markdownu poza tym co dozwolone na danej platformie.`;
  const r = await callClaude(userPrompt, {
    system: SYSTEM,
    model: MODEL,
    timeoutMs: 30_000,
    maxBudgetUsd: 0.02,
  });
  if (!r.ok) return { ok: false, error: r.error || 'llm-error' };
  const post = {
    id: makeId(),
    platform: key,
    type,
    topic,
    body: r.text,
    status: 'draft',
    createdAt: Date.now(),
    publishedAt: null,
    engagement: null,
  };
  return { ok: true, post };
}

// Generuje kalendarz contentu na N dni (clamp 1..30). Jeden call LLM dla calego kalendarza.
// Zwraca [{day, posts: [{platform, type, topic, suggestedTime}]}] lub [] gdy LLM padl.
export async function generateContentCalendar(days = 7) {
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const userPrompt = `Wygeneruj kalendarz contentu na ${n} dni dla Patryka (trixer666.github.io) -
developera automatyzacji: Node.js boty, scrapery, alerty Telegram, integracje API,
panele webowe, Lua/FiveM systemy serwerowe.

ZASADY:
- Kazdy dzien: 2-3 posty na ROZNYCH platformach (twitter, linkedin, reddit, devto, facebook).
- Tematy rotuja przez tydzien: tips automatyzacji, case studies (np. radar zlecen, bot OLX,
  scraper Booking), recenzje narzedzi (Claude Code, Playwright, CDP), behind-the-scenes
  (jak budujesz konkretnego bota od zera).
- suggestedTime w formacie "HH:MM" (24h, czas PL). Sugestie peak: twitter 09:00/14:00/19:00,
  linkedin 08:00/12:00, reddit 16:00/20:00, devto 10:00, facebook 18:00.
- type to JEDNO z: thread, post, article, comment.
- topic ma byc KONKRETNY (nie "automatyzacja", tylko "jak zrobic bota Telegram do alertow OLX w 30 linii Node").

Zwroc TYLKO czysty JSON (bez markdownu, bez wstepu) - tablica obiektow w formacie:
[{"day": 1, "posts": [{"platform": "twitter", "type": "thread", "topic": "...", "suggestedTime": "09:00"}]}]`;
  const r = await callClaude(userPrompt, {
    system: SYSTEM,
    model: MODEL,
    timeoutMs: 60_000,
    maxBudgetUsd: 0.05,
  });
  if (!r.ok) return [];
  const parsed = extractJson(r.text);
  if (!Array.isArray(parsed)) return [];
  // Light sanity check - odrzuc wpisy bez wymaganych pol, zeby caller nie musial walidowac.
  return parsed
    .filter(d => d && typeof d.day === 'number' && Array.isArray(d.posts))
    .map(d => ({
      day: d.day,
      posts: d.posts.filter(p => p && p.platform && p.type && p.topic),
    }));
}

// Generuje wiele postow sekwencyjnie z listy {platform, topic, type?, style?}. Max 5 na batch.
// Sekwencyjnie zeby nie zalac LLM-a rownoleglymi spawnami `claude -p` (kazdy to osobny proces).
// Zwraca tablice udanych postow (puste przy calkowitej porazce).
export async function generateBatchPosts(topics = []) {
  const batch = (Array.isArray(topics) ? topics : []).slice(0, 5);
  const out = [];
  for (const t of batch) {
    if (!t || !t.platform || !t.topic) continue;
    const r = await generatePost({
      platform: t.platform,
      type: t.type || 'post',
      topic: t.topic,
      style: t.style,
    });
    if (r.ok) out.push(r.post);
  }
  return out;
}

// Generuje 10 pomyslow na content dla podanej niszy. Zwraca [{title, platform, type, hook}].
// Hook to pierwsze zdanie/tytul ktore zatrzymuje scroll - sluzy do A/B testu ktore drazyc.
export async function getContentIdeas(niche) {
  if (!niche) return [];
  const userPrompt = `Wygeneruj 10 KONKRETNYCH pomyslow na content dla niszy: "${niche}".
Dla Patryka (trixer666.github.io) - developera automatyzacji (Node.js, boty Telegram,
scrapery, integracje API, FiveM/Lua).

KAZDY pomysl ma byc OSTRY i wykonalny w 1-3h pracy. Bez ogolnikow typu
"10 tipow na produktywnosc". Powinien byc konkretny do podlinkowania kodu/dema.

Dystrybucja platform: 3x twitter, 2x linkedin, 2x reddit, 2x devto, 1x facebook.
type: thread/post/article/comment (dobierz do platformy).
hook: pierwsza linijka ktora zatrzymuje scroll (max 120 znakow, bez frazesow AI).

Zwroc TYLKO czysty JSON (bez markdownu) - tablica obiektow:
[{"title": "...", "platform": "twitter", "type": "thread", "hook": "..."}]`;
  const r = await callClaude(userPrompt, {
    system: SYSTEM,
    model: MODEL,
    timeoutMs: 45_000,
    maxBudgetUsd: 0.03,
  });
  if (!r.ok) return [];
  const parsed = extractJson(r.text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(x => x && x.title && x.platform && x.type && x.hook)
    .slice(0, 10);
}

// Liczy statystyki z posts[]: total, byPlatform, byStatus, thisWeek (7 dni wstecz),
// plus skroty published/drafts dla wygody dashboardu.
export async function getContentStats() {
  const data = await loadContent();
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const byPlatform = {};
  const byStatus = {};
  let thisWeek = 0;
  for (const p of posts) {
    if (!p) continue;
    if (p.platform) byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
    if (p.status) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    if (typeof p.createdAt === 'number' && p.createdAt >= weekAgo) thisWeek++;
  }
  return {
    total: posts.length,
    byPlatform,
    byStatus,
    thisWeek,
    published: byStatus.published || 0,
    drafts: byStatus.draft || 0,
  };
}
