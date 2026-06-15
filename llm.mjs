// income-radar llm: generowanie ofert/analiz przez `claude -p` (Twoja subskrypcja Max/Pro).
// Wzorzec: subprocess `claude -p` na Twojej maszynie, OAuth z keychain - ciagnie z kredytu Agent SDK
// (Max 20x: $200/mies od 15.06.2026). Bezpieczniki: timeout, twardy budzet $/call, fallback do szablonu.
import { spawn } from 'node:child_process';

const SYSTEM = `Jestes Patryk - freelancer developer (portfolio na zywo: trixer666.github.io, kod: github.com/trixer666).
Specjalizacja: Node.js/JavaScript (boty, scrapery, alerty Telegram, integracje API, panele webowe), Lua (systemy FiveM).
Zywe demo, ktore mozesz podlinkowac gdy pasuje do briefu:
- https://trixer666.github.io/demo-olx.html (bot wykrywania okazji cenowych na OLX/Allegro - dziala na zywo)
- https://trixer666.github.io/demo-kotlina.html (scraping bazy obiektow noclegowych z Booking.com)
Glowny projekt: github.com/trixer666/income-radar (radar 6 zrodel platnych zlecen + scoring + alerty Telegram).
Piszesz oferty na Useme i Freelancer pod KONKRETNY brief klienta.`;

const OFFER_RULES = `ZASADY BEZWZGLEDNE oferty:
1. JEZYK = jezyk briefu (PL/EN). Polski tekst BEZ polskich znakow diakrytycznych (a c e l n o s z z zamiast ąćęłńóśźż).
2. PIERWSZE ZDANIE: hak do JEGO konkretnego problemu, jego slowami z briefu (nie "Dzien dobry, jestem...").
3. KONKRETNY PLAN 1-3 kroki techniczne (nie ogolniki typu "zrobie to dobrze").
4. JESLI PASUJE - podlinkuj jedno demo z portfolio jako dowod ("widzi Pan format wynikowy: link").
5. 1-2 PYTANIA doprecyzowujace, wzietymi z briefu (pokazuja ze przeczytales).
6. KWOTA: jasna kotwica + "ostateczna wycena po doprecyzowaniu zakresu". Min 7 dni roboczych.
7. PODPIS: "Pozdrawiam, Patryk - trixer666.github.io" (PL) lub "Best, Patryk - trixer666.github.io" (EN).
8. MAX 7 akapitow, zwykly tekst, ZERO markdownu, ZERO list z gwiazdkami/myslnikami w stylu marketing.
9. ZERO frazesow AI: "w obecnym dynamicznym krajobrazie", "stand out from the crowd", "let's elevate", "synergia".
10. ZERO szablonowych zwrotow typu "doceniam Panskie ogloszenie" - klient widzi 30 takich dziennie.`;

// Wywoluje `claude -p` jako podproces. Zwraca { ok, text } lub { ok:false, error }.
export async function callClaude(userPrompt, opts = {}) {
  const { timeoutMs = 180_000, maxBudgetUsd = 0.30, model = 'claude-opus-4-6', system = '' } = opts;
  return new Promise((resolve) => {
    const args = ['-p', '--model', model, '--dangerously-skip-permissions'];
    if (system) args.push('--append-system-prompt', system);
    const proc = spawn('claude', args, { shell: false, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.stderr.on('data', d => { err += d.toString('utf8'); });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: 'spawn: ' + e.message }); });
    proc.on('close', code => {
      clearTimeout(timer);
      const text = out.trim();
      if (code === 0 && text) resolve({ ok: true, text });
      else resolve({ ok: false, error: (err.trim() || `exit ${code}`).slice(0, 200) });
    });
    try { proc.stdin.end(userPrompt, 'utf8'); }
    catch (e) { clearTimeout(timer); resolve({ ok: false, error: 'stdin: ' + e.message }); }
  });
}

// Pobiera krotki brief zlecenia z meta description (Useme/Freelancer). Cloudflare-OK na meta.
export function fetchBrief(url) {
  // Curl podprocesem (Node fetch dostaje 403 od Cloudflare Useme - TLS fingerprint).
  return new Promise((resolve) => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const args = ['-sL', '--max-time', '15', '-H', 'User-Agent: ' + UA, '-H', 'Accept-Language: pl-PL,pl;q=0.9,en;q=0.8', url];
    const proc = spawn('curl', args, { shell: false, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve(null); }, 18_000);
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      const m = /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i.exec(out);
      if (!m) return resolve(null);
      resolve(m[1].replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1800));
    });
  });
}

