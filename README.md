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

Invalid numeric limits fall back to the defaults. The server binds to `0.0.0.0` and uses `PORT`, so it can later run under Cloud Run's container contract. No Cloud deployment is configured here.

## Socket contract

Client events require an acknowledgement callback. Successful room events return `{ok:true,state}`; `room:leave` returns `{ok:true}`. Failures return `{ok:false,error:{code,message}}` and emit `room:error`.

| Client event | Payload | Result |
| --- | --- | --- |
| `room:create` | `{nickname}` | Creates a room and makes the creator host |
| `room:join` | `{code,nickname}` | Joins an existing lobby room |
| `room:leave` | none | Removes the caller |
| `player:set-ready` | `{ready:boolean}` | Updates only the caller's ready flag |

On connection the server emits `server:hello`. Membership changes emit `room:state` to the room. An explicit leave emits `room:left` to the caller. A disconnect removes membership and updates remaining players.

The public state contains `code`, `status`, `hostPlayerId`, and players with `id`, `nickname`, `ready`, and `host`. It excludes socket IDs. Codes are four characters from an alphabet without easily confused characters. Nicknames are trimmed, whitespace is collapsed, and length is limited to 18 characters.

The server enforces at most **5 rooms** with **6 players each**. A socket can occupy only one room. Origin checking limits browser connections to `CLIENT_ORIGIN`; it is not authentication.

## Next phase

Implement the first server-authoritative gameplay slice: start a match from a ready room, select the existing arena preset, accept bounded player inputs, and broadcast a minimal authoritative state. Movement, bombs, explosions, outcomes, reconnects, storage, and deployment are not implemented yet.
