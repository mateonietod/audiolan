'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cleanPeople, fetchPeople } = require('../lib/bridge');

describe('people on another room host', () => {
  it('keeps a count and two clean names, and nothing else', () => {
    assert.deepEqual(cleanPeople({ count: 4, names: ['Bob', 'Alice', 'Carol'], extra: 1 }), { count: 4, names: ['Bob', 'Alice'] });
    assert.deepEqual(cleanPeople({ count: 1, names: [`  Bob${'x'.repeat(60)}`] }).names[0].length, 32);
    assert.equal(cleanPeople({ count: -1, names: [] }), null);
    assert.equal(cleanPeople({ count: 1.5 }), null);
    assert.equal(cleanPeople(null), null);
  });

  it('does not ask a host whose fingerprint it cannot pin', async () => {
    assert.equal(await fetchPeople('127.0.0.1:1', 'not a fingerprint'), null);
  });

  it('gives up on a host that does not answer', async () => {
    assert.equal(await fetchPeople('127.0.0.1:1', 'ab'.repeat(32), 300), null);
  });
});
