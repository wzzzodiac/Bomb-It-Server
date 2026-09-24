export const MAX_ROOMS = 5;
export const MAX_PLAYERS_PER_ROOM = 6;
export const MAX_NICKNAME_LENGTH = 18;
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_CONNECTIONS_PER_IP = 10;
export const MAX_EVENTS_PER_WINDOW = 40;
export const EVENT_WINDOW_MS = 10_000;
export const MAX_ROOM_CREATES_PER_WINDOW = 3;
export const ROOM_CREATE_WINDOW_MS = 60_000;
export const MAX_INVALID_REQUESTS = 8;
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_INPUTS_PER_WINDOW = 120;
export const INPUT_WINDOW_MS = 10_000;

export type ServerConfig = {
  port: number;
  clientOrigin: string;
  maxRooms: number;
  maxPlayersPerRoom: number;
  maxConnectionsPerIp: number;
  maxEventsPerWindow: number;
  eventWindowMs: number;
  maxRoomCreatesPerWindow: number;
  roomCreateWindowMs: number;
  maxInvalidRequests: number;
  maxPayloadBytes: number;
  maxInputsPerWindow: number;
  inputWindowMs: number;
};

function boundedInteger(value: string | undefined, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
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
    maxPlayersPerRoom: boundedInteger(env.MAX_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM),
    maxConnectionsPerIp: boundedInteger(env.MAX_CONNECTIONS_PER_IP, MAX_CONNECTIONS_PER_IP, 20),
    maxEventsPerWindow: boundedInteger(env.MAX_EVENTS_PER_WINDOW, MAX_EVENTS_PER_WINDOW, 80),
    eventWindowMs: boundedInteger(env.EVENT_WINDOW_MS, EVENT_WINDOW_MS, 60_000, 5000),
    maxRoomCreatesPerWindow: boundedInteger(env.MAX_ROOM_CREATES_PER_WINDOW, MAX_ROOM_CREATES_PER_WINDOW, 6),
    roomCreateWindowMs: boundedInteger(env.ROOM_CREATE_WINDOW_MS, ROOM_CREATE_WINDOW_MS, 300_000, 30_000),
    maxInvalidRequests: boundedInteger(env.MAX_INVALID_REQUESTS, MAX_INVALID_REQUESTS, 12),
    maxPayloadBytes: boundedInteger(env.MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES, 8192, 512),
    maxInputsPerWindow: boundedInteger(env.MAX_INPUTS_PER_WINDOW, MAX_INPUTS_PER_WINDOW, 240, 80),
    inputWindowMs: boundedInteger(env.INPUT_WINDOW_MS, INPUT_WINDOW_MS, 10_000, 5000)
  };
}
