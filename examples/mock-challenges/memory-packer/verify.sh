#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .mock-setup-complete ]; then
  echo "verify: run ./setup.sh first" >&2
  exit 1
fi

node - <<'EOF'
const fs = require("fs");
let layout;
try {
  layout = JSON.parse(fs.readFileSync("solution/layout.json", "utf8"));
} catch (error) {
  console.error(`verify: solution/layout.json is invalid JSON: ${error.message}`);
  process.exit(1);
}
if (typeof layout.allocator !== "string" || layout.allocator.trim() === "") {
  console.error('verify: "allocator" must be a non-empty string');
  process.exit(1);
}
if (
  !Number.isInteger(layout.tileSize) ||
  layout.tileSize < 8 ||
  layout.tileSize > 128 ||
  (layout.tileSize & (layout.tileSize - 1)) !== 0
) {
  console.error('verify: "tileSize" must be a power of two from 8 through 128');
  process.exit(1);
}
if (!["fp32", "fp16"].includes(layout.precision)) {
  console.error('verify: "precision" must be "fp32" or "fp16"');
  process.exit(1);
}
if (typeof layout.reuseBuffers !== "boolean") {
  console.error('verify: "reuseBuffers" must be boolean');
  process.exit(1);
}
console.log("verify: memory layout is valid");
EOF
