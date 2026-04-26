const { BlobServiceClient } = require("@azure/storage-blob");
const { listZones, getZoneFileExport, runPool } = require("./cloudflare");

const DEFAULT_CONTAINER = "cloudflare-zone-backups";
const CONCURRENCY = 5;

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

  const { zones } = await listZones();
  const runId = makeRunId();
  const prefix = runId; // folder-like blob prefix

  onProgress({ phase: "start", total: zones.length, runId });

  const errors = [];
  let succeeded = 0;
  let failed = 0;
  let completed = 0;

  const results = await runPool(zones, CONCURRENCY, async (zone) => {
    const result = { domain: zone.name, status: "ok" };
    try {
      const bind = await getZoneFileExport(zone.id);
      const blobName = `${prefix}/${zone.name}.zone`;
      const blockBlob = container.getBlockBlobClient(blobName);
      await blockBlob.upload(bind, Buffer.byteLength(bind, "utf8"), {
        blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
        metadata: {
          zoneId: zone.id,
          zoneName: zone.name,
          plan: zone.plan?.legacyId || "unknown",
          runId,
        },
      });
      succeeded++;
    } catch (err) {
      result.status = "error";
      result.error = err.message;
      errors.push({ domain: zone.name, error: err.message });
      failed++;
    }

    completed++;
    onProgress({
      phase: "zone",
      current: completed,
      total: zones.length,
      domain: zone.name,
      status: result.status,
      error: result.error,
    });

    return result;
  });

  // Upload manifest
  onProgress({ phase: "manifest" });
  const manifest = {
    runId,
    timestamp: new Date().toISOString(),
    container: containerName,
    total: zones.length,
    succeeded,
    failed,
    zones: results.map((r) => ({
      domain: r.domain,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
  const manifestBlob = container.getBlockBlobClient(`${prefix}/manifest.json`);
  const manifestText = JSON.stringify(manifest, null, 2);
  await manifestBlob.upload(manifestText, Buffer.byteLength(manifestText, "utf8"), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });

  const summary = {
    runId,
    total: zones.length,
    succeeded,
    failed,
    errors,
    container: containerName,
  };
  onProgress({ phase: "done", ...summary });
  return summary;
}

module.exports = { backupAllZones };
