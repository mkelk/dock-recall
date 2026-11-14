#!/bin/bash
# sandbox-future-version.sh — finding A6 / tick t03, proven in the nested
# compositor: a state file from a schema generation this build does not
# understand is INERT. It is read, it is never written, and it dispatches
# NOTHING.
#
# Why this needs a compositor at all. The rule itself is pure and pinned in
# tests/state.test.js, but the bug was never in the rule — it was in who asked
# it. Service.qml asked `writeRefusal` on the write path and nobody asked
# anything on the restore path, so a v99 file drove a full restore cycle: it
# launched, it moved, it claimed windows against identity rules that
# `normalizeIdentity` had just stripped back to class-only on the way in. Only
# a running service against a real dock event can show that no dispatch happens.
#
# THE TWO ARMS, and the second is the one that makes the first mean anything:
#
#   DR_SCENARIO_VERSION=<STATE_VERSION>  (control) — the identical seed at a
#       version this build understands. The window MUST appear. Without this
#       arm, "no window appeared" is equally consistent with a broken harness.
#   DR_SCENARIO_VERSION=99               (subject) — the same seed, same layout,
#       same dock event. NO cycle may start, NO window may appear, and the panel
#       and log must say why.
#
# Usage: tests/sandbox-future-version.sh            # runs the subject arm (99)
#        DR_SCENARIO_VERSION=4 tests/…              # runs the control arm
#        tests/sandbox-future-version.sh --both     # both, in sequence
#
# One at a time, like every sandbox run — the library's flock says so.

set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --both re-executes this script once per arm rather than bringing two nested
# compositors up in one process: the harness's globals, its flock and its
# teardown trap are all single-run by construction, and a scenario that quietly
# reused them would be the first thing to leak.
if [[ ${1:-} == "--both" ]]; then
  control_version=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$LIB_DIR/..")
  echo "### arm 1/2: CONTROL — a v$control_version file at the same seed must launch"
  DR_SCENARIO_VERSION="$control_version" "$0" || exit $?
  echo
  echo "### arm 2/2: SUBJECT — a v99 file must do nothing at all"
  DR_SCENARIO_VERSION=99 "$0"
  exit $?
fi

source "$LIB_DIR/sandbox-lib.sh"

SEED_VERSION="${DR_SCENARIO_VERSION:-99}"
CURRENT_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$REPO_ROOT")
[[ $CURRENT_VERSION =~ ^[0-9]+$ ]] || { echo "FAIL: StateModel.STATE_VERSION came back as '$CURRENT_VERSION'"; exit 1; }

# Which arm is this? Everything below branches on this one boolean, so the two
# arms cannot drift into being two different tests.
FROM_THE_FUTURE=0
(( SEED_VERSION > CURRENT_VERSION )) && FROM_THE_FUTURE=1

echo "### sandbox-future-version: seed version $SEED_VERSION (this build writes v$CURRENT_VERSION)"
(( FROM_THE_FUTURE )) && echo "### SUBJECT arm: nothing may be dispatched" \
                      || echo "### CONTROL arm: the restore must happen normally"

# The identity list goes on disk BEFORE the shell starts, so the service's very
# first read is the one under test — that is the read whose log line the panel
# and the toast come from. The layout has to wait: its topologyKey is computed
# from monitors that do not exist yet.
sandbox_seed_home() {
  cat > "$STATE.seed" <<JSON
{
  "version": $SEED_VERSION,
  "paused": false,
  "identities": [
    { "id": "$APP_ID", "patterns": ["^$APP_ID\$"], "launch": "foot --app-id=$APP_ID" }
  ],
  "layouts": {}
}
JSON
  mv -f "$STATE.seed" "$STATE"
  note "planted a v$SEED_VERSION state file at $STATE before the shell started"
}

sandbox_up

# ------------------------------------------------------ the read, at load time

echo "=== the read ==="

# The service has already read the planted file (service-ready is behind us).
if (( FROM_THE_FUTURE )); then
  if poll 15 bash -c "sed 's/\x1b\[[0-9;]*m//g' '$SBOX/qs.log' | grep -qF 'READ-ONLY'"; then
    pass "the service says READ-ONLY about a v$SEED_VERSION file"
    note "$(sb_raw | grep -F "READ-ONLY" | head -1 | cut -c1-160)"
  else
    fail "no READ-ONLY line in the service log for a v$SEED_VERSION file"
  fi
  if sb_raw | grep -qF "INERT"; then
    pass "and INERT — the notice says restores are refused too, not just writes"
    note "$(sb_raw | grep -F "INERT" | head -1 | cut -c1-160)"
  else
    fail "the service never says the file is INERT; a user reading 'read-only' expects restores to keep running"
  fi
else
  if sb_raw | grep -qE "READ-ONLY|INERT"; then
    fail "a v$SEED_VERSION file — one this build writes — was called read-only or inert"
  else
    pass "a v$SEED_VERSION file draws no read-only and no inert notice"
  fi
fi

