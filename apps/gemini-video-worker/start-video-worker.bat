@echo off
setlocal
cd /d "%~dp0"

set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" (
  echo Google Chrome was not found. Install Chrome and run this file again.
  pause
  exit /b 1
)

set "AUTOMATION_PROFILE=%LOCALAPPDATA%\AgenticMerchant\GeminiChromeProfile"
start "Agentic Gemini Chrome" /min "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%AUTOMATION_PROFILE%" --no-first-run "https://gemini.google.com/app"
timeout /t 4 /nobreak >nul

if not exist node_modules (
  echo Installing the local worker packages...
  call npm install
  if errorlevel 1 goto :failed
)

if exist .env (
  node --env-file=.env worker.mjs
) else (
  echo Missing apps\gemini-video-worker\.env. Copy .env.example to .env and fill in the two required values.
  pause
  exit /b 1
)
if errorlevel 1 goto :failed
exit /b 0

:failed
echo The Gemini video worker stopped with an error.
pause
exit /b 1
