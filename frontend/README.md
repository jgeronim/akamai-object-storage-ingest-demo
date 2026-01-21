# Frontend (SPA)

Single-page HTML/JS app that talks to the backend API and visualizes ingest
runs.

## Tabs

- **Generate & Upload**
  - Fields:
    - Total Files (default 9168)
    - File Size (MiB) (default 75)
    - File Prefix (e.g. `model3/20260115/12`)
    - Mode (Adaptive recommended)
  - Button: **Run Upload Job**
  - Status text shows start/end of the adaptive run.

- **Run Results**
  - Metric cards:
    - Throughput (MiB/s)
    - Network Saturation (vs. assumed link)
    - Total Time
    - Files Uploaded
    - Average Latency
    - P95 Latency
    - Stability Score
    - Average RPS and E3 headroom

- **File Browser**
  - Inputs:
    - Model (model1–model4)
    - Date (YYYYMMDD)
    - Hour (HH)
  - Renders:
    - `Index of /<bucket>/<prefix>` header
    - Table with Name / Last Modified / Size
    - Parent Directory row
    - File count + **Delete Folder** button.

## Running

```bash
npx serve -s . -l 8080
# or use any static web server

The frontend expects the backend to be reachable at  
`http://<host>:3000` (`API_BASE`), which is constructed from  
`window.location.hostname` in `index.html`
