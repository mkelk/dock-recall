#!/bin/bash
# sandbox-slots.sh — the Omarchy 4.5 dock / undock / dock scenario, in the nested
# compositor (Tier B). Increment 08-qjd, definition of done A.
#
# What it proves, with the REAL 4.5 monitor-workspaces.lua running in the nested
# Hyprland and the REAL plugin service restoring against it:
#
#   - THREE watched apps on TWO slots of the headless output, and the same three
#     on the primary while undocked, recorded the way the panel records: through
#     engine.buildLayout and then Slots.toRecorded, never hand-written;
#   - after EACH of dock, undock, dock: every watched window is on its recorded
#     (monitor, slot) — where the laptop-topology record says while undocked —
#     and the expected workspace id is block*10+slot read from the sandbox block
#     file, never a literal;
#   - the external monitor's workspaces are all inside its own block (the 4.5
#     module renumbers anything outside it, and a restore that fights it shows
#     up here);
#   - the merged file is empty after the redock (nothing is left merged);
#   - no dispatch precedes "reconcile gate: ready": every `pass N iteration M:`
#     line in a step is preceded by a gate line that says ready (the service must
#     wait for the 4.5 re-sort to settle before it plans);
#   - the desk's ~/.local/state/omarchy/monitor-workspaces* mtimes are unchanged
#     — the isolation footer (sandbox_verdict) checks that, as for every run.
#
# Record once, then poll (learnings: record-then-poll): the layouts are written
# one time each; every assertion polls for the computed expectation, and the
# expected and actual lists are produced by the SAME node script, sorted by the
# same call, so a sort-order difference cannot fake a mismatch.
#
# Usage: tests/sandbox-slots.sh       exit 0 = all checks passed
#        DR_SANDBOX_KEEP=1 tests/sandbox-slots.sh   keep the sandbox dir + logs
#
# One at a time, like every sandbox run — the library's flock says so.

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-lib.sh"

# The three watched apps. Classes are what `foot --app-id` produces and what the
# seeded identities match. A and B share a slot on purpose: two windows on one
# slot is the case a slot-collapsing bug would get wrong.
APPS=(dr-sa dr-sb dr-sc)
APP_ID="dr-sa"                 # the footer's stray-window check reads this one
OUTPUT="sbx-test"              # the headless monitor docked and undocked
# slot on the PRIMARY while undocked / slot on $OUTPUT while docked, per app
declare -A SLOT_PRIMARY=( [dr-sa]=2 [dr-sb]=2 [dr-sc]=3 )
declare -A SLOT_DOCKED=(  [dr-sa]=9 [dr-sb]=9 [dr-sc]=4 )

sandbox_seed_home() {
  local version
  version=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$REPO_ROOT")
  {
    echo "{ \"version\": $version, \"paused\": false, \"identities\": ["
    local first=1 app
    for app in "${APPS[@]}"; do
      (( first )) || echo ","
      first=0
      printf '  { "id": "%s", "patterns": ["^%s$"], "launch": "foot --app-id=%s" }' "$app" "$app" "$app"
    done
    echo "], \"layouts\": {} }"
  } > "$STATE.seed"
  mv -f "$STATE.seed" "$STATE"
  note "planted ${#APPS[@]} identities before the shell started"
}

sandbox_up

MERGED="$SBOX/home/.local/state/omarchy/monitor-workspaces-merged"
CLASS_RE="^(dr-sa|dr-sb|dr-sc)\$"

# ---------------------------------------------------------------- the tools

# record_current — record what is on screen NOW the way the panel does: build the
# live layout with the engine, convert it to slots with Slots.toRecorded, upsert
# it under the current topology. Refuses (exit 1) if anything was excluded, so a
# window that is not where this scenario put it cannot be recorded by accident.
record_current() {
  HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
    var fs = require("fs"), cp = require("child_process");
    var root = process.argv[1], statePath = process.argv[2], blocksPath = process.argv[3];
    var engine = require(root + "/engine.js"), SM = require(root + "/StateModel.js"), Slots = require(root + "/Slots.js");
    function hc(args) { return JSON.parse(cp.execFileSync("hyprctl", args, { encoding: "utf8" })); }
    var monitors = hc(["monitors", "all", "-j"]), clients = hc(["clients", "-j"]);
    var state = SM.parseState(fs.readFileSync(statePath, "utf8")).state;
    var live = engine.buildLayout(clients, monitors, state.identities, new Date().toISOString());
    var table = Slots.parseBlocks(fs.readFileSync(blocksPath, "utf8"));
    var rec = Slots.toRecorded(live, table, monitors);
    if (rec.excluded.length) { console.error("excluded: " + JSON.stringify(rec.excluded)); process.exit(1); }
    if (rec.layout.apps.length !== 3) { console.error("recorded " + rec.layout.apps.length + " apps, want 3"); process.exit(1); }
    fs.writeFileSync(statePath + ".rec", SM.serializeState(SM.upsertLayout(state, rec.layout)));
    fs.renameSync(statePath + ".rec", statePath);
    console.log("  · recorded \"" + rec.layout.topologyKey + "\": " + rec.layout.apps.map(function (a) {
      return a.identityId + " " + a.monitorDescription + " slot " + a.slot; }).sort().join("; "));
  ' "$REPO_ROOT" "$STATE" "$(sb_blocks)"
}

