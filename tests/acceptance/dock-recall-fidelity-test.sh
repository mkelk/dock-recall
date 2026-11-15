#!/bin/bash
# dock-recall-fidelity-test.sh — within-workspace fidelity on a real Omarchy 4.5
# install (Tier C, epic 9i2).
#
# The sandbox (tests/sandbox-fidelity.sh) proves the engine and the service
# against Hyprland under Omarchy's dwindle settings. What it cannot have is
# Omarchy's OWN workspace modes: a workspace switched to scrolling or floating by
# omarchy-hyprland-workspace-layout-toggle, with the layout rules, tags and
# open rules that come with it. This test runs the same shapes on the real thing:
#
#   G  a tab group (tab order ga,gc,gb, the VISIBLE tab gc — not tab 0) beside a
#      tiled window, unequal tiles: after a scatter and a restore the group tile
#      is back (IoU >= 0.95), the visible tab is gc, the tab order is kept
#   T  three stacked rows with a dragged divider: IoU >= 0.95 after a scatter
#   S  a workspace switched to scrolling by Omarchy's own toggle: the windows
#      come back to it, the restore plans NO split / swap / divider op, and once
#      a column is resized in place the log names the refusal layout-scrolling
#      and leaves the disturbed rects alone
#   F  a workspace switched to floating by the same toggle, one window floating
#      at a known rect: scattered off it, the restore puts it back on the
#      workspace, floating, at that rect (IoU >= 0.95)
#
# Every shape is built by READING rects, never by assuming them: the VM's output
# is not the sandbox's, and the dwindle spine of N windows follows its aspect.
# Every in-place disturbance first ASSERTS it moved the rects — a restore that
# follows a disturbance which did nothing proves nothing.
#
# The layout is recorded the way the panel records it: the engine builds it from
# the live desk (handed the workspaces context) and Slots/StateModel write it,
# atomically. The restore is triggered through the trigger file. Workspace ids
# are never typed: dr_ws_id computes them from the monitor's block.
#
# Windows are foot terminals, one app-id per window, so no case finds another's.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"
TRIGGER="$STATE_DIR/dock-recall.trigger"
BLOCKS="$STATE_DIR/monitor-workspaces"
MODES_DIR="$STATE_DIR/workspace-layouts"

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# One class per window per case.
APPS=(dr-ga dr-gb dr-gc dr-gd dr-ta dr-tb dr-tc dr-sa dr-sb dr-sc dr-fa)

# Slots on the primary monitor; ids are computed (dr_ws_id), never typed.
SLOT_GROUP=2
SLOT_ROWS=3
SLOT_SCROLL=4
SLOT_FLOAT=5
SLOT_HOME=1
SLOT_SCRATCH=9

PRIMARY=
HOME_WS=
SCRATCH=
ANCHOR=
TMPD=$(mktemp -d)
MODE_WORKSPACES=()     # workspaces this test switched, so cleanup puts them back

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }

