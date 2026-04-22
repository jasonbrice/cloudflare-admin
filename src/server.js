require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { listZones, collectZoneData, runPool } = require("./cloudflare");
const { analyze, assignEnterpriseSlots, computeScore, scoreLabel } = require("./analyzer");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "..", "data", "analysis-cache.json");

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
        return { ...r, score, scoreLabel: scoreLabel(score) };
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