# placement_report [verbose] — compares where each watched window IS with where
# the recorded layout for the CURRENT topology says it should be, both lists
# built and sorted by this one script. A recorded monitor that is not live is
# skipped (monitor-absent) and not counted. Prints "OK <n>" and exits 0 when they
# match, otherwise the two lists and exit 1.
placement_report() {
  HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
    var fs = require("fs"), cp = require("child_process");
    var root = process.argv[1], statePath = process.argv[2], blocksPath = process.argv[3];
    var engine = require(root + "/engine.js"), SM = require(root + "/StateModel.js"), Slots = require(root + "/Slots.js");
    function hc(args) { return JSON.parse(cp.execFileSync("hyprctl", args, { encoding: "utf8" })); }
    var monitors = hc(["monitors", "all", "-j"]), clients = hc(["clients", "-j"]);
    var state = SM.parseState(fs.readFileSync(statePath, "utf8")).state;
    var layout = SM.layoutFor(state, engine.topologyKey(monitors));
    if (!layout) { console.log("no layout recorded for \"" + engine.topologyKey(monitors) + "\""); process.exit(1); }
    var table = Slots.parseBlocks(fs.readFileSync(blocksPath, "utf8"));
    var nameById = {}, i, j;
    for (i = 0; i < monitors.length; i++) nameById[monitors[i].id] = monitors[i].name;
    var want = [], got = [], skipped = [];
    for (i = 0; i < layout.apps.length; i++) {
      var app = layout.apps[i], mon = null;
      for (j = 0; j < monitors.length; j++) {
        if (Slots.isLiveMonitor(monitors[j]) && engine.monitorLabel(monitors[j]) === app.monitorDescription) { mon = monitors[j]; break; }
      }
      if (!mon) { skipped.push(app.identityId + " (monitor-absent)"); continue; }
      var blk = Slots.blockForMonitor(table, mon);
      want.push(app.identityId + " ws " + (blk ? Slots.workspaceIdFor(blk.block, app.slot) : "no-block") + " on " + mon.name);
      var found = null;
      for (j = 0; j < clients.length; j++) if (clients[j].class === app.identityId) { found = clients[j]; break; }
      got.push(app.identityId + " ws " + (found ? found.workspace.id : "absent") + " on " + (found ? nameById[found.monitor] : "-"));
    }
    want.sort(); got.sort();
    var ok = want.length > 0 && want.join("|") === got.join("|");
    if (ok && process.argv[4] !== "verbose") process.exit(0);
    console.log((ok ? "OK " : "MISMATCH ") + want.length + (skipped.length ? " skipped: " + skipped.join(", ") : ""));
    if (!ok) { console.log("   want: " + want.join("; ")); console.log("   got:  " + got.join("; ")); }
    else console.log("   " + want.join("; "));
    process.exit(ok ? 0 : 1);
  ' "$REPO_ROOT" "$STATE" "$(sb_blocks)" "${1:-}"
}
placed() { placement_report >/dev/null; }
placed_count() { placement_report verbose | sed -n 's/^OK \([0-9]*\).*/\1/p'; }

# external_in_own_block — every workspace on $OUTPUT has an id inside the block
# the sandbox block file gives $OUTPUT, and there is at least one.
external_in_own_block() {
  local b; b=$(block_of "$OUTPUT")
  [[ $b =~ ^[0-9]+$ ]] || return 1
  nested workspaces -j | jq -e --arg o "$OUTPUT" --argjson b "$b" '
    [.[]|select(.monitor==$o)|.id] as $ids
    | ($ids|length) > 0 and ($ids|all(. > ($b*10) and . <= ($b*10+10)))' >/dev/null
}
external_ids() { nested workspaces -j | jq -c --arg o "$OUTPUT" '[.[]|select(.monitor==$o)|.id]|sort'; }

