ATLAS Notetaker — portable

Запуск: двойной щелчок по «ATLAS Notetaker.cmd». Откроется окно Edge (или Chrome) с блокнотом.
Установка не нужна. Заметки хранятся там же, где у установленной версии:
%APPDATA%\ATLAS Notetaker\notes, документы библиотеки — в %APPDATA%\ATLAS Notetaker\library.
Перед каждым обновлением и раз в день копия заметок ложится в %APPDATA%\ATLAS Notetaker\backups.

Обновление: скачайте новый zip, распакуйте и направьте ярлык на новую папку, а старые папки и ярлыки
удалите. Все копии ATLAS на компьютере работают с одними заметками; начиная с 0.19.19 старая копия,
запущенная по забытому ярлыку, не закрывает новую, а открывает её окно (версии до 0.19.19 так не умеют
и закрывают любую другую). Что и когда запускалось, видно в %APPDATA%\ATLAS Notetaker\server.log.

Если Windows не даёт запустить node.exe из этой папки (политика компьютера), поставьте MSI-версию:
она ставится в Program Files.

Run: double-click "ATLAS Notetaker.cmd". An Edge (or Chrome) window opens with the notepad.
Nothing is installed. Notes live where the installed app keeps them: %APPDATA%\ATLAS Notetaker.
To update, unpack the new zip, point the shortcut at it and delete the old folders and shortcuts. Since
0.19.19 an older copy started by mistake opens the newer one's window instead of closing it.
