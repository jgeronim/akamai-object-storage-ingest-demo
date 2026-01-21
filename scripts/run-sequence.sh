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