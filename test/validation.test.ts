import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { RoomError } from '../src/rooms/types.js';
import { parseCreatePayload, parseJoinPayload, parseNickname, parseReadyPayload, parseRoomCode } from '../src/validation/input.js';

function rejects(action: () => unknown, code: RoomError['code']): void {
  assert.throws(action, error => error instanceof RoomError && error.code === code);
}

test('nickname trims and collapses whitespace while rejecting empty and long values', () => {
  assert.equal(parseNickname('  Ada   Lovelace  '), 'Ada Lovelace');
  rejects(() => parseNickname('   '), 'INVALID_NICKNAME');
  rejects(() => parseNickname('x'.repeat(19)), 'INVALID_NICKNAME');
  rejects(() => parseNickname(42), 'INVALID_NICKNAME');
});

test('room codes normalize lowercase and reject wrong length or alphabet', () => {
  assert.equal(parseRoomCode(' abcd '), 'ABCD');
  rejects(() => parseRoomCode('ABC'), 'INVALID_ROOM_CODE');
  rejects(() => parseRoomCode('AB0D'), 'INVALID_ROOM_CODE');
  rejects(() => parseRoomCode(1234), 'INVALID_ROOM_CODE');
});

test('event payloads reject extra client identity and non-boolean ready', () => {
  assert.deepEqual(parseCreatePayload({ nickname: 'Ada' }), { nickname: 'Ada' });
  assert.deepEqual(parseJoinPayload({ code: 'abcd', nickname: 'Bob' }), { code: 'ABCD', nickname: 'Bob' });
  assert.deepEqual(parseReadyPayload({ ready: true }), { ready: true });
  rejects(() => parseCreatePayload({ nickname: 'Ada', id: 'client-chosen' }), 'INVALID_PAYLOAD');
  rejects(() => parseJoinPayload(null), 'INVALID_PAYLOAD');
  rejects(() => parseReadyPayload({ ready: 'true' }), 'INVALID_READY');
});

test('configuration defaults and caps room limits while respecting PORT and origin', () => {
  assert.deepEqual(readConfig({}), {
    port: 8080, clientOrigin: 'http://localhost:5173', maxRooms: 5, maxPlayersPerRoom: 6
  });
  assert.deepEqual(readConfig({ PORT: '9000', CLIENT_ORIGIN: 'https://wzzzodiac.github.io', MAX_ROOMS: '3', MAX_PLAYERS_PER_ROOM: '4' }), {
    port: 9000, clientOrigin: 'https://wzzzodiac.github.io', maxRooms: 3, maxPlayersPerRoom: 4
  });
  assert.equal(readConfig({ MAX_ROOMS: '999', MAX_PLAYERS_PER_ROOM: 'bad', PORT: '0' }).maxRooms, 5);
  assert.throws(() => readConfig({ CLIENT_ORIGIN: '*' }));
});
