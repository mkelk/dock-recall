#!/bin/bash
# sim-dock.sh — the end-to-end gate (Layer 3 of the build-test loop).
#
# Fakes a dock with `hyprctl output create headless hw-test` and asserts the
# installed service does the whole job: LAUNCH a missing app onto the new
# monitor, put a SCATTERED window back, and then do NOTHING when there is
# nothing to do.
#
# It drives the INSTALLED plugin (~/.config/omarchy/plugins/mkelk.dock-recall)
# in the live session, so run `scripts/dev-install --restart` first — a
# hot-reloaded service never starts its processes (see that script's comment).
#
# Everything it touches is its own: an `dr-sim` foot window, an `hw-test`
# headless output, and the state file, which is backed up and restored by the
# trap even when a case fails.
#
# Usage: tests/sim-dock.sh        exit 0 = all cases passed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"
TRIGGER="$STATE_DIR/dock-recall.trigger"
SHELL_PATH="${OMARCHY_PATH:-/usr/share/omarchy}/shell"

APP_ID="dr-sim"
OUTPUT="hw-test"
TARGET_WS=9
SCATTER_WS=1

BACKUP="$(mktemp "${TMPDIR:-/tmp}/dr-sim-state.XXXXXX")"
FAILURES=0
HAD_STATE=false

# --------------------------------------------------------------- primitives

mw_log() { qs log -p "$SHELL_PATH" --tail 2000 2>/dev/null | grep -F "[dock-recall]" || true; }
mw_count() { mw_log | grep -cF "$1" || true; }

clients() { hyprctl clients -j; }
sim_field() { clients | jq -r --arg c "$APP_ID" --arg f "$1" 'first(.[]|select(.class==$c)|.[$f])//empty'; }
sim_ws() { clients | jq -r --arg c "$APP_ID" 'first(.[]|select(.class==$c)|.workspace.id)//empty'; }
monitor_id() { hyprctl monitors all -j | jq -r --arg n "$1" 'first(.[]|select(.name==$n)|.id)//empty'; }
monitor_present() { [[ -n $(monitor_id "$1") ]]; }

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

trigger() { date +%s.%N > "$TRIGGER"; }   # CONTENT must change; a bare touch is ignored

# poll <timeout-seconds> <shell-condition...> — never a fixed sleep-then-assert:
# the service's own settle delays make every timing variable.
poll() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if "$@"; then return 0; fi
    sleep 0.5
  done
  return 1
}

sim_placed() {   # the window exists, on the target workspace, on the headless output
  local ws mon want
  ws=$(sim_ws); mon=$(sim_field monitor); want=$(monitor_id "$OUTPUT")
  [[ -n $ws && $ws == "$TARGET_WS" && -n $want && $mon == "$want" ]]
}

sim_gone() { [[ -z $(sim_field address) ]]; }

kill_sim() {
  local pid
  pid=$(sim_field pid)
  [[ -n $pid ]] && kill "$pid" 2>/dev/null || true
  poll 10 sim_gone || true
}

remove_output() {
  if monitor_present "$OUTPUT"; then
    hyprctl output remove "$OUTPUT" >/dev/null || true
    poll 10 bash -c "! hyprctl monitors all -j | jq -e --arg n \"$OUTPUT\" 'any(.[]; .name==\$n)' >/dev/null" || true
  fi
}

diagnostics() {
  echo "--- last [dock-recall] log lines ---"
  mw_log | tail -25
  echo "--- clients (class $APP_ID) ---"
  clients | jq -c --arg c "$APP_ID" '[.[]|select(.class==$c)|{address,class,workspace:.workspace.id,monitor}]'
  echo "--- monitors ---"
  hyprctl monitors all -j | jq -c '[.[]|{id,name}]'
}

cleanup() {
  local status=$?
  set +e
  echo "--- teardown ---"
  kill_sim
  remove_output
  if [[ $HAD_STATE == true ]]; then
    cp "$BACKUP" "$STATE.restore" && mv -f "$STATE.restore" "$STATE"
  else
    rm -f "$STATE"
  fi
  rm -f "$BACKUP"
  # One last trigger so the service settles on the RESTORED state rather than
  # keeping the seeded layout in memory.
  trigger
  sleep 2
  echo "teardown done (state restored)"
  exit $status
}
trap cleanup EXIT

# ------------------------------------------------------------------- set-up

if [[ -f $STATE ]]; then cp "$STATE" "$BACKUP"; HAD_STATE=true; fi
mkdir -p "$STATE_DIR"

echo "=== sim-dock: setup ==="
kill_sim
remove_output

# Seed the identity alone first: with no layout for any topology the service
# has nothing to do while we set the stage.
#
# Written through a temp file and mv, never `cat >` on the real path: a
# truncating write leaves the file momentarily empty, the service's watcher
# reads exactly that, and (before it learned better) it wrote a default back
# over the seed. Every writer of this file — the panel included — should be
# atomic.
cat > "$STATE.seed" <<JSON
{
  "version": 1,
  "identities": [
    { "id": "$APP_ID", "patterns": ["^$APP_ID\$"], "launch": "foot --app-id=$APP_ID" }
  ],
  "layouts": {}
}
JSON
mv -f "$STATE.seed" "$STATE"
sleep 1

