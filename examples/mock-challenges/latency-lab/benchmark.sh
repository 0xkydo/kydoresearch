#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

./verify.sh

node - <<'EOF'
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("solution/config.json", "utf8"));
const score =
  260 -
  Math.min(config.cacheEntries, 256) * 0.25 +
  Math.abs(config.batchSize - 16) * 4 -
  (config.prefetch ? 28 : 0);
const result = {
  score,
  metrics: {
    unit: "milliseconds",
    strategy: config.strategy,
    batchSize: config.batchSize,
    cacheEntries: config.cacheEntries,
    prefetch: config.prefetch,
  },
};
fs.writeFileSync("score.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
EOF
