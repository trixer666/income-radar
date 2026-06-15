// income-radar fetcher: Opire API + Algora org pages + Useme listings -> data/items.json
// + Upwork RSS, HackerOne community bounty list, Fiverr (best-effort), Airdrops RSS
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

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

// Krotki, deterministyczny hash do generowania ID dla zrodel bez stabilnego ID
function hash8(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

// Dekoduje najczestsze encje HTML/XML
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Pojedyncze pole w bloku RSS - obsluga CDATA i zwyklego tekstu
function rssField(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

// Parser RSS 2.0 bez zaleznosci - tylko pola ktore nas interesuja
function parseRssItems(xml) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    items.push({
      title: decodeEntities(rssField(block, 'title')),
      link: decodeEntities(rssField(block, 'link')),
      description: rssField(block, 'description'),
      pubDate: rssField(block, 'pubDate'),
    });
  }
  return items;
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
  if (e.bountyAt) it.bountyAt = e.bountyAt;
  if (e.lastAt) it.lastActivityAt = e.lastAt;
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
    if (hit && 'bountyAt' in hit && now - hit.ts < ttlMs) { applyGh(it, hit); continue; }
    if (budget <= 0) { if (hit) applyGh(it, hit); continue; }
    const ref = parseIssueUrl(it.url);
    try {
      // timeline (do 3 stron z tokenem): konkurencja + data postawienia bounty + ostatni ruch
      let events = [];
      const maxPages = cfg.ghToken ? 3 : 1;
      for (let pg = 1; pg <= maxPages; pg++) {
        const res = await fetch(
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/timeline?per_page=100&page=${pg}`,
          { headers: ghHeaders(cfg) },
        );
        budget--;
        const remaining = Number(res.headers.get('x-ratelimit-remaining'));
        if (Number.isFinite(remaining) && remaining < 8) budget = 0; // zostaw zapas
        if (!res.ok) break;
        const chunk = await res.json();
        if (!Array.isArray(chunk)) break;
        events = events.concat(chunk);
        if (chunk.length < 100 || budget <= 0) break;
      }
      if (!events.length) { if (hit) applyGh(it, hit); continue; }
      let claims = 0, prs = 0, state = 'open', bountyAt = null, lastAt = null;
      for (const ev of events) {
        const ts = ev.created_at || ev.submitted_at || null;
        if (ts) lastAt = ts;
        if (ev.event === 'commented') {
          const actor = ev.actor?.login || '';
          if (!bountyAt && (/algora|opire/i.test(actor) || /\/bounty\s+\$\d|bounty of \$\d/i.test(ev.body || ''))) bountyAt = ts;
          if (/\/(claim|attempt|reward)\b/i.test(ev.body || '')) claims++;
        }
        else if (ev.event === 'cross-referenced' && ev.source?.issue?.pull_request) prs++;
        else if (ev.event === 'closed') state = 'closed';
        else if (ev.event === 'reopened') state = 'open';
      }
      const entry = { ts: now, claims, prs, state, bountyAt, lastAt };
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

// ---------- Upwork (scraping publicznej wyszukiwarki — RSS zlikwidowane 2024) ----------
async function fetchUpwork(cfg) {
  const queries = cfg.upworkQueries || [];
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      // Publiczna strona search — curl omija Cloudflare lepiej niz node fetch
      const url = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(q)}&sort=recency&per_page=10`;
      const html = await fetchTextCurl(url);
      // Upwork renderuje danych w JSON wewnatrz <script> — szukamy serializowanego stanu
      const stateM = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!stateM) {
        // Fallback: szukaj linkow do jobow w HTML
        const links = [...html.matchAll(/href="(\/jobs\/[^"?]+)/g)].map(m => m[1]);
        const titles = [...html.matchAll(/data-test="job-tile-title"[^>]*>([^<]+)/g)].map(m => decodeEntities(m[1]));
        for (let i = 0; i < Math.min(links.length, titles.length, 10); i++) {
          const tHash = hash8(titles[i]);
          if (seen.has(tHash)) continue;
          seen.add(tHash);
          out.push({
            id: `upwork:${tHash}`,
            source: 'upwork',
            title: titles[i].slice(0, 160),
            url: `https://www.upwork.com${links[i]}`,
            amountUSD: null,
            amountText: '?',
            langs: [],
            competition: { claims: null, trying: null, offers: null },
            createdAt: null,
            org: null,
          });
        }
        if (!links.length) console.log(`[upwork:${q}] JS-rendered, scraping limited`);
        continue;
      }
      // Parse __NEXT_DATA__ JSON
      try {
        const nd = JSON.parse(stateM[1]);
        const jobs = nd?.props?.pageProps?.searchResults?.jobs || [];
        for (const j of jobs.slice(0, 10)) {
          const title = j.title || '';
          const tHash = hash8(title);
          if (seen.has(tHash)) continue;
          seen.add(tHash);
          let amountUSD = null, amountText = '?';
          if (j.amount?.amount) {
            amountUSD = Math.round(Number(j.amount.amount));
            amountText = `$${amountUSD.toLocaleString('en-US')}`;
          } else if (j.hourlyBudget?.min != null) {
            const lo = Number(j.hourlyBudget.min);
            const hi = Number(j.hourlyBudget.max || lo);
            amountUSD = Math.round(hi * 40);
            amountText = `$${lo}-$${hi}/h`;
          }
          const langs = (j.skills || j.attrs?.skills || []).map(s => typeof s === 'string' ? s : (s.name || s.prettyName || '')).filter(Boolean).slice(0, 6);
          const proposals = j.proposalCount ?? j.totalApplicants ?? null;
          out.push({
            id: `upwork:${tHash}`,
            source: 'upwork',
            title: title.slice(0, 160),
            url: j.ciphertext ? `https://www.upwork.com/jobs/${j.ciphertext}` : `https://www.upwork.com/jobs/~${j.id || tHash}`,
            amountUSD,
            amountText,
            langs,
            competition: { claims: null, trying: null, offers: proposals },
            createdAt: j.createdOn ? Date.parse(j.createdOn) : null,
            org: null,
          });
        }
      } catch { /* zepsuta struktura NEXT_DATA, pomijamy */ }
    } catch (e) {
      console.error(`[upwork:${q}] ${e.message}`);
    }
  }
  return out;
}

