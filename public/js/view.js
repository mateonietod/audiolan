// Everything that paints: screens, people, meters, the audio menu.

import { applyTransmit, transmitting } from './controls.js';
import { micGranted, refreshDevices } from './media.js';
import { retryPeer } from './peers.js';
import { state } from './state.js';
import { $, hasKeyboard, initials } from './util.js';

const BARS = 12;
const BAR_STATE = new Float32Array(BARS);
const TIME = new Uint8Array(512);
const FREQ = new Uint8Array(256);

/* Screens */

export function joinLabel() {
  if (state.roomRole === 'join') return 'Join the line';
  if (state.roomRole === 'host') return 'Open the room';
  return 'Join';
}

export function enterRoom() {
  state.joining = false;
  state.inRoom = true;
  $('join').hidden = true;
  $('room').hidden = false;
  resetJoinButton();
  // Outside the room the mic test keeps the track on. Apply the real mode now.
  applyTransmit();
  renderPeers();
  startMeters();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function showJoin() {
  $('room').hidden = true;
  $('join').hidden = false;
  resetJoinButton();
  renderJoinMic();
  if (hasKeyboard()) $('name').focus();
}

export function resetJoinButton() {
  const button = /** @type {HTMLButtonElement} */ ($('join-button'));
  button.disabled = false;
  button.textContent = joinLabel();
}

/** @param {string} text */
export function setJoinBusy(text) {
  const button = /** @type {HTMLButtonElement} */ ($('join-button'));
  button.disabled = true;
  button.textContent = text;
}

/**
 * The "on the call now" line on the join screen. Hidden when nobody is on.
 * @param {string} names from describePeople
 */
export function paintOnCall(names) {
  const box = $('on-call');
  box.hidden = !names;
  const node = $('on-call-names');
  if (node.textContent !== names) node.textContent = names;
}

/** @param {any} data */
export function paintShare(data) {
  const box = $('share');
  const urls = data?.urls || [];
  box.replaceChildren();
  if (!urls.length) {
    box.hidden = true;
    return;
  }
  const label = document.createElement('p');
  label.className = 'label';
  label.textContent = state.roomRole === 'join' ? 'Joining the room at' : 'On a phone, open';
  box.append(label);
  for (const url of urls) {
    const line = document.createElement('p');
    line.textContent = url;
    box.append(line);
  }
  box.hidden = false;
}

/** @param {string} text */
export function showError(text) {
  const node = $('join-error');
  node.hidden = false;
  node.textContent = text;
}

export function clearError() {
  const node = $('join-error');
  node.hidden = true;
  node.textContent = '';
}

/** Mic and speaker errors go next to the pickers the person is looking at. @param {string} text */
export function reportDeviceError(text) {
  if (!state.inRoom) {
    showError(text);
    return;
  }
  const node = $('device-error');
  node.hidden = false;
  node.textContent = text;
  openAudioMenu();
}

export function clearDeviceError() {
  const node = $('device-error');
  node.hidden = true;
  node.textContent = '';
}

/** The mic check and device pickers on the join screen. */
export function renderJoinMic() {
  const button = $('mic-test');
  button.textContent = state.testing ? 'Stop test' : 'Test microphone';
  button.setAttribute('aria-pressed', String(state.testing));
  $('test-level').hidden = !state.testing;
  const granted = micGranted();
  // Before permission the browser hides device names, so a picker would only
  // offer "System default". Show it once there is something to choose.
  $('join-devices').hidden = !granted;
  $('mic-hint').textContent = granted
    ? (state.testing ? 'Speak. The bar should move.' : 'Choose devices, or test the mic first.')
    : 'Check your mic and choose devices before you join.';
}

/* People */

/** @param {string} id */
function createNode(id) {
  const node = document.createElement('div');
  node.className = 'peer';
  node.dataset.peer = id;
  node.setAttribute('role', 'listitem');
  node.style.setProperty('--level', '0');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  const halo = document.createElement('span');
  halo.className = 'halo';
  const letter = document.createElement('span');
  letter.className = 'letter';
  const slash = document.createElement('span');
  slash.className = 'slash';
  avatar.append(halo, letter, slash);
  const name = document.createElement('p');
  name.className = 'name';
  const sub = document.createElement('p');
  sub.className = 'sub';
  node.append(avatar, name, sub);
  if (id !== 'local') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = 'Retry';
    retry.hidden = true;
    retry.addEventListener('click', () => retryPeer(id));
    node.append(retry);
  }
  return node;
}

