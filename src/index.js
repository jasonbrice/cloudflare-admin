require("dotenv").config();

const { listZones, collectZoneData } = require("./cloudflare");
const { analyze, assignEnterpriseSlots } = require("./analyzer");
const { formatTable, formatJson } = require("./formatter");

function parseArgs(argv) {
  const args = { days: 30, json: false, enterpriseSlots: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      args.days = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--enterprise-slots" && argv[i + 1]) {
      args.enterpriseSlots = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--json") {
      args.json = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`
Usage: node src/index.js [options]

Options:
  --days <n>              Analysis period in days (default: 30)
  --enterprise-slots <n>  Number of enterprise slots to assign (default: auto-detect current count)
  --json                  Output results as JSON
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

async function main() {
  const args = parseArgs(process.argv);

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

  const results = [];
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    progress(`[${i + 1}/${zones.length}] ${zone.name}`);
    try {
      const data = await collectZoneData(zone, args.days);
      results.push(analyze(data));
    } catch (err) {
      process.stderr.write(`\nError processing ${zone.name}: ${err.message}\n`);
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
