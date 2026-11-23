'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { describe, it } = require('node:test');
const http = require('http');
const { resolveStatic, contentSecurityPolicy, sameOrigin, createRequestHandler } = require('../lib/http');
const { lanInterfaces, sameSubnet, pickAddress, parseAllow, trustedPeer } = require('../lib/network');

const ROOT = path.join(__dirname, '..', 'public');

describe('static files', () => {
  it('serves the page and its assets', () => {
    assert.equal(resolveStatic(ROOT, '/')?.file, path.join(ROOT, 'index.html'));
    assert.equal(resolveStatic(ROOT, '/js/main.js')?.type, 'text/javascript; charset=utf-8');
    assert.equal(resolveStatic(ROOT, '/fonts/GeistSerif-Regular.woff2')?.type, 'font/woff2');
    assert.equal(resolveStatic(ROOT, '/manifest.webmanifest')?.type.split(';')[0], 'application/manifest+json');
    assert.equal(resolveStatic(ROOT, '/robots.txt')?.type, 'text/plain; charset=utf-8');
    assert.equal(resolveStatic(ROOT, '/sitemap.xml')?.type, 'application/xml; charset=utf-8');
    assert.equal(resolveStatic(ROOT, '/og.png')?.type, 'image/png');
  });

  it('refuses traversal, dotfiles and unknown types', () => {
    assert.equal(resolveStatic(ROOT, '/../server.js')?.file, path.join(ROOT, 'server.js'));
    assert.equal(resolveStatic(ROOT, '/../../etc/passwd'), null);
    assert.equal(resolveStatic(ROOT, '/.certs/key.pem'), null);
    assert.equal(resolveStatic(ROOT, '/package.json'), null);
    assert.equal(resolveStatic(ROOT, '/x\0.js'), null);
  });

  it('names the socket origin in the CSP only for a sane Host header', () => {
    assert.match(contentSecurityPolicy('192.168.1.5:8787'), /connect-src 'self' wss:\/\/192\.168\.1\.5:8787;/);
    assert.match(contentSecurityPolicy('evil; script-src *'), /connect-src 'self';/);
    assert.match(contentSecurityPolicy(undefined), /frame-ancestors 'none'/);
    assert.match(contentSecurityPolicy('localhost:8787'), /font-src 'self'/);
  });

  it('accepts a page from this host and a client with no origin', () => {
    const req = (host) => ({ headers: { host } });
    assert.equal(sameOrigin({ req: req('localhost:8787') }), true);
    assert.equal(sameOrigin({ origin: 'https://room.example/join', req: req('room.example') }), true);
    assert.equal(sameOrigin({ origin: 'https://evil.example', req: req('room.example') }), false);
    assert.equal(sameOrigin({ origin: 'not a url', req: req('room.example') }), false);
  });
});

describe('request handler', () => {
  it('serves files and fixed extras without blocking', async (t) => {
    const handler = createRequestHandler({
      root: ROOT,
      rooms: async () => ({ role: 'host' }),
      health: () => ({ ok: true }),
      extras: () => new Map([['/ca.crt', { body: Buffer.from('PEM'), type: 'application/x-x509-ca-cert' }]]),
    });
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
    const base = `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.match(await page.text(), /<title>/);
    const again = await fetch(`${base}/`, { headers: { 'If-None-Match': page.headers.get('etag') || '' } });
    assert.equal(again.status, 304);
    const ca = await fetch(`${base}/ca.crt`);
    assert.equal(ca.headers.get('content-type'), 'application/x-x509-ca-cert');
    assert.equal(await ca.text(), 'PEM');
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    const rooms = await fetch(`${base}/rooms`);
    assert.equal(rooms.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await rooms.json(), { role: 'host' });
  });
});

describe('network', () => {
  it('skips virtual interfaces and prefers real ones', () => {
    const v4 = (address) => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null });
    const nets = /** @type {any} */ ({
      docker0: [v4('172.17.0.1')],
      utun3: [v4('100.64.0.2')],
      bridge100: [v4('192.168.2.1')],
      lo0: [{ ...v4('127.0.0.1'), internal: true }],
      zz9: [v4('10.0.0.9')],
      en0: [v4('192.168.1.10'), { ...v4('169.254.3.3') }],
    });
    assert.deepEqual(lanInterfaces(nets).map((item) => item.address), ['192.168.1.10', '10.0.0.9']);
  });

  it('matches subnets', () => {
    const iface = { name: 'en0', address: '192.168.1.10', netmask: '255.255.255.0' };
    assert.equal(sameSubnet('192.168.1.200', iface), true);
    assert.equal(sameSubnet('192.168.2.1', iface), false);
    assert.equal(pickAddress(['127.0.0.1', '10.1.1.1', '192.168.1.99'], [iface]), '192.168.1.99');
    assert.equal(pickAddress(['169.254.1.1'], [iface]), '');
    assert.equal(pickAddress(['203.0.113.9'], [iface]), '');
    assert.equal(pickAddress(['203.0.113.9'], [iface], parseAllow('any')), '203.0.113.9');
  });

  it('lets in this computer and its network, and nobody else', () => {
    const iface = { name: 'en0', address: '192.168.1.10', netmask: '255.255.255.0' };
    assert.equal(trustedPeer('127.0.0.1', [iface]), true);
    assert.equal(trustedPeer('::1', [iface]), true);
    assert.equal(trustedPeer('::ffff:192.168.1.77', [iface]), true);
    assert.equal(trustedPeer('192.168.2.5', [iface]), false);
    assert.equal(trustedPeer('100.101.102.103', [iface]), false);
    assert.equal(trustedPeer('100.101.102.103', [iface], parseAllow('100.64.0.0/10')), true);
    assert.equal(trustedPeer('8.8.8.8', [iface], parseAllow('any')), true);
    assert.equal(trustedPeer(undefined, [iface]), false);
  });

  it('reads AUDIOLAN_ALLOW strictly', () => {
    assert.deepEqual(parseAllow(''), { any: false, cidrs: [] });
    assert.equal(parseAllow('10.0.0.0/8, 192.168.5.7').cidrs.length, 2);
    assert.throws(() => parseAllow('10.0.0.0/33'), /AUDIOLAN_ALLOW/);
    assert.throws(() => parseAllow('my-vpn'), /AUDIOLAN_ALLOW/);
  });
});
