#!/usr/bin/env bash
# Existing dependencies only. Every command runs with redirected HOME/config/temp.
# Commands: prepare, typecheck, unit, repair, mutations, stability, finish, all.
# EVIDENCE_DIR must be outside the checkout; preserve disposable trees for inspection.
set -euo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BASE=b2e7255ece0b8bfd3a6429fd5c147fd59984c785
REAL_HOME="$HOME"
LIVE="${LIVE_BRIDGE:-$REAL_HOME/.pi/agent/npm/node_modules/pi-claude-bridge}"
NPM_ROOT="${NPM_ROOT:-$REAL_HOME/.pi/agent/npm/node_modules}"
E="${EVIDENCE_DIR:?Set external evidence directory}"
mkdir -p "$E"
fail() { echo "FAIL: $*"; exit 1; }
inst_hash() { (cd "$LIVE" && find src package.json -type f | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
if [ "${1:-all}" = prepare ] || [ "${1:-all}" = all ]; then
 [ ! -e "$E/workspace.txt" ] || fail 'workspace exists; use a new evidence directory'
 W="$(mktemp -d)"; echo "$W" > "$E/workspace.txt"
 inst_hash > "$E/installed-start.hash"
else
 W="$(cat "$E/workspace.txt")"
fi
mkdir -p "$W/home" "$W/claude" "$W/tmp"
export HOME="$W/home" USERPROFILE="$W/home" CLAUDE_CONFIG_DIR="$W/claude" TMPDIR="$W/tmp"
unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR CLAUDE_BRIDGE_DEBUG CLAUDE_BRIDGE_DEBUG_PATH CLAUDE_BRIDGE_TEST_LOG_DIR CLAUDE_BRIDGE_RECORD_STREAM ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN NODE_OPTIONS || true
export ANTHROPIC_BASE_URL="http://127.0.0.1:9"
TEST=(node --import ./tests/lib/offline-guard.mjs --import tsx --import ./tests/lib/setup.mjs --test --test-reporter=tap --test-timeout=60000)
NEW="tests/unit-replay-capture.mjs tests/unit-mirror-resume-guard.mjs tests/unit-prompt-capture-reload.mjs tests/unit-goal-checkpoint.mjs tests/unit-aux-capture.mjs tests/unit-aux-isolation.mjs tests/unit-aux-retention.mjs tests/unit-aux-canary.mjs"
summ() { grep -E '^# (tests|pass|fail|cancelled) ' "$1" | tr '\n' ' '; echo; }
failing() { grep -E '^[[:space:]]*not ok [0-9]+ - ' "$1" | sed -E 's/^[[:space:]]*not ok [0-9]+ - //' | sort || true; }
run() {
 local d="$1" o="$2"; shift 2
 set +e
 (cd "$d" && NODE_OPTIONS="--import=$d/tests/lib/offline-guard.mjs" "${TEST[@]}" "$@" > "$o" 2>&1)
 local rc=$?; set -e
 echo "$rc" > "$o.exit"
 ! grep -q 'OFFLINE GUARD:' "$o" || fail "external call in $o"
 printf '%s exit %s: ' "$(basename "$o")" "$rc"; summ "$o"
}
link_deps() {
 mkdir -p "$1/node_modules"
 for e in "$NPM_ROOT"/* "$NPM_ROOT"/.[!.]*; do [ -e "$e" ] && ln -s "$e" "$1/node_modules/$(basename "$e")"; done
}
prepare() {
 [ "$(git -C "$HERE" rev-parse v0.9.2^{})" = "$BASE" ] || fail 'wrong base'
 for t in base patched; do mkdir -p "$W/$t"; git -C "$HERE" archive "$BASE" | tar -x -C "$W/$t"; link_deps "$W/$t"; done
 # Include added files with a temporary index; leave the checkout's index alone.
 GIT_INDEX_FILE="$W/index" git -C "$HERE" read-tree HEAD
 GIT_INDEX_FILE="$W/index" git -C "$HERE" add src CHANGELOG.md tests
 GIT_INDEX_FILE="$W/index" git -C "$HERE" diff --cached --binary "$BASE" -- src CHANGELOG.md tests > "$E/candidate.patch"
 (cd "$W/patched" && git apply "$E/candidate.patch")
 diff -r "$W/patched/src" "$HERE/src" >/dev/null || fail 'source parity'
 diff -r "$W/patched/tests" "$HERE/tests" >/dev/null || fail 'test parity'
 cmp "$W/patched/CHANGELOG.md" "$HERE/CHANGELOG.md"
 cp "$W/patched/tests/lib/offline-guard.mjs" "$W/base/tests/lib/"
 echo "patch application/parity OK; workspace $W"
 echo "tsc $(tsc --version); node $(node --version)"
 for d in @anthropic-ai/claude-agent-sdk @modelcontextprotocol/sdk cc-session-io @earendil-works/pi-ai @earendil-works/pi-coding-agent pi-goal-x; do printf '%s ' "$d"; grep -m1 '"version"' "$NPM_ROOT/$d/package.json"; done
}
typecheck() {
 for t in base patched; do
  set +e
  (cd "$W/$t" && NODE_OPTIONS="--import=$W/$t/tests/lib/offline-guard.mjs" tsc --noEmit -p . > "$E/tsc-$t.txt" 2>&1)
  rc=$?; set -e; echo "$rc" > "$E/tsc-$t.exit"; echo "$t tsc exit $rc"
  [ "$rc" = 0 ] && [ ! -s "$E/tsc-$t.txt" ] || fail "$t typecheck"
 done
}
pin_inherited() {
 awk '/^[[:space:]]*not ok [0-9]+ - haiku shortcut and no-match still resolve/{f=1} f{print} f&&/^[[:space:]]*\.\.\.$/{exit}' "$1" > "$W/inherited.txt"
 grep -q 'unit-models.mjs' "$W/inherited.txt" && grep -q "expected: 'claude-haiku-4-5'" "$W/inherited.txt" && grep -q "actual: 'claude-haiku-5-5'" "$W/inherited.txt" && grep -q "operator: 'strictEqual'" "$W/inherited.txt"
}
unit() {
 # repair() adds regression files to base. Keep the package's own baseline suite
 # pristine regardless of stage order by archiving a separate immutable upstream tree.
 if [ ! -d "$W/upstream-unit" ]; then
  mkdir -p "$W/upstream-unit"; git -C "$HERE" archive "$BASE" | tar -x -C "$W/upstream-unit"; link_deps "$W/upstream-unit"
  cp "$W/patched/tests/lib/offline-guard.mjs" "$W/upstream-unit/tests/lib/"
 fi
 for t in base patched; do
  local d="$W/$t"; [ "$t" != base ] || d="$W/upstream-unit"
  run "$d" "$E/unit-$t.tap" tests/unit-*.mjs
  failing "$E/unit-$t.tap" > "$E/unit-$t.failures"
  if [ -s "$E/unit-$t.failures" ]; then
   [ "$(cat "$E/unit-$t.failures")" = $'applyLongContext\nhaiku shortcut and no-match still resolve' ] && pin_inherited "$E/unit-$t.tap" || fail "unexpected $t failure"
   [ "$(cat "$E/unit-$t.tap.exit")" = 1 ] || fail 'unexpected exit'
  else [ "$(cat "$E/unit-$t.tap.exit")" = 0 ] || fail 'exit without TAP failure'; fi
 done
 cmp "$E/unit-base.failures" "$E/unit-patched.failures" || fail 'exception differs'
}
repair() {
 cp "$W/patched/tests/lib/prompt-fixtures.mjs" "$W/base/tests/lib/"
 cp "$W/patched/tests/fixtures/"{prompt-capture-0.9.2.ts,goal-canary-sequence.json} "$W/base/tests/fixtures/"
 for t in $NEW; do cp "$W/patched/$t" "$W/base/$t"; done
 run "$W/base" "$E/new-base.tap" $NEW
 run "$W/patched" "$E/new-patched.tap" $NEW
 [ "$(cat "$E/new-patched.tap.exit")" = 0 ] || fail 'repair tests'
 failing "$E/new-base.tap" > "$E/new-base.failures"
 diff -u "$HERE/tests/expected-unpatched-0.9.2.txt" "$E/new-base.failures" || fail 'exact expected failures differ'
 ! grep -q 'KNOWN FINDING' "$E/new-base.failures" || fail 'baseline characterization failed'
 echo "exact baseline failures match ($(wc -l < "$E/new-base.failures") entries)"
}
mutate() {
 local label="$1" f="$2" expr="$3"; shift 3
 local n="$mutation" d="$W/mutation-$mutation"; mutation=$((mutation+1))
 # Group execution can select individual mutation ranges without polling or signals.
 [ "$n" -ge "${MUTATION_START:-0}" ] && [ "$n" -lt "${MUTATION_END:-999}" ] || return 0
 [ ! -e "$d" ] || fail "mutation $n workspace already exists"
 mkdir -p "$d"; cp -R "$W/patched/src" "$W/patched/tests" "$d/"; cp "$W/patched/package.json" "$d/"
 ln -s "$W/patched/node_modules" "$d/node_modules"
 sed -i.sedbak -E "$expr" "$d/$f"; rm "$d/$f.sedbak"
 cmp -s "$d/$f" "$W/patched/$f" && fail "mutation changed nothing: $label"
 run "$d" "$E/mutation-$n.tap" "$@"
 local count; count="$(grep -E '^# (fail|cancelled) ' "$E/mutation-$n.tap" | awk '{s+=$3} END {print s+0}')"
 [ "$count" -gt 0 ] || fail "mutation unnoticed: $label"
 echo "$n $label: $count failing" | tee -a "$E/mutations.txt"
}
mutations() {
 mutation=0
 # Mutation list is appended below; each runs in its own disposable source copy.
 source "$HERE/tests/local-fixes-mutations.sh"
}
stability() {
 for ((i=${STABILITY_START:-1}; i<=${STABILITY_END:-20}; i++)); do
  run "$W/patched" "$E/stability-$i.tap" $NEW
  [ "$(cat "$E/stability-$i.tap.exit")" = 0 ] || fail "stability $i"
 done
}
finish() {
 inst_hash > "$E/installed-end.hash"; cmp "$E/installed-start.hash" "$E/installed-end.hash" || fail 'installed source changed'
 diff -r "$W/patched/src" "$HERE/src" >/dev/null || fail 'mutation contaminated source'
 echo "installed source unchanged: $(cat "$E/installed-end.hash")"
 echo OK
}
case "${1:-all}" in
 prepare|typecheck|unit|repair|mutations|stability|finish) "$1" ;;
 all) prepare; typecheck; unit; repair; [ "${MUTATE:-0}" != 1 ] || mutations; stability; finish ;;
 *) fail 'unknown stage' ;;
esac
