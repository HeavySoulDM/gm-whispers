@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ==== GM Whispers Core: установка ====
echo.

set "PY="
py -3.12 -c "import sys" >nul 2>&1 && set "PY=py -3.12"
if not defined PY py -3 -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY goto nopython

:havepython
echo Python найден: %PY%
if exist ".venv\Scripts\python.exe" goto deps
echo Создаю рабочее окружение (.venv) ...
%PY% -m venv .venv
if errorlevel 1 goto venvfail

:deps
echo Устанавливаю зависимости, включая движок распознавания речи (3-5 минут, ~300 МБ) ...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
if errorlevel 1 goto pipfail
echo Готово: сервер установлен.
echo.

:audio
rem Движок распознавания речи (faster-whisper, работает на процессоре) ставится вместе с зависимостями.
rem Модель (0,5-3 ГБ) и ускорение на видеокарте NVIDIA скачиваются по кнопке в Foundry: ⚙ → Транскрибация.
goto done

:done
echo.
echo Всё готово. Дальше: запусти server\start.bat - в его окне будет код доступа для модуля в Foundry.
pause
exit /b 0

:nopython
echo Для работы нужен Python 3.10 или новее - на этом компьютере он не найден.
set "ANS="
set /p "ANS=Установить Python 3.12 автоматически (через winget, ~30 МБ)? [Y/n]: "
if /i "%ANS%"=="n" goto nopython_manual
where winget >nul 2>&1 || goto nowinget
echo Устанавливаю Python 3.12 ...
winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent
if errorlevel 1 goto nowinget
echo Python установлен. Перезапускаю установку ...
set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\Programs\Python\Launcher;%PATH%"
set "PY="
py -3.12 -c "import sys" >nul 2>&1 && set "PY=py -3.12"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"
if defined PY goto havepython
echo Python поставлен, но ещё не виден в этом окне. Закрой окно и запусти setup.bat ещё раз.
pause
exit /b 1

:nowinget
echo Автоматическая установка не удалась.
:nopython_manual
echo Скачай Python 3.12 с python.org - при установке отметь "Add python.exe to PATH".
echo Потом запусти setup.bat снова.
pause
exit /b 1

:venvfail
echo Не удалось создать рабочее окружение (.venv). Попробуй запустить setup.bat ещё раз;
echo если не поможет - сообщи об ошибке: https://github.com/HeavySoulDM/gm-whispers/issues
pause
exit /b 1

:pipfail
echo Не удалось установить зависимости. Проверь интернет и запусти setup.bat ещё раз;
echo если не поможет - сообщи текст ошибки выше: https://github.com/HeavySoulDM/gm-whispers/issues
pause
exit /b 1
