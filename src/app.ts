import { createServer as createHttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ServerConfig } from './config.js';
import { RoomManager } from './rooms/roomManager.js';
import { registerSocketHandlers } from './socket/handlers.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket/events.js';

export function createApp(config: ServerConfig) {
  const rooms = new RoomManager(config);
  const httpServer = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, service: 'bomb-it-server' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
    allowRequest: (request, accept) => {
      const origin = request.headers.origin;
      accept(null, origin === undefined || origin === config.clientOrigin);
    }
  });
  registerSocketHandlers(io, rooms);
  return { httpServer, io, rooms };
}
