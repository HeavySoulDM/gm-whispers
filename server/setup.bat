@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY="
py -3.12 -c "import sys" >nul 2>&1 && set "PY=py -3.12"
if not defined PY py -3 -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY goto nopython

echo Python: %PY%
if exist ".venv\Scripts\python.exe" goto deps
echo Создаю виртуальное окружение .venv ...
%PY% -m venv .venv
if errorlevel 1 goto venvfail

:deps
echo Устанавливаю зависимости ...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto pipfail
echo.
echo Готово. Следующий шаг: check_setup.bat
pause
exit /b 0

:nopython
echo Не найден Python 3.10 или новее.
echo Установи Python 3.12 одной командой в PowerShell:  winget install Python.Python.3.12
echo или скачай с python.org - при установке отметь Add python.exe to PATH.
echo Потом запусти setup.bat снова.
pause
exit /b 1

:venvfail
echo Не удалось создать .venv
pause
exit /b 1

:pipfail
echo Ошибка установки зависимостей - пришли текст выше.
pause
exit /b 1
