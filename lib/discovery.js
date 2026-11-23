'use strict';

const dgram = require('dgram');
const fs = require('fs');
const { spawn } = require('child_process');
const { createHmac, timingSafeEqual } = require('crypto');
const { isFingerprint } = require('./certs');
const { pickAddress, usableAddress } = require('./network');
const { PROTOCOL: WIRE_PROTOCOL } = require('../public/js/protocol.js');

const SERVICE = '_audiolan._tcp.local';
const ALIAS = 'audiolan.local';
const PROTOCOL = String(WIRE_PROTOCOL);
const SIGNATURE = /^[0-9a-f]{64}$/;
// Short TTLs so a computer that crashes drops out of the election quickly.
const TTL = 20;
const QUERY_EVERY = 5000;
const HANDOVER_PROBE_MS = 15000;
const DEBUG = /^(1|on|true|yes)$/i.test(process.env.AUDIOLAN_DEBUG || '');

/** @typedef {import('./network').LanInterface} LanInterface */
/** @typedef {import('./network').Allow} Allow */
/**
 * @typedef {{ id: string, since: number, host: string, url: string, fp: string }} RoomRecord
 * @typedef {{ name: string, type: string, ttl?: number, data?: any, flush?: boolean }} DnsRecord
 */

/** @param {unknown} value */
function lower(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

/** @param {unknown} data */
function txtToObject(data) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const item of [].concat(/** @type {any} */ (data) || [])) {
    const text = Buffer.isBuffer(item) ? item.toString('utf8') : String(item);
    const eq = text.indexOf('=');
    if (eq > 0) out[text.slice(0, eq).toLowerCase()] = text.slice(eq + 1);
  }
  return out;
}

/**
 * The household signature on an announcement. It covers what decides the
 * election and what the bridge pins. The address is left out on purpose: a
 * copied record pointed at another machine still fails the certificate pin.
 * @param {string} secret
 * @param {{ v?: string, id?: string, since?: string | number, fp?: string }} fields
 */
function signAnnouncement(secret, { v, id, since, fp }) {
  return createHmac('sha256', secret)
    .update(`audiolan|${v}|${id}|${since}|${String(fp || '').toLowerCase()}`)
    .digest('hex');
}

/**
 * With a secret, only announcements signed with it count. Without one, signed
 * announcements belong to another household that chose to stay apart.
 * @param {string} secret
 * @param {Record<string, string>} txt
 */
function signedFor(secret, txt) {
  if (!secret) return !txt.sig;
  const sig = String(txt.sig || '').toLowerCase();
  if (!SIGNATURE.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signAnnouncement(secret, txt), 'hex'));
}

/**
 * The text record every backend publishes.
 * @param {{ instance: string, since: number, fingerprint: string, secret?: string }} self
 * @param {string[]} ips
 */
function announcement({ instance, since, fingerprint, secret }, ips) {
  const fields = { v: PROTOCOL, id: instance, since: String(since), fp: fingerprint };
  const txt = [`v=${fields.v}`, `id=${fields.id}`, `since=${fields.since}`, `fp=${fields.fp}`, `ip=${ips.join(',')}`];
  if (secret) txt.push(`sig=${signAnnouncement(secret, fields)}`);
  return txt;
}

/**
 * What this server has heard about other audiolan servers. Pure, so it can be
 * tested without a network.
 */
class Table {
  /** @param {{ secret?: string }} [options] */
  constructor({ secret = '' } = {}) {
    this.secret = secret;
    /** @type {Map<string, { expires: number, srv?: { target: string, port: number }, txt?: Record<string, string> }>} */
    this.instances = new Map();
    /** @type {Map<string, Map<string, number>>} */
    this.hosts = new Map();
  }

  /** @param {string} name */
  entry(name) {
    let entry = this.instances.get(name);
    if (!entry) {
      entry = { expires: 0 };
      this.instances.set(name, entry);
    }
    return entry;
  }

