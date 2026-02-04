# Project: Akamai Object Storage Performance Demo

**Resilient Deployment with VS Code, PM2, and Automation**

**Akamai Linode 8 GB Dedicated CPU (us‑lax‑4) → Akamai Object Storage (us‑ord‑1)**

**Goal:** Build a robust, self-healing Storage Testing UI that uploads randomly generated payloads using adaptive concurrency and provides a live "Index of /bucket/" browser view.

---

## PART 1: Infrastructure & Environment Setup

**Objective:** Provision the required cloud resources with high specificity and configure the local development environment.

### Step 1.1: Local Tooling & CLI Configuration

*(Run these commands on your local machine)*

If you haven't already, install the Linode CLI to manage resources programmatically.

```bash
# Mac (Homebrew)
brew install linode-cli s3cmd jq

# Configure CLI (Follow prompts for API Token)
linode-cli configure

# Verify Regions
# We need 'us-lax' (Los Angeles) for Compute and 'us-ord' (Chicago) for Storage
linode-cli regions list | grep -E "us-lax|us-ord"

```

### Step 1.2: Create Object Storage Keys & Bucket

We will create the storage resources first to generate the credentials needed later.

1. **Create Access Keys:**
```bash
linode-cli object-storage keys-create --label storage-demo-keys

```


*Copy the `access_key` and `secret_key` from the output. You will need them for the `.env` file.*
2. **Configure s3cmd:**
Run the interactive configure tool.
```bash
s3cmd --configure

```


* **Access Key / Secret Key:** (Paste from above)
* **Default Region:** `us-ord-1`
* **S3 Endpoint:** `us-ord-1.linodeobjects.com`
* **DNS-style bucket+hostname:** `%(bucket)s.us-ord-1.linodeobjects.com`


3. **Provision the Bucket:**
```bash
s3cmd mb s3://storage-demo-bucket

```



### Step 1.3: Configure Bucket Permissions (Public Read & CORS)

Detailed security configuration is required for the "Index of" browser view and the JS Frontend to work correctly.

1. **Set Public Read Policy (Demo Only):**
Allows direct HTTP downloads of generated files.
Bash
```
cat > bucket-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::storage-demo-bucket/*"]
  }]
}
EOF

s3cmd setpolicy bucket-policy.json s3://storage-demo-bucket

```


2. **Configure CORS (Cross-Origin Resource Sharing):**
Required for the Single Page App (running on the Linode) to talk to the Object Store (on a different domain).
Bash
```
cat > cors.json << 'EOF'
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-ratelimit-limit</ExposeHeader>
    <ExposeHeader>x-ratelimit-remaining</ExposeHeader>
  </CORSRule>
</CORSConfiguration>
EOF

s3cmd setcors cors.json s3://storage-demo-bucket

```



### Step 1.4: Provision Compute Instance (Client)

We deploy a **Dedicated CPU** instance to ensure consistent network throughput and CPU performance for generating random payloads.
Bash
```
# Create Dedicated 8 GB in us-lax-4
linode-cli linodes create \
  --root_pass 'CHANGEME-strong-password' \
  --region us-lax \
  --type g6-dedicated-8 \
  --label storage-demo-client \
  --image linode/ubuntu24.04

```

* **Note the Public IP Address** returned in the output.
* *Why `us-lax`?* This creates a cross-region path to `us-ord`, simulating a realistic WAN traversal for the performance test.

### Step 1.5: Connect via VS Code Remote - SSH

Instead of a raw terminal, use VS Code for integrated file editing and terminal management.

1. **Install Extension:** Install **Remote - SSH** (Microsoft) in VS Code.
2. **Configure Host:**
* Press `F1` > Type `Remote-SSH: Open Configuration File`.
* Select your config file (e.g., `~/.ssh/config`) and add:
```text
Host akamai-demo
    HostName <LINODE_PUBLIC_IP>
    User root
    # IdentityFile ~/.ssh/id_rsa  <-- Recommended: Use SSH keys

```




3. **Connect:**
* Press `F1` > `Remote-SSH: Connect to Host` > Select `akamai-demo`.
* A new VS Code window will open. Open the Integrated Terminal (`Ctrl + ~`).



### Step 1.6: Server Environment Setup

*(Run these in the VS Code Terminal on the Linode)*

