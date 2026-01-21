# Backend (Node.js API) Implements the S3-compatible ingest and listing endpoints used by the demo frontend. 
## Endpoints 
- `POST /upload-adaptive`   
	- Body: `{ accessKeyId, secretAccessKey, endpoint, region, bucket,             filePrefix, fileCount, fileSizeMB }`  
	- Generates `fileCount` random files of size `fileSizeMB` MiB and uploads    them with a self-tuning concurrency controller (min 8, max 128 threads).
	- Response includes `totalSeconds`, `avgMsPerFile`, `throughputMBs`, and    `totalFiles`. 
- `POST /upload-fixed`
	- Same as `/upload-adaptive`, but uses a fixed concurrency value. 
- `POST /list`   
	- Body: `{ accessKeyId, secretAccessKey, endpoint, region, bucket, prefix }`  
	- Returns `[{ key, size, lastModified }, ...]` for objects under `prefix`. 
- `POST /delete-all`   
	- Body: same as `/list`.  
	- Deletes up to 1,000 objects under the prefix using `DeleteObjects`. 

All S3 calls use the AWS SDK v3 S3 client pointed at Akamai's endpoint with Signature V4. 
## Running locally

```bash 
npm install
node server.js
```

Defaults to port `3000`. Adjust CORS as needed if serving the frontend from  
another origin.