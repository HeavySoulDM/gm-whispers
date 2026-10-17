@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem Скачивает модель распознавания речи для GM Whispers встроенным в Windows curl (без браузера), с докачкой.
rem Можно указать другой адрес-зеркало: download_model.bat https://hf-mirror.com/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/main
for %%I in ("%~dp0..\data\models\faster-whisper-large-v3-turbo") do set "DIR=%%~fI"
set "BASE=https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/main"
if not "%~1"=="" set "BASE=%~1"
if not exist "%DIR%" mkdir "%DIR%"
echo Папка: %DIR%
echo Источник: %BASE%
echo.

for %%F in (config.json preprocessor_config.json tokenizer.json vocabulary.json) do (
  if not exist "%DIR%\%%F" (
    echo Скачиваю %%F ...
    curl.exe -L --fail --retry 5 --retry-delay 5 -o "%DIR%\%%F" "%BASE%/%%F"
  )
)

set N=0
:retry
set /a N+=1
call :size
if !SIZE! GEQ 1600000000 goto ok
echo.
echo Попытка !N!: model.bin ^(1.62 ГБ^), докачка с места обрыва...
curl.exe -L --fail -C - --retry 5 --retry-delay 5 -o "%DIR%\model.bin" "%BASE%/model.bin"
call :size
if !SIZE! GEQ 1600000000 goto ok
if !N! GEQ 20 goto fail
echo Обрыв, повтор через 10 секунд...
timeout /t 10 >nul
goto retry

:ok
echo.
echo Готово: модель на месте ^(!SIZE! байт^). Теперь можно перетаскивать запись на server\transcribe.bat
pause
exit /b 0

:fail
echo.
echo Не удалось скачать за 20 попыток. Попробуй зеркало:
echo   download_model.bat https://hf-mirror.com/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/main
echo или включи VPN и запусти снова - скачанное не пропадёт, продолжится с места обрыва.
pause
exit /b 1

:size
set SIZE=0
if exist "%DIR%\model.bin" for %%A in ("%DIR%\model.bin") do set SIZE=%%~zA
exit /b 0
