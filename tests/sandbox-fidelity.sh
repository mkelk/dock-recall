#!/bin/bash
# sandbox-fidelity.sh — within-workspace fidelity, in the nested compositor
# (Tier B). The fidelity epic: does a restore put the windows of ONE workspace back where
# they were — the tiling tree, the tab group beside a tiled window, the visible
# tab — and does it say so out loud where it cannot?
#
# Each case is a probe of the grouping probes turned into asserted PASS/FAIL lines. The
# nested compositor carries Omarchy's own dwindle settings (tests/nested.lua), so
# the trees built here are the ones a real Omarchy desk builds.
#
#   Q   four windows, an unambiguous tree, a dragged inner divider: IoU >= 0.95
#       after a scatter and after an in-place drag
#   F   two windows, one togglesplit: >= 0.95 both ways
#   G2  tab group ga,gc,gb beside tiled gd: >= 0.95 after a scatter AND after an
#       in-place swap; group order kept; no 'not-a-tree' line for the workspace.
#       The in-place step first ASSERTS the swap moved the rects (IoU < 0.5): the
#       probe's swap silently repaired the desk and proved nothing.
#   A   active tab gb recorded: gb is the visible tab after scatter + restore;
#       after switching to gc in place the ENGINE (driftOf, run in node against
#       the nested instance) reports drift.activeTab for gb — asked of the engine
#       and not of the status file, because a tab switch raises no drift event and
#       the status only catches up at the 30 s slow poll — and gb is visible again
#       after restore
#   T   three stacked rows, a dragged divider: >= 0.95 after a scatter
#   S   workspace rule layout=scrolling: the windows are on the workspace after a
#       scatter with no split / swap / divider op planned; then a column resized
#       in place: the log names the refusal 'layout-scrolling', no tiled op is
#       planned, and the disturbed rects are left exactly as they are
#   V   three columns built by hand, a divider dragged in place, a triggered
#       restore that dispatches nothing for the workspace; the status file then
#       carries shapeCount >= 1 with reason ambiguous-tree
#
# All seven pass, in one invocation, with no argument: there is no expected-red
# allowance. The nested output is pinned at a fixed size by sandbox_up
# (tests/sandbox-lib.sh), so every case runs on the same aspect whatever the live
# desk is doing. Debt 1 (an unplaceable recorded entry must not claim a window a
# placeable one could take) is not staged here: it needs a monitor the slot table
# leaves unassigned, and monitor-workspaces.lua gives every nested output a
# block. tests/restore.test.js pins it in node.
#
# Usage: tests/sandbox-fidelity.sh              every case, in the order above
#        tests/sandbox-fidelity.sh Q F          just those, one sandbox
#        DR_SANDBOX_KEEP=1 tests/sandbox-fidelity.sh G2   keep the sandbox dir
#
# One at a time, like every sandbox run — the library's flock says so.

set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-lib.sh"

