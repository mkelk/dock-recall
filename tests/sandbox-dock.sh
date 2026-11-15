#!/bin/bash
# sandbox-dock.sh — the engine/service gate, run against a NESTED Hyprland that
# the user never sees (Tier B of the sandbox model).
#
# What it is: `tests/sim-dock.sh` without the live session. A second Hyprland
# runs as an invisible window of the real one, a second Quickshell hosts THIS
# WORKTREE's plugin against it, and every path the plugin writes is redirected
# into a temp HOME. The real desktop is not a participant — it only lends a
# Wayland socket to hang the nested compositor's window off.
#
# WHY: the live gate shuffled the user's desk while they were working. Anything
# that drives a compositor belongs here now; sim-dock.sh is on-request only.
#
# The harness — the temp HOME, the invisible compositor, the sandboxed shell and
# THE THREE ISOLATION RULES that fail the run if any of it leaks — lives in
# tests/sandbox-lib.sh, shared with the scenario runs beside it. This file is
# the seed and sim-dock's three cases: LAUNCH, SCATTER, IDEMPOTENCY.
#
# Usage: tests/sandbox-dock.sh        exit 0 = all cases passed
#        DR_SANDBOX_KEEP=1 tests/sandbox-dock.sh   keep the sandbox dir + logs
#
# Runs alongside your work, but only ONE AT A TIME (a flock in the library).
#
# See tests/nested-notes.md for what was measured while building this.

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-lib.sh"

# The four knobs this scenario runs on, STATED rather than inherited.
# The library defaults are these same values; writing them here is what makes
# the seed below readable without a second file open, and what makes a change to
# a default show up in this file's diff. They are validated by sandbox_up.
#
# To vary one for a debugging run, export DR_SANDBOX_APP_ID (or _OUTPUT,
# _TARGET_SLOT, _SCATTER_SLOT) — a plain `APP_ID=…` is deliberately ignored, because
# that name belongs to too many other tools to be trusted as an instruction.
APP_ID="dr-sim"        # the class the seeded identity matches, and what foot is told to be
OUTPUT="sbx-test"      # the headless monitor the dock/undock is performed on
TARGET_SLOT=9          # the slot, on $OUTPUT, where the recorded layout puts the window
SCATTER_SLOT=1         # the PRIMARY monitor's slot case 2 throws it to, to watch the restore bring it back

sandbox_up

# ------------------------------------------------------------------ 3. the seed
#
# Same shape as sim-dock: seed the identity, create the output so the topology
# key can be computed, record a layout THROUGH THE ENGINE, then take the output
# away again — the run proper starts undocked.

echo "=== seed ==="

# The identity seed is the one piece of hand-written JSON here, and its schema
# version is read out of StateModel rather than typed: a seed declaring an OLDER
# version is read as a MIGRATION, and v4's migration is not purely additive (it
# can rewrite `launch`), so a hardcoded number would quietly change what this
# gate thinks it seeded. The LAYOUT below goes through the engine.
SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$REPO_ROOT")
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] || { echo "FAIL: StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"; exit 1; }

cat > "$STATE.seed" <<JSON
{
  "version": $SCHEMA_VERSION,
  "identities": [
    { "id": "$APP_ID", "patterns": ["^$APP_ID\$"], "launch": "foot --app-id=$APP_ID" }
  ],
  "layouts": {}
}
JSON
mv -f "$STATE.seed" "$STATE"
sleep 1

nested output create headless "$OUTPUT" >/dev/null
poll 15 monitor_present "$OUTPUT" || { echo "FAIL: $OUTPUT never appeared in the nested instance"; exit 1; }

HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], output = process.argv[3];
  var appId = process.argv[4], slot = Number(process.argv[5]);

  var monitors = JSON.parse(cp.execFileSync("hyprctl", ["monitors", "all", "-j"], { encoding: "utf8" }));
  var headless = null;
  for (var i = 0; i < monitors.length; i++) if (monitors[i].name === output) headless = monitors[i];
  if (!headless) { console.error("sandbox-dock: " + output + " not in the nested monitor list"); process.exit(1); }

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = {
    topologyKey: engine.topologyKey(monitors),
    recordedAt: new Date().toISOString(),
    apps: [{
      identityId: appId,
      monitorDescription: engine.monitorLabel(headless),
      slot: slot,
      floating: false,
      group: null
    }]
  };
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  console.log("  · seeded layout for \"" + layout.topologyKey + "\": " + appId + " on slot " + slot
    + " @ " + layout.apps[0].monitorDescription);
