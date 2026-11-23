'use strict';

const { execFileSync } = require('child_process');
const { X509Certificate, randomBytes } = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const COMMON_NAME = 'audiolan.local';

/**
 * Run a tool if it is installed. A missing binary is silent; a failing one warns.
 * @param {string} bin
 * @param {string[]} args
 */
function run(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      console.warn(`${bin} failed (${/** @type {Error} */ (error).message}). Falling back.`);
    }
    return false;
  }
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** A sha256 certificate fingerprint as hex, no colons. Anything else is not pinned. @param {unknown} fp */
function isFingerprint(fp) {
  return FINGERPRINT.test(String(fp || '').toLowerCase());
}

/** @param {string | Buffer} pem */
function fingerprintOf(pem) {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

// Bump when the way certificates are made changes, so the next start makes
// a new one even though the names did not change.
const SCHEME = 2;
const CA_DAYS = 3650;
const LEAF_DAYS = 825; // The longest Apple accepts for a server certificate.

// What the household CA may vouch for. A trusted CA without limits could sign
// a certificate for any website. This one can only name local addresses, so
// installing it on a phone does not hand this computer the rest of the web.
const PERMITTED_DNS = ['local', 'localhost'];
const PERMITTED_IP = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];

/** @param {string} ip */
function toInt(ip) {
  return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

/** A name the household CA is allowed to sign. @param {string} name */
function permitted(name) {
  if (net.isIPv4(name)) {
    return PERMITTED_IP.some(([base, mask]) => ((toInt(name) & toInt(mask)) >>> 0) === toInt(base));
  }
  if (net.isIP(name)) return false;
  const host = name.toLowerCase();
  return PERMITTED_DNS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** sha256 as colon-separated hex, the way phones show it. @param {string | Buffer} pem */
function displayFingerprint(pem) {
  return new X509Certificate(pem).fingerprint256;
}

/**
 * Reuse the certificate in `dir` when it covers `names`, or make a new one.
 * mkcert gives a certificate this machine already trusts. Otherwise openssl
 * makes a household CA once and signs a fresh certificate with it whenever
 * the addresses change: a phone that trusts the CA keeps trusting the server.
 * The selfsigned package is the last resort, and every browser warns about it.
 * @param {string} dir
 * @param {string[]} names
 * @param {{ tools?: ('mkcert' | 'openssl' | 'selfsigned')[] }} [options]
 */
async function ensureCertificate(dir, names, { tools = ['mkcert', 'openssl', 'selfsigned'] } = {}) {
  const files = {
    cert: path.join(dir, 'cert.pem'),
    key: path.join(dir, 'key.pem'),
    ca: path.join(dir, 'ca.pem'),
    caKey: path.join(dir, 'ca-key.pem'),
  };
  const metaFile = path.join(dir, 'meta.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fingerprint = names.slice().sort().join('|');
  let meta = readJson(metaFile);
  const ready = meta
    // An mkcert certificate is already trusted; a new scheme does not touch it.
    && (meta.scheme === SCHEME || meta.via === 'mkcert')
    && meta.fingerprint === fingerprint
    && fs.existsSync(files.cert)
    && fs.existsSync(files.key)
    && (meta.via !== 'household CA' || fs.existsSync(files.ca));
  if (!ready) {
    const via = await writeCertificate(names, dir, files, tools);
    meta = { scheme: SCHEME, fingerprint, via, names };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    try { fs.chmodSync(files.key, 0o600); } catch { /* windows */ }
  }
  const cert = fs.readFileSync(files.cert);
  const usesCa = meta && meta.via === 'household CA';
  const caPem = usesCa ? fs.readFileSync(files.ca) : null;
  return {
    cert,
    key: fs.readFileSync(files.key),
    via: (meta && meta.via) || 'unknown',
    fingerprint: fingerprintOf(cert),
    ca: caPem ? { pem: caPem, fingerprint: displayFingerprint(caPem) } : null,
  };
}

/**
 * @param {string[]} names
 * @param {string} dir
 * @param {{ cert: string, key: string, ca: string, caKey: string }} files
 * @param {string[]} tools
 */
async function writeCertificate(names, dir, files, tools) {
  if (tools.includes('mkcert') && run('mkcert', ['-cert-file', files.cert, '-key-file', files.key, ...names])) {
    return 'mkcert';
  }
  if (tools.includes('openssl')) {
    const via = withScratch(dir, (scratch) => signWithHouseholdCa(names, files, scratch));
    if (via) return via;
  }
  if (!tools.includes('selfsigned')) throw new Error('No certificate tool is available.');
  const pems = await generateSelfSigned(names);
  fs.writeFileSync(files.cert, pems.cert);
  fs.writeFileSync(files.key, pems.key);
  return 'selfsigned';
}

/**
 * Run `work` with a private temporary folder inside `dir`, then remove it.
 * @template T
 * @param {string} dir
 * @param {(scratch: string) => T} work
 */
function withScratch(dir, work) {
  const scratch = fs.mkdtempSync(path.join(dir, 'tmp-'));
  try {
    return work(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The household CA in `files.ca`, made now if it is missing, broken, or would
 * expire before a new server certificate does.
 * @param {{ ca: string, caKey: string }} files
 * @param {string} scratch
 */
function ensureHouseholdCa(files, scratch) {
  if (fs.existsSync(files.ca) && fs.existsSync(files.caKey)) {
    try {
      const ca = new X509Certificate(fs.readFileSync(files.ca));
      const lastDay = Date.parse(ca.validTo);
      if (ca.ca && lastDay - Date.now() > (LEAF_DAYS + 1) * 86400000) return true;
    } catch { /* make a new one */ }
    console.warn('  the household CA in .certs/ is unusable. making a new one; phones must trust it again.');
  }
  const config = path.join(scratch, 'ca.cnf');
  fs.writeFileSync(config, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = ca_ext',
    'prompt = no',
    '[dn]',
    `CN = audiolan household CA (${os.hostname().replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40) || 'this computer'})`,
    '[ca_ext]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    'nameConstraints = critical,@permitted',
    '[permitted]',
    ...PERMITTED_DNS.map((name, index) => `permitted;DNS.${index + 1} = ${name}`),
    ...PERMITTED_IP.map(([base, mask], index) => `permitted;IP.${index + 1} = ${base}/${mask}`),
    '',
  ].join('\n'));
  const made = run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', String(CA_DAYS), '-nodes',
    '-keyout', files.caKey,
    '-out', files.ca,
    '-config', config,
  ]);
  try { fs.chmodSync(files.caKey, 0o600); } catch { /* windows */ }
  return made;
}

/**
 * Sign a server certificate for `names` with the household CA. Names the CA
 * may not vouch for (a public address) are left out. Falls back to a plain
 * self-signed openssl certificate if the CA cannot be made.
 * @param {string[]} names
 * @param {{ cert: string, key: string, ca: string, caKey: string }} files
 * @param {string} scratch
 * @returns {string | null} how the certificate was made, or null when openssl is unusable
 */
function signWithHouseholdCa(names, files, scratch) {
  const allowed = names.filter(permitted);
  for (const name of names) {
    if (!allowed.includes(name)) console.warn(`  ${name} is not a local address. the certificate leaves it out.`);
  }
  if (allowed.length && ensureHouseholdCa(files, scratch)) {
    const config = path.join(scratch, 'leaf.cnf');
    const csr = path.join(scratch, 'leaf.csr');
    const san = allowed.map((name) => (net.isIP(name) ? `IP:${name}` : `DNS:${name}`)).join(',');
    fs.writeFileSync(config, [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      '[dn]',
      `CN = ${COMMON_NAME}`,
      '[leaf_ext]',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${san}`,
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid',
      '',
    ].join('\n'));
    const requested = run('openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', files.key, '-out', csr, '-config', config,
    ]);
    const signed = requested && run('openssl', [
      'x509', '-req', '-in', csr, '-CA', files.ca, '-CAkey', files.caKey,
      '-set_serial', `0x${randomBytes(16).toString('hex').replace(/^[89a-f]/, '7')}`,
      '-days', String(LEAF_DAYS), '-sha256',
      '-extfile', config, '-extensions', 'leaf_ext',
      '-out', files.cert,
    ]);
    if (signed && issuedBy(files.cert, files.ca)) return 'household CA';
  }
  const san = names.map((name) => (net.isIP(name) ? `IP:${name}` : `DNS:${name}`)).join(',');
  const plain = run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', String(LEAF_DAYS), '-nodes',
    '-keyout', files.key,
    '-out', files.cert,
    '-subj', `/CN=${COMMON_NAME}`,
    '-addext', `subjectAltName=${san}`,
  ]);
  return plain ? 'openssl' : null;
}

/** @param {string} certFile @param {string} caFile */
function issuedBy(certFile, caFile) {
  try {
    const cert = new X509Certificate(fs.readFileSync(certFile));
    const ca = new X509Certificate(fs.readFileSync(caFile));
    return cert.checkIssued(ca) && cert.verify(ca.publicKey);
  } catch {
    return false;
  }
}

/** @param {string[]} names */
async function generateSelfSigned(names) {
  /** @type {any} */
  const loaded = await import('selfsigned');
  const api = loaded.generate ? loaded : (loaded.default || {});
  if (typeof api.generate !== 'function') {
    throw new Error('The selfsigned package did not export generate().');
  }
  const altNames = names.map((name) => (
    net.isIP(name) ? { type: 7, ip: name } : { type: 2, value: name }
  ));
  const pems = await api.generate(
    [{ name: 'commonName', value: COMMON_NAME }],
    {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  const key = pems.private || pems.key;
  if (!key || !pems.cert) throw new Error('selfsigned returned an empty certificate.');
  return { key, cert: pems.cert };
}

module.exports = { ensureCertificate, isFingerprint, permitted };
