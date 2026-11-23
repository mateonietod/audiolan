import { applyTransmit } from './controls.js';
import { replaceOutboundTrack } from './peers.js';
import { state } from './state.js';
import { store } from './util.js';
import { reportDeviceError, clearDeviceError, renderJoinMic } from './view.js';

const SKIP_IDS = new Set(['', 'default', 'communications']);

export function getCtx() {
  if (!state.ctx) {
    const Context = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    state.ctx = /** @type {AudioContext} */ (new Context({ latencyHint: 'interactive' }));
  }
  return state.ctx;
}

/**
 * Let the audio device go when nothing is measured. A running context keeps
 * the audio thread awake, which a phone pays for in battery. The next call or
 * mic test resumes it inside its click.
 */
export function idleAudio() {
  if (state.inRoom || state.testing || !state.ctx || state.ctx.state !== 'running') return;
  state.ctx.suspend().catch(() => {});
}

/** @param {any} error */
export function micMessage(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone blocked. Allow it for this site, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone found.';
  if (name === 'NotReadableError') return 'Another app is using the microphone.';
  if (name === 'SecurityError') return 'The microphone needs the https address printed by the server.';
  return error?.message || 'Could not open the microphone.';
}

/** @param {string} deviceId */
function micAttempts(deviceId) {
  const tuned = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
  };
  const simple = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  /** @type {MediaStreamConstraints[]} */
  const attempts = [];
  if (deviceId) {
    attempts.push({ audio: { ...tuned, deviceId: { exact: deviceId } }, video: false });
    attempts.push({ audio: { ...simple, deviceId: { exact: deviceId } }, video: false });
  }
  attempts.push({ audio: tuned, video: false });
  attempts.push({ audio: simple, video: false });
  attempts.push({ audio: true, video: false });
  return attempts;
}

/** @param {string} deviceId */
async function requestMic(deviceId) {
  let last = new Error('Could not open the microphone.');
  for (const constraints of micAttempts(deviceId)) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      last = /** @type {Error} */ (error);
      const name = last?.name || '';
      // These will not change with looser constraints.
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'NotReadableError') throw error;
    }
  }
  throw last;
}

/**
 * Open (or switch) the microphone. Newer calls win over older ones that are
 * still waiting on the browser.
 * @param {string} deviceId
 */
export async function openMic(deviceId, ticket = ++state.micTicket) {
  const stream = await requestMic(deviceId || '');
  if (ticket !== state.micTicket) {
    for (const track of stream.getTracks()) track.stop();
    return state.localStream;
  }
  const previous = state.localStream;
  for (const track of stream.getAudioTracks()) {
    try { track.contentHint = 'speech'; } catch { /* optional */ }
  }
  state.localStream = stream;
  attachLocalAnalyser(stream);
  applyTransmit();
  try {
    await replaceOutboundTrack();
  } catch (error) {
    console.warn('track swap failed', error);
  }
  if (previous && previous !== stream) {
    for (const track of previous.getTracks()) track.stop();
  }
  const chosen = stream.getAudioTracks()[0]?.getSettings?.().deviceId || '';
  if (deviceId && chosen && !SKIP_IDS.has(chosen)) state.inputId = chosen;
  else if (!deviceId) state.inputId = '';
  store.set('audiolan.input', state.inputId);
  clearDeviceError();
  await refreshDevices();
  return stream;
}

export function micAlive() {
  return !!state.localStream?.getAudioTracks().some((track) => track.readyState === 'live');
}

export function releaseMic() {
  state.micTicket += 1;
  untap(state.localTap);
  state.localTap = null;
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) track.stop();
    state.localStream = null;
  }
  state.testing = false;
}

/** @param {MediaStream} stream */
function attachLocalAnalyser(stream) {
  untap(state.localTap);
  state.localTap = tapStream(stream);
}

/**
 * Feed a stream to an analyser. A near-silent gain keeps the analyser in a
 * live graph without ever playing the stream back.
 * @param {MediaStream} stream
 * @returns {import('./state.js').Tap}
 */
export function tapStream(stream) {
  const ctx = getCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  const silent = ctx.createGain();
  // Chrome optimizes a gain of exactly zero out of the graph, which freezes the meter.
  silent.gain.value = 0.00001;
  source.connect(analyser);
  analyser.connect(silent);
  silent.connect(ctx.destination);
  return { source, analyser, silent };
}

