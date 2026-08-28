@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-service.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
echo WeChat Claude exited with code %EXIT_CODE%.
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
