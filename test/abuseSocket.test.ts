import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { readConfig, type ServerConfig } from '../src/config.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/socket/events.js';

async function start(config: ServerConfig) {
  const app = createApp(config);
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { ...app, url: `http://127.0.0.1:${address.port}` };
}

function client(url: string) {
  return connect<ServerToClientEvents, ClientToServerEvents>(url, {
    transports: ['websocket'], reconnection: false, autoConnect: false
  });
}

async function connectClient(socket: ReturnType<typeof client>): Promise<void> {
  const connected = once(socket, 'connect');
  socket.connect();
  await connected;
}

test('connection cap rejects excess sockets, then frees the peer slot on disconnect', async () => {
  const app = await start({ ...readConfig({}), maxConnectionsPerIp: 2 });
  const first = client(app.url), second = client(app.url), rejected = client(app.url), replacement = client(app.url);
  try {
    await connectClient(first);
    await connectClient(second);
    assert.equal(app.guard.activeSocketCount, 2);
    const refusal = once(rejected, 'connect_error');
    rejected.connect();
    const [error] = await refusal;
    assert.equal((error as Error).message, 'Too many connections.');
    assert.equal(app.guard.activeSocketCount, 2);
    rejected.disconnect();

    const serverSocket = app.io.sockets.sockets.get(first.id!);
    if (!serverSocket) throw new Error('Expected connected server socket');
    const left = once(serverSocket, 'disconnect');
    first.disconnect();
    await left;
    await connectClient(replacement);
    assert.equal(app.guard.activeSocketCount, 2);
  } finally {
    [first, second, rejected, replacement].forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
  assert.equal(app.guard.activeSocketCount, 0);
  assert.equal(app.guard.trackedAddressCount, 0);
});

test('creation and general event limits reject actions without changing room state', async () => {
  const app = await start({ ...readConfig({}), maxEventsPerWindow: 3, maxRoomCreatesPerWindow: 1 });
  const socket = client(app.url);
  try {
    await connectClient(socket);
    const created = await socket.timeout(1000).emitWithAck('room:create', { nickname: 'Alice' });
    assert.equal(created.ok, true);
    assert.deepEqual(await socket.timeout(1000).emitWithAck('room:leave'), { ok: true });
    assert.equal(app.rooms.roomCount, 0);

    const createBlocked = await socket.timeout(1000).emitWithAck('room:create', { nickname: 'Alice' });
    assert.equal(createBlocked.ok, false);
    if (createBlocked.ok) throw new Error('Expected creation limit');
    assert.equal(createBlocked.error.code, 'RATE_LIMITED');
    assert.equal(app.rooms.roomCount, 0);

    const eventBlocked = await socket.timeout(1000).emitWithAck('room:join', { code: 'ABCD', nickname: 'Alice' });
    assert.equal(eventBlocked.ok, false);
    if (eventBlocked.ok) throw new Error('Expected event limit');
    assert.equal(eventBlocked.error.code, 'RATE_LIMITED');
    assert.equal(app.rooms.roomCount, 0);
  } finally {
    socket.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});

test('normal room errors do not add strikes; repeated invalid payloads disconnect', async () => {
  const app = await start({ ...readConfig({}), maxInvalidRequests: 2 });
  const socket = client(app.url);
  try {
    await connectClient(socket);
    for (let index = 0; index < 3; index++) {
      const missing = await socket.timeout(1000).emitWithAck('room:join', { code: 'ABCD', nickname: 'Alice' });
      assert.equal(missing.ok, false);
      if (missing.ok) throw new Error('Expected missing room');
      assert.equal(missing.error.code, 'ROOM_NOT_FOUND');
    }
    assert.equal(socket.connected, true);
    const invalid = await socket.timeout(1000).emitWithAck('player:set-ready', { ready: 'yes' });
    assert.equal(invalid.ok, false);
    if (invalid.ok) throw new Error('Expected invalid ready value');
    assert.equal(invalid.error.code, 'INVALID_READY');
    assert.equal(socket.connected, true);

    const finalError = once(socket, 'room:error');
    const disconnected = once(socket, 'disconnect');
    socket.emit('player:set-ready', { ready: 'yes' }, () => {});
    const [error] = await finalError;
    assert.equal((error as { code: string }).code, 'INVALID_READY');
    await disconnected;
    assert.equal(app.guard.activeSocketCount, 0);
    assert.equal(app.guard.trackedAddressCount, 0);
  } finally {
    socket.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});

test('Engine.IO applies the configured message size limit', async () => {
  const app = await start({ ...readConfig({}), maxPayloadBytes: 512 });
  const socket = client(app.url);
  try {
    assert.equal(app.io.engine.opts.maxHttpBufferSize, 512);
    await connectClient(socket);
    const disconnected = once(socket, 'disconnect');
    socket.emit('room:create', { nickname: 'x'.repeat(600) }, () => {});
    await disconnected;
    assert.equal(app.rooms.roomCount, 0);
  } finally {
    socket.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});
