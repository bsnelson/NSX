# Mock Gateway

A dependency-light stand-in for the Streamline-Bridge gateway, so the skin can
be developed and tested **without a DE1**.

It serves `packages/nsx/src` as the web root — exactly what the Decent app does
— and mocks the REST + WebSocket API on the same port.

```bash
npm run dev:mock          # sync-core, then serve on http://localhost:8080
PORT=8090 npm run dev:mock  # if the real Decent app already owns 8080
```

> **Port caveat.** `packages/core/src/config.js` derives the gateway host from
> `location.hostname` but **hardcodes port 8080**. On the default port
> everything just works. On any other port, open the skin with an explicit
> gateway, e.g. `http://localhost:8090/?gateway=http://localhost:8090`.

## Why it exists

Core changes used to be verifiable only against a live machine. The mock lets
us exercise the real code paths — including the ones that motivated recent
fixes — offline and deterministically.

## Faithful ETag behaviour

The ETag semantics were verified against a real gateway and are reproduced
exactly, because they are load-bearing for the cross-device refresh (issue #3):

| Endpoint | ETag / `304`? |
|---|---|
| `GET /api/v1/profiles` (incl. `?includeHidden=true`) | yes |
| `GET /api/v1/beans`, `/grinders`, `/shots` | yes |
| `GET /api/v1/store/<ns>?full=1` | yes |
| `GET /api/v1/store/<ns>/<key>` | **no** — deliberately, mirrors the real gateway |

That last row is the whole reason recipes and profile-favorites read through
the namespace-wide endpoint instead of per-key GETs.

## Simulated machine

- `PUT /api/v1/machine/state/<state>` switches state. Flowing states
  (`espresso`, `steam`, `hotWater`, `flush`) start a simulated shot: substate
  goes `preinfusion` → `pouring`, pressure/flow ramp up, and `profileFrame`
  advances one step every 6 s until the shot ends after ~45 s.
- `PUT /api/v1/machine/state/skipStep` advances `profileFrame` by one — this is
  what the cleaning "Step ↷" button drives.
- The machine-snapshot and scale WebSockets stream at 4 Hz; devices report both
  machine and scale as connected.

## Fixtures

`fixtures.mjs` seeds four profiles (one **hidden**, one cleaning profile), two
recipes (one referencing the hidden profile), beans, grinders and three shots.
The hidden profile plus the recipe pointing at it exist so the hidden-profile
push path stays exercisable by hand.

State is mutated in-process, so a session behaves like a real one — changes
stick until the server restarts.
