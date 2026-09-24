import type { Server } from 'socket.io';
import { RoomManager } from '../rooms/roomManager.js';
import { MatchManager } from '../match/matchManager.js';
import { RoomError } from '../rooms/types.js';
import { AbuseGuard, type ProtectedEvent } from '../security/abuseGuard.js';
import { parseCreatePayload, parseJoinPayload, parseMovementPayload, parseReadyPayload } from '../validation/input.js';
import type { ActionAck, ClientToServerEvents, ErrorResponse, InputAck, RoomAck, ServerToClientEvents, StartMatchAck } from './events.js';

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  rooms: RoomManager,
  matches: MatchManager,
  guard: AbuseGuard
): void {
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

    function reject(acknowledge: unknown, error: unknown): void {
      const result: ErrorResponse = error instanceof RoomError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: 'Request could not be processed.' };
      socket.emit('room:error', result);
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: result });
      if (guard.recordInvalid(socket.id, result.code)) socket.disconnect();
    }

    function respond<T extends RoomAck | ActionAck | StartMatchAck | InputAck>(event: ProtectedEvent, acknowledge: unknown, action: () => T): void {
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
      socket.join(state.code);
      io.to(state.code).emit('room:state', state);
      return { ok: true, state };
    }));

    socket.on('room:join', (payload, acknowledge) => respond('room:join', acknowledge, () => {
      const { code, nickname } = parseJoinPayload(payload);
      const state = rooms.join(socket.id, code, nickname);
      socket.join(code);
      io.to(code).emit('room:state', state);
      return { ok: true, state };
    }));

    socket.on('room:leave', acknowledge => respond('room:leave', acknowledge, () => {
      const playerId = rooms.playerIdFor(socket.id);
      const { code, state } = rooms.leave(socket.id);
      const matchState = playerId ? matches.leave(code, playerId) : null;
      socket.leave(code);
      socket.emit('room:left', { code });
      if (state) io.to(code).emit('room:state', state);
      if (matchState) io.to(code).emit('match:state', matchState);
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
      io.to(room.code).emit('match:state', match);
      return { ok: true, state: match };
    }));

    socket.on('player:input', (payload, acknowledge) => respond('player:input', acknowledge, () => {
      const { direction } = parseMovementPayload(payload);
      const result = matches.move(socket.id, direction);
      if (result.moved) {
        const code = rooms.roomCodeFor(socket.id)!;
        io.to(code).emit('match:state', matches.snapshot(code));
      }
      return result;
    }));

    socket.on('disconnect', () => {
      // Namespace disconnect can precede transport close; release is idempotent.
      guard.release(socket.id);
      const code = rooms.roomCodeFor(socket.id);
      const playerId = rooms.playerIdFor(socket.id);
      if (!code || !playerId) return;
      const { state } = rooms.leave(socket.id);
      const matchState = matches.leave(code, playerId);
      if (state) io.to(code).emit('room:state', state);
      if (matchState) io.to(code).emit('match:state', matchState);
    });
  });
}
