const { BlobServiceClient } = require("@azure/storage-blob");
const JSZip = require("jszip");
const { listZones, getZoneFileExport, runPool } = require("./cloudflare");

const DEFAULT_CONTAINER = "cloudflare-zone-backups";
const CONCURRENCY = 5;

/**
 * Pull BIND zone files for all zones in parallel. Per-zone failures are
 * captured in the result objects rather than thrown so a single bad zone
 * doesn't fail the whole backup.
 *
 * @returns {Promise<Array<{ name: string, plan: string, bind?: string, error?: string }>>}
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

function getBlobServiceClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING is not set. Add it to your .env file."
    );
  }
  return BlobServiceClient.fromConnectionString(conn);
}

// Filesystem-safe ISO 8601 timestamp: 2026-04-26T14-30-00Z
function makeRunId() {
  const now = new Date().toISOString();
  // 2026-04-26T14:30:00.123Z -> 2026-04-26T14-30-00Z
  return now.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * Back up DNS zone files for all Cloudflare zones to Azure Blob Storage.
 *
 * @param {function(object): void} [onProgress] - Called with progress events:
 *   { phase: 'start', total }
 *   { phase: 'zone', current, total, domain, status: 'ok'|'error', error? }
 *   { phase: 'manifest' }
 *   { phase: 'done', runId, total, succeeded, failed, errors }
 * @returns {Promise<{runId, total, succeeded, failed, errors}>}
 */
async function backupAllZones(onProgress = () => {}) {
  const containerName =
    process.env.AZURE_STORAGE_CONTAINER || DEFAULT_CONTAINER;
  const blobService = getBlobServiceClient();
  const container = blobService.getContainerClient(containerName);

  // Ensure container exists. createIfNotExists is idempotent.
  await container.createIfNotExists();

  const runId = makeRunId();
  const prefix = runId;

  // Fetch all BIND files first (this is the slow part). We then iterate over
  // the in-memory results to upload — keeps the Azure-side logic compact.
  let totalForStart;
  const { results } = await fetchAllZoneBindFiles((evt) => {
    if (totalForStart === undefined) {
      totalForStart = evt.total;
      onProgress({ phase: "start", total: evt.total, runId });
    }
    onProgress({ phase: "zone", ...evt });
  });

  // Upload successful fetches to Azure
  let succeeded = 0;
  let failed = 0;
  const errors = [];

  for (const r of results) {
    if (r.error) {
      failed++;
      errors.push({ domain: r.name, error: r.error });
      continue;
    }
    try {
      const blockBlob = container.getBlockBlobClient(`${prefix}/${r.name}.zone`);
      await blockBlob.upload(r.bind, Buffer.byteLength(r.bind, "utf8"), {
        blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
        metadata: { zoneName: r.name, plan: r.plan, runId },
      });
      succeeded++;
    } catch (err) {
      failed++;
      errors.push({ domain: r.name, error: err.message });
    }
  }

  // Upload manifest
  onProgress({ phase: "manifest" });
  const manifest = buildManifest({ runId, container: containerName, results, succeeded, failed });
  const manifestBlob = container.getBlockBlobClient(`${prefix}/manifest.json`);
  const manifestText = JSON.stringify(manifest, null, 2);
  await manifestBlob.upload(manifestText, Buffer.byteLength(manifestText, "utf8"), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });

  const summary = {
    runId,
    total: results.length,
    succeeded,
    failed,
    errors,
    container: containerName,
  };
  onProgress({ phase: "done", ...summary });
  return summary;
}

function buildManifest({ runId, container, results, succeeded, failed }) {
  return {
    runId,
    timestamp: new Date().toISOString(),
    ...(container ? { container } : {}),
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
 * No Azure dependency. Returned as a Node Buffer so the caller can stream it
 * to a download.
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

module.exports = { backupAllZones, buildZoneBackupZip };