```bash
# 1. Update System and Install Core Tools
apt-get update
apt-get install -y curl git jq unzip

# 2. Install Node.js LTS (Long Term Support)
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

# 3. Install Global Node Packages
# PM2: Process Manager to keep the app alive
# Serve: Simple static file server
npm install -g pm2 serve pnpm

# 4. Verify Installations
node -v
pm2 -v

```

---

## PART 2: Robust Backend API (Node.js + PM2)

### Step 2.1: Project Skeleton & Secrets

Create the project directory structure.

```bash
mkdir -p /opt/storage-demo && cd /opt/storage-demo
npm init -y
npm install express cors @aws-sdk/client-s3 dotenv

# Enable ES Modules
npm pkg set type="module"

```

**Create `.env` file:**
Right-click in VS Code Explorer > New File > `.env`.

```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
ENDPOINT=https://us-ord-1.linodeobjects.com
REGION=us-ord-1
BUCKET=storage-demo-bucket

```

### Step 2.2: S3 Client Helper (`s3Client.js`)

Create `s3Client.js` to modularize the connection logic.
javascript
```
import { S3Client } from "@aws-sdk/client-s3";

export function makeClient() {
  return new S3Client({
    region: process.env.REGION,
    endpoint: process.env.ENDPOINT,
    forcePathStyle: true, // Critical for Akamai/Linode Objects
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

```

### Step 2.3: API Server Logic (`server.js`)

Create `server.js`. This includes the **Adaptive Concurrency** logic (TCP Slow-Start) to maximize throughput without hitting rate limits.

JavaScript
```
import "dotenv/config";
import express from "express";
import cors from "cors";
import { PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
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
    await Promise.all(batchKeys.map(async (key) => {
      const t0 = Date.now();
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: randomBuffer(bytesPerFile), ACL: "public-read"
        }));
        fileTimes[key] = Date.now() - t0;
        completed++;
      } catch (e) {
        errors++;
        console.error(`Upload error ${key}:`, e.code || e.message);
      }
    }));

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
  const squareDiffs = times.map(t => Math.pow(t - avgMs, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
  const stdDev = Math.sqrt(avgSquareDiff);
  // Score: 100 minus the Coefficient of Variation. Capped at 0.
  const stabilityScore = Math.max(0, 100 - ((stdDev / avgMs) * 100));

  return {
    totalFiles: keys.length,
    totalSeconds,
    throughputMBs: totalMB / totalSeconds,
    avgMsPerFile: avgMs,
    p95MsPerFile: p95Ms,
    stabilityScore: stabilityScore
  };
}

// --- ENDPOINTS ---

app.post("/upload-adaptive", async (req, res) => {
  const { fileCount, fileSizeMB, filePrefix } = req.body;
  const bucket = process.env.BUCKET;
  
  console.log(`Starting Job: ${filePrefix} (${fileCount} files)`);
  
  // ZERO PADDING: Ensures files list linearly (-00000.bin, -00001.bin)
  const keys = Array.from({ length: fileCount }, (_, i) => 
    `${filePrefix}/${Date.now()}-${String(i).padStart(5, '0')}.bin`
  );

  const result = await adaptiveUpload({ bucket, keys, bytesPerFile: fileSizeMB * 1024 * 1024 });
  
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
    Delimiter: '/',
    MaxKeys: 1000 
  });
  
  const response = await s3.send(cmd);
  
  // Map Files
  const files = (response.Contents || []).map(o => ({
    key: o.Key, size: o.Size, lastModified: o.LastModified, type: 'file'
  }));

  // Map Folders (CommonPrefixes)
  const folders = (response.CommonPrefixes || []).map(o => ({
    key: o.Prefix, type: 'folder'
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
  
  if (!listRes.Contents || listRes.Contents.length === 0) return res.json({ deleted: 0 });

  const delCmd = new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: listRes.Contents.map(o => ({ Key: o.Key })) }
  });
  const delRes = await s3.send(delCmd);
  
  res.json({ deleted: delRes.Deleted?.length || 0 });
});

app.listen(3000, () => console.log("Storage Demo API running on port 3000"));
```

### Step 2.4: Start Backend with PM2

Ensure the API restarts automatically if the server reboots.

```bash
pm2 start server.js --name "backend-api"
pm2 startup
# Run the command output by the line above!
pm2 save

```

---

## PART 3: Frontend SPA (HTML/JS)

### Step 3.1: Create `index.html`

Create `index.html`. This includes the **Dark Mode** styling, **Metric Cards**, and the **File Browser** logic.

