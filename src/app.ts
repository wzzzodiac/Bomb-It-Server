import { createServer as createHttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ServerConfig } from './config.js';
import { RoomManager, type RoomManagerOptions } from './rooms/roomManager.js';
import { MatchManager, type MatchScheduler } from './match/matchManager.js';
import { AbuseGuard, MAX_CONCURRENT_TRANSPORTS } from './security/abuseGuard.js';
import { registerSocketHandlers } from './socket/handlers.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket/events.js';

export function createApp(config: ServerConfig, matchOptions: { now?: () => number; random?: () => number; scheduler?: MatchScheduler;
  lifecycle?: Pick<RoomManagerOptions, 'lobbyIdleMs' | 'lobbyMaxMs' | 'finishedIdleMs'>; joinTimeoutMs?: number } = {}) {
  const now = matchOptions.now ?? Date.now;
  const joinTimeoutMs = matchOptions.joinTimeoutMs ?? 15_000;
  const rooms = new RoomManager({ ...config, ...matchOptions.lifecycle, now });
  const matches = new MatchManager(rooms, matchOptions.now, matchOptions.random, matchOptions.scheduler);
  const guard = new AbuseGuard(config, now);
  const transportDeadlines = new Map<Socket['conn'], number>();
  const httpServer = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, service: 'bomb-it-server' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  const io: Server<ClientToServerEvents, ServerToClientEvents> = new Server(httpServer, {
    maxHttpBufferSize: config.maxPayloadBytes,
    cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
    allowRequest: (request, accept) => {
      const origin = request.headers.origin;
      accept(null, (origin === undefined || origin === config.clientOrigin) &&
        guard.allowConnection(request.socket.remoteAddress, io.engine.clientsCount));
    }
  });
  io.engine.on('connection', transport => {
    if (io.engine.clientsCount > MAX_CONCURRENT_TRANSPORTS) { transport.close(); return; }
    transportDeadlines.set(transport, now() + joinTimeoutMs);
    transport.once('close', () => transportDeadlines.delete(transport));
  });
  registerSocketHandlers(io, rooms, matches, guard, { now, joinTimeoutMs });
  function sweep() {
    for (const expired of rooms.expire(now())) {
      matches.closeRoom(expired.code);
      for (const id of expired.socketIds) {
        const socket = io.sockets.sockets.get(id);
        socket?.emit('room:error', { code: 'ROOM_NOT_FOUND', message: 'Room expired after inactivity.' });
        socket?.disconnect(true);
      }
    }
    const socketsByTransport = new Map([...io.sockets.sockets.values()].map(s => [s.conn, s]));
    for (const [transport, deadline] of transportDeadlines) {
      const socket = socketsByTransport.get(transport);
      if (socket && rooms.roomCodeFor(socket.id)) continue;
      if (now() >= (socket?.data.joinDeadline ?? deadline)) transport.close();
    }
    guard.prune();
  }
  const policyTimer = setInterval(sweep, 1000);
  policyTimer.unref();
  httpServer.on('close', () => { clearInterval(policyTimer); transportDeadlines.clear(); matches.dispose(); });
  return { httpServer, io, rooms, matches, guard, sweep };
}
