// Was it a finger? A phone's WebView may send "contextmenu" at the end of a long press or when a
// selection handle is let go, without saying it came from touch (some Xiaomi phones do). The app's own
// right-click menu must not open then: it takes the focus, the keyboard goes and the selection with it.

let lastPointer = '';
let lastAt = 0;
document.addEventListener(
  'pointerdown',
  (event) => {
    lastPointer = event.pointerType;
    lastAt = Date.now();
  },
  true,
);

/** True when a "contextmenu" (or a like event) comes from a finger or a pen, not from a mouse. */
export function fromTouch(event) {
  if (event.pointerType === 'touch' || event.pointerType === 'pen' || event.sourceCapabilities?.firesTouchEvents) return true;
  if (event.pointerType === 'mouse') return false;
  if (lastPointer === 'mouse' && Date.now() - lastAt < 10_000) return false;
  return lastPointer === 'touch' || lastPointer === 'pen' || matchMedia('(pointer: coarse)').matches;
}
