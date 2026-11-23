'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const { Room, cleanName, cleanSignal, PROTOCOL } = require('../lib/room');

class FakeSocket {
  constructor() {
    this.readyState = 1;
    /** @type {any[]} */
    this.sent = [];
    /** @type {number | null} */
    this.closedWith = null;
  }

  /** @param {string} text */
  send(text) {
    this.sent.push(JSON.parse(text));
  }

  /** @param {number} [code] */
  close(code) {
    this.readyState = 3;
    this.closedWith = code ?? null;
  }

  /** @param {string} type */
  last(type) {
    return [...this.sent].reverse().find((message) => message.type === type);
  }

  /** @param {string} type */
  all(type) {
    return this.sent.filter((message) => message.type === type);
  }
}

/** @param {Room} room @param {string} name @param {object} [extra] */
function join(room, name, extra = {}) {
  const socket = new FakeSocket();
  room.handle(socket, JSON.stringify({ type: 'join', v: PROTOCOL, name, ...extra }));
  return { socket, welcome: socket.last('welcome') };
}

describe('Room', () => {
  /** @type {Room} */
  let room;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    room = new Room({ graceMs: 1000 });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('welcomes a new member with everyone already there', () => {
    const a = join(room, 'Kitchen');
    const b = join(room, 'Office');
    assert.equal(a.welcome.resumed, false);
    assert.deepEqual(b.welcome.peers, [{ id: a.welcome.id, name: 'Kitchen', muted: false }]);
    assert.deepEqual(a.socket.last('peer-joined').peer, { id: b.welcome.id, name: 'Office', muted: false });
    assert.ok(b.welcome.token.length > 16);
  });

  it('refuses another protocol version with a readable message', () => {
    const socket = new FakeSocket();
    room.handle(socket, JSON.stringify({ type: 'join', name: 'Old' }));
    assert.equal(socket.last('error').code, 'version');
    assert.equal(socket.closedWith, 4400);
    assert.equal(room.size, 0);
  });

  it('turns people away once the line is full', () => {
    const small = new Room({ maxPeers: 1 });
    join(small, 'One');
    const two = join(small, 'Two');
    assert.equal(two.socket.last('error').code, 'full');
    assert.equal(two.socket.closedWith, 1013);
  });

  it('relays only clean signals, with the sender filled in', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.handle(a.socket, JSON.stringify({
      type: 'signal',
      to: b.welcome.id,
      data: { kind: 'description', description: { type: 'offer', sdp: 'v=0', extra: 1 }, junk: true },
    }));
    const signal = b.socket.last('signal');
    assert.equal(signal.from, a.welcome.id);
    assert.equal(signal.name, 'A');
    assert.deepEqual(signal.data, { kind: 'description', description: { type: 'offer', sdp: 'v=0' } });
  });

  it('names the sender on descriptions but not on candidates', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.handle(a.socket, JSON.stringify({
      type: 'signal',
      to: b.welcome.id,
      data: { kind: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
    }));
    const candidate = b.socket.last('signal');
    assert.equal(candidate.from, a.welcome.id);
    assert.equal('name' in candidate, false);
    room.handle(a.socket, JSON.stringify({ type: 'signal', to: b.welcome.id, data: { kind: 'reset' } }));
    assert.equal(b.socket.last('signal').name, 'A');
  });

  it('tells the sender when the target is gone', () => {
    const a = join(room, 'A');
    room.handle(a.socket, JSON.stringify({ type: 'signal', to: 'nobody', data: { kind: 'reset' } }));
    assert.equal(a.socket.last('peer-left').id, 'nobody');
  });

  it('removes a member at once when the page closes on purpose', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.closed(b.socket, 1001);
    assert.equal(a.socket.last('peer-left').id, b.welcome.id);
    assert.equal(room.size, 1);
  });

  it('removes a member at once on an explicit leave', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.handle(b.socket, JSON.stringify({ type: 'leave' }));
    assert.equal(a.socket.last('peer-left').id, b.welcome.id);
    room.closed(b.socket, 1006);
    assert.equal(a.socket.all('peer-left').length, 1);
  });

  it('keeps a dropped member through the grace period and resumes it', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.closed(b.socket, 1006);
    assert.equal(a.socket.last('peer-left'), undefined);

    // Signals and presence sent while B is away are queued for it.
    room.handle(a.socket, JSON.stringify({ type: 'signal', to: b.welcome.id, data: { kind: 'candidate', candidate: null } }));
    room.handle(a.socket, JSON.stringify({ type: 'presence', muted: true }));

    mock.timers.tick(900);
    const back = join(room, 'B', { resume: { id: b.welcome.id, token: b.welcome.token } });
    assert.equal(back.welcome.resumed, true);
    assert.equal(back.welcome.id, b.welcome.id);
    const types = back.socket.sent.map((message) => message.type);
    assert.deepEqual(types, ['welcome', 'signal', 'presence']);

    mock.timers.tick(5000);
    assert.equal(a.socket.last('peer-left'), undefined, 'grace timer was cancelled');
    assert.equal(a.socket.all('peer-joined').length, 1, 'no second peer-joined for a resume');
  });

  it('lets a member go once the grace period runs out', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.closed(b.socket, 1006);
    mock.timers.tick(1001);
    assert.equal(a.socket.last('peer-left').id, b.welcome.id);
    const late = join(room, 'B', { resume: { id: b.welcome.id, token: b.welcome.token } });
    assert.equal(late.welcome.resumed, false);
    assert.notEqual(late.welcome.id, b.welcome.id);
  });

  it('does not resume with a wrong token', () => {
    join(room, 'A');
    const b = join(room, 'B');
    room.closed(b.socket, 1006);
    const thief = join(room, 'C', { resume: { id: b.welcome.id, token: 'x'.repeat(b.welcome.token.length) } });
    assert.equal(thief.welcome.resumed, false);
    assert.notEqual(thief.welcome.id, b.welcome.id);
  });

  it('does not crash when a resume token has the same length but more bytes', () => {
    const b = join(room, 'B');
    room.closed(b.socket, 1006);
    const token = `é${'x'.repeat(b.welcome.token.length - 1)}`;
    assert.equal(token.length, b.welcome.token.length);
    assert.notEqual(Buffer.from(token).length, Buffer.from(b.welcome.token).length);
    const thief = join(room, 'C', { resume: { id: b.welcome.id, token } });
    assert.equal(thief.welcome.resumed, false);
    assert.notEqual(thief.welcome.id, b.welcome.id);
  });

  it('replaces a half-open socket when the same member resumes', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    const back = join(room, 'B', { resume: { id: b.welcome.id, token: b.welcome.token } });
    assert.equal(back.welcome.resumed, true);
    assert.equal(b.socket.closedWith, 4000);
    // The old socket's close event must not remove the member.
    room.closed(b.socket, 1000);
    assert.equal(room.size, 2);
    assert.equal(a.socket.last('peer-left'), undefined);
  });

  it('evacuates everyone without announcing departures', () => {
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.evacuate(4010);
    assert.equal(room.size, 0);
    assert.equal(a.socket.closedWith, 4010);
    assert.equal(b.socket.closedWith, 4010);
    assert.equal(a.socket.last('peer-left'), undefined);
  });

  it('answers pings', () => {
    const a = join(room, 'A');
    room.handle(a.socket, JSON.stringify({ type: 'ping' }));
    assert.ok(a.socket.last('pong'));
  });

  it('closes a socket after 500 messages in ten seconds', () => {
    const joined = join(room, 'Kitchen');
    for (let i = 0; i < 499; i += 1) room.handle(joined.socket, JSON.stringify({ type: 'ping' }));
    assert.equal(joined.socket.closedWith, null);
    room.handle(joined.socket, JSON.stringify({ type: 'ping' }));
    assert.equal(joined.socket.closedWith, 1008);
    assert.equal(joined.socket.last('error').code, 'rate');
    const before = joined.socket.sent.length;
    room.handle(joined.socket, JSON.stringify({ type: 'ping' }));
    assert.equal(joined.socket.sent.length, before);
  });

  it('sums up who is on the call with at most two names, in join order', () => {
    assert.deepEqual(room.summary(), { count: 0, names: [] });
    join(room, 'Bob');
    assert.deepEqual(room.summary(), { count: 1, names: ['Bob'] });
    join(room, 'Alice');
    join(room, 'Carol');
    assert.deepEqual(room.summary(), { count: 3, names: ['Bob', 'Alice'] });
  });

  it('ignores garbage', () => {
    const socket = new FakeSocket();
    room.handle(socket, 'not json');
    room.handle(socket, '{"type":5}');
    room.handle(socket, JSON.stringify({ type: 'signal', to: 'x', data: {} }));
    assert.equal(socket.sent.length, 0);
  });
});

