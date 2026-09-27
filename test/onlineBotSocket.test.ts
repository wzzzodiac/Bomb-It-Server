import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { MatchScheduler } from '../src/match/matchManager.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/socket/events.js';

test('Socket.IO human plus server bot can play, finish, reset, and replay', async () => {
  let now = 0;
  let nextTimer = 0;
  const tasks = new Map<number, { delay: number; run: () => void }>();
  const scheduler: MatchScheduler = {
    set(run, delay) { const id = ++nextTimer; tasks.set(id, { delay, run }); return id; },
    clear(handle) { tasks.delete(handle as number); }
  };
  const app = createApp(readConfig({}), { now: () => now, random: () => 0.9, scheduler });
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const client = connect<ServerToClientEvents, ClientToServerEvents>(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
  try {
    await once(client, 'connect');
    const created = await client.timeout(1000).emitWithAck('room:create', { nickname: 'Human' });
    if (!created.ok) throw new Error(created.error.message);
    const code = created.state.code;
    const added = await client.timeout(1000).emitWithAck('room:add-bot', {});
    if (!added.ok) throw new Error(added.error.message);
    const bot = added.state.players[1]!;
    assert.equal(bot.kind, 'bot');
    assert.equal(bot.ready, true);
    assert.equal('socketId' in bot, false);
    const invalid = await client.timeout(1000).emitWithAck('room:remove-bot', { botId: created.selfPlayerId });
    assert.equal(invalid.ok, false);
    if (invalid.ok) throw new Error('Expected refusal');
    assert.equal(invalid.error.code, 'BOT_NOT_FOUND');
    assert.equal((await client.timeout(1000).emitWithAck('player:set-ready', { ready: true })).ok, true);
    const first = await client.timeout(1000).emitWithAck('room:start-match');
    if (!first.ok) throw new Error(first.error.message);
    assert.equal(first.state.players.length, 2);
    const moved = once(client, 'match:state');
    const botTick = [...tasks.entries()].find(([, task]) => task.delay < 1000);
    assert.ok(botTick);
    now = 350; tasks.delete(botTick[0]); botTick[1].run();
    const state = (await moved)[0];
    assert.ok(state.revision > first.state.revision);
    assert.notDeepEqual(state.players.find(player => player.id === bot.id)?.position, first.state.players.find(player => player.id === bot.id)?.position);
    assert.equal((await client.timeout(1000).emitWithAck('player:place-bomb', {})).placed, true);
    const resultEvent = once(client, 'match:result');
    now = 2350;
    const fuse = [...tasks.values()].find(task => task.delay === 2000);
    assert.ok(fuse);
    fuse.run();
    const result = (await resultEvent)[0];
    assert.equal(result.winnerId, bot.id);
    assert.equal(app.matches.timerCount, 0);
    const resetEvent = once(client, 'room:reset');
    const reset = await client.timeout(1000).emitWithAck('room:return-to-lobby');
    assert.equal(reset.ok, true);
    assert.equal((await resetEvent)[0].code, code);
    if (!reset.ok) throw new Error('Expected reset');
    assert.deepEqual(reset.state.players.map(player => player.ready), [false, true]);
    assert.equal((await client.timeout(1000).emitWithAck('room:return-to-lobby')).ok, true);
    await client.timeout(1000).emitWithAck('player:set-ready', { ready: true });
    const second = await client.timeout(1000).emitWithAck('room:start-match');
    if (!second.ok) throw new Error(second.error.message);
    assert.equal(second.state.revision, 1);
    assert.deepEqual(second.state.bombs, []);
    await client.timeout(1000).emitWithAck('room:leave');
    assert.equal(app.rooms.roomCount, 0);
    assert.equal(app.matches.matchCount, 0);
    assert.equal(tasks.size, 0);
  } finally {
    client.disconnect();
    await new Promise<void>(resolve => app.io.close(() => resolve()));
  }
});
