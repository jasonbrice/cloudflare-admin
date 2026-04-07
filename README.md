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

Opens at http://localhost:3000. Features:

- Four-column layout showing domains grouped by current plan
- Traffic stats (requests/mo, bandwidth/mo) on each domain card
- Drag and drop domains between plan columns to build a change list
- Search and sort (by name, requests, or bandwidth)
- Pending changes panel with estimated savings
- Live progress bar during initial data load

## How It Works

1. **Fetches all zones** via the Cloudflare API with pagination
2. **Pulls analytics** for each zone using the GraphQL API (`httpRequestsAdaptiveGroups`), with automatic fallback to shorter time windows for lower-tier plans
3. **Checks feature usage** (WAF, firewall rules, custom SSL, rate limits) via zone settings and sub-resource APIs
4. **Recommends a plan** based on the higher of traffic-volume heuristics and feature requirements
5. **Assigns enterprise slots** to the highest-traffic qualifying domains (auto-detected from current usage or overridden via `--enterprise-slots`)

### Plan Recommendation Thresholds

| Metric (per 30 days) | Free | Pro | Business |
|----------------------|------|-----|----------|
| Requests | < 1M | 1M - 50M | > 50M |
| Bandwidth | < 10 GB | 10 - 500 GB | > 500 GB |

Feature-based signals (WAF, custom SSL, rate limits) can push the recommendation higher regardless of traffic.

## Project Structure

```
src/
  index.js        # CLI entry point
  server.js       # Express server for web dashboard
  cloudflare.js   # Cloudflare API client
  analyzer.js     # Recommendation engine
  formatter.js    # CLI table output
  public/
    index.html    # Web dashboard (vanilla HTML/CSS/JS)
```
