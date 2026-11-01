@echo off
title PRIME HD - ISHNT
echo Starting PRIME HD Game Server...

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Starting server with Node.js...
    start http://localhost:8080
    node server.js
    goto :end
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Starting server with Python...
    start http://localhost:8080
    python -m http.server 8080
    goto :end
)

echo Neither Node.js nor Python was found.
echo Please install Node.js or run with VS Code Live Server.
pause

:end

