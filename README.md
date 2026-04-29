# Cloudflare Domain Plan Analyzer

Analyzes traffic and feature usage across all your Cloudflare domains and recommends the right plan (Free, Pro, Business, or Enterprise) for each one. Includes a web dashboard with drag-and-drop plan reassignment.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your Cloudflare API token
```

### API Token

Create a token at https://dash.cloudflare.com/profile/api-tokens with these permissions:

- **Zone** > **Zone** > **Read**
- **Zone** > **Analytics** > **Read**
- **Zone** > **Workers Routes** > **Read** (optional — enables Workers detection)

Set Zone Resources to **Include > All zones**.

## Usage

### CLI

```bash
node src/index.js
```

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `--days <n>` | Analysis period in days | 30 |
| `--enterprise-slots <n>` | Number of enterprise slots (auto-detected if omitted) | auto |
| `--json` | Output as JSON | off |

### Web Dashboard

```bash
npm run dev
```

Opens at http://localhost:3000. The dev server runs under [nodemon](https://nodemon.io/), so changes to `src/**/*.js` or `.env` automatically restart the server (handy after rotating credentials). Frontend HTML changes don't trigger a restart — just refresh the browser.

Features:

- Four-column layout showing domains grouped by current plan
- Traffic stats (requests/mo, bandwidth/mo) on each domain card
- **Click any domain card** to open a detail modal with full recommendation reasoning, tier headroom bars, and feature inventory
- Drag and drop domains between plan columns to build a change list
- Search and sort (by name, requests, or bandwidth)
- Pending changes panel with estimated savings
- Live progress bar during initial data load
- **Download Zone Backups (.zip)** button — fetches every zone's DNS records as a BIND-format file and downloads them all as a single zip (see [DNS Zone Backups](#dns-zone-backups))

## How It Works

1. **Fetches all zones** via the Cloudflare API with pagination
2. **Pulls analytics** for each zone using the GraphQL API (`httpRequestsAdaptiveGroups`), with automatic fallback to shorter time windows for lower-tier plans
3. **Pulls cache analytics** via a separate GraphQL query (`httpRequests1dGroups`) to measure cache hit ratio
4. **Checks feature usage** (WAF, firewall rules, custom SSL, rate limits, page rules, Workers routes) via zone settings and sub-resource APIs
5. **Recommends a plan** based on the higher of traffic-volume heuristics and feature requirements, with cache hit ratio softening bandwidth-based signals
6. **Assigns enterprise slots** to the highest-traffic qualifying domains (auto-detected from current usage or overridden via `--enterprise-slots`)

### Plan Recommendation Thresholds

| Metric (per 30 days) | Free | Pro | Business |
|----------------------|------|-----|----------|
| Requests | < 1M | 1M - 50M | > 50M |
| Bandwidth | < 10 GB | 10 - 500 GB | > 500 GB |

Bandwidth thresholds are adjusted by cache hit ratio — a high cache ratio (>50%) reduces the effective bandwidth used in tier calculations.

### Feature-Based Signals

| Feature | Minimum Plan |
|---------|-------------|
| WAF enabled | Pro |
| Firewall rules | Pro |
| Polish / Mirage | Pro |
| Workers routes | Pro |
| Rate limits (1–2 rules) | Pro |
| Rate limits (3+ rules) | Business |
| Custom SSL certificates | Business |
| Page rules > 3 | Pro |
| Page rules > 20 | Business |
| Page rules > 50 | Enterprise |

Feature-based signals push the recommendation higher regardless of traffic volume.

### Domain Detail View

Click any domain card in the dashboard to see:

- **Plan comparison** — current vs. recommended plan with status and potential savings
- **Traffic analysis** — human-readable reasoning for the traffic-based recommendation
- **Feature requirements** — list of detected features driving the plan recommendation
- **Security & Optimization** — see below
- **Tier headroom** — color-coded bars showing how close to the next tier's limits (green < 60%, yellow 60–85%, red > 85%)
- **Feature inventory** — checklist of all monitored features (WAF, firewall rules, SSL, rate limits, page rules, Workers, Polish, Mirage, Under Attack mode)

### Security & Optimization Recommendations

Each domain is classified into a *site profile* (e.g. `static-cdn`, `dev-staging`, `parked`, `api`, `email-only`) based on traffic patterns, cache hit ratio, DNS records, and naming. A ruleset then suggests security and performance improvements that fit the profile and the current plan tier — so you don't get told to "Enable Polish" on an API endpoint or to "Deploy WAF Managed Rules" on a parked domain.

Recommendations are graded by severity (`critical` / `strong` / `moderate` / `weak`) and aggregated into a 0–100 **security score** shown as a purple chip on the domain card. Use the toolbar's **Sort by → Security strength** option to surface the highest-impact domains. The **Min strength** filter applies to whichever score is currently being sorted (plan or security).

Click a card to see the full recommendation list with rationale ("why this matters for *this* domain") and an action path (where in Cloudflare's UI to make the change). All recommendations are read-only — the app never modifies your Cloudflare configuration.

## DNS Zone Backups

The dashboard's **Download Zone Backups (.zip)** button fetches every zone's DNS records via Cloudflare's `dns_records/export` endpoint and packages them into a single ZIP file that downloads to your browser. No external storage required — just `CLOUDFLARE_API_TOKEN` with `Zone:DNS:Read` added.

### Setup

1. Edit your Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens and add **Zone → DNS → Read**.
2. Click the button. For ~150 zones the download is around 150 KB and takes ~10 seconds.

### What's in the ZIP

```
cloudflare-zones-2026-04-26T14-30-00Z.zip
└── 2026-04-26T14-30-00Z/
    ├── example.com.zone
    ├── foo.com.zone
    ├── ...
    └── manifest.json          # run metadata (timestamp, per-zone status, errors)
```

Each `.zone` file is standard BIND format (importable back into Cloudflare or any other DNS provider). The `manifest.json` records which zones succeeded or failed and any per-zone error messages.

### Scheduling

This is an on-demand feature. To run on a schedule, drive it from a cron-equivalent (e.g. a GitHub Actions workflow with `schedule:` trigger that `curl`s the endpoint and pipes to a file, or a host-level cron that hits `/api/backup-zip` and stashes the result wherever you keep backups).

## Project Structure

```
src/
  index.js        # CLI entry point
  server.js       # Express server for web dashboard
  cloudflare.js   # Cloudflare API client (REST + GraphQL)
  analyzer.js     # Recommendation engine with traffic + feature heuristics
  backup.js       # Zone backup ZIP builder (download-only, no external deps)
  formatter.js    # CLI table output
  public/
    index.html    # Web dashboard (vanilla HTML/CSS/JS)
```
