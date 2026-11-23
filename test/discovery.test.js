'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it, afterEach } = require('node:test');
const { Table, createDiscovery, electUpstream, parseBrowse, parseLookup, planHandover, signAnnouncement, HANDOVER_PROBE_MS, SERVICE } = require('../lib/discovery');
const { parseAllow } = require('../lib/network');

const LAN = [{ name: 'en0', address: '192.168.1.10', netmask: '255.255.255.0' }];
const FP = 'ab'.repeat(32);

/**
 * @param {string} id
 * @param {{ since?: number, ttl?: number, ips?: string[], v?: string, port?: number, sig?: string }} [options]
 */
function announce(id, { since = 100, ttl = 20, ips = ['192.168.1.20'], v = '2', port = 8787, sig = '' } = {}) {
  const instance = `audiolan-${id}.${SERVICE}`;
  const host = `audiolan-${id}.local`;
  const txt = [`v=${v}`, `id=${id}`, `since=${since}`, `fp=${FP}`, ...(sig ? [`sig=${sig}`] : [])];
  return [
    { name: SERVICE, type: 'PTR', ttl, data: instance },
    { name: instance, type: 'SRV', ttl, data: { port, target: host } },
    { name: instance, type: 'TXT', ttl, data: txt.map((item) => Buffer.from(item)) },
    ...ips.map((ip) => ({ name: host, type: 'A', ttl, data: ip })),
  ];
}

const SECRET = 'correct horse battery staple';

