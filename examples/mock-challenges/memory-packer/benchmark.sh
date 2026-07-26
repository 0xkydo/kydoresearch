#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

./verify.sh

node - <<'EOF'
const fs = require("fs");
const layout = JSON.parse(fs.readFileSync("solution/layout.json", "utf8"));
const score =
  420 +
  Math.abs(Math.log2(layout.tileSize) - 5) * 24 -
  (layout.precision === "fp16" ? 120 : 0) -
  (layout.reuseBuffers ? 70 : 0);
const result = {
  score,
  metrics: {
    unit: "MiB",
    allocator: layout.allocator,
    tileSize: layout.tileSize,
    precision: layout.precision,
    reuseBuffers: layout.reuseBuffers,
  },
};
fs.writeFileSync("score.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
EOF
