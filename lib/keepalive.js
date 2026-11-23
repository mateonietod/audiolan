'use strict';

/**
 * Ping every socket on a timer and drop the ones that stopped answering, so a
 * phone that vanished without closing is noticed (and its grace period starts).
 * @param {import('ws').WebSocketServer} wss
 * @param {number} [every]
 * @returns {() => void} stops the timer
 */
function keepAlive(wss, every = 15000) {
  /** @type {WeakSet<import('ws').WebSocket>} */
  const answered = new WeakSet();
  wss.on('connection', (socket) => {
    answered.add(socket);
    socket.on('pong', () => answered.add(socket));
  });
  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      if (!answered.has(socket)) {
        socket.terminate();
        continue;
      }
      answered.delete(socket);
      socket.ping();
    }
  }, every);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { keepAlive };
