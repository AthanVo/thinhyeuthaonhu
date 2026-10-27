@echo off
chcp 65001 >nul
title LoveTunes Discord Music Bot - Thinh & Thao Nhu
cd /d "%~dp0"

echo ============================================================
echo   🌸 LOVETUNES DISCORD MUSIC BOT (API: thinhyeuthaonhu) 🌸
echo ============================================================
echo.

if not exist "node_modules" (
    echo [1/2] Dang cai dat thu vien cho Bot Discord...
    call npm install --no-audit --no-fund
)

findstr /B /C:"DISCORD_TOKEN=." ".env" >nul 2>&1
if errorlevel 1 (
    echo [!] Ban chua dien DISCORD_TOKEN trong file .env!
    set /p USER_TOKEN="👉 Nhap DISCORD_TOKEN cua ban vao day (hoac nhan Enter de mo file .env): "
    if not "%USER_TOKEN%"=="" (
        powershell -Command "(Get-Content .env) -replace '^DISCORD_TOKEN=.*', 'DISCORD_TOKEN=%USER_TOKEN%' | Set-Content .env"
        echo [OK] Da luu DISCORD_TOKEN vao file .env!
    ) else (
        notepad .env
        pause
    )
)

:loop
echo.
echo [🚀] Dang khoi dong Bot Discord...
node bot.js
echo.
echo [!] Bot vua dung hoac mat ket noi. Tu dong khoi dong lai sau 5 giay...
timeout /t 5
goto loop
