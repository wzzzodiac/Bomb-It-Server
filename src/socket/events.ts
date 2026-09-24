import type { PublicRoomState, RoomErrorCode } from '../rooms/types.js';
import type { MatchState, MoveResult } from '../match/types.js';

export type ErrorResponse = { code: RoomErrorCode; message: string };
export type RoomAck = { ok: true; state: PublicRoomState } | { ok: false; error: ErrorResponse };
export type ActionAck = { ok: true } | { ok: false; error: ErrorResponse };
export type StartMatchAck = { ok: true; state: MatchState } | { ok: false; error: ErrorResponse };
export type InputAck = MoveResult | { ok: false; error: ErrorResponse };

export interface ClientToServerEvents {
  'room:create': (payload: unknown, acknowledge: (result: RoomAck) => void) => void;
  'room:join': (payload: unknown, acknowledge: (result: RoomAck) => void) => void;
  'room:leave': (acknowledge: (result: ActionAck) => void) => void;
  'player:set-ready': (payload: unknown, acknowledge: (result: RoomAck) => void) => void;
  'room:start-match': (acknowledge: (result: StartMatchAck) => void) => void;
  'player:input': (payload: unknown, acknowledge: (result: InputAck) => void) => void;
}

export interface ServerToClientEvents {
  'server:hello': (payload: { service: 'bomb-it-server' }) => void;
  'room:state': (state: PublicRoomState) => void;
  'room:error': (error: ErrorResponse) => void;
  'room:left': (payload: { code: string }) => void;
  'match:state': (state: MatchState) => void;
}
