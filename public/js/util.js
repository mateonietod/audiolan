// Small helpers with no app state. Safe to import from Node tests.

import { cleanName } from './protocol.js';

export { cleanName };

/** @param {string} id */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

export const store = {
  /** @param {string} key */
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  /** @param {string} key @param {string} value */
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

/** @param {string} name */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return '·';
  const first = (part) => [...part][0] || '';
  if (parts.length === 1) return first(parts[0]).toUpperCase();
  return (first(parts[0]) + first(parts[1])).toUpperCase();
}

/** @param {string} code */
export function keyLabel(code) {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Mouse')) return `Mouse ${Number(code.slice(5)) + 1}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * Turn what someone typed into host:port. Drops any scheme and path.
 * @param {string} value
 * @param {string} fallbackPort
 */
export function normalizeHost(value, fallbackPort) {
  let host = String(value || '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '');
  if (!host) return '';
  if (host.startsWith('[')) {
    if (!host.includes(']:')) host = `${host}:${fallbackPort}`;
  } else if (!host.includes(':')) {
    host = `${host}:${fallbackPort}`;
  }
  return host.toLowerCase();
}

/**
 * Settings passed in the URL fragment, e.g. #name=Kitchen&debug.
 * @param {string} hash
 */
export function readHash(hash) {
  return new URLSearchParams(String(hash || '').replace(/^#/, ''));
}

/** A mouse or trackpad is the main pointer, so a physical keyboard is likely. */
export function hasKeyboard() {
  return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** @param {HTMLElement | EventTarget | null} target */
export function isTyping(target) {
  if (!target || !(/** @type {any} */ (target).tagName)) return false;
  const element = /** @type {HTMLElement} */ (target);
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable;
}

/**
 * Ask the other side to send audio in short frames. A sender takes its frame
 * length from the description it receives, so this edits the copy that goes
 * over the wire, never our own local description. 10 ms frames cut about
 * 10 ms from each direction against the 20 ms default, for twice the packets.
 * @param {string} sdp
 * @param {number} [ms]
 */
export function preferFrameLength(sdp, ms = 10) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const trailing = lines[lines.length - 1] === '' ? lines.pop() : undefined;
  /** @type {string[]} */
  const out = [];
  let audio = false;
  const close = () => {
    if (audio) out.push(`a=ptime:${ms}`);
  };
  for (const line of lines) {
    if (line.startsWith('m=')) {
      close();
      audio = line.startsWith('m=audio');
    }
    if (audio && line.startsWith('a=ptime:')) continue;
    out.push(line);
  }
  close();
  if (trailing !== undefined) out.push(trailing);
  return out.join(eol);
}

/**
 * Candidates worth sending. TCP would carry voice with head-of-line delays,
 * and the empty end-of-candidates marker is ignored by the other side.
 * @param {{ candidate?: string, protocol?: string | null } | null} candidate
 */
export function worthSending(candidate) {
  if (!candidate || !candidate.candidate) return false;
  if (candidate.protocol) return candidate.protocol.toLowerCase() === 'udp';
  return !/ tcp /i.test(candidate.candidate);
}

/**
 * Who is on the call, in words: "Bob", "Bob and Alice", "Bob, Alice and more".
 * Empty when nobody is. At most two names are shown.
 * @param {unknown} people `{ count, names }` from /rooms
 */
export function describePeople(people) {
  const info = /** @type {{ count?: unknown, names?: unknown } | null} */ (people);
  const count = Number.isInteger(info?.count) ? Number(info?.count) : 0;
  if (count <= 0) return '';
  const names = (Array.isArray(info?.names) ? info.names : []).slice(0, 2).map(cleanName);
  if (names.length === 0) return count === 1 ? 'Someone' : `${count} people`;
  if (count === 1) return names[0];
  if (count === 2 && names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.join(', ')} and more`;
}
