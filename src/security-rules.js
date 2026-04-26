// Per-domain security & optimization recommendations.
//
// Each rule is a pure function (result, ctx) => recommendation | null.
// Rules are filtered by:
//   - whether they apply to the zone's site profile
//   - whether the zone's current plan supports the recommendation
//   - whether the feature is already enabled
//
// Aim: every recommendation should explain WHY it matters for THIS zone, not
// just "feature X is off". That's what differentiates this from Cloudflare's
// boilerplate panel.

const { detectSiteProfile, profileLabel } = require("./site-profile");

const PLANS = ["free", "pro", "business", "enterprise"];
function planIdx(p) {
  const i = PLANS.indexOf((p || "free").toLowerCase());
  return i === -1 ? 0 : i;
}

const SEVERITY_POINTS = { critical: 30, strong: 15, moderate: 5, weak: 1 };
// Per-severity caps so a domain with 10 weak items doesn't outrank a domain
// with 2 critical ones.
const SEVERITY_CAPS = { critical: 60, strong: 45, moderate: 30, weak: 10 };

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SECURITY_RULES = [
  // 1. Always Use HTTPS
  function alwaysUseHttps(r) {
    if (r.settings?.always_use_https === "on") return null;
    return {
      id: "enable-always-https",
      category: "security",
      severity: "strong",
      title: "Enable Always Use HTTPS",
      why: "Off — visitors on http:// URLs incur an extra redirect and can be downgraded by network attackers before reaching Cloudflare.",
      action: "SSL/TLS → Edge Certificates → Always Use HTTPS",
    };
  },

  // 2. Min TLS version >= 1.2
  function minTls12(r) {
    const v = r.settings?.min_tls_version;
    if (!v || v >= "1.2") return null;
    return {
      id: "min-tls-1.2",
      category: "security",
      severity: "strong",
      title: "Raise minimum TLS version to 1.2",
      why: `Currently TLS ${v}. TLS 1.0/1.1 are deprecated by all major browsers and fail PCI compliance.`,
      action: "SSL/TLS → Edge Certificates → Minimum TLS Version",
    };
  },

  // 3. Automatic HTTPS Rewrites
  function autoHttpsRewrites(r) {
    if (r.settings?.automatic_https_rewrites === "on") return null;
    return {
      id: "auto-https-rewrites",
      category: "security",
      severity: "moderate",
      title: "Enable Automatic HTTPS Rewrites",
      why: "Off — mixed-content (http:// references inside an https:// page) blocks render in modern browsers. Cloudflare can rewrite these on the fly at no cost.",
      action: "SSL/TLS → Edge Certificates → Automatic HTTPS Rewrites",
    };
  },

  // 4. Bot Fight Mode (Free tier only — Pro+ has Super Bot Fight Mode)
  function botFightMode(r, { profile }) {
    if (r.currentPlan !== "free") return null;
    if (profile === "parked" || profile === "email-only") return null;
    if (r.settings?.bot_fight_mode === "on") return null;
    if ((r.monthlyRequests || 0) < 1000) return null;
    return {
      id: "bot-fight-mode",
      category: "security",
      severity: "moderate",
      title: "Enable Bot Fight Mode",
      why: "Free-tier zones have no other automated protection against simple bot traffic. Bot Fight Mode is the no-cost baseline.",
      action: "Security → Bots → Bot Fight Mode",
    };
  },

  // 5. DNSSEC
  function enableDnssec(r, { profile }) {
    if (profile === "parked") return null;
    if (r.dnssec?.status === "active" || r.dnssec?.status === "pending") return null;
    return {
      id: "enable-dnssec",
      category: "security",
      severity: "moderate",
      title: "Enable DNSSEC",
      why: "DNSSEC cryptographically signs DNS responses, preventing on-path attackers from spoofing the zone. Cloudflare manages the keys for you.",
      action: "DNS → Settings → DNSSEC → Enable",
    };
  },

  // 6. SPF (only if MX present)
  function addSpf(r, { profile, signals }) {
    if (!signals.hasMx) return null;
    if (signals.hasSpf) return null;
    if (profile === "parked") return null;
    return {
      id: "add-spf",
      category: "security",
      severity: "moderate",
      title: "Add an SPF record",
      why: "Zone receives email (MX present) but has no SPF TXT record. Without SPF, anyone can spoof email From: this domain — major receivers will mark legit mail as spam.",
      action: "DNS → Records → Add TXT @ \"v=spf1 include:... -all\"",
    };
  },

  // 7. DMARC (only if MX present)
  function addDmarc(r, { profile, signals }) {
    if (!signals.hasMx) return null;
    if (signals.hasDmarc) return null;
    if (profile === "parked") return null;
    return {
      id: "add-dmarc",
      category: "security",
      severity: "moderate",
      title: "Add a DMARC record",
      why: "Zone receives email but has no DMARC policy at _dmarc. DMARC tells receivers what to do with mail that fails SPF/DKIM and gives you a feedback loop.",
      action: "DNS → Records → Add TXT _dmarc \"v=DMARC1; p=none; rua=mailto:...\"",
    };
  },

  // 8. Under Attack mode left on accidentally
  function underAttackLeftOn(r) {
    if (r.settings?.security_level !== "under_attack") return null;
    return {
      id: "under-attack-mode-on",
      category: "security",
      severity: "strong",
      title: "Disable Under Attack mode",
      why: "Under Attack mode is on. This shows a 5-second JavaScript challenge to every visitor — fine during an active incident, terrible for normal traffic. If the attack is over, switch back to Medium.",
      action: "Security → Settings → Security Level → Medium (or High)",
    };
  },

  // 9. Block search-engine indexing on staging
  function blockIndexingStaging(r, { profile }) {
    if (profile !== "dev-staging") return null;
    return {
      id: "block-staging-indexing",
      category: "security",
      severity: "strong",
      title: "Block search-engine indexing of this staging zone",
      why: "Domain name suggests a non-production environment. If this gets indexed by Google, customers may land on it and you'll leak pre-release work.",
      action: "Page rule or Worker that returns X-Robots-Tag: noindex; or password-protect via Cloudflare Access",
    };
  },

  // 10. WAF (Pro+) — only for profiles with real attack surface.
  // Skipped on parked/static/marketing/email-only/dev-staging because WAF
  // protects against payloads that need somewhere to land (DB queries, file
  // operations, etc.) — flagging it on a brochure site is the noise we're
  // trying to avoid.
  function enableWaf(r, { profile }) {
    if (r.settings?.waf === "on") return null;
    // WAF Custom Rules require Pro+. On Free, the plan-recommendation engine
    // already surfaces the upgrade signal — don't double-counsel here.
    if (planIdx(r.currentPlan) < planIdx("pro")) return null;

    if (profile === "dynamic-app") {
      return {
        id: "enable-waf-dynamic",
        category: "security",
        severity: "strong",
        title: "Enable Web Application Firewall (WAF)",
        why: "Dynamic-app profile — forms, auth, and database-backed pages are exactly what WAF is designed to protect. Cloudflare's managed ruleset blocks the OWASP Top-10 payloads (SQLi, XSS, RCE, path traversal) before they reach your origin.",
        action: "Security → WAF → Managed Rules → Enable Cloudflare Managed Ruleset",
      };
    }
    if (profile === "api") {
      return {
        id: "enable-waf-api",
        category: "security",
        severity: "strong",
        title: "Enable Web Application Firewall (WAF)",
        why: "API endpoints are constantly probed for known CVEs and injection patterns. WAF managed rules catch the bulk of these before they hit your origin — especially valuable if any endpoint accepts user input that reaches a database.",
        action: "Security → WAF → Managed Rules → Enable Cloudflare Managed Ruleset",
      };
    }
    if (profile === "high-traffic-prod") {
      return {
        id: "enable-waf-prod",
        category: "security",
        severity: "moderate",
        title: "Enable Web Application Firewall (WAF)",
        why: "Significant traffic volume = bigger target. Even if most pages are static, WAF managed rules add a baseline layer against known CVEs at no marginal cost.",
        action: "Security → WAF → Managed Rules → Enable Cloudflare Managed Ruleset",
      };
    }
    return null;  // intentionally skipped for static/marketing/parked/email/staging
  },

  // 11. Rate limiting — for dynamic-app/api profiles with no rate limit rules.
  // Pro+ only (Free tier has no rate limiting). Strong for API (auth abuse,
  // scraping), moderate for dynamic-app (form spam, brute force).
  function enableRateLimiting(r, { profile }) {
    if ((r.rateLimits?.count || 0) > 0) return null;
    if (planIdx(r.currentPlan) < planIdx("pro")) return null;

    if (profile === "api") {
      return {
        id: "enable-rate-limiting-api",
        category: "security",
        severity: "strong",
        title: "Add a rate-limiting rule",
        why: "API endpoints with no rate limits are wide open to credential stuffing, scraping, and accidental client retry storms. Even a permissive baseline (e.g. 100 req/min/IP) catches the worst offenders.",
        action: "Security → WAF → Rate limiting rules → Create rule",
      };
    }
    if (profile === "dynamic-app") {
      return {
        id: "enable-rate-limiting-app",
        category: "security",
        severity: "moderate",
        title: "Add a rate-limiting rule on auth endpoints",
        why: "Dynamic-app profile typically has login/signup forms. A rule on /login (or your auth path) at e.g. 10 req/min/IP makes credential stuffing infeasible without breaking real users.",
        action: "Security → WAF → Rate limiting rules → Create rule scoped to auth path",
      };
    }
    return null;
  },
];