HTML
```
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Akamai Object Storage Demo</title>
  <style>
    /* Modern Dark Theme */
    body { margin:0; font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg,#111827,#1f2937); color:#f9fafb; padding: 20px; }
    .container { max-width:1100px; margin:0 auto; }
    
    /* Tabs */
    .tabs { display:flex; gap:16px; margin-bottom:16px; border-bottom:1px solid #374151; }
    .tab { padding:10px 18px; cursor:pointer; background:transparent; border:none; color:#9ca3af; font-size:16px; }
    .tab.active { color:#f9fafb; border-bottom: 2px solid #3b82f6; }
    .panel { display:none; }
    .panel.active { display:block; }

    /* Forms */
    .field { margin-bottom:12px; }
    label { display:block; font-size:12px; color:#9ca3af; margin-bottom:4px; }
    input, select { width:100%; padding:8px 10px; border-radius:6px; border:1px solid #4b5563;
      background:#111827; color:#f9fafb; box-sizing: border-box; }
    .grid-2 { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }

    /* Buttons */
    .btn { padding:10px 20px; border-radius:6px; border:none;
      background:linear-gradient(135deg,#2563eb,#1d4ed8); color:white; cursor:pointer; font-weight:600; }
    .btn.secondary { background:#374151; }

    /* Metric Cards */
    .cards { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-top:24px; }
    .card { background:rgba(31, 41, 55, 0.8); border-radius:12px; padding:16px; border:1px solid #374151; }
    .card-title { font-size:12px; color:#9ca3af; }
    .card-value { font-size:24px; font-weight:700; margin-top: 4px; }
    .card-sub { font-size: 11px; color: #34d399; margin-top: 4px; }

    /* File Table */
    .table-header { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; padding-bottom: 10px; border-bottom: 1px solid #374151; }
    table { width:100%; border-collapse:collapse; margin-top:10px; font-size:14px; }
    th { text-align:left; color:#9ca3af; padding:8px; border-bottom:1px solid #374151; }
    td { padding:8px; border-bottom:1px solid #374151; font-family: monospace; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
<div class="container">
  <h1>Akamai Object Storage Performance Demo</h1>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('upload')" id="tab-upload">Generate & Upload</button>
    <button class="tab" onclick="switchTab('results')" id="tab-results">Run Results</button>
    <button class="tab" onclick="switchTab('browser')" id="tab-browser">File Browser</button>
  </div>

  <div id="upload" class="panel active">
    <div class="grid-2">
      <div class="field"><label>Total Files</label><input id="fileCount" type="number" value="9168" /></div>
      <div class="field"><label>File Size (MiB)</label><input id="fileSizeMB" type="number" value="75" /></div>
      <div class="field"><label>File Prefix</label><input id="filePrefix" type="text" value="monitor3/20260115/12" /></div>
      <div class="field"><label>Mode</label>
        <select id="mode"><option value="adaptive">Adaptive (Recommended)</option></select>
      </div>
    </div>
    
    <button class="btn" onclick="runUpload()">Run Upload Job</button>
    <div id="statusText" style="margin-top:12px; color:#34d399; font-weight:600;"></div>
  </div>

  <div id="results" class="panel">
    <h2 style="margin-top:0;">Job Completion Statistics</h2>
    <div class="cards" id="metricsCards">
      <div class="card"><div class="card-title">Throughput</div><div class="card-value" id="throughput">-</div><div class="card-sub">Sustained Speed</div></div>
      <div class="card"><div class="card-title">Network Saturation</div><div class="card-value" id="netSat">-</div><div class="card-sub">Of ~5Gbps Client Link</div></div>
      <div class="card"><div class="card-title">Total Time</div><div class="card-value" id="totalTime">-</div></div>
      <div class="card"><div class="card-title">Files Uploaded</div><div class="card-value" id="filesUploaded">-</div></div>
      
      <div class="card"><div class="card-title">Avg Latency</div><div class="card-value" id="avgTime">-</div></div>
      <div class="card"><div class="card-title">P95 Latency</div><div class="card-value" id="p95Time">-</div><div class="card-sub">Consistent Performance</div></div>
      <div class="card"><div class="card-title">Stability Score</div><div class="card-value" id="stability">-</div><div class="card-sub">Consistency Rating</div></div>
    </div>
    
    <h3 style="margin-top:24px; color:#9ca3af;">Platform Scalability</h3>
    <div class="cards">
      <div class="card">
        <div class="card-title">Average RPS</div>
        <div class="card-value" id="rpsVal">-</div>
        <div class="card-sub">Requests Per Second</div>
      </div>
      <div class="card">
        <div class="card-title">E1 Scaling Capacity</div>
        <div class="card-value" id="rpsCap">-</div>
        <div class="card-sub" id="rpsSub">Unused Headroom (vs Limit)</div>
      </div>
    </div>
  </div>

  <div id="browser" class="panel">
    <div class="grid-2" style="grid-template-columns: repeat(4, 1fr); align-items: end;">
      <div class="field"><label>Monitor</label>
        <select id="b_mon"><option>monitor1</option><option>monitor2</option><option selected>monitor3</option><option>monitor4</option></select>
      </div>
      <div class="field"><label>Date (YYYYMMDD)</label><input id="b_date" type="text" value="20260115" /></div>
      <div class="field"><label>Hour (HH)</label><input id="b_hour" type="text" value="12" /></div>
      <div class="field"><button class="btn" onclick="loadBase()">Go</button></div>
    </div>

    <div class="table-header">
      <h2 id="indexTitle" style="margin:0;">Index of /</h2>
      <div style="display:flex; gap:16px; align-items:center;">
        <span id="fileCountDisplay" style="font-weight:700; color:#34d399; font-size:18px;">0 Files</span>
        <button class="btn secondary" onclick="deletePrefix()" style="font-size:12px; padding:6px 12px;">Delete Folder</button>
      </div>
    </div>

    <table id="indexTable">
      <thead><tr><th>Name</th><th>Last Modified</th><th>Size</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<script>
  const API_BASE = "http://" + window.location.hostname + ":3000";

  function switchTab(id) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.getElementById('tab-'+id).classList.add('active');
  }

  // --- UPLOAD LOGIC ---
  async function runUpload() {
    const status = document.getElementById("statusText");
    status.textContent = "Starting upload... please wait.";
    status.style.color = "#fbbf24"; // Yellow
    
    const payload = {
      fileCount: Number(document.getElementById("fileCount").value),
      fileSizeMB: Number(document.getElementById("fileSizeMB").value),
      filePrefix: document.getElementById("filePrefix").value
    };

    try {
      const res = await fetch(`${API_BASE}/upload-adaptive`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      status.textContent = "Upload Complete!";
      status.style.color = "#34d399"; // Green

      // Switch to Results Tab
      switchTab('results');

      // 1. Basic Stats
      document.getElementById("throughput").textContent = data.throughputMBs.toFixed(2) + " MiB/s";
      document.getElementById("totalTime").textContent = data.totalSeconds.toFixed(1) + "s";
      document.getElementById("filesUploaded").textContent = data.totalFiles;

      // 2. Latency Stats
      document.getElementById("avgTime").textContent = data.avgMsPerFile.toFixed(0) + "ms";
      document.getElementById("p95Time").textContent = data.p95MsPerFile.toFixed(0) + "ms";
      document.getElementById("stability").textContent = data.stabilityScore.toFixed(1) + "%";

      // 3. Network Saturation (Assume 6000Mbps link for demo visual)
      const mbps = data.throughputMBs * 8; 
      const linkLimitMbps = 6000; 
      const saturation = Math.min(100, (mbps / linkLimitMbps) * 100);
      document.getElementById("netSat").textContent = saturation.toFixed(1) + "%";
      document.getElementById("netSat").style.color = saturation > 80 ? "#34d399" : "#f9fafb";

      // 4. RPS & Capacity
      const avgRPS = data.totalFiles / data.totalSeconds;
      document.getElementById("rpsVal").textContent = avgRPS.toFixed(1);

      const e1Limit = 5000; 
      const headroom = 100 - ((avgRPS / e1Limit) * 100);
      document.getElementById("rpsCap").textContent = headroom.toFixed(2) + "%";
      document.getElementById("rpsSub").textContent = `Unused RPS Capacity (vs ${e1Limit} limit)`;

    } catch (e) {
      status.textContent = "Error: " + e.message;
      status.style.color = "#f87171";
    }
  }

  // --- BROWSER LOGIC ---
  
  // State tracking for "Parent Directory" logic
  let currentPrefix = "";

  function getBasePrefix() {
    const mon = document.getElementById("b_mon").value;
    const date = document.getElementById("b_date").value;
    const hour = document.getElementById("b_hour").value;
    // Ensure trailing slash
    return `${mon}/${date}/${hour}/`;
  }

  // Called when "Go" is clicked
  function loadBase() {
    currentPrefix = getBasePrefix();
    browse(currentPrefix);
  }

  async function browse(prefix) {
    currentPrefix = prefix;
    
    // UI Updates
    document.getElementById("indexTitle").textContent = `Index of /${prefix}`;

    // Fetch Data (Directory Aware)
    const res = await fetch(`${API_BASE}/list`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix })
    });
    const data = await res.json();
    
    // Update Count Header
    const fileCount = data.items.filter(i => i.type === 'file').length;
    const folderCount = data.items.filter(i => i.type === 'folder').length;
    document.getElementById("fileCountDisplay").textContent = `${folderCount} Dirs, ${fileCount} Files`;
    
    const tbody = document.querySelector("#indexTable tbody");
    tbody.innerHTML = "";
    
    // 1. Add "Parent Directory" Link if we are deeper than base
    const base = getBasePrefix();
    // Only show "Up" if current prefix starts with base AND is longer than base
    if (prefix.length > base.length && prefix.startsWith(base)) {
        // "monitor/date/hour/dir01/" -> split -> pop -> join -> "monitor/date/hour/"
        const parts = prefix.replace(/\/$/, "").split('/');
        parts.pop(); 
        const parentPath = parts.join('/') + '/';
        
        const tr = document.createElement("tr");
        tr.style.backgroundColor = "rgba(255,255,255,0.05)";
        tr.innerHTML = `
            <td colspan="3">
                <a href="#" onclick="browse('${parentPath}'); return false;" style="font-weight:bold; color:#fbbf24;">
                 ⬆ Parent Directory
                </a>
            </td>`;
        tbody.appendChild(tr);
    }

    const publicBase = `https://us-ord-1.linodeobjects.com/storage-demo-bucket`; 

    // 2. Render Items
    data.items.forEach(item => {
      const tr = document.createElement("tr");
      
      if (item.type === 'folder') {
        // FOLDER ROW
        const name = item.key.split('/').filter(p=>p).pop() + "/"; // "dir01/"
        tr.innerHTML = `
          <td>
            <span style="font-size:16px;">📁</span> 
            <a href="#" onclick="browse('${item.key}'); return false;" style="font-weight:bold; color:#fbbf24;">${name}</a>
          </td>
          <td>-</td>
          <td>-</td>
        `;
      } else {
        // FILE ROW
        const name = item.key.split('/').pop();
        const sizeMB = (item.size / 1024 / 1024).toFixed(2);
        const url = `${publicBase}/${item.key}`;
        
        tr.innerHTML = `
          <td><a href="${url}" target="_blank" style="color:#60a5fa;">${name}</a></td>
          <td>${new Date(item.lastModified).toLocaleString()}</td>
          <td>${sizeMB} MiB</td>
        `;
      }
      tbody.appendChild(tr);
    });
  }

  async function deletePrefix() {
    if(!confirm("Are you sure you want to delete all files in this folder?")) return;
    const prefix = getPrefix(); // Deletes based on inputs, not current view
    await fetch(`${API_BASE}/delete-all`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix })
    });
    alert("Deleted.");
    loadBase(); 
  }
