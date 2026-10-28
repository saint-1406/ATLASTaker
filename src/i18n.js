// Every word the interface shows, in Russian and in English. t('area.key', ...args) reads the current
// language (a value may be a function of its arguments); count(n, 'noun') writes "3 заметки" or
// "3 notes" with the plural rules of that language: { one, few, many, other } in Russian,
// { one, other } in English. Numbers and dates follow the language's locale.

export const LANGS = [
  { id: 'ru', title: 'Русский' },
  { id: 'en', title: 'English' },
];

// Used when the browser names no regional variant of the chosen language.
const DEFAULT_LOCALES = { ru: 'ru-RU', en: 'en-GB' };

const ru = {
  untitled: 'Без названия',
  forms: {
    word: { one: 'слово', few: 'слова', many: 'слов', other: 'слова' },
    wordShort: { one: 'сл.', few: 'сл.', many: 'сл.', other: 'сл.' },
    char: { one: 'зн.', few: 'зн.', many: 'зн.', other: 'зн.' },
    note: { one: 'заметка', few: 'заметки', many: 'заметок', other: 'заметки' },
    comment: { one: 'комментарий', few: 'комментария', many: 'комментариев', other: 'комментария' },
    peak: { one: 'вершина', few: 'вершины', many: 'вершин', other: 'вершины' },
    island: { one: 'остров', few: 'острова', many: 'островов', other: 'острова' },
    line: { one: 'строка', few: 'строки', many: 'строк', other: 'строки' },
    metre: { one: 'м', few: 'м', many: 'м', other: 'м' },
    doc: { one: 'документ', few: 'документа', many: 'документов', other: 'документа' },
  },
  // Each look has its own words for the same things: on a map, "saved" reads «Нанесено на карту».
  look: {
    minimal: {
      title: 'Минимал',
      about: 'Чистый интерфейс: текст, оглавление, ничего лишнего',
      notes: 'Заметки',
      filter: 'Фильтр',
      newNote: 'Новая заметка',
      search: 'Поиск и команды',
      saved: 'Сохранено',
      pending: 'Сохраняю…',
      failed: 'Не сохранено — повторяю',
      nothingFound: 'Ничего не нашлось',
      empty: 'Пусто',
      deleteKicker: 'Удаление',
      deleteTitle: (title) => `Удалить «${title}»?`,
      deleteText: 'Файл переместится в папку .trash, оттуда его можно вернуть вручную.',
      deleteOk: 'Удалить',
      deleteItem: 'Удалить',
      deleted: (title) => `«${title}» удалена`,
      commentKicker: 'Комментарий',
      coords: (line, col) => `Стр ${line}, кол ${col}`,
      outline: 'Содержание',
      noHeadings: 'Строка с «# » в начале станет разделом.',
    },
    atlas: {
      title: 'Атлас',
      about: 'Карта с рельефом: заголовки — вершины, заметки — острова',
      notes: 'Указатель',
      filter: 'Найти территорию…',
      newNote: 'Новая территория',
      search: 'Найти',
      saved: 'Нанесено на карту',
      pending: 'Съёмка…',
      failed: 'Не сохранено — повторяю',
      nothingFound: 'Ничего не нашлось',
      empty: 'Пока пусто',
      deleteKicker: 'Архив',
      deleteTitle: (title) => `Затопить остров «${title}»?`,
      deleteText: 'Заметка уйдёт в папку .trash рядом с остальными файлами. Оттуда её можно достать вручную.',
      deleteOk: 'В архив',
      deleteItem: 'В архив',
      deleted: (title) => `«${title}» ушла под воду`,
      commentKicker: 'Полевая заметка',
      coords: (line, col) => `N ${line}° · E ${col}′`,
      outline: 'Вершины',
      noHeadings: 'Равнина: добавьте # заголовок.',
    },
  },
  themes: { dark: 'Тёмная', light: 'Светлая', system: 'Как в системе' },
  accents: { lime: 'Лайм', cyan: 'Циан', orange: 'Сигнальный', violet: 'Фиалка' },
  // index.html
  chrome: {
    actions: 'Действия',
    notesList: 'Список заметок',
    notesListKey: 'Список заметок (Ctrl+B)',
    findKey: 'Заметки и команды (Ctrl+K)',
    atlas: 'Атлас',
    atlasKey: 'Все заметки на одной карте (Ctrl+M)',
    themeKey: 'Светлая / тёмная (Ctrl+Shift+L)',
    theme: 'Сменить тему',
    settings: 'Настройки',
    settingsKey: 'Настройки (Ctrl+,)',
    newNote: 'Новая заметка',
    newNoteKey: 'Новая заметка (Ctrl+N)',
    filterNotes: 'Фильтр заметок',
    outline: 'Содержание заметки',
    pace: 'Темп набора за последние две минуты',
    atlasTitle: 'Архипелаг заметок',
    atlasFind: 'Найти остров…',
    atlasSearch: 'Поиск по островам',
    atlasNew: 'Новый остров',
    atlasBack: 'Назад к заметке (Esc)',
    atlasClose: 'Закрыть',
    atlasHint: 'колесо — масштаб · перетаскивание — обзор · клик — высадиться · Esc — назад',
    library: 'Библиотека',
    libraryKey: 'Библиотека (Ctrl+O)',
  },
  status: {
    selected: (chars) => `Выделено ${chars}`,
    code: 'код',
    pace: (words) => `${words} сл/мин`,
    peaks: (peaks) => `▲ ${peaks} · 1 слово = 1 м`,
  },
  boot: {
    title: 'ATLAS не загрузился',
    text: (error) => `${error}. Закройте окно и запустите ATLAS ещё раз.`,
    reload: 'Перезагрузить',
  },
  window: {
    title: 'ATLAS открыт в другом окне',
    saved: 'Писать можно только в одном окне, чтобы правки не перезаписывали друг друга. Здесь всё сохранено.',
    unsaved:
      'Писать можно только в одном окне. Последние правки не дошли до диска, но лежат в аварийной копии — новое окно их подхватит после перезагрузки.',
    continue: 'Продолжить здесь',
  },
  connection: {
    restartedTitle: 'ATLAS перезапустился',
    restartedText: 'Сервер заметок начал новый сеанс. Обновите окно: несохранённый текст лежит в аварийной копии и вернётся.',
    reload: 'Обновить окно',
    lostTitle: 'Связь с ATLAS потеряна',
    lostText: 'Сервер заметок не отвечает. Несохранённый текст лежит в аварийной копии этого окна. Запустите ATLAS с ярлыка — текст вернётся.',
    retry: 'Попробовать снова',
  },
  restore: {
    kicker: 'Восстановление',
    title: 'Нашлись несохранённые правки',
    text: (where) => `ATLAS закрылся раньше, чем успел их записать — например, во время обновления. Что не вернёте, не пропадёт: копия ляжет ${where}.`,
    skip: 'Не возвращать',
    ok: 'Вернуть отмеченное',
    toBackups: 'в папку бэкапов',
    toTrash: 'в корзину браузера',
    sameLength: 'правки той же длины',
    noteGone: 'заметки уже нет — вернётся новой',
    restored: (notes) => `Вернул несохранённый текст: ${notes}`,
    putAside: (where, notes) => `Отложено ${where}: ${notes}`,
    failed: (title, error) => `Не получилось вернуть «${title}»: ${error}. Копия подождёт следующего запуска.`,
    // become part of a file name in backups/несохранённое
    olderLabel: 'старее сохранённой',
    skippedLabel: 'не возвращено',
    replacedLabel: 'было на диске',
  },
  notes: {
    stayed: 'Заметка не сохранилась, поэтому остаюсь на ней. Сохранение повторяется.',
    deleteFailed: (error) => `Не получилось удалить: ${error}`,
    deleteNote: 'Удалить заметку',
    open: 'Открыть',
    openFolder: 'Открыть папку',
    saveCopy: 'Сохранить копию .md',
  },
  menu: {
    openLink: 'Открыть ссылку',
    ctrlClick: 'Ctrl+клик',
    addComment: 'Добавить комментарий',
    cut: 'Вырезать',
    copy: 'Копировать',
    paste: 'Вставить',
    codeBlock: 'Блок кода',
    wrapCode: 'Обернуть в блок кода',
    selectAll: 'Выделить всё',
    spelling: 'Shift + правая кнопка — меню браузера с орфографией',
  },
  comment: {
    inCode: 'Внутри блока кода комментарий сломал бы код',
    emptyLine: '(пустая строка)',
    kicker: 'Комментарий',
    title: 'Комментарий к строке',
    placeholder: 'Что нового? Например: «перенесли на четверг»',
    label: 'Текст комментария',
    history: 'Предыдущие комментарии',
    hint: 'Enter — добавить · Esc — отмена',
    add: 'Добавить',
  },
  dialog: { cancel: 'Отмена', yes: 'Да' },
  clipboard: {
    blocked: (keys) => `Браузер не дал доступ к буферу — используйте ${keys}`,
  },
  paste: {
    wrapped: (lang) => `Код обёрнут в блок${lang ? ` · ${lang}` : ''}`,
    undo: 'Отменить',
  },
  image: {
    unsupported: 'Здесь картинки не поддерживаются',
    tooBig: 'Картинка больше 15 МБ — уменьшите её и вставьте снова',
    failed: (error) => `Картинка не сохранилась: ${error}`,
    screenshot: (stamp) => `Скриншот ${stamp}`,
    missing: (name) => `Картинка не найдена: ${name}`,
    wrongType: 'нужна картинка PNG, JPEG, GIF или WebP',
  },
  backup: {
    zipName: (date) => `ATLAS-заметки-${date}.zip`,
    downloaded: (notes) => `Скачано: ${notes}`,
    imported: (notes) => `Добавлено: ${notes}`,
    onlyHere: (since) => `Заметки хранятся только в этом браузере. ${since}`,
    lastCopy: (day) => `Последняя копия — ${day}.`,
    noCopy: 'Копии ещё не было.',
    download: 'Скачать .zip',
  },
  view: {
    fontSize: (percent) => `Размер текста ${percent}%`,
    focus: 'Режим фокуса · Esc или Ctrl+. — выйти',
  },
  commands: {
    newNote: 'Новая заметка',
    light: 'Светлая тема',
    dark: 'Тёмная тема',
    toMinimal: 'Оформление «Минимал»',
    toAtlas: 'Оформление «Атлас»',
    settings: 'Настройки',
    sidebar: 'Список заметок: показать / скрыть',
    focus: 'Режим фокуса',
    unfocus: 'Выйти из режима фокуса',
    comment: 'Комментарий к строке',
    codeBlock: 'Блок кода',
    saveCopy: 'Сохранить копию .md',
    exportAll: 'Скачать все заметки (.zip)',
    import: 'Импорт .md',
    atlas: 'Атлас заметок',
    notesFolder: 'Открыть папку заметок',
    backupsFolder: 'Папка бэкапов',
    library: 'Библиотека',
    addDocument: 'Добавить документ в библиотеку',
    // names the language it switches to, in that language
    otherLang: 'Language: English',
  },
  palette: {
    placeholder: 'Заметка, слово из текста или > команда',
    label: 'Поиск заметок и команд',
    create: (title) => `Создать заметку «${title}»`,
    notes: 'Заметки',
    commands: 'Команды',
    nothing: 'Ничего не нашлось',
    hint: '↑↓ выбрать · Enter открыть · > только команды · Esc закрыть',
  },
  settings: {
    kicker: 'Настройки',
    title: 'Внешний вид',
    language: 'Язык · Language',
    look: 'Оформление',
    theme: 'Тема',
    accent: 'Акцент',
    atlasAccent: 'У «Атласа» своя палитра, акцент работает в «Минимале».',
    size: 'Размер текста',
    smaller: 'Мельче',
    larger: 'Крупнее',
    reset: 'Сбросить',
    notes: 'Заметки',
    inBrowser: 'Заметки хранятся в этом браузере. Если очистить его данные, они пропадут — время от времени скачивайте копию.',
    onDisk:
      'Заметки — обычные файлы .md в папке %APPDATA%\\ATLAS Notetaker\\notes. Перед каждым обновлением и раз в день их копия ложится в папку backups рядом.',
    onPhone: 'Заметки и документы хранятся в приложении на этом телефоне. Если удалить приложение, они пропадут — время от времени сохраняйте копию заметок (.zip).',
    exportAll: 'Скачать все заметки (.zip)',
    import: 'Импорт .md',
    openFolder: 'Открыть папку',
    backupsFolder: 'Папка бэкапов',
    hint: 'Ctrl+, настройки · Ctrl+K команды',
    done: 'Готово',
  },
  editor: {
    placeholder: 'Начните писать. Первая строка станет названием, «# » в начале строки — разделом.',
    label: 'Текст заметки',
    copy: 'Копировать',
    copied: 'Скопировано ✓',
    noClipboard: 'Нет доступа к буферу',
    // CodeMirror's search panel
    phrases: {
      Find: 'Найти',
      Replace: 'Заменить',
      next: 'далее',
      previous: 'назад',
      all: 'все',
      'match case': 'регистр',
      'by word': 'слово целиком',
      regexp: 'рег. выражение',
      replace: 'заменить',
      'replace all': 'заменить все',
      close: 'закрыть',
      'current match': 'текущее совпадение',
      'replaced $ matches': 'заменено: $',
      'replaced match on line $': 'заменено в строке $',
      'on line': 'в строке',
      'Go to line': 'Перейти к строке',
      go: 'перейти',
    },
  },
  library: {
    title: 'Библиотека',
    back: 'Назад к заметкам (Esc)',
    add: 'Добавить',
    addTitle: 'Добавить документы: PDF, EPUB, FB2, DOCX, Markdown, TXT, HTML',
    find: 'Найти книгу',
    empty: 'Здесь будут книги и документы для чтения. Добавьте PDF, EPUB, FB2, DOCX, Markdown или текст — кнопкой «Добавить» или перетащите файлы сюда.',
    emptyPhone: 'Здесь будут книги и документы для чтения. Нажмите «Добавить» или откройте файл в другом приложении через «Поделиться → ATLAS».',
    drop: 'Отпустите — документы лягут на полку',
    adding: (n, total) => `Добавляю ${n} из ${total}…`,
    added: (docs) => `Добавлено: ${docs}`,
    already: (title) => `«${title}» уже в библиотеке`,
    unsupported: (name, ext) => `«${name}»: формат .${ext} пока не читается. Подойдут PDF, EPUB, FB2, DOCX, Markdown, TXT и HTML.`,
    oldWord: (name) => `«${name}» — старый формат Word (.doc). Сохраните его как .docx и добавьте снова.`,
    tooBig: (name) => `«${name}» больше 300 МБ — такой файл библиотека не возьмёт`,
    failed: (name, error) => `Не получилось добавить «${name}»: ${error}`,
    read: 'Читать',
    actions: 'Действия',
    remove: 'Удалить из библиотеки',
    removeTitle: (title) => `Удалить «${title}» из библиотеки?`,
    removeDisk: 'Файл переместится в папку library\\.trash. Цитаты в заметках останутся.',
    removeHere: 'Документ удалится отсюда насовсем. Цитаты в заметках останутся.',
    removeOk: 'Удалить',
    removed: (title) => `Удалено из библиотеки: «${title}»`,
    notOpened: 'не открыта',
    progress: (percent) => `${percent}%`,
    finished: 'прочитано',
    loadFailed: 'Читалка не загрузилась',
  },
  reader: {
    opening: 'Открываю…',
    failed: (error) => `Документ не открылся: ${error}`,
    back: 'К библиотеке (Esc)',
    toc: 'Содержание',
    noToc: 'В документе нет оглавления',
    smaller: 'Мельче (Ctrl+−)',
    larger: 'Крупнее (Ctrl+=)',
    quote: 'В заметку',
    quoteTitle: 'Добавить выделенное цитатой в заметку к этому документу',
    quoted: (title) => `Цитата добавлена в «${title}»`,
    quoteFailed: (error) => `Цитата не сохранилась: ${error}`,
    openNote: 'Открыть',
    page: (n) => `с. ${n}`,
    pageN: (n) => `Страница ${n}`,
    notesTitle: (title) => `Цитаты: ${title}`,
  },
  atlas: {
    summary: (islands, words) => `${islands} · ${words} суши`,
    found: (words, date) => `${words} · открыт ${date}`,
  },
  errors: {
    offline: 'Сервер ATLAS не отвечает',
    noNote: (id) => `нет заметки ${id}`,
  },
};