  /**
   * @param {DnsRecord[]} records
   * @param {number} now
   */
  ingest(records, now) {
    for (const record of records) {
      const name = lower(record.name);
      const ttl = Number(record.ttl ?? TTL);
      const expires = now + ttl * 1000;
      const ours = name.endsWith(`.${SERVICE}`);
      if (record.type === 'PTR' && name === SERVICE) {
        const instance = lower(record.data);
        if (ttl === 0) this.instances.delete(instance);
        else this.entry(instance).expires = Math.max(this.entry(instance).expires, expires);
      } else if (record.type === 'SRV' && ours) {
        if (ttl === 0) { this.instances.delete(name); continue; }
        const entry = this.entry(name);
        entry.srv = { target: lower(record.data && record.data.target), port: Number(record.data && record.data.port) };
        entry.expires = Math.max(entry.expires, expires);
      } else if (record.type === 'TXT' && ours) {
        if (ttl === 0) { this.instances.delete(name); continue; }
        const entry = this.entry(name);
        entry.txt = txtToObject(record.data);
        entry.expires = Math.max(entry.expires, expires);
      } else if (record.type === 'A' && typeof record.data === 'string') {
        let addrs = this.hosts.get(name);
        if (!addrs) {
          addrs = new Map();
          this.hosts.set(name, addrs);
        }
        if (ttl === 0) addrs.delete(record.data);
        else addrs.set(record.data, expires);
      }
    }
  }

  /**
   * Names still missing a record we need, to ask for directly.
   * @param {number} now
   */
  incomplete(now) {
    /** @type {{ name: string, type: string }[]} */
    const questions = [];
    for (const [name, entry] of this.instances) {
      if (entry.expires <= now) continue;
      if (!entry.srv) questions.push({ name, type: 'SRV' });
      if (!entry.txt) questions.push({ name, type: 'TXT' });
      if (entry.srv && this.addresses(entry.srv.target, now).length === 0) {
        questions.push({ name: entry.srv.target, type: 'A' });
      }
    }
    return questions;
  }

  /**
   * @param {string} host
   * @param {number} now
   */
  addresses(host, now) {
    const addrs = this.hosts.get(host);
    if (!addrs) return [];
    return [...addrs].filter(([, expires]) => expires > now).map(([addr]) => addr);
  }

  /**
   * @param {number} now
   * @param {{ self: string, ifaces: LanInterface[], allow?: Allow }} options
   * @returns {RoomRecord[]}
   */
  rooms(now, { self, ifaces, allow }) {
    /** @type {RoomRecord[]} */
    const out = [];
    for (const [name, entry] of this.instances) {
      if (entry.expires <= now) {
        this.instances.delete(name);
        continue;
      }
      if (!entry.srv || !entry.txt) continue;
      const { id, since, v, fp, ip: txtIp } = entry.txt;
      if (v !== PROTOCOL || !id || id === self || !isFingerprint(fp)) continue;
      if (!signedFor(this.secret, entry.txt)) continue;
      const fromTxt = String(txtIp || '').split(',').map((item) => item.trim()).filter(usableAddress);
      const addrs = [...this.addresses(entry.srv.target, now), ...fromTxt];
      // Only an address on this network. A server on this same computer can
      // be announced with a loopback address: use this computer's LAN
      // address, which phones can reach.
      const ip = pickAddress(addrs, ifaces, allow)
        || (addrs.some((addr) => addr.startsWith('127.')) && ifaces[0] ? ifaces[0].address : '');
      if (!ip || !entry.srv.port) continue;
      const host = `${ip}:${entry.srv.port}`;
      if (out.some((room) => room.host === host)) continue;
      out.push({
        id,
        since: Number(since) || Number.MAX_SAFE_INTEGER,
        host,
        url: `https://${host}/`,
        fp: String(fp).toLowerCase(),
      });
    }
    return out;
  }
}

/**
 * Everyone runs the same election over the same records: the server that has
 * been up longest hosts the room, and ties go to the smaller id.
 * @param {{ id: string, since: number }} self
 * @param {RoomRecord[]} rooms
 * @returns {RoomRecord | null}
 */
function electUpstream(self, rooms) {
  const candidates = [{ ...self, self: true }, ...rooms.map((room) => ({ ...room, self: false }))];
  candidates.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const winner = candidates[0];
  if (!winner || winner.self) return null;
  return rooms.find((room) => room.id === winner.id) || null;
}

/**
 * What both discovery backends answer about other servers: the rooms heard
 * recently, minus any this server could not reach a moment ago.
 * @param {Table} table
 * @param {string} instance
 * @param {() => LanInterface[]} interfaces
 * @param {Allow} [allow]
 */
function roomView(table, instance, interfaces, allow) {
  /** @type {Map<string, number>} */
  const suppressed = new Map();
  return {
    /** Other audiolan servers on this network that answered recently. */
    rooms() {
      const now = Date.now();
      for (const [id, until] of suppressed) if (until <= now) suppressed.delete(id);
      return table.rooms(now, { self: instance, ifaces: interfaces(), allow })
        .filter((room) => !suppressed.has(room.id));
    },

    /**
     * Ignore a room for a while after a failed connection to it, so a crashed
     * host stops winning the election before its records expire.
     * @param {string} id
     * @param {number} [ms]
     */
    forget(id, ms = TTL * 1000) {
      suppressed.set(id, Date.now() + ms);
    },
  };
}

