// One RTCPeerConnection per person.
//
// The side with the smaller id leads: it attaches its mic as soon as the
// connection exists, which makes it send the first offer. The other side
// attaches its mic to the offered transceiver when the offer arrives, then
// answers. So the first offers never cross. (When they did, Chrome sometimes
// stopped gathering candidates after rolling back, and the link never came up.)
//
// Later renegotiations, such as ICE restarts, use the "perfect negotiation"
// pattern: either side may offer, and when offers cross the follower yields.
//
// Recovery is driven by the leader too, so two peers never restart the same
// link at once.

import { sinkAudio, tapStream, untap } from './media.js';
import { sendSignal } from './signaling.js';
import { DEBUG, dbg, state } from './state.js';
import { preferFrameLength, worthSending } from './util.js';
import { renderPeers } from './view.js';

/** @typedef {import('./state.js').Peer} Peer */

const LINK_TIMEOUT = 6000;
const MAX_BACKOFF = 30000;
// Bandwidth is free on a LAN, and a higher ceiling costs no delay.
const MAX_BITRATE = 48000;
// Opus frame length we ask peers to send. Shorter frames mean less waiting
// before a packet leaves; see preferFrameLength.
const FRAME_MS = 10;

function localTrack() {
  return state.localStream?.getAudioTracks()[0] || null;
}

/** @param {Peer} peer */
function leads(peer) {
  return !!state.id && state.id < peer.id;
}

/**
 * Someone is on the line. `fresh` means they just (re)joined from scratch, so
 * any connection we still hold for that id is dead on their side.
 * @param {{ id: string, name?: string, muted?: boolean }} info
 */
export function learnPeer(info, { fresh = false } = {}) {
  if (!info?.id || info.id === state.id) return;
  if (fresh && state.peers.has(info.id)) forgetPeer(info.id);
  const peer = ensurePeer(info.id, info.name);
  if (typeof info.muted === 'boolean') peer.muted = info.muted;
  renderPeers();
}

/**
 * After resuming a session: drop people who left meanwhile, add new ones,
 * and keep every connection that still works.
 * @param {{ id: string, name?: string, muted?: boolean }[]} list
 */
export function reconcile(list) {
  const ids = new Set(list.map((info) => info.id));
  for (const id of [...state.peers.keys()]) {
    if (!ids.has(id)) forgetPeer(id);
  }
  for (const info of list) learnPeer(info);
  for (const peer of state.peers.values()) {
    if (peer.status !== 'live') armWatch(peer, 1000);
  }
}

/** @param {string} id */
export function forgetPeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  teardownPeer(peer);
  state.peers.delete(id);
  renderPeers();
}

export function dropPeers() {
  for (const peer of state.peers.values()) teardownPeer(peer);
  state.peers.clear();
  renderPeers();
}

/**
 * @param {string} id
 * @param {string} [name]
 * @returns {Peer}
 */
function ensurePeer(id, name) {
  const existing = state.peers.get(id);
  if (existing) {
    if (name) existing.name = name;
    return existing;
  }
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  document.getElementById('sink')?.append(audio);
  sinkAudio(audio);
  /** @type {Peer} */
  const peer = {
    id,
    name: name || 'Guest',
    pc: /** @type {any} */ (null),
    audio,
    tap: null,
    makingOffer: false,
    ignoreOffer: false,
    chain: Promise.resolve(),
    smooth: 0,
    speaking: false,
    muted: false,
    status: 'linking',
    retries: 0,
    wasLive: false,
    watch: 0,
    node: null,
    stats: '',
    statsPrev: null,
  };
  state.peers.set(id, peer);
  connect(peer);
  return peer;
}

/** @param {Peer} peer */
function connect(peer) {
  peer.pc = createPeerConnection(peer);
  peer.makingOffer = false;
  peer.ignoreOffer = false;
  peer.chain = Promise.resolve();
  peer.status = 'linking';
  peer.wasLive = false;
  armWatch(peer, LINK_TIMEOUT);
}

/** @param {Peer} peer */
function closePc(peer) {
  const pc = peer.pc;
  if (pc) {
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch { /* already closed */ }
    const pcs = /** @type {any} */ (window).__audiolanPcs;
    if (pcs) pcs.splice(pcs.indexOf(pc) >>> 0, 1);
  }
  untap(peer.tap);
  peer.tap = null;
  peer.audio.srcObject = null;
}

/** @param {Peer} peer */
function teardownPeer(peer) {
  window.clearTimeout(peer.watch);
  closePc(peer);
  peer.audio.pause();
  peer.audio.remove();
}

