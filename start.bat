@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在启动 直播话术整理台...
node server.js
pause
