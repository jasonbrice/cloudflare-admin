require("dotenv").config();

const path = require("path");
const express = require("express");
const { listZones, collectZoneData } = require("./cloudflare");
const { analyze, assignEnterpriseSlots } = require("./analyzer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

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

    const results = [];
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      send("progress", {
        phase: "analyze",
        current: i + 1,
        total: zones.length,
        domain: zone.name,
      });

      try {
        const data = await collectZoneData(zone, days);
        results.push(analyze(data));
      } catch (err) {
        results.push({
          domain: zone.name,
          currentPlan: zone.plan?.legacyId || "unknown",
          currentPrice: zone.plan?.price ?? 0,
          recommendedPlan: "unknown",
          recommendedPrice: 0,
          status: "error",
          monthlySavings: 0,
          trafficPlan: "unknown",
          featurePlan: "unknown",
          featureReasons: [`Error: ${err.message}`],
          monthlyRequests: 0,
          monthlyBandwidth: 0,
          uniqueVisitors: 0,
          cacheRatio: 0,
        });
      }
    }

    const finalResults =
      enterpriseSlots > 0
        ? assignEnterpriseSlots(results, enterpriseSlots)
        : results;

    send("done", { results: finalResults, accounts, enterpriseSlots });
  } catch (err) {
    send("error", { message: err.message });
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
