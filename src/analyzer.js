// Plan tiers in ascending order
const PLANS = ["free", "pro", "business", "enterprise"];

const PLAN_PRICES = {
  free: 0,
  pro: 20,
  business: 200,
  enterprise: null, // custom
};

// Traffic-volume thresholds (per 30 days)
const TRAFFIC_THRESHOLDS = {
  requests: {
    free: 1_000_000,       // < 1M requests → Free is fine
    pro: 50_000_000,       // 1M–50M → Pro
    business: Infinity,    // > 50M → Business
  },
  bandwidth: {
    free: 10 * 1e9,        // < 10 GB
    pro: 500 * 1e9,        // 10–500 GB
    business: Infinity,    // > 500 GB
  },
};

// Page rule limits per plan
const PAGE_RULE_LIMITS = {
  free: 3,
  pro: 20,
  business: 50,
  enterprise: 125,
};

// Cache discount factor: high cache ratios soften bandwidth-based upgrade signals.
// 0.5 means a 90% cache ratio reduces effective bandwidth by 45%.
const CACHE_DISCOUNT = 0.5;

function planIndex(planId) {
  const normalized = normalizePlanId(planId);
  const idx = PLANS.indexOf(normalized);
  return idx === -1 ? 0 : idx;
}

function normalizePlanId(planId) {
  if (!planId) return "free";
  const lower = planId.toLowerCase();
  if (lower.includes("enterprise")) return "enterprise";
  if (lower.includes("business")) return "business";
  if (lower.includes("pro")) return "pro";
  return "free";
}

