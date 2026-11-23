'use strict';

const https = require('https');
const path = require('path');
const { randomBytes } = require('crypto');
const { WebSocketServer } = require('ws');
const { bridge, fetchPeople, probeHost, HOP_HEADER } = require('./lib/bridge');
const { ensureCertificate } = require('./lib/certs');
const { createDiscovery, electUpstream, planHandover, HANDOVER_PROBE_MS, ALIAS } = require('./lib/discovery');
const { createRequestHandler, sameOrigin } = require('./lib/http');
const { keepAlive } = require('./lib/keepalive');
const { lanInterfaces, lanIPv4s, parseAllow, trustedPeer } = require('./lib/network');
const { Room } = require('./lib/room');

const PORT = normalizePort(process.env.PORT);
const DISCOVERY = !/^(0|off|false|no)$/i.test(process.env.AUDIOLAN_DISCOVERY || '');
const ALLOW = readAllow(process.env.AUDIOLAN_ALLOW);
const SECRET = readSecret(process.env.AUDIOLAN_SECRET);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// A container keeps certificates on a volume, so the household CA survives
// an image update and phones do not have to trust a new one.
const CERT_DIR = path.resolve(process.env.AUDIOLAN_CERTS || path.join(ROOT, '.certs'));
const INSTANCE = randomBytes(4).toString('hex');
const STARTED = Date.now();
const MAX_PEERS = 16;
const MOVED = 4010;

/**
 * One line per arrival and departure on the terminal.
 * @param {{ kind?: string, name?: string, occupancy?: number }} event
 */
function homeLog(event) {
  if (!event || typeof event !== 'object') return;
  if (event.kind === 'resume') {
    console.log(`~ ${event.name}  (back on the line)`);
    return;
  }
  const mark = event.kind === 'leave' ? '-' : '+';
  console.log(`${mark} ${event.name}  (${event.occupancy} on the line)`);
}

/** @param {string | undefined} value */
function normalizePort(value) {
  const port = Number(value || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer from 1 to 65535.');
    process.exit(1);
  }
  return port;
}

