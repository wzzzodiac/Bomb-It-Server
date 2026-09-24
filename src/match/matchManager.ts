import { allocateSpawns, createArena, tileAt } from '../game/arena.js';
import { getArenaSizeForPlayerCount, VECTORS, type Direction } from '../game/config.js';
import { RoomManager } from '../rooms/roomManager.js';
import { RoomError } from '../rooms/types.js';
import type { InternalMatch, MatchState, MoveResult } from './types.js';

export const MOVE_COOLDOWN_MS = 135;

export class MatchManager {
  private readonly matches = new Map<string, InternalMatch>();

  constructor(
    private readonly rooms: RoomManager,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {}

  get matchCount(): number { return this.matches.size; }

  start(socketId: string): { room: ReturnType<RoomManager['state']>; match: MatchState } {
    const { state: room, players } = this.rooms.startMatch(socketId);
    const { cols, rows } = getArenaSizeForPlayerCount(players.length);
    const arena = createArena({ cols, rows, playerCount: players.length, random: this.random });
    const spawns = allocateSpawns(players.length, cols, rows);
    const state: MatchState = {
      roomCode: room.code, status: 'playing', revision: 1,
      arena: { cols, rows, tiles: arena },
      players: players.map((player, index) => ({
        id: player.id, name: player.nickname, position: spawns[index]!, alive: true,
        bombCapacity: 1, fireRange: 2, activeBombs: 0
      }))
    };
    this.matches.set(room.code, { state, arena, lastAcceptedMove: new Map() });
    return { room, match: this.snapshot(room.code) };
  }

  snapshot(code: string): MatchState {
    const match = this.matches.get(code);
    if (!match) throw new RoomError('MATCH_NOT_STARTED', 'Match has not started.');
    const state = match.state;
    return {
      ...state,
      arena: { ...state.arena, tiles: state.arena.tiles.map(row => [...row]) },
      players: state.players.map(player => ({ ...player, position: { ...player.position } }))
    };
  }

  move(socketId: string, direction: Direction): MoveResult {
    const code = this.rooms.roomCodeFor(socketId);
    const playerId = this.rooms.playerIdFor(socketId);
    if (!code || !playerId) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const match = this.matches.get(code);
    if (!match) throw new RoomError('MATCH_NOT_STARTED', 'Match has not started.');
    const player = match.state.players.find(candidate => candidate.id === playerId);
    if (!player?.alive) return { ok: true, moved: false, reason: 'blocked' };
    const vector = VECTORS[direction];
    const target = { x: player.position.x + vector.x, y: player.position.y + vector.y };
    if (tileAt(match.arena, target) !== 'floor' || match.state.players.some(candidate =>
      candidate.id !== playerId && candidate.alive && candidate.position.x === target.x && candidate.position.y === target.y
    )) return { ok: true, moved: false, reason: 'blocked' };
    const now = this.now();
    const last = match.lastAcceptedMove.get(playerId);
    if (last !== undefined && now - last < MOVE_COOLDOWN_MS) return { ok: true, moved: false, reason: 'cooldown' };
    player.position = target;
    match.lastAcceptedMove.set(playerId, now);
    match.state.revision++;
    return { ok: true, moved: true, revision: match.state.revision };
  }

  leave(code: string, playerId: string): MatchState | null {
    const match = this.matches.get(code);
    if (!match) return null;
    const before = match.state.players.length;
    match.state.players = match.state.players.filter(player => player.id !== playerId);
    match.lastAcceptedMove.delete(playerId);
    if (match.state.players.length === 0) {
      this.matches.delete(code);
      return null;
    }
    if (match.state.players.length !== before) match.state.revision++;
    return this.snapshot(code);
  }
}
