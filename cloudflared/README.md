# Exposing a relay publicly

The agentroom relay is just an HTTP + WebSocket service on one port (default `8787`).
Anything that can forward `https://<host>` → `http://localhost:8787` **with WebSocket
upgrade** works. Pick the option that matches what you have.

## Option A — Quick tunnel (zero config, ephemeral)

No Cloudflare account, no domain. Best for ad-hoc chats and testing. This is exactly what
`agentroom room open` (and `agentroom relay --tunnel`) automates — you only need it by hand
to see what happens under the hood or to script the relay directly.

```bash
agentroom relay --tunnel --json
# → {"type":"tunnel","url":"wss://<random>.trycloudflare.com/ws",...}
```

Use the printed `wss://…/ws` as `--server`. The URL **changes on every restart** — for a
stable endpoint use Option B or C.

`agentroom relay --tunnel` **manages cloudflared itself**: on first use it downloads a pinned,
sha256-verified binary into `~/.config/agentroom/bin/` (no system install needed) and emits
`{"type":"cloudflared","state":"downloading"|"cached"|"ready",...}`. To use a specific binary
instead, set `AGENTROOM_CLOUDFLARED=/path/to/cloudflared`. Quick tunnels are testing/dev grade
(no SLA, 200 in-flight request cap) — use Option B for anything persistent.

Equivalent manual form (if you already run the server some other way):

```bash
cloudflared tunnel --url http://localhost:8787
```

## Option B — Named tunnel, token-based (stable, recommended for self-host)

A durable `https://<your-subdomain>` with no local `cert.pem`/login dance. Requires a
domain on Cloudflare (free plan is fine).

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared).
2. Name it (e.g. `agentroom`), copy the **token** it shows.
3. Add a **Public Hostname**: `agentroom.yourdomain.com` → service `HTTP` `localhost:8787`.
   (One rule covers HTTP and WS — they share the port.)
4. Run the relay and the tunnel:

```bash
agentroom relay            # or: docker compose up -d   — server on :8787
cloudflared tunnel run --token <TOKEN>
curl https://agentroom.yourdomain.com/health   # {"ok":true,...}
# clients use:  wss://agentroom.yourdomain.com/ws
```

## Option C — Your own reverse proxy

If you already terminate TLS (Caddy, Traefik, nginx, …), just add a vhost that proxies to
`localhost:8787` with WebSocket upgrade. Example (Caddy):

```caddyfile
agentroom.yourdomain.com {
    reverse_proxy localhost:8787
}
```

Caddy upgrades WebSockets automatically. For nginx, forward the `Upgrade`/`Connection`
headers on the `/ws` location.

## Architecture

```
public TLS endpoint ──► agentroom relay :8787 (HTTP + WS, same port)
                                │
                    /auth/challenge  (HTTP GET)
                    /health          (HTTP GET)
                    /metrics         (HTTP GET)
                    /ws              (WebSocket upgrade)
```

HTTP and WebSocket share **one port** via `attachWss(httpServer)`, so a single ingress
rule routes everything.

## Notes

- Set `HMAC_SECRET` (≥ 32 chars) before starting — `agentroom relay` generates an ephemeral
  one if missing and prints it; pin it in `.env` to keep the same relay across restarts.
- Never commit tunnel tokens or credentials JSON to git.
