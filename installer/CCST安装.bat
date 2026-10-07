@echo off
chcp 65001 >nul
setlocal
title CCST 一键安装
rem 每次都下载最新的安装程序（旁边那份可能是旧的）；下载失败才用旁边那份
set "PS1=%TEMP%\ccst-install.ps1"
echo 正在下载安装程序...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/installer/ccst-install.ps1' -OutFile $env:TEMP\ccst-install.ps1 } catch { exit 1 }"
if errorlevel 1 set "PS1=%~dp0ccst-install.ps1"
if not exist "%PS1%" (
  echo.
  echo [失败] 下载安装程序失败。请检查网络（需要能打开 github.com），然后再双击一次本文件。
  if not defined CCST_YES pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
exit /b %errorlevel%