/**
 * @param {HTMLElement} node
 * @param {{ name: string, sub: string, muted: boolean, failed?: boolean }} view
 */
function paint(node, { name, sub, muted, failed = false }) {
  setText(/** @type {HTMLElement} */ (node.querySelector('.letter')), initials(name));
  setText(/** @type {HTMLElement} */ (node.querySelector('.name')), name);
  setText(/** @type {HTMLElement} */ (node.querySelector('.sub')), sub);
  node.classList.toggle('is-muted', muted);
  node.classList.toggle('is-failed', failed);
  const retry = /** @type {HTMLElement | null} */ (node.querySelector('.retry'));
  if (retry) {
    retry.hidden = !failed;
    retry.setAttribute('aria-label', `Retry connecting to ${name}`);
  }
}

/** @param {HTMLElement} node @param {string} text */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** @param {import('./state.js').Peer} peer */
function statusText(peer) {
  if (peer.muted) return 'Muted';
  if (peer.status === 'failed') return 'Can\'t connect';
  if (peer.status === 'linking') return 'Connecting…';
  if (peer.status === 'unstable') return 'Reconnecting…';
  // Empty unless the page was opened with #debug. See stats.js.
  return peer.stats;
}

export function renderPeers() {
  const list = $('peers');
  if (!state.localNode) state.localNode = createNode('local');
  paint(state.localNode, { name: state.name, sub: state.muted ? 'Muted' : 'You', muted: state.muted });

  const peers = [...state.peers.values()].sort((a, b) => (
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  ));
  const order = [state.localNode];
  for (const peer of peers) {
    if (!peer.node) peer.node = createNode(peer.id);
    paint(peer.node, {
      name: peer.name,
      sub: statusText(peer),
      muted: peer.muted,
      failed: peer.status === 'failed' && !peer.muted,
    });
    order.push(peer.node);
  }
  const keep = new Set(order);
  for (const child of [...list.children]) {
    if (!keep.has(/** @type {HTMLElement} */ (child))) child.remove();
  }
  // Move only what is out of place, so hover and focus are not disturbed.
  order.forEach((node, index) => {
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  $('alone').hidden = peers.length > 0;

  if (!state.inRoom) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const total = peers.length + 1;
    setCount(total === 1 ? 'Just you' : `${total} on the line`);
  }
}

/** @param {string} text */
export function setCount(text) {
  const count = $('count');
  if (count.textContent !== text) count.textContent = text;
}

/* Audio menu */

const panel = () => $('audio-panel');
const popovers = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
// With CSS anchor positioning the stylesheet places the popover itself.
const anchored = popovers && typeof CSS !== 'undefined' && CSS.supports('position-anchor: --audio-menu');

export function bindAudioMenu() {
  const button = $('audio-menu');
  const box = panel();
  if (popovers) {
    // The browser handles opening, light dismiss, Escape and focus return.
    box.hidden = false;
    box.addEventListener('toggle', (event) => {
      const open = /** @type {any} */ (event).newState === 'open';
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        refreshDevices();
        placeAudioMenu();
      }
    });
  } else {
    box.removeAttribute('popover');
    button.removeAttribute('popovertarget');
    button.addEventListener('click', () => (box.hidden ? openAudioMenu() : closeAudioMenu()));
    document.addEventListener('pointerdown', (event) => {
      const target = /** @type {Element | null} */ (event.target);
      if (!target?.closest?.('#audio-panel, #audio-menu')) closeAudioMenu();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !box.hidden) {
        closeAudioMenu();
        button.focus();
      }
    });
  }
  window.addEventListener('resize', placeAudioMenu);
}

function isMenuOpen() {
  const box = panel();
  return popovers ? box.matches(':popover-open') : !box.hidden;
}

function openAudioMenu() {
  if (isMenuOpen()) return;
  const box = panel();
  if (popovers) {
    box.showPopover();
    return;
  }
  box.hidden = false;
  $('audio-menu').setAttribute('aria-expanded', 'true');
  refreshDevices();
  placeAudioMenu();
}

