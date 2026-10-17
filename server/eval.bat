@echo off
chcp 65001 >nul
title GM Whispers - контрольный набор
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not exist ".venv\Scripts\python.exe" (echo Сначала запусти setup.bat & pause & exit /b 1)
rem Без параметров - только поиск (бесплатно). eval.bat --llm - полный ответ советника (платно). eval.bat --save - сохранить результат.
".venv\Scripts\python.exe" -m gmw.evaluate %*
pause
