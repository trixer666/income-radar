@echo off
rem Profil automatyzacji: osobny Chrome z CDP, w ktorym logujesz sie RAZ
rem (Google/GitHub) do: Useme, Algora, Opire, Freelancer, Prolific, Devpost.
rem Agent podlacza sie do portu 9333 i dziala na Twoich sesjach - tylko na polecenie.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9333 ^
  --user-data-dir="%~dp0data\chrome-profile" ^
  --no-first-run --no-default-browser-check ^
  "http://127.0.0.1:7777"
