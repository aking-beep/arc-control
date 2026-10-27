#!/usr/bin/env bash
# Runs the Meridian sandbox suite against an ARC Control checkout.
# Usage: run.sh <arc-checkout> <label> [sandbox-dir]
set -u
ARC="$(cd "${1:?arc checkout path required}" && pwd)"
LABEL="${2:?label required}"
SB="$(cd "${3:-$ARC/../arc-control-sandbox}" && pwd)"
OUT="${MERIDIAN_OUT:-$PWD/.meridian}/$LABEL"
mkdir -p "$OUT"

{
  echo "arc:     $(git -C "$ARC" rev-parse HEAD)"
  echo "sandbox: $(git -C "$SB" rev-parse HEAD)"
} > "$OUT/revisions.txt"

cd "$SB"
export ARC_REPO_PATH="$ARC"
npm test > "$OUT/unit.txt" 2>&1; echo "unit exit $?" | tee "$OUT/summary.txt"
npm run preflight > "$OUT/preflight.txt" 2>&1; echo "preflight exit $?" | tee -a "$OUT/summary.txt"

node src/start.mjs > "$OUT/server.txt" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  curl -s http://127.0.0.1:8890/api/health | grep -q '"gatewayConfigured":true' && break
  sleep 1
done

npm run validate > "$OUT/validate.txt" 2>&1; echo "validate exit $?" | tee -a "$OUT/summary.txt"
if grep -q '"phase2"' package.json; then
  npm run phase2 > "$OUT/phase2.txt" 2>&1; echo "phase2 exit $?" | tee -a "$OUT/summary.txt"
  cp reports/phase2-latest.json "$OUT/" 2>/dev/null
else
  echo "phase2 not available on this sandbox revision" | tee -a "$OUT/summary.txt"
fi
cp reports/latest.json "$OUT/validate-latest.json" 2>/dev/null

# One result file in the harness format, for tools/harness/measure.mjs.
node -e '
const fs = require("fs");
const out = process.argv[1];
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
const p2 = read(out + "/phase2-latest.json");
const v = read(out + "/validate-latest.json");
const metrics = {};
if (v) { metrics.integration_passed = v.passed; metrics.integration_failed = v.failed; }
if (p2) {
  Object.assign(metrics, { phase2_pass: p2.phase2.pass, phase2_fail: p2.phase2.fail, phase2_unsupported: p2.phase2.unsupported });
  metrics.stress_failed_presets = p2.stress.filter((s) => !s.pass).length;
  if (p2.preservedIntegration) { metrics.integration_passed = p2.preservedIntegration.passed; metrics.integration_failed = p2.preservedIntegration.failed; }
}
const ok = metrics.integration_failed === 0 && (metrics.phase2_fail ?? 0) === 0 && (metrics.stress_failed_presets ?? 0) === 0;
fs.writeFileSync(out + "/result.json", JSON.stringify({ at: new Date().toISOString(), skill: "meridian-validate", tool: "run.sh", ok, metrics, details: { revisions: fs.readFileSync(out + "/revisions.txt", "utf8") } }, null, 2) + "\n");
' "$OUT"

grep -E "FAIL|Phase 2:|Integration|STRESS|scenarios passed" "$OUT/validate.txt" "$OUT/phase2.txt" 2>/dev/null
echo "reports in $OUT"
