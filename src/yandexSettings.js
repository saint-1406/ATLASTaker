// "Yandex Translate" in the settings: the person's own Yandex Cloud API key, kept on this device only
// (src/translate.js: yandexKey). With a key, a selected passage is translated by Yandex (online); the
// on-device translators stay for when there is no internet.

import { h, openDialog, toast } from './overlays.js';
import { t } from './i18n.js';
import { setYandexKey, yandexKey } from './translate.js';

/** Whether this copy of the app can reach Yandex (the Windows app's server, or the Android app). */
export const yandexPossible = ({ api, android }) => Boolean(android?.yandexTranslate || api?.translateYandex);

/** The key dialog; onDone() after a change (the menu redraws). */
export function openYandexDialog({ onDone } = {}) {
  const had = yandexKey();
  openDialog((box, close) => {
    const field = h('input', {
      type: 'password',
      class: 'field',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: had ? t('yandex.keySaved') : t('yandex.keyPlaceholder'),
      'aria-label': t('yandex.key'),
      'data-autofocus': true,
    });
    const save = () => {
      const value = field.value.trim();
      if (!value) return close(null);
      setYandexKey(value);
      toast(t('yandex.saved'));
      close(true);
      onDone?.();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    box.append(
      h('div', { class: 'modal-kicker' }, t('yandex.kicker')),
      h('h2', { class: 'modal-title' }, t('yandex.title')),
      h('p', { class: 'modal-text' }, t('yandex.about')),
      field,
      h(
        'div',
        { class: 'modal-actions' },
        had
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn danger',
                onclick: () => {
                  setYandexKey('');
                  toast(t('yandex.removed'));
                  close(false);
                  onDone?.();
                },
              },
              t('yandex.remove'),
            )
          : null,
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: save }, t('yandex.save')),
      ),
    );
  });
}
