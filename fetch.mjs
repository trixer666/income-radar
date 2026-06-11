// income-radar fetcher: Opire API + Algora org pages + Useme listings -> data/items.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HTML_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
};

async function loadConfig() {
  return JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: HTML_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Cloudflare odrzuca TLS fingerprint Node a przepuszcza curl - stad curl.exe dla Useme
async function fetchTextCurl(url) {
  const args = ['-sL', '--max-time', '30', url];
  for (const [k, v] of Object.entries(HTML_HEADERS)) args.push('-H', `${k}: ${v}`);
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 });
  if (!stdout || stdout.length < 1000) throw new Error(`curl: pusta/krotka odpowiedz dla ${url}`);
  return stdout;
}

// Naglowki GitHub API; z tokenem (config.ghToken) limit rosnie z 60 do 5000 req/h
function ghHeaders(cfg) {
  const h = { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' };
  if (cfg.ghToken) h.Authorization = `Bearer ${cfg.ghToken}`;
  return h;
}

// ---------- Opire (public JSON API) ----------
async function fetchOpire(cfg) {
  const items = [];
  for (let page = 1; page <= (cfg.opirePages ?? cfg.opireMaxPages ?? 3); page++) {
    let rows;
    try {
      const res = await fetch(`https://api.opire.dev/rewards?page=${page}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) break;
      rows = await res.json();
    } catch { break; }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const claims = (r.claimerUsers || []).length;
      const trying = (r.tryingUsers || []).length;
      items.push({
        id: `opire:${r.id}`,
        source: 'opire',
        title: r.title || '(bez tytulu)',
        url: r.url,
        amountUSD: r.pendingPrice ? r.pendingPrice.value / 100 : null,
        amountText: r.pendingPrice ? `$${(r.pendingPrice.value / 100).toLocaleString('en-US')}` : '?',
        langs: r.programmingLanguages || [],
        competition: { claims, trying, offers: null },
        createdAt: r.createdAt || null,
        org: r.organization ? r.organization.name : null,
      });
    }
    if (rows.length < 30) break;
  }
  return items;
}

// ---------- Algora (scrape public org bounty pages) ----------
function parseAlgoraOrg(html, org) {
  const out = new Map();
  // card pattern: $AMOUNT ... <a href="github issue url" ...>TITLE...</a>
  const re = /\$([\d,]+)\s*<\/div>[\s\S]{0,600}?<a href="(https:\/\/github\.com\/[^"]+\/issues\/\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const amount = Number(m[1].replace(/,/g, ''));
    const url = m[2];
    const title = stripTags(m[3]).slice(0, 160) || url.split('/').slice(-3).join('/');
    const prev = out.get(url);
    if (!prev || amount > prev.amountUSD) {
      out.set(url, {
        id: `algora:${url}`,
        source: 'algora',
        title,
        url,
        amountUSD: amount,
        amountText: `$${amount.toLocaleString('en-US')}`,
        langs: [],
        competition: { claims: null, trying: null, offers: null },
        createdAt: null,
        org,
      });
    }
  }
  return [...out.values()];
}

async function fetchAlgora(cfg) {
  const items = [];
  for (const org of cfg.algoraOrgs) {
    try {
      const html = await fetchText(`https://algora.io/${org}/bounties`);
      items.push(...parseAlgoraOrg(html, org));
    } catch (e) {
      console.error(`[algora:${org}] ${e.message}`);
    }
  }
  return items;
}

// ---------- Useme (scrape listing pages) ----------
function parseUseme(html, cfg) {
  const items = [];
  // split per job card on the title anchor
  const re = /<a[^>]*class="[^"]*job__title[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const anchors = [];
  let m;
  while ((m = re.exec(html)) !== null) anchors.push({ idx: m.index, inner: m[1], tag: html.slice(Math.max(0, m.index - 0), re.lastIndex) });
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const seg = html.slice(a.idx, i + 1 < anchors.length ? anchors[i + 1].idx : a.idx + 4000);
    const hrefM = a.tag.match(/href="(\/pl\/jobs\/[^"]+)"/) || seg.match(/href="(\/pl\/jobs\/[^"]+)"/);
    if (!hrefM) continue;
    const url = `https://useme.com${hrefM[1]}`;
    if (url.includes('/category/')) continue;
    const title = stripTags(a.inner).slice(0, 160);
    const budgetM = seg.match(/job__budget-value[^>]*>([\s\S]*?)<\/(span|div)>/);
    const budgetText = budgetM ? stripTags(budgetM[1]) : '?';
    const offersM = seg.match(/job__header-details--offers"[\s\S]{0,500}?<span>\s*(\d+)\s*<\/span>/);
    const offers = offersM ? Number(offersM[1]) : null;
    // budzet np. "3000,00 EUR" / "1 500,00 PLN" / "do uzgodnienia" -> przyblizenie w USD
    const amtM = budgetText.replace(/[^\dA-Za-z,]/g, '').match(/(\d+)(?:,\d\d)?(PLN|EUR|USD|zl)/i);
    let amountUSD = null;
    if (amtM) {
      const val = Number(amtM[1]);
      const cur = amtM[2].toUpperCase();
      amountUSD = Math.round(cur === 'EUR' ? val * 1.1 : cur === 'USD' ? val : val / cfg.plnPerUsd);
    }
    items.push({
      id: `useme:${hrefM[1]}`,
      source: 'useme',
      title,
      url,
      amountUSD,
      amountText: budgetText,
      langs: [],
      competition: { claims: null, trying: null, offers: offers !== null ? Number(offers) : null },
      createdAt: null,
      org: null,
    });
  }
  return items;
}

async function fetchUseme(cfg) {
  const items = [];
  for (const cat of cfg.usemeCategories) {
    for (let page = 1; page <= cfg.usemePages; page++) {
      try {
        const url = `https://useme.com/pl/jobs/category/${cat}/${page > 1 ? `?page=${page}` : ''}`;
        const html = await fetchTextCurl(url);
        const parsed = parseUseme(html, cfg);
        if (parsed.length === 0) break;
        items.push(...parsed);
      } catch (e) {
        console.error(`[useme:${cat} p${page}] ${e.message}`);
        break;
      }
    }
  }
  // dedup across pages
  const seen = new Set();
  return items.filter(it => (seen.has(it.id) ? false : seen.add(it.id)));
}

// ---------- GitHub enrichment: konkurencja (/claim, /attempt w komentarzach + podpiete PRy) ----------
// Bez tokena: limit 60 req/h, stad twardy budzet na przebieg + cache na dysku.
function parseIssueUrl(url) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url || '');
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}