const en = {
  untitled: 'Untitled',
  forms: {
    word: { one: 'word', other: 'words' },
    wordShort: { one: 'word', other: 'words' },
    char: { one: 'char', other: 'chars' },
    note: { one: 'note', other: 'notes' },
    comment: { one: 'comment', other: 'comments' },
    peak: { one: 'peak', other: 'peaks' },
    island: { one: 'island', other: 'islands' },
    line: { one: 'line', other: 'lines' },
    metre: { one: 'm', other: 'm' },
    doc: { one: 'document', other: 'documents' },
  },
  look: {
    minimal: {
      title: 'Minimal',
      about: 'A clean interface: the text, its contents, nothing else',
      notes: 'Notes',
      filter: 'Filter',
      newNote: 'New note',
      search: 'Search & commands',
      saved: 'Saved',
      pending: 'Saving…',
      failed: 'Not saved — retrying',
      nothingFound: 'Nothing found',
      empty: 'Empty',
      deleteKicker: 'Delete',
      deleteTitle: (title) => `Delete “${title}”?`,
      deleteText: 'The file moves to the .trash folder, where you can bring it back by hand.',
      deleteOk: 'Delete',
      deleteItem: 'Delete',
      deleted: (title) => `“${title}” deleted`,
      commentKicker: 'Comment',
      coords: (line, col) => `Ln ${line}, Col ${col}`,
      outline: 'Contents',
      noHeadings: 'A line that starts with “# ” becomes a section.',
    },
    atlas: {
      title: 'Atlas',
      about: 'A relief map: headings are peaks, notes are islands',
      notes: 'Gazetteer',
      filter: 'Find a territory…',
      newNote: 'New territory',
      search: 'Find',
      saved: 'Charted',
      pending: 'Surveying…',
      failed: 'Not saved — retrying',
      nothingFound: 'Nothing found',
      empty: 'Nothing charted yet',
      deleteKicker: 'Archive',
      deleteTitle: (title) => `Sink the island “${title}”?`,
      deleteText: 'The note goes to the .trash folder next to the other files. You can fish it out from there by hand.',
      deleteOk: 'Archive',
      deleteItem: 'Archive',
      deleted: (title) => `“${title}” sank beneath the waves`,
      commentKicker: 'Field note',
      coords: (line, col) => `N ${line}° · E ${col}′`,
      outline: 'Peaks',
      noHeadings: 'Flatland: add a # heading.',
    },
  },
  themes: { dark: 'Dark', light: 'Light', system: 'Match system' },
  accents: { lime: 'Lime', cyan: 'Cyan', orange: 'Signal', violet: 'Violet' },
  chrome: {
    actions: 'Actions',
    notesList: 'Notes list',
    notesListKey: 'Notes list (Ctrl+B)',
    findKey: 'Notes and commands (Ctrl+K)',
    atlas: 'Atlas',
    atlasKey: 'All notes on one map (Ctrl+M)',
    themeKey: 'Light / dark (Ctrl+Shift+L)',
    theme: 'Switch theme',
    settings: 'Settings',
    settingsKey: 'Settings (Ctrl+,)',
    newNote: 'New note',
    newNoteKey: 'New note (Ctrl+N)',
    filterNotes: 'Filter notes',
    outline: 'Note contents',
    pace: 'Typing pace over the last two minutes',
    atlasTitle: 'Archipelago of notes',
    atlasFind: 'Find an island…',
    atlasSearch: 'Search the islands',
    atlasNew: 'New island',
    atlasBack: 'Back to the note (Esc)',
    atlasClose: 'Close',
    atlasHint: 'wheel to zoom · drag to look around · click to land · Esc to go back',
    library: 'Library',
    libraryKey: 'Library (Ctrl+O)',
  },
  status: {
    selected: (chars) => `${chars} selected`,
    code: 'code',
    pace: (words) => `${words} wpm`,
    peaks: (peaks) => `▲ ${peaks} · 1 word = 1 m`,
  },
  boot: {
    title: 'ATLAS failed to load',
    text: (error) => `${error}. Close the window and start ATLAS again.`,
    reload: 'Reload',
  },
  window: {
    title: 'ATLAS is open in another window',
    saved: 'You can write in one window at a time, so edits never overwrite each other. Everything here is saved.',
    unsaved:
      'You can write in one window at a time. The latest edits did not reach the disk, but they are in the rescue copy — the new window picks them up after a reload.',
    continue: 'Continue here',
  },
  connection: {
    restartedTitle: 'ATLAS restarted',
    restartedText: 'The notes server started a new session. Reload the window: unsaved text is in the rescue copy and will come back.',
    reload: 'Reload window',
    lostTitle: 'Lost touch with ATLAS',
    lostText: 'The notes server is not responding. Unsaved text is in this window’s rescue copy. Start ATLAS from its shortcut and the text will come back.',
    retry: 'Try again',
  },
  restore: {
    kicker: 'Recovery',
    title: 'Unsaved edits found',
    text: (where) => `ATLAS closed before it could write them — during an update, for example. Nothing you leave out is lost: a copy goes ${where}.`,
    skip: 'Don’t restore',
    ok: 'Restore selected',
    toBackups: 'to the backups folder',
    toTrash: 'to the browser’s trash',
    sameLength: 'edits of the same length',
    noteGone: 'the note is gone — it comes back as a new one',
    restored: (notes) => `Unsaved text restored: ${notes}`,
    putAside: (where, notes) => `Moved ${where}: ${notes}`,
    failed: (title, error) => `Could not restore “${title}”: ${error}. The copy will wait for the next start.`,
    olderLabel: 'older than saved',
    skippedLabel: 'not restored',
    replacedLabel: 'was on disk',
  },
  notes: {
    stayed: 'The note did not save, so I am staying on it. Retrying the save.',
    deleteFailed: (error) => `Could not delete: ${error}`,
    deleteNote: 'Delete note',
    open: 'Open',
    openFolder: 'Open folder',
    saveCopy: 'Save a copy (.md)',
  },
  menu: {
    openLink: 'Open link',
    ctrlClick: 'Ctrl+click',
    addComment: 'Add comment',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    codeBlock: 'Code block',
    wrapCode: 'Wrap in a code block',
    selectAll: 'Select all',
    spelling: 'Shift + right-click — the browser menu with spelling',
  },
  comment: {
    inCode: 'A comment inside a code block would break the code',
    emptyLine: '(empty line)',
    kicker: 'Comment',
    title: 'Comment on the line',
    placeholder: 'What’s new? For example: “moved to Thursday”',
    label: 'Comment text',
    history: 'Earlier comments',
    hint: 'Enter to add · Esc to cancel',
    add: 'Add',
  },
  dialog: { cancel: 'Cancel', yes: 'Yes' },
  clipboard: {
    blocked: (keys) => `The browser blocked the clipboard — use ${keys}`,
  },
  paste: {
    wrapped: (lang) => `Code wrapped in a block${lang ? ` · ${lang}` : ''}`,
    undo: 'Undo',
  },
  image: {
    unsupported: 'Pictures are not supported here',
    tooBig: 'The picture is over 15 MB — make it smaller and paste it again',
    failed: (error) => `The picture was not saved: ${error}`,
    screenshot: (stamp) => `Screenshot ${stamp}`,
    missing: (name) => `Picture not found: ${name}`,
    wrongType: 'a PNG, JPEG, GIF or WebP picture is needed',
  },
  backup: {
    zipName: (date) => `ATLAS-notes-${date}.zip`,
    downloaded: (notes) => `Downloaded: ${notes}`,
    imported: (notes) => `Added: ${notes}`,
    onlyHere: (since) => `Your notes live only in this browser. ${since}`,
    lastCopy: (day) => `Last copy: ${day}.`,
    noCopy: 'No copy yet.',
    download: 'Download .zip',
  },
  view: {
    fontSize: (percent) => `Text size ${percent}%`,
    focus: 'Focus mode · Esc or Ctrl+. to leave',
  },
  commands: {
    newNote: 'New note',
    light: 'Light theme',
    dark: 'Dark theme',
    toMinimal: 'Look: Minimal',
    toAtlas: 'Look: Atlas',
    settings: 'Settings',
    sidebar: 'Notes list: show / hide',
    focus: 'Focus mode',
    unfocus: 'Leave focus mode',
    comment: 'Comment on the line',
    codeBlock: 'Code block',
    saveCopy: 'Save a copy (.md)',
    exportAll: 'Download all notes (.zip)',
    import: 'Import .md',
    atlas: 'Atlas of notes',
    notesFolder: 'Open the notes folder',
    backupsFolder: 'Backups folder',
    library: 'Library',
    addDocument: 'Add a document to the library',
    otherLang: 'Язык: русский',
  },
  palette: {
    placeholder: 'A note, a word from the text, or > command',
    label: 'Search notes and commands',
    create: (title) => `Create note “${title}”`,
    notes: 'Notes',
    commands: 'Commands',
    nothing: 'Nothing found',
    hint: '↑↓ choose · Enter open · > commands only · Esc close',
  },
  settings: {
    kicker: 'Settings',
    title: 'Appearance',
    language: 'Language · Язык',
    look: 'Look',
    theme: 'Theme',
    accent: 'Accent',
    atlasAccent: 'Atlas has a palette of its own; the accent works in Minimal.',
    size: 'Text size',
    smaller: 'Smaller',
    larger: 'Larger',
    reset: 'Reset',
    notes: 'Notes',
    inBrowser: 'Your notes are kept in this browser. Clearing its data would take them with it, so download a copy now and then.',
    onDisk:
      'Notes are plain .md files in %APPDATA%\\ATLAS Notetaker\\notes. Before every update and once a day a copy of them goes to the backups folder next to it.',
    onPhone: 'Notes and documents live in the app on this phone. Uninstalling the app deletes them, so save a copy of your notes (.zip) now and then.',
    exportAll: 'Download all notes (.zip)',
    import: 'Import .md',
    openFolder: 'Open folder',
    backupsFolder: 'Backups folder',
    hint: 'Ctrl+, settings · Ctrl+K commands',
    done: 'Done',
  },
  editor: {
    placeholder: 'Start writing. The first line becomes the title; “# ” at the start of a line makes a section.',
    label: 'Note text',
    copy: 'Copy',
    copied: 'Copied ✓',
    noClipboard: 'No clipboard access',
    // CodeMirror speaks English already; listed so both languages have the same keys
    phrases: {
      Find: 'Find',
      Replace: 'Replace',
      next: 'next',
      previous: 'previous',
      all: 'all',
      'match case': 'match case',
      'by word': 'by word',
      regexp: 'regexp',
      replace: 'replace',
      'replace all': 'replace all',
      close: 'close',
      'current match': 'current match',
      'replaced $ matches': 'replaced $ matches',
      'replaced match on line $': 'replaced match on line $',
      'on line': 'on line',
      'Go to line': 'Go to line',
      go: 'go',
    },
  },
  library: {
    title: 'Library',
    back: 'Back to the notes (Esc)',
    add: 'Add',
    addTitle: 'Add documents: PDF, EPUB, FB2, DOCX, Markdown, TXT, HTML',
    find: 'Find a book',
    empty: 'Books and documents to read will live here. Add a PDF, EPUB, FB2, DOCX, Markdown or text file with “Add”, or drop files here.',
    emptyPhone: 'Books and documents to read will live here. Tap “Add”, or open a file in another app and choose “Share → ATLAS”.',
    drop: 'Let go to put the documents on the shelf',
    adding: (n, total) => `Adding ${n} of ${total}…`,
    added: (docs) => `Added: ${docs}`,
    already: (title) => `“${title}” is already in the library`,
    unsupported: (name, ext) => `“${name}”: .${ext} files can’t be read yet. PDF, EPUB, FB2, DOCX, Markdown, TXT and HTML can.`,
    oldWord: (name) => `“${name}” is an old Word file (.doc). Save it as .docx and add it again.`,
    tooBig: (name) => `“${name}” is over 300 MB, too big for the library`,
    failed: (name, error) => `Could not add “${name}”: ${error}`,
    read: 'Read',
    actions: 'Actions',
    remove: 'Remove from the library',
    removeTitle: (title) => `Remove “${title}” from the library?`,
    removeDisk: 'The file moves to the library\\.trash folder. Quotes in your notes stay.',
    removeHere: 'The document is deleted from here for good. Quotes in your notes stay.',
    removeOk: 'Remove',
    removed: (title) => `Removed from the library: “${title}”`,
    notOpened: 'not opened yet',
    progress: (percent) => `${percent}%`,
    finished: 'finished',
    loadFailed: 'The reader did not load',
  },
  reader: {
    opening: 'Opening…',
    failed: (error) => `The document did not open: ${error}`,
    back: 'Back to the library (Esc)',
    toc: 'Contents',
    noToc: 'This document has no table of contents',
    smaller: 'Smaller (Ctrl+−)',
    larger: 'Larger (Ctrl+=)',
    quote: 'To a note',
    quoteTitle: 'Add the selection as a quote to this document’s note',
    quoted: (title) => `Quote added to “${title}”`,
    quoteFailed: (error) => `The quote was not saved: ${error}`,
    openNote: 'Open',
    page: (n) => `p. ${n}`,
    pageN: (n) => `Page ${n}`,
    notesTitle: (title) => `Quotes: ${title}`,
  },
  atlas: {
    summary: (islands, words) => `${islands} · ${words} of land`,
    found: (words, date) => `${words} · discovered ${date}`,
  },
  errors: {
    offline: 'The ATLAS server is not responding',
    noNote: (id) => `no note ${id}`,
  },
};

