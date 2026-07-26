#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prepare_script="$repo_root/examples/mock-challenges/prepare.sh"
extension_path="$repo_root/extensions/autoresearch/index.ts"
challenge=""
destination=""
prepare_only=false

usage() {
  cat <<'EOF'
Usage:
  npm run mock
  npm run mock -- latency
  npm run mock -- ranking
  npm run mock -- memory

Options:
  --destination <path>  Prepare under this directory instead of a fresh /tmp directory.
  --prepare-only        Prepare the repository and print the launch command without starting Pi.
  -h, --help            Show this help.

Challenge aliases:
  latency, latency-lab
  ranking, ranking-quality
  memory, memory-packer
EOF
}

normalize_challenge() {
  case "$1" in
    1|latency|latency-lab)
      printf '%s\n' "latency-lab"
      ;;
    2|ranking|ranking-quality)
      printf '%s\n' "ranking-quality"
      ;;
    3|memory|memory-packer)
      printf '%s\n' "memory-packer"
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_pi() {
  if [ -n "${KYDORESEARCH_PI:-}" ]; then
    if [ ! -x "$KYDORESEARCH_PI" ]; then
      echo "mock: KYDORESEARCH_PI is not executable: $KYDORESEARCH_PI" >&2
      return 1
    fi
    printf '%s\n' "$KYDORESEARCH_PI"
    return
  fi

  local path_pi
  path_pi="$(command -v pi 2>/dev/null || true)"
  if [ -n "$path_pi" ] && [ -x "$path_pi" ]; then
    printf '%s\n' "$path_pi"
    return
  fi

  if [ -x "$repo_root/node_modules/.bin/pi" ]; then
    printf '%s\n' "$repo_root/node_modules/.bin/pi"
    return
  fi

  local common_git_dir
  common_git_dir="$(
    git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null ||
      true
  )"
  if [ -n "$common_git_dir" ]; then
    local main_checkout
    main_checkout="$(dirname "$common_git_dir")"
    if [ -x "$main_checkout/node_modules/.bin/pi" ]; then
      printf '%s\n' "$main_checkout/node_modules/.bin/pi"
      return
    fi
  fi

  local npm_prefix
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$npm_prefix" ] && [ -x "$npm_prefix/bin/pi" ]; then
    printf '%s\n' "$npm_prefix/bin/pi"
    return
  fi

  echo "mock: Pi was not found globally, in this worktree, or in the main checkout." >&2
  echo "mock: install it with:" >&2
  echo "  npm install -g --ignore-scripts @earendil-works/pi-coding-agent" >&2
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --destination)
      if [ "$#" -lt 2 ]; then
        echo "mock: --destination requires a path" >&2
        exit 2
      fi
      destination="$2"
      shift 2
      ;;
    --prepare-only)
      prepare_only=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "mock: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$challenge" ]; then
        echo "mock: choose only one challenge" >&2
        exit 2
      fi
      if ! challenge="$(normalize_challenge "$1")"; then
        echo "mock: unknown challenge: $1" >&2
        usage >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [ -z "$challenge" ]; then
  if [ ! -t 0 ]; then
    echo "mock: no interactive terminal; pass latency, ranking, or memory" >&2
    exit 2
  fi
  cat <<'EOF'
Choose a mock challenge:
  1) Latency Lab       minimize request latency
  2) Ranking Quality   maximize ranking quality
  3) Memory Packer     minimize peak memory
EOF
  read -r -p "Selection [1-3]: " selection
  if ! challenge="$(normalize_challenge "$selection")"; then
    echo "mock: invalid selection: $selection" >&2
    exit 2
  fi
fi

pi_path="$(resolve_pi)"
if [ -z "$destination" ]; then
  destination="$(mktemp -d /tmp/kydoresearch-mock-demo.XXXXXX)"
fi

"$prepare_script" "$destination" "$challenge"
challenge_root="$destination/$challenge"

cat <<EOF

Selected: $challenge
Repository: $challenge_root
Pi: $pi_path

Inside Pi, run:
  /autoresearch

Keep runner=mock. For a watchable tour, set max loops=6 and mock loop delay=1200 ms.
EOF

if [ "$prepare_only" = true ]; then
  cat <<EOF

Launch later with:
  cd "$challenge_root"
  "$pi_path" -e "$extension_path"
EOF
  exit 0
fi

if (
  cd "$challenge_root"
  "$pi_path" -e "$extension_path"
); then
  status=0
else
  status=$?
fi

echo
echo "Mock evidence was retained at: $challenge_root"
exit "$status"
