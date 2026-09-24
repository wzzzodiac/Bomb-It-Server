import { DIRECTIONS, VECTORS, key, type Point } from './config.js';

export type Tile = 'floor' | 'wall' | 'crate';
export type Arena = Tile[][];
export type ArenaOptions = { cols: number; rows: number; playerCount: number; random?: () => number };
export const arenaSize = (arena: Arena) => ({ cols: arena[0]?.length ?? 0, rows: arena.length });
export const inside = (arena: Arena, { x, y }: Point): boolean => y >= 0 && y < arena.length && x >= 0 && x < (arena[0]?.length ?? 0);
export const tileAt = (arena: Arena, p: Point): Tile => inside(arena, p) ? arena[p.y]![p.x]! : 'wall';

const candidateSpawns = (cols: number, rows: number): Point[] => [
  { x: 1, y: 1 }, { x: cols - 2, y: rows - 2 }, { x: cols - 2, y: 1 },
  { x: 1, y: rows - 2 }, { x: Math.floor(cols / 2), y: 1 }, { x: Math.floor(cols / 2), y: rows - 2 }
];

export function allocateSpawns(playerCount: number, cols: number, rows: number): Point[] {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 6) throw new Error('playerCount must be between 1 and 6');
  if (cols < 9 || rows < 9 || cols % 2 === 0 || rows % 2 === 0) throw new Error('arena dimensions must be odd and at least 9');
  return candidateSpawns(cols, rows).slice(0, playerCount);
}

export function safeSpawnTiles(spawn: Point, cols: number, rows: number): Point[] {
  const adjacent = DIRECTIONS.map(direction => ({ x: spawn.x + VECTORS[direction].x, y: spawn.y + VECTORS[direction].y }))
    .filter(({ x, y }) => x > 0 && y > 0 && x < cols - 1 && y < rows - 1 && !(x % 2 === 0 && y % 2 === 0));
  return [spawn, ...adjacent];
}

export function createArena({ cols, rows, playerCount, random = Math.random }: ArenaOptions): Arena {
  const safe = new Set(allocateSpawns(playerCount, cols, rows).flatMap(spawn => safeSpawnTiles(spawn, cols, rows)).map(key));
  return Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x): Tile => {
    if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1 || (x % 2 === 0 && y % 2 === 0)) return 'wall';
    return !safe.has(`${x},${y}`) && random() < 0.58 ? 'crate' : 'floor';
  }));
}
