import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchManager, type MatchScheduler } from '../src/match/matchManager.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import { RoomError } from '../src/rooms/types.js';

test('finished match returns the same human room to a clean lobby and starts a fresh round', () => {
  let now = 0;
  let nextTimer = 1;
  const tasks = new Map<number, () => void>();
  const scheduler: MatchScheduler = {
    set(callback) { const id = nextTimer++; tasks.set(id, callback); return id; },
    clear(handle) { tasks.delete(handle as number); }
  };
  let nextPlayer = 0;
  const rooms = new RoomManager({ makeCode: () => 'ABCD', makePlayerId: () => `p${++nextPlayer}` });
  const matches = new MatchManager(rooms, () => now, () => 1, scheduler);
  rooms.create('first', 'Same'); rooms.join('second', 'ABCD', 'Same');
  const before = rooms.state('ABCD');
  rooms.setReady('first', true); rooms.setReady('second', true);
  assert.equal(matches.returnToLobby('first').reset, false);
  matches.start('first');
  assert.throws(() => matches.returnToLobby('second'), (error: unknown) => error instanceof RoomError && error.code === 'MATCH_NOT_FINISHED');
  matches.placeBomb('first');
  assert.equal(matches.timerCount, 1);
  now = 2000;
  for (const callback of [...tasks.values()]) callback();
  assert.equal(rooms.state('ABCD').status, 'finished');
  assert.equal(matches.snapshot('ABCD').status, 'finished');
  const reset = matches.returnToLobby('second');
  assert.equal(reset.reset, true);
  assert.equal(reset.state.code, before.code);
  assert.equal(reset.state.hostPlayerId, before.hostPlayerId);
  assert.deepEqual(reset.state.players.map(player => player.id), before.players.map(player => player.id));
  assert.ok(reset.state.players.every(player => !player.ready));
  assert.equal(matches.matchCount, 0);
  assert.equal(matches.timerCount, 0);
  assert.equal(tasks.size, 0);
  assert.equal(matches.returnToLobby('first').reset, false);
  rooms.setReady('first', true); rooms.setReady('second', true);
  const restarted = matches.start('first').match;
  assert.equal(restarted.roomCode, 'ABCD');
  assert.equal(restarted.revision, 1);
  assert.deepEqual(restarted.bombs, []);
  assert.deepEqual(restarted.powerUps, []);
  assert.equal(restarted.status, 'playing');
});
