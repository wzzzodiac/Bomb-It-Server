import type { PublicRoomState, RoomErrorCode } from '../rooms/types.js';
import type { BombResult, InitialMatchState, MatchExplosion, MatchResult, MatchState, MoveResult } from '../match/types.js';

export type ErrorResponse = { code: RoomErrorCode; message: string };
export type RoomAck = { ok: true; state: PublicRoomState } | { ok: false; error: ErrorResponse };
export type MembershipAck = { ok: true; state: PublicRoomState; selfPlayerId: string } | { ok: false; error: ErrorResponse };
export type ActionAck = { ok: true } | { ok: false; error: ErrorResponse };
export type StartMatchAck = { ok: true; state: InitialMatchState } | { ok: false; error: ErrorResponse };
export type InputAck = MoveResult | { ok: false; error: ErrorResponse };
export type BombAck = BombResult | { ok: false; error: ErrorResponse };

export interface ClientToServerEvents {
  'room:create': (payload: unknown, acknowledge: (result: MembershipAck) => void) => void;
  'room:join': (payload: unknown, acknowledge: (result: MembershipAck) => void) => void;
  'room:leave': (acknowledge: (result: ActionAck) => void) => void;
  'room:return-to-lobby': (acknowledge: (result: RoomAck) => void) => void;
  'room:add-bot': (payload: unknown, acknowledge: (result: RoomAck) => void) => void;
  'room:remove-bot': (payload: unknown, acknowledge: (result: RoomAck) => void) => void;
  'player:set-ready': (payload: unknown, acknowledge: (result: RoomAck) => void) => void;
  'room:start-match': (acknowledge: (result: StartMatchAck) => void) => void;
  'player:input': (payload: unknown, acknowledge: (result: InputAck) => void) => void;
  'player:place-bomb': (payload: unknown, acknowledge: (result: BombAck) => void) => void;
}

export interface ServerToClientEvents {
  'server:hello': (payload: { service: 'bomb-it-server' }) => void;
  'room:state': (state: PublicRoomState) => void;
  'room:error': (error: ErrorResponse) => void;
  'room:left': (payload: { code: string }) => void;
  'room:reset': (state: PublicRoomState) => void;
  'match:started': (state: InitialMatchState) => void;
  'match:state': (state: MatchState) => void;
  'match:explosion': (event: MatchExplosion) => void;
  'match:result': (result: MatchResult) => void;
}
