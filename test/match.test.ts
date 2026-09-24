import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSpawns, createArena, safeSpawnTiles, tileAt } from '../src/game/arena.js';
import { getArenaSizeForPlayerCount } from '../src/game/config.js';
import { MatchManager, MOVE_COOLDOWN_MS } from '../src/match/matchManager.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import { RoomError } from '../src/rooms/types.js';
import { AbuseGuard } from '../src/security/abuseGuard.js';
import { readConfig } from '../src/config.js';

function code(action: () => unknown, expected: RoomError['code']): void {
  assert.throws(action, error => error instanceof RoomError && error.code === expected);
}

function setup(random = () => 1) {
  let now = 1000;
  let nextId = 0;
  const rooms = new RoomManager({ makeCode: () => 'ABCD', makePlayerId: () => `p${++nextId}` });
  const matches = new MatchManager(rooms, () => now, random);
  const room = rooms.create('host', 'Alice');
  rooms.join('guest', room.code, 'Bob');
  return { rooms, matches, code: room.code, advance: (ms: number) => { now += ms; } };
}

test('arena presets, dimensions, spawn order, walls, pillars, crates and safe tiles match Bomb-It', () => {
  for (const [count, cols, rows] of [[2, 17, 13], [3, 21, 17], [4, 21, 17], [5, 25, 19], [6, 25, 19]]) {
    assert.deepEqual(getArenaSizeForPlayerCount(count), { cols, rows });
    const spawns = allocateSpawns(count, cols, rows);
    assert.deepEqual(spawns, [
      { x: 1, y: 1 }, { x: cols - 2, y: rows - 2 }, { x: cols - 2, y: 1 },
      { x: 1, y: rows - 2 }, { x: Math.floor(cols / 2), y: 1 }, { x: Math.floor(cols / 2), y: rows - 2 }
    ].slice(0, count));
    const arena = createArena({ cols, rows, playerCount: count, random: () => 0 });
    assert.equal(arena.length, rows);
    assert.ok(arena.every(row => row.length === cols));
    for (let x = 0; x < cols; x++) {
      assert.equal(tileAt(arena, { x, y: 0 }), 'wall');
      assert.equal(tileAt(arena, { x, y: rows - 1 }), 'wall');
    }
    for (let y = 0; y < rows; y++) {
      assert.equal(tileAt(arena, { x: 0, y }), 'wall');
      assert.equal(tileAt(arena, { x: cols - 1, y }), 'wall');
    }
    assert.equal(tileAt(arena, { x: 2, y: 2 }), 'wall');
    assert.equal(tileAt(arena, { x: 3, y: 3 }), 'crate');
    for (const spawn of spawns) for (const point of safeSpawnTiles(spawn, cols, rows)) {
      assert.equal(tileAt(arena, point), 'floor');
    }
  }
});

test('host start requires two ready players and yields an isolated authoritative snapshot', () => {
  const { rooms, matches, code: roomCode } = setup(() => 0);
  code(() => matches.start('guest'), 'NOT_HOST');
  code(() => matches.start('host'), 'PLAYERS_NOT_READY');
  rooms.setReady('guest', true);
  code(() => matches.start('host'), 'PLAYERS_NOT_READY');
  rooms.setReady('host', true);
  const { room, match } = matches.start('host');
  assert.equal(room.status, 'playing');
  assert.equal(match.revision, 1);
  assert.deepEqual([match.arena.cols, match.arena.rows], [17, 13]);
  assert.equal(match.players.length, 2);
  assert.deepEqual(match.players.map(player => player.position), [{ x: 1, y: 1 }, { x: 15, y: 11 }]);
  assert.deepEqual(match.players.map(player => [player.alive, player.bombCapacity, player.fireRange, player.activeBombs]), [[true, 1, 2, 0], [true, 1, 2, 0]]);
  assert.equal(JSON.stringify(match).includes('socketId'), false);
  match.arena.tiles[1]![1] = 'crate';
  match.players[0]!.position.x = 99;
  assert.equal(matches.snapshot(roomCode).arena.tiles[1]![1], 'floor');
  assert.equal(matches.snapshot(roomCode).players[0]!.position.x, 1);
  code(() => matches.start('host'), 'MATCH_ALREADY_STARTED');
  code(() => rooms.join('third', roomCode, 'Carol'), 'ROOM_NOT_JOINABLE');
});

