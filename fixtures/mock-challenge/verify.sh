#!/usr/bin/env bash
# Correctness check: params.json must be valid JSON with algorithm string and
# finite x/y within [-10, 10]. Exits 1 with a descriptive message on failure.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .autoresearch-setup-done ]; then
  echo "verify: setup has not been run (missing .autoresearch-setup-done)" >&2
  exit 1
fi

node - <<'EOF'
const fs = require("fs");
let params;
try {
  params = JSON.parse(fs.readFileSync("src/solution/params.json", "utf8"));
} catch (err) {
  console.error(`verify: params.json is not valid JSON: ${err.message}`);
  process.exit(1);
}
if (typeof params.algorithm !== "string" || params.algorithm.length === 0) {
  console.error('verify: params.json missing required "algorithm" string key');
  process.exit(1);
}
for (const key of ["x", "y"]) {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    console.error(`verify: params.json "${key}" must be a finite number, got ${JSON.stringify(v)}`);
    process.exit(1);
  }
  if (Math.abs(v) > 10) {
    console.error(`verify: params.json "${key}" out of bounds |${key}| <= 10, got ${v}`);
    process.exit(1);
  }
}
console.log("verify: OK");
EOF
