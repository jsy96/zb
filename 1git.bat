@echo off
cd /d %~dp0

echo === zhibo-tools: commit and push to Gitee ===
echo === (env.local with API keys is ignored by .gitignore) ===

git add -A

git diff --cached --quiet
if %errorlevel%==0 (
    echo [OK] nothing to commit.
    git push
    pause
    exit /b 0
)

set "MSG="
set /p MSG=commit message (ENTER = default):
if not defined MSG set "MSG=update: %date% %time:~0,8%"

git commit -m "%MSG%"
if errorlevel 1 (
    echo [FAIL] commit failed.
    pause
    exit /b 1
)

git push
if errorlevel 1 (
    echo [FAIL] push failed - check network / gitee login.
    pause
    exit /b 1
)

echo === DONE ===
pause
