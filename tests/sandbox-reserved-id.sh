#!/bin/bash
# sandbox-reserved-id.sh — proven in the nested
# compositor: an app whose identity id collides with an Object.prototype key is
# matched, launched, placed, moved and named in the diagnostics like any other.
#
# WHY IT NEEDS A COMPOSITOR. The rule (`own()`) is pure and pinned in
# tests/reserved-ids.test.js. The maps that still got it wrong were the three
# bare-object dedupes inside Panel.qml and Service.qml, where node cannot look:
# `seen[id]` on a bare object is truthy for `constructor` before anything is put
# there, so the FIRST sighting of such an app was thrown away as a duplicate.
#
# HOW THE ID IS REACHED WITHOUT A HAND EDIT. PanelModel.deriveIdentityId builds
# an id out of the window class's segments, so a window classed `Constructor`
# derives exactly the id `constructor`. This scenario asserts that derivation
# out of the real module and then seeds the id it produces.
#
# THE TWO PHASES:
#
#   1. RESTORE — an identity `constructor` (patterns ^Constructor$) with a
#      recorded layout. Dock: it must launch and land on its workspace. Scatter:
#      it must come back. Nothing about it may go missing on the way.
#   2. THE LAUNCH DIAGNOSTIC — a second identity whose launch command opens a
#      window of a class it does not claim, and that class is `toString`. When
#      the 10s launch wait gives up, the warning has to NAME the window that did
#      turn up. Before the fix, Service.qml's `seen[name]` dropped `toString`
#      and the line read "no new window appeared at all" with the window on
#      screen — which is the difference between a diagnosis and a dead end.
#
# Phase 2 is the arm that tells a fixed tree from an unfixed one on the SERVICE
# side; phase 1 is the one that says the app still works.
#
# Usage: tests/sandbox-reserved-id.sh
#
# One at a time, like every sandbox run — the library's flock says so.

set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$LIB_DIR/sandbox-lib.sh"

# AFTER the source, and that is not a style choice. sandbox-lib.sh assigns
# `APP_ID="${DR_SANDBOX_APP_ID:-dr-sim}"` unconditionally (so an
# ambient `APP_ID` from a shell rc cannot silently reconfigure the gate), so a
# scenario's own value only survives if it is set afterwards — which is what
# sandbox-dock.sh does. Set above the source, this file's `Constructor` was
# overwritten with `dr-sim` and the run died at the deriveIdentityId check
# below, which is exactly the check that exists to catch a scenario no longer
# testing what it says.
#
# The window class the whole scenario hangs off, and the id it derives to.
APP_ID="Constructor"
STRAY_ID="strayclass"
STRAY_CLASS="toString"
STRAY_SLOT=8

# Not assumed — asked. If deriveIdentityId ever stopped producing `constructor`
# from `Constructor` this scenario would be seeding a hand edit and quietly
# proving something weaker than it claims.
DERIVED_ID=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/PanelModel.js").deriveIdentityId(process.argv[2])))' "$LIB_DIR/.." "$APP_ID")
if [[ $DERIVED_ID == "constructor" ]]; then
  echo "  · PanelModel.deriveIdentityId(\"$APP_ID\") = \"$DERIVED_ID\" — the id a user's tick would write"
else
  echo "FAIL: deriveIdentityId(\"$APP_ID\") is \"$DERIVED_ID\", not \"constructor\" — this scenario no longer tests what it says"
  exit 1
fi