// ---------- HackerOne / Bug Bounty (lista z GitHub, publiczna i bez auth) ----------
async function fetchHackerOneBounties(_cfg) {
  // Probujemy kilka znanych lokalizacji listy bug bounty programow
  const urls = [
    'https://raw.githubusercontent.com/projectdiscovery/public-bugbounty-programs/main/chaos-bugbounty-list.json',
    'https://raw.githubusercontent.com/projectdiscovery/public-bugbounty-programs/master/chaos-bugbounty-list.json',
    'https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/hackerone_data.json',
  ];
  for (const url of urls) {
    try {
      const raw = await fetchText(url);
      const data = JSON.parse(raw);
      // Obsluga obu formatow: {programs:[...]} lub [{...}]
      const programs = Array.isArray(data.programs) ? data.programs : (Array.isArray(data) ? data : []);
      if (!programs.length) continue;
      const bountyProgs = programs.filter(p => p && (p.bounty || p.offers_bounties) && (p.url || p.handle));
      return bountyProgs.slice(-40).reverse().slice(0, 25).map(p => {
        const name = p.name || p.handle || (p.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        const domCount = Array.isArray(p.domains) ? p.domains.length : (p.targets?.in_scope?.length || 0);
        const pUrl = p.url || (p.handle ? `https://hackerone.com/${p.handle}` : '');
        return {
          id: `h1bounty:${hash8(pUrl || name)}`,
          source: 'h1bounty',
          title: `${name} - bug bounty${domCount ? ` (${domCount} domen)` : ''}`.slice(0, 160),
          url: pUrl,
          amountUSD: null,
          amountText: p.swag ? 'Bounty + swag' : 'Bounty',
          langs: ['security', 'bug-bounty'],
          competition: { claims: null, trying: null, offers: null },
          createdAt: null,
          org: name,
        };
      });
    } catch (e) {
      console.error(`[h1bounty] ${e.message} for ${url}`);
    }
  }
  console.error('[h1bounty] all sources failed');
  return [];
}

// ---------- Fiverr (best-effort scrape; w wiekszosci JS-rendered) ----------
async function fetchFiverrBuyerGigs(cfg) {
  const queries = cfg.fiverrQueries || [];
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(q)}&source=top-bar&search_in=everywhere&search-autocomplete-original-term=${encodeURIComponent(q)}`;
      let html;
      try { html = await fetchTextCurl(url); }
      catch (e) { console.log(`[fiverr:${q}] JS-rendered, skipping (${e.message})`); continue; }
      // anchor do oferty: dwusegmentowa sciezka /<seller>/<gig-slug>, czesto z atrybutem trackingowym
      const gigRe = /href="(\/[a-z0-9_-]+\/[a-z0-9][a-z0-9-]{6,})"/gi;
      const found = [];
      let m;
      while ((m = gigRe.exec(html)) !== null) {
        const path = m[1];
        if (seen.has(path)) continue;
        // odsiej linki nawigacyjne typu /categories/...
        if (/^\/(categories|cp|help|gigs|landing|inspire|business|pro|logo-maker|studio)\b/.test(path)) continue;
        seen.add(path);
        found.push(path);
        if (found.length >= 12) break;
      }
      if (found.length === 0) { console.log(`[fiverr:${q}] JS-rendered, skipping (brak gigow w HTML)`); continue; }
      for (const path of found) {
        const slug = path.split('/').pop().replace(/-/g, ' ');
        out.push({
          id: `fiverr:${hash8(path)}`,
          source: 'fiverr',
          title: `Fiverr [${q}]: ${slug}`.slice(0, 160),
          url: `https://www.fiverr.com${path}`,
          amountUSD: null,
          amountText: '?',
          langs: [q],
          competition: { claims: null, trying: null, offers: null },
          createdAt: null,
          org: null,
        });
      }
    } catch (e) {
      console.error(`[fiverr:${q}] ${e.message}`);
    }
  }
  return out;
}

