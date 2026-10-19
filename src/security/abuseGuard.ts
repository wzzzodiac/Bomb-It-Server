import type { ServerConfig } from '../config.js';
import type { RoomErrorCode } from '../rooms/types.js';

export type ProtectedEvent = 'room:create' | 'room:join' | 'room:leave' | 'room:return-to-lobby' | 'room:add-bot' | 'room:remove-bot' | 'player:set-ready' | 'room:start-match' | 'player:input' | 'player:place-bomb';

type Window = { startedAt: number; count: number };
type SocketUsage = { address: string; events: Window; creates: Window; inputs: Window; packets: Window; rateRejections: Window; invalidRequests: number };

export const MAX_CONCURRENT_TRANSPORTS = 40;
const MAX_TRACKED_ADDRESSES = 1024;
type AbuseLimits = Pick<ServerConfig,
  'maxConnectionsPerIp' | 'maxEventsPerWindow' | 'eventWindowMs' |
  'maxRoomCreatesPerWindow' | 'roomCreateWindowMs' | 'maxInvalidRequests' |
  'maxInputsPerWindow' | 'inputWindowMs'>;

const INVALID_CODES: ReadonlySet<RoomErrorCode> = new Set([
  'INVALID_PAYLOAD', 'INVALID_NICKNAME', 'INVALID_ROOM_CODE', 'INVALID_READY', 'RATE_LIMITED'
]);

// Use the transport peer address. Forwarded headers are not trusted without a configured proxy boundary.
export function resolveClientAddress(address: string | undefined): string {
  if (!address) return 'unknown';
  const normalized = address.toLowerCase();
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}

export class AbuseGuard {
  private readonly sockets = new Map<string, SocketUsage>();
  private readonly connectionsByAddress = new Map<string, number>();
  private readonly opensByAddress = new Map<string, Window>();
  private readonly createsByAddress = new Map<string, Window>();

  constructor(private readonly limits: AbuseLimits, private readonly now: () => number = Date.now) {}

  get activeSocketCount(): number { return this.sockets.size; }
  get trackedAddressCount(): number { return this.connectionsByAddress.size; }

  prune(): void {
    const now = this.now();
    for (const [address, window] of this.opensByAddress)
      if (now - window.startedAt >= 60_000) this.opensByAddress.delete(address);
    for (const [address, window] of this.createsByAddress)
      if (now - window.startedAt >= this.limits.roomCreateWindowMs) this.createsByAddress.delete(address);
  }

  allowConnection(address: string | undefined, activeTransports: number): boolean {
    if (activeTransports >= MAX_CONCURRENT_TRANSPORTS) return false;
    this.prune();
    const resolved = resolveClientAddress(address);
    let window = this.opensByAddress.get(resolved);
    if (!window) {
      if (this.opensByAddress.size >= MAX_TRACKED_ADDRESSES) return false;
      window = { startedAt: this.now(), count: 0 };
      this.opensByAddress.set(resolved, window);
    }
    return this.consume(window, 80, 60_000, this.now());
  }

  allowPacket(socketId: string): boolean {
    const usage = this.sockets.get(socketId);
    return !!usage && this.consume(usage.packets,
      Math.max(60, this.limits.maxEventsPerWindow + this.limits.maxInputsPerWindow), 1000, this.now());
  }

  admit(socketId: string, address: string): boolean {
    if (this.sockets.has(socketId)) return false;
    const resolved = resolveClientAddress(address);
    const count = this.connectionsByAddress.get(resolved) ?? 0;
    if (count >= this.limits.maxConnectionsPerIp) return false;
    const startedAt = this.now();
    this.sockets.set(socketId, {
      address: resolved,
      events: { startedAt, count: 0 },
      creates: { startedAt, count: 0 },
      inputs: { startedAt, count: 0 },
      packets: { startedAt, count: 0 },
      rateRejections: { startedAt, count: 0 },
      invalidRequests: 0
    });
    this.connectionsByAddress.set(resolved, count + 1);
    return true;
  }

  allowEvent(socketId: string, event: ProtectedEvent): boolean {
    const usage = this.sockets.get(socketId);
    if (!usage) return false;
    const now = this.now();
    if (event === 'player:input' || event === 'player:place-bomb') return this.consume(usage.inputs, this.limits.maxInputsPerWindow, this.limits.inputWindowMs, now);
    if (!this.consume(usage.events, this.limits.maxEventsPerWindow, this.limits.eventWindowMs, now)) return false;
    if (event !== 'room:create') return true;
    if (!this.consume(usage.creates, this.limits.maxRoomCreatesPerWindow, this.limits.roomCreateWindowMs, now)) return false;
    this.prune();
    let addressWindow = this.createsByAddress.get(usage.address);
    if (!addressWindow) {
      if (this.createsByAddress.size >= MAX_TRACKED_ADDRESSES) return false;
      addressWindow = { startedAt: now, count: 0 };
      this.createsByAddress.set(usage.address, addressWindow);
    }
    // Allow five households/players behind one peer to reserve all five rooms,
    // while retaining a bounded creation budget across socket reconnects.
    return this.consume(addressWindow, Math.max(5, this.limits.maxRoomCreatesPerWindow * 2), this.limits.roomCreateWindowMs, now);
  }

  recordInvalid(socketId: string, code: RoomErrorCode): boolean {
    const usage = this.sockets.get(socketId);
    if (!usage || !INVALID_CODES.has(code)) return false;
    if (code === 'RATE_LIMITED') return !this.consume(usage.rateRejections,
      this.limits.maxInvalidRequests - 1, this.limits.eventWindowMs, this.now());
    usage.invalidRequests++;
    return usage.invalidRequests >= this.limits.maxInvalidRequests;
  }

  release(socketId: string): void {
    const usage = this.sockets.get(socketId);
    if (!usage) return;
    this.sockets.delete(socketId);
    const count = this.connectionsByAddress.get(usage.address) ?? 0;
    if (count <= 1) this.connectionsByAddress.delete(usage.address);
    else this.connectionsByAddress.set(usage.address, count - 1);
  }

  private consume(window: Window, maximum: number, durationMs: number, now: number): boolean {
    if (now < window.startedAt || now - window.startedAt >= durationMs) {
      window.startedAt = now;
      window.count = 0;
    }
    if (window.count >= maximum) return false;
    window.count++;
    return true;
  }
}
