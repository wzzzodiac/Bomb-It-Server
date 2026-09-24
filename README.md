# Bomb-It-Server

The multiplayer backend for [Bomb-It](https://github.com/wzzzodiac/Bomb-It). This repository now provides the **SERVER-AUTHORITATIVE MATCH FOUNDATION**, not full multiplayer gameplay. The existing functional browser game remains the gameplay reference and is not connected to this server yet.

## What runs today

A Node.js HTTP server serves `GET /health`; Socket.IO handles room membership and match inputs. `RoomManager` owns in-memory rooms and server-generated player IDs. `MatchManager` owns each online match's arena and player positions. Socket handlers validate inputs and publish public states without socket IDs. Rooms and matches disappear after their last player leaves; the host role passes to the earliest remaining player.

## Local setup

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

The default port is `8080`. `GET http://localhost:8080/health` returns `{"ok":true,"service":"bomb-it-server"}`.

```sh
npm test
npm run typecheck
npm run build
npm start
```

`npm start` runs the compiled `dist/server.js` after `npm run build`. The server reads environment variables from the process; `.env.example` lists values for local configuration and is not loaded automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and Socket.IO listener port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Single allowed browser origin; set to `https://wzzzodiac.github.io` for the future Pages client |
| `MAX_ROOMS` | `5` | In-memory room cap; cannot exceed 5 |
| `MAX_PLAYERS_PER_ROOM` | `6` | Player cap per room; cannot exceed 6 |
| `MAX_CONNECTIONS_PER_IP` | `10` | Simultaneous Socket.IO connections per direct peer address |
| `MAX_EVENTS_PER_WINDOW` | `40` | Protected room events per socket in each event window |
| `EVENT_WINDOW_MS` | `10000` | Event window length in milliseconds |
| `MAX_ROOM_CREATES_PER_WINDOW` | `3` | Room creation attempts per socket in each creation window |
| `ROOM_CREATE_WINDOW_MS` | `60000` | Creation window length in milliseconds |
| `MAX_INVALID_REQUESTS` | `8` | Invalid requests before a socket is disconnected |
| `MAX_PAYLOAD_BYTES` | `4096` | Maximum Engine.IO message size in bytes |
| `MAX_INPUTS_PER_WINDOW` | `120` | Gameplay movement inputs per socket per input window, separate from lobby events |
| `INPUT_WINDOW_MS` | `10000` | Gameplay input window length in milliseconds |

Invalid or out-of-range numeric limits fall back to the defaults. Upper bounds are 20 connections per IP, 80 lobby events per window, 6 room creation attempts per window, 12 invalid requests, 8192 payload bytes, and 240 gameplay inputs per window. Event windows accept 5000–60000 ms; creation windows accept 30000–300000 ms; gameplay windows accept 5000–10000 ms and at least 80 inputs. The server binds to `0.0.0.0` and uses `PORT`, so it can later run under Cloud Run's container contract. No Cloud deployment is configured here.

## Socket contract

Client events require an acknowledgement callback. Successful room events return `{ok:true,state}`; `room:leave` returns `{ok:true}`. Failures return `{ok:false,error:{code,message}}` and emit `room:error`.
Rate-limited events return the stable `RATE_LIMITED` code and do not execute the room action. Repeated invalid payloads eventually disconnect the socket. A connection rejected by the per-IP cap receives a short transport-level error.

| Client event | Payload | Result |
| --- | --- | --- |
| `room:create` | `{nickname}` | Creates a room and makes the creator host |
| `room:join` | `{code,nickname}` | Joins an existing lobby room |
| `room:leave` | none | Removes the caller |
| `player:set-ready` | `{ready:boolean}` | Updates only the caller's ready flag |
| `room:start-match` | none | Host starts after at least two humans are ready; returns `{ok:true,state:InitialMatchState}` |
| `player:input` | `{direction:"up"|"down"|"left"|"right"}` | Requests one tile of movement; returns `{ok:true,moved:true,revision}` or `{ok:true,moved:false,reason:"blocked"|"cooldown"}` |

On connection the server emits `server:hello`. Membership changes emit `room:state` to the room. A successful start emits `match:started` with the full authoritative arena and initial players. Accepted movement and in-match departures emit compact `match:state` updates with players and revision, not arena tiles. A later tile-mutation event can be added when bomb logic requires it. An explicit leave emits `room:left` to the caller. A disconnect removes membership and updates remaining players.

The server ports Bomb-It's pure arena rules: 1–2 players use 17×13, 3–4 use 21×17, and 5–6 use 25×19. The initial serialized arena includes every wall, pillar, crate, and safe spawn tile, so clients render the server-generated map rather than generating their own. Players start at the same dimension-derived spawns with `alive=true`, bomb capacity 1, fire range 2, and zero active bombs. Match snapshots contain a monotonically increasing revision and are copied before publication. Match construction completes before the room is committed to `playing`; a construction failure leaves the ready lobby intact for retry. The client sends only direction; identity, position, arena, and revision remain server-owned. A move enters only a free floor tile and is subject to a server-side 135 ms accepted-move cooldown. Blocked and cooldown moves do not change state or count as invalid requests.

Gameplay input has its own 120-per-10-second rate bucket, safely above the approximately 74 accepted moves per 10 seconds possible at the cooldown. The existing 40-per-10-second lobby event bucket still protects `room:start-match` and other room events. This is a per-socket traffic bound, not a replacement for movement validation.

The public state contains `code`, `status`, `hostPlayerId`, and players with `id`, `nickname`, `ready`, and `host`. It excludes socket IDs. Codes are four characters from an alphabet without easily confused characters. Nicknames are trimmed, whitespace is collapsed, and length is limited to 18 characters.

The server enforces at most **5 rooms** with **6 players each**. A socket can occupy only one room. Origin checking limits browser connections to `CLIENT_ORIGIN`; it is not authentication.

The abuse counters and rooms are process-local. The IP cap uses the direct transport peer address and does not trust `X-Forwarded-For`; an ingress proxy may cause multiple visitors to share one counted address. A future deployment must explicitly establish a trusted proxy boundary before using forwarded client IPs. Clients without an Origin header may connect, so Origin checks are not an identity system. These limits are not shared across multiple Cloud Run instances.

## Next phase

Connect the Bomb-It frontend to this server locally for online mode while preserving local Quick Play and the current visual/mobile UX. Server-side bomb placement, fuse, chain explosions, crate destruction, power-ups, deaths, winner/draw evaluation, bots, reconnects, storage, and Cloud Run deployment are not implemented yet.
