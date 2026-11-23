// Link numbers for #debug: round trip, receive buffer, loss, send rate and
// the path in use. They show under each person, and the latest set is on
// window.__audiolanStats, so "near-zero latency" is measured, not assumed.
// At home the path should read host/udp and the send rate about 100/s
// (10 ms frames).

import { DEBUG, state } from './state.js';
import { renderPeers } from './view.js';

const EVERY = 2000;

/**
 * @typedef {{ at: number, delay: number, emitted: number, lost: number, received: number, sent: number, rtt: number | null }} StatsSample
 * @typedef {{
 *   rttMs: number | null,
 *   bufferMs: number | null,
 *   lossPct: number | null,
 *   sentPerSecond: number | null,
 *   path: string | null,
 * }} LinkStats
 */

let timer = 0;

export function startStats() {
  if (!DEBUG || timer) return;
  timer = window.setInterval(() => { sample(); }, EVERY);
}

export function stopStats() {
  window.clearInterval(timer);
  timer = 0;
}

async function sample() {
  if (!state.inRoom) return;
  /** @type {Record<string, LinkStats>} */
  const all = {};
  await Promise.all([...state.peers.values()].map(async (peer) => {
    if (!peer.pc || peer.status !== 'live') {
      peer.stats = '';
      peer.statsPrev = null;
      return;
    }
    try {
      const report = await peer.pc.getStats();
      const next = readSample(report);
      const link = { ...measure(peer.statsPrev, next), path: pathOf(report) };
      peer.statsPrev = next;
      peer.stats = describe(link);
      all[`${peer.name} (${peer.id})`] = link;
    } catch {
      peer.stats = '';
    }
  }));
  /** @type {any} */ (window).__audiolanStats = all;
  renderPeers();
}

/** @param {RTCStatsReport} report */
function selectedPair(report) {
  /** @type {any} */
  let pair = null;
  let selectedId = '';
  report.forEach((/** @type {any} */ item) => {
    if (item.type === 'transport' && item.selectedCandidatePairId) selectedId = item.selectedCandidatePairId;
  });
  report.forEach((/** @type {any} */ item) => {
    if (item.type !== 'candidate-pair') return;
    const chosen = selectedId ? item.id === selectedId : (item.selected || (item.nominated && item.state === 'succeeded'));
    if (chosen) pair = item;
  });
  return pair;
}

/** @param {RTCStatsReport} report */
function pathOf(report) {
  const pair = selectedPair(report);
  const local = pair && /** @type {any} */ (report.get(pair.localCandidateId));
  return local ? `${local.candidateType}/${local.protocol}` : null;
}

/**
 * @param {RTCStatsReport} report
 * @returns {StatsSample}
 */
function readSample(report) {
  /** @type {any} */
  let inbound = null;
  /** @type {any} */
  let outbound = null;
  report.forEach((/** @type {any} */ item) => {
    if (item.kind !== 'audio') return;
    if (item.type === 'inbound-rtp') inbound = item;
    if (item.type === 'outbound-rtp') outbound = item;
  });
  const pair = selectedPair(report);
  return {
    at: Date.now(),
    delay: inbound?.jitterBufferDelay || 0,
    emitted: inbound?.jitterBufferEmittedCount || 0,
    lost: inbound?.packetsLost || 0,
    received: inbound?.packetsReceived || 0,
    sent: outbound?.packetsSent || 0,
    // Not a counter, so it is read as is.
    rtt: typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null,
  };
}

/**
 * Rates over the last interval, not since the call started, so a bad
 * minute does not hide in an hour of good ones.
 * @param {StatsSample | null} prev
 * @param {StatsSample} next
 * @returns {Omit<LinkStats, 'path'>}
 */
function measure(prev, next) {
  const rttMs = next.rtt === null ? null : Math.round(next.rtt * 1000);
  if (!prev) return { rttMs, bufferMs: null, lossPct: null, sentPerSecond: null };
  const emitted = next.emitted - prev.emitted;
  const lost = next.lost - prev.lost;
  const received = next.received - prev.received;
  const seconds = (next.at - prev.at) / 1000;
  return {
    rttMs,
    bufferMs: emitted > 0 ? Math.round(((next.delay - prev.delay) / emitted) * 1000) : null,
    lossPct: lost + received > 0 ? Math.round((Math.max(0, lost) / (lost + received)) * 1000) / 10 : null,
    sentPerSecond: seconds > 0 ? Math.round((next.sent - prev.sent) / seconds) : null,
  };
}

/** @param {LinkStats} link */
function describe(link) {
  const parts = [];
  if (link.rttMs !== null) parts.push(`${link.rttMs} ms rtt`);
  if (link.bufferMs !== null) parts.push(`${link.bufferMs} ms buffer`);
  if (link.lossPct) parts.push(`${link.lossPct}% loss`);
  if (link.sentPerSecond !== null) parts.push(`${link.sentPerSecond}/s`);
  if (link.path) parts.push(link.path);
  return parts.join(' · ');
}
