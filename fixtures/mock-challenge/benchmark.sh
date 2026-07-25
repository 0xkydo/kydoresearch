#!/usr/bin/env bash
# Performance benchmark: verifies correctness first (ecdsafail-style embedded
# check), then computes score = (x-3)^2 + (y+1)^2 and writes score.json.
set -euo pipefail
cd "$(dirname "$0")"

./verify.sh

node - <<'EOF'
const fs = require("fs");
const params = JSON.parse(fs.readFileSync("src/solution/params.json", "utf8"));
const score = (params.x - 3) ** 2 + (params.y + 1) ** 2;
const result = { score, metrics: { x: params.x, y: params.y, algorithm: params.algorithm } };
fs.writeFileSync("score.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
EOF
