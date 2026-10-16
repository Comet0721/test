@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_PATH=%~dp0node_modules"
"%~dp0node-v24.16.0-win-x64\node.exe" "%~dp0webui.cjs" %*
pause