' "$REPO_ROOT" "$STATE" "$OUTPUT" "$APP_ID" "$TARGET_SLOT" || { echo "FAIL: seeding failed"; exit 1; }

sleep 1
nested output remove "$OUTPUT" >/dev/null
# The run proper has to start UNDOCKED. If the output is still there, case 1 is
# not a LAUNCH-on-dock test at all — it starts from the state it means to reach —
# so a timeout here is a failed check, not something to poll past in silence.
if ! poll 15 bash -c "! HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl monitors all -j | jq -e --arg n '$OUTPUT' 'any(.[]; .name==\$n)' >/dev/null"; then
  fail "seed teardown — $OUTPUT never went away after 'output remove'; the cases would start DOCKED and prove nothing"
  diagnostics
fi
sleep 3

# =================================================================== THE CASES
#
# sim-dock's three, unchanged in substance: the plugin must LAUNCH what is
# missing, put back what is SCATTERED, and then do NOTHING. Each case waits for
# the cycle it started to finish before the next one begins, so a case is never
# scored against a queued rerun of its predecessor — polled on the log's own
# cycle-done marker rather than a fixed sleep, because the settle passes make
# every timing variable.

echo "=== case 1: LAUNCH ==="

cycles_before=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null

if poll 40 sim_placed; then
  pass "case 1 LAUNCH — $APP_ID launched onto ws $(target_ws) (slot $TARGET_SLOT) on $OUTPUT"
else
  fail "case 1 LAUNCH — $APP_ID is on ws '$(sim_ws)' monitor '$(sim_field monitor)' (want ws $(target_ws) on monitor $(monitor_id "$OUTPUT"))"
  diagnostics
fi
wait_for_cycle 40 "$cycles_before" || note "warning: the dock cycle never logged its completion"

# ------------------------------------------------------------------ 2. SCATTER

echo "=== case 2: SCATTER ==="

addr=$(sim_field address)
if [[ -z $addr ]]; then
  fail "case 2 SCATTER — no $APP_ID window to scatter"
else
  # Both dispatches go to the NESTED instance: the focus this takes is the
  # nested compositor's, not the user's.
  nested dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
  SCATTER_LIVE=$(scatter_ws)   # the primary's block*10+slot, from the block file
  nested dispatch "hl.dsp.window.move({ workspace = \"$SCATTER_LIVE\", follow = false })" >/dev/null
  if poll 10 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg c '$APP_ID' 'first(.[]|select(.class==\$c)|.workspace.id)//empty') == $SCATTER_LIVE ]]"; then
    note "scattered to ws $(sim_ws)"
  else
    note "warning: the scatter dispatch left $APP_ID on ws $(sim_ws)"
  fi

  cycles_before=$(sb_count "restore cycle done")
  trigger
  if poll 40 sim_placed; then
    pass "case 2 SCATTER — $APP_ID back on ws $(target_ws) (slot $TARGET_SLOT) on $OUTPUT"
  else
    fail "case 2 SCATTER — $APP_ID is on ws '$(sim_ws)' monitor '$(sim_field monitor)'"
    diagnostics
  fi
  wait_for_cycle 40 "$cycles_before" || note "warning: the scatter cycle never logged its completion"
fi

# -------------------------------------------------------------- 3. IDEMPOTENCY

echo "=== case 3: IDEMPOTENCY ==="

converged_before=$(sb_count "converged, 0 ops")
iterations_before=$(sb_count " iteration ")
cycles_before=$(sb_count "restore cycle done")

trigger
if wait_for_cycle 40 "$cycles_before"; then
  converged_after=$(sb_count "converged, 0 ops")
  iterations_after=$(sb_count " iteration ")
  if (( converged_after > converged_before )) && (( iterations_after == iterations_before )); then
    pass "case 3 IDEMPOTENCY — the pass after the marker converged with 0 ops and planned nothing"
  else
    fail "case 3 IDEMPOTENCY — converged lines +$((converged_after - converged_before)), iteration lines +$((iterations_after - iterations_before))"
    diagnostics
  fi
else
  fail "case 3 IDEMPOTENCY — no restore cycle completed within 40s of the trigger"
  diagnostics
fi

# ------------------------------------------------------------------- evidence

# The state the plugin wrote is in the temp HOME, and only there.
if [[ -s $STATE ]]; then
  pass "sandbox state written to the temp HOME only: $STATE ($(wc -c < "$STATE") bytes, version $(jq -r .version "$STATE"))"
else
  fail "no sandbox state file at $STATE"
fi

sandbox_verdict "sandbox-dock"
