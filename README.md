# Akamai Object Storage AI Ingest Demo

Browser-based ingest and inspection tool for testing **Akamai Cloud Object Storage**
with realistic AI model output workloads.

This demo simulates four AI models that each emit 75 MiB result files into a
shared S3-compatible bucket, and shows how fixed vs adaptive concurrency behave
over a cross-region path (Linode in `us-lax-4` → Object Storage in `us-ord-1`).

## Scenario

- **Models**: 4 independent AI models.
- **Batch workload (every 6 hours)**:
  - Model 1: 260 files
  - Model 2: 520 files
  - Model 3: 8,060 files
  - Model 4: 328 files
- **Average file size**: 75 MiB.
- **Total per batch**: 9,168 files ≈ 0.68 TiB written to one bucket.

The client runs on an **8 GB Dedicated CPU Linode in `us-lax-4`**, uploading to
an Akamai Object Storage bucket in **`us-ord-1`** via the S3-compatible endpoint
`us-ord-1.linodeobjects.com`.

## Features

- **Adaptive concurrency upload**
  - Node.js backend uses an additive-increase / multiplicative-decrease loop to
    discover an efficient concurrency level (up to 128 parallel uploads) based
    on batch throughput and error signals.
- **Fixed concurrency upload**
  - Run comparison tests with a fixed number of parallel uploads to understand
    how different thread counts affect throughput and latency.
- **Run Results dashboard**
  - Cards for sustained throughput (MiB/s), total upload time, files uploaded,
    average and P95 latency, a simple stability score, and RPS vs platform
    headroom.
- **Model-aware file browser**
  - Simple “Index of /bucket/prefix/” view scoped by model/date/hour (e.g.
    `model3/20260115/12/`) with:
    - Parent Directory row
    - Name, last modified, size
    - Delete Folder action to clear a prefix for reruns.

## Architecture

- **Backend** (`backend/`):
  - Node.js + Express.
  - Uses `@aws-sdk/client-s3` against Akamai’s S3-compatible endpoint with
    Signature V4.
  - Endpoints:
    - `POST /upload-adaptive`
    - `POST /upload-fixed`
    - `POST /list`
    - `POST /delete-all`
- **Frontend** (`frontend/`):
  - Single-page HTML/JS app with three tabs:
    - Generate & Upload
    - Run Results
    - File Browser
  - Dark theme, metric cards, and an Apache-style directory listing.

See `docs/Akamai-Object-Storage-Performance-Demo-Guide.md` for a detailed,
step-by-step runbook.

## Quick start

> **Prereqs:** You have Akamai Object Storage access and an 8 GB Dedicated CPU
> Linode (or similar) running Ubuntu in `us-lax-4`.

1. **Clone the repo**

   ```bash
   git clone https://github.com/jgeronim/akamai-object-storage-ai-ingest-demo.git
   cd akamai-object-storage-ai-ingest-demo
   ```
2. Configure Object Storage
   - Create a bucket in us-ord-1.
   - Configure access keys and a bucket policy that allows public GET for demo objects (or adjust the frontend to use signed URLs).
   - Optionally apply CORS with GET/PUT/HEAD/POST methods for browser access.

3. Start the backend
```bash
cd backend
npm install
node server.js
```
The API listens on port 3000 by default.

4. Serve the frontend

```bash
cd ../frontend
npx serve -s . -l 8080
```
Open http://<linode-ip>:8080 in your browser.

5. Run an ingest job
   - Go to the Generate & Upload tab.
   - Use the defaults:
     - Total files: 9168
     - File size (MiB): 75
     - File prefix: model3/20260115/12
     - Mode: Adaptive (Recommended)
   - Click Run Upload Job and watch the status.

When the job finishes, switch to the Run Results tab to see throughput, latency, and stability metrics.

6. Inspect the bucket
   - Open the File Browser tab.
   - Choose the model, date, and hour.
   - Verify that files appear under the expected prefix, and use Delete Folder to clear them before reruns.

### Related reading
docs/Demo-Summary-Write-up.md – Internal summary of the validation run.
Medium article (link TBD) – Narrative walkthrough of the challenge, demo, and results.