function applyGh(it, e) {
  it.competition = { ...it.competition, claims: e.claims, trying: e.prs };
  it.githubState = e.state;
}

async function enrichGithub(items, cfg) {
  const ttlMs = Math.max(1, cfg.ghCacheHours ?? 6) * 3600 * 1000;
  const cachePath = join(DATA, 'gh-cache.json');
  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch {}

  const candidates = items
    .filter(it => (it.competition?.claims === null || it.competition?.claims === undefined) && parseIssueUrl(it.url))
    .sort((a, b) => (b.amountUSD || 0) - (a.amountUSD || 0))
    .slice(0, cfg.ghEnrichTop ?? (cfg.ghToken ? 60 : 12));

  let budget = cfg.ghBudgetPerRun ?? (cfg.ghToken ? 80 : 15);
  const now = Date.now();
  for (const it of candidates) {
    const hit = cache[it.url];
    if (hit && now - hit.ts < ttlMs) { applyGh(it, hit); continue; }
    if (budget <= 0) { if (hit) applyGh(it, hit); continue; }
    const ref = parseIssueUrl(it.url);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/timeline?per_page=100`,
        { headers: ghHeaders(cfg) },
      );
      budget--;
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(remaining) && remaining < 8) budget = 0; // zostaw zapas
      if (!res.ok) { if (hit) applyGh(it, hit); continue; }
      const events = await res.json();
      if (!Array.isArray(events)) continue;
      let claims = 0, prs = 0, state = 'open';
      for (const ev of events) {
        if (ev.event === 'commented' && /\/(claim|attempt|reward)\b/i.test(ev.body || '')) claims++;
        else if (ev.event === 'cross-referenced' && ev.source?.issue?.pull_request) prs++;
        else if (ev.event === 'closed') state = 'closed';
        else if (ev.event === 'reopened') state = 'open';
      }
      const entry = { ts: now, claims, prs, state };
      cache[it.url] = entry;
      applyGh(it, entry);
    } catch { if (hit) applyGh(it, hit); }
  }
  for (const [k, v] of Object.entries(cache)) if (now - v.ts > ttlMs * 4) delete cache[k];
  await writeFile(cachePath, JSON.stringify(cache, null, 1), 'utf8');
}

// ---------- GitHub global: wyszukiwarka issues z labelem bounty (auto-odkrywanie orgow) ----------
async function fetchGithubBounties(cfg) {
  const labels = cfg.ghBountyLabels || ['💎 Bounty', 'bounty'];
  const minStars = cfg.ghMinStars ?? 30;
  const repoCachePath = join(DATA, 'repo-cache.json');
  let repoCache = {};
  try { repoCache = JSON.parse(await readFile(repoCachePath, 'utf8')); } catch {}
  const now = Date.now();
  const weekMs = 7 * 864e5;
  let lookups = cfg.ghRepoLookupsPerRun ?? (cfg.ghToken ? 40 : 8);
  const blockOrgs = new Set((cfg.ghBlockOrgs || []).map(s => s.toLowerCase()));
  const perRepo = new Map();
  const out = [];
  for (const label of labels) {
    const q = encodeURIComponent(`label:"${label}" is:open is:issue`);
    let rows;
    try {
      const res = await fetch(`https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=30`,
        { headers: ghHeaders(cfg) });
      if (!res.ok) continue;
      rows = (await res.json()).items || [];
    } catch { continue; }
    for (const r of rows) {
      const repoUrl = r.repository_url;
      const repoName = repoUrl.split('/repos/')[1] || '';
      const owner = (repoName.split('/')[0] || '').toLowerCase();
      if (blockOrgs.has(owner)) continue;
      let rc = repoCache[repoUrl];
      if ((!rc || rc.hasDesc === undefined || now - rc.ts > weekMs) && lookups > 0) {
        lookups--;
        try {
          const rr = await fetch(repoUrl, { headers: ghHeaders(cfg) });
          const remaining = Number(rr.headers.get('x-ratelimit-remaining'));
          if (Number.isFinite(remaining) && remaining < 10) lookups = 0;
          if (rr.ok) {
            const j = await rr.json();
            rc = { ts: now, stars: j.stargazers_count || 0, lang: j.language || null, hasDesc: !!(j.description && j.description.trim()) };
            repoCache[repoUrl] = rc;
          }
        } catch {}
      }
      if (!rc || rc.stars < minStars) continue; // anty-spam: tylko repo z realna spolecznoscia
      const amtM = /\$\s?([\d][\d,]*)/.exec(r.title);
      const amount = amtM ? Number(amtM[1].replace(/,/g, '')) : null;
      // farmy spamowe: star-farmowane repo bez opisu i issue bez kwoty w tytule
      if (amount === null && !rc.hasDesc) continue;
      const cnt = perRepo.get(repoUrl) || 0;
      if (cnt >= 3) continue; // max 3 issues z jednego repo (flood farm)
      perRepo.set(repoUrl, cnt + 1);
      out.push({
        id: `github:${r.html_url}`,
        source: 'github',
        title: `${repoName.split('/')[1]}#${r.number} ${r.title}`.slice(0, 160),
        url: r.html_url,
        amountUSD: amount,
        amountText: amount !== null ? `$${amount.toLocaleString('en-US')}` : '?',
        langs: rc.lang ? [rc.lang] : [],
        competition: { claims: null, trying: null, offers: null },
        createdAt: r.created_at || null,
        org: repoName.split('/')[0] || null,
      });
    }
  }
  await writeFile(repoCachePath, JSON.stringify(repoCache, null, 1), 'utf8');
  const seen = new Set();
  return out.filter(it => (seen.has(it.id) ? false : seen.add(it.id)));
}

