// Installable-app extras: service worker, keeping the screen awake during a
// call, and the system call controls (Media Session).

import { state } from './state.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Browsers refuse service workers on a certificate they do not trust,
    // which is normal for the self-signed LAN certificate. The app still works.
  });
}

/** @type {any} */
let wakeLock = null;

export async function holdWakeLock() {
  const nav = /** @type {any} */ (navigator);
  if (!nav.wakeLock || document.hidden || wakeLock || !state.inRoom) return;
  try {
    wakeLock = await nav.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null; // Battery saver or no permission. Not worth a message.
  }
}

export function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
}

/** @type {{ toggleMic: () => void, hangUp: () => void } | null} */
let handlers = null;

/** @param {{ toggleMic: () => void, hangUp: () => void }} actions */
export function bindCallSession(actions) {
  handlers = actions;
}

/** Show the call in the system UI while in a room. */
export function updateCallSession() {
  const session = /** @type {any} */ (navigator).mediaSession;
  if (!session) return;
  const active = state.inRoom && !!handlers;
  try {
    if (active && typeof MediaMetadata === 'function') {
      const total = state.peers.size + 1;
      session.metadata = new MediaMetadata({
        title: 'audiolan',
        artist: total === 1 ? 'Just you' : `${total} on the line`,
      });
    } else {
      session.metadata = null;
    }
  } catch { /* metadata is optional */ }
  for (const [action, run] of /** @type {[string, (() => void) | undefined][]} */ ([
    ['togglemicrophone', handlers?.toggleMic],
    ['hangup', handlers?.hangUp],
  ])) {
    try { session.setActionHandler(action, active && run ? run : null); } catch { /* unsupported action */ }
  }
  try { session.setMicrophoneActive?.(active && !state.muted); } catch { /* unsupported */ }
}