/** @param {Peer} peer */
function createPeerConnection(peer) {
  // Everyone is on one network, so host candidates are enough. No STUN
  // server is asked, and nothing about the call leaves the network.
  const pc = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
  pc.onnegotiationneeded = () => negotiate(peer, pc);
  pc.onicecandidate = ({ candidate }) => {
    if (peer.pc !== pc) return;
    const send = worthSending(candidate);
    dbg({ event: 'cand-out', id: peer.id, end: !candidate, sent: send });
    if (send && candidate) sendSignal(peer.id, { kind: 'candidate', candidate: candidate.toJSON() });
  };
  pc.ontrack = (event) => onTrack(peer, pc, event);
  pc.onconnectionstatechange = () => noteLink(peer, pc);
  pc.oniceconnectionstatechange = () => noteLink(peer, pc);
  if (leads(peer)) attachMic(pc);
  if (DEBUG) {
    const w = /** @type {any} */ (window);
    (w.__audiolanPcs = w.__audiolanPcs || []).push(pc);
  }
  return pc;
}

/**
 * Send the mic on this connection, reusing an offered transceiver if there is
 * one. Returns false when there is nothing to attach.
 * @param {RTCPeerConnection} pc
 */
function attachMic(pc) {
  const track = localTrack();
  if (!track || !state.localStream) return false;
  if (pc.getSenders().some((sender) => sender.track === track)) return true;
  // addTrack reuses a transceiver the remote offer created, when one is free.
  pc.addTrack(track, state.localStream);
  return true;
}

/**
 * The description as it goes to the other side: ours, asking for short frames.
 * @param {RTCSessionDescription} description
 */
function outgoing(description) {
  const { type, sdp } = description.toJSON();
  return { type, sdp: preferFrameLength(sdp || '', FRAME_MS) };
}

/**
 * @param {Peer} peer
 * @param {RTCPeerConnection} pc
 */
async function negotiate(peer, pc) {
  if (peer.pc !== pc) return;
  try {
    peer.makingOffer = true;
    await pc.setLocalDescription();
    if (peer.pc !== pc || !pc.localDescription) return;
    sendSignal(peer.id, { kind: 'description', description: outgoing(pc.localDescription) });
    dbg({ event: 'offer', id: peer.id, ...mediaShape(pc) });
  } catch (error) {
    console.warn('offer failed', error);
  } finally {
    peer.makingOffer = false;
  }
}

/**
 * @param {Peer} peer
 * @param {RTCPeerConnection} pc
 * @param {RTCTrackEvent} event
 */
function onTrack(peer, pc, event) {
  if (peer.pc !== pc) return;
  const stream = event.streams?.find((item) => item.getAudioTracks().length > 0)
    || new MediaStream([event.track]);
  dbg({ event: 'track', id: peer.id, muted: event.track.muted, ready: event.track.readyState });
  peer.audio.srcObject = stream;
  sinkAudio(peer.audio);
  peer.audio.play().catch(() => {});
  untap(peer.tap);
  try {
    peer.tap = tapStream(stream);
  } catch {
    try { peer.tap = tapStream(new MediaStream([event.track])); } catch { peer.tap = null; }
  }
}

/**
 * Handle a signal from someone. Signals for one peer run strictly in order.
 * @param {{ from: string, name?: string, data: any }} message
 */
export function onSignal(message) {
  const data = message.data || {};
  if (data.kind === 'reset') {
    // The other side rebuilt its connection. Rebuild ours to match.
    const peer = state.peers.get(message.from);
    if (peer) rebuild(peer);
    else learnPeer({ id: message.from, name: message.name });
    return;
  }
  const peer = ensurePeer(message.from, message.name);
  if (data.kind === 'retry') {
    if (leads(peer)) startOver(peer);
    return;
  }
  const pc = peer.pc;
  peer.chain = peer.chain
    .then(() => applySignal(peer, pc, data))
    .catch((error) => console.warn('signal failed', error));
}

/**
 * @param {Peer} peer
 * @param {RTCPeerConnection} pc
 * @param {any} data
 */
async function applySignal(peer, pc, data) {
  if (peer.pc !== pc) return;
  if (data.kind === 'description') {
    const description = data.description;
    const polite = !leads(peer);
    const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !polite && collision;
    if (peer.ignoreOffer) return;
    // An answer to an offer we already rolled back.
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      attachMic(pc);
      await pc.setLocalDescription();
      if (peer.pc !== pc || !pc.localDescription) return;
      sendSignal(peer.id, { kind: 'description', description: outgoing(pc.localDescription) });
      dbg({ event: 'answer', id: peer.id, ...mediaShape(pc) });
    }
    tuneSender(pc);
  } else if (data.kind === 'candidate') {
    if (!data.candidate?.candidate) return;
    try {
      await pc.addIceCandidate(data.candidate);
      dbg({ event: 'cand-in', id: peer.id, ok: true });
    } catch (error) {
      dbg({ event: 'cand-in', id: peer.id, ok: false, ignored: peer.ignoreOffer });
      if (!peer.ignoreOffer) console.warn('ice failed', error);
    }
  }
}