export const STRINGS = { ru, en };

const ids = LANGS.map((l) => l.id);
export const isLang = (value) => ids.includes(value);

const baseOf = (tag) => String(tag ?? '').toLowerCase().split(/[-_]/)[0];

/** The first of the browser's languages that ATLAS speaks; English when none is. */
export function detectLang(preferred = []) {
  return preferred.map(baseOf).find(isLang) ?? 'en';
}

/**
 * The language to start in: the saved one; else Russian for someone who used ATLAS before it spoke
 * English (their notes and habits are Russian); else the browser's language.
 */
export function pickLang({ saved, existing = false, preferred = [] } = {}) {
  if (isLang(saved)) return saved;
  return existing ? 'ru' : detectLang(preferred);
}

/** The browser's own regional variant of the language when it has one (en-US gets 12-hour clocks). */
export function localeFor(lang, preferred = []) {
  for (const tag of preferred) {
    if (baseOf(tag) !== lang) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0];
    } catch {
      // not a valid tag: try the next one
    }
  }
  return DEFAULT_LOCALES[lang];
}

export const browserLanguages = () => (typeof navigator === 'object' && navigator?.languages?.length ? [...navigator.languages] : []);

let lang = 'ru';
let locale = DEFAULT_LOCALES.ru;
const formatters = new Map();

