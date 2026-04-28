const { detectSiteProfile } = require("./site-profile");
const {
  recommendSecurityOptimizations,
  computeSecurityScore,
  computePerformanceScore,
  securityScoreLabel,
  performanceScoreLabel,
} = require("./security-rules");

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

// Recommendation strength weights. Scores are 0–100; components are added and
// clamped. Tune to reshape how aggressively the UI surfaces upgrade/downgrade
// candidates. The activity component uses a continuous log scale so domains
// with e.g. 10 req/mo vs 100K req/mo produce meaningfully different scores
// even when both are clearly under-utilizing the current plan.
const SCORE_WEIGHTS = {
  tierGap: 20,         // per tier of difference — smaller so other signals differentiate
  bothSignalsAgree: 15, // upgrade bonus when traffic AND features both point up
  overage: 25,         // upgrade bonus for being well past current plan's ceiling
  featureIntensity: 10, // upgrade bonus for heavy feature usage
  inactivity: 40,      // downgrade bonus — continuous, higher = less activity
  noFeatures: 10,      // downgrade bonus when no advanced features are in use
  savings: 10,         // downgrade bonus for larger monthly savings
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

// Count meaningful features in use. Used as a tiebreaker — domains with more
// features in play are weaker downgrade candidates and stronger upgrade signals.
function featureIntensity(result) {
  const f = result.features || {};
  return (
    (f.waf ? 1 : 0) +
    (f.firewallRules > 0 ? 1 : 0) +
    (f.customSSL > 0 ? 1 : 0) +
    (f.rateLimits > 0 ? 1 : 0) +
    ((f.pageRules || 0) > 3 ? 1 : 0) +
    (f.workersRoutes > 0 ? 1 : 0) +
    (f.polish && f.polish !== "off" ? 1 : 0) +
    (f.mirage ? 1 : 0) +
    (f.underAttack ? 1 : 0)
  );
}

// Continuous activity magnitude on a log scale. Returns a unitless number that
// grows as the domain uses more of Cloudflare's bandwidth/request capacity.
// A quiet domain (tens of req/mo, tiny bandwidth) → near 0.
// A busy domain (1M req + 1GB/mo) → around 8.
// Enterprise-scale domains (tens of M req + hundreds of GB) → 12+.
function activityMagnitude(result) {
  const reqs = Math.max(1, result.monthlyRequests || 0);
  const bwMB = Math.max(1, (result.monthlyBandwidth || 0) / 1e6);
  return Math.log10(reqs) + Math.log10(bwMB) * 0.5;
}

// Strength score (0–100) for how compelling an upgrade/downgrade recommendation
// is. "ok" always scores 0 so it sorts to the bottom on a strength-sorted view.
// The downgrade side uses a continuous log-scale activity component so that
// low-traffic domains spread across the top of the score range (useful when
// pruning a large pool of enterprise slots) rather than clustering at 100.
function computeScore(result) {
  if (result.status === "ok" || result.status === "error") return 0;

  const currentIdx = planIndex(result.currentPlan);
  const recIdx = planIndex(result.recommendedPlan);
  const tierGap = Math.abs(recIdx - currentIdx);

  let score = tierGap * SCORE_WEIGHTS.tierGap;

  if (result.status === "upgrade") {
    // Traffic and features both point up → strong confirmation
    if (planIndex(result.trafficPlan) > currentIdx && planIndex(result.featurePlan) > currentIdx) {
      score += SCORE_WEIGHTS.bothSignalsAgree;
    }

    // Continuous overage against the current plan's ceiling
    const reqLimit = TRAFFIC_THRESHOLDS.requests[result.currentPlan];
    const bwLimit = TRAFFIC_THRESHOLDS.bandwidth[result.currentPlan];
    let overageLog = 0;
    if (reqLimit !== Infinity && reqLimit > 0 && result.monthlyRequests > reqLimit) {
      overageLog = Math.max(overageLog, Math.log2(result.monthlyRequests / reqLimit));
    }
    if (bwLimit !== Infinity && bwLimit > 0 && result.monthlyBandwidth > bwLimit) {
      overageLog = Math.max(overageLog, Math.log2(result.monthlyBandwidth / bwLimit));
    }
    // 1x over → 0, 2x → 5, 4x → 10, 8x → 15, 16x → 20, 32x+ → 25
    score += Math.min(SCORE_WEIGHTS.overage, overageLog * 5);

    // Feature-driven pressure (multiple advanced features in play)
    const fi = featureIntensity(result);
    score += Math.min(SCORE_WEIGHTS.featureIntensity, fi * 2);
  } else if (result.status === "downgrade") {
    // Continuous activity-based inactivity bonus. Near-zero activity → full
    // bonus; heavy activity → none. Calibrated so an empty domain maxes out
    // and a domain doing 1M req + 1GB/mo gets roughly half the bonus.
    const activity = activityMagnitude(result);
    // activity=0 → full 40; activity=8 → 8; activity=10 → 0
    const inactivityBonus = Math.max(0, SCORE_WEIGHTS.inactivity - activity * 4);
    score += inactivityBonus;

    // No advanced features in use → stronger downgrade signal
    const fi = featureIntensity(result);
    if (fi === 0) score += SCORE_WEIGHTS.noFeatures;
    else if (fi <= 2) score += SCORE_WEIGHTS.noFeatures * 0.5;

    // Savings magnitude (smaller weight now — mostly a tiebreaker)
    const savings = result.monthlySavings || 0;
    if (savings >= 200) score += SCORE_WEIGHTS.savings;
    else if (savings >= 20) score += SCORE_WEIGHTS.savings * 0.5;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreLabel(score) {
  if (score >= 85) return "critical";
  if (score >= 65) return "strong";
  if (score >= 40) return "moderate";
  if (score > 0) return "weak";
  return "";
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

  const base = {
    domain: zoneData.name,
    zoneId: zoneData.id,
    accountId: zoneData.accountId,
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
    // Carry through raw signals so the recommendation engine can read them
    // here AND so /api/cached can recompute recs without re-fetching.
    settings: zoneData.settings || {},
    dns: zoneData.dns || {},
    dnssec: zoneData.dnssec || {},
  };

  const score = computeScore(base);

  // Site profile + security/optimization recommendations
  const profileInfo = detectSiteProfile(base);
  base.profile = profileInfo.profile;
  base.profileSignals = profileInfo.signals;

  // Both security and performance recommendations live in the same array.
  // We score them separately so each gets its own card-line, sort, and filter.
  const securityRecommendations = recommendSecurityOptimizations(base);
  const securityScore = computeSecurityScore(securityRecommendations);
  const performanceScore = computePerformanceScore(securityRecommendations);

  return {
    ...base,
    score,
    scoreLabel: scoreLabel(score),
    securityRecommendations,
    securityScore,
    securityScoreLabel: securityScoreLabel(securityScore),
    performanceScore,
    performanceScoreLabel: performanceScoreLabel(performanceScore),
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

      const updated = {
        ...r,
        recommendedPlan: "enterprise",
        recommendedPrice: 0, // covered by account-level enterprise agreement
        status,
        monthlySavings: r.currentPrice - 0,
        enterpriseSlot: true,
      };
      const newScore = computeScore(updated);
      return { ...updated, score: newScore, scoreLabel: scoreLabel(newScore) };
    }

    // Domain did not win a slot — return base recommendation as-is.
    // Enterprise domains whose base recommendation is lower will
    // naturally show as "downgrade" from the analyze() step.
    return r;
  });
}

module.exports = { analyze, assignEnterpriseSlots, normalizePlanId, computeScore, scoreLabel, PLAN_PRICES, PLANS, TRAFFIC_THRESHOLDS, PAGE_RULE_LIMITS, SCORE_WEIGHTS };
