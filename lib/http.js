'use strict';

const fs = require('fs');
const path = require('path');

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

/**
 * Map a URL path to a file in `root`, or null. Rejects traversal, dotfiles and
 * types the app does not serve.
 * @param {string} root
 * @param {string} pathname
 */
function resolveStatic(root, pathname) {
  if (pathname.includes('\0')) return null;
  let rel = path.posix.normalize(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (rel.split('/').some((part) => part.startsWith('.'))) return null;
  const type = TYPES.get(path.posix.extname(rel));
  if (!type) return null;
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  return { file, type };
}

/**
 * The page's Content Security Policy.
 * @param {string} connect the connect-src sources after 'self'
 */
function cspDirectives(connect) {
  return [
    "default-src 'self'",
    `connect-src 'self'${connect ? ` ${connect}` : ''}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ];
}

/** @param {string | undefined} host */
function contentSecurityPolicy(host) {
  // Older Safari does not count wss://same-host as 'self', so name it.
  return cspDirectives(host && HOST_RE.test(host) ? `wss://${host}` : '').join('; ');
}

/**
 * Accept sockets only from pages this server served. Without this, any site
 * open in a browser could join as a silent listener. A missing Origin is a
 * non-browser client, including another audiolan server bridging in.
 * @param {{ origin?: string, req: { headers: { host?: string | string[] } } }} info
 */
function sameOrigin({ origin, req }) {
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Sent with every response. */
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), speaker-selection=(self), camera=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

/**
 * @param {import('http').ServerResponse} res
 * @param {import('http').IncomingMessage} req
 * @param {unknown} payload
 */
function json(res, req, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** @param {import('http').ServerResponse} res */
function notFound(res) {
  res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/**
 * Files are read asynchronously, so a page load never holds up the signaling
 * that shares this process.
 * @param {{
 *   root: string,
 *   rooms: (req: import('http').IncomingMessage) => unknown,
 *   health: () => unknown,
 *   extras?: () => Map<string, { body: Buffer, type: string }>,
 * }} options `extras` are fixed responses outside `root`, such as the CA certificate
 */
function createRequestHandler({ root, rooms, health, extras = () => new Map() }) {
  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'https://audiolan.invalid').pathname);
    } catch {
      res.writeHead(400, BASE_HEADERS);
      res.end('Bad request');
      return;
    }

    if (pathname === '/rooms') return json(res, req, await rooms(req));
    if (pathname === '/health') return json(res, req, health());
    const extra = extras().get(pathname);
    if (extra) {
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': extra.type,
        'Cache-Control': 'no-cache',
        'Content-Length': extra.body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : extra.body);
      return;
    }

    const asset = resolveStatic(root, pathname);
    if (!asset) return notFound(res);
    let stat;
    try {
      stat = await fs.promises.stat(asset.file);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) return notFound(res);

    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      ...BASE_HEADERS,
      'Content-Type': asset.type,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Content-Security-Policy': contentSecurityPolicy(req.headers.host),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let body;
    try {
      body = await fs.promises.readFile(asset.file);
    } catch {
      return notFound(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

module.exports = { createRequestHandler, resolveStatic, contentSecurityPolicy, cspDirectives, sameOrigin, BASE_HEADERS };
