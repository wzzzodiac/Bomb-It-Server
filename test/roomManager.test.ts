import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/rooms/roomManager.js';
import { RoomError } from '../src/rooms/types.js';

function manager(codes: string[] = ['ABCD', 'EFGH', 'JKLM', 'NPQR', 'STUV', 'WXYZ']): RoomManager {
  let id = 0;
  return new RoomManager({ makeCode: () => codes.shift()!, makePlayerId: () => `player-${++id}`, now: () => 123 });
}

function errorCode(action: () => unknown, code: RoomError['code']): void {
  assert.throws(action, error => error instanceof RoomError && error.code === code);
}

test('creates a room with a server-owned host and a public state without socket IDs', () => {
  const rooms = manager();
  const state = rooms.create('socket-a', 'Alice');
  assert.equal(state.code, 'ABCD');
  assert.equal(state.status, 'lobby');
  assert.equal(state.hostPlayerId, 'player-1');
  assert.deepEqual(state.players, [{ id: 'player-1', nickname: 'Alice', ready: false, host: true }]);
  assert.equal(JSON.stringify(state).includes('socket-a'), false);
  assert.equal(rooms.roomCount, 1);
});

test('room codes remain unique after a collision', () => {
  const rooms = manager(['ABCD', 'ABCD', 'EFGH']);
  assert.equal(rooms.create('socket-a', 'Alice').code, 'ABCD');
  assert.equal(rooms.create('socket-b', 'Bob').code, 'EFGH');
});

test('at most five rooms can exist', () => {
  const rooms = manager();
  for (let index = 0; index < 5; index++) rooms.create(`socket-${index}`, `Player ${index}`);
  errorCode(() => rooms.create('socket-six', 'Six'), 'ROOM_LIMIT_REACHED');
  assert.equal(rooms.roomCount, 5);
});

test('joins an existing lobby and rejects missing or full rooms', () => {
  const rooms = manager();
  const code = rooms.create('socket-a', 'Alice').code;
  errorCode(() => rooms.join('socket-z', 'WXYZ', 'Missing'), 'ROOM_NOT_FOUND');
  for (let index = 1; index < 6; index++) rooms.join(`socket-${index}`, code, `Player ${index}`);
  assert.equal(rooms.state(code).players.length, 6);
  errorCode(() => rooms.join('socket-extra', code, 'Extra'), 'ROOM_FULL');
});

test('a socket cannot join or create a second room', () => {
  const rooms = manager();
  const code = rooms.create('socket-a', 'Alice').code;
  errorCode(() => rooms.join('socket-a', code, 'Again'), 'ALREADY_IN_ROOM');
  errorCode(() => rooms.create('socket-a', 'Again'), 'ALREADY_IN_ROOM');
});

test('ready state changes only for the caller', () => {
  const rooms = manager();
  const code = rooms.create('socket-a', 'Alice').code;
  rooms.join('socket-b', code, 'Bob');
  const state = rooms.setReady('socket-b', true);
  assert.deepEqual(state.players.map(player => player.ready), [false, true]);
  errorCode(() => rooms.setReady('missing', true), 'NOT_IN_ROOM');
});

test('leaving reassigns the host by join order and deletes an empty room', () => {
  const rooms = manager();
  const code = rooms.create('socket-a', 'Alice').code;
  rooms.join('socket-b', code, 'Bob');
  rooms.join('socket-c', code, 'Carol');
  const afterHostLeaves = rooms.leave('socket-a');
  assert.equal(afterHostLeaves.state?.hostPlayerId, 'player-2');
  assert.deepEqual(afterHostLeaves.state?.players.map(player => player.nickname), ['Bob', 'Carol']);
  rooms.leave('socket-b');
  assert.equal(rooms.leave('socket-c').state, null);
  assert.equal(rooms.roomCount, 0);
  errorCode(() => rooms.state(code), 'ROOM_NOT_FOUND');
});

test('configured room limits can be lower but cannot exceed product limits', () => {
  const rooms = new RoomManager({ maxRooms: 1, maxPlayersPerRoom: 2, makeCode: () => 'ABCD' });
  const code = rooms.create('socket-a', 'Alice').code;
  rooms.join('socket-b', code, 'Bob');
  errorCode(() => rooms.join('socket-c', code, 'Carol'), 'ROOM_FULL');
  errorCode(() => rooms.create('socket-c', 'Carol'), 'ROOM_LIMIT_REACHED');
  assert.throws(() => new RoomManager({ maxRooms: 6 }));
  assert.throws(() => new RoomManager({ maxPlayersPerRoom: 7 }));
});