/**
 * @typedef {{
 *   port: number,
 *   instance: string,
 *   since: number,
 *   fingerprint: string,
 *   interfaces: () => LanInterface[],
 *   secret?: string,
 *   allow?: Allow,
 *   transport?: 'dns-sd' | 'multicast',
 *   factory?: (options: object) => any,
 *   spawnProcess?: (args: string[]) => import('child_process').ChildProcess,
 * }} DiscoveryOptions
 */

/**
 * Publish this server over mDNS and keep a live table of the others.
 * @param {DiscoveryOptions} options
 */
function createDiscovery(options) {
  const transport = options.transport
    || (process.platform === 'darwin' && fs.existsSync('/usr/bin/dns-sd') ? 'dns-sd' : 'multicast');
  if (transport === 'dns-sd') return createDnsSdDiscovery(options);
  return createMulticastDiscovery(options);
}

/** @param {DiscoveryOptions} options */
function createMulticastDiscovery({ port, instance, since, fingerprint, interfaces, secret = '', allow, factory }) {
  const instanceName = `audiolan-${instance}.${SERVICE}`;
  const hostName = `audiolan-${instance}.local`;
  const table = new Table({ secret });
  const view = roomView(table, instance, interfaces, allow);
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  let mdns = /** @type {any} */ (null);
  let alias = false;
  let followUp = /** @type {NodeJS.Timeout | null} */ (null);

  function records(ttl = TTL) {
    const ips = interfaces().map((item) => item.address);
    return {
      ptr: { name: SERVICE, type: 'PTR', ttl, data: instanceName },
      srv: { name: instanceName, type: 'SRV', ttl, flush: true, data: { port, target: hostName, priority: 0, weight: 0 } },
      txt: {
        name: instanceName,
        type: 'TXT',
        ttl,
        flush: true,
        data: announcement({ instance, since, fingerprint, secret }, ips),
      },
      a: ips.map((ip) => ({ name: hostName, type: 'A', ttl, flush: true, data: ip })),
      alias: ips.map((ip) => ({ name: ALIAS, type: 'A', ttl, flush: true, data: ip })),
    };
  }

  /** @param {DnsRecord[]} list */
  function unique(list) {
    const seen = new Set();
    return list.filter((record) => {
      const key = `${record.name}|${record.type}|${JSON.stringify(record.data)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * @param {any} query
   * @param {{ address: string, port: number } | undefined} rinfo
   */
  function onQuery(query, rinfo) {
    const r = records();
    /** @type {DnsRecord[]} */
    const answers = [];
    /** @type {DnsRecord[]} */
    const additionals = [];
    for (const question of query.questions || []) {
      const name = lower(question.name);
      const any = question.type === 'ANY';
      if (name === SERVICE && (question.type === 'PTR' || any)) {
        answers.push(r.ptr);
        additionals.push(r.srv, r.txt, ...r.a);
      } else if (name === instanceName) {
        if (question.type === 'SRV' || any) answers.push(r.srv);
        if (question.type === 'TXT' || any) answers.push(r.txt);
        additionals.push(...r.a);
      } else if (name === hostName && (question.type === 'A' || any)) {
        answers.push(...r.a);
      } else if (alias && name === ALIAS && (question.type === 'A' || any)) {
        answers.push(...r.alias);
      }
    }
    if (!answers.length) return;
    const response = { answers: unique(answers), additionals: unique(additionals) };
    if (rinfo && rinfo.port !== 5353) {
      // A plain DNS resolver asking over mDNS wants a unicast reply that echoes the query.
      mdns.respond({ ...response, id: query.id, questions: query.questions }, rinfo);
    } else {
      mdns.respond(response);
    }
  }

  /** @param {any} packet */
  function onResponse(packet) {
    const records = [...(packet.answers || []), ...(packet.additionals || [])];
    if (DEBUG) {
      for (const r of records) {
        if (/audiolan/i.test(r.name) || (r.type === 'A' && table.hosts.has(lower(r.name)))) {
          console.log(`  mdns ${r.type} ${r.name} ttl=${r.ttl}`);
        }
      }
    }
    table.ingest(records, Date.now());
    if (followUp) return;
    followUp = setTimeout(() => {
      followUp = null;
      const missing = table.incomplete(Date.now());
      if (missing.length && mdns) mdns.query({ questions: missing });
    }, 150);
    followUp.unref?.();
  }

  function query() {
    if (!mdns) return;
    mdns.query({ questions: [{ name: SERVICE, type: 'PTR' }, ...table.incomplete(Date.now())] });
  }

  function announce() {
    if (!mdns) return;
    const r = records();
    mdns.respond({ answers: [r.ptr, r.srv, r.txt, ...r.a, ...(alias ? r.alias : [])] });
  }

  /** @param {() => void} fn @param {number} ms */
  function later(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    timers.push(timer);
  }

  return {
    /** @returns {Promise<boolean>} */
    start() {
      return new Promise((resolve) => {
        let settled = false;
        /** @param {boolean} ok */
        const done = (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        // Listen on every interface (loopback included, which is how programs
        // on the same computer hear each other), but send on the LAN.
        // Left to itself, multicast-dns only finds the LAN on a Mac when it is
        // called en0. On Ethernet adapters and docks (en7…) announcements
        // went out on loopback and no other computer heard them.
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const aim = () => {
          const primary = interfaces()[0]?.address;
          if (!primary) return;
          try { socket.setMulticastInterface(primary); } catch { /* interface went away */ }
        };
        try {
          mdns = (factory || require('multicast-dns'))({ loopback: true, reuseAddr: true, socket });
          mdns.on('networkInterface', aim);
          mdns.once('ready', aim);
        } catch (error) {
          console.warn(`mDNS is off (${/** @type {Error} */ (error).message}). Use the IP address instead.`);
          mdns = null;
          done(false);
          return;
        }
        mdns.on('error', (/** @type {Error} */ error) => {
          console.warn(`mDNS is off (${error.message}). Use the IP address instead.`);
          try { mdns.destroy(); } catch { /* already closed */ }
          mdns = null;
          done(false);
        });
        mdns.on('warning', () => { /* malformed packets from other devices */ });
        mdns.on('query', onQuery);
        mdns.on('response', onResponse);
        mdns.on('ready', () => {
          announce();
          query();
          later(() => { announce(); query(); }, 1000);
          later(query, 2500);
          // Refresh well inside the TTL. Queries we cannot hear would otherwise
          // let every record, including audiolan.local, expire in silence.
          const loop = setInterval(() => { announce(); query(); }, QUERY_EVERY);
          loop.unref?.();
          timers.push(loop);
          done(true);
        });
        later(() => done(!!mdns), 2000);
      });
    },

    ...view,

    /** Answer for audiolan.local. Only the computer hosting the room does. @param {boolean} on */
    setAlias(on) {
      if (on === alias || !mdns) {
        alias = on;
        return;
      }
      alias = on;
      mdns.respond({ answers: records(on ? TTL : 0).alias });
    },

    get alias() {
      return alias;
    },

    /** Say goodbye so others drop this server at once, then close. */
    stop() {
      for (const timer of timers) clearTimeout(timer);
      if (!mdns) return Promise.resolve();
      const r = records(0);
      try {
        mdns.respond({ answers: [r.ptr, r.srv, r.txt, ...r.a, ...(alias ? r.alias : [])] });
      } catch { /* socket already gone */ }
      return new Promise((resolve) => {
        setTimeout(() => {
          try { mdns.destroy(); } catch { /* already closed */ }
          mdns = null;
          resolve(undefined);
        }, 120);
      });
    },
  };
}

/**
 * One step of the handover. Move people at most once per upstream, and only
 * after it has been seen twice. A failed relay sets `heldOk` false so the
 * same advertisement cannot evict them again until the probe interval elapses.
 * @param {{ lastId: string | null, steady: number, heldId: string | null, heldOk: boolean, nextProbeAt: number }} state
 * @param {{ upstreamId: string | null, roomSize: number, now: number }} event
 */
function planHandover(state, event) {
  const upstreamId = event.upstreamId || null;
  const steady = upstreamId === state.lastId ? state.steady + 1 : 0;
  const sameHold = !!upstreamId && state.heldId === upstreamId;
  const heldOk = sameHold && state.heldOk;
  const confirmed = !!upstreamId && steady >= 1 && event.roomSize > 0;
  const due = !sameHold || event.now >= state.nextProbeAt;
  const action = confirmed && !heldOk && due ? 'probe' : 'none';
  return {
    lastId: upstreamId,
    steady,
    heldId: state.heldId,
    heldOk,
    nextProbeAt: action === 'probe' ? event.now + HANDOVER_PROBE_MS : state.nextProbeAt,
    action,
  };
}

/** @param {string} line */
function parseBrowse(line) {
  const match = line.match(/\b(Add|Rmv)\s+\S+\s+\S+\s+\S+\s+_audiolan\._tcp\.?\s+(.+?)\s*$/);
  if (!match) return null;
  const name = match[2].trim();
  // The audiolan.local proxy is not a room. It has no id or start time.
  if (!name || name === 'audiolan' || name === `audiolan.${SERVICE}`) return null;
  return { kind: match[1] === 'Add' ? 'add' : 'remove', name };
}

/** @param {string} text */
function parseLookup(text) {
  const reached = text.match(/can be reached at\s+(\S+?):(\d+)/);
  if (!reached) return null;
  const txtLine = text.split(/\r?\n/).find((line) => /\bid=/.test(line) && /\bfp=/.test(line));
  if (!txtLine) return null;
  /** @type {Record<string, string>} */
  const txt = {};
  for (const part of txtLine.trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) txt[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return {
    host: reached[1].replace(/\.$/, ''),
    port: Number(reached[2]),
    txt,
  };
}

/**
 * dns-sd block-buffers when its stdout is a pipe. `script -F` gives it a
 * terminal and flushes each line, which is what makes the browse readable.
 * @param {string[]} args
 */
function spawnDnsSd(args) {
  const child = spawn('script', ['-q', '-F', '/dev/null', 'dns-sd', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.unref?.();
  return child;
}

/** @param {import('child_process').ChildProcess} child */
function stopChild(child) {
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  if (child.pid) kill();
  else {
    child.once('spawn', kill);
    if (child.pid) kill();
  }
}

/**
 * @param {import('child_process').ChildProcess} child
 * @param {RegExp} pattern
 * @param {number} ms
 */
function waitForText(child, pattern, ms) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve(ok);
    };
    const onData = (/** @type {Buffer} */ chunk) => {
      buf += chunk.toString().replace(/\x04/g, '');
      if (pattern.test(buf)) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    child.stdout?.on('data', onData);
    child.on('exit', () => finish(false));
  });
}

/**
 * macOS mDNSResponder owns port 5353. A UDP socket with only SO_REUSEADDR
 * binds and then hears nothing, so publish and browse go through dns-sd.
 * @param {DiscoveryOptions} options
 */
function createDnsSdDiscovery({ port, instance, since, fingerprint, interfaces, secret = '', allow, spawnProcess = spawnDnsSd }) {
  const ownName = `audiolan-${instance}`;
  const table = new Table({ secret });
  const view = roomView(table, instance, interfaces, allow);
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<import('child_process').ChildProcess>} */
  const children = new Set();
  /** @type {import('child_process').ChildProcess | null} */
  let aliasChild = null;
  /** @type {NodeJS.Timeout | null} */
  let refreshTimer = null;
  let alias = false;
  /** @type {string} */
  let aliasIp = '';
  /** @type {import('child_process').ChildProcess | null} */
  let registerChild = null;
  /** @type {string | null} */
  let publishedKey = null;
  let stopped = false;

  function addressKey() {
    return interfaces().map((item) => item.address).filter(usableAddress).sort().join(',');
  }

  function txtArgs() {
    const ips = interfaces().map((item) => item.address).filter(usableAddress);
    return announcement({ instance, since, fingerprint, secret }, ips);
  }

  /**
   * dns-sd keeps the addresses from the moment of registration. When the
   * LAN set changes, the old registration is the wrong room, so replace it.
   */
  function refreshService() {
    if (stopped) return null;
    const key = addressKey();
    if (registerChild && key === publishedKey) return null;
    const previous = registerChild;
    if (previous) {
      children.delete(previous);
      registerChild = null;
      stopChild(previous);
    }
    const child = spawnProcess(['-R', ownName, '_audiolan._tcp', 'local', String(port), ...txtArgs()]);
    registerChild = child;
    publishedKey = key;
    children.add(child);
    child.on('exit', () => {
      children.delete(child);
      if (registerChild === child) registerChild = null;
    });
    return child;
  }

  /** @param {boolean} on */
  function repostAlias(on) {
    if (!on) {
      if (aliasChild) stopChild(aliasChild);
      aliasChild = null;
      alias = false;
      aliasIp = '';
      return;
    }
    const ip = interfaces().map((item) => item.address).find(usableAddress) || '';
    if (!ip) {
      if (aliasChild) stopChild(aliasChild);
      aliasChild = null;
      alias = false;
      aliasIp = '';
      return;
    }
    if (alias && aliasIp === ip && aliasChild) return;
    if (aliasChild) stopChild(aliasChild);
    alias = true;
    aliasIp = ip;
    aliasChild = spawnProcess(['-P', 'audiolan', '_audiolan._tcp', 'local', String(port), ALIAS, ip]);
  }

  /** @param {string} name */
  function remember(name, text) {
    const parsed = parseLookup(text);
    if (!parsed) return;
    const id = parsed.txt.id || '';
    // The browse name is audiolan-<id>. A record that disagrees is not ours.
    if (!id || name !== `audiolan-${id}`) return;
    const target = `${name}.${SERVICE}`;
    const ips = String(parsed.txt.ip || '').split(',').map((item) => item.trim()).filter(usableAddress);
    const txt = Object.entries(parsed.txt).map(([key, value]) => `${key}=${value}`);
    table.ingest([
      { name: SERVICE, type: 'PTR', ttl: TTL, data: target },
      { name: target, type: 'SRV', ttl: TTL, data: { port: parsed.port, target: `${name}.local` } },
      { name: target, type: 'TXT', ttl: TTL, data: txt },
      ...ips.map((ip) => ({ name: `${name}.local`, type: 'A', ttl: TTL, data: ip })),
    ], Date.now());
  }

  /**
   * Short-lived dns-sd commands are detached, so they have to be tracked or
   * a shutdown in the middle of a lookup leaves them running.
   * @param {string[]} args
   * @param {number} ms
   */
  function collect(args, ms) {
    if (stopped) return Promise.resolve('');
    const child = spawnProcess(args);
    // stop() may run between the check above and this add.
    if (stopped) {
      stopChild(child);
      return Promise.resolve('');
    }
    children.add(child);
    if (stopped) stopChild(child);
    child.on('exit', () => children.delete(child));
    return new Promise((resolve) => {
      let buf = '';
      child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
        buf += chunk.toString().replace(/\x04/g, '').replace(/\r/g, '');
      });
      const timer = setTimeout(() => {
        stopChild(child);
        resolve(buf);
      }, ms);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
  }

  /** @param {string} name */
  async function lookup(name) {
    if (stopped || name === ownName) return;
    const text = await collect(['-L', name, '_audiolan._tcp', 'local'], 900);
    if (!stopped) remember(name, text);
  }

  /** @param {string} line */
  function onBrowseLine(line) {
    const event = parseBrowse(line);
    if (!event || event.name === ownName) return;
    if (event.kind === 'remove') {
      names.delete(event.name);
      table.ingest([{ name: SERVICE, type: 'PTR', ttl: 0, data: `${event.name}.${SERVICE}` }], Date.now());
      return;
    }
    names.add(event.name);
    lookup(event.name);
  }

  return {
    /** @returns {Promise<boolean>} */
    start() {
      return new Promise((resolve) => {
        const registered = refreshService();
        if (!registered) {
          resolve(false);
          return;
        }
        waitForText(registered, /registered and active/i, 2500).then((ok) => {
          if (!ok || stopped) {
            this.stop();
            resolve(false);
            return;
          }
          const browse = spawnProcess(['-B', '_audiolan._tcp', 'local']);
          children.add(browse);
          let buf = '';
          browse.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
            buf += chunk.toString().replace(/\x04/g, '').replace(/\r/g, '');
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) onBrowseLine(line);
          });
          refreshTimer = setInterval(() => {
            for (const name of names) lookup(name);
            refreshService();
            if (alias) repostAlias(true);
          }, QUERY_EVERY * 2);
          refreshTimer.unref?.();
          resolve(true);
        });
      });
    },

    ...view,

    /** @param {boolean} on */
    setAlias(on) {
      refreshService();
      repostAlias(on);
    },

    get alias() {
      return alias;
    },

    stop() {
      stopped = true;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      if (aliasChild) stopChild(aliasChild);
      aliasChild = null;
      for (const child of children) stopChild(child);
      children.clear();
      return Promise.resolve();
    },
  };
}

module.exports = {
  createDiscovery,
  electUpstream,
  planHandover,
  parseBrowse,
  parseLookup,
  signAnnouncement,
  Table,
  SERVICE,
  PROTOCOL,
  ALIAS,
  HANDOVER_PROBE_MS,
};
