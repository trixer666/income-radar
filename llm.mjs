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
  const { timeoutMs = 120_000, maxBudgetUsd = 0.10, model = 'sonnet', system = '' } = opts;
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
function fetchBrief(url) {
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
    model: opts.model ?? 'sonnet',
  });
  if (!r.ok) return r;
  return { ok: true, body: r.text, brief: brief.slice(0, 400) };
}
