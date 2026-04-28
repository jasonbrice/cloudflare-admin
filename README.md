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
| `--backup` | Back up DNS zone files for all zones to Azure Blob Storage (see [DNS Zone Backups](#dns-zone-backups)) | off |

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
- **Backup Zones to Azure** split-button — snapshot all DNS zone files to Azure Blob Storage, download all zones as a single ZIP, or view the last backup's details (see [DNS Zone Backups](#dns-zone-backups))

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

The app can export every Cloudflare zone's DNS records as a BIND-format zone file and upload them to Azure Blob Storage for disaster recovery and audit history. Each run writes to a date-stamped folder (no overwrites), so you can restore any prior snapshot.

### One-time setup

1. **Create an Azure Storage Account** (any region, any redundancy — `Standard_LRS` is cheapest and fine for backups). In the Portal: *Storage accounts → Create*.
2. **Create a private container** in the storage account (or let the app auto-create the default `cloudflare-zone-backups` on first run). Make sure public access is set to **None**.
3. **Get the connection string**: Storage Account → *Security + networking → Access keys → Show → key1 → Connection string*.
4. **Add credentials to `.env`**:
   ```
   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
   AZURE_STORAGE_CONTAINER=cloudflare-zone-backups
   ```
5. **(Optional) Add `AZURE_SUBSCRIPTION_ID` and `AZURE_RESOURCE_GROUP`** to `.env`. With these set, the **View in Azure Portal** link on the backup success badge deep-links straight to your container. Without them, the link still works but lands on the portal's generic Storage accounts browse page.
6. **Add `Zone:DNS:Read`** to your Cloudflare API token (https://dash.cloudflare.com/profile/api-tokens). The existing token can be edited in place.

### Running a backup

The **Backup Zones to Azure** split-button in the dashboard offers three options via the chevron menu:

- **Back up now** — kicks off the same Azure-backed backup as the CLI (`node src/index.js --backup`). Live progress modal, ends with a summary card.
- **Download all as .zip** — assembles every zone's BIND file into a single ZIP that downloads to your browser. No Azure required (the endpoint only needs `CLOUDFLARE_API_TOKEN` with `Zone:DNS:Read`). The zip contains a date-stamped folder with one `<domain>.zone` file per zone plus a `manifest.json`. Useful for ad-hoc snapshots or for users who don't have Azure configured.
- **Last Backup Details** — shows the run metadata from the most recent Azure backup, with a copy-to-clipboard summary.

The Azure CLI flag is unchanged:

```bash
node src/index.js --backup
```

### Scheduled backups

A GitHub Actions workflow at `.github/workflows/scheduled-backup.yml` runs the CLI backup on a weekly schedule (Sundays at 07:00 UTC by default — adjust the `cron` line to suit). It reuses the `production` environment, so make sure these secrets are configured there:

- `CLOUDFLARE_API_TOKEN` (with `Zone:DNS:Read`)
- `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_STORAGE_CONTAINER` *(optional, as a variable not a secret; defaults to `cloudflare-zone-backups`)*

You can also trigger a run on demand via the **Run workflow** button on the Actions tab. GitHub emails the repo's failure-notification recipients on failed runs.

### What gets stored

```
<container>/2026-04-26T14-30-00Z/
  example.com.zone
  foo.com.zone
  ...
  manifest.json     # run metadata (timestamp, per-zone status, errors)
```

Each `.zone` file is a standard BIND-format DNS zone file (importable back into Cloudflare or any other DNS provider).

### Storage tier

New blobs are written using the storage account's default access tier (typically Hot). For cost savings on long-term retention, configure an Azure Storage **Lifecycle Management** rule to move blobs older than N days to Cool/Cold/Archive. Connection-string auth doesn't restrict this — it's just an Azure-side policy.

## Project Structure

```
src/
  index.js        # CLI entry point
  server.js       # Express server for web dashboard
  cloudflare.js   # Cloudflare API client (REST + GraphQL)
  analyzer.js     # Recommendation engine with traffic + feature heuristics
  backup.js       # DNS zone backup to Azure Blob Storage
  formatter.js    # CLI table output
  public/
    index.html    # Web dashboard (vanilla HTML/CSS/JS)
```
