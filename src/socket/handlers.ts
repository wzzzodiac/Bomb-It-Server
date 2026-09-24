import type { Server } from 'socket.io';
import { RoomManager } from '../rooms/roomManager.js';
import { RoomError } from '../rooms/types.js';
import { AbuseGuard, type ProtectedEvent } from '../security/abuseGuard.js';
import { parseCreatePayload, parseJoinPayload, parseReadyPayload } from '../validation/input.js';
import type { ActionAck, ClientToServerEvents, ErrorResponse, RoomAck, ServerToClientEvents } from './events.js';

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  rooms: RoomManager,
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

    function respond<T extends RoomAck | ActionAck>(event: ProtectedEvent, acknowledge: unknown, action: () => T): void {
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
      const { code, state } = rooms.leave(socket.id);
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

    socket.on('disconnect', () => {
      guard.release(socket.id);
      if (!rooms.roomCodeFor(socket.id)) return;
      const { code, state } = rooms.leave(socket.id);
      if (state) io.to(code).emit('room:state', state);
    });
  });
}
