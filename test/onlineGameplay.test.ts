import test from 'node:test';
import assert from 'node:assert/strict';
import { blastTiles, createArena } from '../src/game/arena.js';
import { FLAME_MS, FUSE_MS } from '../src/game/config.js';
import { MatchManager, MOVE_COOLDOWN_MS, type MatchScheduler } from '../src/match/matchManager.js';
import type { MatchPublication } from '../src/match/types.js';
import { RoomManager } from '../src/rooms/roomManager.js';

class Clock implements MatchScheduler {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  };
  clear = (handle: unknown): void => { this.tasks.delete(handle as number); };
  get pending(): number { return this.tasks.size; }
  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = end;
  }
}

function setup(count = 3, random = () => 1) {
  const clock = new Clock();
  let nextId = 0;
  const rooms = new RoomManager({ makeCode: () => 'ABCD', makePlayerId: () => `p${++nextId}` });
  const publications: MatchPublication[] = [];
  const matches = new MatchManager(rooms, () => clock.now, random, clock);
  matches.setPublisher((_code, publication) => publications.push(publication));
  rooms.create('s0', 'Alice');
  for (let index = 1; index < count; index++) rooms.join(`s${index}`, 'ABCD', `Player ${index}`);
  for (let index = 0; index < count; index++) rooms.setReady(`s${index}`, true);
  matches.start('s0');
  return { clock, rooms, matches, publications };
}

function moveMany(matches: MatchManager, clock: Clock, socket: string, direction: 'left' | 'up', count: number): void {
  for (let index = 0; index < count; index++) {
    assert.equal(matches.move(socket, direction).moved, true);
    clock.advance(MOVE_COOLDOWN_MS);
  }
}

test('bomb intent uses the caller position, capacity, server ID and authoritative fuse', () => {
  const { matches, clock, publications } = setup();
  assert.deepEqual(matches.placeBomb('s0'), { ok: true, placed: true, revision: 2 });
  const state = matches.snapshot('ABCD');
  assert.deepEqual(state.bombs[0]?.position, { x: 1, y: 1 });
  assert.equal(state.bombs[0]?.ownerId, 'p1');
  assert.equal(state.bombs[0]?.id, 'bomb-1');
  assert.equal(state.bombs[0]?.range, 2);
  assert.equal(state.bombs[0]?.explodeAt, FUSE_MS);
  assert.equal(state.players[0]?.activeBombs, 1);
  assert.deepEqual(matches.placeBomb('s0'), { ok: true, placed: false, reason: 'capacity' });
  assert.deepEqual(matches.move('s0', 'right'), { ok: true, moved: true, revision: 3 });
  assert.deepEqual(matches.move('s0', 'left'), { ok: true, moved: false, reason: 'blocked' });
  assert.equal(publications.length, 2);
  assert.equal(clock.pending, 1);
});

test('blast follows local walls and first-crate blocking; fuse destroys crate once without a drop', () => {
  const arena = createArena({ cols: 17, rows: 13, playerCount: 2, random: () => 0 });
  assert.deepEqual(blastTiles(arena, { x: 1, y: 1 }, 3), [
    { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 1 }, { x: 3, y: 1 }
  ]);
  let calls = 0;
  const { matches, clock, publications } = setup(3, () => ++calls === 1 ? 0 : 1);
  matches.placeBomb('s0');
  matches.move('s0', 'down');
  clock.advance(FUSE_MS - 1);
  assert.equal(matches.snapshot('ABCD').bombs.length, 1);
  clock.advance(1);
  const event = publications.find(publication => publication.explosion)?.explosion;
  assert.ok(event);
  assert.deepEqual(event.changes, [{ x: 3, y: 1, tile: 'floor' }]);
  assert.equal(event.durationMs, FLAME_MS);
  assert.equal(matches.initialSnapshot('ABCD').arena.tiles[1]?.[3], 'floor');
  assert.equal(matches.snapshot('ABCD').powerUps.length, 0);
  assert.equal(matches.snapshot('ABCD').players[0]?.activeBombs, 0);
  assert.equal(matches.snapshot('ABCD').players[0]?.alive, false);
  assert.deepEqual(matches.move('s0', 'up'), { ok: true, moved: false, reason: 'blocked' });
  assert.deepEqual(matches.placeBomb('s0'), { ok: true, placed: false, reason: 'dead' });
  assert.equal(publications.filter(publication => publication.explosion).length, 1);
  clock.advance(FUSE_MS);
  assert.equal(publications.filter(publication => publication.explosion).length, 1);
});

