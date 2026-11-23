import { applyTransmit, bindControls, cancelBind, releaseHold, renderControls, setMuted } from './controls.js';
import { bindDevices, getCtx, idleAudio, micAlive, micMessage, openMic, refreshDevices, releaseMic } from './media.js';
import { dropPeers } from './peers.js';
import {
  bindCallSession,
  holdWakeLock,
  registerServiceWorker,
  releaseWakeLock,
  updateCallSession,
} from './pwa.js';
import { openSocket, reconnectNow, sayGoodbye, startWatchdog, stopWatchdog } from './signaling.js';
import { startStats, stopStats } from './stats.js';
import { state } from './state.js';
import { $, cleanName, describePeople, hasKeyboard, normalizeHost, readHash, store } from './util.js';
import {
  bindAudioMenu,
  buildMeter,
  clearError,
  closeAudioMenu,
  paintOnCall,
  paintShare,
  renderJoinMic,
  resetJoinButton,
  setJoinBusy,
  showError,
  showJoin,
  startMeters,
} from './view.js';

const ROOM_POLL_MS = 5000;

init();

function init() {
  adoptHashName();
  const saved = store.get('audiolan.name');
  const nameInput = /** @type {HTMLInputElement} */ ($('name'));
  if (saved) nameInput.value = saved;
  buildMeter();
  $('join-form').addEventListener('submit', onJoin);
  $('leave').addEventListener('click', leave);
  $('mic-test').addEventListener('click', toggleMicTest);
  bindControls();
  bindDevices();
  bindAudioMenu();
  bindCallSession({ toggleMic: () => setMuted(!state.muted), hangUp: leave });
  bindLifecycle();
  document.addEventListener('pointerdown', unlockAudio);
  resetJoinButton();
  renderControls();
  renderJoinMic();
  refreshDevices();
  lookForRoom();
  watchRoom();
  registerServiceWorker();
  // On a phone, focusing would open the keyboard before anyone asked for it.
  if (!saved && hasKeyboard()) nameInput.focus();
}

/** "Another address" hands the name over in the URL, since storage is per address. */
function adoptHashName() {
  const hash = readHash(location.hash);
  const name = hash.get('name');
  if (!name) return;
  store.set('audiolan.name', cleanName(name));
  hash.delete('name');
  const rest = hash.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
}

function bindLifecycle() {
  window.addEventListener('blur', releaseHold);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseHold();
      return;
    }
    if (!state.inRoom) return;
    holdWakeLock();
    reconnectNow();
  });
  window.addEventListener('online', reconnectNow);
  window.addEventListener('pagehide', () => {
    if (state.inRoom) sayGoodbye();
  });
  window.addEventListener('pageshow', (event) => {
    // Back from the back/forward cache. The server already let this tab go.
    if (event.persisted && state.inRoom) {
      state.id = null;
      state.token = null;
      reconnectNow();
    }
  });
}

/** The room role only changes wording. The server decides when the socket connects. */
async function lookForRoom() {
  /** @type {any} */
  let data = null;
  try {
    const response = await fetch('/rooms', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    data = response.ok ? await response.json() : null;
  } catch { /* The wording falls back below. The call can still start. */ }
  if (state.inRoom) return;
  const onCall = describePeople(data?.people);
  paintOnCall(onCall);
  if (data) {
    state.roomRole = data.role === 'join' ? 'join' : 'host';
    $('lede').textContent = onCall
      ? 'A call is on. Enter your name to join it.'
      : (state.roomRole === 'join'
        ? 'A room is already open. Enter your name to join it.'
        : 'No room on this network yet. You will open one.');
    paintShare(data);
  } else {
    state.roomRole = 'host';
    $('lede').textContent = 'Enter your name to open the room on this computer.';
    $('share').hidden = true;
  }
  if (!state.joining) resetJoinButton();
}

/**
 * Keep the join screen current while someone is deciding whether to join.
 * Only while it is showing: a call in progress does not poll.
 */
function watchRoom() {
  window.setInterval(() => {
    if (state.inRoom || state.joining || document.hidden) return;
    lookForRoom();
  }, ROOM_POLL_MS);
}

function manualHost() {
  const box = /** @type {HTMLDetailsElement} */ ($('elsewhere'));
  if (!box.open) return '';
  return normalizeHost(/** @type {HTMLInputElement} */ ($('host')).value, location.port || '8787');
}

function micSupported() {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

async function toggleMicTest() {
  clearError();
  if (state.testing) {
    releaseMic();
    renderJoinMic();
    idleAudio();
    return;
  }
  if (!micSupported()) {
    showError('The microphone needs the https address printed by the server.');
    return;
  }
  getCtx().resume().catch(() => {});
  const session = state.session;
  try {
    await openMic(state.inputId);
    if (session !== state.session || state.inRoom) return;
    state.testing = true;
    applyTransmit();
    startMeters();
  } catch (error) {
    showError(micMessage(error));
  }
  renderJoinMic();
}

/** @param {SubmitEvent} event */
async function onJoin(event) {
  event.preventDefault();
  if (state.joining) return;
  clearError();
  if (!micSupported()) {
    showError('The microphone needs the https address printed by the server.');
    return;
  }
  state.name = cleanName(/** @type {HTMLInputElement} */ ($('name')).value);
  store.set('audiolan.name', state.name);
  const chosen = manualHost();
  if (chosen && chosen !== location.host.toLowerCase()) {
    location.assign(`https://${chosen}/#name=${encodeURIComponent(state.name)}`);
    return;
  }
  const session = ++state.session;
  state.leaving = false;
  state.joining = true;
  state.id = null;
  state.token = null;
  setJoinBusy(state.roomRole === 'join' ? 'Joining…' : 'Opening…');
  // Start audio inside the click, before any await, so Safari allows it.
  getCtx().resume().catch(() => {});
  try {
    if (!micAlive()) await openMic(state.inputId);
    if (session !== state.session) return;
    state.testing = false;
    await openSocket();
    if (session !== state.session) return;
    startWatchdog();
    startStats();
    holdWakeLock();
    updateCallSession();
  } catch (error) {
    if (session !== state.session || /** @type {any} */ (error).superseded) return;
    releaseMic();
    sayGoodbye();
    state.joining = false;
    state.inRoom = false;
    resetJoinButton();
    renderJoinMic();
    idleAudio();
    showError(micMessage(error));
  }
}

function leave() {
  state.session += 1;
  state.leaving = true;
  state.inRoom = false;
  state.joining = false;
  window.clearTimeout(state.reconnectTimer);
  stopWatchdog();
  stopStats();
  cancelBind();
  releaseHold();
  closeAudioMenu();
  sayGoodbye();
  dropPeers();
  releaseMic();
  state.id = null;
  state.token = null;
  state.outbox = [];
  releaseWakeLock();
  updateCallSession();
  renderControls();
  showJoin();
  idleAudio();
  // The line still shows who was there with you. Look again.
  lookForRoom();
}

function unlockAudio() {
  // Outside a call the context stays suspended on purpose (see idleAudio).
  if (!state.inRoom && !state.testing) return;
  state.ctx?.resume().catch(() => {});
  for (const peer of state.peers.values()) peer.audio.play().catch(() => {});
}

// Keep the call controls in the system UI current as people come and go.
const peersObserver = new MutationObserver(() => { if (state.inRoom) updateCallSession(); });
peersObserver.observe($('peers'), { childList: true });

