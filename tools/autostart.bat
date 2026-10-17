@echo off
chcp 65001 >nul
rem Автозапуск GM Whispers Core вместе с Windows (в трее, без окна).
rem   autostart.bat       — включить
rem   autostart.bat off   — выключить
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\GM Whispers Core.lnk"
set "VBS=%~dp0..\server\start_quiet.vbs"
for %%I in ("%VBS%") do set "VBS=%%~fI"

if /i "%~1"=="off" (
  if exist "%LNK%" del "%LNK%"
  echo Автозапуск выключен.
  pause
  exit /b 0
)
if not exist "%VBS%" (echo Не найден %VBS% & pause & exit /b 1)
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='wscript.exe';" ^
  "$s.Arguments='\"%VBS%\"';" ^
  "$s.WorkingDirectory='%~dp0..\server';" ^
  "$s.Description='GM Whispers Core — сервер помощника мастера';" ^
  "$s.Save()"
if errorlevel 1 (echo Не удалось создать ярлык автозапуска. & pause & exit /b 1)
echo Готово: GM Whispers Core будет запускаться вместе с Windows (значок в трее).
echo Запустить сейчас: server\start_tray.bat
echo Выключить автозапуск: tools\autostart.bat off
pause
