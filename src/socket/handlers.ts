import type { Server } from 'socket.io';
import { RoomManager } from '../rooms/roomManager.js';
import { RoomError } from '../rooms/types.js';
import { parseCreatePayload, parseJoinPayload, parseReadyPayload } from '../validation/input.js';
import type { ActionAck, ClientToServerEvents, ErrorResponse, RoomAck, ServerToClientEvents } from './events.js';

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  rooms: RoomManager
): void {
  io.on('connection', socket => {
    socket.emit('server:hello', { service: 'bomb-it-server' });

    function fail(error: unknown): ErrorResponse {
      const result: ErrorResponse = error instanceof RoomError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: 'Request could not be processed.' };
      socket.emit('room:error', result);
      return result;
    }

    function respond<T extends RoomAck | ActionAck>(acknowledge: unknown, action: () => T): void {
      if (typeof acknowledge !== 'function') {
        fail(new RoomError('INVALID_PAYLOAD', 'Acknowledgement callback is required.'));
        return;
      }
      let result: T;
      try {
        result = action();
      } catch (error) {
        acknowledge({ ok: false, error: fail(error) });
        return;
      }
      acknowledge(result);
    }

    socket.on('room:create', (payload, acknowledge) => respond(acknowledge, () => {
      const { nickname } = parseCreatePayload(payload);
      const state = rooms.create(socket.id, nickname);
      socket.join(state.code);
      io.to(state.code).emit('room:state', state);
      return { ok: true, state };
    }));

    socket.on('room:join', (payload, acknowledge) => respond(acknowledge, () => {
      const { code, nickname } = parseJoinPayload(payload);
      const state = rooms.join(socket.id, code, nickname);
      socket.join(code);
      io.to(code).emit('room:state', state);
      return { ok: true, state };
    }));

    socket.on('room:leave', acknowledge => respond(acknowledge, () => {
      const { code, state } = rooms.leave(socket.id);
      socket.leave(code);
      socket.emit('room:left', { code });
      if (state) io.to(code).emit('room:state', state);
      return { ok: true };
    }));

    socket.on('player:set-ready', (payload, acknowledge) => respond(acknowledge, () => {
      const { ready } = parseReadyPayload(payload);
      const state = rooms.setReady(socket.id, ready);
      io.to(state.code).emit('room:state', state);
      return { ok: true, state };
    }));

    socket.on('disconnect', () => {
      if (!rooms.roomCodeFor(socket.id)) return;
      const { code, state } = rooms.leave(socket.id);
      if (state) io.to(code).emit('room:state', state);
    });
  });
}