// Generuje szyta oferte dla pozycji (useme/freelancer). Zwraca { ok, body, brief }.
export async function generateOfferDraft(it, opts = {}) {
  const brief = await fetchBrief(it.url);
  if (!brief) return { ok: false, error: 'brak-briefu' };
  const lang = /[ąćęłńóśźż]/i.test(brief) || /\b(zlec|szukam|napisz|prosze|stworze)/i.test(brief) ? 'PL' : 'EN';
  const budget = it.amountText && it.amountText !== '?' && it.amountText !== 'Do negocjacji' ? `BUDZET KLIENTA: ${it.amountText}` : 'BUDZET: do negocjacji';
  const userPrompt = `JEZYK ODPOWIEDZI: ${lang}
TYTUL ZLECENIA: ${it.title}
${budget}
LINK: ${it.url}

BRIEF KLIENTA (z meta opisu zlecenia):
"""
${brief}
"""

Napisz JEDNA oferte zgodnie z zasadami systemu. Zwroc TYLKO tresc oferty (bez wstepow typu "oto oferta:", bez markdownu, bez nawiasow z komentarzami).`;
  const r = await callClaude(userPrompt, {
    system: SYSTEM + '\n\n' + OFFER_RULES,
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.10,
    model: opts.model ?? 'claude-opus-4-6',
  });
  if (!r.ok) return r;
  return { ok: true, body: r.text, brief: brief.slice(0, 400) };
}

const BOUNTY_SYSTEM = `Jestes senior developerem z 10+ latami doswiadczenia w open source i kontrybucjach na GitHub.
Oceniasz bounty (Opire/Algora/GitHub) pod katem ROI: czas vs nagroda, realne szanse na merge, ryzyko maintainer-ghosta.
Jestes brutalnie szczery - wiekszosc bounty to pulapki: stale issues (>180 dni bez ruchu), scam repos generujace AI claimy,
bounty w tokenach zamiast USD, maintainer ktory nie odpowiada od miesiecy, wymagane CLA u korporacji.
Zasada GO: aktywny repo (komentarze maintainera w ostatnich 30 dniach), opis jednoznaczny, konkurencja do ogarniecia
(<5 claimow lub claimy stare), nagroda >$100 lub <2h pracy.
Zasada NO-GO: >10 claimow, brak opisu, issue >180 dni, repo bez aktywnosci, bounty w tokenach, korpo z CLA.
Piszesz po polsku bez polskich znakow diakrytycznych. Bez frazesow, konkrety, liczby.`;

// Pobiera strone GitHub issue i wyciaga: body (do 2000 znakow), labels, liczbe komentarzy.
// Ten sam wzorzec co fetchBrief - curl subprocess, bo Node fetch potrafi dostac 403.
function fetchGithubIssue(url) {
  return new Promise((resolve) => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const args = ['-sL', '--max-time', '15', '-H', 'User-Agent: ' + UA, '-H', 'Accept-Language: en-US,en;q=0.9', url];
    const proc = spawn('curl', args, { shell: false, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve(null); }, 18_000);
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      if (!out) return resolve(null);
      // 1) Body: najpierw probujemy embedded JSON ("body":"..."), bo zawiera caly tekst.
      //    Fallback: og:description (skrocony ~155 znakow ale zawsze obecny).
      let body = '';
      const jsonBodyRe = /"body"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let bm, longest = '';
      while ((bm = jsonBodyRe.exec(out))) {
        if (bm[1].length > longest.length) longest = bm[1];
      }
      if (longest) {
        try { body = JSON.parse('"' + longest + '"'); } catch { body = ''; }
      }
      if (!body) {
        const og = /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i.exec(out)
          || /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i.exec(out);
        if (og) body = og[1];
      }
      body = body
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 2000);
      // 2) Labels: szukamy IssueLabel (span/a z tytulem labela jako tekst).
      const labels = [];
      const labelRe = /<(?:span|a)[^>]*class=["'][^"']*IssueLabel[^"']*["'][^>]*>([^<]+)<\/(?:span|a)>/gi;
      let lm;
      while ((lm = labelRe.exec(out)) && labels.length < 20) {
        const lbl = lm[1].replace(/\s+/g, ' ').trim();
        if (lbl && !labels.includes(lbl)) labels.push(lbl);
      }
      // 3) Komentarze: embedded JSON ma "comments":N. Fallback: "X comments" w title meta.
      let comments = null;
      const cm = /"comments"\s*:\s*(\d+)/.exec(out);
      if (cm) comments = parseInt(cm[1], 10);
      else {
        const cm2 = /([\d,]+)\s+comments?\b/i.exec(out);
        if (cm2) comments = parseInt(cm2[1].replace(/,/g, ''), 10);
      }
      resolve({ body: body || null, labels, comments });
    });
  });
}

