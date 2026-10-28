@echo off
rem ATLAS Notetaker, portable: starts the bundled Node on the launcher, which brings up the local
rem server and opens the window. Notes live in %APPDATA%\ATLAS Notetaker, as with the installed app.
start "" /min "%~dp0node\node.exe" "%~dp0app\server\launch.js"
