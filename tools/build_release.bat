@echo off
chcp 65001 >nul
rem Сборка чистого релиза (прод-билд) в отдельную папку рядом с проектом: ..\GM_Whispers_Release
cd /d "%~dp0.."
if not exist "server\.venv\Scripts\python.exe" (echo Сначала запусти server\setup.bat & pause & exit /b 1)
"server\.venv\Scripts\python.exe" tools\build_release.py %*
pause
