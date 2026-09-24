import type { ServerConfig } from '../config.js';
import type { RoomErrorCode } from '../rooms/types.js';

export type ProtectedEvent = 'room:create' | 'room:join' | 'room:leave' | 'player:set-ready' | 'room:start-match' | 'player:input';

type Window = { startedAt: number; count: number };
type SocketUsage = { address: string; events: Window; creates: Window; inputs: Window; invalidRequests: number };
type AbuseLimits = Pick<ServerConfig,
  'maxConnectionsPerIp' | 'maxEventsPerWindow' | 'eventWindowMs' |
  'maxRoomCreatesPerWindow' | 'roomCreateWindowMs' | 'maxInvalidRequests' |
  'maxInputsPerWindow' | 'inputWindowMs'>;

const INVALID_CODES: ReadonlySet<RoomErrorCode> = new Set([
  'INVALID_PAYLOAD', 'INVALID_NICKNAME', 'INVALID_ROOM_CODE', 'INVALID_READY'
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

  constructor(private readonly limits: AbuseLimits, private readonly now: () => number = Date.now) {}

  get activeSocketCount(): number { return this.sockets.size; }
  get trackedAddressCount(): number { return this.connectionsByAddress.size; }

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
      invalidRequests: 0
    });
    this.connectionsByAddress.set(resolved, count + 1);
    return true;
  }

  allowEvent(socketId: string, event: ProtectedEvent): boolean {
    const usage = this.sockets.get(socketId);
    if (!usage) return false;
    const now = this.now();
    if (event === 'player:input') return this.consume(usage.inputs, this.limits.maxInputsPerWindow, this.limits.inputWindowMs, now);
    if (!this.consume(usage.events, this.limits.maxEventsPerWindow, this.limits.eventWindowMs, now)) return false;
    return event !== 'room:create' ||
      this.consume(usage.creates, this.limits.maxRoomCreatesPerWindow, this.limits.roomCreateWindowMs, now);
  }

  recordInvalid(socketId: string, code: RoomErrorCode): boolean {
    const usage = this.sockets.get(socketId);
    if (!usage || !INVALID_CODES.has(code)) return false;
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
