import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/socket/events.js';

test('health and the room connection lifecycle work through Socket.IO', async () => {
  const { httpServer, io, rooms } = createApp(readConfig({}));
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [
    connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], extraHeaders: { Origin: 'http://localhost:5173' } }),
    connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], extraHeaders: { Origin: 'http://localhost:5173' } })
  ];
  try {
    await Promise.all(clients.map(client => once(client, 'connect')));
    const denied = connect(url, {
      transports: ['websocket'], reconnection: false, timeout: 500,
      extraHeaders: { Origin: 'https://unapproved.example' }
    });
    await once(denied, 'connect_error');
    denied.disconnect();
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'bomb-it-server' });

    const created = await clients[0]!.timeout(1000).emitWithAck('room:create', { nickname: 'Alice' });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error(created.error.message);
    const code = created.state.code;
    const invalid = await clients[1]!.timeout(1000).emitWithAck('room:create', { nickname: 'Bob', id: 'chosen-by-client' });
    assert.equal(invalid.ok, false);
    if (invalid.ok) throw new Error('Expected invalid payload');
    assert.equal(invalid.error.code, 'INVALID_PAYLOAD');
    const joined = await clients[1]!.timeout(1000).emitWithAck('room:join', { code, nickname: 'Bob' });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error(joined.error.message);
    assert.equal(joined.state.players.length, 2);

    const ready = await clients[1]!.timeout(1000).emitWithAck('player:set-ready', { ready: true });
    assert.equal(ready.ok, true);
    if (!ready.ok) throw new Error(ready.error.message);
    assert.deepEqual(ready.state.players.map(player => player.ready), [false, true]);

    assert.deepEqual(await clients[0]!.timeout(1000).emitWithAck('room:leave'), { ok: true });
    assert.equal(rooms.state(code).players.length, 1);
    assert.equal(rooms.state(code).players[0]?.host, true);
    const serverSocket = io.sockets.sockets.get(clients[1]!.id!);
    if (!serverSocket) throw new Error('Expected connected server socket');
    const disconnected = once(serverSocket, 'disconnect');
    clients[1]!.disconnect();
    await disconnected;
    assert.equal(rooms.roomCount, 0);
  } finally {
    clients.forEach(client => client.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});
