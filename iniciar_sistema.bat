@echo off
title Sistema de Caja y Arqueo - Almacen / Minimercado
cd /d "%~dp0"
echo Inicializando Base de Datos SQLite...
node backend\src\db\seed-cli.js
echo.
echo Iniciando Servidor con recarga automatica en http://localhost:4000 ...
start "" http://localhost:4000
node --watch backend\src\server.js
pause