const PERFORMANCE_RULES = [
  // 10. Polish (Pro+) for static-heavy zones
  function enablePolish(r, { profile }) {
    if (planIdx(r.currentPlan) < planIdx("pro")) return null;
    if (profile !== "static-cdn" && profile !== "high-traffic-prod") return null;
    if (r.settings?.polish && r.settings.polish !== "off") return null;
    return {
      id: "enable-polish",
      category: "performance",
      severity: "moderate",
      title: "Enable Polish (Lossy)",
      why: `${profileLabel(profile)} profile — image bytes are a meaningful share of bandwidth. Polish compresses JPEG/PNG/WebP at the edge with no app changes.`,
      action: "Speed → Optimization → Image Optimization → Polish (Lossy)",
    };
  },

  // 11. Mirage (Pro+) for static-heavy zones
  function enableMirage(r, { profile }) {
    if (planIdx(r.currentPlan) < planIdx("pro")) return null;
    if (profile !== "static-cdn") return null;
    if (r.settings?.mirage === "on") return null;
    return {
      id: "enable-mirage",
      category: "performance",
      severity: "weak",
      title: "Enable Mirage",
      why: "Static-CDN profile — Mirage delivers low-resolution images first to slow connections, then upgrades them, improving perceived load time.",
      action: "Speed → Optimization → Image Optimization → Mirage",
    };
  },

  // 12. Brotli compression
  function enableBrotli(r, { profile }) {
    if (profile === "parked") return null;
    if (r.settings?.brotli === "on") return null;
    return {
      id: "enable-brotli",
      category: "performance",
      severity: "weak",
      title: "Enable Brotli compression",
      why: "Brotli compresses text responses ~15-25% better than gzip with negligible CPU cost. Off by default on some older zones.",
      action: "Speed → Optimization → Content Optimization → Brotli",
    };
  },

  // 13. HTTP/3
  function enableHttp3(r, { profile }) {
    if (profile === "parked") return null;
    if (r.settings?.http3 === "on") return null;
    return {
      id: "enable-http3",
      category: "performance",
      severity: "weak",
      title: "Enable HTTP/3 (with QUIC)",
      why: "HTTP/3 reduces connection setup latency, especially on lossy mobile networks. Browsers fall back to HTTP/2 automatically if unsupported.",
      action: "Network → HTTP/3 (with QUIC)",
    };
  },

  // 14. 0-RTT (Pro+)
  function enable0Rtt(r, { profile }) {
    if (planIdx(r.currentPlan) < planIdx("pro")) return null;
    if (profile === "parked") return null;
    if (r.settings?.["0rtt"] === "on") return null;
    return {
      id: "enable-0rtt",
      category: "performance",
      severity: "weak",
      title: "Enable 0-RTT Connection Resumption",
      why: "Returning visitors skip the TLS handshake, shaving 100-300ms off subsequent requests. Safe for idempotent (GET) traffic.",
      action: "SSL/TLS → Edge Certificates → 0-RTT Connection Resumption",
    };
  },

  // 15. Early Hints
  function enableEarlyHints(r, { profile }) {
    if (profile === "parked" || profile === "email-only") return null;
    if (r.settings?.early_hints === "on") return null;
    return {
      id: "enable-early-hints",
      category: "performance",
      severity: "weak",
      title: "Enable Early Hints",
      why: "Sends 103 Early Hints so the browser can preload critical assets while the origin is still rendering the response. Free win on slow origins.",
      action: "Speed → Optimization → Content Optimization → Early Hints",
    };
  },
];

