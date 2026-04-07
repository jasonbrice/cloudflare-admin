const { PLAN_PRICES } = require("./analyzer");

// ANSI color codes
const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
};

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatNumber(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function statusColor(status) {
  if (status === "ok") return COLOR.green;
  if (status === "downgrade") return COLOR.yellow;
  return COLOR.red;
}

function statusLabel(status) {
  if (status === "ok") return "OK";
  if (status === "downgrade") return "DOWNGRADE";
  return "UPGRADE";
}

function planLabel(plan) {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function padRight(str, len) {
  const stripped = str.replace(/\x1b\[\d+m/g, "");
  return str + " ".repeat(Math.max(0, len - stripped.length));
}

function padLeft(str, len) {
  const stripped = str.replace(/\x1b\[\d+m/g, "");
  return " ".repeat(Math.max(0, len - stripped.length)) + str;
}

function formatTable(results, options = {}) {
  const cols = {
    domain: { header: "Domain", width: 0 },
    current: { header: "Current", width: 10 },
    requests: { header: "Req/mo", width: 10 },
    bandwidth: { header: "BW/mo", width: 10 },
    recommended: { header: "Recommended", width: 12 },
    status: { header: "Status", width: 10 },
    savings: { header: "Savings/mo", width: 11 },
  };

  // Calculate domain column width
  cols.domain.width = Math.max(
    6,
    ...results.map((r) => r.domain.length)
  );

  const header =
    `  ${padRight(cols.domain.header, cols.domain.width)}  ` +
    `${padRight(cols.current.header, cols.current.width)}  ` +
    `${padLeft(cols.requests.header, cols.requests.width)}  ` +
    `${padLeft(cols.bandwidth.header, cols.bandwidth.width)}  ` +
    `${padRight(cols.recommended.header, cols.recommended.width)}  ` +
    `${padRight(cols.status.header, cols.status.width)}  ` +
    `${padLeft(cols.savings.header, cols.savings.width)}`;

  const separator = "  " + "-".repeat(header.length - 2);

  const lines = [
    "",
    `${COLOR.bold}Cloudflare Domain Plan Analysis${COLOR.reset}`,
    "",
    `${COLOR.dim}${header}${COLOR.reset}`,
    `${COLOR.dim}${separator}${COLOR.reset}`,
  ];

  for (const r of results) {
    const sc = statusColor(r.status);
    const savingsStr =
      r.monthlySavings > 0
        ? `${COLOR.green}$${r.monthlySavings}/mo${COLOR.reset}`
        : r.monthlySavings < 0
          ? `${COLOR.red}+$${Math.abs(r.monthlySavings)}/mo${COLOR.reset}`
          : `${COLOR.dim}-${COLOR.reset}`;

    const line =
      `  ${padRight(r.domain, cols.domain.width)}  ` +
      `${padRight(planLabel(r.currentPlan), cols.current.width)}  ` +
      `${padLeft(formatNumber(r.monthlyRequests), cols.requests.width)}  ` +
      `${padLeft(formatBytes(r.monthlyBandwidth), cols.bandwidth.width)}  ` +
      `${padRight(planLabel(r.recommendedPlan), cols.recommended.width)}  ` +
      `${padRight(sc + statusLabel(r.status) + COLOR.reset, cols.status.width + 9)}  ` +
      `${padLeft(savingsStr, cols.savings.width + 9)}`;

    lines.push(line);
  }

  lines.push(`${COLOR.dim}${separator}${COLOR.reset}`);

  // Summary
  const downgrades = results.filter((r) => r.status === "downgrade");
  const upgrades = results.filter((r) => r.status === "upgrade");
  const totalSavings = results.reduce((sum, r) => sum + Math.max(0, r.monthlySavings), 0);

  lines.push("");
  lines.push(`${COLOR.bold}Summary${COLOR.reset}`);
  lines.push(`  Total domains: ${results.length}`);
  if (downgrades.length > 0) {
    lines.push(
      `  ${COLOR.yellow}${downgrades.length} domain(s) could downgrade${COLOR.reset} (est. savings: $${totalSavings}/mo)`
    );
  }
  if (upgrades.length > 0) {
    lines.push(
      `  ${COLOR.red}${upgrades.length} domain(s) may need an upgrade${COLOR.reset}`
    );
  }
  if (downgrades.length === 0 && upgrades.length === 0) {
    lines.push(`  ${COLOR.green}All domains appear to be on appropriate plans.${COLOR.reset}`);
  }

  // Enterprise slot summary
  const enterpriseSlots = options.enterpriseSlots || 0;
  if (enterpriseSlots > 0) {
    const assigned = results.filter((r) => r.enterpriseSlot);
    lines.push(
      `  ${COLOR.cyan}Enterprise slots: ${assigned.length}/${enterpriseSlots} used${COLOR.reset}` +
        (assigned.length > 0
          ? ` (${assigned.map((r) => r.domain).join(", ")})`
          : "")
    );
  }

  // Detail section for domains with recommendations
  const actionable = results.filter((r) => r.status !== "ok");
  if (actionable.length > 0) {
    lines.push("");
    lines.push(`${COLOR.bold}Details${COLOR.reset}`);
    for (const r of actionable) {
      const sc = statusColor(r.status);
      lines.push(
        `  ${sc}${r.domain}${COLOR.reset}: ${planLabel(r.currentPlan)} -> ${planLabel(r.recommendedPlan)}`
      );
      if (r.featureReasons.length > 0) {
        for (const reason of r.featureReasons) {
          lines.push(`    ${COLOR.dim}- ${reason}${COLOR.reset}`);
        }
      }
      const trafficNote =
        r.trafficPlan !== r.currentPlan
          ? `Traffic suggests ${planLabel(r.trafficPlan)} (${formatNumber(r.monthlyRequests)} req, ${formatBytes(r.monthlyBandwidth)})`
          : `Traffic level consistent with ${planLabel(r.trafficPlan)}`;
      lines.push(`    ${COLOR.dim}- ${trafficNote}${COLOR.reset}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatJson(results) {
  return JSON.stringify(results, null, 2);
}

module.exports = { formatTable, formatJson, formatBytes, formatNumber };