describe('discovery table', () => {
  it('builds a room from a full announcement', () => {
    const table = new Table();
    table.ingest(announce('b1'), 0);
    assert.deepEqual(table.rooms(1000, { self: 'me', ifaces: LAN }), [{
      id: 'b1',
      since: 100,
      host: '192.168.1.20:8787',
      url: 'https://192.168.1.20:8787/',
      fp: FP,
    }]);
  });

  it('ignores itself and other protocol versions', () => {
    const table = new Table();
    table.ingest(announce('me'), 0);
    table.ingest(announce('old', { v: '1' }), 0);
    assert.deepEqual(table.rooms(1000, { self: 'me', ifaces: LAN }), []);
  });

  it('forgets rooms when their records expire or say goodbye', () => {
    const table = new Table();
    table.ingest(announce('b1', { ttl: 20 }), 0);
    table.ingest(announce('b2', { ttl: 20, ips: ['192.168.1.21'] }), 0);
    assert.equal(table.rooms(19000, { self: 'me', ifaces: LAN }).length, 2);
    table.ingest(announce('b2', { ttl: 0, ips: ['192.168.1.21'] }), 19500);
    assert.deepEqual(table.rooms(19600, { self: 'me', ifaces: LAN }).map((room) => room.id), ['b1']);
    assert.deepEqual(table.rooms(20001, { self: 'me', ifaces: LAN }), []);
  });

  it('prefers the address on this machine\'s subnet', () => {
    const table = new Table();
    table.ingest(announce('b1', { ips: ['10.0.0.5', '192.168.1.20'] }), 0);
    assert.equal(table.rooms(1, { self: 'me', ifaces: LAN })[0].host, '192.168.1.20:8787');
  });

  it('uses this computer\'s LAN address for a server announced over loopback', () => {
    const table = new Table();
    table.ingest(announce('b1', { ips: ['127.0.0.1'], port: 8899 }), 0);
    assert.equal(table.rooms(1, { self: 'me', ifaces: LAN })[0].url, 'https://192.168.1.10:8899/');
  });

  it('ignores a room with no fingerprint', () => {
    const table = new Table();
    const records = announce('b1').map((record) => {
      if (record.type !== 'TXT' || !Array.isArray(record.data)) return record;
      return {
        ...record,
        data: record.data.filter((item) => !Buffer.from(item).toString().startsWith('fp=')),
      };
    });
    table.ingest(records, 0);
    assert.deepEqual(table.rooms(1, { self: 'me', ifaces: LAN }), []);
  });

  it('uses the address published in the text record when there is no A record', () => {
    const table = new Table();
    const instance = `audiolan-b1.${SERVICE}`;
    const host = 'audiolan-b1.local';
    table.ingest([
      { name: SERVICE, type: 'PTR', ttl: 20, data: instance },
      { name: instance, type: 'SRV', ttl: 20, data: { port: 8787, target: host } },
      { name: instance, type: 'TXT', ttl: 20, data: [`v=2`, `id=b1`, `since=100`, `fp=${FP}`, 'ip=192.168.1.20'] },
    ], 0);
    assert.equal(table.rooms(1, { self: 'me', ifaces: LAN })[0].host, '192.168.1.20:8787');
  });

  it('never points the room at an address off this network', () => {
    const table = new Table();
    const instance = `audiolan-evil.${SERVICE}`;
    table.ingest([
      { name: SERVICE, type: 'PTR', ttl: 20, data: instance },
      { name: instance, type: 'SRV', ttl: 20, data: { port: 8787, target: 'evil.local' } },
      { name: instance, type: 'TXT', ttl: 20, data: ['v=2', 'id=evil', 'since=1', `fp=${FP}`, 'ip=203.0.113.9'] },
    ], 0);
    assert.deepEqual(table.rooms(1, { self: 'me', ifaces: LAN }), []);
    table.ingest(announce('b2', { ips: ['10.0.0.5'] }), 0);
    assert.deepEqual(table.rooms(1, { self: 'me', ifaces: LAN }), []);
  });

  it('reaches another subnet that AUDIOLAN_ALLOW names', () => {
    const table = new Table();
    table.ingest(announce('b2', { ips: ['10.0.0.5'] }), 0);
    const rooms = table.rooms(1, { self: 'me', ifaces: LAN, allow: parseAllow('10.0.0.0/8') });
    assert.equal(rooms[0]?.host, '10.0.0.5:8787');
  });

  it('with a household secret, follows only announcements signed with it', () => {
    const table = new Table({ secret: SECRET });
    const fields = { v: '2', id: 'good', since: '100', fp: FP };
    table.ingest(announce('good', { sig: signAnnouncement(SECRET, fields) }), 0);
    table.ingest(announce('plain', { ips: ['192.168.1.21'] }), 0);
    table.ingest(announce('forged', { ips: ['192.168.1.22'], sig: signAnnouncement('another household secret', { ...fields, id: 'forged' }) }), 0);
    // A copied signature does not carry over to an older start time.
    table.ingest(announce('good', { since: 1, ips: ['192.168.1.23'], sig: signAnnouncement(SECRET, fields) }), 0);
    assert.deepEqual(table.rooms(1, { self: 'me', ifaces: LAN }).map((room) => room.id), []);
    const fresh = new Table({ secret: SECRET });
    fresh.ingest(announce('good', { sig: signAnnouncement(SECRET, fields) }), 0);
    fresh.ingest(announce('plain', { ips: ['192.168.1.21'] }), 0);
    assert.deepEqual(fresh.rooms(1, { self: 'me', ifaces: LAN }).map((room) => room.id), ['good']);
  });

  it('without a secret, leaves signed households alone', () => {
    const table = new Table();
    table.ingest(announce('private', { sig: signAnnouncement(SECRET, { v: '2', id: 'private', since: '100', fp: FP }) }), 0);
    table.ingest(announce('open', { ips: ['192.168.1.21'] }), 0);
    assert.deepEqual(table.rooms(1, { self: 'me', ifaces: LAN }).map((room) => room.id), ['open']);
  });

  it('asks for what is missing', () => {
    const table = new Table();
    table.ingest([{ name: SERVICE, type: 'PTR', ttl: 20, data: `audiolan-x.${SERVICE}` }], 0);
    const questions = table.incomplete(1).map((q) => q.type).sort();
    assert.deepEqual(questions, ['SRV', 'TXT']);
  });
});

