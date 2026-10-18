@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" goto nosetup
echo Устанавливаю распознавание речи: faster-whisper и библиотеки CUDA для видеокарты NVIDIA (~1.5 ГБ) ...
".venv\Scripts\python.exe" -m pip install "faster-whisper>=1.1" "nvidia-cublas-cu12" "nvidia-cudnn-cu12>=9,<10"
if errorlevel 1 goto fail
echo.
echo Готово. Модель распознавания (~1.6 ГБ) скачается сама при первой расшифровке.
echo Дальше: перетащи zip с записью Craig на transcribe.bat
pause
exit /b 0

:nosetup
echo Сначала запусти setup.bat
pause
exit /b 1

:fail
echo Ошибка установки - сообщи текст выше: https://github.com/HeavySoulDM/gm-whispers/issues
pause
exit /b 1
