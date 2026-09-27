import { allocateSpawns, blastTiles, createArena, tileAt } from '../game/arena.js';
import { FLAME_MS, FUSE_MS, getArenaSizeForPlayerCount, key, VECTORS, type Direction } from '../game/config.js';
import { canEscapeBomb, dangerTiles, findEscapeDirection } from '../game/botLogic.js';
import { DIRECTIONS } from '../game/config.js';
import { RoomManager } from '../rooms/roomManager.js';
import { RoomError } from '../rooms/types.js';
import type { BombResult, InitialMatchState, InternalMatch, MatchBomb, MatchExplosion, MatchPublication, MatchResult, MatchState, MoveResult, TileChange } from './types.js';

export const MOVE_COOLDOWN_MS = 135;
export type MatchScheduler = { set: (callback: () => void, delayMs: number) => unknown; clear: (handle: unknown) => void };
const realScheduler: MatchScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class MatchManager {
  private readonly matches = new Map<string, InternalMatch>();
  private publisher: ((code: string, publication: MatchPublication) => void) | null = null;

  constructor(
    private readonly rooms: RoomManager,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly scheduler: MatchScheduler = realScheduler
  ) {}

  get matchCount(): number { return this.matches.size; }
  get timerCount(): number { return [...this.matches.values()].reduce((count, match) => count + match.bombTimers.size + match.botTimers.size, 0); }
  setPublisher(publisher: (code: string, publication: MatchPublication) => void): void { this.publisher = publisher; }

  start(socketId: string): { room: ReturnType<RoomManager['state']>; match: InitialMatchState } {
    const { code, players } = this.rooms.prepareMatchStart(socketId);
    const { cols, rows } = getArenaSizeForPlayerCount(players.length);
    const arena = createArena({ cols, rows, playerCount: players.length, random: this.random });
    const spawns = allocateSpawns(players.length, cols, rows);
    const state: MatchState = {
      roomCode: code, status: 'playing', revision: 1, bombs: [], powerUps: [],
      players: players.map((player, index) => ({
        id: player.id, name: player.nickname, position: spawns[index]!, alive: true,
        bombCapacity: 1, fireRange: 2, activeBombs: 0
      }))
    };
    this.matches.set(code, { state, arena, lastAcceptedMove: new Map(), bombTimers: new Map(), botTimers: new Map(), botNextBomb: new Map(), flames: new Map(), nextBombId: 1, result: null });
    try {
      const match = this.initialSnapshot(code);
      const room = this.rooms.commitMatchStart(socketId);
      for (const player of players) if (player.kind === 'bot') {
        this.getMatch(code).botNextBomb.set(player.id, this.now() + 1700 + this.random() * 1200);
        this.scheduleBot(code, player.id, 240 + this.random() * 140);
      }
      return { room, match };
    } catch (error) {
      this.deleteMatch(code);
      throw error;
    }
  }

  initialSnapshot(code: string): InitialMatchState {
    const match = this.getMatch(code);
    return {
      ...this.snapshot(code),
      arena: { cols: match.arena[0]!.length, rows: match.arena.length, tiles: match.arena.map(row => [...row]) }
    };
  }

  snapshot(code: string): MatchState {
    const state = this.getMatch(code).state;
    return {
      ...state,
      players: state.players.map(player => ({ ...player, position: { ...player.position } })),
      bombs: state.bombs.map(bomb => ({ ...bomb, position: { ...bomb.position } })),
      powerUps: state.powerUps.map(power => ({ ...power, position: { ...power.position } }))
    };
  }

  private getMatch(code: string): InternalMatch {
    const match = this.matches.get(code);
    if (!match) throw new RoomError('MATCH_NOT_STARTED', 'Match has not started.');
    return match;
  }

  private memberMatch(socketId: string): { code: string; playerId: string; match: InternalMatch } {
    const code = this.rooms.roomCodeFor(socketId);
    const playerId = this.rooms.playerIdFor(socketId);
    if (!code || !playerId) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    return { code, playerId, match: this.getMatch(code) };
  }

  move(socketId: string, direction: Direction): MoveResult {
    const { code, playerId } = this.memberMatch(socketId);
    return this.movePlayer(code, playerId, direction);
  }

  private movePlayer(code: string, playerId: string, direction: Direction): MoveResult {
    const match = this.getMatch(code);
    if (match.state.status !== 'playing') return { ok: true, moved: false, reason: 'blocked' };
    const player = match.state.players.find(candidate => candidate.id === playerId);
    if (!player?.alive) return { ok: true, moved: false, reason: 'blocked' };
    const vector = VECTORS[direction];
    const target = { x: player.position.x + vector.x, y: player.position.y + vector.y };
    if (tileAt(match.arena, target) !== 'floor' || match.state.bombs.some(bomb => key(bomb.position) === key(target)) ||
        match.state.players.some(candidate => candidate.id !== playerId && candidate.alive && key(candidate.position) === key(target))) {
      return { ok: true, moved: false, reason: 'blocked' };
    }
    const now = this.now();
    const last = match.lastAcceptedMove.get(playerId);
    if (last !== undefined && now - last < MOVE_COOLDOWN_MS) return { ok: true, moved: false, reason: 'cooldown' };
    player.position = target;
    match.lastAcceptedMove.set(playerId, now);
    const powerIndex = match.state.powerUps.findIndex(power => key(power.position) === key(target));
    if (powerIndex >= 0) {
      const [power] = match.state.powerUps.splice(powerIndex, 1);
      if (power?.kind === 'bomb') player.bombCapacity++;
      else if (power?.kind === 'fire') player.fireRange++;
    }
    if ((match.flames.get(key(target)) ?? 0) > now) player.alive = false;
    match.state.revision++;
    const result = this.finishIfResolved(code, match);
    this.publish(code, match, { result, roomFinished: !!result });
    return { ok: true, moved: true, revision: match.state.revision };
  }

  placeBomb(socketId: string): BombResult {
    const { code, playerId } = this.memberMatch(socketId);
    return this.placeBombForPlayer(code, playerId);
  }

  private placeBombForPlayer(code: string, playerId: string): BombResult {
    const match = this.getMatch(code);
    if (match.state.status !== 'playing') return { ok: true, placed: false, reason: 'finished' };
    const player = match.state.players.find(candidate => candidate.id === playerId);
    if (!player?.alive) return { ok: true, placed: false, reason: 'dead' };
    if (player.activeBombs >= player.bombCapacity) return { ok: true, placed: false, reason: 'capacity' };
    if (match.state.bombs.some(bomb => key(bomb.position) === key(player.position))) return { ok: true, placed: false, reason: 'occupied' };
    const bomb: MatchBomb = {
      id: `bomb-${match.nextBombId++}`, ownerId: playerId, position: { ...player.position },
      range: player.fireRange, explodeAt: this.now() + FUSE_MS
    };
    match.state.bombs.push(bomb);
    player.activeBombs++;
    match.bombTimers.set(bomb.id, this.scheduler.set(() => this.explode(code, bomb.id), FUSE_MS));
    match.state.revision++;
    this.publish(code, match);
    return { ok: true, placed: true, revision: match.state.revision };
  }

  private scheduleBot(code: string, botId: string, delayMs: number): void {
    const match = this.matches.get(code);
    if (!match || match.state.status !== 'playing') return;
    match.botTimers.set(botId, this.scheduler.set(() => {
      match.botTimers.delete(botId);
      this.tickBot(code, botId);
      if (match.state.status === 'playing' && match.state.players.some(player => player.id === botId && player.alive)) {
        this.scheduleBot(code, botId, 240 + this.random() * 140);
      }
    }, delayMs));
  }

  private tickBot(code: string, botId: string): void {
    const match = this.matches.get(code);
    const bot = match?.state.players.find(player => player.id === botId);
    if (!match || !bot?.alive || match.state.status !== 'playing') return;
    const blocked = new Set([
      ...match.state.bombs.map(bomb => key(bomb.position)),
      ...match.state.players.filter(player => player.id !== botId && player.alive).map(player => key(player.position))
    ]);
    const threats = match.state.bombs.map(bomb => ({ position: bomb.position, range: bomb.range }));
    const danger = dangerTiles(match.arena, threats);
    const escape = findEscapeDirection(match.arena, bot.position, threats, blocked);
    const options = DIRECTIONS.map(direction => {
      const vector = VECTORS[direction];
      return { direction, point: { x: bot.position.x + vector.x, y: bot.position.y + vector.y } };
    }).filter(option => tileAt(match.arena, option.point) === 'floor' && !blocked.has(key(option.point)));
    const safe = options.filter(option => !danger.has(key(option.point)) && (match.flames.get(key(option.point)) ?? 0) <= this.now());
    const choices = safe.length ? safe : options;
    const direction = escape ?? choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))]?.direction;
    if (direction) this.movePlayer(code, botId, direction);
    if (match.state.status !== 'playing' || !bot.alive) return;
    if (this.now() >= (match.botNextBomb.get(botId) ?? 0)) {
      const prospective = [...threats, { position: bot.position, range: bot.fireRange }];
      if (!danger.has(key(bot.position)) && canEscapeBomb(match.arena, bot.position, prospective, blocked) && this.random() < 0.52) {
        this.placeBombForPlayer(code, botId);
      }
      match.botNextBomb.set(botId, this.now() + 1700 + this.random() * 1700);
    }
  }

  private explode(code: string, firstBombId: string): void {
    const match = this.matches.get(code);
    if (!match || match.state.status !== 'playing' || !match.state.bombs.some(bomb => bomb.id === firstBombId)) return;
    const queue = [firstBombId];
    const queued = new Set(queue);
    const tileKeys = new Set<string>();
    const tiles: MatchExplosion['tiles'] = [];
    const changes: TileChange[] = [];
    while (queue.length) {
      const bombId = queue.shift()!;
      const index = match.state.bombs.findIndex(bomb => bomb.id === bombId);
      if (index < 0) continue;
      const [bomb] = match.state.bombs.splice(index, 1);
      if (!bomb) continue;
      const timer = match.bombTimers.get(bombId);
      if (timer !== undefined) this.scheduler.clear(timer);
      match.bombTimers.delete(bombId);
      const owner = match.state.players.find(player => player.id === bomb.ownerId);
      if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);
      for (const point of blastTiles(match.arena, bomb.position, bomb.range)) {
        const pointKey = key(point);
        if (!tileKeys.has(pointKey)) { tileKeys.add(pointKey); tiles.push(point); }
        if (tileAt(match.arena, point) === 'crate') {
          match.arena[point.y]![point.x] = 'floor';
          changes.push({ ...point, tile: 'floor' });
          if (this.random() < 0.22) match.state.powerUps.push({ position: { ...point }, kind: this.random() < 0.5 ? 'bomb' : 'fire' });
        }
        for (const chained of match.state.bombs) {
          if (key(chained.position) === pointKey && !queued.has(chained.id)) { queued.add(chained.id); queue.push(chained.id); }
        }
      }
    }
    const expiresAt = this.now() + FLAME_MS;
    for (const point of tiles) match.flames.set(key(point), expiresAt);
    for (const player of match.state.players) if (player.alive && tileKeys.has(key(player.position))) player.alive = false;
    match.state.revision++;
    const explosion: MatchExplosion = { roomCode: code, revision: match.state.revision, tiles, changes, durationMs: FLAME_MS };
    const result = this.finishIfResolved(code, match);
    this.publish(code, match, { explosion, result, roomFinished: !!result });
  }

  leave(code: string, playerId: string): MatchState | null {
    const match = this.matches.get(code);
    if (!match || !match.state.players.some(player => player.id === playerId)) return null;
    match.state.players = match.state.players.filter(player => player.id !== playerId);
    match.lastAcceptedMove.delete(playerId);
    if (match.state.players.length === 0) { this.deleteMatch(code); return null; }
    match.state.revision++;
    const result = this.finishIfResolved(code, match);
    this.publish(code, match, { result });
    return this.snapshot(code);
  }

  closeRoom(code: string): void { this.deleteMatch(code); }

  returnToLobby(socketId: string): { state: ReturnType<RoomManager['state']>; reset: boolean } {
    const code = this.rooms.roomCodeFor(socketId);
    if (!code) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const room = this.rooms.state(code);
    if (room.status === 'lobby') return { state: room, reset: false };
    const match = this.getMatch(code);
    if (room.status !== 'finished' || match.state.status !== 'finished') throw new RoomError('MATCH_NOT_FINISHED', 'Match has not finished.');
    const state = this.rooms.returnToLobby(socketId);
    this.deleteMatch(code);
    return { state, reset: true };
  }

  private finishIfResolved(code: string, match: InternalMatch): MatchResult | undefined {
    if (match.result || match.state.status !== 'playing') return undefined;
    const alive = match.state.players.filter(player => player.alive);
    if (alive.length > 1) return undefined;
    match.state.status = 'finished';
    this.rooms.finishMatch(code);
    this.clearTimers(match);
    match.state.bombs = [];
    match.flames.clear();
    for (const player of match.state.players) player.activeBombs = 0;
    const winner = alive.length === 1 ? alive[0] : undefined;
    match.result = {
      roomCode: code, revision: match.state.revision, kind: winner ? 'winner' : 'draw',
      winnerId: winner?.id, winnerName: winner?.name,
      statuses: match.state.players.map(player => ({ id: player.id, name: player.name, alive: player.alive }))
    };
    return match.result;
  }

  private publish(code: string, match: InternalMatch, extras: Omit<MatchPublication, 'state'> = {}): void {
    this.publisher?.(code, { state: this.snapshot(code), ...extras });
  }

  private clearTimers(match: InternalMatch): void {
    for (const timer of match.bombTimers.values()) this.scheduler.clear(timer);
    match.bombTimers.clear();
    for (const timer of match.botTimers.values()) this.scheduler.clear(timer);
    match.botTimers.clear();
    match.botNextBomb.clear();
  }

  private deleteMatch(code: string): void {
    const match = this.matches.get(code);
    if (!match) return;
    this.clearTimers(match);
    match.flames.clear();
    this.matches.delete(code);
  }

  dispose(): void {
    for (const code of this.matches.keys()) this.deleteMatch(code);
    this.publisher = null;
  }
}
