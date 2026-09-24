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

export type MatchState = {
  roomCode: string;
  status: 'playing';
  revision: number;
  players: MatchPlayer[];
};

export type InitialMatchState = MatchState & {
  arena: { cols: number; rows: number; tiles: Tile[][] };
};

export type InternalMatch = { state: MatchState; arena: Arena; lastAcceptedMove: Map<string, number> };
export type MoveResult = { ok: true; moved: true; revision: number } |
  { ok: true; moved: false; reason: 'blocked' | 'cooldown' };
