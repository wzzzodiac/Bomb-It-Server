# Bomb-It-Server

The planned multiplayer backend for [Bomb-It](https://github.com/wzzzodiac/Bomb-It). This repository currently provides the **ROOM / CONNECTION FOUNDATION**, not **FULL MULTIPLAYER GAMEPLAY**. The browser game is a separate repository and is not connected to this server yet.

## What runs today

A Node.js HTTP server serves `GET /health`; Socket.IO handles room membership. `RoomManager` owns in-memory rooms and server-generated player IDs. Socket handlers validate input and publish a public room state without socket IDs. Rooms disappear after their last player leaves. The host role passes to the earliest remaining player.

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

Invalid or out-of-range numeric limits fall back to the defaults. Upper bounds are 20 connections per IP, 80 events per window, 6 room creation attempts per window, 12 invalid requests, and 8192 payload bytes. Event windows accept 5000–60000 ms; creation windows accept 30000–300000 ms. The server binds to `0.0.0.0` and uses `PORT`, so it can later run under Cloud Run's container contract. No Cloud deployment is configured here.

## Socket contract

Client events require an acknowledgement callback. Successful room events return `{ok:true,state}`; `room:leave` returns `{ok:true}`. Failures return `{ok:false,error:{code,message}}` and emit `room:error`.
Rate-limited events return the stable `RATE_LIMITED` code and do not execute the room action. Repeated invalid payloads eventually disconnect the socket. A connection rejected by the per-IP cap receives a short transport-level error.

| Client event | Payload | Result |
| --- | --- | --- |
| `room:create` | `{nickname}` | Creates a room and makes the creator host |
| `room:join` | `{code,nickname}` | Joins an existing lobby room |
| `room:leave` | none | Removes the caller |
| `player:set-ready` | `{ready:boolean}` | Updates only the caller's ready flag |

On connection the server emits `server:hello`. Membership changes emit `room:state` to the room. An explicit leave emits `room:left` to the caller. A disconnect removes membership and updates remaining players.

The public state contains `code`, `status`, `hostPlayerId`, and players with `id`, `nickname`, `ready`, and `host`. It excludes socket IDs. Codes are four characters from an alphabet without easily confused characters. Nicknames are trimmed, whitespace is collapsed, and length is limited to 18 characters.

The server enforces at most **5 rooms** with **6 players each**. A socket can occupy only one room. Origin checking limits browser connections to `CLIENT_ORIGIN`; it is not authentication.

The abuse counters and rooms are process-local. The IP cap uses the direct transport peer address and does not trust `X-Forwarded-For`; an ingress proxy may cause multiple visitors to share one counted address. A future deployment must explicitly establish a trusted proxy boundary before using forwarded client IPs. Clients without an Origin header may connect, so Origin checks are not an identity system. These limits are not shared across multiple Cloud Run instances.

## Next phase

Implement the first server-authoritative gameplay slice: start a match from a ready room, select the existing arena preset, accept bounded player inputs, and broadcast a minimal authoritative state. Movement, bombs, explosions, outcomes, reconnects, storage, and deployment are not implemented yet.
