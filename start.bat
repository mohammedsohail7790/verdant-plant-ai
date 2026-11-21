@echo off
title Verdant server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Port 8080
pause