test('chain explosion resolves once, cancels the second fuse and emits one result', () => {
  const { matches, rooms, clock, publications } = setup();
  moveMany(matches, clock, 's2', 'left', 16);
  assert.deepEqual(matches.snapshot('ABCD').players[2]?.position, { x: 3, y: 1 });
  matches.placeBomb('s0');
  const hostFuseAt = clock.now + FUSE_MS;
  matches.move('s0', 'down');
  clock.advance(100);
  matches.placeBomb('s2');
  matches.move('s2', 'down');
  assert.equal(clock.pending, 2);
  clock.advance(hostFuseAt - clock.now);
  const state = matches.snapshot('ABCD');
  assert.equal(state.status, 'finished');
  assert.equal(rooms.state('ABCD').status, 'finished');
  assert.equal(state.bombs.length, 0);
  assert.deepEqual(state.players.map(player => player.activeBombs), [0, 0, 0]);
  assert.deepEqual(state.players.map(player => player.alive), [false, true, false]);
  assert.equal(publications.filter(publication => publication.explosion).length, 1);
  assert.equal(publications.filter(publication => publication.result).length, 1);
  assert.equal(publications.at(-1)?.result?.winnerId, 'p2');
  assert.equal(clock.pending, 0);
  const revision = state.revision;
  clock.advance(FUSE_MS + 100);
  assert.equal(matches.snapshot('ABCD').revision, revision);
  assert.equal(publications.filter(publication => publication.explosion).length, 1);
});

test('server RNG selects Bomb Up or Fire Up and collection updates stats exactly once', () => {
  for (const [kind, kindRoll] of [['bomb', 0], ['fire', 1]] as const) {
    let arenaRolls = 0;
    let exploding = false;
    const rolls = [0, kindRoll];
    const random = () => exploding ? (rolls.shift() ?? 1) : (++arenaRolls === 1 ? 0 : 1);
    const { matches, clock } = setup(3, random);
    exploding = true;
    matches.placeBomb('s0');
    matches.move('s0', 'down');
    clock.advance(FUSE_MS + FLAME_MS);
    assert.deepEqual(matches.snapshot('ABCD').powerUps, [{ position: { x: 3, y: 1 }, kind }]);
    moveMany(matches, clock, 's2', 'left', 16);
    const collector = matches.snapshot('ABCD').players[2];
    assert.deepEqual(collector?.position, { x: 3, y: 1 });
    assert.equal(matches.snapshot('ABCD').powerUps.length, 0);
    assert.equal(collector?.bombCapacity, kind === 'bomb' ? 2 : 1);
    assert.equal(collector?.fireRange, kind === 'fire' ? 3 : 2);
    if (kind === 'bomb') {
      assert.equal(matches.placeBomb('s2').placed, true);
      assert.deepEqual(matches.placeBomb('s2'), { ok: true, placed: false, reason: 'occupied' });
    }
  }
});

test('simultaneous deaths produce one draw; finished matches reject further intents', () => {
  const { matches, rooms, clock, publications } = setup(2);
  moveMany(matches, clock, 's1', 'left', 12);
  moveMany(matches, clock, 's1', 'up', 10);
  assert.deepEqual(matches.snapshot('ABCD').players[1]?.position, { x: 3, y: 1 });
  matches.placeBomb('s0');
  clock.advance(FUSE_MS);
  assert.equal(matches.snapshot('ABCD').status, 'finished');
  assert.equal(rooms.state('ABCD').status, 'finished');
  assert.deepEqual(matches.snapshot('ABCD').players.map(player => player.alive), [false, false]);
  assert.equal(publications.filter(publication => publication.result).length, 1);
  assert.equal(publications.at(-1)?.result?.kind, 'draw');
  assert.deepEqual(matches.move('s1', 'right'), { ok: true, moved: false, reason: 'blocked' });
  assert.deepEqual(matches.placeBomb('s1'), { ok: true, placed: false, reason: 'finished' });
  assert.equal(publications.filter(publication => publication.result).length, 1);
});

test('departed owner leaves a live fuse; final deletion cancels timers and stale callbacks', () => {
  const { matches, rooms, clock, publications } = setup(3);
  matches.placeBomb('s0');
  rooms.leave('s0'); matches.leave('ABCD', 'p1');
  assert.equal(matches.snapshot('ABCD').bombs[0]?.ownerId, 'p1');
  assert.equal(clock.pending, 1);
  clock.advance(FUSE_MS);
  assert.equal(publications.filter(publication => publication.explosion).length, 1);
  assert.equal(matches.snapshot('ABCD').status, 'playing');
  rooms.leave('s1'); matches.leave('ABCD', 'p2');
  assert.equal(publications.filter(publication => publication.result).length, 1);
  rooms.leave('s2'); matches.leave('ABCD', 'p3');
  assert.equal(matches.matchCount, 0);
  assert.equal(matches.timerCount, 0);
  assert.equal(clock.pending, 0);
  clock.advance(FUSE_MS);
  assert.equal(publications.filter(publication => publication.explosion).length, 1);
});
