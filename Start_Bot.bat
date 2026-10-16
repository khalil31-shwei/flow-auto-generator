@echo off
cd /d "%~dp0"
if not exist node_modules (
    echo [INFO] node_modules not found. Installing dependencies...
    call npm install
)
echo [INFO] Starting Flow Auto Generator...
call npm start
pause
