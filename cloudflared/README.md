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
cp .env.example .env
# Edit .env: set HMAC_SECRET to a 32+ char random string
# Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run build && npm run dev
```

### 6. Start tunnel
```bash
# In another terminal:
cloudflared tunnel run agentroom
```

### 7. Verify
```bash
curl https://agentroom.yourdomain.com/health
# {"ok":true,"ts":...}
```

## Notes
- cloudflared handles TLS termination and WebSocket upgrades automatically
- The WS server runs on PORT+1 (default 8788). You need a second ingress rule if you want to separate HTTP and WS on the same domain — or just use the same port via an HTTP server that handles both (recommended for v1.1)
- Credentials JSON (`~/.cloudflared/<id>.json`) must never be committed to git
