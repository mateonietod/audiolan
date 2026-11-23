'use strict';

const https = require('https');
const { WebSocket } = require('ws');
const { cleanName } = require('../public/js/protocol.js');
const { isFingerprint } = require('./certs');

const HOP_HEADER = 'x-audiolan-hop';
const QUEUE_LIMIT = 256;

/**
 * The fingerprint the peer presented, or '' when there is none.
 * @param {import('http').IncomingMessage} response
 */
function presentedFingerprint(response) {
  const socket = /** @type {import('tls').TLSSocket} */ (response.socket);
  return String(socket.getPeerCertificate?.()?.fingerprint256 || '').replace(/:/g, '').toLowerCase();
}

/** @param {number} code */
function sendable(code) {
  return code === 1000 || code === 1001 || (code >= 3000 && code <= 4999);
}

/**
 * Relay a browser's signaling socket to the server that hosts the room.
 *
 * Close codes pass through, so the room host can tell a page that left (1000,
 * 1001) from one that lost its connection and may come back.
 *
 * If the room host cannot be reached at all (refused, timed out, wrong
 * certificate), the browser is handed back through `fallback` along with
 * anything it already sent, so this server can keep it in its own room
 * instead of failing the join.
 *
 * @param {WebSocket} browser
 * @param {{ host: string, fp: string }} upstream
 * @param {{ dial: string, fallback: (queued: string[]) => void, log?: (line: string) => void }} options
 */
function bridge(browser, upstream, { dial, fallback, log = () => {} }) {
  const remote = new WebSocket(`wss://${dial}`, {
    // The room host's certificate is self-signed. It is pinned below to the
    // fingerprint the host advertises over mDNS instead.
    rejectUnauthorized: false,
    headers: { [HOP_HEADER]: '1' },
    handshakeTimeout: 4000,
    perMessageDeflate: false,
    maxPayload: 128 * 1024,
  });
  /** @type {string[]} */
  const queue = [];
  let open = false;
  let released = false;

  /** @param {import('ws').RawData} data @param {boolean} isBinary */
  const onBrowserMessage = (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    if (open) remote.send(text);
    else if (queue.length < QUEUE_LIMIT) queue.push(text);
  };
  /** @param {number} code */
  const onBrowserClose = (code) => {
    if (remote.readyState === WebSocket.CONNECTING) remote.terminate();
    else if (remote.readyState === WebSocket.OPEN) remote.close(sendable(code) ? code : 4006, 'browser gone');
  };
  const onBrowserError = () => { /* a close event follows */ };
  browser.on('message', onBrowserMessage);
  browser.on('close', onBrowserClose);
  browser.on('error', onBrowserError);

  /** Give the browser back to this server, once, if the relay never opened. */
  const release = () => {
    if (released || open) return;
    released = true;
    browser.off('message', onBrowserMessage);
    browser.off('close', onBrowserClose);
    browser.off('error', onBrowserError);
    if (remote.readyState === WebSocket.CONNECTING || remote.readyState === WebSocket.OPEN) remote.terminate();
    if (browser.readyState === WebSocket.OPEN) fallback(queue.splice(0));
  };

  remote.on('upgrade', (response) => {
    const seen = presentedFingerprint(response);
    if (isFingerprint(upstream.fp) && seen === upstream.fp.toLowerCase()) return;
    log(`  the room host at ${upstream.host} presented a different certificate. Not joining it.`);
    release();
  });
  remote.on('open', () => {
    if (released) return;
    open = true;
    for (const text of queue.splice(0)) remote.send(text);
  });
  remote.on('message', (data, isBinary) => {
    if (!released && !isBinary && browser.readyState === WebSocket.OPEN) browser.send(data.toString());
  });
  remote.on('close', (code) => {
    if (released) return;
    if (!open) {
      release();
      return;
    }
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
      browser.close(code >= 4000 && code <= 4999 ? code : 4001, 'room host closed');
    }
  });
  remote.on('error', () => { /* a close event follows */ });
}

/**
 * Open a relay and drop it. True only when the peer's certificate matches.
 * No join is sent, so the other room does not gain a member.
 * @param {string} dial
 * @param {string} fp
 */
function probeHost(dial, fp) {
  if (!isFingerprint(fp)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const remote = new WebSocket(`wss://${dial}`, {
      rejectUnauthorized: false,
      headers: { [HOP_HEADER]: '1' },
      handshakeTimeout: 4000,
      perMessageDeflate: false,
    });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { remote.terminate(); } catch { /* already closed */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 4000);
    remote.on('upgrade', (response) => finish(presentedFingerprint(response) === fp.toLowerCase()));
    remote.on('error', () => finish(false));
    remote.on('close', () => finish(false));
  });
}

/**
 * Ask the room host who is on the call, over the same pinned connection the
 * relay uses. Null when it cannot be reached in time, or presents another
 * certificate.
 * @param {string} dial
 * @param {string} fp
 * @param {number} [ms]
 * @returns {Promise<{ count: number, names: string[] } | null>}
 */
function fetchPeople(dial, fp, ms = 1500) {
  if (!isFingerprint(fp)) return Promise.resolve(null);
  const split = dial.lastIndexOf(':');
  return new Promise((resolve) => {
    let settled = false;
    /** @param {{ count: number, names: string[] } | null} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(value);
    };
    const req = https.get({
      host: dial.slice(0, split),
      port: Number(dial.slice(split + 1)),
      path: '/rooms',
      rejectUnauthorized: false,
      headers: { [HOP_HEADER]: '1' },
      timeout: ms,
    }, (res) => {
      if (presentedFingerprint(res) !== fp.toLowerCase() || res.statusCode !== 200) {
        finish(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) finish(null);
      });
      res.on('end', () => {
        try {
          finish(cleanPeople(JSON.parse(body).people));
        } catch {
          finish(null);
        }
      });
    });
    req.on('timeout', () => finish(null));
    req.on('error', () => finish(null));
  });
}

/**
 * A people summary from another server, trimmed to what the page shows.
 * @param {any} people
 */
function cleanPeople(people) {
  if (!people || !Number.isInteger(people.count) || people.count < 0) return null;
  const names = Array.isArray(people.names) ? people.names.slice(0, 2).map(cleanName) : [];
  return { count: Math.min(people.count, 1000), names };
}

module.exports = { bridge, probeHost, fetchPeople, cleanPeople, HOP_HEADER };
