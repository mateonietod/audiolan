// The WebSocket to the local audiolan server. It only carries signaling;
// audio flows directly between browsers and survives this socket dropping.
//
// A dropped socket reconnects with the id and token from the last welcome.
// If the server still remembers this tab, it resumes the session and the
// existing peer connections carry on untouched.

import { micAlive, openMic, releaseMic } from './media.js';
import { dropPeers, forgetPeer, learnPeer, onSignal, reconcile } from './peers.js';
import { PROTOCOL, state } from './state.js';
import { enterRoom, renderPeers, setCount } from './view.js';

const JOIN_TIMEOUT = 8000;
const PING_EVERY = 10000;
const SILENCE_LIMIT = 25000;
const OUTBOX_LIMIT = 256;

/** @param {object} message */
export function send(message) {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * @param {string} to
 * @param {object} data
 */
export function sendSignal(to, data) {
  const message = { type: 'signal', to, data };
  if (send(message)) return;
  // Hold on to it. If the session resumes these still matter.
  if (state.inRoom && state.outbox.length < OUTBOX_LIMIT) state.outbox.push(message);
}

function hostUnreachable() {
  return 'Can\'t reach that host. Check the address, and that audiolan is running.';
}

function socketUrl() {
  const scheme = location.protocol === 'http:' ? 'ws' : 'wss';
  return `${scheme}://${location.host}/api/ws`;
}

/**
 * @typedef {Error & { superseded?: boolean }} SocketError
 */

/**
 * Connect and join. Resolves on the server's welcome.
 * @returns {Promise<void>}
 */
export function openSocket() {
  closeSocket(4000);
  const ws = new WebSocket(socketUrl());
  state.ws = ws;
  return new Promise((resolve, reject) => {
    let settled = false;
    let welcomed = false;
    /** @param {string} text */
    const fail = (text) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const error = /** @type {SocketError} */ (new Error(text));
      error.superseded = state.ws !== ws;
      reject(error);
    };
    const timer = window.setTimeout(() => {
      fail('The host did not answer.');
      if (state.ws === ws) closeSocket(4000);
    }, JOIN_TIMEOUT);

    ws.addEventListener('open', () => {
      if (state.ws !== ws) return;
      const resume = state.id && state.token ? { id: state.id, token: state.token } : undefined;
      /** @type {Record<string, unknown>} */
      ws.send(JSON.stringify({ type: 'join', v: PROTOCOL, name: state.name, resume }));
    });
    ws.addEventListener('message', (event) => {
      if (state.ws !== ws) return;
      state.lastHeard = Date.now();
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!welcomed && message.type === 'error') {
        fail(message.message || 'The line refused the join.');
        return;
      }
      if (!welcomed && message.type === 'welcome') {
        welcomed = true;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      }
      onServerMessage(message);
    });
    ws.addEventListener('close', () => {
      if (state.ws !== ws) return;
      state.ws = null;
      fail(hostUnreachable());
      if (welcomed && state.inRoom && !state.leaving) {
        setCount('Reconnecting');
        scheduleReconnect();
      }
    });
    ws.addEventListener('error', () => {
      if (state.ws !== ws) return;
      fail(hostUnreachable());
    });
  });
}

/** Detach from the current socket and close it. @param {number} [code] */
function closeSocket(code = 1000) {
  const ws = state.ws;
  state.ws = null;
  if (!ws) return;
  try { ws.close(code); } catch { /* already closing */ }
}

/** Tell the server this tab is leaving for good, then close. */
export function sayGoodbye() {
  send({ type: 'leave' });
  closeSocket(1000);
}

function scheduleReconnect() {
  window.clearTimeout(state.reconnectTimer);
  const base = Math.min(8000, 500 * 2 ** state.reconnects);
  const delay = base * (0.8 + Math.random() * 0.4);
  state.reconnects += 1;
  const session = state.session;
  state.reconnectTimer = window.setTimeout(() => attemptReconnect(session), delay);
}

/** @param {number} session */
async function attemptReconnect(session) {
  if (session !== state.session || state.leaving || !state.inRoom) return;
  try {
    if (!micAlive()) {
      releaseMic();
      await openMic(state.inputId);
    }
    if (session !== state.session) return;
    await openSocket();
  } catch (error) {
    if (/** @type {SocketError} */ (error).superseded) return;
    if (session === state.session && state.inRoom && !state.leaving) scheduleReconnect();
  }
}

/** Reconnect right away, e.g. when the network or the page comes back. */
export function reconnectNow() {
  if (!state.inRoom || state.leaving) return;
  const ws = state.ws;
  const healthy = ws && ws.readyState === WebSocket.OPEN && Date.now() - state.lastHeard < SILENCE_LIMIT;
  if (healthy || (ws && ws.readyState === WebSocket.CONNECTING)) return;
  window.clearTimeout(state.reconnectTimer);
  state.reconnects = 0;
  closeSocket(4000);
  setCount('Reconnecting');
  attemptReconnect(state.session);
}

/** Notice a socket that went quiet without closing, e.g. after a Wi-Fi switch. */
export function startWatchdog() {
  stopWatchdog();
  state.lastHeard = Date.now();
  state.watchdog = window.setInterval(() => {
    if (!state.inRoom) return;
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - state.lastHeard > SILENCE_LIMIT) {
      reconnectNow();
      return;
    }
    if (now - state.lastPing >= PING_EVERY) {
      state.lastPing = now;
      send({ type: 'ping' });
    }
  }, 2500);
}

export function stopWatchdog() {
  window.clearInterval(state.watchdog);
  state.watchdog = 0;
}

/** @param {any} message */
function onServerMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'welcome': {
      const resumed = !!message.resumed && message.id === state.id;
      state.id = message.id;
      state.token = message.token;
      state.reconnects = 0;
      const outbox = state.outbox.splice(0);
      if (!resumed) dropPeers();
      enterRoom();
      if (resumed) {
        reconcile(message.peers || []);
        for (const queued of outbox) send(queued);
      } else {
        for (const peer of message.peers || []) learnPeer(peer);
      }
      send({ type: 'presence', muted: state.muted });
      renderPeers();
      break;
    }
    case 'peer-joined':
      learnPeer(message.peer, { fresh: true });
      break;
    case 'peer-left':
      forgetPeer(message.id);
      break;
    case 'presence': {
      const peer = state.peers.get(message.from);
      if (!peer || typeof message.muted !== 'boolean') return;
      peer.muted = message.muted;
      renderPeers();
      break;
    }
    case 'signal':
      onSignal(message);
      break;
    case 'error':
      setCount(message.message || 'Line unavailable');
      break;
    default:
      break;
  }
}
