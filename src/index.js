require("dotenv").config();

const { listZones, collectZoneData, runPool } = require("./cloudflare");
const { analyze, assignEnterpriseSlots } = require("./analyzer");
const { formatTable, formatJson } = require("./formatter");
const { backupAllZones } = require("./backup");

function parseArgs(argv) {
  const args = { days: 30, json: false, enterpriseSlots: null, backup: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      args.days = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--enterprise-slots" && argv[i + 1]) {
      args.enterpriseSlots = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--json") {
      args.json = true;
    } else if (argv[i] === "--backup") {
      args.backup = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`
Usage: node src/index.js [options]

Options:
  --days <n>              Analysis period in days (default: 30)
  --enterprise-slots <n>  Number of enterprise slots to assign (default: auto-detect current count)
  --json                  Output results as JSON
  --backup                Back up DNS zone files for all zones to Azure Blob Storage
                          (requires AZURE_STORAGE_CONNECTION_STRING in .env)
  --help, -h              Show this help
      `);
      process.exit(0);
    }
  }
  return args;
}

function progress(msg) {
  process.stderr.write(`\r\x1b[K${msg}`);
}

async function runBackup() {
  process.stderr.write("Starting Cloudflare zone backup to Azure...\n");
  const summary = await backupAllZones((evt) => {
    if (evt.phase === "start") {
      progress(`Backing up ${evt.total} zone(s) to run ${evt.runId}\n`);
    } else if (evt.phase === "zone") {
      const tag = evt.status === "ok" ? "ok" : "FAIL";
      progress(`[${evt.current}/${evt.total}] ${evt.domain} — ${tag}`);
      if (evt.status === "error") {
        process.stderr.write(`\n  ! ${evt.domain}: ${evt.error}\n`);
      }
    } else if (evt.phase === "manifest") {
      progress("Uploading manifest...");
    }
  });
  process.stderr.write("\n\n");
  console.log(`Backup complete.`);
  console.log(`  Run ID:    ${summary.runId}`);
  console.log(`  Container: ${summary.container}`);
  console.log(`  Total:     ${summary.total}`);
  console.log(`  Succeeded: ${summary.succeeded}`);
  console.log(`  Failed:    ${summary.failed}`);
  if (summary.errors.length) {
    console.log(`\nErrors:`);
    for (const e of summary.errors) {
      console.log(`  - ${e.domain}: ${e.error}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.backup) {
    await runBackup();
    return;
  }

  progress("Fetching zones...");
  const { zones, accounts } = await listZones();

  // Auto-detect enterprise slot count from current usage if not specified
  let enterpriseSlots = args.enterpriseSlots;
  if (enterpriseSlots === null) {
    enterpriseSlots = 0;
    for (const acct of Object.values(accounts)) {
      enterpriseSlots += acct.plans.enterprise || 0;
    }
  }

  // Log account summary
  for (const acct of Object.values(accounts)) {
    const planSummary = Object.entries(acct.plans)
      .map(([p, n]) => `${n} ${p}`)
      .join(", ");
    progress(`Account "${acct.name}": ${planSummary}\n`);
  }
  progress(`Found ${zones.length} zone(s), ${enterpriseSlots} enterprise slot(s). Collecting data...\n`);

  let completed = 0;
  const results = await runPool(zones, 5, async (zone) => {
    completed++;
    progress(`[${completed}/${zones.length}] ${zone.name}`);
    try {
      const data = await collectZoneData(zone, args.days);
      return analyze(data);
    } catch (err) {
      process.stderr.write(`\nError processing ${zone.name}: ${err.message}\n`);
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

  progress("");

  const finalResults =
    enterpriseSlots > 0
      ? assignEnterpriseSlots(results, enterpriseSlots)
      : results;

  if (args.json) {
    console.log(formatJson(finalResults));
  } else {
    console.log(formatTable(finalResults, { enterpriseSlots }));
  }
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
