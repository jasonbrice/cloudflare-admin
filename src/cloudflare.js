const https = require("https");
const readline = require("readline");

const API_BASE = "https://api.cloudflare.com/client/v4";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

let _token = null;

async function getToken() {
  if (_token) return _token;

  if (process.env.CLOUDFLARE_API_TOKEN) {
    _token = process.env.CLOUDFLARE_API_TOKEN;
    return _token;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  _token = await new Promise((resolve) => {
    rl.question("Enter your Cloudflare API token: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  return _token;
}

function requestOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Retry wrapper with 429 (rate limited) backoff
async function request(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await requestOnce(url, options);
    if (result.status === 429 && attempt < retries) {
      const backoff = (attempt + 1) * 2000; // 2s, 4s, 6s
      await delay(backoff);
      continue;
    }
    return result;
  }
}

// Same as requestOnce but returns the raw response body without JSON parsing.
// Used by endpoints that return non-JSON content (e.g. DNS zone file export).
function requestOnceText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function requestText(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await requestOnceText(url, options);
    if (result.status === 429 && attempt < retries) {
      const backoff = (attempt + 1) * 2000;
      await delay(backoff);
      continue;
    }
    return result;
  }
}

async function apiGet(path) {
  const token = await getToken();
  const { status, data } = await request(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!data.success) {
    const msg = data.errors?.map((e) => e.message).join(", ") || "Unknown error";
    throw new Error(`Cloudflare API error (${status}): ${msg}`);
  }
  return data;
}

async function graphqlQuery(query, variables = {}) {
  const token = await getToken();
  const { status, data } = await request(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (data.errors?.length) {
    const msg = data.errors.map((e) => e.message).join(", ");
    throw new Error(`GraphQL error (${status}): ${msg}`);
  }
  return data.data;
}

// Small delay to respect rate limits (1200 req / 5 min)
function delay(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Concurrency-limited pool: runs tasks with at most `limit` in parallel
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function listZones() {
  const zones = [];
  const accounts = {};
  let page = 1;
  while (true) {
    const data = await apiGet(`/zones?per_page=50&page=${page}`);
    for (const z of data.result) {
      const acctId = z.account?.id || "unknown";
      if (!accounts[acctId]) {
        accounts[acctId] = { id: acctId, name: z.account?.name || "Unknown", plans: {} };
      }
      const planId = z.plan?.legacy_id || "unknown";
      accounts[acctId].plans[planId] = (accounts[acctId].plans[planId] || 0) + 1;

      zones.push({
        id: z.id,
        name: z.name,
        status: z.status,
        accountId: acctId,
        plan: {
          name: z.plan?.name || "Unknown",
          legacyId: z.plan?.legacy_id || "unknown",
          price: z.plan?.price ?? 0,
        },
      });
    }
    if (data.result_info.page >= data.result_info.total_pages) break;
    page++;
    await delay();
  }
  return { zones, accounts };
}

const ANALYTICS_QUERY = `
  query ZoneAnalytics($zoneTag: string!, $dateStart: Date!, $dateEnd: Date!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          filter: { date_geq: $dateStart, date_leq: $dateEnd }
          limit: 1
        ) {
          count
          sum {
            edgeResponseBytes
          }
        }
      }
    }
  }
`;

// Cloudflare limits query range by plan: Free=1d, Pro=3d, Biz=1w, Ent=30d+.
// Try the requested range first, then fall back to shorter windows.
const FALLBACK_DAYS = [30, 7, 3, 1];

async function getZoneAnalytics(zoneId, days = 30) {
  const trialDays = FALLBACK_DAYS.filter((d) => d <= days);
  if (!trialDays.includes(days)) trialDays.unshift(days);

  for (const tryDays of trialDays) {
    const now = new Date();
    // Use yesterday as dateEnd and go back tryDays from there,
    // so even 1-day queries stay within a single calendar day.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dateEnd = yesterday.toISOString().split("T")[0];
    const since = new Date(yesterday.getTime() - (tryDays - 1) * 24 * 60 * 60 * 1000);
    const dateStart = tryDays === 1 ? dateEnd : since.toISOString().split("T")[0];

    try {
      const data = await graphqlQuery(ANALYTICS_QUERY, {
        zoneTag: zoneId,
        dateStart,
        dateEnd,
      });

      const groups = data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
      if (!groups?.length) {
        return { requests: 0, bandwidth: 0, cachedBytes: 0, uniqueVisitors: 0, days: tryDays };
      }

      const g = groups[0];
      return {
        requests: g.count || 0,
        bandwidth: g.sum?.edgeResponseBytes || 0,
        cachedBytes: 0, // populated by separate cache query
        uniqueVisitors: 0,
        days: tryDays,
      };
    } catch (err) {
      // If the error is about time range, try a shorter window
      if (tryDays !== trialDays[trialDays.length - 1]) {
        continue;
      }
      // All attempts failed — return zeros rather than throwing
      return { requests: 0, bandwidth: 0, cachedBytes: 0, uniqueVisitors: 0, days: 1 };
    }
  }

  // All ranges failed — return zeros
  return { requests: 0, bandwidth: 0, cachedBytes: 0, uniqueVisitors: 0, days: 1 };
}

// Separate cache query using httpRequests1dGroups which supports cachedBytes
const CACHE_QUERY = `
  query ZoneCacheAnalytics($zoneTag: string!, $dateStart: Date!, $dateEnd: Date!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1dGroups(
          filter: { date_geq: $dateStart, date_leq: $dateEnd }
          limit: 1
        ) {
          sum {
            cachedBytes
          }
        }
      }
    }
  }
`;

async function getZoneCacheAnalytics(zoneId, days = 30) {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dateEnd = yesterday.toISOString().split("T")[0];
    const since = new Date(yesterday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    const dateStart = since.toISOString().split("T")[0];

    const data = await graphqlQuery(CACHE_QUERY, { zoneTag: zoneId, dateStart, dateEnd });
    const groups = data?.viewer?.zones?.[0]?.httpRequests1dGroups;
    if (!groups?.length) return 0;
    return groups[0].sum?.cachedBytes || 0;
  } catch {
    return 0;
  }
}

async function getZoneSettings(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/settings`);
    const settings = {};
    for (const s of data.result) {
      settings[s.id] = s.value;
    }
    return settings;
  } catch {
    return {};
  }
}

async function getZoneFirewallRules(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/firewall/rules?per_page=1`);
    return {
      count: data.result_info?.total_count || 0,
    };
  } catch {
    return { count: 0 };
  }
}

async function getZoneCustomCertificates(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/custom_certificates?per_page=1`);
    return {
      count: data.result_info?.total_count || 0,
    };
  } catch {
    return { count: 0 };
  }
}

async function getZoneRateLimits(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/rate_limits?per_page=1`);
    return {
      count: data.result_info?.total_count || 0,
    };
  } catch {
    return { count: 0 };
  }
}

