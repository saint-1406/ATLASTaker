// Dictation: speech becomes text at the cursor. Two engines behind one interface:
//   - Android: the phone's own speech recognition, through the app's native side
//     (MainActivity.java: startDictation / stopDictation, results back via window.__atlas.dictation);
//     it works offline where the language pack is on the phone;
//   - a browser with the Web Speech API (Edge, Chrome): the browser's recognition service, online —
//     in Edge the sound goes to Microsoft's cloud, in Chrome to Google's.
// While someone speaks, the words so far are shown greyed at the cursor; a finished phrase is put in.

import { STRINGS } from './i18n.js';

/** "ru" → "ru-RU": the language the recognizer listens for. */
export const speechTag = (lang) => ({ ru: 'ru-RU', en: 'en-US' })[lang] ?? 'en-US';

// spoken commands (dictation.spoken in i18n.js), in any of the languages, whole phrases only:
// "new paragraph" makes an empty line, "new line" a line break
const spoken = (key) => Object.values(STRINGS).map((words) => words.dictation.spoken[key]);
const command = (phrases) => new RegExp(`\\s*(?<!\\p{L})(?:${phrases.join('|')})(?!\\p{L})[.,!?]?\\s*`, 'giu');
const COMMANDS = [
  [command(spoken('newParagraph')), '\n\n'],
  [command(spoken('newLine')), '\n'],
];

/** The spoken commands in a phrase turned into what they mean. */
export const applyCommands = (text) => COMMANDS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

/**
 * What to insert for a recognized phrase, given the text just before the cursor: a space where the
 * words would otherwise touch, a capital letter at the start of a line or after a full stop.
 */
export function joinDictated(before, text) {
  let phrase = applyCommands(String(text ?? '')).replace(/[ \t]+/g, ' ');
  if (!phrase.startsWith('\n')) phrase = phrase.trimStart();
  phrase = phrase.trimEnd();
  if (!phrase.trim()) return phrase.includes('\n') ? phrase : '';
  const atLineStart = !before || before.endsWith('\n') || phrase.startsWith('\n');
  const afterSentence = /[.!?…]\s*$/.test(before.slice(-3));
  if (atLineStart || afterSentence) phrase = phrase.replace(/^(\n*)(\p{Ll})/u, (_, breaks, letter) => breaks + letter.toUpperCase());
  const touching = before && !/\s$/.test(before) && !/^[\s,.!?;:…)\]]/.test(phrase);
  return (touching ? ' ' : '') + phrase;
}

/**
 * handlers: { partial(text), final(text), state(listening), error(code) } — codes: "not-allowed"
 * (no microphone), "network", "language", "busy", "no-service", "failed".
 * Returns { supported, listening, start(lang), stop(), receive(event) } (receive: Android's events).
 */
export function createDictation({ android = null, handlers }) {
  let listening = false;
  const setListening = (on) => {
    if (on === listening) return;
    listening = on;
    handlers.state(on);
  };

  // ---------- Android ----------
  if (android?.startDictation) {
    let available = null;
    return {
      get supported() {
        available ??= Boolean(android.canDictate());
        return available;
      },
      get listening() {
        return listening;
      },
      start(lang) {
        setListening(true);
        android.startDictation(speechTag(lang));
      },
      stop() {
        android.stopDictation();
        setListening(false);
      },
      /** { type: "listening" | "partial" | "final" | "end" | "error", text, code } from the native side. */
      receive(event) {
        if (event?.type === 'partial') handlers.partial(event.text ?? '');
        else if (event?.type === 'final') {
          handlers.partial('');
          handlers.final(event.text ?? '');
        } else if (event?.type === 'end') {
          handlers.partial('');
          setListening(false);
        } else if (event?.type === 'error') {
          handlers.partial('');
          setListening(false);
          handlers.error(event.code ?? 'failed');
        }
      },
    };
  }

  // ---------- the browser ----------
  const Recognition = typeof window === 'object' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  let recognition = null;
  let wanted = false;
  let silent = 0; // restarts in a row with nothing heard: after a few, the microphone goes off
  const ERRORS = { 'not-allowed': 'not-allowed', 'service-not-allowed': 'not-allowed', 'audio-capture': 'not-allowed', network: 'network', 'language-not-supported': 'language' };

  function begin(lang) {
    recognition = new Recognition();
    recognition.lang = speechTag(lang);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => {
      silent = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          handlers.partial('');
          handlers.final(result[0].transcript);
        } else interim += result[0].transcript;
      }
      handlers.partial(interim);
    };
    recognition.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      wanted = false;
      handlers.error(ERRORS[e.error] ?? 'failed');
    };
    // the browser stops listening after a pause: while dictation is on, it starts again
    recognition.onend = () => {
      handlers.partial('');
      if (wanted && ++silent <= 3) {
        try {
          recognition.start();
          return;
        } catch {
          // could not start again: dictation ends
        }
      }
      wanted = false;
      setListening(false);
    };
    recognition.start();
  }

  return {
    supported: Boolean(Recognition),
    get listening() {
      return listening;
    },
    start(lang) {
      if (!Recognition) return;
      wanted = true;
      silent = 0;
      setListening(true);
      try {
        begin(lang);
      } catch {
        wanted = false;
        setListening(false);
        handlers.error('failed');
      }
    },
    stop() {
      wanted = false;
      recognition?.stop();
      setListening(false);
    },
    receive() {},
  };
}
