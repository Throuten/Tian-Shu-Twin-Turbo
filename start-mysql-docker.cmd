@echo off
setlocal
cd /d "%~dp0"
title MySQL-Docker

where docker >NUL 2>&1
if errorlevel 1 (
    echo [ERROR] docker not found. Start Docker Desktop first.
    pause
    exit /b 1
)

echo Starting MySQL 8 on host port 3307 (user root / pass root, DB traffic_system) ...
docker compose -f "%~dp0docker-compose.mysql.yml" up -d
if errorlevel 1 (
    echo Compose failed. If port 3307 is busy, stop the other program or edit docker-compose.mysql.yml.
    pause
    exit /b 1
)

echo.
echo OK. Wait ~15s on first run, then start backend with: 后端-启动-DockerMySQL.cmd
echo Check: docker ps   (traffic-mysql-dev)
pause
endlocal