dr_ws_id() {
  local connector="${1:-}" slot="${2:-}" block
  [[ -n $connector && $slot =~ ^([1-9]|10)$ ]] || {
    echo "dr_ws_id: usage: dr_ws_id <connector> <slot 1..10> (got '$connector' '$slot')" >&2
    return 2
  }
  block=$(awk -F'\t' -v c="$connector" '$2 == c && $1 ~ /^[0-9]+$/ { print $1; exit }' "$BLOCKS" 2>/dev/null)
  [[ $block =~ ^[0-9]+$ ]] || {
    echo "dr_ws_id: no monitor-workspaces row for '$connector'" >&2
    return 1
  }
  echo $((10#$block * 10 + slot))
}

poll() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

as_root() { echo "$GUEST_PASSWORD" | sudo -S "$@" 2>/dev/null; }
ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

# A deeper tail than the sibling tests use: a case's log slice is taken by line
# count, and a window that slides past the cycle's first line would lose it.
dr_log() {
  qs log -p "${OMARCHY_PATH:-/usr/share/omarchy}/shell" --tail 100000 2>/dev/null |
    sed 's/\x1b\[[0-9;]*m//g' | grep -F "[dock-recall]"
}
service_ready() { dr_log | grep -qF "service-ready"; }
plugin_state() {
  omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id { print $2 }'
}
plugin_known() { [[ -n $(plugin_state) ]]; }
cycles_done() { dr_log | grep -cF "restore cycle done" || true; }

capture_service_log() { dr_log > "$ARTIFACTS/dock-recall-fidelity-service.log" 2>/dev/null || true; }

d() { local out; out=$(hyprctl dispatch "$1" 2>&1); echo "${out:-<empty>}"; }
trigger() { date +%s.%N > "$TRIGGER"; }   # content must CHANGE; a bare touch is ignored

addr_of() { clients | jq -r --arg c "$1" 'first(.[]|select(.class==$c)|.address)//empty'; }
cls_of()  { clients | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.class)//empty'; }
focus()   { d "hl.dsp.focus({ window = \"address:$1\" })" >/dev/null; sleep 0.2; }
mv_ws()   { d "hl.dsp.window.move({ window = \"address:$1\", workspace = \"$2\", follow = false })" >/dev/null; sleep 0.3; }
ws()      { dr_ws_id "$PRIMARY" "$1"; }
size_of() { clients | jq -r --arg c "$1" 'first(.[]|select(.class==$c)|.size|"\(.[0]) \(.[1])")'; }

launch() {   # launch <class> <ws>
  d "hl.dsp.exec_cmd([[ [workspace $2 silent] foot --app-id=$1 ]])" >/dev/null
  poll 30 bash -c "[[ -n \$(hyprctl clients -j | jq -r --arg c '$1' 'first(.[]|select(.class==\$c)|.address)//empty') ]]"
  sleep 0.4
}

rects() {
  clients | jq -r --argjson w "$1" '
    (map({key:.address, value:.class})|from_entries) as $c
    | [.[]|select(.workspace.id==$w)] | sort_by(.at[0], .at[1], .class)[]
    | "\(.class) at=\(.at|join(",")) size=\(.size|join("x")) float=\(.floating) hidden=\(.hidden|tostring) visible=\(.visible|tostring) grouped=[\(.grouped|map($c[.])|join(","))]"'
}
show_rects() { rects "$1" | sed 's/^/      /'; }

diagnostics() {
  echo "--- monitors ---" >&2
  hyprctl monitors all -j | jq -c '[.[]|{id,name,width,height,scale}]' >&2
  echo "--- workspaces ---" >&2
  hyprctl workspaces -j | jq -c '[.[]|{id,tiledLayout,windows}]' >&2
  echo "--- watched windows ---" >&2
  clients | jq -c '[.[]|select(.class|test("^dr-"))|{class,workspace:.workspace.id,at,size,floating,grouped:(.grouped|length),visible}]' >&2
  echo "--- state file ---" >&2
  head -c 3000 "$STATE" 2>/dev/null >&2
  echo "--- [dock-recall] log ---" >&2
  dr_log | tail -40 >&2
  capture_service_log
}

# Every assertion goes through here, so a failure always carries the desk and
# the service's own account of the cycle before the run aborts.
must() {   # must <description> <detail> <command...>
  local description="$1" detail="$2"
  shift 2
  if "$@"; then
    pass "$description"
  else
    diagnostics
    fail "$description" "$detail"
  fi
}

cleanup() {
  local status=$?
  set +e
  local a
  for a in $(clients | jq -r '.[]|select(.class|test("^dr-"))|.address' 2>/dev/null); do
    hyprctl dispatch "hl.dsp.window.close({ window = \"address:$a\" })" >/dev/null 2>&1
  done
  sleep 1
  # Put every workspace this test switched back on the default mode, the way
  # Omarchy's own toggle does when it cycles onto the default.
  local w
  for w in "${MODE_WORKSPACES[@]}"; do
    hyprctl eval "o.workspace_mode({ workspace = \"$w\", mode = \"dwindle\" })" >/dev/null 2>&1
    rm -f "$MODES_DIR/$w.lua"
  done
  rm -rf "$TMPD"
  return $status
}
trap cleanup EXIT

# ----------------------------------------------------------- shape tooling

clear_desk() {
  local a
  for a in $(clients | jq -r '.[]|select(.class|test("^dr-[a-z]{2}$"))|.address'); do
    d "hl.dsp.window.close({ window = \"address:$a\" })" >/dev/null
  done
  poll 20 bash -c "[[ -z \$(hyprctl clients -j | jq -r '.[]|select(.class|test(\"^dr-[a-z]{2}\$\"))|.address') ]]" ||
    echo "note: windows of the previous case are still open"
  sleep 0.5
}

# build_spine <ws> <a> <b> ... — each window splits the one before it. Launched
# on the scratch workspace and moved with the previous window focused, so the
# tree does not depend on where the launch happened to land.
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
  sleep 0.4
}

# shape_ok <ws> col|row — every window of the workspace shares one column (col)
# or one row (row). make_shape flips splits until they do.
shape_ok() {
  local f='.at[0]'; [[ $2 == row ]] && f='.at[1]'
  [[ $(clients | jq -r --argjson w "$1" "[.[]|select(.workspace.id==\$w and (.class|test(\"^dr-[a-z]{2}\$\")))|$f]|unique|length") == 1 ]]
}
make_shape() {
  local w=$1 want=$2 first=$3 last=${*: -1} step
  shift 2
  for step in "$last" "$first" "$last"; do
    shape_ok "$w" "$want" && break
    focus "$(addr_of "$step")"; d 'hl.dsp.layout("togglesplit")' >/dev/null; sleep 0.4
  done
  focus "$ANCHOR"; sleep 0.4
  shape_ok "$w" "$want"
}

# resize_to <class> <w> <h> — an absolute size, the way dragging a divider ends.
resize_to() {
  local a; a=$(addr_of "$1")
  d "hl.dsp.window.resize({ window = \"address:$a\", x = $2, y = $3 })" >/dev/null
  sleep 0.4
}

# join <addr> <pred> <leader> — put a window into the group <leader> leads, by
# trying each side of <pred> (a member of the group) until it lands.
join() {
  local dir
  for dir in left right up down; do
    focus "$2"; focus "$1"
    d "hl.dsp.window.move({ into_group = \"$dir\" })" >/dev/null; sleep 0.3
    clients | jq -e --arg a "$1" --arg g "$3" 'first(.[]|select(.address==$a)|.grouped|index($g))!=null' >/dev/null && return 0
  done
  return 1
}
group_order() { clients | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.grouped)|.[]' | while read -r x; do cls_of "$x"; done | paste -sd,; }

# visible_tab <ws> — the class of the visible member of the workspace's group.
visible_tab() {
  clients | jq -r --argjson w "$1" \
    '[.[]|select(.workspace.id==$w and (.grouped|length)>1 and .visible==true)|.class]|join(",")'
}

# scatter <ws> <class...> — throw the windows to the scratch workspace, in the
# order given (so they come back in a different one).
scatter() {
  local cls
  shift
  for cls in "$@"; do mv_ws "$(addr_of "$cls")" "$SCRATCH"; done
  sleep 1
}

# save_rects <ws> <file>; iou_report <label> <ws> <file> — mean IoU now against
# the saved rects, by class (a window that is gone scores 0). Number in IOU_LAST.
save_rects() { clients | jq -c --argjson w "$1" '[.[]|select(.workspace.id==$w)|{c:.class,at:.at,size:.size}]' > "$2"; }
IOU_LAST=""
iou_report() {
  local now out; now=$(mktemp)
  clients | jq -c --argjson w "$2" '[.[]|select(.workspace.id==$w)|{c:.class,at:.at,size:.size}]' > "$now"
  out=$(node -e '
    var a = JSON.parse(require("fs").readFileSync(process.argv[1])), b = JSON.parse(require("fs").readFileSync(process.argv[2]));
    function iou(p, q) { var x1=Math.max(p.at[0],q.at[0]), y1=Math.max(p.at[1],q.at[1]), x2=Math.min(p.at[0]+p.size[0],q.at[0]+q.size[0]), y2=Math.min(p.at[1]+p.size[1],q.at[1]+q.size[1]);
      var i=Math.max(0,x2-x1)*Math.max(0,y2-y1); return i/(p.size[0]*p.size[1]+q.size[0]*q.size[1]-i); }
    var out = [], tot = 0, n = 0;
    a.forEach(function (r) { var m = b.filter(function (x) { return x.c === r.c; })[0];
      var s = m ? iou(r, m) : 0; tot += s; n++; out.push(r.c + "=" + s.toFixed(3)); });
    console.log(process.argv[3] + ": mean IoU " + (n ? (tot / n).toFixed(3) : "0") + " [" + out.join(" ") + "]");
  ' "$3" "$now" "$1")
  rm -f "$now"
  echo "      $out"
  IOU_LAST=$(sed -E 's/.*mean IoU ([0-9.]+) .*/\1/' <<<"$out")
}
iou_at_least() { awk -v v="$IOU_LAST" -v t="$1" 'BEGIN { exit !(v + 0 >= t + 0) }'; }
iou_below()    { awk -v v="$IOU_LAST" -v t="$1" 'BEGIN { exit !(v + 0 <  t + 0) }'; }

# check_iou <label> <ws> <file> [threshold] — fail the run under the threshold.
check_iou() {
  iou_report "$1" "$2" "$3"
  must "$1: mean IoU $IOU_LAST >= ${4:-0.95}" "$1: mean IoU $IOU_LAST is below ${4:-0.95}" iou_at_least "${4:-0.95}"
}

# assert_moved <label> <ws> <file> <ceiling> — the disturbance must have CHANGED
# the desk, or the restore that follows proves nothing.
assert_moved() {
  iou_report "$1 (before the restore)" "$2" "$3"
  must "$1: the disturbance moved the rects (IoU $IOU_LAST < $4)" \
    "$1: the disturbance left the rects where they were (IoU $IOU_LAST >= $4) — the restore after it would prove nothing" \
    iou_below "$4"
}

# record_current — record what is on screen NOW the way the panel does.
record_current() {
  node -e '
    var fs = require("fs"), cp = require("child_process");
    var root = process.argv[1], statePath = process.argv[2], blocksPath = process.argv[3];
    var engine = require(root + "/engine.js"), SM = require(root + "/StateModel.js"), Slots = require(root + "/Slots.js");
    function hc(args) { return JSON.parse(cp.execFileSync("hyprctl", args, { encoding: "utf8" })); }
    var monitors = hc(["monitors", "all", "-j"]), clients = hc(["clients", "-j"]), workspaces = hc(["workspaces", "-j"]);
    var state = SM.parseState(fs.readFileSync(statePath, "utf8")).state;
    var live = engine.buildLayout(clients, monitors, state.identities, new Date().toISOString(), undefined,
      { workspaces: workspaces, built: null });
    var table = Slots.parseBlocks(fs.readFileSync(blocksPath, "utf8"));
    var rec = Slots.toRecorded(live, table, monitors);
    fs.writeFileSync(statePath + ".rec", SM.serializeState(SM.upsertLayout(state, rec.layout)));
    fs.renameSync(statePath + ".rec", statePath);
    rec.layout.apps.forEach(function (a) {
      console.log("  . REC " + a.identityId + " slot " + a.slot + " float=" + a.floating
        + " mode=" + a.layoutMode
        + " group=" + (a.group ? a.group.groupId + "@" + a.group.index + (a.group.active ? "*" : "") : "null")
        + " at=" + a.at + " size=" + a.size);
    });
  ' "$PLUGIN_DIR" "$STATE" "$BLOCKS" || fail "layout recorded" "record_current failed"
  # copy the recording out as evidence
  cp -f "$STATE" "$ARTIFACTS/dock-recall-fidelity-state-${CASE_NAME:-case}.json" 2>/dev/null || true
}

# restore — trigger a restore and wait for the cycle. The cycle's own log lines
# stay in $RESTORE_LOG for the caller to grep.
RESTORE_LOG=""
CYCLES_BEFORE=0
cycle_advanced() { [[ $(cycles_done) -gt $CYCLES_BEFORE ]]; }
restore() {
  local before mark
  before=$(cycles_done)
  mark=$(dr_log | wc -l)
  trigger
  CYCLES_BEFORE=$before
  poll 90 cycle_advanced ||
    echo "note: no 'restore cycle done' within 90 s"
  sleep 1
  RESTORE_LOG=$(dr_log | tail -n +"$((mark + 1))")
  echo "$RESTORE_LOG" | grep -iE "group|refus|split|swap|divider|tiling|placement|order|fail|warn|plan|tabbed" | head -40 | sed 's/^/      log| /'
}

tiling_plan_lines() {
  echo "$RESTORE_LOG" | grep -E "pass [0-9]+ iteration [0-9]+: [0-9]+ ops — " | grep -E "split|swap|divider"
}
no_tiling_ops() { [[ -z $(tiling_plan_lines) ]]; }
log_refused() { echo "$RESTORE_LOG" | grep -qE "REFUSED workspace $1 .*$2"; }

# set_mode <ws> scrolling|floating — Omarchy's own toggle, which acts on the
# ACTIVE workspace and cycles dwindle -> scrolling -> floating. Read the result
# back with Omarchy's own reader; a toggle that did not land is a failed setup.
active_ws() { hyprctl activeworkspace -j | jq -r '.id'; }
set_mode() {
  local w=$1 want=$2 i
  MODE_WORKSPACES+=("$w")
  d "hl.dsp.focus({ workspace = \"$w\" })" >/dev/null
  poll 10 bash -c "[[ \$(hyprctl activeworkspace -j | jq -r '.id') == $w ]]" ||
    fail "workspace $w is active" "the active workspace is '$(active_ws)'"
  for i in 1 2 3; do
    [[ $(omarchy-hyprland-workspace-layout-current "$w" 2>/dev/null) == "$want" ]] && break
    omarchy-hyprland-workspace-layout-toggle >/dev/null 2>&1
    sleep 1.5
  done
  [[ $(omarchy-hyprland-workspace-layout-current "$w" 2>/dev/null) == "$want" ]] ||
    fail "workspace $w switched to $want" \
      "omarchy-hyprland-workspace-layout-current says '$(omarchy-hyprland-workspace-layout-current "$w" 2>&1)'"
  pass "workspace $w is in $want mode (Omarchy's own toggle)"
}

case_begin() {
  echo "=== case $1 ==="
  CASE_NAME=$2
  clear_desk
  # Back on the home workspace: the toggle, and a window's first launch, both
  # follow the active workspace.
  d "hl.dsp.focus({ workspace = \"$HOME_WS\" })" >/dev/null
  sleep 0.5
}

# --------------------------------------------------------- 0. prerequisites

[[ -d $PLUGIN_SRC ]] || fail "plugin payload present" "no plugin tree at $PLUGIN_SRC"
ensure_pkg jq jq       || fail "jq available in the guest"
ensure_pkg foot foot   || fail "foot available in the guest"
ensure_pkg node nodejs || fail "node available in the guest"
command -v omarchy-hyprland-workspace-layout-toggle >/dev/null ||
  fail "Omarchy's workspace layout toggle is present" "omarchy-hyprland-workspace-layout-toggle is not on PATH"
pass "guest prerequisites present (jq, foot, node, workspace layout toggle)"

# ------------------------------------------------------- 1. the plugin, live

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed" "rsync into $PLUGIN_DIR failed"

SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

# Start from no recordings and only this test's identities (one app-id each).
{
  echo "{ \"version\": $SCHEMA_VERSION, \"paused\": false, \"identities\": ["
  first=1
  for app in "${APPS[@]}"; do
    ((first)) || echo ","
    first=0
    printf '  { "id": "%s", "patterns": ["^%s$"], "launch": "foot --app-id=%s" }' "$app" "$app" "$app"
  done
  echo "], \"layouts\": {} }"
} > "$STATE.seed"
mv -f "$STATE.seed" "$STATE"

# An earlier test in this boot normally left the plugin enabled and its service
# live. When it did not (this file run alone), do the full install: rescan, WAIT
# for the registry, enable, check the answer, restart the shell so the service is
# really live.
if [[ $(plugin_state) == "enabled" ]] && service_ready; then
  pass "plugin already enabled and its service live"
else
  omarchy-shell shell rescanPlugins >/dev/null 2>&1
  wait_until "plugin registry knows $PLUGIN_ID" 30 plugin_known
  enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
  [[ $enable_result == "ok" ]] ||
    fail "plugin enabled" "omarchy-shell shell enablePlugin answered '$enable_result'"
  omarchy-restart-shell >/dev/null 2>&1
  wait_until "shell is back after restart" 60 pgrep -f 'quickshell -n -p'
  wait_until "dock-recall service reported ready" 60 service_ready
fi

PRIMARY=$(hyprctl monitors all -j | jq -r 'first(.[]|select(.id==0)|.name)//empty')
[[ -n $PRIMARY ]] || fail "a primary monitor exists" "no monitor with id 0"
wait_until "primary monitor has a workspace block" 20 dr_ws_id "$PRIMARY" 1
HOME_WS=$(ws "$SLOT_HOME") || fail "home workspace id resolved"
SCRATCH=$(ws "$SLOT_SCRATCH") || fail "scratch workspace id resolved"

# The unwatched focus anchor lives on the home workspace, away from every case.
d "hl.dsp.focus({ workspace = \"$HOME_WS\" })" >/dev/null
launch dr-anchor "$HOME_WS"
ANCHOR=$(addr_of dr-anchor)
[[ -n $ANCHOR ]] || fail "anchor window launched"
screenshot "success-dock-recall-fidelity-00-ready"

# ----------------------------------------------------------------- G: group

case_group() {
  case_begin "G: tab group ga,gc,gb beside tiled gd, visible tab gc" group
  local W GA GB GC GD order DW DH gx dx
  W=$(ws "$SLOT_GROUP")
  build_spine "$W" dr-ga dr-gc dr-gb     # tab order ga,gc,gb
  GA=$(addr_of dr-ga); GC=$(addr_of dr-gc); GB=$(addr_of dr-gb)
  d "hl.dsp.group.toggle({ window = \"address:$GA\" })" >/dev/null
  join "$GC" "$GA" "$GA" || fail "G: dr-gc did not join the group — the scenario did not build what it says"
  join "$GB" "$GC" "$GA" || fail "G: dr-gb did not join the group — the scenario did not build what it says"
  focus "$ANCHOR"
  launch dr-gd "$SCRATCH"; GD=$(addr_of dr-gd)
  mv_ws "$GD" "$W"; sleep 0.6
  # Unequal tiles, so the group's PLACE is something the rects can show: shrink
  # gd along the axis that separates it from the group.
  read -r DW DH <<<"$(size_of dr-gd)"
  gx=$(clients | jq -r --arg a "$GA" 'first(.[]|select(.address==$a)|.at[0])')
  dx=$(clients | jq -r --arg a "$GD" 'first(.[]|select(.address==$a)|.at[0])')
  if [[ $gx != "$dx" ]]; then resize_to dr-gd $(( DW * 3 / 10 )) "$DH"; else resize_to dr-gd "$DW" $(( DH * 3 / 10 )); fi
  # The visible tab becomes gc: the SECOND tab, not tab 0 and not the last.
  focus "$GC"; focus "$ANCHOR"; sleep 0.5
  show_rects "$W"
  order=$(group_order "$GA")
  must "G: the group holds ga,gc,gb in tab order ($order)" "G: tab order is '$order'" [ "$order" == "dr-ga,dr-gc,dr-gb" ]
  must "G: gc is the visible tab when recorded" "G: visible tab is '$(visible_tab "$W")', wanted dr-gc — the scenario did not build what it says" \
    [ "$(visible_tab "$W")" == "dr-gc" ]
  save_rects "$W" "$TMPD/g"
  record_current
  restore
  d "hl.dsp.group.toggle({ window = \"address:$GA\" })" >/dev/null; sleep 0.5   # dissolve it
  scatter "$W" dr-gb dr-gd dr-ga dr-gc
  restore
  show_rects "$W"
  check_iou "G after scatter" "$W" "$TMPD/g"
  must "G: the group is rebuilt in the recorded tab order" "G: tab order after the restore is '$(group_order "$(addr_of dr-ga)")', recorded '$order'" \
    [ "$(group_order "$(addr_of dr-ga)")" == "$order" ]
  must "G: the visible tab is the recorded one (gc)" "G: the visible tab after the restore is '$(visible_tab "$W")', recorded dr-gc" \
    [ "$(visible_tab "$W")" == "dr-gc" ]
  screenshot "success-dock-recall-fidelity-01-group"
}

# ------------------------------------------------------------------ T: rows

case_rows() {
  case_begin "T: three stacked rows, a dragged divider" rows
  local W TW TH
  W=$(ws "$SLOT_ROWS")
  build_spine "$W" dr-ta dr-tb dr-tc
  must "T: the three windows are stacked in one column" "T: the scenario did not build three stacked rows" make_shape "$W" col dr-ta dr-tb dr-tc
  read -r TW TH <<<"$(size_of dr-tb)"
  resize_to dr-tb "$TW" $(( TH * 3 / 2 ))
  show_rects "$W"
  save_rects "$W" "$TMPD/t"
  record_current
  restore
  scatter "$W" dr-tc dr-ta dr-tb
  restore
  show_rects "$W"
  check_iou "T after scatter" "$W" "$TMPD/t"
  screenshot "success-dock-recall-fidelity-02-rows"
}

# -------------------------------------------------------------- S: scrolling

case_scrolling() {
  case_begin "S: a workspace in Omarchy's scrolling mode" scrolling
  local W SW SH
  W=$(ws "$SLOT_SCROLL")
  set_mode "$W" scrolling
  # Windows land straight on the scrolling workspace: a dwindle spine has no
  # meaning there.
  launch dr-sa "$W"; launch dr-sb "$W"; launch dr-sc "$W"
  d "hl.dsp.focus({ window = \"address:$ANCHOR\" })" >/dev/null; sleep 0.5
  show_rects "$W"
  must "S: all three windows are on workspace $W" "S: fewer than three windows on workspace $W" \
    [ "$(clients | jq --argjson w "$W" '[.[]|select(.workspace.id==$w and (.class|test("^dr-s[abc]$")))]|length')" == 3 ]
  must "S: Hyprland reports the workspace as scrolling" \
    "S: tiledLayout is '$(hyprctl workspaces -j | jq -r --argjson w "$W" 'first(.[]|select(.id==$w)|.tiledLayout)//"?"')'" \
    [ "$(hyprctl workspaces -j | jq -r --argjson w "$W" 'first(.[]|select(.id==$w)|.tiledLayout)//"?"')" == scrolling ]
  record_current
  save_rects "$W" "$TMPD/s"
  restore
  scatter "$W" dr-sc dr-sa dr-sb
  restore
  show_rects "$W"
  must "S: all three windows are back on workspace $W" \
    "S: $(clients | jq --argjson w "$W" '[.[]|select(.workspace.id==$w and (.class|test("^dr-s[abc]$")))]|length') of 3 windows are on workspace $W" \
    [ "$(clients | jq --argjson w "$W" '[.[]|select(.workspace.id==$w and (.class|test("^dr-s[abc]$")))]|length')" == 3 ]
  must "S: the cycle's plan lines carry no split / swap / divider op" "S: the cycle planned a tiling op for a scrolling workspace: $(tiling_plan_lines)" no_tiling_ops

  # In place: a column resized by hand. Disturbed, the workspace is finished and
  # unsettled, so the refusal is news: named in the log, and the restore leaves
  # the disturbed rects exactly as they are.
  read -r SW SH <<<"$(size_of dr-sb)"
  resize_to dr-sb $(( SW * 3 / 2 )) "$SH"
  show_rects "$W"
  assert_moved "S resize" "$W" "$TMPD/s" 0.95
  save_rects "$W" "$TMPD/s2"
  restore
  show_rects "$W"
  must "S: the log names the refusal layout-scrolling for workspace $W" "S: no 'layout-scrolling' refusal for workspace $W in the cycle's log" log_refused "$W" layout-scrolling
  must "S: the in-place cycle's plan lines carry no split / swap / divider op" "S: the in-place cycle planned a tiling op: $(tiling_plan_lines)" no_tiling_ops
  iou_report "S after the in-place restore" "$W" "$TMPD/s2"
  must "S: the in-place restore left the disturbed rects unchanged (IoU $IOU_LAST)" "S: the in-place restore moved windows on a scrolling workspace (IoU $IOU_LAST)" iou_at_least 0.99
  screenshot "success-dock-recall-fidelity-03-scrolling"
}

# --------------------------------------------------------------- F: floating

# float_to <class> <x> <y> <w> <h> — an absolute rect for a floating window.
float_to() {
  local a; a=$(addr_of "$1")
  d "hl.dsp.window.resize({ window = \"address:$a\", x = $4, y = $5 })" >/dev/null
  d "hl.dsp.window.move({ window = \"address:$a\", x = $2, y = $3 })" >/dev/null
  sleep 0.5
}

case_floating() {
  case_begin "F: a recorded float on a workspace in Omarchy's floating mode" floating
  local W MW MH
  W=$(ws "$SLOT_FLOAT")
  set_mode "$W" floating
  launch dr-fa "$W"
  # The mode floats a window it opens, on its own timer: wait for it, then place
  # it at a rect of this test's choosing, read off the monitor and not assumed.
  must "F: the window floats on the floating workspace" "F: dr-fa is not floating on workspace $W" \
    poll 15 bash -c "[[ \$(hyprctl clients -j | jq -r 'first(.[]|select(.class==\"dr-fa\")|.floating)') == true ]]"
  read -r MW MH <<<"$(hyprctl monitors all -j | jq -r --arg n "$PRIMARY" 'first(.[]|select(.name==$n)|"\((.width/.scale)|floor) \((.height/.scale)|floor)")')"
  float_to dr-fa $(( MW / 8 )) $(( MH / 5 )) $(( MW / 3 )) $(( MH / 3 ))
  d "hl.dsp.focus({ window = \"address:$ANCHOR\" })" >/dev/null; sleep 0.5
  show_rects "$W"
  must "F: dr-fa is floating at a rect of the test's choosing" "F: dr-fa is not floating on workspace $W" \
    [ "$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|"\(.floating) \(.workspace.id)")')" == "true $W" ]
  save_rects "$W" "$TMPD/f"
  record_current
  must "F: the recording carries the float and its mode" "F: the recording does not say floating on a floating workspace" \
    bash -c "jq -e '[.layouts[]?.apps[]?|select(.identityId==\"dr-fa\")]|first|.floating==true and .layoutMode==\"floating\"' '$STATE' >/dev/null"
  restore
  # Scatter: off the workspace, and to a different rect. The scatter itself is
  # asserted FIRST, straight after the move and before anything could restore
  # it: VM run 1 of epic 9i2 read it 2.5 s later, after a reload-triggered cycle
  # had already put dr-fa back, and blamed the scatter. Omarchy's mode tiles a
  # window it floated once it leaves the workspace (one second after the move),
  # so the rect is compared only after waiting that out.
  mv_ws "$(addr_of dr-fa)" "$SCRATCH"
  must "F: the window left workspace $W" "F: dr-fa is still on workspace $W" \
    [ "$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|.workspace.id)')" == "$SCRATCH" ]
  sleep 2.5
  must "F: nothing restored the window before the restore was asked for" \
    "F: dr-fa left the scratch workspace for '$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|.workspace.id)')' before any restore — something else restored it" \
    [ "$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|.workspace.id)')" == "$SCRATCH" ]
  assert_moved "F scatter" "$SCRATCH" "$TMPD/f" 0.5
  restore
  show_rects "$W"
  must "F: the window is back on workspace $W" "F: dr-fa is on workspace '$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|.workspace.id)')'" \
    [ "$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|.workspace.id)')" == "$W" ]
  must "F: the window ends floating" "F: dr-fa is not floating after the restore" \
    [ "$(clients | jq -r 'first(.[]|select(.class=="dr-fa")|.floating)')" == true ]
  check_iou "F after restore" "$W" "$TMPD/f"
  screenshot "success-dock-recall-fidelity-04-floating"
}

case_group
case_rows
case_scrolling
case_floating

capture_service_log
pass "dock-recall fidelity: tab group and visible tab, stacked rows, scrolling refused by name, floating rect restored"
