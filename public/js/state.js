import { readHash, store } from './util.js';

export { PROTOCOL } from './protocol.js';

const hash = readHash(location.hash);
export const DEBUG = hash.has('debug');

/**
 * @typedef {{
 *   source: MediaStreamAudioSourceNode,
 *   analyser: AnalyserNode,
 *   silent: GainNode,
 * }} Tap
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   pc: RTCPeerConnection,
 *   audio: HTMLAudioElement,
 *   tap: Tap | null,
 *   makingOffer: boolean,
 *   ignoreOffer: boolean,
 *   chain: Promise<void>,
 *   smooth: number,
 *   speaking: boolean,
 *   muted: boolean,
 *   status: 'linking' | 'live' | 'unstable' | 'failed',
 *   retries: number,
 *   wasLive: boolean,
 *   watch: number,
 *   node: HTMLElement | null,
 *   stats: string,
 *   statsPrev: import('./stats.js').StatsSample | null,
 * }} Peer
 */

export const state = {
  name: '',
  /** Server-assigned id and the token that lets this tab reclaim it. */
  id: /** @type {string | null} */ (null),
  token: /** @type {string | null} */ (null),
  ws: /** @type {WebSocket | null} */ (null),
  /** Bumped on every join and leave. Async work from an older session stops. */
  session: 0,
  leaving: false,
  joining: false,
  inRoom: false,
  reconnects: 0,
  reconnectTimer: 0,
  lastHeard: 0,
  lastPing: 0,
  watchdog: 0,
  /** Signals produced while the socket is down, sent if the session resumes. */
  outbox: /** @type {object[]} */ ([]),
  mode: store.get('audiolan.mode') === 'ptt' ? 'ptt' : 'open',
  pttKey: store.get('audiolan.ptt') || 'Space',
  pttHeld: false,
  pointerHeld: false,
  binding: false,
  cancelBind: /** @type {(() => void) | null} */ (null),
  muted: false,
  testing: false,
  inputId: store.get('audiolan.input') || '',
  outputId: store.get('audiolan.output') || '',
  devices: /** @type {MediaDeviceInfo[]} */ ([]),
  micTicket: 0,
  localStream: /** @type {MediaStream | null} */ (null),
  ctx: /** @type {AudioContext | null} */ (null),
  localTap: /** @type {Tap | null} */ (null),
  localNode: /** @type {HTMLElement | null} */ (null),
  peers: /** @type {Map<string, Peer>} */ (new Map()),
  roomRole: /** @type {'host' | 'join' | null} */ (null),
  level: 0,
  speaking: false,
};

/** @param {Record<string, unknown>} info */
export function dbg(info) {
  if (!DEBUG) return;
  console.debug('[audiolan]', info);
  const w = /** @type {any} */ (window);
  (w.__audiolanLog = w.__audiolanLog || []).push(info);
}

if (DEBUG) /** @type {any} */ (window).__audiolan = state;
