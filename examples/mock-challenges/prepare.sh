#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extension_path="$(cd "$source_root/../.." && pwd)/extensions/autoresearch/index.ts"
destination="${1:-/tmp/kydoresearch-mock-challenges}"
challenges=("latency-lab" "ranking-quality" "memory-packer")
requested_challenge="${2:-}"

if [ -n "$requested_challenge" ]; then
  case "$requested_challenge" in
    latency-lab|ranking-quality|memory-packer)
      challenges=("$requested_challenge")
      ;;
    *)
      echo "prepare: unknown challenge $requested_challenge" >&2
      exit 2
      ;;
  esac
fi

for challenge in "${challenges[@]}"; do
  if [ -e "$destination/$challenge" ]; then
    echo "prepare: refusing to overwrite $destination/$challenge" >&2
    echo "prepare: choose a new destination or move the existing directory" >&2
    exit 1
  fi
done

mkdir -p "$destination"

for challenge in "${challenges[@]}"; do
  challenge_root="$destination/$challenge"
  cp -R "$source_root/$challenge" "$challenge_root"
  mkdir -p "$challenge_root/bin"
  cp "$source_root/_shared/mockchal.mjs" "$challenge_root/bin/mockchal"
  chmod +x \
    "$challenge_root/setup.sh" \
    "$challenge_root/verify.sh" \
    "$challenge_root/benchmark.sh" \
    "$challenge_root/bin/mockchal"
  git -C "$challenge_root" init -b main >/dev/null
  git -C "$challenge_root" add -A
  git -C "$challenge_root" \
    -c user.name="kydoresearch mock" \
    -c user.email="mock@localhost" \
    commit --no-gpg-sign -m "mock challenge baseline" >/dev/null
  echo "prepared $challenge_root"
done

cat <<EOF

Selected mock challenge(s) are ready.

Start one with:
  cd "$destination/${challenges[0]}"
  pi -e "$extension_path"

Then run /autoresearch inside Pi and keep runner=mock.
EOF
