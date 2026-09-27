import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { MatchScheduler } from '../src/match/matchManager.js';
import type { MatchExplosion, MatchResult, MatchState } from '../src/match/types.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/socket/events.js';

test('two sockets share bomb, explosion, crate/power-up mutation, death and result authority', async () => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const scheduler: MatchScheduler = {
    set: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clear: handle => { timers.delete(handle as number); }
  };
  let arenaRolls = 0;
  let started = false;
  const powerRolls = [0, 0];
  const random = () => started ? (powerRolls.shift() ?? 1) : (++arenaRolls === 1 ? 0 : 1);
  const app = createApp(readConfig({}), { now: () => now, random, scheduler });
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `http://127.0.0.1:${address.port}`;
  const a = connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], reconnection: false });
  const b = connect<ServerToClientEvents, ClientToServerEvents>(url, { transports: ['websocket'], reconnection: false });
  const statesA: MatchState[] = []; const statesB: MatchState[] = [];
  const explosionsA: MatchExplosion[] = []; const explosionsB: MatchExplosion[] = [];
  const resultsA: MatchResult[] = []; const resultsB: MatchResult[] = [];
  a.on('match:state', state => statesA.push(state)); b.on('match:state', state => statesB.push(state));
  a.on('match:explosion', event => explosionsA.push(event)); b.on('match:explosion', event => explosionsB.push(event));
  a.on('match:result', result => resultsA.push(result)); b.on('match:result', result => resultsB.push(result));
  try {
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const created = await a.timeout(1000).emitWithAck('room:create', { nickname: 'Same' });
    if (!created.ok) throw new Error(created.error.message);
    const joined = await b.timeout(1000).emitWithAck('room:join', { code: created.state.code, nickname: 'Same' });
    if (!joined.ok) throw new Error(joined.error.message);
    assert.notEqual(created.selfPlayerId, joined.selfPlayerId);
    assert.equal((await a.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    assert.equal((await b.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    const beginA = once(a, 'match:started'); const beginB = once(b, 'match:started');
    const start = await a.timeout(1000).emitWithAck('room:start-match');
    if (!start.ok) throw new Error(start.error.message);
    started = true;
    assert.deepEqual((await beginA)[0], (await beginB)[0]);
    assert.equal(start.state.bombs.length, 0);
    assert.equal(start.state.powerUps.length, 0);

    const bombA = once(a, 'match:state'); const bombB = once(b, 'match:state');
    assert.deepEqual(await a.timeout(1000).emitWithAck('player:place-bomb', {}), { ok: true, placed: true, revision: 2 });
    assert.deepEqual((await bombA)[0], (await bombB)[0]);
    assert.equal(statesA[0]?.bombs[0]?.ownerId, created.selfPlayerId);
    assert.deepEqual(statesA[0]?.bombs[0]?.position, { x: 1, y: 1 });
    assert.equal('socketId' in (statesA[0]?.bombs[0] ?? {}), false);
    const rejected = await a.timeout(1000).emitWithAck('player:place-bomb', {});
    assert.deepEqual(rejected, { ok: true, placed: false, reason: 'capacity' });
    const malformed = await a.timeout(1000).emitWithAck('player:place-bomb', { ownerId: joined.selfPlayerId, x: 8 });
    assert.equal(malformed.ok, false);
    if (malformed.ok) throw new Error('Expected invalid payload');
    assert.equal(malformed.error.code, 'INVALID_PAYLOAD');
    assert.equal(a.connected, true);
    assert.equal(statesA.length, 1);

    const movedA = once(a, 'match:state'); const movedB = once(b, 'match:state');
    assert.equal((await a.timeout(1000).emitWithAck('player:input', { direction: 'down' })).moved, true);
    assert.deepEqual((await movedA)[0], (await movedB)[0]);
    assert.deepEqual(statesA[1]?.players[0]?.position, { x: 1, y: 2 });
    const explosionA = once(a, 'match:explosion'); const explosionB = once(b, 'match:explosion');
    const finishedA = once(a, 'match:result'); const finishedB = once(b, 'match:result');
    now = 2000;
    const fuse = [...timers.values()][0];
    if (!fuse) throw new Error('Expected authoritative fuse');
    fuse();
    assert.deepEqual((await explosionA)[0], (await explosionB)[0]);
    assert.deepEqual((await finishedA)[0], (await finishedB)[0]);
    assert.deepEqual(explosionsA, explosionsB);
    assert.deepEqual(resultsA, resultsB);
    assert.deepEqual(statesA, statesB);
    assert.deepEqual(statesA.map(state => state.revision), [2, 3, 4]);
    assert.ok(statesA.every(state => !('arena' in state)));
    assert.deepEqual(explosionsA[0]?.changes, [{ x: 3, y: 1, tile: 'floor' }]);
    assert.deepEqual(statesA[2]?.powerUps, [{ position: { x: 3, y: 1 }, kind: 'bomb' }]);
    assert.equal(statesA[2]?.players[0]?.alive, false);
    assert.equal(statesA[2]?.status, 'finished');
    assert.equal(resultsA[0]?.kind, 'winner');
    assert.equal(resultsA[0]?.winnerId, joined.selfPlayerId);
    assert.equal(app.rooms.state(created.state.code).status, 'finished');
    assert.equal(timers.size, 0);
    assert.equal(app.matches.timerCount, 0);
    assert.equal((await b.timeout(1000).emitWithAck('player:place-bomb', {})).placed, false);
    assert.equal((await b.timeout(1000).emitWithAck('player:input', { direction: 'left' })).moved, false);
    await a.timeout(1000).emitWithAck('room:leave');
    await b.timeout(1000).emitWithAck('room:leave');
    assert.equal(app.matches.matchCount, 0);
  } finally {
    a.disconnect(); b.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});
