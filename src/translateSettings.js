// Translation in the settings: "Online translation: MyMemory" takes an optional e-mail that raises its
// free daily allowance from about 5,000 to about 50,000 characters (kept on this device only); "Offline
// translation" downloads Firefox's model ahead of time (src/bergamot.js).

import { h, openDialog, toast } from './overlays.js';
import { t } from './i18n.js';
import { isEmail, myMemoryEmail, setMyMemoryEmail } from './translate.js';

/**
 * Firefox's offline model ahead of time (translateCard.js: offline, prepareOffline): a dialog that
 * downloads both directions with a bar. onDone() once it is here.
 */
export function openOfflineDialog({ translator, onDone }) {
  openDialog((box, close) => {
    const bar = h('i');
    const progress = h('div', { class: 'tr-progress', hidden: true }, bar);
    const note = h('p', { class: 'modal-hint', hidden: true });
    const go = h('button', { type: 'button', class: 'btn primary', 'data-autofocus': true }, t('translate.offline.download'));
    go.onclick = async () => {
      go.disabled = true;
      progress.hidden = false;
      note.hidden = false;
      note.textContent = t('translate.downloading');
      try {
        await translator.prepareOffline((share) => {
          progress.classList.add('known');
          bar.style.transform = `scaleX(${Math.min(1, share)})`;
          note.textContent = t('translate.downloadingPct', Math.round(share * 100));
        });
        toast(t('translate.offline.done'));
        close(true);
        onDone?.();
      } catch {
        note.textContent = t('translate.errors.download');
        go.disabled = false;
      }
    };
    box.append(
      h('div', { class: 'modal-kicker' }, t('translate.online.kicker')),
      h('h2', { class: 'modal-title' }, t('translate.offline.title')),
      h('p', { class: 'modal-text' }, t('translate.offline.about')),
      progress,
      note,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')), go),
    );
  });
}

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
