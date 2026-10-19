import { randomInt, randomUUID } from 'node:crypto';
import { MAX_PLAYERS_PER_ROOM, MAX_ROOMS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../config.js';
import { RoomError, type Player, type PublicRoomState, type Room } from './types.js';

export type RoomManagerOptions = {
  maxRooms?: number;
  maxPlayersPerRoom?: number;
  makeCode?: () => string;
  makePlayerId?: () => string;
  now?: () => number;
  lobbyIdleMs?: number;
  lobbyMaxMs?: number;
  finishedIdleMs?: number;
};

function randomRoomCode(): string {
  return Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join('');
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly membership = new Map<string, { code: string; playerId: string }>();
  private readonly maxRooms: number;
  private readonly maxPlayersPerRoom: number;
  private readonly makeCode: () => string;
  private readonly makePlayerId: () => string;
  private readonly now: () => number;
  private readonly lifecycle: { lobbyIdleMs: number; lobbyMaxMs: number; finishedIdleMs: number };

  constructor(options: RoomManagerOptions = {}) {
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.maxPlayersPerRoom = options.maxPlayersPerRoom ?? MAX_PLAYERS_PER_ROOM;
    this.makeCode = options.makeCode ?? randomRoomCode;
    this.makePlayerId = options.makePlayerId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.lifecycle = { lobbyIdleMs: options.lobbyIdleMs ?? 15 * 60_000,
      lobbyMaxMs: options.lobbyMaxMs ?? 60 * 60_000, finishedIdleMs: options.finishedIdleMs ?? 5 * 60_000 };
    if (!Number.isInteger(this.maxRooms) || this.maxRooms < 1 || this.maxRooms > MAX_ROOMS ||
        !Number.isInteger(this.maxPlayersPerRoom) || this.maxPlayersPerRoom < 1 || this.maxPlayersPerRoom > MAX_PLAYERS_PER_ROOM) {
      throw new Error('Room limits must stay within product limits.');
    }
  }

  get roomCount(): number { return this.rooms.size; }

  create(socketId: string, nickname: string): PublicRoomState {
    this.ensureAvailable(socketId);
    if (this.rooms.size >= this.maxRooms) throw new RoomError('ROOM_LIMIT_REACHED', 'Room limit reached.');
    let code: string | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = this.makeCode();
      if (!this.rooms.has(candidate)) { code = candidate; break; }
    }
    if (!code) throw new RoomError('INTERNAL_ERROR', 'Could not allocate a room code.');
    const player = this.player(socketId, nickname);
    this.rooms.set(code, { code, hostPlayerId: player.id, status: 'lobby', players: [player],
      createdAt: this.now(), lobbyOpenedAt: this.now(), lastLobbyActivityAt: this.now(), finishedAt: null, nextBotNumber: 1 });
    this.membership.set(socketId, { code, playerId: player.id });
    return this.state(code);
  }

  join(socketId: string, code: string, nickname: string): PublicRoomState {
    this.ensureAvailable(socketId);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found.');
    if (room.status !== 'lobby') throw new RoomError('ROOM_NOT_JOINABLE', 'Room is not in the lobby.');
    if (room.players.length >= this.maxPlayersPerRoom) throw new RoomError('ROOM_FULL', 'Room is full.');
    const player = this.player(socketId, nickname);
    room.players.push(player);
    this.membership.set(socketId, { code, playerId: player.id });
    this.touchLobby(room);
    return this.state(code);
  }

  leave(socketId: string): { code: string; state: PublicRoomState | null } {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    this.membership.delete(socketId);
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    room.players = room.players.filter(player => player.id !== member.playerId);
    if (!room.players.some(player => player.kind === 'human')) {
      this.rooms.delete(room.code);
      return { code: room.code, state: null };
    }
    if (room.hostPlayerId === member.playerId) {
      const nextHost = room.players.find(player => player.kind === 'human');
      if (!nextHost) throw new Error('Room has no human host candidate.');
      room.hostPlayerId = nextHost.id;
    }
    this.touchLobby(room);
    return { code: room.code, state: this.state(room.code) };
  }

  setReady(socketId: string, ready: boolean): PublicRoomState {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    if (room.status !== 'lobby') throw new RoomError('ROOM_NOT_JOINABLE', 'Room is not in the lobby.');
    const player = room.players.find(candidate => candidate.id === member.playerId);
    if (!player) throw new Error('Player membership is inconsistent.');
    if (player.ready !== ready) { player.ready = ready; this.touchLobby(room); }
    return this.state(room.code);
  }

  addBot(socketId: string): PublicRoomState {
    const room = this.hostLobby(socketId);
    if (room.players.length >= this.maxPlayersPerRoom) throw new RoomError('ROOM_FULL', 'Room is full.');
    const number = room.nextBotNumber++;
    room.players.push({ id: this.makePlayerId(), kind: 'bot', nickname: `Bot ${number}`, ready: true, connected: true });
    this.touchLobby(room);
    return this.state(room.code);
  }

  removeBot(socketId: string, botId: string): PublicRoomState {
    const room = this.hostLobby(socketId);
    const index = room.players.findIndex(player => player.id === botId && player.kind === 'bot');
    if (index < 0) throw new RoomError('BOT_NOT_FOUND', 'Bot not found.');
    room.players.splice(index, 1);
    this.touchLobby(room);
    return this.state(room.code);
  }

  private hostLobby(socketId: string): Room {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    if (room.status !== 'lobby') throw new RoomError('ROOM_NOT_JOINABLE', 'Room is not in the lobby.');
    if (room.hostPlayerId !== member.playerId) throw new RoomError('NOT_HOST', 'Only the host can manage bots.');
    return room;
  }

  prepareMatchStart(socketId: string): { code: string; players: Array<{ id: string; nickname: string; kind: 'human' | 'bot' }> } {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    if (room.status !== 'lobby') throw new RoomError('MATCH_ALREADY_STARTED', 'Match already started.');
    if (room.hostPlayerId !== member.playerId) throw new RoomError('NOT_HOST', 'Only the host can start.');
    if (room.players.length < 2) throw new RoomError('NOT_ENOUGH_PLAYERS', 'At least two players are required.');
    if (room.players.some(player => !player.ready)) throw new RoomError('PLAYERS_NOT_READY', 'All players must be ready.');
    return { code: room.code, players: room.players.map(player => ({ id: player.id, nickname: player.nickname, kind: player.kind })) };
  }

  commitMatchStart(socketId: string): PublicRoomState {
    const { code } = this.prepareMatchStart(socketId);
    const state = this.state(code);
    const room = this.rooms.get(code)!;
    room.status = 'playing';
    return { ...state, status: 'playing' };
  }

  finishMatch(code: string): PublicRoomState {
    const room = this.rooms.get(code);
    if (!room) throw new Error('Room was removed before match finished.');
    room.status = 'finished';
    room.finishedAt = this.now();
    return this.state(code);
  }

  returnToLobby(socketId: string): PublicRoomState {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    if (room.status !== 'finished') throw new RoomError('MATCH_NOT_FINISHED', 'Match has not finished.');
    room.status = 'lobby';
    room.lobbyOpenedAt = this.now();
    room.lastLobbyActivityAt = this.now();
    room.finishedAt = null;
    for (const player of room.players) player.ready = player.kind === 'bot';
    return this.state(room.code);
  }

  roomCodeFor(socketId: string): string | undefined { return this.membership.get(socketId)?.code; }
  playerIdFor(socketId: string): string | undefined { return this.membership.get(socketId)?.playerId; }

  private touchLobby(room: Room): void {
    if (room.status === 'lobby') room.lastLobbyActivityAt = this.now();
  }

  expire(now = this.now()): Array<{ code: string; socketIds: string[] }> {
    const expired: Array<{ code: string; socketIds: string[] }> = [];
    for (const room of this.rooms.values()) {
      const staleLobby = room.status === 'lobby' &&
        (now - room.lastLobbyActivityAt >= this.lifecycle.lobbyIdleMs || now - room.lobbyOpenedAt >= this.lifecycle.lobbyMaxMs);
      const staleResult = room.status === 'finished' && room.finishedAt !== null && now - room.finishedAt >= this.lifecycle.finishedIdleMs;
      if (!staleLobby && !staleResult) continue;
      const socketIds = room.players.flatMap(player => player.socketId ? [player.socketId] : []);
      for (const id of socketIds) this.membership.delete(id);
      this.rooms.delete(room.code);
      expired.push({ code: room.code, socketIds });
    }
    return expired;
  }

  state(code: string): PublicRoomState {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found.');
    return {
      code: room.code,
      status: room.status,
      hostPlayerId: room.hostPlayerId,
      players: room.players.map(player => ({
        id: player.id, nickname: player.nickname, ready: player.ready, host: player.id === room.hostPlayerId, kind: player.kind
      }))
    };
  }

  private ensureAvailable(socketId: string): void {
    if (this.membership.has(socketId)) throw new RoomError('ALREADY_IN_ROOM', 'Socket is already in a room.');
  }

  private player(socketId: string, nickname: string): Player {
    return { id: this.makePlayerId(), kind: 'human', socketId, nickname, ready: false, connected: true };
  }
}