/** @param {string | undefined} value */
function readAllow(value) {
  try {
    return parseAllow(value);
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
}

/**
 * The household secret that signs discovery. Short secrets are refused: the
 * signature is on the network, so a guessable one can be found offline.
 * @param {string | undefined} value
 */
function readSecret(value) {
  const secret = String(value || '').trim();
  if (secret && secret.length < 16) {
    console.error('AUDIOLAN_SECRET must be at least 16 characters. Make one with: openssl rand -base64 18');
    process.exit(1);
  }
  return secret;
}

/** @param {string[]} ips */
function certNames(ips) {
  return [...new Set(['localhost', ALIAS, '127.0.0.1', ...ips])];
}

/**
 * @param {string[]} ips
 * @param {boolean} alias
 */
function shareUrls(ips, alias) {
  const urls = ips.map((ip) => `https://${ip}:${PORT}`);
  // The name survives the router handing out a new IP, so list it first.
  if (alias) urls.unshift(`https://${ALIAS}:${PORT}`);
  return urls;
}

/** Reach a room host on this same machine over loopback. @param {string} host */
function dialHost(host) {
  const split = host.lastIndexOf(':');
  const ip = host.slice(0, split);
  if (ip === '127.0.0.1' || lanIPv4s().includes(ip)) return `127.0.0.1:${host.slice(split + 1)}`;
  return host;
}

/**
 * @param {string[]} ips
 * @param {{ via: string, ca: { fingerprint: string } | null }} certificate
 * @param {boolean} alias
 * @param {{ url: string } | null} upstream
 */
function printBanner(ips, certificate, alias, upstream) {
  const lines = ['', '  audiolan', '  local voice. peers connect directly.', '', '  open'];
  const urls = shareUrls(ips, alias);
  for (const url of urls) lines.push(`    ${url}`);
  lines.push(`    https://localhost:${PORT}`, '');
  lines.push(`  certificate   ${certificate.via}  (${CERT_DIR.startsWith(ROOT + path.sep) ? path.relative(ROOT, CERT_DIR) : CERT_DIR})`);
  if (certificate.ca) {
    lines.push(`  on each phone, open ${urls[0] || `https://localhost:${PORT}`}/ca.crt once and trust it.`);
    lines.push(`  check that its SHA-256 matches  ${certificate.ca.fingerprint}`);
  } else if (certificate.via !== 'mkcert') {
    lines.push('  the browser will warn once. continue anyway.');
  }
  if (SECRET) lines.push('  discovery is signed (AUDIOLAN_SECRET). only servers with the same secret share a room.');
  if (ALLOW.any) lines.push('  AUDIOLAN_ALLOW=any. any address that can reach this port can join.');
  if (!DISCOVERY) lines.push('  discovery is off (AUDIOLAN_DISCOVERY). this computer hosts its own room.');
  if (ips.length === 0) {
    lines.push('  no LAN address yet. other machines cannot join.');
  } else if (upstream) {
    lines.push(`  joining the room at ${upstream.url}`);
  } else {
    lines.push('  this computer opens the room.');
    lines.push('  same network. not guest Wi-Fi. leave this process running.');
  }
  lines.push('');
  console.log(lines.join('\n'));
}

async function main() {
  const ips = lanIPv4s();
  const certificate = await ensureCertificate(CERT_DIR, certNames(ips));
  const room = new Room({ maxPeers: MAX_PEERS, log: homeLog });
  const discovery = DISCOVERY
    ? createDiscovery({
      port: PORT,
      instance: INSTANCE,
      since: STARTED,
      fingerprint: certificate.fingerprint,
      interfaces: () => lanInterfaces(),
      secret: SECRET,
      allow: ALLOW,
    })
    : null;
  const mdnsUp = discovery ? await discovery.start() : false;

  const upstream = () => (discovery ? electUpstream({ id: INSTANCE, since: STARTED }, discovery.rooms()) : null);

  const handler = createRequestHandler({
    root: PUBLIC_DIR,
    // Who is on the call, for the join screen. When another computer hosts
    // the room, ask it. A request that already came through a relay is
    // answered from here, so two servers never ask each other in a loop.
    rooms: async (req) => {
      const up = req.headers[HOP_HEADER] ? null : upstream();
      const people = up ? await fetchPeople(dialHost(up.host), up.fp) : room.summary();
      return {
        role: up || (people && people.count > 0) ? 'join' : 'host',
        urls: up ? [up.url] : shareUrls(lanIPv4s(), !!discovery?.alias),
        people,
      };
    },
    health: () => ({ ok: true, peers: room.size, port: PORT, discovery: mdnsUp }),
    extras: () => (certificate.ca
      ? new Map([['/ca.crt', { body: certificate.ca.pem, type: 'application/x-x509-ca-cert' }]])
      : new Map()),
  });
  const server = https.createServer({ key: certificate.key, cert: certificate.cert }, handler);
  // The household is this computer and its LAN. Anything else (a VPN peer, a
  // container, a port-forward from the internet) is dropped before TLS starts.
  /** @type {Set<string>} */
  const refused = new Set();
  server.on('connection', (/** @type {import('net').Socket} */ socket) => {
    if (trustedPeer(socket.remoteAddress, lanInterfaces(), ALLOW)) return;
    const from = String(socket.remoteAddress || 'unknown');
    if (refused.size < 64 && !refused.has(from)) {
      refused.add(from);
      console.warn(`  refused ${from}: not on this network. AUDIOLAN_ALLOW can add it.`);
    }
    socket.destroy();
  });
  const wss = new WebSocketServer({
    server,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
    verifyClient: sameOrigin,
  });

  const stopKeepAlive = keepAlive(wss);

  wss.on('connection', (socket, req) => {
    // A socket that already went through a bridge never gets bridged again,
    // so two servers that briefly disagree cannot relay in a loop.
    const up = req.headers[HOP_HEADER] ? null : upstream();
    if (!up) {
      hostLocally(socket, []);
      return;
    }
    bridge(socket, up, {
      dial: dialHost(up.host),
      // The room host is unreachable. Stop sending people there, and keep
      // this browser here, so its join still succeeds.
      fallback: (queued) => {
        park(up.id);
        console.warn(`  could not reach the room at ${up.url}. hosting here for now.`);
        hostLocally(socket, queued);
      },
      log: (line) => console.warn(line),
    });
  });

  /**
   * @param {import('ws').WebSocket} socket
   * @param {string[]} queued messages the browser sent before this point
   */
  function hostLocally(socket, queued) {
    socket.on('message', (data, isBinary) => {
      if (!isBinary) room.handle(socket, data.toString());
    });
    socket.on('close', (code) => room.closed(socket, code));
    socket.on('error', () => { /* a close event follows */ });
    for (const text of queued) room.handle(socket, text);
  }

  // Re-run the election. The host claims audiolan.local. A server that finds
  // an older room hands its people over once that room has been seen twice
  // and a connection to it actually succeeds. One lost packet does not move
  // everyone, and a host this computer cannot reach does not evict them on
  // every tick.
  let handover = { lastId: /** @type {string | null} */ (null), steady: 0, heldId: /** @type {string | null} */ (null), heldOk: false, nextProbeAt: 0 };
  let probeGeneration = 0;

  /** Remember a host we could not reach, long enough that its advertisements cannot win again immediately. @param {string} id */
  function park(id) {
    probeGeneration += 1;
    discovery?.forget(id);
    handover = { ...handover, heldId: id, heldOk: false, nextProbeAt: Date.now() + HANDOVER_PROBE_MS };
  }

  /**
   * @param {{ id: string, host: string, url: string, fp: string }} target
   */
  function probeThenMove(target) {
    const generation = ++probeGeneration;
    handover = { ...handover, heldId: target.id, heldOk: false };
    probeHost(dialHost(target.host), target.fp).then((ok) => {
      if (generation !== probeGeneration) return;
      const current = upstream();
      if (!current || current.id !== target.id) return;
      if (!ok) {
        park(target.id);
        console.warn(`  could not reach the room at ${target.url}. keeping this line here.`);
        return;
      }
      handover = { ...handover, heldId: target.id, heldOk: true };
      if (room.size === 0) return;
      console.log(`  moving ${room.size} on the line to ${target.url}`);
      room.evacuate(MOVED);
    });
  }

  const election = setInterval(() => {
    const up = upstream();
    const key = up ? up.id : null;
    if (key !== handover.lastId) {
      console.log(up ? `  joining the room at ${up.url}` : '  this computer now hosts the room.');
    }
    const plan = planHandover(handover, { upstreamId: key, roomSize: room.size, now: Date.now() });
    handover = {
      lastId: plan.lastId,
      steady: plan.steady,
      heldId: handover.heldId,
      heldOk: plan.heldOk,
      nextProbeAt: plan.nextProbeAt,
    };
    discovery?.setAlias(!up && lanIPv4s().length > 0);
    if (plan.action === 'probe' && up) probeThenMove(up);
  }, 2000);
  election.unref();

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    stopKeepAlive();
    clearInterval(election);
    for (const socket of wss.clients) socket.close(1012, 'server stopping');
    setTimeout(() => process.exit(0), 600).unref();
    try { await discovery?.stop(); } catch { /* exiting anyway */ }
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '0.0.0.0', () => {
        server.off('error', reject);
        resolve(undefined);
      });
    });
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }

  // Give the first queries a moment to come back before deciding.
  if (mdnsUp) await new Promise((resolve) => setTimeout(resolve, 1500));
  const up = upstream();
  handover = { ...handover, lastId: up ? up.id : null };
  discovery?.setAlias(!up && ips.length > 0);
  printBanner(ips, certificate, !!discovery?.alias, up);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
