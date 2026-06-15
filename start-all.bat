@echo off
echo Starting income-radar ecosystem...
cd /d C:\Users\PC\Documents\GitHub\income-radar

echo [1/2] Starting income-radar server (port 7777)...
start /B node server.mjs > data\server.log 2>&1

echo [2/2] Starting multi-bot (3 signal bots + admin)...
start /B node multi-bot.mjs > data\multi-bot.log 2>&1

timeout /t 3 /nobreak > nul
echo.
echo === RUNNING ===
netstat -aon | findstr :7777 | findstr LISTENING && echo Server: OK || echo Server: FAILED
echo Multi-bot: check data\multi-bot.log
echo.
echo Dashboard: http://127.0.0.1:7777
echo Admin bot: @jarkens_bot
echo Signal bots: @cshub_signals_bot @sol_sniper_signals_bot @crypto_signals_prox_bot
echo.
echo Press any key to close this window (services keep running)...
pause > nul
