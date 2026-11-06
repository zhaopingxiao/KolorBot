@echo off
REM KolorBot restart helper. See scripts\restart.ps1 for options.
REM   restart.cmd                  restart on 100.87.104.6:3399
REM   restart.cmd stop|status      stop / inspect
REM   restart.cmd restart -Port 3400
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart.ps1" %*
endlocal
