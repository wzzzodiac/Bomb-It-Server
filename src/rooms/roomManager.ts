import { randomInt, randomUUID } from 'node:crypto';
import { MAX_PLAYERS_PER_ROOM, MAX_ROOMS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../config.js';
import { RoomError, type Player, type PublicRoomState, type Room } from './types.js';

type RoomManagerOptions = {
  maxRooms?: number;
  maxPlayersPerRoom?: number;
  makeCode?: () => string;
  makePlayerId?: () => string;
  now?: () => number;
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

  constructor(options: RoomManagerOptions = {}) {
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.maxPlayersPerRoom = options.maxPlayersPerRoom ?? MAX_PLAYERS_PER_ROOM;
    this.makeCode = options.makeCode ?? randomRoomCode;
    this.makePlayerId = options.makePlayerId ?? randomUUID;
    this.now = options.now ?? Date.now;
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
    this.rooms.set(code, { code, hostPlayerId: player.id, status: 'lobby', players: [player], createdAt: this.now() });
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
    return this.state(code);
  }

  leave(socketId: string): { code: string; state: PublicRoomState | null } {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    this.membership.delete(socketId);
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    room.players = room.players.filter(player => player.id !== member.playerId);
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return { code: room.code, state: null };
    }
    if (room.hostPlayerId === member.playerId) room.hostPlayerId = room.players[0]!.id;
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
    player.ready = ready;
    return this.state(room.code);
  }

  startMatch(socketId: string): { state: PublicRoomState; players: Array<{ id: string; nickname: string }> } {
    const member = this.membership.get(socketId);
    if (!member) throw new RoomError('NOT_IN_ROOM', 'Socket is not in a room.');
    const room = this.rooms.get(member.code);
    if (!room) throw new Error('Room membership is inconsistent.');
    if (room.status !== 'lobby') throw new RoomError('MATCH_ALREADY_STARTED', 'Match already started.');
    if (room.hostPlayerId !== member.playerId) throw new RoomError('NOT_HOST', 'Only the host can start.');
    if (room.players.length < 2) throw new RoomError('NOT_ENOUGH_PLAYERS', 'At least two players are required.');
    if (room.players.some(player => !player.ready)) throw new RoomError('PLAYERS_NOT_READY', 'All players must be ready.');
    room.status = 'playing';
    return { state: this.state(room.code), players: room.players.map(player => ({ id: player.id, nickname: player.nickname })) };
  }

  roomCodeFor(socketId: string): string | undefined { return this.membership.get(socketId)?.code; }
  playerIdFor(socketId: string): string | undefined { return this.membership.get(socketId)?.playerId; }

  state(code: string): PublicRoomState {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found.');
    return {
      code: room.code,
      status: room.status,
      hostPlayerId: room.hostPlayerId,
      players: room.players.map(player => ({
        id: player.id, nickname: player.nickname, ready: player.ready, host: player.id === room.hostPlayerId
      }))
    };
  }

  private ensureAvailable(socketId: string): void {
    if (this.membership.has(socketId)) throw new RoomError('ALREADY_IN_ROOM', 'Socket is already in a room.');
  }

  private player(socketId: string, nickname: string): Player {
    return { id: this.makePlayerId(), socketId, nickname, ready: false, connected: true };
  }
}
