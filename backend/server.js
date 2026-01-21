import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { makeClient } from "./s3Client.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Helper: Fast buffer generation
function randomBuffer(len) {
  return Buffer.alloc(len, "A");
}

// --- ADAPTIVE CONCURRENCY CONTROLLER ---
async function adaptiveUpload({ bucket, keys, bytesPerFile }) {
  const s3 = makeClient();
  const fileTimes = {};
  let completed = 0;
  let index = 0;

  // Algorithm Parameters (TCP Slow-Start style)
  let concurrency = 8;
  const minC = 8;
  const maxC = 128; // Cap to prevent socket exhaustion
  let lastThroughput = 0;
  const startAll = Date.now();

  while (index < keys.length) {
    const batchKeys = [];
    // Select batch based on current dynamic concurrency
    for (let i = 0; i < concurrency && index < keys.length; i++, index++) {
      batchKeys.push(keys[index]);
    }

    const batchStart = Date.now();
    let errors = 0;

    // Execute Batch
    await Promise.all(
      batchKeys.map(async (key) => {
        const t0 = Date.now();
        try {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: randomBuffer(bytesPerFile),
              ACL: "public-read",
            }),
          );
          fileTimes[key] = Date.now() - t0;
          completed++;
        } catch (e) {
          errors++;
          console.error(`Upload error ${key}:`, e.code || e.message);
        }
      }),
    );

    // Congestion Control Logic
    const batchSeconds = (Date.now() - batchStart) / 1000 || 0.001;
    const batchMB = (batchKeys.length * bytesPerFile) / (1024 * 1024);
    const batchThroughput = batchMB / batchSeconds;

    if (errors > 0) {
      // Multiplicative Backoff
      concurrency = Math.max(minC, Math.floor(concurrency * 0.5));
    } else {
      // Additive Increase if throughput is growing
      if (batchThroughput > lastThroughput * 1.05) {
        concurrency = Math.min(maxC, concurrency + 4);
      } else if (batchThroughput < lastThroughput * 0.9) {
        // Mild reduction if throughput degrades (congestion avoidance)
        concurrency = Math.max(minC, Math.floor(concurrency * 0.9));
      }
    }
    lastThroughput = batchThroughput;
  }

  const totalSeconds = (Date.now() - startAll) / 1000;
  const totalMB = (bytesPerFile * keys.length) / (1024 * 1024);

  // --- METRICS CALCULATIONS ---
  const times = Object.values(fileTimes);
  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;

  // 1. P95 Calculation
  times.sort((a, b) => a - b);
  const p95Index = Math.floor(times.length * 0.95);
  const p95Ms = times[p95Index];

  // 2. Stability Score (Based on Standard Deviation)
  const squareDiffs = times.map((t) => Math.pow(t - avgMs, 2));
  const avgSquareDiff =
    squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
  const stdDev = Math.sqrt(avgSquareDiff);
  // Score: 100 minus the Coefficient of Variation. Capped at 0.
  const stabilityScore = Math.max(0, 100 - (stdDev / avgMs) * 100);

  return {
    totalFiles: keys.length,
    totalSeconds,
    throughputMBs: totalMB / totalSeconds,
    avgMsPerFile: avgMs,
    p95MsPerFile: p95Ms,
    stabilityScore: stabilityScore,
  };
}

// --- ENDPOINTS ---

app.post("/upload-adaptive", async (req, res) => {
  const { fileCount, fileSizeMB, filePrefix } = req.body;
  const bucket = process.env.BUCKET;

  console.log(`Starting Job: ${filePrefix} (${fileCount} files)`);

  // ZERO PADDING: Ensures files list linearly (-00000.bin, -00001.bin)
  const keys = Array.from(
    { length: fileCount },
    (_, i) => `${filePrefix}/${Date.now()}-${String(i).padStart(5, "0")}.bin`,
  );

  const result = await adaptiveUpload({
    bucket,
    keys,
    bytesPerFile: fileSizeMB * 1024 * 1024,
  });

  console.log(`Finished Job: ${filePrefix}`);
  res.json({ mode: "adaptive", ...result });
});

app.post("/list", async (req, res) => {
  const { prefix } = req.body;
  const s3 = makeClient();

  // UPDATED: Uses Delimiter '/' to support folders
  const cmd = new ListObjectsV2Command({
    Bucket: process.env.BUCKET,
    Prefix: prefix,
    Delimiter: "/",
    MaxKeys: 1000,
  });

  const response = await s3.send(cmd);

  // Map Files
  const files = (response.Contents || []).map((o) => ({
    key: o.Key,
    size: o.Size,
    lastModified: o.LastModified,
    type: "file",
  }));

  // Map Folders (CommonPrefixes)
  const folders = (response.CommonPrefixes || []).map((o) => ({
    key: o.Prefix,
    type: "folder",
  }));

  // Return combined list
  res.json({ items: [...folders, ...files] });
});

app.post("/delete-all", async (req, res) => {
  const { prefix } = req.body;
  const s3 = makeClient();
  const bucket = process.env.BUCKET;

  const listCmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix });
  const listRes = await s3.send(listCmd);

  if (!listRes.Contents || listRes.Contents.length === 0)
    return res.json({ deleted: 0 });

  const delCmd = new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: listRes.Contents.map((o) => ({ Key: o.Key })) },
  });
  const delRes = await s3.send(delCmd);

  res.json({ deleted: delRes.Deleted?.length || 0 });
});

app.listen(3000, () => console.log("Storage Demo API running on port 3000"));
