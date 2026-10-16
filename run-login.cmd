@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_PATH=%~dp0node_modules"
if "%~1"=="" (
  set /p ACCNAME=请输入账号备注名（如：账号1）:
  if "%ACCNAME%"=="" set ACCNAME=account%random%
  "%~dp0node-v24.16.0-win-x64\node.exe" "%~dp0login-capture.cjs" %ACCNAME%
) else (
  "%~dp0node-v24.16.0-win-x64\node.exe" "%~dp0login-capture.cjs" %*
)
echo.
pause
