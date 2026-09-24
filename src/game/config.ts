export type Point = { x: number; y: number };
export type Direction = 'up' | 'down' | 'left' | 'right';
export type ArenaSize = { cols: number; rows: number };

export const ARENA_PRESETS = {
  small: { cols: 17, rows: 13 },
  medium: { cols: 21, rows: 17 },
  large: { cols: 25, rows: 19 }
} as const satisfies Record<string, ArenaSize>;

export function getArenaSizeForPlayerCount(playerCount: number): ArenaSize {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 6) {
    throw new Error('playerCount must be between 1 and 6');
  }
  if (playerCount <= 2) return ARENA_PRESETS.small;
  if (playerCount <= 4) return ARENA_PRESETS.medium;
  return ARENA_PRESETS.large;
}

export const VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
};
export const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
export const key = ({ x, y }: Point): string => `${x},${y}`;
