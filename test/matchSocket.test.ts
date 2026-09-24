import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { MatchState } from '../src/match/types.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/socket/events.js';

test('two clients receive identical authoritative arena, movement and cleanup snapshots', async () => {
  let now = 1000;
  const app = createApp(readConfig({}), { now: () => now, random: () => 0 });
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `http://127.0.0.1:${address.port}`;
  const a = connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], reconnection: false });
  const b = connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], reconnection: false });
  try {
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const created = await a.timeout(1000).emitWithAck('room:create', { nickname: 'Alice' });
    if (!created.ok) throw new Error(created.error.message);
    const code = created.state.code;
    assert.equal((await b.timeout(1000).emitWithAck('room:join', { code, nickname: 'Bob' })).ok, true);

    const early = await a.timeout(1000).emitWithAck('room:start-match');
    assert.equal(early.ok, false);
    if (early.ok) throw new Error('Expected unready rejection');
    assert.equal(early.error.code, 'PLAYERS_NOT_READY');
    assert.equal((await a.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    assert.equal((await b.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    const noHost = await b.timeout(1000).emitWithAck('room:start-match');
    assert.equal(noHost.ok, false);
    if (noHost.ok) throw new Error('Expected host rejection');
    assert.equal(noHost.error.code, 'NOT_HOST');

    const initialA = once(a, 'match:state');
    const initialB = once(b, 'match:state');
    const started = await a.timeout(1000).emitWithAck('room:start-match');
    if (!started.ok) throw new Error(started.error.message);
    const [stateA] = await initialA as [MatchState];
    const [stateB] = await initialB as [MatchState];
    assert.deepEqual(stateA, stateB);
    assert.deepEqual(started.state, stateA);
    assert.deepEqual([stateA.arena.cols, stateA.arena.rows], [17, 13]);
    assert.equal(stateA.arena.tiles.length, 13);
    assert.equal(stateA.arena.tiles[0]!.length, 17);
    assert.deepEqual(stateA.players.map(player => player.position), [{ x: 1, y: 1 }, { x: 15, y: 11 }]);
    assert.equal(JSON.stringify(stateA).includes('socketId'), false);

    const changedA = once(a, 'match:state');
    const changedB = once(b, 'match:state');
    assert.deepEqual(await a.timeout(1000).emitWithAck('player:input', { direction: 'right' }), { ok: true, moved: true, revision: 2 });
    const [movedA] = await changedA as [MatchState];
    const [movedB] = await changedB as [MatchState];
    assert.deepEqual(movedA, movedB);
    assert.deepEqual(movedA.players.map(player => player.position), [{ x: 2, y: 1 }, { x: 15, y: 11 }]);

    assert.deepEqual(await a.timeout(1000).emitWithAck('player:input', { direction: 'right' }), { ok: true, moved: false, reason: 'blocked' });
    assert.deepEqual(await a.timeout(1000).emitWithAck('player:input', { direction: 'down' }), { ok: true, moved: false, reason: 'blocked' });
    assert.deepEqual(await a.timeout(1000).emitWithAck('player:input', { direction: 'left' }), { ok: true, moved: false, reason: 'cooldown' });
    const malformed = await a.timeout(1000).emitWithAck('player:input', { direction: 'left', x: 99 });
    assert.equal(malformed.ok, false);
    if (malformed.ok) throw new Error('Expected malformed input rejection');
    assert.equal(malformed.error.code, 'INVALID_PAYLOAD');
    assert.equal(a.connected, true);
    assert.equal(app.matches.snapshot(code).revision, 2);

    now += 135;
    const updated = once(b, 'match:state');
    assert.equal((await a.timeout(1000).emitWithAck('player:input', { direction: 'left' })).moved, true);
    assert.equal(((await updated) as [MatchState])[0].revision, 3);

    const departure = once(a, 'match:state');
    assert.deepEqual(await b.timeout(1000).emitWithAck('room:leave'), { ok: true });
    const [remaining] = await departure as [MatchState];
    assert.equal(remaining.players.length, 1);
    assert.equal(remaining.revision, 4);
    assert.deepEqual(await a.timeout(1000).emitWithAck('room:leave'), { ok: true });
    assert.equal(app.matches.matchCount, 0);
    assert.equal(app.rooms.roomCount, 0);
  } finally {
    a.disconnect();
    b.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});

test('disconnect during a match updates remaining client and frees the final match', async () => {
  const app = createApp(readConfig({}), { random: () => 1 });
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `http://127.0.0.1:${address.port}`;
  const a = connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], reconnection: false });
  const b = connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], reconnection: false });
  try {
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    const created = await a.timeout(1000).emitWithAck('room:create', { nickname: 'Alice' });
    if (!created.ok) throw new Error(created.error.message);
    const code = created.state.code;
    assert.equal((await b.timeout(1000).emitWithAck('room:join', { code, nickname: 'Bob' })).ok, true);
    assert.equal((await a.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    assert.equal((await b.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    assert.equal((await a.timeout(1000).emitWithAck('room:start-match')).ok, true);
    const changed = once(a, 'match:state');
    const serverB = app.io.sockets.sockets.get(b.id!);
    if (!serverB) throw new Error('Expected server socket');
    const left = once(serverB, 'disconnect');
    b.disconnect();
    await left;
    const [state] = await changed as [MatchState];
    assert.equal(state.revision, 2);
    assert.equal(state.players.length, 1);
    assert.equal(app.matches.matchCount, 1);
    const serverA = app.io.sockets.sockets.get(a.id!);
    if (!serverA) throw new Error('Expected server socket');
    const finalLeave = once(serverA, 'disconnect');
    a.disconnect();
    await finalLeave;
    assert.equal(app.matches.matchCount, 0);
    assert.equal(app.rooms.roomCount, 0);
  } finally {
    a.disconnect();
    b.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});

test('malformed movement counts as invalid strikes, then disconnects', async () => {
  const app = createApp({ ...readConfig({}), maxInvalidRequests: 2 });
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const socket = connect<ServerToClientEvents, ClientToServerEvents>(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'], reconnection: false
  });
  try {
    await once(socket, 'connect');
    const first = await socket.timeout(1000).emitWithAck('player:input', { direction: 'diagonal' });
    assert.equal(first.ok, false);
    if (first.ok) throw new Error('Expected invalid movement');
    assert.equal(first.error.code, 'INVALID_PAYLOAD');
    const disconnected = once(socket, 'disconnect');
    socket.emit('player:input', { direction: 'up', x: 99 }, () => {});
    await disconnected;
    assert.equal(app.guard.activeSocketCount, 0);
  } finally {
    socket.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});
