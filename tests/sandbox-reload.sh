#!/bin/bash
# sandbox-reload.sh — a Hyprland config reload restores only when the monitors
# or the block table changed (human decision 2026-11-14, "restore only if
# monitors changed"; the fidelity epic). Tier B, nested compositor.
#
# Why it exists: entering Omarchy 4.5's floating mode reloads Hyprland's config,
# and while every configreloaded started a restore cycle, a VM run saw the plugin
# move windows back and LAUNCH recorded-but-closed apps on a mode toggle.
#
# What it proves, against the REAL service and 4.5's monitor-workspaces.lua:
#
#   1. RELOAD, MONITORS UNCHANGED — with a watched window scattered off its slot
#      and a recorded app closed, `hyprctl reload` makes the service say
#      "config reload: monitors and blocks unchanged — no restore", and in the
#      seconds a cycle would have needed: no "restore cycle start", no plan
#      iteration, no launch; the window is still where it was scattered, the
#      closed app is still closed.
#   2. RELOAD WITH AN OUTPUT ADDED — an output created and a reload straight
#      after it still restore: a cycle starts and the window lands on its
#      recorded slot of the new output.
#
# Usage: tests/sandbox-reload.sh       exit 0 = all checks passed
#        DR_SANDBOX_KEEP=1 tests/sandbox-reload.sh   keep the sandbox dir + logs

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-lib.sh"

APP_ID="dr-ra"           # the watched window that is scattered; the footer's stray check reads it
CLOSED="dr-rb"           # recorded, then closed: a restore would launch it
OUTPUT="sbx-test"        # the headless output of case 2
HOME_SLOT=2              # dr-ra's recorded slot on the primary
CLOSED_SLOT=3            # dr-rb's recorded slot on the primary
SCATTER_SLOT=5           # where dr-ra is left before the reload
DOCKED_SLOT=4            # dr-ra's recorded slot on $OUTPUT

sandbox_seed_home() {
  local version
  version=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$REPO_ROOT")
  cat > "$STATE.seed" <<JSON
{ "version": $version, "paused": false, "identities": [
  { "id": "$APP_ID", "patterns": ["^$APP_ID\$"], "launch": "foot --app-id=$APP_ID" },
  { "id": "$CLOSED", "patterns": ["^$CLOSED\$"], "launch": "foot --app-id=$CLOSED" }
], "layouts": {} }
JSON
  mv -f "$STATE.seed" "$STATE"
  note "planted 2 identities before the shell started"
}

sandbox_up

ws_of_class() { nested clients -j | jq -r --arg c "$1" 'first(.[]|select(.class==$c)|.workspace.id)//empty'; }
on_ws()       { [[ $(ws_of_class "$1") == "$2" ]]; }
absent()      { [[ -z $(addr_of "$1") ]]; }
output_gone() { [[ -z $(monitor_id "$OUTPUT") ]]; }
has_block()   { [[ -n $(block_of "$OUTPUT") ]]; }

# move_to <class> <workspace> [monitor] — as sandbox-slots: a missing workspace
# is created on the focused monitor, so it is sent to its owner right after.
move_to() {
  local addr exists; addr=$(addr_of "$1")
  [[ -n $addr ]] || return 1
  exists=$(nested workspaces -j | jq -r --argjson w "$2" 'any(.[]; .id==$w)')
  nested dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
  nested dispatch "hl.dsp.window.move({ workspace = \"$2\", follow = false })" >/dev/null
  if [[ -n ${3:-} && $exists == false ]]; then
    nested dispatch "hl.dsp.workspace.move({ workspace = \"$2\", monitor = \"$3\" })" >/dev/null
  fi
  poll 10 on_ws "$1" "$2"
}

PRIMARY=$(primary_monitor)
[[ -n $PRIMARY ]] || { echo "FAIL: no primary monitor"; exit 1; }

# ------------------------------------------------------------------ the record
#
# The docked record first, while only dr-ra runs: recording the laptop with
# dr-rb open and then docking would make the undock restore relaunch it.

echo "=== record: docked topology (dr-ra on $OUTPUT slot $DOCKED_SLOT) ==="
launch "$APP_ID" "$(ws "$HOME_SLOT")" || { echo "FAIL: $APP_ID never appeared"; exit 1; }
cycles=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null
poll 15 monitor_present "$OUTPUT" || { echo "FAIL: $OUTPUT never appeared"; exit 1; }
poll 15 has_block || { echo "FAIL: monitor-workspaces.lua gave $OUTPUT no block"; exit 1; }
wait_for_cycle 40 "$cycles" || note "warning: the setup dock cycle never logged its completion"
DOCKED_WS=$(expected_ws "$OUTPUT" "$DOCKED_SLOT")
move_to "$APP_ID" "$DOCKED_WS" "$OUTPUT" || { echo "FAIL: $APP_ID did not reach ws $DOCKED_WS"; diagnostics; exit 1; }
sleep 1
record_current