// ---------- Freelancer.com (publiczne API projektow) ----------
const FX_USD = { USD: 1, EUR: 1.1, GBP: 1.25, CAD: 0.73, AUD: 0.65, NZD: 0.6, SGD: 0.74, HKD: 0.13, INR: 0.012, PLN: 0.27, ZAR: 0.054, BRL: 0.18, MXN: 0.05 };
async function fetchFreelancer(cfg) {
  const out = [];
  for (const query of cfg.freelancerQueries || []) {
    try {
      const res = await fetch(
        `https://www.freelancer.com/api/projects/0.1/projects/active/?query=${encodeURIComponent(query)}&limit=15&job_details=true`,
        { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const rows = (await res.json())?.result?.projects || [];
      for (const p of rows) {
        if (!p.seo_url) continue;
        const cur = p.currency?.code || 'USD';
        const fx = FX_USD[cur];
        const hi = p.budget?.maximum || p.budget?.minimum || null;
        const amountUSD = hi && fx ? Math.round(hi * fx) : null;
        if (amountUSD !== null && amountUSD < (cfg.freelancerMinUSD ?? 50)) continue; // odsiej grosze
        if (amountUSD !== null && amountUSD > (cfg.freelancerMaxUSD ?? 20000)) continue; // fejkowe budzety
        out.push({
          id: `freelancer:${p.id}`,
          source: 'freelancer',
          title: (p.title || '').slice(0, 160),
          url: `https://www.freelancer.com/projects/${p.seo_url}`,
          amountUSD,
          amountText: `${p.budget?.minimum ?? '?'}–${p.budget?.maximum ?? '?'} ${cur}`,
          langs: (p.jobs || []).slice(0, 3).map(j => j.name),
          competition: { claims: null, trying: null, offers: p.bid_stats?.bid_count ?? null },
          createdAt: p.submitdate ? p.submitdate * 1000 : null,
          org: null,
        });
      }
    } catch (e) { console.error('[freelancer]', e.message); }
  }
  const seen = new Set();
  return out.filter(it => (seen.has(it.id) ? false : seen.add(it.id)));
}

// ---------- Devpost (otwarte hackathony z nagrodami) ----------
async function fetchDevpost() {
  const res = await fetch('https://devpost.com/api/hackathons?status[]=open', { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const rows = (await res.json())?.hackathons || [];
  return rows.map(h => {
    const prize = Number(stripTags(h.prize_amount || '').replace(/[^\d]/g, '')) || null;
    return {
      id: `devpost:${h.url}`,
      source: 'devpost',
      title: (h.title || '').slice(0, 160),
      url: h.url,
      amountUSD: prize,
      amountText: prize ? `$${prize.toLocaleString('en-US')} (pula)` : '?',
      langs: (h.themes || []).slice(0, 3).map(t => t.name),
      competition: { claims: null, trying: null, offers: null },
      createdAt: null,
      org: null,
      note: stripTags(h.submission_period_dates || ''),
    };
  });
}

// ---------- scoring ----------
function applyScore(it, skillsRe) {
  const c = it.competition || {};
  let comp = null;
  if (c.offers !== null && c.offers !== undefined) comp = c.offers;
  else if (c.claims !== null && c.claims !== undefined) comp = c.claims + Math.floor((c.trying || 0) / 2);
  let verdict;
  if (comp === null || comp === undefined) verdict = 'unknown';
  else if (comp <= 2) verdict = 'hot';
  else if (comp <= 7) verdict = 'ok';
  else verdict = 'crowd';
  if (verdict === 'hot' && it.amountUSD !== null && it.amountUSD < 30) verdict = 'ok';
  // dopasowanie do umiejetnosci uzytkownika (config.skills)
  let matches = 0;
  if (skillsRe) {
    const hay = `${it.title} ${(it.langs || []).join(' ')}`;
    matches = new Set((hay.match(skillsRe) || []).map(s => s.toLowerCase())).size;
  }
  const amt = it.amountUSD || 0;
  it.skillMatch = matches;
  it.verdict = verdict;
  it.score = Math.round((amt / (1 + (comp ?? 4))) * (1 + 0.25 * Math.min(matches, 3)));
  return it;
}

export async function refreshAll() {
  const cfg = await loadConfig();
  await mkdir(DATA, { recursive: true });

  let prev = { items: [] };
  try { prev = JSON.parse(await readFile(join(DATA, 'items.json'), 'utf8')); } catch {}
  const prevById = new Map(prev.items.map(i => [i.id, i]));

  const [opire, algora, ghb, freelancer, useme, devpost] = await Promise.all([
    fetchOpire(cfg).catch(e => (console.error('[opire]', e.message), [])),
    fetchAlgora(cfg).catch(e => (console.error('[algora]', e.message), [])),
    fetchGithubBounties(cfg).catch(e => (console.error('[gh-bounty]', e.message), [])),
    fetchFreelancer(cfg).catch(e => (console.error('[freelancer]', e.message), [])),
    fetchUseme(cfg).catch(e => (console.error('[useme]', e.message), [])),
    fetchDevpost().catch(e => (console.error('[devpost]', e.message), [])),
  ]);

  // dedupe po URL: opire/algora maja pierwszenstwo przed wyszukiwarka GitHub
  const byUrl = new Map();
  for (const it of [...opire, ...algora, ...ghb, ...freelancer, ...useme, ...devpost]) {
    if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  }
  const items = [...byUrl.values()];

  const now = Date.now();
  for (const it of items) it.firstSeen = prevById.get(it.id)?.firstSeen || now;
  await enrichGithub(items, cfg).catch(e => console.error('[github]', e.message));
  const skillsRe = (cfg.skills || []).length
    ? new RegExp(`(${cfg.skills.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    : null;
  // zamkniete na GitHubie nie sa juz do wziecia
  const live = items.filter(it => it.githubState !== 'closed').map(it => applyScore(it, skillsRe));

  const payload = {
    updatedAt: now,
    counts: { opire: opire.length, algora: algora.length, github: ghb.length, freelancer: freelancer.length, useme: useme.length, devpost: devpost.length },
    items: live,
  };
  await writeFile(join(DATA, 'items.json'), JSON.stringify(payload, null, 1), 'utf8');
  return payload;
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  refreshAll().then(p => {
    console.log(`OK: ${Object.entries(p.counts).map(([k, v]) => `${k}=${v}`).join(' ')} (total ${p.items.length})`);
  }).catch(e => { console.error(e); process.exit(1); });
}