// ---------- Airdrops.io (RSS z bezplatnymi airdropami / testnetami) ----------
async function fetchAirdrops(cfg) {
  if (cfg.airdropEnabled === false) return [];
  try {
    const xml = await fetchText('https://airdrops.io/feed/');
    const items = parseRssItems(xml).slice(0, 15);
    return items.filter(it => it.title && it.link).map(it => ({
      id: `airdrop:${hash8(it.link)}`,
      source: 'airdrop',
      title: it.title.slice(0, 160),
      url: it.link,
      amountUSD: 0,
      amountText: 'Airdrop',
      langs: ['crypto', 'airdrop'],
      competition: { claims: null, trying: null, offers: null },
      createdAt: it.pubDate ? (Date.parse(it.pubDate) || null) : null,
      org: null,
    }));
  } catch (e) {
    console.error(`[airdrop] ${e.message}`);
    return [];
  }
}

// ---------- scoring ----------
function applyScore(it, skillsRe, repoCache) {
  // Zrodla informacyjne (bez konkurencji / kwoty) - stale punkty bazowe
  if (it.source === 'airdrop') {
    it.verdict = 'unknown'; it.skillMatch = 0; it.ageDays = null;
    it.repoHealth = null; it.score = 30; return it;
  }
  if (it.source === 'h1bounty') {
    it.verdict = 'unknown'; it.skillMatch = 0; it.ageDays = null;
    it.repoHealth = null; it.score = 50; return it;
  }
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
  // realny wiek bounty/ogloszenia (nie data wykrycia przez radar) + kara za stare wraki
  const rawT = it.bountyAt ?? it.createdAt;
  const t = typeof rawT === 'number' ? rawT : (rawT ? Date.parse(rawT) : NaN);
  it.ageDays = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 864e5)) : null;
  let freshness = 1;
  if (it.ageDays !== null) freshness = it.ageDays > 365 ? 0.4 : it.ageDays > 180 ? 0.6 : it.ageDays > 60 ? 0.8 : 1;
  // dopasowanie do umiejetnosci uzytkownika (config.skills)
  let matches = 0;
  if (skillsRe) {
    const hay = `${it.title} ${(it.langs || []).join(' ')}`;
    matches = new Set((hay.match(skillsRe) || []).map(s => s.toLowerCase())).size;
  }
  const amt = it.amountUSD || 0;
  it.skillMatch = matches;
  it.verdict = verdict;
  let score = (amt / (1 + (comp ?? 4))) * (1 + 0.25 * Math.min(matches, 3)) * freshness;
  // bonus/kara od kondycji repo - dotyczy zrodel z linkiem do GitHub issue
  let repoHealth = null;
  if (repoCache && (it.source === 'opire' || it.source === 'algora' || it.source === 'github')) {
    const m = /github\.com\/([^/]+)\/([^/]+)\//.exec(it.url || '');
    if (m) {
      const rc = repoCache[`https://api.github.com/repos/${m[1]}/${m[2]}`];
      if (rc) {
        if (rc.archived) { score *= 0.1; repoHealth = 'archived'; }
        else if (rc.pushedAt) {
          const ageDays = (Date.now() - Date.parse(rc.pushedAt)) / 864e5;
          if (ageDays <= 30) { score *= 1.3; repoHealth = 'active'; }
          else if (ageDays <= 90) { score *= 1.1; repoHealth = 'active'; }
          else if (ageDays > 180) { score *= 0.5; repoHealth = 'stale'; }
        }
        if ((rc.forks || 0) > 50) score *= 1.1;
      }
    }
  }
  it.repoHealth = repoHealth;
  it.score = Math.round(score);
  return it;
}

