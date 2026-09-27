import type { Arena, Tile } from '../game/arena.js';
import type { Point } from '../game/config.js';

export type MatchPlayer = {
  id: string;
  name: string;
  position: Point;
  alive: boolean;
  bombCapacity: number;
  fireRange: number;
  activeBombs: number;
};

export type MatchBomb = { id: string; ownerId: string; position: Point; range: number; explodeAt: number };
export type MatchPowerUp = { position: Point; kind: 'bomb' | 'fire' };
export type TileChange = { x: number; y: number; tile: Tile };

export type MatchState = {
  roomCode: string;
  status: 'playing' | 'finished';
  revision: number;
  players: MatchPlayer[];
  bombs: MatchBomb[];
  powerUps: MatchPowerUp[];
};

export type MatchExplosion = { roomCode: string; revision: number; tiles: Point[]; changes: TileChange[]; durationMs: number };
export type MatchResult = {
  roomCode: string; revision: number; kind: 'winner' | 'draw'; winnerId?: string; winnerName?: string;
  statuses: Array<{ id: string; name: string; alive: boolean }>;
};
export type MatchPublication = { state: MatchState; explosion?: MatchExplosion; result?: MatchResult; roomFinished?: boolean };

export type InitialMatchState = MatchState & {
  arena: { cols: number; rows: number; tiles: Tile[][] };
};

export type InternalMatch = {
  state: MatchState; arena: Arena; lastAcceptedMove: Map<string, number>;
  bombTimers: Map<string, unknown>; flames: Map<string, number>; nextBombId: number; result: MatchResult | null;
};
export type MoveResult = { ok: true; moved: true; revision: number } |
  { ok: true; moved: false; reason: 'blocked' | 'cooldown' };
export type BombResult = { ok: true; placed: true; revision: number } |
  { ok: true; placed: false; reason: 'dead' | 'capacity' | 'occupied' | 'finished' };
