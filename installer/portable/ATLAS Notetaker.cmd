@echo off
rem ATLAS Notetaker, portable: the bundled Node runs the launcher, which brings up the local server,
rem opens the window and ends (the server goes on by itself). Notes live in %APPDATA%\ATLAS Notetaker,
rem as with the installed app. When the app cannot start, the launcher prints why and this window
rem stays open until a key is pressed, instead of closing at once. (ASCII only, CRLF: cmd misreads
rem a batch file with other characters or line ends.)
"%~dp0node\node.exe" "%~dp0app\server\launch.js"
if errorlevel 1 pause
