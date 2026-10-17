@echo off
chcp 65001 >nul
rem Сборка GM Whispers Core в exe (для раздачи тем, кто не хочет ставить Python). Нужен setup.bat.
cd /d "%~dp0..\server"
if not exist ".venv\Scripts\python.exe" (echo Сначала запусти server\setup.bat & pause & exit /b 1)
".venv\Scripts\python.exe" -m pip install "pyinstaller>=6.6" pystray pillow
if errorlevel 1 goto fail
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean gmw_core.spec
if errorlevel 1 goto fail
echo.
echo Готово: server\dist\"GM Whispers Core"\"GM Whispers Core.exe"
echo Запуск exe без параметров = режим трея. Рядом с exe создадутся .env и data\.
pause
exit /b 0
:fail
echo Сборка не удалась - пришли текст выше.
pause
exit /b 1
