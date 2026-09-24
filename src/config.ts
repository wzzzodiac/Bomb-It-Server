export const MAX_ROOMS = 5;
export const MAX_PLAYERS_PER_ROOM = 6;
export const MAX_NICKNAME_LENGTH = 18;
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type ServerConfig = {
  port: number;
  clientOrigin: string;
  maxRooms: number;
  maxPlayersPerRoom: number;
};

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const origin = env.CLIENT_ORIGIN?.trim() || 'http://localhost:5173';
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error('CLIENT_ORIGIN must be a single HTTP(S) origin');
  }
  return {
    port: boundedInteger(env.PORT, 8080, 65535),
    clientOrigin: origin,
    maxRooms: boundedInteger(env.MAX_ROOMS, MAX_ROOMS, MAX_ROOMS),
    maxPlayersPerRoom: boundedInteger(env.MAX_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM)
  };
}
