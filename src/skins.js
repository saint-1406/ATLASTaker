// Two looks share one app: "minimal" (the default) and "atlas" (the cartographic one). Each look has
// its own words for the same things: on a map, "saved" reads «Нанесено на карту».

export const SKINS = [
  { id: 'minimal', title: 'Минимал', about: 'Чистый интерфейс: текст, оглавление, ничего лишнего' },
  { id: 'atlas', title: 'Атлас', about: 'Карта с рельефом: заголовки — вершины, заметки — острова' },
];

export const THEMES = [
  { id: 'dark', title: 'Тёмная' },
  { id: 'light', title: 'Светлая' },
  { id: 'system', title: 'Как в системе' },
];

export const ACCENTS = [
  { id: 'lime', title: 'Лайм' },
  { id: 'cyan', title: 'Циан' },
  { id: 'orange', title: 'Сигнальный' },
  { id: 'violet', title: 'Фиалка' },
];

export const DEFAULT_LOOK = { skin: 'minimal', theme: 'dark', accent: 'lime' };

export const COPY = {
  minimal: {
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
};

const ids = (list) => list.map((item) => item.id);

/** Keeps only known values, falling back to the defaults. */
export function normalizeLook(saved = {}) {
  return {
    skin: ids(SKINS).includes(saved.skin) ? saved.skin : DEFAULT_LOOK.skin,
    theme: ids(THEMES).includes(saved.theme) ? saved.theme : DEFAULT_LOOK.theme,
    accent: ids(ACCENTS).includes(saved.accent) ? saved.accent : DEFAULT_LOOK.accent,
  };
}