merged_empty() { [[ ! -s $MERGED ]]; }

# gate_violations <log text> — the `pass N iteration M:` lines whose nearest
# preceding "reconcile gate:" line did not say ready (or had none). Empty = the
# service never planned before the gate released. Reads stdin-free: text in $1.
gate_violations() {
  awk '
    /reconcile gate: ready/   { gate = "ready"; next }
    /reconcile gate: waiting/ { gate = "waiting"; next }
    /pass [0-9]+ iteration [0-9]+:/ {
      if (gate != "ready") {
        why = (gate == "") ? "no gate line before it" : "gate " gate
        print "line " NR " (" why "): " $0
      }
    }
  ' <<<"$1"
}

# window_for <class> — the window address, or empty.
window_for() { nested clients -j | jq -r --arg c "$1" 'first(.[]|select(.class==$c)|.address)//empty'; }

# launch_on <class> <live workspace id> — a parked, focus-free launch onto that
# workspace, then wait for the window.
launch_on() {
  nested dispatch "hl.dsp.exec_cmd([[ [workspace $2 silent] foot --app-id=$1 ]])" >/dev/null
  poll 20 bash -c "[[ -n \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg c '$1' 'first(.[]|select(.class==\$c)|.address)//empty') ]]"
}

# move_to <class> <live workspace id> [monitor] — the dispatch pair the dock case
# uses, then wait for the window to report that workspace. Moving to a workspace
# that does not exist yet creates it on the FOCUSED monitor, not the block owner
# (measured, tests/nested-notes.md 2026-11-14), so with a monitor named and the
# workspace missing, the new workspace is sent to its owner right after — the
# same two steps the engine's viaMonitor move takes.
move_to() {
  local addr exists; addr=$(window_for "$1")
  [[ -n $addr ]] || return 1
  exists=$(nested workspaces -j | jq -r --argjson w "$2" 'any(.[]; .id==$w)')
  nested dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
  nested dispatch "hl.dsp.window.move({ workspace = \"$2\", follow = false })" >/dev/null
  if [[ -n ${3:-} && $exists == false ]]; then
    nested dispatch "hl.dsp.workspace.move({ workspace = \"$2\", monitor = \"$3\" })" >/dev/null
  fi
  poll 10 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg a '$addr' 'first(.[]|select(.address==\$a)|.workspace.id)//empty') == $2 ]]"
}

output_gone() { [[ -z $(monitor_id "$OUTPUT") ]]; }

# step_checks <label> <docked|undocked> <log mark> — the five assertions for one
# step. Polls for the placement (the service's passes make timing variable),
# then asserts the rest on the settled state.
step_checks() {
  local label="$1" mode="$2" mark="$3" report

  if poll 60 placed; then
    pass "$label — every watched window is on its recorded (monitor, slot): $(placement_report verbose | sed -n 's/^OK \([0-9]*\).*/\1 windows/p')"
    note "$(placement_report verbose | sed -n 's/^   //p')"
  else
    fail "$label — a watched window is not where the record says"
    placement_report | sed 's/^/        /'
    diagnostics
  fi
  [[ $(placed_count) == 3 ]] && pass "$label — all three windows were judged (none skipped as monitor-absent)" \
    || fail "$label — fewer than three windows were judged: $(placement_report verbose | head -1)"

  if [[ $mode == docked ]]; then
    if poll 20 external_in_own_block; then
      pass "$label — $OUTPUT's workspaces $(external_ids) are all in its own block $(block_of "$OUTPUT")"
    else
      fail "$label — $OUTPUT has a workspace outside its own block $(block_of "$OUTPUT"): $(external_ids)"
      nested workspaces -j | jq -c '[.[]|{id,monitor}]'
    fi
    if poll 20 merged_empty; then
      pass "$label — the merged file is empty after the redock"
    else
      fail "$label — the merged file is not empty after the redock"
      sed 's/^/        /' "$MERGED"
    fi
  else
    # Undocked: the external is gone; nothing may be left claiming its block.
    if [[ -z $(nested workspaces -j | jq -r --arg o "$OUTPUT" '.[]|select(.monitor==$o)|.id') ]]; then
      pass "$label — no workspace is left on the removed $OUTPUT"
    else
      fail "$label — workspaces still on the removed $OUTPUT: $(external_ids)"
    fi
  fi

  wait_for_cycle 40 "$CYCLES_BEFORE" || note "warning: $label — no restore cycle completed within 40s"
  # No dispatch before the gate: the lines of THIS step only.
  local slice violations iters
  slice=$(sb_log | tail -n +"$((mark + 1))")
  iters=$(grep -cE 'pass [0-9]+ iteration [0-9]+:' <<<"$slice" || true)
  violations=$(gate_violations "$slice")
  if [[ -n $violations ]]; then
    fail "$label — a dispatch iteration ran before 'reconcile gate: ready'"
    sed 's/^/        /' <<<"$violations"
  elif grep -qF 'reconcile gate: ready' <<<"$slice"; then
    pass "$label — no dispatch precedes 'reconcile gate: ready' ($iters iteration line(s), gate released first)"
  else
    fail "$label — the log has no 'reconcile gate: ready' at all for this step; the gate was not exercised"
  fi
}