/** @param {import('./state.js').Tap | null} tap */
export function untap(tap) {
  if (!tap) return;
  for (const node of [tap.source, tap.analyser, tap.silent]) {
    try { node.disconnect(); } catch { /* already torn down */ }
  }
}

/** True once the browser has granted the mic, which is when device labels appear. */
export function micGranted() {
  return state.devices.some((device) => device.kind === 'audioinput' && device.label);
}

export async function refreshDevices() {
  if (navigator.mediaDevices?.enumerateDevices) {
    try {
      state.devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      state.devices = [];
    }
  }
  renderDeviceMenus();
  renderJoinMic();
}

function canChooseOutput() {
  return typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function';
}

function renderDeviceMenus() {
  paintDeviceMenu('input', 'audioinput', state.inputId);
  paintDeviceMenu('output', 'audiooutput', state.outputId);
  const canSink = canChooseOutput();
  for (const select of document.querySelectorAll('[data-device="output"]')) {
    const field = /** @type {HTMLElement | null} */ (select.closest('.device'));
    if (field) field.hidden = !canSink;
  }
}

/**
 * @param {string} slot
 * @param {MediaDeviceKind} kind
 * @param {string} selected
 */
function paintDeviceMenu(slot, kind, selected) {
  const devices = state.devices.filter((device) => device.kind === kind && !SKIP_IDS.has(device.deviceId));
  const noun = kind === 'audioinput' ? 'Microphone' : 'Speaker';
  const options = [{ value: '', label: 'System default' }].concat(devices.map((device, index) => ({
    value: device.deviceId,
    label: device.label || `${noun} ${index + 1}`,
  })));
  // Rebuilding the list closes a dropdown that is open, so only do it when
  // the devices actually changed.
  const signature = options.map((option) => `${option.value}\u0000${option.label}`).join('\u0001');
  const want = options.some((option) => option.value === selected) ? selected : '';
  for (const element of document.querySelectorAll(`[data-device="${slot}"]`)) {
    const select = /** @type {HTMLSelectElement} */ (element);
    if (select.dataset.signature !== signature) {
      const next = document.createDocumentFragment();
      for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        next.append(node);
      }
      select.replaceChildren(next);
      select.dataset.signature = signature;
    }
    if (select.value !== want) select.value = want;
  }
}

/** @param {string} id */
async function chooseInput(id) {
  if (id === state.inputId) return;
  const previous = state.inputId;
  state.inputId = id;
  store.set('audiolan.input', id);
  renderDeviceMenus();
  if (!state.localStream) return;
  const ticket = ++state.micTicket;
  try {
    await openMic(id, ticket);
  } catch (error) {
    if (ticket !== state.micTicket) return;
    state.inputId = previous;
    store.set('audiolan.input', previous);
    renderDeviceMenus();
    reportDeviceError(micMessage(error));
  }
}

/** @param {string} id */
async function chooseOutput(id) {
  state.outputId = id;
  store.set('audiolan.output', id);
  renderDeviceMenus();
  try {
    await applyOutput();
    clearDeviceError();
  } catch {
    reportDeviceError('That speaker is unavailable.');
  }
}

async function applyOutput() {
  if (!canChooseOutput()) return;
  const id = state.outputId || '';
  const elements = /** @type {HTMLAudioElement[]} */ ([...document.querySelectorAll('#sink audio')]);
  await Promise.all(elements.map(async (audio) => {
    if (audio.sinkId !== id) await audio.setSinkId(id);
  }));
}

/** @param {HTMLAudioElement} audio */
export function sinkAudio(audio) {
  if (!state.outputId || typeof audio.setSinkId !== 'function') return;
  audio.setSinkId(state.outputId).catch(() => {});
}

export function bindDevices() {
  for (const element of document.querySelectorAll('[data-device]')) {
    const select = /** @type {HTMLSelectElement} */ (element);
    select.addEventListener('change', () => {
      if (select.dataset.device === 'input') chooseInput(select.value);
      else chooseOutput(select.value);
    });
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { refreshDevices(); });
  renderDeviceMenus();
}