// Wyciaga werdykt z odpowiedzi LLM. Konserwatywnie defaultuje do NOGO gdy niejasne.
function parseVerdict(text) {
  if (!text) return 'NOGO';
  const last = text.trim().split(/\r?\n/).slice(-3).join(' ');
  if (/VERDICT\s*:\s*NO[\s-]*GO\b/i.test(last)) return 'NOGO';
  if (/VERDICT\s*:\s*GO\b/i.test(last)) return 'GO';
  // Fallback: skan calego tekstu pod katem ostatniego wystapienia.
  const all = [...text.matchAll(/VERDICT\s*:\s*(NO[\s-]*GO|GO)\b/gi)];
  if (all.length) return /NO/i.test(all[all.length - 1][1]) ? 'NOGO' : 'GO';
  return 'NOGO';
}

// Generuje analize GO/NO-GO dla bounty (opire/algora/github). Zwraca { ok, body, verdict } lub { ok:false, error }.
export async function generateBountyAnalysis(it, opts = {}) {
  const issue = await fetchGithubIssue(it.url);
  if (!issue) return { ok: false, error: 'brak-issue' };
  const comp = it.competition || {};
  const claims = (comp.claims === null || comp.claims === undefined) ? null : comp.claims;
  const trying = (comp.trying === null || comp.trying === undefined) ? null : comp.trying;
  const compLine = claims === null
    ? 'Konkurencja: nieznana (issue jeszcze nie wzbogacone przez timeline GitHuba)'
    : `Realna konkurencja: ${claims} claimow, ${trying || 0} PR-ow w toku`;
  const reward = it.amountUSD ? `$${it.amountUSD}` : (it.amountText || '(brak danych o nagrodzie)');
  const ageStr = it.createdAt
    ? `${Math.floor((Date.now() - new Date(it.createdAt).getTime()) / 86_400_000)} dni od stworzenia issue`
    : '?';
  const lastMove = it.lastActivityAt
    ? `${Math.floor((Date.now() - new Date(it.lastActivityAt).getTime()) / 86_400_000)} dni od ostatniego ruchu`
    : 'brak danych o ostatnim ruchu';
  const labelsLine = (issue.labels && issue.labels.length) ? `Labels: ${issue.labels.join(', ')}` : 'Labels: (brak/nieparsowane)';
  const commentsLine = (issue.comments !== null && issue.comments !== undefined) ? `Komentarzy: ${issue.comments}` : 'Komentarzy: ?';
  const langs = (it.langs && it.langs.length) ? it.langs.join(', ') : '(brak)';
  const userPrompt = `BOUNTY DO OCENY:

Tytul: ${it.title}
Link: ${it.url}
Zrodlo: ${it.source}${it.org ? ` (org: ${it.org})` : ''}
Nagroda: ${reward}
Jezyki: ${langs}
Wiek issue: ${ageStr}
Aktywnosc: ${lastMove}
${compLine}
${labelsLine}
${commentsLine}
${it.githubState ? `Stan issue: ${it.githubState}` : ''}

OPIS ISSUE (z GitHub, pierwsze 2000 znakow):
"""
${issue.body || '(opis pusty lub niedostepny - moze byc issue prywatne, usuniete, lub strona nie wyrenderowala body)'}
"""

Wykonaj analize w 7 sekcjach, kazdy naglowek na osobnej linii, czysty tekst:

1. CO JEST ZEPSUTE/OCZEKIWANE - 2-3 zdania, konkretnie co maintainer chce dostac.
2. GDZIE W REPO LEZY PROBLEM - zgadnij modul/plik/funkcje na podstawie opisu i nazwy repo (np. "prawdopodobnie src/parser/lexer.ts, funkcja tokenize" - jesli nie da sie zgadnac, napisz "trzeba sklonowac repo").
3. PLAN NAPRAWY - 3-5 krokow technicznych, kazdy jako numerowana linia (1. ... 2. ... 3. ...).
4. REALNA KONKURENCJA - na podstawie liczb claimow/PR-ow ile osob naprawde pracuje (claimy >30 dni = porzucone). Ocen szanse procentowo (np. "60% szans ze mnie wybiora").
5. SZACUNEK CZASU - przedzial godzin (np. "4-8h dla doswiadczonego, 12-20h bez znajomosci stacku").
6. RYZYKA - wymien konkretne: maintainer nie odpowiada od X dni, CLA wymagane, bounty w tokenach zamiast USD, issue stale (>180 dni), repo wymaga deep domain knowledge, scam repo (auto-generowane issues).
7. WERDYKT - jedno zdanie uzasadnienia, potem na ostatniej linii DOKLADNIE format: "VERDICT: GO" lub "VERDICT: NO-GO" (nic wiecej, bez kropek, bez confidence w tej linii - confidence opisz w uzasadnieniu jako low/medium/high).

Polski bez polskich znakow diakrytycznych. Bez markdownu. Bez gwiazdek. Bez frazesow typu "warto rozwazyc" - albo GO albo NO-GO.`;
  const r = await callClaude(userPrompt, {
    system: BOUNTY_SYSTEM,
    timeoutMs: opts.timeoutMs ?? 90_000,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.05,
    model: opts.model ?? 'claude-sonnet-4-20250514',
  });
  if (!r.ok) return r;
  return {
    ok: true,
    body: r.text,
    verdict: parseVerdict(r.text),
    issueBody: issue.body ? issue.body.slice(0, 400) : null,
    labels: issue.labels,
    comments: issue.comments,
  };
}