describe('election', () => {
  const self = { id: 'mmm', since: 200 };

  it('stays host when nobody older is around', () => {
    assert.equal(electUpstream(self, []), null);
    assert.equal(electUpstream(self, [{ id: 'zzz', since: 300, host: 'h', url: 'u', fp: '' }]), null);
  });

  it('joins the oldest room', () => {
    const rooms = [
      { id: 'b', since: 150, host: 'h1', url: 'u1', fp: '' },
      { id: 'a', since: 100, host: 'h2', url: 'u2', fp: '' },
    ];
    assert.equal(electUpstream(self, rooms)?.id, 'a');
  });

  it('breaks ties by id the same way on every machine', () => {
    const tied = { id: 'aaa', since: 200, host: 'h', url: 'u', fp: '' };
    assert.equal(electUpstream(self, [tied])?.id, 'aaa');
    assert.equal(electUpstream({ id: 'aaa', since: 200 }, [{ ...tied, id: 'mmm' }]), null);
  });
});

describe('dns-sd text', () => {
  it('reads browse lines and skips the alias proxy', () => {
    const add = '17:46:59.711  Add        2  23 local.               _audiolan._tcp.      audiolan-abc';
    const gone = '17:46:59.711  Rmv        2  23 local.               _audiolan._tcp.      audiolan-abc';
    const alias = '17:46:59.711  Add        2  23 local.               _audiolan._tcp.      audiolan';
    assert.deepEqual(parseBrowse(add), { kind: 'add', name: 'audiolan-abc' });
    assert.deepEqual(parseBrowse(gone), { kind: 'remove', name: 'audiolan-abc' });
    assert.equal(parseBrowse(alias), null);
    assert.equal(parseBrowse('Browsing for _audiolan._tcp.local'), null);
  });

  it('reads a lookup', () => {
    const text = [
      'Lookup audiolan-abc._audiolan._tcp.local',
      '17:47:01.204  audiolan-abc._audiolan._tcp.local. can be reached at Some-Mac.local.:8799 (interface 23)',
      ` id=abc since=100 v=2 fp=${FP} ip=192.168.1.20`,
    ].join('\n');
    assert.deepEqual(parseLookup(text), {
      host: 'Some-Mac.local',
      port: 8799,
      txt: { id: 'abc', since: '100', v: '2', fp: FP, ip: '192.168.1.20' },
    });
  });
});

