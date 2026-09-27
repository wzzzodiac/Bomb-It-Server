import { blastTiles, tileAt, type Arena } from './arena.js';
import { DIRECTIONS, VECTORS, key, type Direction, type Point } from './config.js';

export type BombThreat = { position: Point; range: number };

export function dangerTiles(arena: Arena, bombs: readonly BombThreat[]): Set<string> {
  return new Set(bombs.flatMap(bomb => blastTiles(arena, bomb.position, bomb.range)).map(key));
}

export function findEscapeDirection(
  arena: Arena, start: Point, bombs: readonly BombThreat[], blocked: ReadonlySet<string> = new Set(), maxSteps = 8
): Direction | null {
  const danger = dangerTiles(arena, bombs);
  if (!danger.has(key(start))) return null;
  const visited = new Set([key(start)]);
  const queue: Array<{ point: Point; first: Direction; steps: number }> = [];
  for (const direction of DIRECTIONS) {
    const step = VECTORS[direction];
    queue.push({ point: { x: start.x + step.x, y: start.y + step.y }, first: direction, steps: 1 });
  }
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const currentKey = key(current.point);
    if (visited.has(currentKey) || blocked.has(currentKey) || tileAt(arena, current.point) !== 'floor') continue;
    visited.add(currentKey);
    if (!danger.has(currentKey)) return current.first;
    if (current.steps >= maxSteps) continue;
    for (const direction of DIRECTIONS) {
      const step = VECTORS[direction];
      queue.push({ point: { x: current.point.x + step.x, y: current.point.y + step.y }, first: current.first, steps: current.steps + 1 });
    }
  }
  return null;
}

export function canEscapeBomb(arena: Arena, start: Point, bombs: readonly BombThreat[], blocked: ReadonlySet<string> = new Set()): boolean {
  return findEscapeDirection(arena, start, bombs, blocked) !== null;
}