# Both identities are on disk before the shell starts, so the service's first
# read is the one under test. Only `constructor` gets a layout entry for now:
# phase 2 adds the other, because its launch never satisfies its own wait and a
# cycle carrying it takes ten seconds per pass.
sandbox_seed_home() {
  cat > "$STATE.seed" <<JSON
{
  "version": $(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$LIB_DIR/.."),
  "paused": false,
  "identities": [
    { "id": "$DERIVED_ID", "patterns": ["^$APP_ID\$"], "launch": "foot --app-id=$APP_ID" },
    { "id": "$STRAY_ID", "patterns": ["^never-appears-here\$"], "launch": "foot --app-id=$STRAY_CLASS" }
  ],
  "layouts": {}
}
JSON
  mv -f "$STATE.seed" "$STATE"
  note "planted identities \"$DERIVED_ID\" and \"$STRAY_ID\" before the shell started"
}

sandbox_up

# ------------------------------------------------------------------- the seed

echo "=== seed: a layout for the reserved-id app ==="

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
' "$REPO_ROOT" "$STATE" "$OUTPUT" "$DERIVED_ID" "$TARGET_SLOT" || { echo "FAIL: seeding failed"; exit 1; }

# The identity survived the round trip through the reader, which is the earlier half
# and the precondition for everything below.
if [[ $(jq -r --arg id "$DERIVED_ID" '[.identities[]|select(.id==$id)]|length' "$STATE") == "1" ]]; then
  pass "the identity \"$DERIVED_ID\" survived the read/write round trip"
else
  fail "the identity \"$DERIVED_ID\" is not in the state file the plugin wrote"
  jq -c '.identities' "$STATE"
fi

sleep 1
nested output remove "$OUTPUT" >/dev/null
if ! poll 15 bash -c "! HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl monitors all -j | jq -e --arg n '$OUTPUT' 'any(.[]; .name==\$n)' >/dev/null"; then
  fail "seed teardown — $OUTPUT never went away; the case would start DOCKED and prove nothing"
  diagnostics
fi
sleep 3

# ============================================== PHASE 1, case 1: it is restored

echo "=== case 1: LAUNCH a reserved-id app ==="

cycles_before=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null

if poll 60 sim_placed; then
  pass "case 1 — \"$DERIVED_ID\" launched onto ws $(target_ws) (slot $TARGET_SLOT) on $OUTPUT"
else
  fail "case 1 — \"$DERIVED_ID\" is on ws '$(sim_ws)' monitor '$(sim_field monitor)' (want ws $(target_ws) on monitor $(monitor_id "$OUTPUT"))"
  diagnostics
fi

# The launch wait's own line: it names the address the launch opened, which is
# engine.newAddressSince answering about a window it had to tell from the ones
# already there.
if sb_raw | grep -qF "launched $DERIVED_ID -> 0x"; then
  pass "case 1 — the launch wait named the window it opened"
  note "$(sb_raw | grep -F "launched $DERIVED_ID -> " | tail -1 | cut -c1-140)"
else
  fail "case 1 — no 'launched $DERIVED_ID -> 0x…' line; the wait never confirmed a window"
fi
wait_for_cycle 60 "$cycles_before" || note "warning: the dock cycle never logged its completion"

# --------------------------------------------------------- case 2: it comes back

echo "=== case 2: SCATTER a reserved-id app ==="

addr=$(sim_field address)
if [[ -z $addr ]]; then
  fail "case 2 — no \"$APP_ID\" window to scatter"
else
  nested dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
  SCATTER_LIVE=$(scatter_ws)   # the primary's block*10+slot, from the block file
  nested dispatch "hl.dsp.window.move({ workspace = \"$SCATTER_LIVE\", follow = false })" >/dev/null
  poll 10 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg c '$APP_ID' 'first(.[]|select(.class==\$c)|.workspace.id)//empty') == $SCATTER_LIVE ]]" \
    && note "scattered to ws $(sim_ws)" || note "warning: the scatter dispatch left $APP_ID on ws $(sim_ws)"

  cycles_before=$(sb_count "restore cycle done")
  trigger
  if poll 60 sim_placed; then
    pass "case 2 — \"$DERIVED_ID\" moved back to ws $(target_ws) (slot $TARGET_SLOT) on $OUTPUT"
  else
    fail "case 2 — \"$DERIVED_ID\" is on ws '$(sim_ws)' monitor '$(sim_field monitor)'"
    diagnostics
  fi
  wait_for_cycle 60 "$cycles_before" || note "warning: the scatter cycle never logged its completion"
