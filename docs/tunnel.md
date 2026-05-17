# Cloudflare Tunnel

To let invited participants connect their agents from anywhere, you need to
expose the coordinator (and ideally the dashboard) to the public internet.
Cloudflare Tunnel does this without opening ports or owning a domain —
ephemeral `*.trycloudflare.com` URLs are fine for a hackathon.

## Install

```bash
brew install cloudflared       # macOS
# or
curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz
```

## Run (ephemeral URLs, easiest)

Two terminals:

```bash
# coordinator — required: participants' agents connect here
cloudflared tunnel --url http://localhost:8787

# dashboard — optional: anyone you share the URL with can spectate
cloudflared tunnel --url http://localhost:3000
```

Each command prints a banner with the assigned URL:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://random-words-here-1234.trycloudflare.com                                          |
+--------------------------------------------------------------------------------------------+
```

The URL stays alive as long as the `cloudflared` process is running. Each
restart gets a new URL (so don't email it in advance — share it the moment
you start the tunnel).

## After the tunnel is up

1. Update `.env` so signup URLs print the public hostname:
   ```
   AC_PUBLIC_BASE_URL=https://your-coord-tunnel.trycloudflare.com
   ```
   Restart the coordinator.

2. Test from another network (phone hotspot is fine):
   ```bash
   curl https://your-coord-tunnel.trycloudflare.com/health
   # → {"ok":true,"subs":…}
   ```

3. Share the right URL with the right audience:
   - **Coordinator URL** — only to invited participants. They put it in
     `COORDINATOR_URL` / `COORDINATOR_WS_URL`.
   - **Dashboard URL** — public; tweet it, drop it in Slack, whatever.

## WebSocket on Cloudflare

The coordinator's `/ws` works over the tunnel out of the box. Two notes:

- Participants must use `wss://` (not `ws://`) for the WS URL. The starter's
  `.env.example` already shows the right shape.
- Cloudflare's free quick tunnels have a per-connection idle timeout
  somewhere around 100s. The SDK heartbeats every second and reconnects on
  close, so this is invisible in practice.

## Named tunnels (stable URLs)

Only worth doing if you'll demo more than once. You'll need a Cloudflare
account + a domain on Cloudflare DNS.

```bash
cloudflared tunnel login                              # opens browser
cloudflared tunnel create ac-coord                    # creates a tunnel + .json credentials
cloudflared tunnel route dns ac-coord coord.example.com
```

Then run with a config file (`~/.cloudflared/config.yml`):

```yaml
tunnel: ac-coord
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: coord.example.com
    service: http://localhost:8787
  - hostname: dash.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel run ac-coord
```

Now `coord.example.com` and `dash.example.com` are stable. Drop them into
`.env` and printed signup URLs use them automatically.

## What to do if cloudflared isn't an option

- **Same-LAN demo.** Skip tunnels; tell participants to use your machine's
  LAN IP in `COORDINATOR_URL` (e.g. `http://192.168.1.42:8787`). The
  coordinator binds to `0.0.0.0` so this works.
- **ngrok** is the equivalent fallback. `ngrok http 8787` → public URL. The
  free tier rotates URLs on every restart just like quick tunnels.
- **Self-host.** Coordinator is one Fastify process; any VM with a public IP
  and the env vars set will do.
