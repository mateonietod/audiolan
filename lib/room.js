'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');
const { PROTOCOL, cleanName } = require('../public/js/protocol.js');

const MAX_SDP = 100000;
const QUEUE_LIMIT = 512;
const OPEN = 1;
const RATE_WINDOW = 10000;
const RATE_MAX = 500;

/**
 * @typedef {{ readyState: number, send(text: string): void, close(code?: number, reason?: string): void }} Socket
 * @typedef {{
 *   id: string,
 *   name: string,
 *   muted: boolean,
 *   token: string,
 *   socket: Socket | null,
 *   queue: string[],
 *   timer: NodeJS.Timeout | null,
 * }} Member
 */

/**
 * Resume tokens are compared in constant time. Byte length is what
 * timingSafeEqual checks; JavaScript string length is not the same thing
 * once a token contains a multibyte character, and a mismatch throws.
 * @param {unknown} a
 * @param {unknown} b
 */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Keep only the fields a peer needs, so the server never relays arbitrary data.
 * @param {any} data
 */
function cleanSignal(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.kind === 'description') {
    const d = data.description;
    if (!d || (d.type !== 'offer' && d.type !== 'answer')) return null;
    if (typeof d.sdp !== 'string' || d.sdp.length > MAX_SDP) return null;
    return { kind: 'description', description: { type: d.type, sdp: d.sdp } };
  }
  if (data.kind === 'candidate') {
    const c = data.candidate;
    if (c === null) return { kind: 'candidate', candidate: null };
    if (!c || typeof c.candidate !== 'string' || c.candidate.length > 2048) return null;
    return {
      kind: 'candidate',
      candidate: {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
        usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null,
      },
    };
  }
  if (data.kind === 'reset' || data.kind === 'retry') return { kind: data.kind };
  return null;
}

/**
 * The signaling state of one room. Media never passes through here.
 *
 * A member whose socket drops without saying goodbye is kept for `graceMs`.
 * Messages for it are queued, and a reconnect with the same id and token picks
 * up where it left off, so peers never notice a short signaling outage.
 */
class Room {
  /**
   * @param {{ maxPeers?: number, graceMs?: number, log?: (event: { kind: string, id?: string, name?: string, occupancy?: number }) => void }} [options]
   */
  constructor({ maxPeers = 16, graceMs = 12000, log = () => {} } = {}) {
    this.maxPeers = maxPeers;
    this.graceMs = graceMs;
    this.log = log;
    /** @type {WeakMap<Socket, { start: number, count: number }>} */
    this.rates = new WeakMap();
    /** @type {Map<string, Member>} */
    this.members = new Map();
    /** @type {Map<Socket, Member>} */
    this.bySocket = new Map();
  }

  get size() {
    return this.members.size;
  }

  /**
   * Who is on the call, for the join screen: the head count and the first
   * few names in the order they joined. Only `limit` names leave the server.
   * @param {number} [limit]
   */
  summary(limit = 2) {
    const names = [];
    for (const member of this.members.values()) {
      if (names.length >= limit) break;
      names.push(member.name);
    }
    return { count: this.members.size, names };
  }

