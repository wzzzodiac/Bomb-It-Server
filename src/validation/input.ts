import { MAX_NICKNAME_LENGTH, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../config.js';
import { RoomError } from '../rooms/types.js';
import { VECTORS, type Direction } from '../game/config.js';

function oneField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RoomError('INVALID_PAYLOAD', 'Expected an object payload.');
  }
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== field) {
    throw new RoomError('INVALID_PAYLOAD', `Expected only ${field}.`);
  }
  return entries[0][1];
}

export function parseNickname(value: unknown): string {
  if (typeof value !== 'string') throw new RoomError('INVALID_NICKNAME', 'Nickname must be text.');
  const nickname = value.trim().replace(/\s+/gu, ' ');
  if (!nickname || [...nickname].length > MAX_NICKNAME_LENGTH) {
    throw new RoomError('INVALID_NICKNAME', `Nickname must be 1–${MAX_NICKNAME_LENGTH} characters.`);
  }
  return nickname;
}

export function parseRoomCode(value: unknown): string {
  if (typeof value !== 'string') throw new RoomError('INVALID_ROOM_CODE', 'Room code must be text.');
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH || [...code].some(character => !ROOM_CODE_ALPHABET.includes(character))) {
    throw new RoomError('INVALID_ROOM_CODE', 'Room code is invalid.');
  }
  return code;
}

export function parseReady(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new RoomError('INVALID_READY', 'Ready must be true or false.');
  return value;
}

export function parseCreatePayload(value: unknown): { nickname: string } {
  return { nickname: parseNickname(oneField(value, 'nickname')) };
}

export function parseJoinPayload(value: unknown): { code: string; nickname: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RoomError('INVALID_PAYLOAD', 'Expected an object payload.');
  }
  const entries = Object.keys(value);
  if (entries.length !== 2 || !entries.includes('code') || !entries.includes('nickname')) {
    throw new RoomError('INVALID_PAYLOAD', 'Expected code and nickname.');
  }
  const payload = value as Record<string, unknown>;
  return { code: parseRoomCode(payload.code), nickname: parseNickname(payload.nickname) };
}

export function parseReadyPayload(value: unknown): { ready: boolean } {
  return { ready: parseReady(oneField(value, 'ready')) };
}

export function parseMovementPayload(value: unknown): { direction: Direction } {
  const direction = oneField(value, 'direction');
  if (typeof direction !== 'string' || !Object.hasOwn(VECTORS, direction)) {
    throw new RoomError('INVALID_PAYLOAD', 'Direction is invalid.');
  }
  return { direction: direction as Direction };
}