</script>
</body>
</html>
```

### Step 3.2: Start Frontend with PM2

We use `serve` to host the static files, managed by PM2 for resilience.

```bash
pm2 start "serve -s . -l 8080" --name "frontend-ui"
pm2 save

```

---

## PART 4: Workload Automation (The Script)

### Step 4.1: Create `run-sequence.sh`

This script automates the 4-Monitor workload described in the scenario. It sends commands to the local API, which then executes the uploads efficiently.

```
#!/bin/bash

# Configuration
# Triggers the local Node.js API to perform the uploads
API_URL="http://localhost:3000/upload-adaptive"

# Dynamic Date Generation (Pacific Time)
# Forces the script to use Los Angeles time so the folder created 
# matches the hour on your local clock during the demo.
DATE_DIR=$(TZ='America/Los_Angeles' date +"%Y%m%d")
HOUR_DIR=$(TZ='America/Los_Angeles' date +"%H")

# Helper function to execute a single monitor job
run_monitor() {
  local MON_NAME=$1
  local FILE_COUNT=$2
  local SIZE_MB=$3
  
  # Construct the target prefix (e.g., monitor1/20260115/14)
  local PREFIX="${MON_NAME}/${DATE_DIR}/${HOUR_DIR}"
  
  echo "---------------------------------------------------"
  echo "Starting ${MON_NAME}: ${FILE_COUNT} files of ${SIZE_MB}MB..."
  echo "Target: /${PREFIX}"
  echo "---------------------------------------------------"

  # Construct JSON Payload using jq
  JSON_DATA=$(jq -n \
    --arg fc "$FILE_COUNT" \
    --arg fs "$SIZE_MB" \
    --arg pf "$PREFIX" \
    '{fileCount: ($fc|tonumber), fileSizeMB: ($fs|tonumber), filePrefix: $pf}')

  # Send Request to Local API and Parse JSON Output
  # The API will block until the upload batch is complete
  curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -d "$JSON_DATA" | jq '{totalSeconds, throughputMBs, avgMsPerFile}'
    
  echo "---------------------------------------------------"
  echo "${MON_NAME} Completed."
  echo ""
}

