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

function recommendByTraffic(analytics) {
  const { requests, bandwidth, days } = analytics;

  // Normalize to 30-day period
  const scale = days > 0 ? 30 / days : 1;
  const monthlyRequests = requests * scale;
  const monthlyBandwidth = bandwidth * scale;

  let trafficPlan = "free";

  if (monthlyRequests >= TRAFFIC_THRESHOLDS.requests.pro) {
    trafficPlan = "business";
  } else if (monthlyRequests >= TRAFFIC_THRESHOLDS.requests.free) {
    trafficPlan = "pro";
  }

  let bandwidthPlan = "free";
  if (monthlyBandwidth >= TRAFFIC_THRESHOLDS.bandwidth.pro) {
    bandwidthPlan = "business";
  } else if (monthlyBandwidth >= TRAFFIC_THRESHOLDS.bandwidth.free) {
    bandwidthPlan = "pro";
  }

  // Take the higher of the two
  return planIndex(bandwidthPlan) > planIndex(trafficPlan) ? bandwidthPlan : trafficPlan;
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

  // Minification (available on all plans, but heavy use suggests Pro)
  // Not a hard requirement, skip

  return { requiredPlan, reasons };
}

function analyze(zoneData) {
  const currentPlanId = normalizePlanId(zoneData.plan?.legacyId || zoneData.plan?.name);
  const currentIdx = planIndex(currentPlanId);

  const trafficPlan = recommendByTraffic(zoneData.analytics);
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
    featureReasons,
    monthlyRequests: Math.round(zoneData.analytics.requests * scale),
    monthlyBandwidth: Math.round(zoneData.analytics.bandwidth * scale),
    uniqueVisitors: zoneData.analytics.uniqueVisitors,
    cacheRatio:
      zoneData.analytics.bandwidth > 0
        ? zoneData.analytics.cachedBytes / zoneData.analytics.bandwidth
        : 0,
  };
}

/**
 * Post-processing step: assign enterprise slots to the highest-traffic domains
 * that would otherwise need Business tier (or are already enterprise).
 * Slots are awarded by descending monthly traffic (requests + bandwidth score).
 */
function assignEnterpriseSlots(results, slots) {
  if (!slots || slots <= 0) return results;

  // Candidates: domains whose base recommendation is "business" (they'd benefit
  // most from enterprise) or that are already on enterprise.
  const candidates = results
    .filter(
      (r) =>
        r.recommendedPlan === "business" ||
        r.currentPlan === "enterprise"
    )
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
    if (!awarded.has(r.domain)) return r;

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
  });
}

module.exports = { analyze, assignEnterpriseSlots, normalizePlanId, PLAN_PRICES, PLANS };
