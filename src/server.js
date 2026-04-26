require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { listZones, collectZoneData, runPool } = require("./cloudflare");
const { analyze, assignEnterpriseSlots, computeScore, scoreLabel } = require("./analyzer");
const { detectSiteProfile } = require("./site-profile");
const {
  recommendSecurityOptimizations,
  computeSecurityScore,
  securityScoreLabel,
} = require("./security-rules");
const { backupAllZones } = require("./backup");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "..", "data", "analysis-cache.json");
const LAST_BACKUP_FILE = path.join(__dirname, "..", "data", "last-backup.json");

app.use(express.static(path.join(__dirname, "public")));

// --- Cache helpers ---
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const cached = JSON.parse(raw);
    if (!cached.results || !cached.timestamp) return null;
    return cached;
  } catch {
    return null;
  }
}

function saveCache(data) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { ...data, timestamp: new Date().toISOString() };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  return payload.timestamp;
}

function loadLastBackup() {
  try {
    if (!fs.existsSync(LAST_BACKUP_FILE)) return null;
    return JSON.parse(fs.readFileSync(LAST_BACKUP_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveLastBackup(summary) {
  const dir = path.dirname(LAST_BACKUP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    ...summary,
    timestamp: new Date().toISOString(),
    portalUrl: buildPortalUrl(summary.container, summary.runId),
  };
  fs.writeFileSync(LAST_BACKUP_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

// Parse AccountName=foo from a connection string. Returns null if not found.
function parseAccountName(connStr) {
  if (!connStr) return null;
  const match = connStr.match(/(?:^|;)AccountName=([^;]+)/i);
  return match ? match[1] : null;
}

/**
 * Build an Azure Portal URL pointing at the backup location.
 *
 * If AZURE_SUBSCRIPTION_ID and AZURE_RESOURCE_GROUP are set, returns a deep
 * link directly to the container (the date-stamped folder appears in the
 * listing). Otherwise returns a link to the portal's Storage accounts browse
 * page so the user can pick the account manually. Returns null if we can't
 * even determine the account name.
 */
function buildPortalUrl(container, _runId) {
  const accountName = parseAccountName(process.env.AZURE_STORAGE_CONNECTION_STRING);
  if (!accountName) return null;

  const sub = process.env.AZURE_SUBSCRIPTION_ID;
  const rg = process.env.AZURE_RESOURCE_GROUP;

  if (sub && rg && container) {
    const resourceId =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Storage/storageAccounts/${accountName}`;
    return (
      "https://portal.azure.com/#blade/Microsoft_Azure_Storage/ContainerMenuBlade/overview" +
      `/storageAccountId/${encodeURIComponent(resourceId)}` +
      `/path/${encodeURIComponent(container)}`
    );
  }

  // Fallback: browse storage accounts (one extra click to find the account)
  return "https://portal.azure.com/#blade/HubsExtension/BrowseResource/resourceType/Microsoft.Storage%2FStorageAccounts";
}

// --- Routes ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Return cached data if available (non-SSE, fast). Recomputes recommendation
// scores on every read so scoring-formula tweaks apply without re-hitting the
// Cloudflare API. Score computation is pure and cheap.
app.get("/api/cached", (_req, res) => {
  const cached = loadCache();
  if (cached) {
    if (Array.isArray(cached.results)) {
      cached.results = cached.results.map((r) => {
        const score = computeScore(r);

        // Re-detect profile + security recs so rule changes apply without
        // re-hitting the Cloudflare API. Pure functions, cheap.
        const profileInfo = detectSiteProfile(r);
        const enriched = {
          ...r,
          profile: profileInfo.profile,
          profileSignals: profileInfo.signals,
        };
        const securityRecommendations = recommendSecurityOptimizations(enriched);
        const securityScore = computeSecurityScore(securityRecommendations);

        return {
          ...enriched,
          score,
          scoreLabel: scoreLabel(score),
          securityRecommendations,
          securityScore,
          securityScoreLabel: securityScoreLabel(securityScore),
        };
      });
    }
    res.json(cached);
  } else {
    res.json({ results: null });
  }
});

// Full refresh via SSE — always hits Cloudflare API
app.get("/api/analyze", async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    send("progress", { phase: "zones", message: "Fetching zones..." });

    const { zones, accounts } = await listZones();

    // Auto-detect enterprise slots
    let enterpriseSlots = 0;
    for (const acct of Object.values(accounts)) {
      enterpriseSlots += acct.plans.enterprise || 0;
    }

    send("progress", {
      phase: "zones",
      message: `Found ${zones.length} zone(s)`,
      total: zones.length,
    });

    let completed = 0;
    const results = await runPool(zones, 5, async (zone) => {
      completed++;
      send("progress", {
        phase: "analyze",
        current: completed,
        total: zones.length,
        domain: zone.name,
      });

      try {
        const data = await collectZoneData(zone, days);
        return analyze(data);
      } catch (err) {
        return {
          domain: zone.name,
          currentPlan: zone.plan?.legacyId || "unknown",
          currentPrice: zone.plan?.price ?? 0,
          recommendedPlan: "unknown",
          recommendedPrice: 0,
          status: "error",
          monthlySavings: 0,
          trafficPlan: "unknown",
          featurePlan: "unknown",
          trafficReasons: [],
          featureReasons: [`Error: ${err.message}`],
          monthlyRequests: 0,
          monthlyBandwidth: 0,
          uniqueVisitors: 0,
          cacheRatio: 0,
          headroom: null,
          features: null,
          analysisDays: 0,
        };
      }
    });

    const finalResults =
      enterpriseSlots > 0
        ? assignEnterpriseSlots(results, enterpriseSlots)
        : results;

    const payload = { results: finalResults, accounts, enterpriseSlots };
    const timestamp = saveCache(payload);

    send("done", { ...payload, timestamp });
  } catch (err) {
    send("error", { message: err.message });
  }

  res.end();
});

// Stream zone backup progress via SSE
app.get("/api/backup", async (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
      send("error", {
        message:
          "AZURE_STORAGE_CONNECTION_STRING is not set on the server. Add it to .env and restart.",
      });
      res.end();
      return;
    }

    const summary = await backupAllZones((evt) => {
      // Forward each progress event from backup module to the client
      if (evt.phase === "done") {
        send("done", evt);
      } else {
        send("progress", evt);
      }
    });

    // Persist the summary so "Last Backup Details" works across sessions/restarts
    const persisted = saveLastBackup(summary);

    // backupAllZones already emits a "done" via onProgress, but emit one more
    // explicit done as a safety net in case the consumer missed it.
    send("done", { phase: "done", ...persisted });
  } catch (err) {
    send("error", { message: err.message });
  }

  res.end();
});

// Returns the most recent successful backup summary (or { summary: null })
app.get("/api/last-backup", (_req, res) => {
  const summary = loadLastBackup();
  if (summary) {
    // Recompute portalUrl on every read so env-var changes (subscription /
    // resource group) are picked up without needing a fresh backup.
    summary.portalUrl = buildPortalUrl(summary.container, summary.runId);
  }
  res.json({ summary });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
