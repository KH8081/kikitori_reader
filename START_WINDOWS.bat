@echo off
setlocal
cd /d "%~dp0"
title Kikitori Reader

echo Kikitori Reader を起動しています...
echo この黒い画面は、アプリを使用している間は閉じないでください。
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"

if errorlevel 1 (
  echo.
  echo 通常起動に失敗しました。予備の直接起動を試します。
  start "" "%~dp0index.html"
  echo.
  echo ブラウザーが開かない場合は、index.html をダブルクリックしてください。
  pause
)
endlocal