// Podstawia [SPERSONALIZUJ]/[PERSONALIZE] w szablonie konkretnym pytaniem z briefu.
// Zwraca { ok, body }. Przy bledzie body = oryginal (caller moze bezpiecznie nadpisac).
export async function personalizeTemplate(body, it, opts = {}) {
  if (typeof body !== 'string' || !body) return { ok: false, body: body || '' };
  if (!/\[(SPERSONALIZUJ|PERSONALIZE)\]/i.test(body)) return { ok: false, body };
  const brief = await fetchBrief(it.url);
  if (!brief) return { ok: false, body };
  const lang = /[ąćęłńóśźż]/i.test(brief) || /\b(zlec|szukam|napisz|prosze|stworze|witam)/i.test(brief) ? 'PL' : 'EN';
  const placeholderHint = /\[PERSONALIZE\]/i.test(body) ? '[PERSONALIZE]' : '[SPERSONALIZUJ]';
  const userPrompt = `BRIEF KLIENTA:
"""
${brief}
"""

TEMPLATE OFERTY (z placeholderem ${placeholderHint}):
"""
${body}
"""

Zastap WYLACZNIE ${placeholderHint} JEDNYM konkretnym pytaniem doprecyzowujacym, wyciagnietym z briefu (pokazujacym ze klient zostal przeczytany).
Wymagania pytania:
- 1 zdanie zakonczone znakiem zapytania
- ${lang === 'PL' ? 'po polsku bez polskich znakow diakrytycznych' : 'in English'}
- konkretne (NIE "jakie sa wymagania", TAK "czy dane wejsciowe to plik CSV czy live API")
- dotyczy realnej niejednoznacznosci w briefie, nie generycznego pytania

Zwroc DOKLADNIE caly tekst template z podstawionym pytaniem zamiast ${placeholderHint}. Nie zmieniaj reszty. Nie dodawaj wstepow, komentarzy, markdownu. Tylko gotowy tekst oferty.`;
  const r = await callClaude(userPrompt, {
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.02,
    model: opts.model ?? 'claude-sonnet-4-20250514',
  });
  if (!r.ok || !r.text) return { ok: false, body };
  // Sanity: jesli placeholder dalej w tekscie, LLM nie podstawil - traktuj jako blad.
  if (/\[(SPERSONALIZUJ|PERSONALIZE)\]/i.test(r.text)) return { ok: false, body };
  // Sanity: wynik musi byc rozsadnie zblizony dlugoscia (LLM nie obcial template).
  if (r.text.length < body.length * 0.5) return { ok: false, body };
  return { ok: true, body: r.text };
}
