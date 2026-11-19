@echo off
rem ATLAS Notetaker, portable: the bundled Node runs the launcher, which starts the hidden keeper
rem (server/keeper.js: the server and the window, the server brought back if it stops) and ends. Notes live in %APPDATA%\ATLAS Notetaker,
rem as with the installed app. When the app cannot start, the launcher prints why and this window
rem stays open until a key is pressed, instead of closing at once. (ASCII only, CRLF: cmd misreads
rem a batch file with other characters or line ends.)
"%~dp0node\node.exe" "%~dp0app\server\launch.js" --keeper
if errorlevel 1 pause
