@echo off
rem 一键安装入口：补齐 Node.js / uv（缺才装），再安装项目依赖。
rem 双击运行即可；脚本幂等，中断后重跑会自动续上。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-machine.ps1"
echo.
pause