test('single-player room cannot start', () => {
  const rooms = new RoomManager({ makeCode: () => 'ABCD' });
  const matches = new MatchManager(rooms);
  rooms.create('host', 'Alice');
  rooms.setReady('host', true);
  code(() => matches.start('host'), 'NOT_ENOUGH_PLAYERS');
});

test('server movement blocks crates, pillars, walls and players; cooldown does not mutate', () => {
  const { rooms, matches, advance, code: roomCode } = setup(() => 0);
  rooms.setReady('host', true);
  rooms.setReady('guest', true);
  matches.start('host');
  assert.deepEqual(matches.move('host', 'up'), { ok: true, moved: false, reason: 'blocked' });
  assert.deepEqual(matches.move('host', 'right'), { ok: true, moved: true, revision: 2 });
  assert.deepEqual(matches.move('host', 'down'), { ok: true, moved: false, reason: 'blocked' });
  assert.deepEqual(matches.move('host', 'right'), { ok: true, moved: false, reason: 'blocked' });
  assert.deepEqual(matches.move('host', 'left'), { ok: true, moved: false, reason: 'cooldown' });
  assert.equal(matches.snapshot(roomCode).revision, 2);
  advance(MOVE_COOLDOWN_MS);
  assert.deepEqual(matches.move('host', 'left'), { ok: true, moved: true, revision: 3 });
  assert.equal(matches.snapshot(roomCode).players[1]!.position.x, 15);
  code(() => matches.move('stranger', 'left'), 'NOT_IN_ROOM');
});

test('leaving a match increments revision and deleting its last room removes match', () => {
  const { rooms, matches, code: roomCode } = setup();
  rooms.setReady('host', true);
  rooms.setReady('guest', true);
  matches.start('host');
  rooms.leave('guest');
  const remaining = matches.leave(roomCode, 'p2');
  assert.equal(remaining?.revision, 2);
  assert.deepEqual(remaining?.players.map(player => player.id), ['p1']);
  assert.equal(matches.leave(roomCode, 'p2')?.revision, 2);
  rooms.leave('host');
  assert.equal(matches.leave(roomCode, 'p1'), null);
  assert.equal(matches.matchCount, 0);
  assert.equal(rooms.roomCount, 0);
});

test('another alive player blocks entry to their floor tile', () => {
  const { rooms, matches, advance } = setup(() => 1);
  rooms.setReady('host', true);
  rooms.setReady('guest', true);
  matches.start('host');
  for (let index = 0; index < 14; index++) {
    assert.equal(matches.move('host', 'right').moved, true);
    advance(MOVE_COOLDOWN_MS);
  }
  for (let index = 0; index < 9; index++) {
    assert.equal(matches.move('host', 'down').moved, true);
    advance(MOVE_COOLDOWN_MS);
  }
  assert.deepEqual(matches.move('host', 'down'), { ok: true, moved: false, reason: 'blocked' });
});

test('movement uses a separate rate window that permits normal 135 ms cadence and bounds floods', () => {
  let now = 0;
  const guard = new AbuseGuard(readConfig({}), () => now);
  guard.admit('socket', '127.0.0.1');
  for (let index = 0; index < 74; index++) {
    assert.equal(guard.allowEvent('socket', 'player:input'), true);
    now += 135;
  }
  for (let index = 74; index < 120; index++) assert.equal(guard.allowEvent('socket', 'player:input'), true);
  assert.equal(guard.allowEvent('socket', 'player:input'), false);
  assert.equal(guard.allowEvent('socket', 'room:start-match'), true);
  for (let index = 1; index < 40; index++) assert.equal(guard.allowEvent('socket', 'room:start-match'), true);
  assert.equal(guard.allowEvent('socket', 'room:start-match'), false);
  assert.equal(guard.allowEvent('socket', 'player:input'), false);
  now = 10_000;
  assert.equal(guard.allowEvent('socket', 'player:input'), true);
  guard.release('socket');
});
