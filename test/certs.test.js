'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { ensureCertificate, permitted } = require('../lib/certs');

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('certificates', () => {
  it('only lets the household CA name local addresses', () => {
    assert.equal(permitted('audiolan.local'), true);
    assert.equal(permitted('localhost'), true);
    assert.equal(permitted('192.168.1.20'), true);
    assert.equal(permitted('10.135.210.122'), true);
    assert.equal(permitted('172.31.0.1'), true);
    assert.equal(permitted('172.32.0.1'), false);
    assert.equal(permitted('203.0.113.9'), false);
    assert.equal(permitted('example.com'), false);
    assert.equal(permitted('notlocal'), false);
  });

  it('keeps one CA and signs a new server certificate when the addresses change', async (t) => {
    if (!hasOpenssl()) {
      t.skip('openssl is not installed');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolan-certs-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const quiet = t.mock.method(console, 'warn', () => {});
    const first = await ensureCertificate(dir, ['localhost', 'audiolan.local', '127.0.0.1', '192.168.1.20', '203.0.113.9'], { tools: ['openssl'] });
    assert.equal(first.via, 'household CA');
    assert.ok(first.ca);
    const ca = new X509Certificate(first.ca.pem);
    const leaf = new X509Certificate(first.cert);
    assert.equal(ca.ca, true);
    assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
    assert.match(leaf.subjectAltName || '', /IP Address:192\.168\.1\.20/);
    // A public address is left out rather than breaking the name constraints.
    assert.doesNotMatch(leaf.subjectAltName || '', /203\.0\.113\.9/);
    assert.equal(quiet.mock.callCount(), 1);
    const constraints = execFileSync('openssl', ['x509', '-in', path.join(dir, 'ca.pem'), '-noout', '-ext', 'nameConstraints'], { encoding: 'utf8' });
    assert.match(constraints, /critical/);
    assert.match(constraints, /DNS:local\b/);

    const same = await ensureCertificate(dir, ['127.0.0.1', '192.168.1.20', 'audiolan.local', 'localhost', '203.0.113.9'], { tools: ['openssl'] });
    assert.equal(same.fingerprint, first.fingerprint);

    const moved = await ensureCertificate(dir, ['localhost', 'audiolan.local', '127.0.0.1', '192.168.1.33'], { tools: ['openssl'] });
    assert.notEqual(moved.fingerprint, first.fingerprint);
    assert.equal(moved.ca?.fingerprint, first.ca.fingerprint);
    assert.ok(new X509Certificate(moved.cert).checkIssued(ca));
    assert.equal(fs.statSync(path.join(dir, 'ca-key.pem')).mode & 0o077, 0);
  });
});
