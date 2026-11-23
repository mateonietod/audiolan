// What the page and the server must agree on. The browser imports this file;
// the server require()s it (Node loads an ES module that way), so there is one
// copy. No DOM, no app state.

/** Bump when the signaling messages change. Every computer must match. */
export const PROTOCOL = 2;

const MAX_NAME = 32;
// Control characters, bidi overrides and invisible characters. Zero-width
// joiner (U+200D) stays, since emoji sequences need it.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/** @param {unknown} input */
export function cleanName(input) {
  const name = String(input ?? '')
    .normalize('NFC')
    .replace(/[\t\n\v\f\r]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...name].slice(0, MAX_NAME).join('') || 'Guest';
}
