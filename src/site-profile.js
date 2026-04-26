// Pure classifier — no I/O. Takes a zone result enriched by analyze() and
// returns a coarse "site profile" tag plus the signals that drove the choice.
// Recommendation rules use the profile to skip irrelevant suggestions
// (e.g. don't suggest image optimization on an API zone).

// Match domain names that strongly suggest a non-production environment.
// "uat", "sandbox", and "preview" are unambiguous enough that we allow them to
// be glued to the front of the host (e.g. "ambauat-ivr.com"). Shorter/more
// ambiguous keywords (test, dev, qa, stg, staging) require a clear
// boundary character so we don't false-positive on "latest" / "develop" / etc.
const STAGING_RX =
  /(?:uat|sandbox|preview)[-.]|(?:^|[-.])(?:test|staging|stg|dev|qa)([-.]|$)/i;

function totalAdvancedFeatures(result) {
  return (
    (result.firewall?.count || 0) +
    (result.customCertificates?.count || 0) +
    (result.rateLimits?.count || 0) +
    (result.pageRules?.count || 0) +
    (result.workersRoutes?.count || 0)
  );
}

/**
 * Classify a zone into one of several site profiles. First match wins.
 *
 * Profiles:
 *   dev-staging          — name pattern hints at non-production
 *   parked               — no traffic, no MX, no advanced features
 *   email-only           — has MX records, near-zero web traffic
 *   static-cdn           — high cache hit ratio with meaningful traffic
 *   dynamic-app          — low cache, significant traffic
 *   api                  — most subdomains look like API endpoints
 *   high-traffic-prod    — catch-all for big sites not matched above
 *   low-traffic-marketing — fallback default
 */
function detectSiteProfile(result) {
  const name = result.domain || result.name || "";
  const requests = result.monthlyRequests || 0;
  const bandwidth = result.monthlyBandwidth || 0;
  const cacheRatio = result.cacheRatio || 0;
  const dns = result.dns || {};
  const features = totalAdvancedFeatures(result);

  const signals = {
    monthlyRequests: requests,
    monthlyBandwidth: bandwidth,
    cacheRatio,
    hasMx: !!dns.hasMx,
    hasSpf: !!dns.hasSpf,
    hasDmarc: !!dns.hasDmarc,
    dnssecActive: result.dnssec?.status === "active",
    subdomainCount: dns.subdomainCount || 0,
    apiSubdomainCount: dns.apiSubdomainCount || 0,
    advancedFeatureCount: features,
  };

  // 1. dev/staging — name pattern overrides everything else
  if (STAGING_RX.test(name)) {
    return { profile: "dev-staging", signals };
  }

  // 2. parked — no traffic, no MX. Features may be present (and the cleanup
  // rule will flag them) — they don't disqualify the profile.
  if (requests < 100 && !dns.hasMx) {
    return { profile: "parked", signals };
  }

  // 3. email-only — MX present, very little web traffic
  if (dns.hasMx && requests < 1000) {
    return { profile: "email-only", signals };
  }

  // 4. static-cdn — high cache hit ratio with at least some real traffic
  if (cacheRatio > 0.6 && requests >= 10_000) {
    return { profile: "static-cdn", signals };
  }

  // 5. api — majority of subdomains look API-shaped, low cache
  if (
    signals.subdomainCount >= 2 &&
    signals.apiSubdomainCount / signals.subdomainCount > 0.5 &&
    cacheRatio < 0.4
  ) {
    return { profile: "api", signals };
  }

  // 6. dynamic-app — low cache, significant traffic
  if (cacheRatio < 0.3 && requests >= 100_000) {
    return { profile: "dynamic-app", signals };
  }

  // 7. high-traffic-prod — catch-all for big sites not matched above
  if (requests >= 1_000_000) {
    return { profile: "high-traffic-prod", signals };
  }

  // 8. fallback
  return { profile: "low-traffic-marketing", signals };
}

const PROFILE_LABELS = {
  "dev-staging": "Dev / staging",
  "parked": "Parked",
  "email-only": "Email-only",
  "static-cdn": "Static / CDN-friendly",
  "dynamic-app": "Dynamic application",
  "api": "API endpoint",
  "high-traffic-prod": "High-traffic production",
  "low-traffic-marketing": "Low-traffic marketing",
};

function profileLabel(profile) {
  return PROFILE_LABELS[profile] || profile;
}

module.exports = { detectSiteProfile, profileLabel };
