@echo off
chcp 65001 >nul
title GM Whispers - расшифровка записи
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not exist ".venv\Scripts\python.exe" goto nosetup
if "%~1"=="" goto usage
".venv\Scripts\python.exe" -m gmw.transcribe %*
pause
exit /b 0

:usage
echo Перетащи zip-архив записи Craig (или папку с дорожками) на этот файл.
echo Или из командной строки: transcribe.bat "путь\к\craig.zip" [--start "2026-10-07 19:00"] [--session ID]
pause
exit /b 1

:nosetup
echo Сначала запусти setup.bat, затем setup_audio.bat
pause
exit /b 1
