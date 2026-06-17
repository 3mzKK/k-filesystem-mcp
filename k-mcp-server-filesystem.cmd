@ECHO off
SETLOCAL
SET "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%dist\index.js" %*