echo "=== STARTING 4-MONITOR WORKLOAD SEQUENCE (Pacific Time) ==="

# Monitor 1 (Standard Load)
run_monitor "monitor1" 260 75

# Monitor 2 (Double Load)
run_monitor "monitor2" 520 75

# Monitor 3 (Heavy Load - 31 sub-directories)
echo "=== Starting Monitor 3 (Distributed across 31 Directories) ==="

# Save the base hour (e.g., "09")
BASE_HOUR=$HOUR_DIR

for i in {1..31}; do
  # Pad directory number with zero (dir01, dir02...)
  DIR_NUM=$(printf "%02d" $i)
  
  # TRICK: Append the directory to the HOUR variable
  # Resulting Path: monitor3/20260120/09/dir01
  HOUR_DIR="${BASE_HOUR}/dir${DIR_NUM}"
  
  # Run monitor with just "monitor3" so it stays at the root
  run_monitor "monitor3" 260 75
done

# Restore the original hour for Monitor 4
HOUR_DIR=$BASE_HOUR
echo "Monitor 3 Sequence Completed."
echo ""

# Monitor 4 (Standard Load)
run_monitor "monitor4" 328 75

echo "=== SEQUENCE FINISHED ==="
```

### Step 4.2: Execute

```bash
chmod +x run-sequence.sh
./run-sequence.sh

