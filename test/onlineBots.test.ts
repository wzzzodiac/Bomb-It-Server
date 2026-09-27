import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchManager, type MatchScheduler } from '../src/match/matchManager.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import { RoomError } from '../src/rooms/types.js';

function code(action: () => unknown): string | undefined {
  try { action(); } catch (error) { if (error instanceof RoomError) return error.code; throw error; }
  return undefined;
}

test('bots are host-managed, server-owned, ready, capped, and never become host', () => {
  let id = 0;
  const rooms = new RoomManager({ makeCode: () => 'ABCD', makePlayerId: () => `p${++id}` });
  rooms.create('host-socket', 'Same');
  rooms.join('guest-socket', 'ABCD', 'Same');
  assert.equal(code(() => rooms.addBot('guest-socket')), 'NOT_HOST');
  const first = rooms.addBot('host-socket').players[2]!;
  assert.equal(first.kind, 'bot');
  assert.equal(first.nickname, 'Bot 1');
  assert.equal(first.id, 'p3');
  assert.equal(first.ready, true);
  assert.equal(rooms.playerIdFor('bot-socket'), undefined);
  assert.equal(JSON.stringify(rooms.state('ABCD')).includes('socket'), false);
  assert.equal(code(() => rooms.removeBot('host-socket', 'p2')), 'BOT_NOT_FOUND');
  assert.equal(code(() => rooms.removeBot('guest-socket', first.id)), 'NOT_HOST');
  rooms.removeBot('host-socket', first.id);
  assert.equal(rooms.addBot('host-socket').players[2]!.nickname, 'Bot 2');
  rooms.addBot('host-socket'); rooms.addBot('host-socket'); rooms.addBot('host-socket');
  assert.equal(rooms.state('ABCD').players.length, 6);
  assert.equal(code(() => rooms.addBot('host-socket')), 'ROOM_FULL');
  assert.equal(code(() => rooms.join('extra', 'ABCD', 'Extra')), 'ROOM_FULL');
  const afterHost = rooms.leave('host-socket').state!;
  assert.equal(afterHost.hostPlayerId, 'p2');
  assert.equal(afterHost.players.find(player => player.host)?.kind, 'human');
  assert.equal(rooms.leave('guest-socket').state, null);
  assert.equal(rooms.roomCount, 0);
});

test('one human and one bot start, move, place authoritative bombs, and clean timers on deletion', () => {
  let now = 0;
  let rng = 0.9;
  let nextTimer = 0;
  const tasks = new Map<number, { at: number; run: () => void }>();
  const scheduler: MatchScheduler = {
    set(run, delayMs) { const id = ++nextTimer; tasks.set(id, { at: now + delayMs, run }); return id; },
    clear(handle) { tasks.delete(handle as number); }
  };
  const advance = (until: number) => {
    for (;;) {
      const due = [...tasks.entries()].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; tasks.delete(due[0]); due[1].run();
    }
    now = until;
  };
  let id = 0;
  const rooms = new RoomManager({ makeCode: () => 'ABCD', makePlayerId: () => `p${++id}` });
  const matches = new MatchManager(rooms, () => now, () => rng, scheduler);
  rooms.create('host-socket', 'Host');
  const botId = rooms.addBot('host-socket').players[1]!.id;
  assert.equal(code(() => matches.start('host-socket')), 'PLAYERS_NOT_READY');
  rooms.setReady('host-socket', true);
  const started = matches.start('host-socket').match;
  assert.equal(started.players.length, 2);
  assert.equal(matches.timerCount, 1);
  advance(1000);
  assert.ok(matches.snapshot('ABCD').revision > 1, 'bot moved using normal match revision updates');
  rng = 0.1;
  advance(3300);
  const snapshot = matches.snapshot('ABCD');
  const botBomb = snapshot.bombs.find(bomb => bomb.ownerId === botId);
  assert.ok(botBomb, 'bot placed a normal authoritative bomb');
  assert.ok(botBomb.explodeAt > now);
  assert.equal(botBomb.range, snapshot.players.find(player => player.id === botId)!.fireRange);
  assert.equal(code(() => rooms.addBot('host-socket')), 'ROOM_NOT_JOINABLE');
  rooms.leave('host-socket');
  matches.closeRoom('ABCD');
  assert.equal(matches.matchCount, 0);
  assert.equal(matches.timerCount, 0);
  assert.equal(tasks.size, 0);
});

test('bot winner resets to same room with bot ready, human unready, and no stale timers', () => {
  let now = 0;
  let nextTimer = 0;
  const tasks = new Map<number, { delay: number; run: () => void }>();
  const scheduler: MatchScheduler = {
    set(run, delay) { const id = ++nextTimer; tasks.set(id, { delay, run }); return id; },
    clear(handle) { tasks.delete(handle as number); }
  };
  let id = 0;
  const rooms = new RoomManager({ makeCode: () => 'ABCD', makePlayerId: () => `p${++id}` });
  const matches = new MatchManager(rooms, () => now, () => 0.9, scheduler);
  rooms.create('human', 'Same');
  const bot = rooms.addBot('human').players[1]!;
  rooms.setReady('human', true);
  const first = matches.start('human').match;
  assert.equal(matches.timerCount, 1);
  matches.placeBomb('human');
  assert.equal(matches.timerCount, 2);
  now = 2000;
  const fuse = [...tasks.values()].find(task => task.delay === 2000);
  assert.ok(fuse);
  fuse.run();
  assert.equal(matches.snapshot('ABCD').status, 'finished');
  assert.equal(matches.snapshot('ABCD').players.find(player => player.id === bot.id)?.alive, true);
  assert.equal(matches.timerCount, 0);
  assert.equal(tasks.size, 0);
  const reset = matches.returnToLobby('human');
  assert.equal(reset.reset, true);
  assert.equal(reset.state.code, first.roomCode);
  assert.equal(reset.state.players[0]?.id, first.players[0]?.id);
  assert.equal(reset.state.players[0]?.ready, false);
  assert.equal(reset.state.players[1]?.id, bot.id);
  assert.equal(reset.state.players[1]?.ready, true);
  assert.equal(matches.matchCount, 0);
  assert.equal(matches.returnToLobby('human').reset, false);
  rooms.setReady('human', true);
  const second = matches.start('human').match;
  assert.equal(second.revision, 1);
  assert.deepEqual(second.bombs, []);
  assert.deepEqual(second.powerUps, []);
  matches.dispose();
  assert.equal(tasks.size, 0);
});