  /**
   * @param {Socket} socket
   * @param {string} raw
   */
  handle(socket, raw) {
    if (!this.allow(socket)) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'join') return this.join(socket, message);
    if (message.type === 'signal') return this.signal(socket, message);
    if (message.type === 'presence') return this.presence(socket, message);
    if (message.type === 'ping') this.write(socket, JSON.stringify({ type: 'pong' }));
    else if (message.type === 'leave') return this.leave(socket);
  }

  /**
   * One socket may relay a burst of ICE, and nothing more. Past the budget
   * the socket is closed. The next window starts on the next message.
   * @param {Socket} socket
   */
  allow(socket) {
    const now = Date.now();
    let bucket = this.rates.get(socket);
    if (!bucket || now - bucket.start >= RATE_WINDOW) {
      bucket = { start: now, count: 0 };
      this.rates.set(socket, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= RATE_MAX) return true;
    if (bucket.count === RATE_MAX + 1) {
      this.send(socket, {
        type: 'error',
        code: 'rate',
        message: 'Too many messages. Reconnect in a moment.',
      });
      try { socket.close(1008, 'rate'); } catch { /* already closing */ }
    }
    return false;
  }

  /**
   * @param {'join' | 'resume' | 'leave'} kind
   * @param {Member} member
   */
  report(kind, member) {
    this.log({ kind, id: member.id, name: member.name, occupancy: this.members.size });
  }

  /**
   * @param {Socket} socket
   * @param {number} code
   */
  closed(socket, code) {
    const member = this.bySocket.get(socket);
    if (!member) return;
    this.bySocket.delete(socket);
    if (member.socket !== socket) return;
    member.socket = null;
    // 1000 and 1001 are a page closing on purpose. Anything else may come back.
    if (code === 1000 || code === 1001) return this.remove(member);
    member.timer = setTimeout(() => this.remove(member), this.graceMs);
    member.timer.unref?.();
  }

  /**
   * Hand every member to another room host. They reconnect and get bridged.
   * @param {number} code
   */
  evacuate(code) {
    const sockets = [...this.bySocket.keys()];
    for (const member of this.members.values()) {
      if (member.timer) clearTimeout(member.timer);
    }
    this.members.clear();
    this.bySocket.clear();
    for (const socket of sockets) {
      try { socket.close(code, 'room moved'); } catch { /* already closed */ }
    }
  }

  /**
   * @param {Socket} socket
   * @param {any} message
   */
  join(socket, message) {
    if (this.bySocket.has(socket)) return;
    if (message.v !== PROTOCOL) {
      this.send(socket, {
        type: 'error',
        code: 'version',
        message: 'Another computer runs a different version of audiolan. Update it on every computer.',
      });
      socket.close(4400, 'version');
      return;
    }
    const resume = message.resume;
    const prior = resume && typeof resume.id === 'string' ? this.members.get(resume.id) : undefined;
    if (prior && sameToken(prior.token, resume.token)) {
      this.resume(socket, prior);
      return;
    }
    if (this.members.size >= this.maxPeers) return this.refuseFull(socket);
    const member = this.track(newMember(socket, message.name));
    this.send(socket, this.welcome(member, false));
    this.broadcast({ type: 'peer-joined', peer: publicPeer(member) }, member);
    this.report('join', member);
  }

  /**
   * @param {Socket} socket
   * @param {Member} member
   */
  resume(socket, member) {
    if (member.socket && member.socket !== socket) {
      const old = member.socket;
      this.bySocket.delete(old);
      try { old.close(4000, 'replaced'); } catch { /* already closed */ }
    }
    if (member.timer) clearTimeout(member.timer);
    member.timer = null;
    member.socket = socket;
    this.bySocket.set(socket, member);
    this.send(socket, this.welcome(member, true));
    for (const text of member.queue.splice(0)) this.write(socket, text);
    this.report('resume', member);
  }

  /**
   * @param {Member} member
   * @param {boolean} resumed
   */
  welcome(member, resumed) {
    const peers = [...this.members.values()].filter((other) => other !== member).map(publicPeer);
    return { type: 'welcome', v: PROTOCOL, id: member.id, token: member.token, resumed, peers };
  }

  /**
   * @param {Socket} socket
   * @param {any} message
   */
  signal(socket, message) {
    const sender = this.bySocket.get(socket);
    if (!sender || typeof message.to !== 'string') return;
    const data = cleanSignal(message.data);
    if (!data) return;
    const relayed = signalFrom(sender, data);
    const target = this.members.get(message.to);
    if (target && target !== sender) {
      this.deliver(target, relayed);
      return;
    }
    this.send(socket, { type: 'peer-left', id: message.to });
  }

  /**
   * @param {Socket} socket
   * @param {any} message
   */
  presence(socket, message) {
    const sender = this.bySocket.get(socket);
    if (!sender || typeof message.muted !== 'boolean') return;
    sender.muted = message.muted;
    this.broadcast({ type: 'presence', from: sender.id, muted: sender.muted }, sender);
  }

  /** @param {Socket} socket */
  leave(socket) {
    const member = this.bySocket.get(socket);
    if (!member) return;
    this.bySocket.delete(socket);
    member.socket = null;
    this.remove(member);
  }

  /** @param {Member} member */
  remove(member) {
    if (this.members.get(member.id) !== member) return;
    if (member.timer) clearTimeout(member.timer);
    member.timer = null;
    if (member.socket) this.bySocket.delete(member.socket);
    member.socket = null;
    member.queue.length = 0;
    this.members.delete(member.id);
    this.broadcast({ type: 'peer-left', id: member.id });
    this.report('leave', member);
  }

  /** Register a member and its socket. @param {Member} member */
  track(member) {
    this.members.set(member.id, member);
    this.bySocket.set(member.socket, member);
    return member;
  }

  /** @param {Socket} socket */
  refuseFull(socket) {
    this.send(socket, { type: 'error', code: 'full', message: 'This line is full.' });
    socket.close(1013, 'full');
  }

  /**
   * @param {object} message
   * @param {Member} [except]
   */
  broadcast(message, except) {
    const text = JSON.stringify(message);
    for (const member of [...this.members.values()]) {
      if (member !== except) this.deliver(member, text);
    }
  }

  /**
   * Send now, or queue while the member is reconnecting.
   * @param {Member} member
   * @param {object | string} message
   */
  deliver(member, message) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (member.socket && member.socket.readyState === OPEN) {
      this.write(member.socket, text);
      return;
    }
    member.queue.push(text);
    // Too far behind to catch up. Treat it as gone; it rejoins fresh.
    if (member.queue.length > QUEUE_LIMIT) this.remove(member);
  }

  /**
   * @param {Socket} socket
   * @param {object} message
   */
  send(socket, message) {
    this.write(socket, JSON.stringify(message));
  }

  /**
   * @param {Socket} socket
   * @param {string} text
   */
  write(socket, text) {
    if (socket.readyState === OPEN) socket.send(text);
  }
}

/**
 * A new member on `socket`, with a fresh id and resume token.
 * @param {Socket} socket
 * @param {unknown} name
 * @returns {Member}
 */
function newMember(socket, name) {
  return {
    id: randomBytes(6).toString('hex'),
    name: cleanName(name),
    muted: false,
    token: randomBytes(18).toString('base64url'),
    socket,
    queue: [],
    timer: null,
  };
}

/**
 * A signal as the target receives it. Candidates are most of the traffic and
 * always follow a description from the same sender, so only descriptions,
 * resets and retries carry the name a page needs for someone it has not met.
 * @param {{ id: string, name: unknown }} sender
 * @param {{ kind: string }} data
 */
function signalFrom(sender, data) {
  if (data.kind === 'candidate') return { type: 'signal', from: sender.id, data };
  return { type: 'signal', from: sender.id, name: cleanName(sender.name), data };
}

/** @param {Member} member */
function publicPeer(member) {
  return { id: member.id, name: member.name, muted: member.muted };
}

module.exports = { Room, cleanName, cleanSignal, sameToken, PROTOCOL };