// Filtr jakosci repo dla nagrod Opire - ten sam prog gwiazdek co wyszukiwarka GitHub
async function filterRepoQuality(items, cfg) {
  const minStars = cfg.ghMinStars ?? 30;
  const repoCachePath = join(DATA, 'repo-cache.json');
  let repoCache = {};
  try { repoCache = JSON.parse(await readFile(repoCachePath, 'utf8')); } catch {}
  const now = Date.now();
  const weekMs = 7 * 864e5;
  let lookups = cfg.ghToken ? 50 : 5;
  const keep = [];
  for (const it of items) {
    const m = /github\.com\/([^/]+)\/([^/]+)\//.exec(it.url || '');
    if (!m) { keep.push(it); continue; } // nie-GitHub (GitLab itp.): zostaw
    const repoUrl = `https://api.github.com/repos/${m[1]}/${m[2]}`;
    let rc = repoCache[repoUrl];
    if ((!rc || now - rc.ts > weekMs) && lookups > 0) {
      lookups--;
      try {
        const rr = await fetch(repoUrl, { headers: ghHeaders(cfg) });
        const remaining = Number(rr.headers.get('x-ratelimit-remaining'));
        if (Number.isFinite(remaining) && remaining < 8) lookups = 0;
        if (rr.ok) {
          const j = await rr.json();
          rc = { ts: now, stars: j.stargazers_count || 0, lang: j.language || null, hasDesc: !!(j.description && j.description.trim()), pushedAt: j.pushed_at || null, openIssues: j.open_issues_count || 0, archived: !!j.archived, forks: j.forks_count || 0 };
          repoCache[repoUrl] = rc;
        }
      } catch {}
    }
    if (rc && (rc.archived || rc.stars < minStars)) continue; // repo-smiec lub porzucony: nagroda niewiarygodna
  }
  await writeFile(repoCachePath, JSON.stringify(repoCache, null, 1), 'utf8');
  return keep;
}

export async function refreshAll() {
  const cfg = await loadConfig();
  await mkdir(DATA, { recursive: true });

  let prev = { items: [] };
  try { prev = JSON.parse(await readFile(join(DATA, 'items.json'), 'utf8')); } catch {}

  const prevById = new Map(prev.items.map(i => [i.id, i]));

  const [opire, algora, ghb, freelancer, useme, devpost, upwork, h1bounty, fiverr, airdrops] = await Promise.all([
    fetchOpire(cfg).catch(e => (console.error('[opire]', e.message), [])),
    fetchAlgora(cfg).catch(e => (console.error('[algora]', e.message), [])),
    fetchGithubBounties(cfg).catch(e => (console.error('[gh-bounty]', e.message), [])),
    fetchFreelancer(cfg).catch(e => (console.error('[freelancer]', e.message), [])),
    fetchUseme(cfg).catch(e => (console.error('[useme]', e.message), [])),
    fetchDevpost().catch(e => (console.error('[devpost]', e.message), [])),
    fetchUpwork(cfg).catch(e => (console.error('[upwork]', e.message), [])),
    fetchHackerOneBounties(cfg).catch(e => (console.error('[h1bounty]', e.message), [])),
    fetchFiverrBuyerGigs(cfg).catch(e => (console.error('[fiverr]', e.message), [])),
    fetchAirdrops(cfg).catch(e => (console.error('[airdrop]', e.message), [])),
  ]);

  // Opire nie waliduje nagrod: odsiej "rewardy" z repo-smieci (0 gwiazdek, scam/test)
  const opireClean = await filterRepoQuality(opire, cfg).catch(e => (console.error('[repo-filter]', e.message), opire));
  // repoCache zapisany przez filterRepoQuality; wczytujemy do scoringu zdrowia repo
  let repoCache = {};
  try { repoCache = JSON.parse(await readFile(join(DATA, 'repo-cache.json'), 'utf8')); } catch {}

  // dedupe po URL: opire/algora maja pierwszenstwo przed wyszukiwarka GitHub
  const byUrl = new Map();
  for (const it of [...opireClean, ...algora, ...ghb, ...freelancer, ...useme, ...devpost, ...upwork, ...h1bounty, ...fiverr, ...airdrops]) {
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
  const live = items.filter(it => it.githubState !== 'closed').map(it => applyScore(it, skillsRe, repoCache));

  const payload = {
    updatedAt: now,
    counts: { opire: opire.length, algora: algora.length, github: ghb.length, freelancer: freelancer.length, useme: useme.length, devpost: devpost.length, upwork: upwork.length, h1bounty: h1bounty.length, fiverr: fiverr.length, airdrop: airdrops.length },
    items: live,
  };
  await writeFile(join(DATA, 'items.json'), JSON.stringify(payload, null, 1), 'utf8');
  return { ...payload, repoCache };
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  refreshAll().then(p => {
    console.log(`OK: ${Object.entries(p.counts).map(([k, v]) => `${k}=${v}`).join(' ')} (total ${p.items.length})`);
  }).catch(e => { console.error(e); process.exit(1); });
}