```

---

## PART 5: Operation & Verification

### 5.1 Verification Checklist

1. **Reboot Test:** Type `reboot` in the terminal. Wait 1 minute. Reconnect VS Code.
2. **Process Check:** Run `pm2 status`. Both `backend-api` and `frontend-ui` should be `online`.
3. **UI Access:** Open browser to `http://<LINODE_IP>:8080`.

### 5.2 The Demo Flow

1. **Start the Script:** Run `./run-sequence.sh` in the VS Code terminal.
2. **Switch to Browser:** Go to the UI (`http://<LINODE_IP>:8080`).
3. **Click "File Browser" Tab.**
4. **Live View:**
* Select `monitor1`. Ensure the Date matches today. Click **Go**.
* You will see files populating in real-time.
* Click a file name to download it (verifying Public Read access).
5. **Performance:**
* Switch to **Generate & Upload** tab.
* Once the script finishes a batch, the metrics will update (or you can run a manual ad-hoc job here to show the graph/cards updating live).

### 5.3 Troubleshooting

* **503 Slow Down:** If you see these in the backend logs (`pm2 logs backend-api`), it means the `adaptive` logic is doing its job—detecting the limit and backing off.
* **CORS Error:** If the UI says "Network Error", ensure you ran the `s3cmd setcors` command in Part 1.3.

## PART 6: Clean Up & Security Reset

**Objective:** Remove public access and CORS rules after the demo to secure the bucket.

### Step 6.1: Remove Public Access

This command deletes the bucket policy, making the files private again. The "File Browser" in the UI will stop working (links will become 403 Forbidden).

```
s3cmd delpolicy s3://storage-demo-bucket
```

### Step 6.2: Remove CORS

This removes the Cross-Origin Resource Sharing rules, preventing browser-based scripts (like your demo UI) from making API calls to the bucket.

```
s3cmd delcors s3://storage-demo-bucket
```

### Step 6.3: Verification

Verify that the policies are gone:

```
s3cmd info s3://storage-demo-bucket
```

- The output should **not** show a `Policy` or `CORS` section anymore.