function fmtBytes(b) {
  if (b === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + " " + u[i];
}

function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function recommendByTraffic(analytics) {
  const { requests, bandwidth, cachedBytes, days } = analytics;

  // Normalize to 30-day period
  const scale = days > 0 ? 30 / days : 1;
  const monthlyRequests = requests * scale;
  const monthlyBandwidth = bandwidth * scale;
  const cacheRatio = bandwidth > 0 ? cachedBytes / bandwidth : 0;

  // Apply cache discount to bandwidth assessment
  const effectiveBandwidth = monthlyBandwidth * (1 - cacheRatio * CACHE_DISCOUNT);

  const reasons = [];

  // Request-based recommendation
  let trafficPlan = "free";
  if (monthlyRequests >= TRAFFIC_THRESHOLDS.requests.pro) {
    trafficPlan = "business";
    reasons.push(`${fmtNum(monthlyRequests)} requests/mo exceeds Pro tier limit (${fmtNum(TRAFFIC_THRESHOLDS.requests.pro)})`);
  } else if (monthlyRequests >= TRAFFIC_THRESHOLDS.requests.free) {
    trafficPlan = "pro";
    reasons.push(`${fmtNum(monthlyRequests)} requests/mo exceeds Free tier limit (${fmtNum(TRAFFIC_THRESHOLDS.requests.free)})`);
  } else {
    reasons.push(`${fmtNum(monthlyRequests)} requests/mo is within Free tier limit (${fmtNum(TRAFFIC_THRESHOLDS.requests.free)})`);
  }

  // Bandwidth-based recommendation (using effective bandwidth)
  let bandwidthPlan = "free";
  if (effectiveBandwidth >= TRAFFIC_THRESHOLDS.bandwidth.pro) {
    bandwidthPlan = "business";
    reasons.push(`${fmtBytes(monthlyBandwidth)} bandwidth/mo exceeds Pro tier limit (${fmtBytes(TRAFFIC_THRESHOLDS.bandwidth.pro)})`);
  } else if (effectiveBandwidth >= TRAFFIC_THRESHOLDS.bandwidth.free) {
    bandwidthPlan = "pro";
    reasons.push(`${fmtBytes(monthlyBandwidth)} bandwidth/mo exceeds Free tier limit (${fmtBytes(TRAFFIC_THRESHOLDS.bandwidth.free)})`);
  } else {
    reasons.push(`${fmtBytes(monthlyBandwidth)} bandwidth/mo is within Free tier limit (${fmtBytes(TRAFFIC_THRESHOLDS.bandwidth.free)})`);
  }

  // Cache ratio context
  if (cacheRatio > 0.5) {
    reasons.push(`${(cacheRatio * 100).toFixed(0)}% cache hit ratio reduces effective bandwidth load`);
  }

  // Take the higher of the two
  const plan = planIndex(bandwidthPlan) > planIndex(trafficPlan) ? bandwidthPlan : trafficPlan;
  return { plan, reasons };
}

function recommendByFeatures(zoneData) {
  const reasons = [];
  let requiredPlan = "free";

  function requireAtLeast(plan, reason) {
    if (planIndex(plan) > planIndex(requiredPlan)) {
      requiredPlan = plan;
    }
    reasons.push(reason);
  }

  // Custom SSL certificates → Business+
  if (zoneData.customCertificates?.count > 0) {
    requireAtLeast("business", "Custom SSL certificates uploaded");
  }

  // WAF / firewall rules → Pro+
  if (zoneData.firewall?.count > 0) {
    requireAtLeast("pro", `${zoneData.firewall.count} firewall rule(s) active`);
  }

  // Rate limiting rules → Business+ (advanced usage)
  if (zoneData.rateLimits?.count > 2) {
    requireAtLeast("business", `${zoneData.rateLimits.count} rate limit rules (advanced)`);
  } else if (zoneData.rateLimits?.count > 0) {
    requireAtLeast("pro", `${zoneData.rateLimits.count} rate limit rule(s)`);
  }

  // Page rules — exceeding plan limits signals upgrade
  const pageRuleCount = zoneData.pageRules?.count || 0;
  if (pageRuleCount > PAGE_RULE_LIMITS.business) {
    requireAtLeast("enterprise", `${pageRuleCount} page rules exceeds Business limit (${PAGE_RULE_LIMITS.business})`);
  } else if (pageRuleCount > PAGE_RULE_LIMITS.pro) {
    requireAtLeast("business", `${pageRuleCount} page rules exceeds Pro limit (${PAGE_RULE_LIMITS.pro})`);
  } else if (pageRuleCount > PAGE_RULE_LIMITS.free) {
    requireAtLeast("pro", `${pageRuleCount} page rules exceeds Free limit (${PAGE_RULE_LIMITS.free})`);
  }

  // Workers routes → Pro+
  if (zoneData.workersRoutes?.count > 0) {
    requireAtLeast("pro", `${zoneData.workersRoutes.count} Workers route(s) configured`);
  }

  // Settings-based checks
  const settings = zoneData.settings || {};

  // WAF enabled → Pro+
  if (settings.waf === "on") {
    requireAtLeast("pro", "WAF enabled");
  }

  // Advanced security level
  if (settings.security_level === "under_attack") {
    requireAtLeast("pro", "Under Attack mode active");
  }

  // Image optimization (Polish/Mirage) → Pro+
  if (settings.polish && settings.polish !== "off") {
    requireAtLeast("pro", `Image optimization (Polish: ${settings.polish})`);
  }
  if (settings.mirage === "on") {
    requireAtLeast("pro", "Mirage (image lazy loading) enabled");
  }

  return { requiredPlan, reasons };
}

function analyze(zoneData) {
  const currentPlanId = normalizePlanId(zoneData.plan?.legacyId || zoneData.plan?.name);
  const currentIdx = planIndex(currentPlanId);

  const { plan: trafficPlan, reasons: trafficReasons } = recommendByTraffic(zoneData.analytics);
  const { requiredPlan: featurePlan, reasons: featureReasons } = recommendByFeatures(zoneData);

  // Take the max of traffic and feature recommendations
  const recommendedPlan =
    planIndex(trafficPlan) > planIndex(featurePlan) ? trafficPlan : featurePlan;
  const recommendedIdx = planIndex(recommendedPlan);

  let status;
  if (recommendedIdx === currentIdx) {
    status = "ok";
  } else if (recommendedIdx < currentIdx) {
    status = "downgrade";
  } else {
    status = "upgrade";
  }

  const currentPrice = PLAN_PRICES[currentPlanId] ?? 0;
  const recommendedPrice = PLAN_PRICES[recommendedPlan] ?? 0;
  const monthlySavings = currentPrice - recommendedPrice;

  // Normalize analytics to monthly for display
  const scale = zoneData.analytics.days > 0 ? 30 / zoneData.analytics.days : 1;
  const monthlyRequests = Math.round(zoneData.analytics.requests * scale);
  const monthlyBandwidth = Math.round(zoneData.analytics.bandwidth * scale);
  const cacheRatio = zoneData.analytics.bandwidth > 0
    ? zoneData.analytics.cachedBytes / zoneData.analytics.bandwidth
    : 0;

  // Headroom: how close is this domain to the next tier's limits?
  const headroom = {
    requests: {
      current: monthlyRequests,
      limit: TRAFFIC_THRESHOLDS.requests[recommendedPlan],
      percent: TRAFFIC_THRESHOLDS.requests[recommendedPlan] === Infinity
        ? 0
        : Math.round((monthlyRequests / TRAFFIC_THRESHOLDS.requests[recommendedPlan]) * 100),
    },
    bandwidth: {
      current: monthlyBandwidth,
      limit: TRAFFIC_THRESHOLDS.bandwidth[recommendedPlan],
      percent: TRAFFIC_THRESHOLDS.bandwidth[recommendedPlan] === Infinity
        ? 0
        : Math.round((monthlyBandwidth / TRAFFIC_THRESHOLDS.bandwidth[recommendedPlan]) * 100),
    },
    pageRules: {
      current: zoneData.pageRules?.count || 0,
      limit: PAGE_RULE_LIMITS[recommendedPlan],
      percent: Math.round(((zoneData.pageRules?.count || 0) / PAGE_RULE_LIMITS[recommendedPlan]) * 100),
    },
  };

  // Feature summary for the detail view
  const settings = zoneData.settings || {};
  const features = {
    waf: settings.waf === "on",
    firewallRules: zoneData.firewall?.count || 0,
    customSSL: zoneData.customCertificates?.count || 0,
    rateLimits: zoneData.rateLimits?.count || 0,
    pageRules: zoneData.pageRules?.count || 0,
    workersRoutes: zoneData.workersRoutes?.count || 0,
    polish: settings.polish || "off",
    mirage: settings.mirage === "on",
    underAttack: settings.security_level === "under_attack",
  };

  return {
    domain: zoneData.name,
    currentPlan: currentPlanId,
    currentPrice,
    recommendedPlan,
    recommendedPrice,
    status,
    monthlySavings,
    trafficPlan,
    featurePlan,
    trafficReasons,
    featureReasons,
    monthlyRequests,
    monthlyBandwidth,
    uniqueVisitors: zoneData.analytics.uniqueVisitors,
    cacheRatio,
    headroom,
    features,
    analysisDays: zoneData.analytics.days,
  };
}

/**
 * Post-processing step: assign enterprise slots to the highest-traffic domains
 * that would otherwise need Business tier (or are already enterprise).
 * Slots are awarded by descending monthly traffic (requests + bandwidth score).
 */
function assignEnterpriseSlots(results, slots) {
  if (!slots || slots <= 0) return results;

  // Candidates: only domains whose base recommendation is "business" qualify
  // for enterprise slots. Current enterprise domains with lower base
  // recommendations (free/pro) should show as downgrade candidates.
  const candidates = results
    .filter((r) => r.recommendedPlan === "business")
    .sort((a, b) => {
      // Primary: monthly requests descending
      if (b.monthlyRequests !== a.monthlyRequests)
        return b.monthlyRequests - a.monthlyRequests;
      // Tiebreak: monthly bandwidth descending
      return b.monthlyBandwidth - a.monthlyBandwidth;
    });

  const awarded = new Set();
  for (let i = 0; i < Math.min(slots, candidates.length); i++) {
    awarded.add(candidates[i].domain);
  }

  return results.map((r) => {
    if (awarded.has(r.domain)) {
      // Domain wins an enterprise slot
      const currentIdx = planIndex(r.currentPlan);
      const enterpriseIdx = planIndex("enterprise");
      let status;
      if (enterpriseIdx === currentIdx) {
        status = "ok";
      } else if (enterpriseIdx < currentIdx) {
        status = "downgrade";
      } else {
        status = "upgrade";
      }

      return {
        ...r,
        recommendedPlan: "enterprise",
        recommendedPrice: 0, // covered by account-level enterprise agreement
        status,
        monthlySavings: r.currentPrice - 0,
        enterpriseSlot: true,
      };
    }

    // Domain did not win a slot — return base recommendation as-is.
    // Enterprise domains whose base recommendation is lower will
    // naturally show as "downgrade" from the analyze() step.
    return r;
  });
}

module.exports = { analyze, assignEnterpriseSlots, normalizePlanId, PLAN_PRICES, PLANS, TRAFFIC_THRESHOLDS, PAGE_RULE_LIMITS };