echo "=== record: laptop topology (dr-ra slot $HOME_SLOT, dr-rb slot $CLOSED_SLOT) ==="
cycles=$(sb_count "restore cycle done")
nested output remove "$OUTPUT" >/dev/null
poll 15 output_gone || { echo "FAIL: $OUTPUT never went away"; exit 1; }
wait_for_cycle 40 "$cycles" || note "warning: the setup undock cycle never logged its completion"
on_ws "$APP_ID" "$(ws "$HOME_SLOT")" || move_to "$APP_ID" "$(ws "$HOME_SLOT")" \
  || { echo "FAIL: $APP_ID is not on ws $(ws "$HOME_SLOT")"; diagnostics; exit 1; }
launch "$CLOSED" "$(ws "$CLOSED_SLOT")" || { echo "FAIL: $CLOSED never appeared"; exit 1; }
sleep 1
record_current

# The desk the reload finds: the recorded app closed, the other one scattered.
d "hl.dsp.window.close({ window = \"address:$(addr_of "$CLOSED")\" })" >/dev/null
poll 10 absent "$CLOSED" || { echo "FAIL: $CLOSED did not close"; exit 1; }
SCATTERED=$(ws "$SCATTER_SLOT")
move_to "$APP_ID" "$SCATTERED" || { echo "FAIL: $APP_ID was not scattered to ws $SCATTERED"; exit 1; }
note "$CLOSED closed, $APP_ID scattered to ws $SCATTERED"
sleep 3   # past the 2 s drift refresh, so the service's last reading is this desk

# ------------------------------------------------ 1. RELOAD, MONITORS UNCHANGED

echo "=== case 1: config reload, monitors unchanged ==="
mark=$(sb_log | wc -l)
nested reload >/dev/null
slice() { sb_log | tail -n +"$((mark + 1))"; }
decided() { slice | grep -qF "config reload: monitors and blocks unchanged — no restore"; }

if poll 20 decided; then
  pass "case 1 — the service judged the reload: $(slice | grep -F 'config reload:' | head -1 | sed 's/.*\[dock-recall\] *//')"
else
  fail "case 1 — no 'config reload: monitors and blocks unchanged — no restore' line within 20 s"
  slice | grep -E "event |config reload|restore cycle|reconcile" | head -20 | sed 's/^/        /'
fi
# A cycle the reload had started would be on its second settle pass by now
# (1 s after the burst) and dispatching.
sleep 8
SLICE=$(slice)
grep -qF "event configreloaded" <<<"$SLICE" \
  && pass "case 1 — the service saw configreloaded" \
  || fail "case 1 — no 'event configreloaded' in the log: the reload never reached the service, the case proves nothing"
if grep -qF "restore cycle start" <<<"$SLICE"; then
  fail "case 1 — the reload started a restore cycle"
  grep -E "restore cycle|config reload|iteration" <<<"$SLICE" | head -10 | sed 's/^/        /'
else
  pass "case 1 — no restore cycle started"
fi
iters=$(grep -cE 'pass [0-9]+ iteration [0-9]+:|launched ' <<<"$SLICE" || true)
(( iters == 0 )) && pass "case 1 — nothing planned, dispatched or launched (0 iteration / launch lines)" \
  || fail "case 1 — $iters iteration / launch line(s) after the reload"
on_ws "$APP_ID" "$SCATTERED" && pass "case 1 — $APP_ID is still on ws $SCATTERED, where it was left" \
  || fail "case 1 — $APP_ID moved to ws '$(ws_of_class "$APP_ID")' after the reload"
absent "$CLOSED" && pass "case 1 — the closed $CLOSED was not launched" \
  || fail "case 1 — $CLOSED was launched by the reload"

# ------------------------------------------- 2. RELOAD WITH AN OUTPUT ADDED

echo "=== case 2: an output added, then a config reload ==="
mark=$(sb_log | wc -l)
cycles=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null
nested reload >/dev/null
poll 15 has_block || note "warning: $OUTPUT has no block yet"
placed_docked() { local w; w=$(expected_ws "$OUTPUT" "$DOCKED_SLOT"); [[ -n $w ]] && on_ws "$APP_ID" "$w"; }
if poll 60 placed_docked; then
  pass "case 2 — $APP_ID restored onto ws $(expected_ws "$OUTPUT" "$DOCKED_SLOT") ($OUTPUT slot $DOCKED_SLOT)"
else
  fail "case 2 — $APP_ID is on ws '$(ws_of_class "$APP_ID")', want ws $(expected_ws "$OUTPUT" "$DOCKED_SLOT") on $OUTPUT"
  diagnostics
fi
wait_for_cycle 40 "$cycles" || note "warning: the case 2 cycle never logged its completion"
SLICE=$(slice)
grep -qF "restore cycle start" <<<"$SLICE" && pass "case 2 — a restore cycle started" \
  || fail "case 2 — no restore cycle started"
grep -qF "event configreloaded" <<<"$SLICE" \
  && pass "case 2 — the reload reached the service beside the monitor event" \
  || note "warning: case 2 saw no configreloaded event"

sandbox_verdict "sandbox-reload"
