# Cloudflared setup

## Prerequisites
- Cloudflare account with a domain managed in Cloudflare DNS
- `cloudflared` installed: `yay -S cloudflared` (Arch) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

## Steps

### 1. Authenticate
```bash
cloudflared tunnel login
```

### 2. Create tunnel
```bash
cloudflared tunnel create agentroom
# Note the tunnel ID printed — copy it into config.yml
```

### 3. Configure DNS (points your subdomain at the tunnel)
```bash
cloudflared tunnel route dns agentroom agentroom.yourdomain.com
```

### 4. Create config
```bash
cp cloudflared/config.yml.example ~/.cloudflared/config.yml
# Edit ~/.cloudflared/config.yml: fill in tunnel ID, hostname, credentials path
```

### 5. Start server
```bash
# In one terminal:
npm run setup       # install + build + link CLI globally (once per machine)
agentroom setup     # generates .env with HMAC_SECRET + identity
npm run dev
```

### 6. Start tunnel
```bash
# In another terminal:
cloudflared tunnel run agentroom
```

### 7. Verify
```bash
curl https://agentroom.yourdomain.com/health
# {"ok":true,"db":"ok","agents":0,"pending":0,"invites":0,"uptime_s":N}
```

## Architecture

```
cloudflared (public) ──► agentroom server :8787 (HTTP + WS)
                                │
                    attachWss(httpServer)
                                │
                    /auth/challenge  (HTTP GET)
                    /health          (HTTP GET)
                    /metrics         (HTTP GET)
                    /ws              (WebSocket upgrade)
```

HTTP and WebSocket share **the same port (8787)** via `attachWss(httpServer)`. A single cloudflared ingress rule covers both — no second rule needed.

## Notes
- cloudflared handles TLS termination and WebSocket upgrades automatically
- One ingress rule routes everything (HTTP and WS) to `localhost:8787`
- Credentials JSON (`~/.cloudflared/<id>.json`) must never be committed to git
- Health endpoint: `curl https://agentroom.yourdomain.com/health` → `{"ok":true,"db":"ok",...}`