# ------------------------------------------------------------------- the seed
#
# Identical to sandbox-dock's, and deliberately so: the layout this plants is
# the layout that gate proves gets restored. The only difference between this
# run and that one is the number in `version`.

echo "=== seed: a layout the plugin would otherwise restore ==="

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
  if (!headless) { console.error("scenario: " + output + " not in the nested monitor list"); process.exit(1); }

  // parseState keeps a FUTURE version verbatim (migrateVersion is explicit
  // about that), and serializeState round-trips it, so the file this writes is
  // still stamped with the seeded number. That is the whole point: the seeder
  // is standing in for "a newer Dock Recall wrote this file".
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

seeded_version=$(jq -r .version "$STATE")
if [[ $seeded_version == "$SEED_VERSION" ]]; then
  pass "the seeded file is stamped v$seeded_version on disk"
else
  fail "the seed wrote version $seeded_version, not $SEED_VERSION — the arm under test is not the arm that ran"
fi
SEED_SHA=$(sha256sum "$STATE" | cut -d' ' -f1)

sleep 1
nested output remove "$OUTPUT" >/dev/null
if ! poll 15 bash -c "! HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl monitors all -j | jq -e --arg n '$OUTPUT' 'any(.[]; .name==\$n)' >/dev/null"; then
  fail "seed teardown — $OUTPUT never went away; the case would start DOCKED and prove nothing"
  diagnostics
fi
sleep 3

# =========================================================== THE CASE: the dock

echo "=== case: DOCK ==="

# Counted immediately before the event, so the assertion is about THIS dock and
# not about anything the load-time read may have done.
starts_before=$(sb_count "restore cycle start")
dones_before=$(sb_count "restore cycle done")
iters_before=$(sb_count " iteration ")

nested output create headless "$OUTPUT" >/dev/null

if (( FROM_THE_FUTURE )); then
  # The negative has to be given time to fail. 40s is the same budget case 1 of
  # sandbox-dock gives the launch it expects, so "no window in 40s" is measured
  # against a window that demonstrably arrives inside it.
  if poll 40 sim_placed; then
    fail "case DOCK — a v$SEED_VERSION file RESTORED: $APP_ID is on ws $(sim_ws). The file is not inert."
    diagnostics
  else
    if [[ -z $(sim_field address) ]]; then
      pass "case DOCK — 40s after the dock, a v$SEED_VERSION file has launched nothing at all"
    else
      fail "case DOCK — a v$SEED_VERSION file launched $APP_ID (on ws $(sim_ws)), even if it landed wrong"
      diagnostics
    fi
  fi

  starts_after=$(sb_count "restore cycle start")
  dones_after=$(sb_count "restore cycle done")
  iters_after=$(sb_count " iteration ")
  if (( starts_after == starts_before && dones_after == dones_before && iters_after == iters_before )); then
    pass "case DOCK — ZERO restore cycles: no start, no plan iteration, no completion"
  else
    fail "case DOCK — the dock produced restore work: cycle start +$((starts_after - starts_before)), iterations +$((iters_after - iters_before)), done +$((dones_after - dones_before))"
    diagnostics
  fi

  # …and it said so, naming the event it declined.
  if sb_raw | grep -qF "not restoring ("; then
    pass "case DOCK — the refusal is in the log, naming the event it declined"
    note "$(sb_raw | grep -F "not restoring (" | tail -1 | cut -c1-160)"
  else
    fail "case DOCK — nothing was restored and nothing was said; a silent no-op is the worse bug"
  fi

  # The manual trigger is NOT an override. Pausing is "not now" and the user's
  # button rightly beats it; this is "I cannot read this file", and it does not.
  starts_before=$(sb_count "restore cycle start")
  trigger
  sleep 6
  if (( $(sb_count "restore cycle start") == starts_before )); then
    pass "case DOCK — the manual trigger is refused too: a button cannot make a stripped identity list safe"
  else
    fail "case DOCK — the manual trigger drove a restore from a v$SEED_VERSION file"
    diagnostics
  fi
else
  if poll 40 sim_placed; then
    pass "case DOCK (control) — a v$SEED_VERSION file restored normally: $APP_ID on ws $(target_ws) (slot $TARGET_SLOT) on $OUTPUT"
  else
    fail "case DOCK (control) — the control arm did not restore ($APP_ID on ws '$(sim_ws)'). The subject arm's silence proves nothing."
    diagnostics
  fi
  wait_for_cycle 40 "$dones_before" || note "warning: the dock cycle never logged its completion"
fi

# ----------------------------------------------------- and the file is untouched

if (( FROM_THE_FUTURE )); then
  if [[ $(sha256sum "$STATE" | cut -d' ' -f1) == "$SEED_SHA" ]]; then
    pass "the v$SEED_VERSION file is byte-identical to the seed — nothing wrote it either"
  else
    fail "the v$SEED_VERSION file was rewritten; the write refusal leaked"
  fi
fi

sandbox_verdict "sandbox-future-version(v$SEED_VERSION)"
