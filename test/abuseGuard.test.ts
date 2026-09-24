import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { AbuseGuard, resolveClientAddress } from '../src/security/abuseGuard.js';

test('direct-peer IP limit rejects excess connections and releases slots without retaining counters', () => {
  const guard = new AbuseGuard({ ...readConfig({}), maxConnectionsPerIp: 2 });
  assert.equal(resolveClientAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(guard.admit('one', '::ffff:127.0.0.1'), true);
  assert.equal(guard.admit('two', '127.0.0.1'), true);
  assert.equal(guard.admit('three', '127.0.0.1'), false);
  assert.equal(guard.activeSocketCount, 2);
  guard.release('one');
  guard.release('one');
  assert.equal(guard.admit('three', '127.0.0.1'), true);
  guard.release('two');
  guard.release('three');
  assert.equal(guard.activeSocketCount, 0);
  assert.equal(guard.trackedAddressCount, 0);
});

test('normal events pass, spam is limited, and a new window restores the allowance', () => {
  let now = 100;
  const guard = new AbuseGuard({ ...readConfig({}), maxEventsPerWindow: 2, eventWindowMs: 5000 }, () => now);
  guard.admit('one', '127.0.0.1');
  assert.equal(guard.allowEvent('one', 'room:join'), true);
  assert.equal(guard.allowEvent('one', 'player:set-ready'), true);
  assert.equal(guard.allowEvent('one', 'room:leave'), false);
  now += 5000;
  assert.equal(guard.allowEvent('one', 'room:leave'), true);
  guard.release('one');
});

test('room creation has a separate stricter limit and rejected attempts do not run actions', () => {
  const guard = new AbuseGuard({ ...readConfig({}), maxRoomCreatesPerWindow: 1 });
  guard.admit('one', '127.0.0.1');
  let created = 0;
  const create = () => { if (guard.allowEvent('one', 'room:create')) created++; };
  create();
  create();
  assert.equal(created, 1);
  assert.equal(guard.allowEvent('one', 'player:set-ready'), true);
  guard.release('one');
});

test('invalid strikes disconnect at the threshold while normal room errors do not count', () => {
  const guard = new AbuseGuard({ ...readConfig({}), maxInvalidRequests: 2 });
  guard.admit('one', '127.0.0.1');
  for (let index = 0; index < 10; index++) {
    assert.equal(guard.recordInvalid('one', 'ROOM_NOT_FOUND'), false);
    assert.equal(guard.recordInvalid('one', 'ROOM_FULL'), false);
  }
  assert.equal(guard.recordInvalid('one', 'INVALID_PAYLOAD'), false);
  assert.equal(guard.recordInvalid('one', 'INVALID_READY'), true);
  guard.release('one');
  assert.equal(guard.trackedAddressCount, 0);
});
