#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.." || exit 1
OUT=${VERIFY_LOG_DIR:-.verify-logs}
mkdir -p "$OUT"
AUTH_FAMILY=" check:auth check:account check:google check:password check:backup "
AUTH_LOCK=/tmp/mls-auth-checks.lock
CHECK_TIMEOUT=${VERIFY_CHECK_TIMEOUT:-1200}

if [ $# -gt 0 ]; then names=("$@"); else
  mapfile -t names < <(node -e 'for (const k of Object.keys(require("./package.json").scripts)) if (k.startsWith("check:")) console.log(k)')
fi

: > "$OUT/summary.tsv"
row() { printf '%s\t%s\t%ss\t%s\n' "$1" "$2" "$3" "$4" | tee -a "$OUT/summary.tsv"; }

start=$(date +%s)
npm run --silent build > "$OUT/build.log" 2>&1 < /dev/null
code=$?
row build "$code" "$(( $(date +%s) - start ))" 1
if [ "$code" -ne 0 ]; then
  tail -n 30 "$OUT/build.log"
  echo "verify: build failed, see $OUT/build.log"
  exit 1
fi

run_check() {
  local name=$1 log=$2 lock=()
  [[ "$AUTH_FAMILY" == *" $name "* ]] && lock=(flock "$AUTH_LOCK")
  "${lock[@]}" timeout -k 10 "$CHECK_TIMEOUT" npm run --silent "$name" > "$log" 2>&1 < /dev/null
}

failed=()
for name in "${names[@]}"; do
  log="$OUT/${name#check:}.log"
  rm -f "$log.retry"
  start=$(date +%s)
  attempts=1
  run_check "$name" "$log"
  code=$?
  if [ "$code" -ne 0 ]; then
    attempts=2
    run_check "$name" "$log.retry"
    code=$?
  fi
  row "$name" "$code" "$(( $(date +%s) - start ))" "$attempts"
  [ "$code" -eq 0 ] || failed+=("$name")
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "verify: ${#failed[@]} of ${#names[@]} checks failed after one retry: ${failed[*]}"
  echo "verify: logs in $OUT (<name>.log and <name>.log.retry)"
  exit 1
fi
echo "verify: build and all ${#names[@]} checks passed"
