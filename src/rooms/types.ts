export type RoomStatus = 'lobby' | 'playing' | 'finished';

export type Player = {
  id: string;
  socketId: string;
  nickname: string;
  ready: boolean;
  connected: boolean;
};

export type Room = {
  code: string;
  hostPlayerId: string;
  status: RoomStatus;
  players: Player[];
  createdAt: number;
};

export type PublicRoomState = {
  code: string;
  status: RoomStatus;
  hostPlayerId: string;
  players: Array<{ id: string; nickname: string; ready: boolean; host: boolean }>;
};

export type RoomErrorCode =
  | 'INVALID_PAYLOAD' | 'INVALID_NICKNAME' | 'INVALID_ROOM_CODE' | 'INVALID_READY'
  | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ROOM_LIMIT_REACHED'
  | 'ALREADY_IN_ROOM' | 'NOT_IN_ROOM' | 'ROOM_NOT_JOINABLE' | 'RATE_LIMITED' | 'INTERNAL_ERROR';

export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode, message: string) {
    super(message);
    this.name = 'RoomError';
  }
}