export const currentLang = () => lang;
export const currentLocale = () => locale;

export function setLang(id, preferred = browserLanguages()) {
  lang = isLang(id) ? id : 'ru';
  locale = localeFor(lang, preferred);
  formatters.clear();
  return lang;
}

/** The current language's whole dictionary. */
export const ui = () => STRINGS[lang];

const lookup = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict);

export function t(key, ...args) {
  const value = lookup(STRINGS[lang], key) ?? lookup(STRINGS.ru, key);
  if (value === undefined) return key;
  return typeof value === 'function' ? value(...args) : value;
}

function formatter(name, make) {
  if (!formatters.has(name)) formatters.set(name, make());
  return formatters.get(name);
}

export const formatNumber = (n) => formatter('number', () => new Intl.NumberFormat(locale)).format(n);

/** "3 заметки" / "3 notes": `noun` is a key of `forms`. */
export function count(n, noun) {
  const forms = ui().forms[noun];
  const rule = formatter('plural', () => new Intl.PluralRules(locale)).select(n);
  return `${formatNumber(n)} ${forms[rule] ?? forms.other}`;
}

/** "17:30" (or "05:30 PM" where that is the custom). */
export const formatTime = (ms) => formatter('time', () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })).format(ms);

/** "27 окт" / "27 Oct": a short date without the abbreviation's dot. */
export const formatDay = (ms) =>
  formatter('day', () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }))
    .format(ms)
    .replace('.', '');

/** "27 октября 2026 г." / "27 October 2026". */
export const formatDate = (ms) => formatter('date', () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' })).format(ms);