async function getZonePageRules(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/pagerules?per_page=1`);
    return {
      count: data.result_info?.total_count || 0,
    };
  } catch {
    return { count: 0 };
  }
}

// Fetches the BIND-format DNS zone file for a zone.
// Endpoint: GET /zones/{zone_id}/dns_records/export
// Returns plain text (BIND), max 256 KiB. Requires DNS:Read permission.
async function getZoneFileExport(zoneId) {
  const token = await getToken();
  const { status, body } = await requestText(
    `${API_BASE}/zones/${zoneId}/dns_records/export`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/plain",
      },
    }
  );
  if (status < 200 || status >= 300) {
    // The error response is JSON even though the success path is text.
    let message = `HTTP ${status}`;
    try {
      const parsed = JSON.parse(body);
      message =
        parsed.errors?.map((e) => e.message).join(", ") || message;
    } catch {
      // body wasn't JSON; surface the raw text (truncated)
      message = `HTTP ${status}: ${body.slice(0, 200)}`;
    }
    throw new Error(`Cloudflare zone export failed: ${message}`);
  }
  return body;
}

async function getZoneWorkersRoutes(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/workers/routes`);
    return {
      count: data.result?.length || 0,
    };
  } catch {
    return { count: 0 };
  }
}

// Summarizes DNS records for use by the security/optimization recommendation
// engine. Cheap (single REST call) and conservatively returns an empty summary
// on failure so analysis never breaks if DNS:Read is missing.
async function getZoneDnsRecords(zoneName, zoneId) {
  const empty = {
    count: 0,
    hasMx: false,
    hasSpf: false,
    hasDmarc: false,
    subdomainCount: 0,
    apiSubdomainCount: 0,
  };
  try {
    const data = await apiGet(`/zones/${zoneId}/dns_records?per_page=100`);
    const records = data.result || [];
    if (!records.length) return empty;

    const subdomains = new Set();
    let hasMx = false;
    let hasSpf = false;
    let hasDmarc = false;

    for (const r of records) {
      if (r.type === "MX") hasMx = true;

      // SPF lives in a TXT record on the apex starting with "v=spf1"
      if (r.type === "TXT" && /v=spf1/i.test(r.content || "")) hasSpf = true;

      // DMARC lives in a TXT record at _dmarc.<domain>
      if (
        r.type === "TXT" &&
        /^_dmarc\./i.test(r.name || "") &&
        /v=DMARC1/i.test(r.content || "")
      ) {
        hasDmarc = true;
      }

      // Track subdomains (anything beyond the apex). Strip trailing dot if any.
      if (
        (r.type === "A" || r.type === "AAAA" || r.type === "CNAME") &&
        r.name &&
        r.name.toLowerCase() !== zoneName.toLowerCase()
      ) {
        subdomains.add(r.name.toLowerCase());
      }
    }

    let apiSubdomainCount = 0;
    for (const sub of subdomains) {
      const label = sub.split(".")[0];
      if (/^(api|service|services|app|graphql|grpc)$/i.test(label)) {
        apiSubdomainCount++;
      }
    }

    return {
      count: records.length,
      hasMx,
      hasSpf,
      hasDmarc,
      subdomainCount: subdomains.size,
      apiSubdomainCount,
    };
  } catch {
    return empty;
  }
}

