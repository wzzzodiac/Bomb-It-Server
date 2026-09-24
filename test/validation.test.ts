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
    port: 8080, clientOrigin: 'http://localhost:5173', maxRooms: 5, maxPlayersPerRoom: 6,
    maxConnectionsPerIp: 10, maxEventsPerWindow: 40, eventWindowMs: 10_000,
    maxRoomCreatesPerWindow: 3, roomCreateWindowMs: 60_000,
    maxInvalidRequests: 8, maxPayloadBytes: 4096
  });
  assert.deepEqual(readConfig({ PORT: '9000', CLIENT_ORIGIN: 'https://wzzzodiac.github.io', MAX_ROOMS: '3', MAX_PLAYERS_PER_ROOM: '4' }), {
    ...readConfig({}), port: 9000, clientOrigin: 'https://wzzzodiac.github.io', maxRooms: 3, maxPlayersPerRoom: 4
  });
  assert.equal(readConfig({ MAX_ROOMS: '999', MAX_PLAYERS_PER_ROOM: 'bad', PORT: '0' }).maxRooms, 5);
  assert.throws(() => readConfig({ CLIENT_ORIGIN: '*' }));
});

test('abuse settings accept bounded values and reject unsafe overrides', () => {
  const defaults = readConfig({});
  assert.equal(readConfig({ MAX_CONNECTIONS_PER_IP: '4' }).maxConnectionsPerIp, 4);
  assert.equal(readConfig({ MAX_EVENTS_PER_WINDOW: '8' }).maxEventsPerWindow, 8);
  assert.equal(readConfig({ EVENT_WINDOW_MS: '6000' }).eventWindowMs, 6000);
  assert.equal(readConfig({ MAX_ROOM_CREATES_PER_WINDOW: '2' }).maxRoomCreatesPerWindow, 2);
  assert.equal(readConfig({ ROOM_CREATE_WINDOW_MS: '30000' }).roomCreateWindowMs, 30000);
  assert.equal(readConfig({ MAX_INVALID_REQUESTS: '3' }).maxInvalidRequests, 3);
  assert.equal(readConfig({ MAX_PAYLOAD_BYTES: '2048' }).maxPayloadBytes, 2048);
  assert.equal(readConfig({ MAX_CONNECTIONS_PER_IP: '9999' }).maxConnectionsPerIp, defaults.maxConnectionsPerIp);
  assert.equal(readConfig({ MAX_EVENTS_PER_WINDOW: '9999' }).maxEventsPerWindow, defaults.maxEventsPerWindow);
  assert.equal(readConfig({ EVENT_WINDOW_MS: '1' }).eventWindowMs, defaults.eventWindowMs);
  assert.equal(readConfig({ MAX_ROOM_CREATES_PER_WINDOW: '9999' }).maxRoomCreatesPerWindow, defaults.maxRoomCreatesPerWindow);
  assert.equal(readConfig({ ROOM_CREATE_WINDOW_MS: '1' }).roomCreateWindowMs, defaults.roomCreateWindowMs);
  assert.equal(readConfig({ MAX_INVALID_REQUESTS: '9999' }).maxInvalidRequests, defaults.maxInvalidRequests);
  assert.equal(readConfig({ MAX_PAYLOAD_BYTES: '999999' }).maxPayloadBytes, defaults.maxPayloadBytes);
});
