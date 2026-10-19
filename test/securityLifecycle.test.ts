import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { Socket as EngineClient } from 'engine.io-client';
import { RoomManager } from '../src/rooms/roomManager.js';
import { AbuseGuard, MAX_CONCURRENT_TRANSPORTS } from '../src/security/abuseGuard.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

test('five idle rooms release their capacity and all memberships', () => {
  let now = 0;
  const rooms = new RoomManager({ now: () => now, lobbyIdleMs: 100 });
  for (let i = 0; i < 5; i++) rooms.create(String(i), 'Player');
  assert.throws(() => rooms.create('extra', 'Extra'));
  now = 100;
  assert.equal(rooms.expire().length, 5);
  assert.equal(rooms.roomCount, 0);
  for (let i = 0; i < 5; i++) assert.equal(rooms.roomCodeFor(String(i)), undefined);
  assert(rooms.create('0', 'Reused'));
});

test('no-op readiness does not renew a reservation; active games are exempt and rematches get a fresh lobby', () => {
  let now = 0;
  const rooms = new RoomManager({ now: () => now, lobbyIdleMs: 100, lobbyMaxMs: 250, finishedIdleMs: 50 });
  rooms.create('a', 'A');
  now = 90; rooms.setReady('a', false);
  now = 100; assert.equal(rooms.expire().length, 1);
  const code = rooms.create('b', 'B').code;
  rooms.addBot('b'); rooms.setReady('b', true); rooms.commitMatchStart('b');
  now += 10000; assert.deepEqual(rooms.expire(), []);
  rooms.finishMatch(code); now += 49; assert.deepEqual(rooms.expire(), []);
  rooms.returnToLobby('b'); now += 51; assert.deepEqual(rooms.expire(), []);
  for (let i = 0; i < 3; i++) { now += 90; rooms.setReady('b', i % 2 === 0); }
  assert.equal(rooms.expire().length, 1, 'valid activity cannot exceed the lobby hard lifetime');
});

test('creation and opening budgets survive reconnects and expire in bounded windows', () => {
  let now = 0;
  const guard = new AbuseGuard(readConfig({}), () => now);
  for (let i = 0; i < 6; i++) {
    assert(guard.admit(String(i), 'peer'));
    assert(guard.allowEvent(String(i), 'room:create'));
    guard.release(String(i));
  }
  assert(guard.admit('next', 'peer'));
  assert.equal(guard.allowEvent('next', 'room:create'), false);
  now = 60000; assert(guard.allowEvent('next', 'room:create'));
  for (let i = 0; i < 80; i++) assert(guard.allowConnection('peer', 0));
  assert.equal(guard.allowConnection('peer', 0), false);
  assert.equal(guard.allowConnection('other', MAX_CONCURRENT_TRANSPORTS), false);
  now += 60000; assert(guard.allowConnection('peer', 0));
});

async function fixture(t: TestContext, options: Parameters<typeof createApp>[1] = {}) {
  const app = createApp(readConfig({}), options);
  app.httpServer.listen(0, '127.0.0.1'); await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  assert(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => app.io.close(() => resolve())));
  async function client() {
    const socket = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], autoConnect: false, reconnection: false });
    const opened = once(socket, 'connect'); socket.connect(); await opened;
    t.after(() => socket.disconnect());
    return socket;
  }
  return { app, client, url: `http://127.0.0.1:${address.port}` };
}

test('unjoined namespace and raw Engine.IO transports expire; leaving rearms the deadline', async t => {
  let now = 0;
  const { app, client, url } = await fixture(t, { now: () => now, joinTimeoutMs: 100 });
  const raw = new EngineClient(url, { path: '/socket.io', transports: ['websocket'] });
  t.after(() => raw.close()); await once(raw, 'open');
  const idle = await client();
  const closed = [once(raw, 'close'), once(idle, 'disconnect')];
  idle.emit('unrecognized-event'); now = 100; app.sweep(); await Promise.all(closed);
  const member = await client();
  assert((await member.timeout(1000).emitWithAck('room:create', { nickname: 'A' })).ok);
  now += 200; app.sweep(); assert(member.connected);
  assert((await member.timeout(1000).emitWithAck('room:leave')).ok);
  now += 99; app.sweep(); assert(member.connected);
  const left = once(member, 'disconnect'); now++; app.sweep(); await left;
  assert.equal(app.guard.activeSocketCount, 0);
});

test('expiry clears room, match and bot/bomb timers without expiring an active game', async t => {
  let now = 0, next = 0;
  const timers = new Map<number, () => void>();
  const { app, client } = await fixture(t, { now: () => now, lifecycle: { lobbyIdleMs: 100, finishedIdleMs: 50 },
    scheduler: { set(fn) { const id = ++next; timers.set(id, fn); return id; }, clear(id) { timers.delete(id as number); } } });
  const host = await client();
  const created = await host.timeout(1000).emitWithAck('room:create', { nickname: 'Host' });
  assert(created.ok); const code = created.state.code;
  assert((await host.timeout(1000).emitWithAck('room:add-bot', {})).ok);
  assert((await host.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok);
  assert((await host.timeout(1000).emitWithAck('room:start-match')).ok);
  assert((await host.timeout(1000).emitWithAck('player:place-bomb', {})).ok);
  assert(app.matches.timerCount > 0);
  now = 10000; app.sweep(); assert.equal(app.rooms.roomCount, 1);
  app.rooms.finishMatch(code);
  const closed = once(host, 'disconnect'); now += 50; app.sweep(); await closed;
  assert.equal(app.rooms.roomCount, 0); assert.equal(app.matches.matchCount, 0);
  assert.equal(app.matches.timerCount, 0); assert.equal(timers.size, 0);
});

test('sustained rate violations close the transport and readiness no-ops do not broadcast', async t => {
  const { app, client } = await fixture(t);
  const host = await client();
  assert((await host.timeout(1000).emitWithAck('room:create', { nickname: 'Host' })).ok);
  let broadcasts = 0; host.on('room:state', () => broadcasts++);
  assert((await host.timeout(1000).emitWithAck('player:set-ready', { ready: false })).ok);
  assert.equal(broadcasts, 0);
  const closed = once(host, 'disconnect');
  for (let i = 0; i < 55; i++) host.emit('player:set-ready', { ready: false }, () => {});
  await closed;
  assert.equal(app.guard.activeSocketCount, 0); assert.equal(app.rooms.roomCount, 0);
});
