import type { Server } from 'socket.io';
import { RoomManager } from '../rooms/roomManager.js';
import { MatchManager } from '../match/matchManager.js';
import { RoomError } from '../rooms/types.js';
import { AbuseGuard, type ProtectedEvent } from '../security/abuseGuard.js';
import { parseBombPayload, parseCreatePayload, parseJoinPayload, parseMovementPayload, parseReadyPayload } from '../validation/input.js';
import type { ActionAck, BombAck, ClientToServerEvents, ErrorResponse, InputAck, MembershipAck, RoomAck, ServerToClientEvents, StartMatchAck } from './events.js';

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  rooms: RoomManager,
  matches: MatchManager,
  guard: AbuseGuard
): void {
  matches.setPublisher((code, publication) => {
    if (publication.explosion) io.to(code).emit('match:explosion', publication.explosion);
    io.to(code).emit('match:state', publication.state);
    if (publication.result) io.to(code).emit('match:result', publication.result);
    if (publication.roomFinished) io.to(code).emit('room:state', rooms.state(code));
  });
  io.use((socket, next) => {
    if (!guard.admit(socket.id, socket.handshake.address)) {
      next(new Error('Too many connections.'));
      return;
    }
    socket.conn.once('close', () => guard.release(socket.id));
    next();
  });

  io.on('connection', socket => {
    socket.emit('server:hello', { service: 'bomb-it-server' });

    function leaveJoinedRoom() {
      const playerId = rooms.playerIdFor(socket.id);
      const { code, state } = rooms.leave(socket.id);
      if (playerId) matches.leave(code, playerId);
      return { code, state: state ? rooms.state(code) : null };
    }

    function reject(acknowledge: unknown, error: unknown): void {
      const result: ErrorResponse = error instanceof RoomError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: 'Request could not be processed.' };
      socket.emit('room:error', result);
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: result });
      if (guard.recordInvalid(socket.id, result.code)) socket.disconnect();
    }

    function respond<T extends MembershipAck | RoomAck | ActionAck | StartMatchAck | InputAck | BombAck>(event: ProtectedEvent, acknowledge: unknown, action: () => T): void {
      if (!guard.allowEvent(socket.id, event)) {
        reject(acknowledge, new RoomError('RATE_LIMITED', 'Too many requests. Try again shortly.'));
        return;
      }
      if (typeof acknowledge !== 'function') {
        reject(acknowledge, new RoomError('INVALID_PAYLOAD', 'Acknowledgement callback is required.'));
        return;
      }
      let result: T;
      try {
        result = action();
      } catch (error) {
        reject(acknowledge, error);
        return;
      }
      acknowledge(result);
    }

    socket.on('room:create', (payload, acknowledge) => respond('room:create', acknowledge, () => {
      const { nickname } = parseCreatePayload(payload);
      const state = rooms.create(socket.id, nickname);
      const selfPlayerId = rooms.playerIdFor(socket.id);
      if (!selfPlayerId) throw new Error('Room membership was not created.');
      socket.join(state.code);
      io.to(state.code).emit('room:state', state);
      return { ok: true, state, selfPlayerId };
    }));

    socket.on('room:join', (payload, acknowledge) => respond('room:join', acknowledge, () => {
      const { code, nickname } = parseJoinPayload(payload);
      const state = rooms.join(socket.id, code, nickname);
      const selfPlayerId = rooms.playerIdFor(socket.id);
      if (!selfPlayerId) throw new Error('Room membership was not created.');
      socket.join(code);
      io.to(code).emit('room:state', state);
      return { ok: true, state, selfPlayerId };
    }));

    socket.on('room:leave', acknowledge => respond('room:leave', acknowledge, () => {
      const { code, state } = leaveJoinedRoom();
      socket.leave(code);
      socket.emit('room:left', { code });
      if (state) io.to(code).emit('room:state', state);
      return { ok: true };
    }));

    socket.on('player:set-ready', (payload, acknowledge) => respond('player:set-ready', acknowledge, () => {
      const { ready } = parseReadyPayload(payload);
      const state = rooms.setReady(socket.id, ready);
      io.to(state.code).emit('room:state', state);
      return { ok: true, state };
    }));

    socket.on('room:start-match', acknowledge => respond('room:start-match', acknowledge, () => {
      const { room, match } = matches.start(socket.id);
      io.to(room.code).emit('room:state', room);
      io.to(room.code).emit('match:started', match);
      return { ok: true, state: match };
    }));

    socket.on('player:input', (payload, acknowledge) => respond('player:input', acknowledge, () => {
      const { direction } = parseMovementPayload(payload);
      const result = matches.move(socket.id, direction);
      return result;
    }));

    socket.on('player:place-bomb', (payload, acknowledge) => respond('player:place-bomb', acknowledge, () => {
      parseBombPayload(payload);
      return matches.placeBomb(socket.id);
    }));

    socket.on('disconnect', () => {
      // Namespace disconnect can precede transport close; release is idempotent.
      guard.release(socket.id);
      const code = rooms.roomCodeFor(socket.id);
      if (!code) return;
      const { state } = leaveJoinedRoom();
      if (state) io.to(code).emit('room:state', state);
    });
  });
}
