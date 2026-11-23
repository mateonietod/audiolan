'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it, mock } = require('node:test');
const { keepAlive } = require('../lib/keepalive');

class FakeSocket extends EventEmitter {
  /** @param {boolean} answers */
  constructor(answers) {
    super();
    this.answers = answers;
    this.pings = 0;
    this.terminated = false;
  }

  ping() {
    this.pings += 1;
    if (this.answers) this.emit('pong');
  }

  terminate() {
    this.terminated = true;
  }
}

describe('keepAlive', () => {
  it('pings every socket and drops the ones that stop answering', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const wss = Object.assign(new EventEmitter(), { clients: new Set() });
      const stop = keepAlive(/** @type {any} */ (wss), 1000);
      const alive = new FakeSocket(true);
      const silent = new FakeSocket(false);
      for (const socket of [alive, silent]) {
        wss.clients.add(socket);
        wss.emit('connection', socket);
      }

      mock.timers.tick(1000);
      assert.equal(alive.pings, 1);
      assert.equal(silent.pings, 1);
      assert.equal(silent.terminated, false, 'one missed pong is not enough');

      mock.timers.tick(1000);
      assert.equal(silent.terminated, true);
      assert.equal(alive.terminated, false);

      stop();
      mock.timers.tick(5000);
      assert.equal(alive.pings, 2, 'stopped');
    } finally {
      mock.timers.reset();
    }
  });
});