# ------------------------------------------------------------------ the record

echo "=== record: laptop topology (undocked) ==="

PRIMARY=$(primary_monitor)
[[ -n $PRIMARY ]] || { echo "FAIL: no primary monitor"; exit 1; }
for app in "${APPS[@]}"; do
  ws=$(expected_ws "$PRIMARY" "${SLOT_PRIMARY[$app]}")
  [[ -n $ws ]] || { echo "FAIL: no block for the primary $PRIMARY in $(sb_blocks)"; exit 1; }
  launch_on "$app" "$ws" || { echo "FAIL: $app never appeared"; exit 1; }
  note "$app launched on ws $ws (primary slot ${SLOT_PRIMARY[$app]})"
done
# Every window where this scenario meant it, before the single recording.
for app in "${APPS[@]}"; do
  ws=$(expected_ws "$PRIMARY" "${SLOT_PRIMARY[$app]}")
  [[ $(nested clients -j | jq -r --arg c "$app" 'first(.[]|select(.class==$c)|.workspace.id)//empty') == "$ws" ]] \
    || move_to "$app" "$ws" || { echo "FAIL: $app is not on ws $ws"; exit 1; }
done
sleep 2
record_current || { echo "FAIL: recording the laptop topology failed"; exit 1; }

echo "=== record: docked topology ==="

nested output create headless "$OUTPUT" >/dev/null
poll 15 monitor_present "$OUTPUT" || { echo "FAIL: $OUTPUT never appeared in the nested instance"; exit 1; }
poll 15 bash -c "[[ -n \$(awk -F'\t' -v c='$OUTPUT' '\$2==c{print \$1}' '$(sb_blocks)') ]]" \
  || { echo "FAIL: monitor-workspaces.lua gave $OUTPUT no block"; cat "$(sb_blocks)"; exit 1; }
sleep 2
for app in "${APPS[@]}"; do
  ws=$(expected_ws "$OUTPUT" "${SLOT_DOCKED[$app]}")
  move_to "$app" "$ws" "$OUTPUT" || { echo "FAIL: $app did not reach ws $ws on $OUTPUT"; diagnostics; exit 1; }
  note "$app moved to ws $ws ($OUTPUT slot ${SLOT_DOCKED[$app]})"
done
sleep 2
record_current || { echo "FAIL: recording the docked topology failed"; diagnostics; exit 1; }

# Both records exist now. Take the output away so the scenario starts UNDOCKED
# and its first step is a real dock. The service restores the laptop record on
# this undock; the settle below is only so the first step starts on a quiet log.
echo "=== setup: undock to the starting state ==="
CYCLES_BEFORE=$(sb_count "restore cycle done")
nested output remove "$OUTPUT" >/dev/null
poll 15 output_gone || { fail "setup — $OUTPUT never went away"; diagnostics; }
poll 60 placed || note "warning: the setup undock did not settle on the laptop record"
# The cycle's own completion marker, not a sleep: a dock that lands while the
# undock cycle is still in its settle passes is a different (racy) scenario.
wait_for_cycle 60 "$CYCLES_BEFORE" || note "warning: the setup undock cycle never logged its completion"
sleep 1

# ------------------------------------------------------------------- the steps

echo "=== step 1: DOCK ==="
mark=$(sb_log | wc -l); CYCLES_BEFORE=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null
step_checks "step 1 DOCK" docked "$mark"

echo "=== step 2: UNDOCK ==="
mark=$(sb_log | wc -l); CYCLES_BEFORE=$(sb_count "restore cycle done")
nested output remove "$OUTPUT" >/dev/null
step_checks "step 2 UNDOCK" undocked "$mark"

echo "=== step 3: DOCK again ==="
mark=$(sb_log | wc -l); CYCLES_BEFORE=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null
step_checks "step 3 REDOCK" docked "$mark"

sandbox_verdict "sandbox-slots"
