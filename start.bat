@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "%~dp0node-v24.16.0-win-x64\node.exe" "%~dp0webui.cjs"
