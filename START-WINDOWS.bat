@echo off
title NEXUS Agent
cd /d "%~dp0"

echo.
echo   ============================================
echo     NEXUS Agent - starting up
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo       Download it from https://nodejs.org  ^(LTS version^)
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   Installing dependencies, this takes a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
  echo.
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo   ============================================
  echo     ONE THING LEFT - add your API key
  echo   ============================================
  echo.
  echo   I just created a .env file and will open it now.
  echo   Replace the placeholder on the XKIRO_API_KEY line
  echo   with your real key, then SAVE and close Notepad.
  echo.
  pause
  notepad .env
  echo.
)

echo   Starting NEXUS...
echo   The exact URL is printed below - if port 3000 is busy
echo   it moves to 3001, 3002... and opens your browser automatically.
echo   ^(press Ctrl+C here to stop^)
echo.
call npm start
pause
