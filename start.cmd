@echo off
rem Tarkov Helper - lokaal starten (Windows). Dubbelklik dit bestand.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js niet gevonden. Installeer Node 20+ van https://nodejs.org & pause & exit /b 1)
if not exist node_modules\leaflet (
  echo Eenmalig installeren...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
start "" http://localhost:3311
node server.mjs
pause
