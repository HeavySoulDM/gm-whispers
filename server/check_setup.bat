@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not exist ".venv\Scripts\python.exe" goto nosetup
".venv\Scripts\python.exe" check_setup.py
pause
exit /b 0

:nosetup
echo Сначала запусти setup.bat
pause
exit /b 1
