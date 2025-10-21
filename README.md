# Gaming DoH

Ultra-compact gaming-optimized DNS-over-HTTPS proxy with provider racing, adaptive routing, and low-latency caching for Cloudflare Workers.

## 🚀 Quick Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Rainman69/Gaming-DoH-Public)

## Features

- **Gaming-Optimized**: Intelligent detection of gaming domains with specialized caching policies
- **Provider Racing**: Simultaneously queries multiple DNS providers for the fastest response
- **Adaptive Routing**: KV-backed RTT monitoring automatically ranks providers by performance
- **Smart Caching**: Separate TTL policies for gaming (600s) vs regular queries (300s)
- **Multiple Formats**: Supports both RFC 8484 DoH and JSON resolve endpoints
- **Health Monitoring**: Automated provider health checks and performance metrics
- **Scheduled Warmup**: Pre-warms cache for popular gaming domains

## Gaming Domains

The proxy automatically detects and optimizes queries for popular gaming platforms including:
- Steam, Epic Games, Origin, Uplay
- League of Legends, Valorant, Call of Duty
- PUBG Mobile, Clash Royale, Minecraft
- PlayStation, Xbox, Discord, Twitch
- And many more gaming services

## Setup

### 1. Create KV Namespace

```bash
npx wrangler kv:namespace create PROVIDER_METRICS
```

### 2. Update Configuration

Replace `YOUR_KV_NAMESPACE_ID_HERE` in `wrangler.toml` with the ID from step 1.

### 3. Deploy

```bash
npx wrangler deploy
```

## API Endpoints

- `GET/POST /dns-query` - RFC 8484 DoH endpoint
- `GET /resolve?name=example.com&type=A` - JSON resolve endpoint
- `GET /providers` - List DNS providers ranked by performance
- `GET /stats` - Performance metrics and statistics
- `GET /health` - Health check endpoint

## DNS Providers

1. **Cloudflare** (35% weight) - `https://cloudflare-dns.com/dns-query`
2. **Google** (25% weight) - `https://dns.google/dns-query`
3. **Quad9** (15% weight) - `https://dns.quad9.net/dns-query`
4. **OpenDNS** (10% weight) - `https://doh.opendns.com/dns-query`
5. **AdGuard** (8% weight) - `https://dns.adguard.com/dns-query`
6. **ControlD** (7% weight) - `https://freedns.controld.com/p2`

## Performance Features

- **Provider Racing**: Top 3 providers compete for gaming queries
- **Sequential Fallback**: Non-gaming queries use ranked provider list
- **Adaptive Weights**: Performance metrics automatically adjust provider rankings
- **Edge Caching**: Cloudflare's edge network caches responses globally
- **Scheduled Maintenance**: Cron jobs maintain provider health and warm popular domains

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0) - see the [LICENSE](LICENSE) file for details.

## Credits

Based on [doh-proxy-worker](https://github.com/code3-dev/doh-proxy-worker) by code3-dev.