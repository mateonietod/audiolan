import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { cleanName, describePeople, initials, keyLabel, normalizeHost, preferFrameLength, readHash, worthSending } from '../public/js/util.js';

const server = createRequire(import.meta.url)('../lib/room.js');

describe('client utilities', () => {
  it('cleans names exactly like the server', () => {
    for (const input of ['  Kitchen ', 'a\u202eb', '', '👨‍👩‍👧 Den', 'x'.repeat(50), '\u0000\u0007 Bob']) {
      assert.equal(cleanName(input), server.cleanName(input), JSON.stringify(input));
    }
  });

  it('makes initials from code points', () => {
    assert.equal(initials('kitchen'), 'K');
    assert.equal(initials('Living Room Speaker'), 'LR');
    assert.equal(initials('😀 Den'), '😀D');
    assert.equal(initials('  '), '·');
  });

  it('labels keys', () => {
    assert.equal(keyLabel('Space'), 'Space');
    assert.equal(keyLabel('KeyT'), 'T');
    assert.equal(keyLabel('Digit4'), '4');
    assert.equal(keyLabel('Mouse3'), 'Mouse 4');
    assert.equal(keyLabel('Numpad0'), 'Num 0');
  });

  it('normalizes typed hosts', () => {
    assert.equal(normalizeHost('192.168.1.20', '8787'), '192.168.1.20:8787');
    assert.equal(normalizeHost('https://Audiolan.local:9000/path?x', '8787'), 'audiolan.local:9000');
    assert.equal(normalizeHost('[fe80::1]', '8787'), '[fe80::1]:8787');
    assert.equal(normalizeHost('   ', '8787'), '');
  });

  it('reads the hash', () => {
    const hash = readHash('#name=K%C3%BCche&debug');
    assert.equal(hash.get('name'), 'Küche');
    assert.equal(hash.has('debug'), true);
    const room = readHash('#room=abcdefghijklmnopqrstuv&name=Kitchen');
    room.delete('name');
    assert.equal(room.get('room'), 'abcdefghijklmnopqrstuv');
  });

  it('asks for 10 ms audio frames in the description it sends', () => {
    const sdp = [
      'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=ptime:20', 'a=maxptime:60',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:1', '',
    ].join('\r\n');
    const out = preferFrameLength(sdp);
    assert.equal(out.match(/a=ptime:/g)?.length, 1);
    assert.match(out, /a=maxptime:60\r\na=ptime:10\r\nm=application/);
    assert.ok(out.endsWith('a=mid:1\r\n'));
    assert.equal(preferFrameLength('v=0\r\nm=audio 9 RTP/SAVPF 111\r\n').split('\r\n')[2], 'a=ptime:10');
  });

  it('sends UDP candidates only', () => {
    assert.equal(worthSending({ candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 5000 typ host', protocol: 'udp' }), true);
    assert.equal(worthSending({ candidate: 'candidate:2 1 tcp 1518280447 192.168.1.2 9 typ host tcptype active', protocol: 'tcp' }), false);
    assert.equal(worthSending({ candidate: 'candidate:2 1 TCP 1518280447 192.168.1.2 9 typ host tcptype active' }), false);
    assert.equal(worthSending({ candidate: '' }), false);
    assert.equal(worthSending(null), false);
  });

  it('names at most two people on the call', () => {
    assert.equal(describePeople(null), '');
    assert.equal(describePeople({ count: 0, names: [] }), '');
    assert.equal(describePeople({ count: 1, names: ['Bob'] }), 'Bob');
    assert.equal(describePeople({ count: 2, names: ['Bob', 'Alice'] }), 'Bob and Alice');
    assert.equal(describePeople({ count: 5, names: ['Bob', 'Alice', 'Carol'] }), 'Bob, Alice and more');
    assert.equal(describePeople({ count: 3, names: [] }), '3 people');
    assert.equal(describePeople({ count: 'lots', names: ['Bob'] }), '');
  });
});