/** @param {RTCPeerConnection} pc */
function linkState(pc) {
  const ice = pc.iceConnectionState;
  const conn = pc.connectionState;
  if (conn === 'failed' || ice === 'failed' || conn === 'closed') return 'failed';
  if (conn === 'connected' || ice === 'connected' || ice === 'completed') return 'live';
  if (conn === 'disconnected' || ice === 'disconnected') return 'unstable';
  return 'linking';
}

/**
 * @param {Peer} peer
 * @param {RTCPeerConnection} pc
 */
function noteLink(peer, pc) {
  if (peer.pc !== pc) return;
  const next = linkState(pc);
  if (next === 'live') {
    peer.retries = 0;
    peer.wasLive = true;
    window.clearTimeout(peer.watch);
    tuneSender(pc);
  } else if (next === 'failed') {
    armWatch(peer, 1000);
  } else if (next === 'unstable') {
    // ICE often recovers by itself from a short drop.
    armWatch(peer, 5000);
  }
  if (next !== peer.status) {
    peer.status = next;
    renderPeers();
  }
}

/**
 * @param {Peer} peer
 * @param {number} ms
 */
function armWatch(peer, ms) {
  window.clearTimeout(peer.watch);
  peer.watch = window.setTimeout(() => checkLink(peer), ms);
}

/** @param {Peer} peer */
function checkLink(peer) {
  if (state.peers.get(peer.id) !== peer) return;
  if (linkState(peer.pc) === 'live') {
    peer.retries = 0;
    return;
  }
  if (peer.status !== 'failed') {
    peer.status = 'failed';
    renderPeers();
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    // No way to signal right now. Look again once the socket is back.
    armWatch(peer, 2000);
    return;
  }
  if (leads(peer)) {
    peer.retries += 1;
    const pc = peer.pc;
    // An ICE restart helps a link that worked and then dropped. One that never
    // came up gets a fresh connection instead, which recovers faster.
    const canRestart = peer.retries === 1
      && peer.wasLive
      && pc.signalingState === 'stable'
      && !!pc.remoteDescription
      && pc.connectionState !== 'closed';
    if (canRestart) pc.restartIce();
    else startOver(peer);
  } else {
    // The leader may not have noticed (its side can look fine). Nudge it.
    peer.retries += 1;
    if (peer.retries >= 2) sendSignal(peer.id, { kind: 'retry' });
  }
  armWatch(peer, Math.min(MAX_BACKOFF, LINK_TIMEOUT * 2 ** Math.min(peer.retries, 3)));
}

/**
 * Throw the connection away and build a new one. Only the leading side does
 * this on its own; the other side follows when the reset arrives.
 * @param {Peer} peer
 */
function startOver(peer) {
  rebuild(peer);
  sendSignal(peer.id, { kind: 'reset' });
}

/** @param {Peer} peer */
function rebuild(peer) {
  closePc(peer);
  connect(peer);
  renderPeers();
}

/** The Retry button on a person who cannot be reached. @param {string} id */
export function retryPeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.retries = 0;
  if (leads(peer)) startOver(peer);
  else {
    sendSignal(peer.id, { kind: 'retry' });
    peer.status = 'linking';
    armWatch(peer, LINK_TIMEOUT);
    renderPeers();
  }
}

/** Send the current mic to everyone without renegotiating. */
export async function replaceOutboundTrack() {
  const track = localTrack();
  if (!track) return;
  const swaps = [];
  for (const peer of state.peers.values()) {
    const sender = peer.pc?.getSenders().find((item) => item.track?.kind === 'audio');
    if (sender && sender.track !== track) swaps.push(sender.replaceTrack(track));
    // A follower still waiting for the first offer attaches the mic then.
    else if (!sender && peer.pc && (leads(peer) || peer.pc.remoteDescription)) attachMic(peer.pc);
  }
  await Promise.all(swaps);
}

/** Voice needs little bandwidth, but it should go first. @param {RTCPeerConnection} pc */
async function tuneSender(pc) {
  try {
    const sender = pc.getSenders().find((item) => item.track?.kind === 'audio');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) return;
    const encoding = /** @type {any} */ (params.encodings[0]);
    if (encoding.maxBitrate === MAX_BITRATE && encoding.priority === 'high') return;
    encoding.maxBitrate = MAX_BITRATE;
    encoding.priority = 'high';
    encoding.networkPriority = 'high';
    await sender.setParameters(params);
  } catch { /* the browser kept its own encoder settings */ }
}

/** @param {RTCPeerConnection} pc */
function mediaShape(pc) {
  const sdp = pc.localDescription?.sdp || '';
  return {
    transceivers: pc.getTransceivers().length,
    direction: pc.getTransceivers().map((item) => item.currentDirection || item.direction).join(',') || 'none',
    sdp: (sdp.match(/a=(sendrecv|sendonly|recvonly|inactive)/g) || []).join(',') || 'none',
  };
}