const PROFILE_RULES = [
  // 16. Parked domain has features enabled
  function parkedHasFeatures(r, { profile, signals }) {
    if (profile !== "parked") return null;
    if (signals.advancedFeatureCount === 0) return null;
    return {
      id: "cleanup-parked-features",
      category: "security",
      severity: "weak",
      title: "Clean up unused features on this parked domain",
      why: `No traffic and no email but ${signals.advancedFeatureCount} advanced feature(s) (firewall/page rules/etc.) are still configured. Drift like this hides real signals on active zones.`,
      action: "Audit firewall rules, page rules, and Workers routes; remove anything not deliberately in place",
    };
  },
];

const ALL_RULES = [...SECURITY_RULES, ...PERFORMANCE_RULES, ...PROFILE_RULES];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { critical: 0, strong: 1, moderate: 2, weak: 3 };

/**
 * Run all rules against a result object and return the recommendations that
 * fired. Sorted by severity (critical first), then by category.
 *
 * Caller is expected to have populated `result.profile` already (analyze()
 * does this), but we re-detect if missing for safety.
 */
function recommendSecurityOptimizations(result) {
  if (!result || result.status === "error") return [];

  const profileInfo = result.profile
    ? { profile: result.profile, signals: result.profileSignals || {} }
    : detectSiteProfile(result);

  const ctx = profileInfo;
  const recs = [];
  for (const rule of ALL_RULES) {
    try {
      const rec = rule(result, ctx);
      if (rec) recs.push(rec);
    } catch {
      // A misbehaving rule should never break analysis. Skip it silently.
    }
  }

  recs.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.category.localeCompare(b.category);
  });

  return recs;
}

/**
 * Aggregate the recommendations into a single 0–100 score so we can show a
 * chip on the card and offer sort/filter on it. Capped per severity so a
 * domain with many weak items doesn't outrank a domain with two critical ones.
 */
function computeSecurityScore(recommendations) {
  if (!recommendations || !recommendations.length) return 0;

  const tally = { critical: 0, strong: 0, moderate: 0, weak: 0 };
  for (const r of recommendations) {
    if (tally[r.severity] !== undefined) tally[r.severity]++;
  }

  let score = 0;
  for (const sev of Object.keys(tally)) {
    score += Math.min(SEVERITY_CAPS[sev], tally[sev] * SEVERITY_POINTS[sev]);
  }
  return Math.min(100, Math.round(score));
}

function securityScoreLabel(score) {
  if (score >= 85) return "critical";
  if (score >= 65) return "strong";
  if (score >= 40) return "moderate";
  if (score > 0) return "weak";
  return "";
}

module.exports = {
  recommendSecurityOptimizations,
  computeSecurityScore,
  securityScoreLabel,
};
