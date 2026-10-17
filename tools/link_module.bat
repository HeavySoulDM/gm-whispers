@echo off
chcp 65001 >nul
rem Подключает модуль gm-whispers к Foundry ссылкой (junction): правки в GM_Whispers сразу видны в Foundry.
for %%I in ("%~dp0..\foundry-module\gm-whispers") do set "SRC=%%~fI"
set "DST=H:\Foundry_14\Data\modules\gm-whispers"

if not exist "%SRC%\module.json" goto nosrc
if exist "%DST%" goto exists

mklink /J "%DST%" "%SRC%"
if errorlevel 1 goto fail
echo.
echo Готово. Перезапусти Foundry, открой мир dod-test и включи модуль GM Whispers.
pause
exit /b 0

:exists
echo Уже подключено: %DST%
pause
exit /b 0

:nosrc
echo Не найден модуль: %SRC%
pause
exit /b 1

:fail
echo Не удалось создать ссылку.
pause
exit /b 1
