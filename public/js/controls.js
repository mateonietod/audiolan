// Mute, open mic vs. push-to-talk, and the talk key.

import { updateCallSession } from './pwa.js';
import { send } from './signaling.js';
import { state } from './state.js';
import { $, isTyping, keyLabel, store } from './util.js';
import { renderPeers } from './view.js';

/** Whether the mic is being sent to the room right now. */
export function transmitting() {
  if (!state.localStream || state.muted) return false;
  if (state.mode === 'ptt') return state.pttHeld || state.pointerHeld;
  return true;
}

export function applyTransmit() {
  // Outside a room the track only feeds the mic test, so keep it on.
  const on = state.inRoom ? transmitting() : !!state.localStream;
  if (state.localStream) {
    for (const track of state.localStream.getAudioTracks()) track.enabled = on;
  }
  renderControls();
}

/** @param {'open' | 'ptt'} mode */
function setMode(mode) {
  state.mode = mode === 'ptt' ? 'ptt' : 'open';
  if (state.mode !== 'ptt') releaseHold();
  store.set('audiolan.mode', state.mode);
  applyTransmit();
}

/** @param {boolean} muted */
export function setMuted(muted) {
  state.muted = muted;
  if (muted) releaseHold();
  applyTransmit();
  send({ type: 'presence', muted: state.muted });
  renderPeers();
  updateCallSession();
}

export function releaseHold() {
  if (!state.pttHeld && !state.pointerHeld) return;
  state.pttHeld = false;
  state.pointerHeld = false;
  applyTransmit();
}

/** @param {boolean} held */
function holdKey(held) {
  if (state.pttHeld === held) return;
  state.pttHeld = held;
  applyTransmit();
}

export function bindControls() {
  $('mute').addEventListener('click', () => setMuted(!state.muted));
  $('mode-open').addEventListener('click', () => setMode('open'));
  $('mode-ptt').addEventListener('click', () => setMode('ptt'));
  $('bind').addEventListener('click', armBind);
  bindTalkButton();
  bindKeys();
}

function bindTalkButton() {
  const talk = $('talk');
  talk.addEventListener('pointerdown', (event) => {
    if (state.mode !== 'ptt' || state.binding) return;
    event.preventDefault();
    talk.setPointerCapture?.(event.pointerId);
    state.pointerHeld = true;
    applyTransmit();
  });
  const release = () => {
    if (!state.pointerHeld) return;
    state.pointerHeld = false;
    applyTransmit();
  };
  talk.addEventListener('pointerup', release);
  talk.addEventListener('pointercancel', release);
  talk.addEventListener('lostpointercapture', release);
  // A long press on a phone would open the context menu and steal the pointer.
  talk.addEventListener('contextmenu', (event) => event.preventDefault());
}

function bindKeys() {
  window.addEventListener('keydown', (event) => {
    if (state.binding || !state.inRoom || isTyping(event.target)) return;
    if (state.mode === 'ptt' && event.code === state.pttKey) {
      event.preventDefault();
      if (!event.repeat) holdKey(true);
      return;
    }
    if (event.code === 'KeyM' && !event.repeat && state.pttKey !== 'KeyM'
      && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setMuted(!state.muted);
    }
  });
  window.addEventListener('keyup', (event) => {
    if (state.mode !== 'ptt' || event.code !== state.pttKey) return;
    // Space and Enter activate a focused button on keyup. Without this,
    // releasing the talk key would also click whatever was clicked last.
    if (!isTyping(event.target)) event.preventDefault();
    holdKey(false);
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.inRoom || event.button < 3) return;
    // Side buttons would otherwise navigate back and drop the call.
    event.preventDefault();
    if (state.binding || state.mode !== 'ptt' || state.pttKey !== `Mouse${event.button}`) return;
    holdKey(true);
  }, true);
  window.addEventListener('mouseup', (event) => {
    if (event.button < 3) return;
    if (state.inRoom) event.preventDefault();
    if (state.pttKey === `Mouse${event.button}`) holdKey(false);
  }, true);
  window.addEventListener('auxclick', (event) => {
    if (event.button >= 3) event.preventDefault();
  }, true);
}

function armBind() {
  if (state.binding) return;
  state.binding = true;
  renderControls();
  /** @param {string | null} code */
  const finish = (code) => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    state.binding = false;
    state.cancelBind = null;
    if (code) {
      state.pttKey = code;
      store.set('audiolan.ptt', code);
    }
    renderControls();
  };
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    event.preventDefault();
    event.stopPropagation();
    finish(event.code === 'Escape' ? null : event.code);
  };
  /** @param {MouseEvent} event */
  const onMouse = (event) => {
    if (event.button < 3) return;
    event.preventDefault();
    event.stopPropagation();
    finish(`Mouse${event.button}`);
  };
  state.cancelBind = () => finish(null);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
}

export function cancelBind() {
  state.cancelBind?.();
}

export function renderControls() {
  const live = state.inRoom && transmitting();
  const mute = $('mute');
  // The label says what the button does. No aria-pressed, so a screen reader
  // does not announce "Unmute, pressed".
  mute.dataset.muted = String(state.muted);
  $('mute-label').textContent = state.muted ? 'Unmute' : 'Mute';
  $('mode-open').setAttribute('aria-pressed', String(state.mode === 'open'));
  $('mode-ptt').setAttribute('aria-pressed', String(state.mode === 'ptt'));
  const ptt = state.mode === 'ptt';
  $('talk').hidden = !ptt;
  $('bind').hidden = !ptt;
  $('talk-key').textContent = keyLabel(state.pttKey);
  $('talk').classList.toggle('is-hot', ptt && live);
  $('bind').classList.toggle('is-armed', state.binding);
  $('bind').textContent = state.binding ? 'Press a key' : 'Change key';
  $('flag').classList.toggle('is-on', live);
  $('flag-label').textContent = state.muted ? 'Muted' : (live ? 'Live' : 'Ready');
}