describe('dns-sd registration', () => {
  /** @type {any} */
  let discovery = null;

  afterEach(async () => {
    if (discovery) await discovery.stop();
    discovery = null;
  });

  /**
   * @param {any[]} bag
   */
  function fakeSpawn(bag) {
    return (/** @type {string[]} */ args) => {
      const child = /** @type {any} */ (new EventEmitter());
      child.stdout = new EventEmitter();
      child.pid = 2000000000 + bag.length;
      child.unref = () => {};
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.emit('exit', 0);
      };
      child.args = args;
      bag.push(child);
      return child;
    };
  }

  /**
   * @param {string[]} addresses
   * @param {string} [secret]
   */
  function boot(addresses, secret = '') {
    /** @type {string[]} */
    let current = addresses.slice();
    /** @type {any[]} */
    const calls = [];
    discovery = createDiscovery({
      port: 8787,
      instance: 'abc',
      since: 1,
      fingerprint: FP,
      interfaces: () => current.map((address) => ({ name: 'en0', address, netmask: '255.255.255.0' })),
      transport: 'dns-sd',
      secret,
      spawnProcess: fakeSpawn(calls),
    });
    return {
      calls,
      /** @param {string[]} next */
      setIfaces(next) { current = next.slice(); },
    };
  }

  /** @param {any[]} calls */
  async function started(calls) {
    const pending = discovery.start();
    calls[0].stdout.emit('data', Buffer.from('registered and active\n'));
    assert.equal(await pending, true);
  }

  it('registers again when the LAN address changes', async () => {
    const { calls, setIfaces } = boot(['192.168.1.10']);
    await started(calls);
    discovery.setAlias(true);
    assert.equal(calls.filter((child) => child.args[0] === '-R').length, 1);
    assert.equal(calls.find((child) => child.args[0] === '-P').args.at(-1), '192.168.1.10');
    setIfaces(['192.168.1.50']);
    discovery.setAlias(true);
    const registrations = calls.filter((child) => child.args[0] === '-R');
    assert.equal(registrations.length, 2);
    assert.equal(registrations[0].killed, true);
    assert.ok(registrations[1].args.includes('ip=192.168.1.50'));
    const proxies = calls.filter((child) => child.args[0] === '-P');
    assert.equal(proxies.at(-1).args.at(-1), '192.168.1.50');
    assert.equal(proxies[0].killed, true);
  });

  it('leaves the registration in place when the address is unchanged', async () => {
    const { calls } = boot(['192.168.1.10']);
    await started(calls);
    assert.equal(calls[0].args.some((/** @type {string} */ arg) => arg.startsWith('sig=')), false);
    discovery.setAlias(true);
    discovery.setAlias(true);
    assert.equal(calls.filter((child) => child.args[0] === '-R').length, 1);
    assert.equal(calls.filter((child) => child.args[0] === '-P').length, 1);
  });

  it('signs the announcement when there is a household secret', async () => {
    const { calls } = boot(['192.168.1.10'], SECRET);
    await started(calls);
    const sig = signAnnouncement(SECRET, { v: '2', id: 'abc', since: '1', fp: FP });
    assert.ok(calls[0].args.includes(`sig=${sig}`));
  });

  it('publishes an address that arrives after startup', async () => {
    const { calls, setIfaces } = boot([]);
    await started(calls);
    assert.ok(calls[0].args.includes('ip='));
    setIfaces(['192.168.68.63']);
    discovery.setAlias(true);
    const registrations = calls.filter((child) => child.args[0] === '-R');
    assert.equal(registrations.length, 2);
    assert.ok(registrations[1].args.includes('ip=192.168.68.63'));
    assert.equal(calls.find((child) => child.args[0] === '-P').args.at(-1), '192.168.68.63');
  });
});

describe('handover', () => {
  const idle = { lastId: null, steady: 0, heldId: null, heldOk: false, nextProbeAt: 0 };

  it('waits for a second sighting before probing', () => {
    const first = planHandover(idle, { upstreamId: 'a', roomSize: 2, now: 1000 });
    assert.equal(first.action, 'none');
    assert.equal(first.steady, 0);
    const second = planHandover(first, { upstreamId: 'a', roomSize: 2, now: 2000 });
    assert.equal(second.action, 'probe');
  });

  it('does not probe again while a successful hold is in place', () => {
    const held = { lastId: 'a', steady: 1, heldId: 'a', heldOk: true, nextProbeAt: 0 };
    const next = planHandover(held, { upstreamId: 'a', roomSize: 2, now: 5000 });
    assert.equal(next.action, 'none');
  });

  it('waits out the probe interval after a failed hold', () => {
    const held = { lastId: 'a', steady: 4, heldId: 'a', heldOk: false, nextProbeAt: 20000 };
    assert.equal(planHandover(held, { upstreamId: 'a', roomSize: 2, now: 19000 }).action, 'none');
    assert.equal(planHandover(held, { upstreamId: 'a', roomSize: 2, now: 20000 }).action, 'probe');
  });

  it('probes a different room once it has been seen twice', () => {
    const held = { lastId: 'a', steady: 4, heldId: 'a', heldOk: false, nextProbeAt: 99999 };
    const seen = planHandover(held, { upstreamId: 'b', roomSize: 2, now: 1000 });
    assert.equal(seen.action, 'none');
    assert.equal(seen.steady, 0);
    assert.equal(planHandover(seen, { upstreamId: 'b', roomSize: 2, now: 2000 }).action, 'probe');
  });

  it('leaves an empty room alone', () => {
    const seen = { lastId: 'a', steady: 3, heldId: null, heldOk: false, nextProbeAt: 0 };
    assert.equal(planHandover(seen, { upstreamId: 'a', roomSize: 0, now: 1000 }).action, 'none');
    assert.equal(HANDOVER_PROBE_MS, 15000);
  });
});
