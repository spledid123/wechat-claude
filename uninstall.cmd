@echo off
rem 一键卸载入口：默认只清理依赖与构建产物（node_modules/.venv/dist/.tmp）。
rem 微信 token 与本地数据默认保留；如需彻底清除请运行：
rem   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -All
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*
echo.
pause