describe('cleanSignal', () => {
  it('accepts descriptions and candidates', () => {
    assert.ok(cleanSignal({ kind: 'description', description: { type: 'answer', sdp: 'v=0' } }));
    assert.deepEqual(cleanSignal({ kind: 'candidate', candidate: null }), { kind: 'candidate', candidate: null });
    assert.deepEqual(
      cleanSignal({ kind: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, foo: 1 } }),
      { kind: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } },
    );
  });

  it('rejects everything else', () => {
    assert.equal(cleanSignal(null), null);
    assert.equal(cleanSignal({ kind: 'offer', sdp: 'v=0' }), null);
    assert.equal(cleanSignal({ kind: 'description', description: { type: 'rollback', sdp: '' } }), null);
    assert.equal(cleanSignal({ kind: 'description', description: { type: 'offer', sdp: 'x'.repeat(100001) } }), null);
    assert.equal(cleanSignal({ kind: 'candidate', candidate: { candidate: 5 } }), null);
  });
});

describe('cleanName', () => {
  it('strips invisible and direction-changing characters', () => {
    assert.equal(cleanName('  Ki\u202etchen\u200b '), 'Kitchen');
    assert.equal(cleanName('a\nb\tc'), 'a b c');
  });

  it('keeps emoji sequences whole and limits length by character', () => {
    assert.equal(cleanName('👨‍👩‍👧'), '👨‍👩‍👧');
    assert.equal([...cleanName('😀'.repeat(40))].length, 32);
  });

  it('falls back to Guest', () => {
    assert.equal(cleanName(''), 'Guest');
    assert.equal(cleanName('\u200b\u202e'), 'Guest');
    assert.equal(cleanName(undefined), 'Guest');
  });
});