fi

# ================================= PHASE 2: the launch diagnostic names the class

echo "=== case 3: a failed launch NAMES the window that appeared ==="

# A second recorded app whose launch opens a window it does not claim. Exactly
# the shape the shared-Chromium bug had, with the class chosen to be an
# Object.prototype key so the dedupe that used to drop it is the thing on trial.
HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], output = process.argv[3];
  var strayId = process.argv[4], straySlot = Number(process.argv[5]);

  var monitors = JSON.parse(cp.execFileSync("hyprctl", ["monitors", "all", "-j"], { encoding: "utf8" }));
  var headless = null;
  for (var i = 0; i < monitors.length; i++) if (monitors[i].name === output) headless = monitors[i];
  if (!headless) { console.error("scenario: " + output + " is gone"); process.exit(1); }

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var key = engine.topologyKey(monitors);
  var layout = StateModel.layoutFor(state, key);
  layout.apps = layout.apps.concat([{
    identityId: strayId,
    monitorDescription: engine.monitorLabel(headless),
    slot: straySlot,
    floating: false,
    group: null
  }]);
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  console.log("  · added \"" + strayId + "\" to the layout; its launch opens a window classed toString");
' "$REPO_ROOT" "$STATE" "$OUTPUT" "$STRAY_ID" "$STRAY_SLOT" || { echo "FAIL: phase-2 seeding failed"; exit 1; }

sleep 2
trigger

# The wait is 10s per launch attempt plus the settle delay in front of it, so
# 90s covers a first attempt comfortably without waiting out the whole cycle —
# one timeout is all this case needs.
if poll 90 bash -c "sed 's/\x1b\[[0-9;]*m//g' '$SBOX/qs.log' | grep -qF 'launch of \"$STRAY_ID\" produced no window'"; then
  timeout_line=$(sb_raw | grep -F "launch of \"$STRAY_ID\" produced no window" | tail -1)
  pass "case 3 — the launch of \"$STRAY_ID\" timed out, as designed"
  if [[ $timeout_line == *"$STRAY_CLASS"* ]]; then
    pass "case 3 — and the warning NAMES the class that did appear: $STRAY_CLASS"
    note "$(echo "$timeout_line" | cut -c1-200)"
  else
    fail "case 3 — the warning does not name \"$STRAY_CLASS\"; the class-name dedupe dropped it"
    note "$(echo "$timeout_line" | cut -c1-220)"
    # Said explicitly, because this is the one that separates a fixed tree from
    # an unfixed one: the window IS there, and the line claims it is not.
    note "windows of class $STRAY_CLASS actually on screen: $(nested clients -j | jq -c --arg c "$STRAY_CLASS" '[.[]|select(.class==$c)|.address]')"
  fi
  if [[ $timeout_line == *"no new window appeared at all"* ]]; then
    fail "case 3 — the warning says 'no new window appeared at all' while a $STRAY_CLASS window is on screen"
  else
    pass "case 3 — the warning does not claim that nothing appeared"
  fi
else
  fail "case 3 — no launch timeout for \"$STRAY_ID\" within 90s; the case never got to run"
  diagnostics
fi

# The window really was there for the line to have named — asserted, not assumed.
if [[ -n $(nested clients -j | jq -r --arg c "$STRAY_CLASS" 'first(.[]|select(.class==$c)|.address)//empty') ]]; then
  pass "case 3 — a window of class $STRAY_CLASS is on screen, so the diagnostic had something to report"
else
  fail "case 3 — no $STRAY_CLASS window ever opened; the case proves nothing about the diagnostic"
  diagnostics
fi

sandbox_verdict "sandbox-reserved-id"
