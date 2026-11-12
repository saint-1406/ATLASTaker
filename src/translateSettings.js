// "Online translation: MyMemory" in the settings: an optional e-mail that raises MyMemory's free daily
// allowance from about 5,000 to about 50,000 characters. Kept on this device only (src/translate.js).

import { h, openDialog, toast } from './overlays.js';
import { t } from './i18n.js';
import { isEmail, myMemoryEmail, setMyMemoryEmail } from './translate.js';

/** The settings row's hint: the allowance as it stands. */
export const onlineHint = () => (myMemoryEmail() ? t('translate.online.on', myMemoryEmail()) : t('translate.online.off'));

/** The e-mail dialog; onDone() after a change (the menu redraws). */
export function openOnlineDialog({ onDone } = {}) {
  const had = myMemoryEmail();
  openDialog((box, close) => {
    const field = h('input', {
      type: 'email',
      class: 'field',
      autocomplete: 'email',
      spellcheck: 'false',
      value: had,
      placeholder: t('translate.online.emailPlaceholder'),
      'aria-label': t('translate.online.email'),
      'data-autofocus': true,
    });
    const problem = h('p', { class: 'modal-hint', hidden: true }, t('translate.online.bad'));
    const save = () => {
      const value = field.value.trim();
      if (!value) {
        if (had) {
          setMyMemoryEmail('');
          toast(t('translate.online.removed'));
          onDone?.();
        }
        return close(null);
      }
      if (!isEmail(value)) {
        problem.hidden = false;
        field.focus();
        return;
      }
      setMyMemoryEmail(value);
      toast(t('translate.online.saved'));
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
      h('div', { class: 'modal-kicker' }, t('translate.online.kicker')),
      h('h2', { class: 'modal-title' }, t('translate.online.title')),
      h('p', { class: 'modal-text' }, t('translate.online.about')),
      field,
      problem,
      h(
        'div',
        { class: 'modal-actions' },
        had
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: () => {
                  setMyMemoryEmail('');
                  toast(t('translate.online.removed'));
                  close(false);
                  onDone?.();
                },
              },
              t('translate.online.remove'),
            )
          : null,
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: save }, t('translate.online.save')),
      ),
    );
  });
}
