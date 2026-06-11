# income-radar — protokol agenta ("kolejka")

Panel: http://127.0.0.1:7777 (start.cmd). Uzytkownik oznacza pozycje statusem
"do agenta", agent w sesji przetwarza kolejke i odklada szkice. Haslo: **kolejka**.

## Petla

1. Przeczytaj `data/items.json` oraz `data/state.json`.
   Kolejka = pozycje, dla ktorych `state.itemStatus[id] === 'agent'`.
2. Dla kazdej pozycji otworz `url` i przygotuj `body` szkicu:
   - `useme` -> kind `oferta`: gotowa do wklejenia odpowiedz PL na zlecenie.
     Struktura: 1 zdanie haka pod konkretne zlecenie, dowod kompetencji
     (konkrety, nie ogolniki), 1-2 pytania doprecyzowujace, widelka + termin.
   - `freelancer` -> kind `oferta`: jak wyzej, ale PO ANGIELSKU (bid na
     Freelancer.com); uwzglednij liczbe ofert i widelki budzetu.
   - `opire`/`algora`/`github` -> kind `analiza`: werdykt GO/NO-GO + plan.
     Struktura: co jest zepsute/oczekiwane, gdzie w repo lezy problem,
     plan naprawy krok po kroku, realna konkurencja (claimy/PRy + ogon
     watku na GitHubie!), szacunek czasu, ryzyka (maintainer nie merguje,
     wymagane CLA, bounty w tokenach zamiast USD).
   - `devpost` -> kind `analiza`: czy realne miejsce w niszy (tracki
     sponsorskie maja mniejsza konkurencje niz grand prize), wymagania
     zgloszenia, deadline, pomysl na projekt mozliwy do zbudowania.
3. Zapisz szkice do `data/drafts.json` jako
   `{ "<itemId>": { "ts": <ms>, "kind": "oferta"|"analiza", "title": "...", "url": "...", "body": "..." } }`
   - serwer dziala -> `POST /api/drafts` (merge po kluczu; `null` usuwa wpis),
   - serwer nie dziala -> edytuj plik bezposrednio (ten sam format).
4. Ustaw pozycji status `szkic` przez `POST /api/state`
   (`{ "itemStatus": { "<id>": "szkic" } }`).
5. Po akceptacji szkicu przez uzytkownika kolejne kroki (PR do bounty,
   wyslanie oferty na Useme) wykonuj TYLKO na wyrazne polecenie.

## Zasady

- NIGDY nie wysylaj niczego automatycznie (GitHub, Useme) bez polecenia.
- Szkice ofert po polsku; zwiezle, bez lania wody, zero AI-frazesow.
- Bounty: preferuj male/srednie kwoty z niska konkurencja (verdict WARTO/OK);
  unikaj issue z >2 claimami albo zamknietych (fetcher je odfiltrowuje).
- Statusy cyklu: `agent` -> `szkic` -> (user) `claim`/`PR wyslany` -> `wyplacone`.

## Zalogowane akcje (Chrome CDP)

Uzytkownik loguje sie RAZ w osobnym profilu Chrome: `chrome-debug.cmd`
(port CDP 9333, profil w `data/chrome-profile` - NIE commitowac).

- Podlaczenie: browser tool, `open` z `app.cdp_url = "http://127.0.0.1:9333"`.
- Jesli port nie odpowiada -> popros uzytkownika o odpalenie `chrome-debug.cmd`.
- DOZWOLONE bez pytania: czytanie zalogowanych stron (leaderboard i globalna
  tablica Algora, oferty/wiadomosci Useme, badania Prolific, bidy Freelancer),
  wypelnianie formularzy BEZ wysylania.
- ZABRONIONE bez wyraznego polecenia: klik "wyslij/submit/claim/bid",
  jakakolwiek zmiana ustawien kont, operacje platnicze.
- Po akcji zostaw notke w szkicu pozycji (co zrobiono, link).
- Prolific/Outlier/Mindrift: wolno sprawdzac dostepnosc badan/taskow,
  NIGDY nie wykonuj samych taskow/ankiet (ban za automatyzacje).
