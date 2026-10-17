@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (echo Сначала запусти setup.bat & pause & exit /b 1)
start "" wscript.exe "%~dp0start_quiet.vbs"
echo GM Whispers Core запущен в трее (значок со шляпой у часов). Закрыть: правой кнопкой по значку → Выход.
timeout /t 4 >nul