# The topology key for laptop+hw-test can only be computed while hw-test
# exists, so create it, record the layout THROUGH THE ENGINE (same code path
# the service plans with), then take it away again — the run proper starts from
# an undocked desktop.
hyprctl output create headless "$OUTPUT" >/dev/null
poll 10 monitor_present "$OUTPUT" || { echo "FAIL: $OUTPUT never appeared"; exit 1; }

node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], output = process.argv[3];
  var appId = process.argv[4], ws = Number(process.argv[5]);

  var monitors = JSON.parse(cp.execFileSync("hyprctl", ["monitors", "all", "-j"], { encoding: "utf8" }));
  var headless = null;
  for (var i = 0; i < monitors.length; i++) if (monitors[i].name === output) headless = monitors[i];
  if (!headless) { console.error("sim-dock: " + output + " not in the monitor list"); process.exit(1); }

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = {
    topologyKey: engine.topologyKey(monitors),
    recordedAt: new Date().toISOString(),
    apps: [{
      identityId: appId,
      monitorDescription: engine.monitorLabel(headless),
      workspaceId: ws,
      floating: false,
      group: null
    }]
  };
  // Atomic, for the reason spelled out above the identity seed.
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  console.log("seeded layout for \"" + layout.topologyKey + "\": " + appId + " on ws " + ws
    + " @ " + layout.apps[0].monitorDescription);
' "$REPO_ROOT" "$STATE" "$OUTPUT" "$APP_ID" "$TARGET_WS"

sleep 1
remove_output
# Let the undock cycle finish before the run proper: with no layout for the
# laptop-only topology it ends immediately, but the trigger debounce is 400ms.
sleep 3

# ------------------------------------------------- 1. LAUNCH on monitoradded

echo "=== case 1: LAUNCH ==="
kill_sim
hyprctl output create headless "$OUTPUT" >/dev/null
if poll 20 sim_placed; then
  pass "case 1 LAUNCH — $APP_ID launched onto ws $TARGET_WS on $OUTPUT"
else
  fail "case 1 LAUNCH — $APP_ID is on ws '$(sim_ws)' monitor '$(sim_field monitor)' (want ws $TARGET_WS on monitor $(monitor_id "$OUTPUT"))"
  diagnostics
fi

# Let the remaining settle passes of the dock cycle run out, so case 2 gets a
# cycle of its own rather than a queued rerun.
sleep 8

# ------------------------------------------------------------ 2. SCATTER

echo "=== case 2: SCATTER ==="
addr=$(sim_field address)
if [[ -z $addr ]]; then
  fail "case 2 SCATTER — no $APP_ID window to scatter"
else
  hyprctl dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
  hyprctl dispatch "hl.dsp.window.move({ workspace = \"$SCATTER_WS\", follow = false })" >/dev/null
  sleep 1
  echo "scattered to ws $(sim_ws)"
  trigger
  if poll 25 sim_placed; then
    pass "case 2 SCATTER — $APP_ID back on ws $TARGET_WS on $OUTPUT"
  else
    fail "case 2 SCATTER — $APP_ID is on ws '$(sim_ws)' monitor '$(sim_field monitor)'"
    diagnostics
  fi
fi

sleep 8

# --------------------------------------------------------- 3. IDEMPOTENCY

echo "=== case 3: IDEMPOTENCY ==="
converged_before=$(mw_count "converged, 0 ops")
iterations_before=$(mw_count " iteration ")
done_before=$(mw_count "restore cycle done")

trigger
if poll 30 bash -c "[[ \$(qs log -p '$SHELL_PATH' --tail 2000 2>/dev/null | grep -cF 'restore cycle done' || true) -gt $done_before ]]"; then
  converged_after=$(mw_count "converged, 0 ops")
  iterations_after=$(mw_count " iteration ")
  if (( converged_after > converged_before )) && (( iterations_after == iterations_before )); then
    pass "case 3 IDEMPOTENCY — the pass after the marker converged with 0 ops and planned nothing"
  else
    fail "case 3 IDEMPOTENCY — converged lines +$((converged_after - converged_before)), iteration lines +$((iterations_after - iterations_before))"
    diagnostics
  fi
else
  fail "case 3 IDEMPOTENCY — no restore cycle completed within 30s of the trigger"
  diagnostics
fi

# ------------------------------------------------------------------ verdict

verb_errors=$(mw_count "VERB-ERROR")
echo "VERB-ERROR lines currently in the log buffer: $verb_errors"
if (( verb_errors > 0 )); then
  echo "--- VERB-ERROR detail ---"
  mw_log | grep -F "VERB-ERROR" | tail -10
fi

if (( FAILURES == 0 )); then
  echo "sim-dock: ALL PASS"
else
  echo "sim-dock: $FAILURES case(s) FAILED"
fi
exit "$FAILURES"