async function getZoneDnssec(zoneId) {
  try {
    const data = await apiGet(`/zones/${zoneId}/dnssec`);
    return { status: data.result?.status || "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

// Fetches the Cloudflare audit log for a zone via the account-scoped audit
// log endpoint (legacy v1: /accounts/:id/audit_logs), filtered by zone name.
//
// Required token permission (one of, depending on what the dashboard exposes
// for your account tier):
//   • Account → Audit Logs → Read   (when present in the permission picker)
//   • Account → Account Settings → Read   (works as a fallback on accounts
//       where "Audit Logs" isn't an available scope — verified empirically)
// Neither is in the analyzer's default scopes — operators must add one
// explicitly. The 403 response from CF is surfaced verbatim by the server
// endpoint so misconfigurations are obvious.
//
// `since` is an ISO-8601 string; defaults to 90 days ago. Pagination is
// auto-followed up to `maxPages` (50 records per page).
async function getZoneAuditLog(accountId, zoneName, opts = {}) {
  const { since, maxPages = 4, perPage = 50 } = opts;
  const sinceParam = since
    ? `&since=${encodeURIComponent(since)}`
    : `&since=${encodeURIComponent(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())}`;

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await apiGet(
      `/accounts/${accountId}/audit_logs?per_page=${perPage}&page=${page}&zone.name=${encodeURIComponent(zoneName)}${sinceParam}`
    );
    const items = data.result || [];
    all.push(...items);
    const info = data.result_info || {};
    if (!info.total_pages || info.page >= info.total_pages) break;
    if (items.length < perPage) break;
    await delay();
  }
  return all;
}

async function collectZoneData(zone, days = 30, onProgress) {
  if (onProgress) onProgress(`Analyzing ${zone.name}...`);

  // Run all API calls for this zone in parallel — they are independent
  const [
    analytics,
    cachedBytes,
    settings,
    firewall,
    certs,
    rateLimits,
    pageRules,
    workersRoutes,
    dns,
    dnssec,
  ] = await Promise.all([
    getZoneAnalytics(zone.id, days),
    getZoneCacheAnalytics(zone.id, days),
    getZoneSettings(zone.id),
    getZoneFirewallRules(zone.id),
    getZoneCustomCertificates(zone.id),
    getZoneRateLimits(zone.id),
    getZonePageRules(zone.id),
    getZoneWorkersRoutes(zone.id),
    getZoneDnsRecords(zone.name, zone.id),
    getZoneDnssec(zone.id),
  ]);

  analytics.cachedBytes = cachedBytes;

  return {
    ...zone,
    analytics,
    settings,
    firewall,
    customCertificates: certs,
    rateLimits,
    pageRules,
    workersRoutes,
    dns,
    dnssec,
  };
}

module.exports = {
  listZones,
  getZoneAnalytics,
  getZoneSettings,
  getZoneFirewallRules,
  getZoneCustomCertificates,
  getZoneRateLimits,
  getZonePageRules,
  getZoneWorkersRoutes,
  getZoneFileExport,
  getZoneDnsRecords,
  getZoneDnssec,
  getZoneAuditLog,
  collectZoneData,
  runPool,
  getToken,
};