export function closeAudioMenu() {
  if (!isMenuOpen()) return;
  const box = panel();
  if (popovers) box.hidePopover();
  else box.hidden = true;
  $('audio-menu').setAttribute('aria-expanded', 'false');
}

function placeAudioMenu() {
  if (anchored || !isMenuOpen()) return;
  const box = panel();
  const anchor = $('audio-menu').getBoundingClientRect();
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - 12 - width));
  let top = anchor.top - height - 8;
  if (top < 12) top = Math.min(anchor.bottom + 8, window.innerHeight - height - 12);
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.max(12, top))}px`;
}

/* Meters */

export function buildMeter() {
  const meter = $('meter');
  for (let i = 0; i < BARS; i += 1) meter.append(document.createElement('span'));
}

/** @param {AnalyserNode} analyser */
function rms(analyser) {
  analyser.getByteTimeDomainData(TIME);
  let sum = 0;
  for (let i = 0; i < TIME.length; i += 1) {
    const sample = (TIME[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / TIME.length);
}

/**
 * @param {HTMLElement | null} node
 * @param {number} level
 * @param {boolean} live
 */
function paintLevel(node, level, live) {
  if (!node) return;
  node.style.setProperty('--level', level.toFixed(3));
  node.classList.toggle('is-live', live);
}

/**
 * @param {AnalyserNode} analyser
 * @param {boolean} active
 */
function paintMeter(analyser, active) {
  const bars = /** @type {HTMLCollectionOf<HTMLElement>} */ ($('meter').children);
  if (!active) {
    for (let i = 0; i < BARS; i += 1) {
      BAR_STATE[i] *= 0.8;
      bars[i].style.transform = `scaleY(${0.16 + BAR_STATE[i] * 0.84})`;
    }
    return;
  }
  const energy = Math.min(1, rms(analyser) * 7);
  analyser.getByteFrequencyData(FREQ);
  for (let i = 0; i < BARS; i += 1) {
    let peak = 0;
    const start = 1 + i * 3;
    for (let j = 0; j < 3; j += 1) peak = Math.max(peak, FREQ[start + j] || 0);
    const shaped = 0.55 + 0.45 * Math.sin((i + 0.5) * 0.7);
    const target = Math.min(1, peak / 180 + energy * shaped);
    const speed = target > BAR_STATE[i] ? 0.55 : 0.2;
    BAR_STATE[i] += (target - BAR_STATE[i]) * speed;
    bars[i].style.transform = `scaleY(${0.16 + BAR_STATE[i] * 0.84})`;
  }
}

/**
 * @param {number} current
 * @param {number} next
 */
function ease(current, next) {
  return current + (next - current) * (next > current ? 0.45 : 0.14);
}

let metering = false;

function tick() {
  // Nothing to draw outside a call or a mic test. Stop, and let the next
  // call or test start the loop again, so an idle tab costs no frames.
  if (!state.inRoom && !state.testing) {
    metering = false;
    return;
  }
  try {
    if (!document.hidden) frame();
  } catch (error) {
    console.warn('meter', error);
  }
  requestAnimationFrame(tick);
}

function frame() {
  const analyser = state.localTap?.analyser;
  if (analyser) {
    state.level = ease(state.level, Math.min(1, rms(analyser) * 4.5));
    if (state.inRoom) {
      const sending = transmitting();
      const speaking = state.speaking ? state.level > 0.05 : state.level > 0.09;
      state.speaking = speaking && sending;
      paintLevel(state.localNode, state.speaking ? state.level : state.level * 0.25, state.speaking && !state.muted);
      paintMeter(analyser, sending);
    } else if (state.testing) {
      /** @type {HTMLElement} */ ($('test-level').firstElementChild).style.transform = `scaleX(${state.level.toFixed(3)})`;
    }
  }
  if (!state.inRoom) return;
  for (const peer of state.peers.values()) {
    if (!peer.tap) continue;
    peer.smooth = ease(peer.smooth, Math.min(1, rms(peer.tap.analyser) * 4.5));
    peer.speaking = peer.speaking ? peer.smooth > 0.05 : peer.smooth > 0.09;
    paintLevel(peer.node, peer.speaking ? peer.smooth : peer.smooth * 0.35, peer.speaking && !peer.muted);
  }
}

export function startMeters() {
  if (metering) return;
  metering = true;
  requestAnimationFrame(tick);
}
