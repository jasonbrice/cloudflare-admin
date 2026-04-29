const JSZip = require("jszip");
const { listZones, getZoneFileExport, runPool } = require("./cloudflare");

const CONCURRENCY = 5;

/**
 * Pull BIND zone files for all zones in parallel. Per-zone failures are
 * captured in the result objects rather than thrown so a single bad zone
 * doesn't fail the whole backup.
 *
 * @returns {Promise<{ zones: Array, results: Array<{ name: string, plan: string, bind?: string, error?: string }> }>}
 */
async function fetchAllZoneBindFiles(onZone = () => {}) {
  const { zones } = await listZones();
  let completed = 0;
  const results = await runPool(zones, CONCURRENCY, async (zone) => {
    const out = { name: zone.name, plan: zone.plan?.legacyId || "unknown" };
    try {
      out.bind = await getZoneFileExport(zone.id);
    } catch (err) {
      out.error = err.message;
    }
    completed++;
    onZone({ current: completed, total: zones.length, domain: zone.name, status: out.error ? "error" : "ok", error: out.error });
    return out;
  });
  return { zones, results };
}

// Filesystem-safe ISO 8601 timestamp: 2026-04-26T14-30-00Z
function makeRunId() {
  const now = new Date().toISOString();
  // 2026-04-26T14:30:00.123Z -> 2026-04-26T14-30-00Z
  return now.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function buildManifest({ runId, results, succeeded, failed }) {
  return {
    runId,
    timestamp: new Date().toISOString(),
    total: results.length,
    succeeded,
    failed,
    zones: results.map((r) => ({
      domain: r.name,
      status: r.error ? "error" : "ok",
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}

/**
 * Build a ZIP archive containing every zone's BIND file plus a manifest.json.
 * Returned as a Node Buffer so the caller can stream it to a download.
 *
 * @param {function(object): void} [onProgress]
 * @returns {Promise<{ buffer: Buffer, filename: string, summary: object }>}
 */
async function buildZoneBackupZip(onProgress = () => {}) {
  const runId = makeRunId();

  let totalForStart;
  const { results } = await fetchAllZoneBindFiles((evt) => {
    if (totalForStart === undefined) {
      totalForStart = evt.total;
      onProgress({ phase: "start", total: evt.total, runId });
    }
    onProgress({ phase: "zone", ...evt });
  });

  onProgress({ phase: "zip" });

  const zip = new JSZip();
  const folder = zip.folder(runId);
  let succeeded = 0;
  let failed = 0;
  const errors = [];

  for (const r of results) {
    if (r.error) {
      failed++;
      errors.push({ domain: r.name, error: r.error });
      continue;
    }
    folder.file(`${r.name}.zone`, r.bind);
    succeeded++;
  }

  const manifest = buildManifest({ runId, results, succeeded, failed });
  folder.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const summary = { runId, total: results.length, succeeded, failed, errors };
  onProgress({ phase: "done", ...summary });

  return {
    buffer,
    filename: `cloudflare-zones-${runId}.zip`,
    summary,
  };
}

module.exports = { buildZoneBackupZip };