ALL_CASES=(Q F G2 A T S V)
CASES=("$@")
(( ${#CASES[@]} )) || CASES=("${ALL_CASES[@]}")
for c in "${CASES[@]}"; do
  [[ " ${ALL_CASES[*]} " == *" $c "* ]] || { echo "FAIL: unknown case '$c' (cases: ${ALL_CASES[*]})"; exit 2; }
done

# One class per window per case, so a case never finds another case's window.
APPS=(dr-qa dr-qb dr-qc dr-qd dr-fa dr-fb dr-ga dr-gb dr-gc dr-gd dr-aa dr-ab dr-ac
      dr-ta dr-tb dr-tc dr-sa dr-sb dr-sc dr-va dr-vb dr-vc)
APP_ID="dr-qa"                 # the footer's stray-window check reads this one

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

STATUS="$SBOX/home/.local/state/omarchy/dock-recall.status.json"
TMPD=$(mktemp -d)
HOME_WS=$(ws 1)       # the unwatched focus anchor lives here, away from every case
SCRATCH=$(ws 9)       # where a scatter throws the windows

launch dr-anchor "$HOME_WS"
ANCHOR=$(addr_of dr-anchor)
note "dwindle force_split $(nested getoption dwindle:force_split -j 2>/dev/null | jq -c .) (from tests/nested.lua)"

# ---------------------------------------------------------------- the tools

# clear_desk — close every watched window the previous case left, so the next
# case records a desktop of its own and nothing else.
clear_desk() {
  local a
  for a in $(nested clients -j | jq -r '.[]|select(.class|test("^dr-[a-z]{2}$"))|.address'); do
    d "hl.dsp.window.close({ window = \"address:$a\" })" >/dev/null
  done
  poll 15 bash -c "[[ -z \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r '.[]|select(.class|test(\"^dr-[a-z]{2}\$\"))|.address') ]]" \
    || note "WARN: windows of the previous case are still open"
  sleep 0.5
}

# build_spine <ws> <a> <b> ...  — each window splits the one before it, the way
# a user opening the next window beside the one in hand does. Launched on the
# scratch workspace and moved with the previous window focused, so the tree does
# not depend on where the launch happened to land.
build_spine() {
  local w=$1 prev="" cls a
  shift
  for cls in "$@"; do
    if [[ -z $prev ]]; then
      launch "$cls" "$w"
      prev=$(addr_of "$cls")
    else
      launch "$cls" "$SCRATCH"
      a=$(addr_of "$cls")
      focus "$prev"
      mv_ws "$a" "$w"
      prev=$a
    fi
  done
  focus "$ANCHOR"
  sleep 0.3
}

# make_shape <ws> col|row <class...> — flip splits (the inner one, the root, the
# inner one again: all four orientations of a three-window spine) until every
# window shares a column (col) or a row (row).
shape_ok() {   # shape_ok <ws> col|row
  local f='.at[0]'; [[ $2 == row ]] && f='.at[1]'
  [[ $(nested clients -j | jq -r --argjson w "$1" "[.[]|select(.workspace.id==\$w and (.class|test(\"^dr-[a-z]{2}\$\")))|$f]|unique|length") == 1 ]]
}
make_shape() {
  local w=$1 want=$2 first=$3 last=${*: -1} step
  shift 2
  for step in "$last" "$first" "$last"; do
    shape_ok "$w" "$want" && break
    focus "$(addr_of "$step")"; d 'hl.dsp.layout("togglesplit")' >/dev/null; sleep 0.3
  done
  focus "$ANCHOR"; sleep 0.3
  shape_ok "$w" "$want"
}

# spans_top <ws> <class> — the class is the workspace's whole top row: at the
# top edge, and as wide as every tile of the workspace taken together.
spans_top() {
  nested clients -j | jq -e --argjson w "$1" --arg c "$2" '
    [.[]|select(.workspace.id==$w and (.class|test("^dr-[a-z]{2}$")))] as $t
    | ($t|map(.at[0])|min) as $l | ($t|map(.at[0]+.size[0])|max) as $r
    | ($t|map(.at[1])|min) as $top
    | first($t[]|select(.class==$c)) | .at[0]==$l and .at[0]+.size[0]==$r and .at[1]==$top' >/dev/null
}

# resize_to <class> <w> <h> — an absolute size, the way dragging a divider ends.
resize_to() {
  local a; a=$(addr_of "$1")
  d "hl.dsp.window.resize({ window = \"address:$a\", x = $2, y = $3 })" >/dev/null
  sleep 0.3
}
size_of() { nested clients -j | jq -r --arg c "$1" 'first(.[]|select(.class==$c)|.size|"\(.[0]) \(.[1])")'; }

# scatter <ws> <class...> — throw the windows to the scratch workspace, in the
# order given (so they come back in a different one).
scatter() {
  local cls
  shift
  for cls in "$@"; do mv_ws "$(addr_of "$cls")" "$SCRATCH"; done
  sleep 0.5
}

# check_iou <label> <ws> <saved-file> — PASS when the workspace is back to >= 0.95.
check_iou() {
  iou_report "$1" "$2" "$3"
  if awk -v v="$IOU_LAST" 'BEGIN { exit !(v >= 0.95) }'; then
    pass "$1: mean IoU $IOU_LAST >= 0.95"
  else
    fail "$1: mean IoU $IOU_LAST < 0.95"
  fi
}

# assert_moved <label> <ws> <saved-file> <ceiling> — the in-place step must have
# CHANGED the desk, or the restore that follows proves nothing.
assert_moved() {
  iou_report "$1 (before the restore)" "$2" "$3"
  if awk -v v="$IOU_LAST" -v c="$4" 'BEGIN { exit !(v < c) }'; then
    pass "$1: the in-place step moved the rects (IoU $IOU_LAST < $4)"
    return 0
  fi
  fail "$1: the in-place step left the rects where they were (IoU $IOU_LAST >= $4) — the restore after it would prove nothing"
  return 1
}

# case_log — the sandbox log since the case began.
case_log() { sb_log | tail -n +"$((CASE_MARK + 1))"; }

# case_begin <name> — a quiet desk and a log mark.
case_begin() {
  echo "=== case $1 ==="
  clear_desk
  CASE_MARK=$(sb_log | wc -l)
}

# ------------------------------------------------------------------ cases

case_Q() {
  case_begin "Q: 4-window tree, dragged inner divider"
  local W; W=$(ws 2)
  build_spine "$W" dr-qa dr-qb dr-qc dr-qd
  # The spine's shape follows the nested output's aspect: on a narrow one it is
  # qa over (qb | (qc / qd)), on a wide one three columns qa | qb | (qc / qd),
  # which fit two trees — the in-place half would then be refused as
  # ambiguous-tree, and qb's height (the whole column) would not even move. The
  # output is pinned now, but the case still flips the root until qa is the top
  # row, so it does not depend on which aspect the pin is set to.
  spans_top "$W" dr-qa || { focus "$(addr_of dr-qa)"; d 'hl.dsp.layout("togglesplit")' >/dev/null; focus "$ANCHOR"; sleep 0.3; }
  spans_top "$W" dr-qa \
    && pass "Q: qa spans the top row, over qb | (qc / qd)" \
    || fail "Q: the scenario did not build qa over qb | (qc / qd)"
  read -r QW QH <<<"$(size_of dr-qb)"
  resize_to dr-qb "$QW" $(( QH * 3 / 4 ))
  rects "$W" | sed 's/^/      /'
  save_rects "$W" "$TMPD/q"
  record_current; restore
  scatter "$W" dr-qd dr-qb dr-qa dr-qc
  restore
  rects "$W" | sed 's/^/      /'
  check_iou "Q after scatter" "$W" "$TMPD/q"
  # in place: the user drags the same divider somewhere else
  read -r QW QH <<<"$(size_of dr-qb)"
  resize_to dr-qb "$QW" $(( QH / 2 ))
  assert_moved "Q" "$W" "$TMPD/q" 0.95 && { restore; check_iou "Q after in-place drag" "$W" "$TMPD/q"; }
}

case_F() {
  case_begin "F: two windows, one togglesplit"
  local W; W=$(ws 3)
  build_spine "$W" dr-fa dr-fb
  focus "$(addr_of dr-fb)"; d 'hl.dsp.layout("togglesplit")' >/dev/null; focus "$ANCHOR"; sleep 0.3
  rects "$W" | sed 's/^/      /'
  save_rects "$W" "$TMPD/f"
  record_current; restore
  scatter "$W" dr-fb dr-fa
  restore
  rects "$W" | sed 's/^/      /'
  check_iou "F after scatter" "$W" "$TMPD/f"
  focus "$(addr_of dr-fb)"; d 'hl.dsp.layout("togglesplit")' >/dev/null; focus "$ANCHOR"; sleep 0.3
  assert_moved "F" "$W" "$TMPD/f" 0.95 && { restore; check_iou "F after in-place flip" "$W" "$TMPD/f"; }
}

# A group of three beside a tiled window; the tab order, the visible tab and the
# group's place are what the cases read. build_group <ws> <a> <b> <c> — the
# classes join in that order; sets GA GB GC.
#
# The member chain (tests/nested-notes.md, fidelity facts (e)): each member arrives on the
# workspace with its predecessor focused, so it splits exactly that tile, and the
# joins run in tab order — every joiner is then next to the group whatever the
# nested output's aspect. Three silent launches tile by the output's shape, and
# on a wide output the second member landed beside the third, not the group: it
# never joined, and G2 recorded a group of two beside two tiles.
build_group() {
  local w=$1
  build_spine "$w" "$2" "$3" "$4"
  GA=$(addr_of "$2"); GB=$(addr_of "$3"); GC=$(addr_of "$4")
  d "hl.dsp.group.toggle({ window = \"address:$GA\" })" >/dev/null
  join "$GB" "$GA" "$GA" || fail "build_group: $3 did not join the group — the scenario did not build what it says"
  join "$GC" "$GB" "$GA" || fail "build_group: $4 did not join the group — the scenario did not build what it says"
}

case_G2() {
  case_begin "G2: group ga,gc,gb beside tiled gd"
  local W; W=$(ws 4)
  # The groupbar is taller than the desk's 22px and the constant's guess: the
  # swap read-back must take the height from hyprctl, or the group's tile box
  # reads ~11px off and the swap is called a miss.
  nested eval "hl.config({ group = { groupbar = { height = 33 } } })" >/dev/null 2>&1; sleep 0.4
  local gbh; gbh=$(nested getoption group:groupbar:height -j | jq -r '.int // "absent"')
  [[ $gbh == 33 ]] \
    && pass "G2: the nested groupbar height now reads 33 through hyprctl getoption" \
    || fail "G2: could not override group:groupbar:height (getoption says '$gbh')"
  build_group "$W" dr-ga dr-gc dr-gb     # tab order ga,gc,gb
  focus "$ANCHOR"
  launch dr-gd "$SCRATCH"; local GD; GD=$(addr_of dr-gd)
  mv_ws "$GD" "$W"; sleep 0.4
  # unequal tiles, so that swapping them is something the rects can show: shrink
  # gd along the axis that separates it from the group — side by side when the
  # two tiles start at different x, stacked otherwise. Read off the rects, not
  # guessed from gd's size: the nested output is as wide as the live desk made
  # the parked window, and a shrink along the shared axis moves nothing.
  read -r DW DH <<<"$(size_of dr-gd)"
  local gx dx
  gx=$(nested clients -j | jq -r --arg a "$GA" 'first(.[]|select(.address==$a)|.at[0])')
  dx=$(nested clients -j | jq -r --arg a "$GD" 'first(.[]|select(.address==$a)|.at[0])')
  if [[ $gx != "$dx" ]]; then resize_to dr-gd $(( DW * 3 / 10 )) "$DH"; else resize_to dr-gd "$DW" $(( DH * 3 / 10 )); fi
  focus "$ANCHOR"; sleep 0.4
  rects "$W" | sed 's/^/      /'
  local order; order=$(group_order "$GA")
  note "group order recorded: $order"
  save_rects "$W" "$TMPD/g"
  record_current; restore
  d "hl.dsp.group.toggle({ window = \"address:$GA\" })" >/dev/null; sleep 0.3
  scatter "$W" dr-gb dr-gd dr-ga dr-gc
  restore
  rects "$W" | sed 's/^/      /'
  check_iou "G2 after scatter" "$W" "$TMPD/g"
  [[ $(group_order "$GA") == "$order" ]] \
    && pass "G2 group order kept after scatter ($order)" \
    || fail "G2 group order after scatter is '$(group_order "$GA")', recorded '$order'"
  # in place: SUPER+SHIFT swap of gd and the group
  d "hl.dsp.window.swap({ window = \"address:$GD\", target = \"address:$GA\" })" >/dev/null
  sleep 0.5
  rects "$W" | sed 's/^/      /'
  if assert_moved "G2 swap" "$W" "$TMPD/g" 0.5; then
    restore
    rects "$W" | sed 's/^/      /'
    check_iou "G2 after in-place swap" "$W" "$TMPD/g"
    [[ $(group_order "$GA") == "$order" ]] \
      && pass "G2 group order kept after in-place swap ($order)" \
      || fail "G2 group order after the swap restore is '$(group_order "$GA")', recorded '$order'"
  fi
  grep -qE "groupbar height 33px \(read from hyprctl\)" <<<"$(case_log)" \
    && pass "G2: the service read the groupbar height (33px) from hyprctl" \
    || fail "G2: no 'groupbar height 33px' line in the cycle's log"
  if grep -qE "swap did not land|swap: .* reads .* after the swap" <<<"$(case_log)"; then
    fail "G2: the swap read-back called a landed swap a miss"
    case_log | grep -E "swap did not land|after the swap" | sed 's/^/        /'
  else
    pass "G2: the swap read-back accepted the swap against the real groupbar"
  fi
  if case_log | grep -qE "REFUSED workspace $W .*not-a-tree"; then
    fail "G2: the log refuses workspace $W as not-a-tree"
    case_log | grep -E "REFUSED workspace $W " | sed 's/^/        /'
  else
    pass "G2: no not-a-tree refusal for workspace $W"
  fi
}

# visible_tab <ws> — the class of the visible member of the workspace's group.
# `visible` is the field the engine's activeTabOf reads (planner-output §2.2);
# the H2 probe may name another, and this is the one place to change.
visible_tab() {
  nested clients -j | jq -r --argjson w "$1" \
    '[.[]|select(.workspace.id==$w and (.grouped|length)>1 and .visible==true)|.class]|join(",")'
}

# drift_active_tab <class> — ask the ENGINE whether <class>'s record is drifted on
# the active tab: driftOf against the nested instance, handed the workspaces
# context. Prints true / false / null (the field absent).
drift_active_tab() {
  HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
    var fs = require("fs"), cp = require("child_process");
    var root = process.argv[1], statePath = process.argv[2], blocksPath = process.argv[3], want = process.argv[4];
    var engine = require(root + "/engine.js"), SM = require(root + "/StateModel.js"), Slots = require(root + "/Slots.js");
    function hc(args) { return JSON.parse(cp.execFileSync("hyprctl", args, { encoding: "utf8" })); }
    var monitors = hc(["monitors", "all", "-j"]), clients = hc(["clients", "-j"]), workspaces = hc(["workspaces", "-j"]);
    var state = SM.parseState(fs.readFileSync(statePath, "utf8")).state;
    var key = engine.topologyKey(monitors);
    var table = Slots.parseBlocks(fs.readFileSync(blocksPath, "utf8"));
    var layout = Slots.toLive(SM.layoutFor(state, key), table, monitors);
    var report = engine.driftOf(clients, monitors, layout, state.identities, { workspaces: workspaces, built: null });
    var row = report.apps.filter(function (a) { return a.identityId === want; })[0];
    var v = row && row.drift ? row.drift.activeTab : undefined;
    console.log(v === undefined ? "null" : String(v));
  ' "$REPO_ROOT" "$STATE" "$(sb_blocks)" "$1"
}

case_A() {
  case_begin "A: the recorded active tab"
  local W; W=$(ws 5)
  build_group "$W" dr-aa dr-ab dr-ac     # tab order aa,ab,ac
  focus "$GB"; focus "$ANCHOR"; sleep 0.3   # the visible tab becomes ab
  rects "$W" | sed 's/^/      /'
  [[ $(visible_tab "$W") == "dr-ab" ]] \
    && pass "A: ab is the visible tab when recorded" \
    || fail "A: the visible tab is '$(visible_tab "$W")' when recording, wanted dr-ab — the scenario did not build what it says"
  record_current; restore
  d "hl.dsp.group.toggle({ window = \"address:$GA\" })" >/dev/null; sleep 0.3
  scatter "$W" dr-ac dr-aa dr-ab
  restore
  rects "$W" | sed 's/^/      /'
  [[ $(visible_tab "$W") == "dr-ab" ]] \
    && pass "A: ab is the visible tab after scatter + restore" \
    || fail "A: the visible tab after scatter + restore is '$(visible_tab "$W")', recorded dr-ab"
  # in place: the user clicks the gc tab
  focus "$GC"; focus "$ANCHOR"; sleep 0.3
  [[ $(visible_tab "$W") == "dr-ac" ]] \
    && pass "A: switching in place made ac the visible tab" \
    || fail "A: the in-place switch left '$(visible_tab "$W")' visible, wanted dr-ac"
  local verdict; verdict=$(drift_active_tab dr-ab)
  [[ $verdict == "true" ]] \
    && pass "A: engine.driftOf reports drift.activeTab for ab" \
    || fail "A: engine.driftOf drift.activeTab for ab is $verdict, wanted true"
  restore
  [[ $(visible_tab "$W") == "dr-ab" ]] \
    && pass "A: ab is visible again after the in-place restore" \
    || fail "A: after the in-place restore the visible tab is '$(visible_tab "$W")', recorded dr-ab"
}

case_T() {
  case_begin "T: three stacked rows, dragged divider"
  local W; W=$(ws 6)
  build_spine "$W" dr-ta dr-tb dr-tc
  make_shape "$W" col dr-ta dr-tb dr-tc \
    && pass "T: the three windows are stacked in one column" \
    || fail "T: the scenario did not build three stacked rows"
  read -r TW TH <<<"$(size_of dr-tb)"
  resize_to dr-tb "$TW" $(( TH * 3 / 2 ))
  rects "$W" | sed 's/^/      /'
  save_rects "$W" "$TMPD/t"
  record_current; restore
  scatter "$W" dr-tc dr-ta dr-tb
  restore
  rects "$W" | sed 's/^/      /'
  check_iou "T after scatter" "$W" "$TMPD/t"
}

case_S() {
  case_begin "S: scrolling layout rule"
  local W; W=$(ws 7)
  note "rule: $(nested eval "hl.workspace_rule({ workspace = \"$W\", layout = \"scrolling\" })" 2>&1)"
  build_spine "$W" dr-sa dr-sb dr-sc
  note "workspace $W tiledLayout=$(layout_of "$W")"
  rects "$W" | sed 's/^/      /'
  record_current; restore
  save_rects "$W" "$TMPD/s"
  scatter "$W" dr-sc dr-sa dr-sb
  restore
  rects "$W" | sed 's/^/      /'
  local n; n=$(nested clients -j | jq -r --argjson w "$W" '[.[]|select(.workspace.id==$w and (.class|test("^dr-s[abc]$")))]|length')
  [[ $n == 3 ]] \
    && pass "S: all three windows are back on workspace $W" \
    || fail "S: $n of 3 windows are on workspace $W after the restore"
  local plan; plan=$(echo "$RESTORE_LOG" | grep -E "pass [0-9]+ iteration [0-9]+: [0-9]+ ops — " | grep -E "split|swap|divider")
  [[ -z $plan ]] \
    && pass "S: the cycle's plan lines carry no split / swap / divider op" \
    || { fail "S: the cycle planned a tiling op for a scrolling workspace"; echo "$plan" | sed 's/^/        /'; }

  # In place: a column resized by hand. Scrolling puts the windows back exactly
  # after a scatter, so the workspace is SETTLED there and a refusal is not news
  # (the settled gate). Disturbed, it is finished and unsettled: the refusal is
  # named, and the restore leaves the disturbed rects exactly as they are.
  read -r SW SH <<<"$(size_of dr-sb)"
  resize_to dr-sb $(( SW * 3 / 2 )) "$SH"
  rects "$W" | sed 's/^/      /'
  assert_moved "S resize" "$W" "$TMPD/s" 0.95
  save_rects "$W" "$TMPD/s2"
  restore
  rects "$W" | sed 's/^/      /'
  echo "$RESTORE_LOG" | grep -qE "REFUSED workspace $W .*layout-scrolling" \
    && pass "S: the log names the refusal layout-scrolling for workspace $W" \
    || fail "S: no 'layout-scrolling' refusal for workspace $W in the cycle's log"
  plan=$(echo "$RESTORE_LOG" | grep -E "pass [0-9]+ iteration [0-9]+: [0-9]+ ops — " | grep -E "split|swap|divider")
  [[ -z $plan ]] \
    && pass "S: the in-place cycle's plan lines carry no split / swap / divider op" \
    || { fail "S: the in-place cycle planned a tiling op for a scrolling workspace"; echo "$plan" | sed 's/^/        /'; }
  iou_report "S after the in-place restore" "$W" "$TMPD/s2"
  if awk -v v="$IOU_LAST" 'BEGIN { exit !(v >= 0.99) }'; then
    pass "S: the in-place restore left the disturbed rects unchanged (IoU $IOU_LAST)"
  else
    fail "S: the in-place restore moved windows on a scrolling workspace (IoU $IOU_LAST)"
  fi
}

case_V() {
  case_begin "V: three columns by hand, an ambiguous tree"
  local W; W=$(ws 8)
  build_spine "$W" dr-va dr-vb dr-vc
  make_shape "$W" row dr-va dr-vb dr-vc \
    && pass "V: the three windows stand side by side in one row" \
    || fail "V: the scenario did not build three columns"
  record_current
  # the user drags a divider by hand
  read -r VW VH <<<"$(size_of dr-vb)"
  resize_to dr-vb $(( VW * 3 / 2 )) "$VH"
  rects "$W" | sed 's/^/      /'
  save_rects "$W" "$TMPD/v"
  restore
  rects "$W" | sed 's/^/      /'
  iou_report "V after restore" "$W" "$TMPD/v"
  if awk -v v="$IOU_LAST" 'BEGIN { exit !(v >= 0.99) }'; then
    pass "V: the restore dispatched nothing for workspace $W (rects untouched, IoU $IOU_LAST)"
  else
    fail "V: the restore moved windows on a workspace whose tree is ambiguous (IoU $IOU_LAST)"
  fi
  local plan; plan=$(echo "$RESTORE_LOG" | grep -E "pass [0-9]+ iteration [0-9]+: [0-9]+ ops — " | grep -E "split|swap|divider")
  [[ -z $plan ]] \
    && pass "V: the cycle's plan lines carry no split / swap / divider op" \
    || { fail "V: the cycle planned a tiling op"; echo "$plan" | sed 's/^/        /'; }
  # the unmet shape reaches the status file, with its reason
  poll 15 bash -c "[[ \$(jq -r '.shapeCount // 0' '$STATUS' 2>/dev/null) -ge 1 ]]" || true
  local count reason
  count=$(jq -r '.shapeCount // "absent"' "$STATUS" 2>/dev/null)
  reason=$(jq -r --argjson w "$W" 'first((.shapes // [])[]|select(.workspaceId==$w)|.reason)//"absent"' "$STATUS" 2>/dev/null)
  note "status: shapeCount=$count, reason for workspace $W: $reason"
  [[ $count =~ ^[0-9]+$ ]] && (( count >= 1 )) && [[ $reason == "ambiguous-tree" ]] \
    && pass "V: the status file carries shapeCount $count with reason ambiguous-tree" \
    || fail "V: the status file has shapeCount '$count' and reason '$reason', wanted shapeCount >= 1 with ambiguous-tree"
}

for c in "${CASES[@]}"; do "case_$c"; done

rm -rf "$TMPD"
sandbox_verdict "sandbox-fidelity"
