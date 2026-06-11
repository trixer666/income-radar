@echo off
rem Instaluje autostart radaru przy logowaniu do Windows (bez okna konsoli).
rem Odinstalowanie: usun plik income-radar.vbs z folderu Autostart (shell:startup).
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\income-radar.vbs"
> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.CurrentDirectory = "%~dp0."
>> "%VBS%" echo sh.Run "cmd /c node server.mjs", 0, False
echo Zainstalowano autostart: %VBS%
echo Radar wstanie sam przy kazdym logowaniu do Windows.
pause
