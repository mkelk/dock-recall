#!/bin/bash
# sandbox-lib.sh — the invisible-compositor harness, SOURCED rather than run.
#
# Everything `tests/sandbox-dock.sh` does except the seed and the cases lives
# here: the live-session baseline, the temp HOME, the nested Hyprland parked on
# a special workspace, the second Quickshell hosting THIS WORKTREE's plugin
# against it, and the isolation footer that fails the run if any of it leaked.
#
# It is a library because there is now more than one thing to prove in a nested
# compositor (a future-version state file must be inert; a reserved-word
# identity id must survive), and each of those wants its own seed and its own
# assertions. Copying the harness per scenario would mean copying the THREE
# ISOLATION RULES per scenario, and a copy of a safety rule is a copy that
# drifts. One definition, many cases.
#
#   THE THREE ISOLATION RULES, enforced by sandbox_verdict:
#     1. the nested compositor's window lives on a special workspace that is
#        never toggled open, so nothing appears on any visible workspace.
#        Rule 1 is now also enforced from the OTHER side, where it cannot be
#        skipped by not calling this library at all: the launch wrapper below
#        stamps DR_NESTED_SANDBOX_PID and tests/nested.lua refuses to configure
#        without it, so a bare `Hyprland -c tests/nested.lua` aborts instead of
#        opening a window on the user's desk (tick n1s;
#        sandbox_probe_unmarked_start proves it, tests/sandbox-nested-guard.sh
#        runs it);
#     2. nothing steals focus — the live `activewindow` is compared
#        before/after (this one and the visible-workspace check are AMBIGUOUS:
#        your own clicking about during the run trips them too, so they fail
#        loudly but say so);
#     3. nothing writes live state — ~/.local/state/omarchy/dock-recall.json is
#        compared byte-for-byte, the desk's monitor-workspaces{,-merged} by
#        mtime (the nested compositor runs Omarchy 4.5's monitor-workspaces.lua,
#        tick zf6), and the sandbox's HOME is a mktemp dir.
#
# Usage, from a script in tests/:
#
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-lib.sh"
#   sandbox_up                 # baseline, nested Hyprland, sandboxed Quickshell
#   ... seed $STATE, drive $OUTPUT, assert with pass/fail ...
#   sandbox_verdict            # isolation footer + the ALL PASS line; exits
#
# A scenario that needs state on disk BEFORE the plugin's service ever reads it
# — a future-version file, an identity the service must see at load — defines
# `sandbox_seed_home` before calling sandbox_up. The temp HOME exists and the
# state directory is made by then; Quickshell has not started.
#
# Runs alongside your work, but only ONE AT A TIME: sandbox_up takes a
# non-blocking flock on $XDG_RUNTIME_DIR/dock-recall-sandbox.lock, because two
# runs share one $XDG_RUNTIME_DIR/hypr.
#
# See tests/nested-notes.md for what was measured while building this.

SANDBOX_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SANDBOX_LIB_DIR/.." && pwd)"
NESTED_CONF="$REPO_ROOT/tests/nested.lua"
SHELL_DIR="${OMARCHY_PATH:-/usr/share/omarchy}/shell"

# The live session, captured ONCE: every later `live …` call uses this rather
# than the ambient variable, which the nested exports would otherwise shadow.
LIVE_SIG="${HYPRLAND_INSTANCE_SIGNATURE:-}"
LIVE_STATE="$HOME/.local/state/omarchy/dock-recall.json"

# Omarchy 4.5's per-monitor workspace state on the DESK (tick zf6). The nested
# compositor now runs default/hypr/monitor-workspaces.lua, which writes these two
# files under $XDG_STATE_HOME — the sandbox's, because the launch wrapper exports
# it. Should that redirect ever slip, the module would rewrite the human's block
# table from a nested world's monitors, and their bar would number every screen
# wrong. So their mtimes are a footer check, beside the dock-recall state file.
LIVE_MW_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy"
LIVE_MW_FILES=("$LIVE_MW_DIR/monitor-workspaces" "$LIVE_MW_DIR/monitor-workspaces-merged")

# mtime_of <file> — full-precision mtime, or "absent". A rewrite with identical
# content still moves it, which is the point: the module rewrites the merged
# file unconditionally on every Hyprland start.
mtime_of() {
  if [[ -e $1 ]]; then stat -c '%y' "$1"; else echo absent; fi
}

# A special workspace is hidden unless something toggles it open, and nothing
# here ever does. `[workspace <name> silent]` on the exec keeps the launch from
# taking focus as well (learnings § QML/JS boundary).
SPECIAL_WS="special:dr-sandbox"
# The nested output size every case runs on (tick 5wo); override only to probe.
# Narrow on purpose: sandbox-fidelity's Q case builds its designed tree (qa over
# qb | (qc / qd)) here, and on 1000 or 1400 wide it builds three stacked rows,
# which fit two trees and are refused as ambiguous-tree.
NESTED_OUTPUT_W="${NESTED_OUTPUT_W:-700}"
NESTED_OUTPUT_H="${NESTED_OUTPUT_H:-850}"

# Defaults a scenario may override BEFORE sandbox_up. APP_ID is the class the
# seeded identity matches and the class `foot --app-id=…` produces, so the two
# move together.
#
# NAMESPACED, and the plain names are IGNORED (tick 66x). These four used to
# read `${APP_ID:-dr-sim}` straight from the environment, and `APP_ID` is a name
# half the world exports — an Android build, a Flatpak helper, a shell rc. An
# ambient one silently reconfigured the gate: the seeded identity would match a
# class the harness never launches, every case would fail, and nothing in the
# output would say why. An override is a deliberate act, so it gets a deliberate
# name; anything a scenario sets in the script itself still wins, because it
# assigns after this file is sourced.
SANDBOX_IGNORED_ENV=""
for _sbx_var in APP_ID OUTPUT TARGET_SLOT SCATTER_SLOT; do
  [[ -n ${!_sbx_var:-} ]] && SANDBOX_IGNORED_ENV="$SANDBOX_IGNORED_ENV $_sbx_var"
done
unset _sbx_var
APP_ID="${DR_SANDBOX_APP_ID:-dr-sim}"
OUTPUT="${DR_SANDBOX_OUTPUT:-sbx-test}"
# SLOTS, not workspace ids (Omarchy 4.5 per-monitor workspaces): a live id is
# block*10+slot and the block is whatever the nested monitor-workspaces.lua gave
# the monitor, so a scenario never writes a literal id. TARGET_SLOT is where the
# seeded layout puts the app on $OUTPUT; SCATTER_SLOT is the slot on the PRIMARY
# monitor a scatter case throws it to. expected_ws turns either into a live id.
TARGET_SLOT="${DR_SANDBOX_TARGET_SLOT:-9}"
SCATTER_SLOT="${DR_SANDBOX_SCATTER_SLOT:-1}"

SBOX=""
STATE=""
NESTED_PID=""
NESTED_SIG=""
NESTED_WD=""
QS_PID=""
FAILURES=0

# Only ever set by sandbox_probe_unmarked_start, and only if the park guard in
# tests/nested.lua FAILED to stop an unmarked start: the socket directory of a
# compositor that should never have come up. Teardown removes it.
UNMARKED_SIG=""
UNMARKED_PID=""

# Set by sandbox_up when the harness declines to host Panel.qml (omarchy-shell's
# Commons/Ui modules are not where SHELL_DIR says); a scenario that asserts on
# panel behaviour checks this rather than discovering it in the silence.
PANEL_HOSTED=0

# ------------------------------------------------------------------ primitives

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
note() { echo "  · $*"; }

# A live-session delta THIS RUN CANNOT BE PROVEN TO HAVE CAUSED. It fails the
# gate exactly like `fail` — the gate does not get to guess — but it prints its
# own attribution so the reader can tell it apart from the checks no user action
# can trip (a stray sandbox client, the live state file, the monitor set).
fail_ambiguous() {
  echo "FAIL: $*"
  echo "      NOTE: this can be your own activity during the run — a click, an"
  echo "            alt-tab, a workspace switch, a notification stealing focus."
  echo "            Rerun while leaving the desktop alone to confirm; if it"
  echo "            repeats on an idle desk, the sandbox really did leak."
  FAILURES=$((FAILURES + 1))
}

live()   { HYPRLAND_INSTANCE_SIGNATURE="$LIVE_SIG"   hyprctl "$@"; }
nested() { HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" hyprctl "$@"; }

# poll <timeout-seconds> <shell-condition...> — never a fixed sleep-then-assert:
# the service's own settle delays make every timing variable. (Same helper as
# sim-dock.sh, and for the same reason.)
poll() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if "$@"; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Quickshell colours its log; strip the escapes so grep -F and -c are honest.
sb_log()   { sed 's/\x1b\[[0-9;]*m//g' "$SBOX/qs.log" 2>/dev/null | grep -F "[dock-recall]" || true; }
sb_count() { sb_log | grep -cF "$1" || true; }

# The whole log, escapes stripped — for the lines the plugin writes through
# console.warn, which carry the prefix too but are worth grepping without it.
sb_raw()   { sed 's/\x1b\[[0-9;]*m//g' "$SBOX/qs.log" 2>/dev/null || true; }

sim_ws()    { nested clients -j | jq -r --arg c "$APP_ID" 'first(.[]|select(.class==$c)|.workspace.id)//empty'; }
sim_field() { nested clients -j | jq -r --arg c "$APP_ID" --arg f "$1" 'first(.[]|select(.class==$c)|.[$f])//empty'; }
monitor_id() { nested monitors all -j | jq -r --arg n "$1" 'first(.[]|select(.name==$n)|.id)//empty'; }
monitor_present() { [[ -n $(monitor_id "$1") ]]; }

# The nested compositor's block table (written by monitor-workspaces.lua into the
# sandbox HOME): "<block>\t<connector>\t<identity>", one row per monitor ever seen,
# the connector empty while it is unplugged.
sb_blocks() { echo "$SBOX/home/.local/state/omarchy/monitor-workspaces"; }
# block_of <connector> — the block of a monitor that is plugged in right now.
block_of() { awk -F'\t' -v c="$1" '$2==c{print $1; exit}' "$(sb_blocks)" 2>/dev/null; }
# expected_ws <connector> <slot> — the live workspace id, block*10+slot, read from
# the block file and never typed. Empty (so a comparison fails) with no block yet.
expected_ws() {
  local b; b=$(block_of "$1")
  [[ $b =~ ^[0-9]+$ ]] && echo $((b * 10 + $2))
}
# primary_monitor — the nested compositor's own output (monitor id 0), which a
# dock and an undock never remove.
primary_monitor() { nested monitors all -j | jq -r 'first(.[]|select(.id==0)|.name)//empty'; }
target_ws()  { expected_ws "$OUTPUT" "$TARGET_SLOT"; }
scatter_ws() { expected_ws "$(primary_monitor)" "$SCATTER_SLOT"; }

sim_placed() {
  local ws mon want want_ws
  ws=$(sim_ws); mon=$(sim_field monitor); want=$(monitor_id "$OUTPUT"); want_ws=$(target_ws)
  [[ -n $ws && -n $want_ws && $ws == "$want_ws" && -n $want && $mon == "$want" ]]
}

trigger() { date +%s.%N > "$SBOX/home/.local/state/omarchy/dock-recall.trigger"; }

# wait_for_cycle <timeout> <cycle-done count before the event> — the log's own
# completion marker is what says a cycle (all three settle passes) is over, so
# the next case starts on a quiet service instead of racing a queued rerun.
wait_for_cycle() {
  poll "$1" bash -c "[[ \$(sed 's/\x1b\[[0-9;]*m//g' '$SBOX/qs.log' | grep -cF 'restore cycle done' || true) -gt $2 ]]"
}

diagnostics() {
  echo "--- last [dock-recall] log lines ---"
  sb_log | tail -25
  echo "--- nested clients (class $APP_ID) ---"
  nested clients -j | jq -c --arg c "$APP_ID" '[.[]|select(.class==$c)|{address,class,workspace:.workspace.id,monitor}]'
  echo "--- nested monitors ---"
  nested monitors all -j | jq -c '[.[]|{id,name}]'
  echo "--- nested workspaces ---"
  nested workspaces -j | jq -c '[.[]|{id,monitor}]'
}

kill_wait() {   # kill_wait <pid> — TERM, then KILL if it will not go
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null
  local i
  for i in $(seq 24); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null
  sleep 0.5
}

# --------------------------------------------------------------------- teardown
#
# Fires on success, on failure and on Ctrl-C. An orphan nested Hyprland is not a
# harmless leftover: it holds a window on the user's special workspace and a
# socket under $XDG_RUNTIME_DIR/hypr that the next run's "newest directory"
# probe would pick up.

cleanup() {
  local status=$?
  set +e
  trap - EXIT
  # A Ctrl-C landing mid-teardown used to abort the teardown itself and leave the
  # nested compositor orphaned on the user's special workspace — the one thing
  # this function exists to prevent. Teardown is short; it runs to the end.
  trap '' INT TERM
  echo "--- teardown ---"
  [[ -n $QS_PID ]] && kill_wait "$QS_PID"
  [[ -n $NESTED_PID ]] && kill_wait "$NESTED_PID"
  # A guard probe's compositor exists only when the guard did not hold. It is
  # parked on the special workspace like every start here, so it was never
  # visible — but it must not outlive the run either.
  [[ -n $UNMARKED_PID ]] && kill_wait "$UNMARKED_PID"
  [[ -n $UNMARKED_SIG ]] && rm -rf "${XDG_RUNTIME_DIR:?}/hypr/$UNMARKED_SIG"
  # Hyprland does not remove its own socket directory when it is killed, and a
  # drift of dead instance dirs is what the adoption probe reads. NESTED_SIG is
  # only ever set for a directory whose `hyprland.lock` pid was VERIFIED to be
  # our own nested compositor, so this rm can never reach another run's live
  # socket dir — and on a failed adoption it stays empty and nothing is removed.
  [[ -n $NESTED_SIG ]] && rm -rf "${XDG_RUNTIME_DIR:?}/hypr/$NESTED_SIG"

  if [[ -n $SBOX && -d $SBOX ]]; then
    if [[ ${DR_SANDBOX_KEEP:-0} == 1 || $status -ne 0 || $FAILURES -ne 0 ]]; then
      echo "sandbox kept: $SBOX (qs.log, nested-hyprland.log, home/.local/state/omarchy/)"
    else
      rm -rf "$SBOX"
    fi
  fi
  echo "teardown done"
  exit $status
}

# owned_by_nested <pid> — is <pid> our nested compositor, or a descendant of it?
# The wrapper execs Hyprland, so equality is the normal answer; the walk covers
# a future wrapper that forks instead of exec'ing.
owned_by_nested() {
  local pid="$1" i
  for i in 1 2 3 4 5; do
    [[ -n $pid && $pid =~ ^[0-9]+$ ]] || return 1
    (( pid <= 1 )) && return 1
    [[ $pid == "$NESTED_PID" ]] && return 0
    pid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)
  done
  return 1
}

# ----------------------------------------------------------------- config check

# The four knobs, validated before anything is built out of them (tick 66x).
#
# They are not just labels: APP_ID is interpolated into a JSON state file AND
# into the anchored regex that identity matches on (`"^$APP_ID$"`), OUTPUT names
# a headless monitor and is compared with `jq --arg`, and the two workspace ids
# are pasted into Lua dispatch strings and into `[[ … == $WS ]]`. A value with a
# space, a regex metacharacter or a `]]` in it does not fail loudly there — it
# produces a seed that matches something else, a Lua string that ends early, or
# a `[[` test that is a syntax error two hundred lines into a run. So the values
# are checked here, where the message can say which knob and what is wrong,
# rather than discovered in a case that fails for a reason it cannot name.
#
# Called from sandbox_up, which is AFTER a scenario's own assignments — those
# are as capable of being wrong as an environment variable is.
#
# `.` is allowed even though it is a regex metacharacter: reverse-DNS classes
# (`org.gnome.Nautilus`) are the normal shape of an app id, and in `^$APP_ID$`
# a dot still matches its own literal — it only widens the pattern, it cannot
# make it match something the harness never launches. Everything that can end a
# string early or change what a shell does is out.
sandbox_check_config() {
  local bad=0 name value

  for name in APP_ID OUTPUT; do
    value="${!name}"
    if [[ -z $value ]]; then
      echo "FAIL: $name is empty — set DR_SANDBOX_$name to a class/monitor name"
      bad=1
    elif [[ ! $value =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "FAIL: $name is '$value'."
      echo "      Only letters, digits, '.', '_' and '-' are allowed: this value is"
      echo "      interpolated into a JSON state file, into the anchored regex the"
      echo "      seeded identity matches on, and into Lua dispatch strings. A space,"
      echo "      a regex metacharacter or a ']]' there corrupts the seed silently."
      echo "      Set DR_SANDBOX_$name to a plain name."
      bad=1
    fi
  done

  for name in TARGET_SLOT SCATTER_SLOT; do
    value="${!name}"
    if [[ ! $value =~ ^[0-9]+$ ]] || (( value < 1 || value > 10 )); then
      echo "FAIL: $name is '$value' — a slot must be a number from 1 to 10."
      echo "      It becomes block*10+slot in a Lua dispatch string and a numeric"
      echo "      [[ ]] comparison; anything else is a broken dispatch."
      echo "      Set DR_SANDBOX_$name to a slot."
      bad=1
    fi
  done
  # No TARGET != SCATTER rule any more: the target is on the dock output and the
  # scatter on the primary, two different blocks, so the ids cannot collide.

  (( bad == 0 )) || exit 1

  # Said out loud rather than obeyed: an exported APP_ID is far more likely to be
  # someone else's than a deliberate override of this gate, and a person who did
  # mean it needs to know the spelling that works.
  if [[ -n $SANDBOX_IGNORED_ENV ]]; then
    note "ignoring ambient$SANDBOX_IGNORED_ENV from the environment — the sandbox"
    note "reads DR_SANDBOX_* only (DR_SANDBOX_APP_ID, …). Effective values:"
  fi
  note "config        APP_ID=$APP_ID OUTPUT=$OUTPUT TARGET_SLOT=$TARGET_SLOT SCATTER_SLOT=$SCATTER_SLOT"
}

# --------------------------------------------- within-workspace fidelity helpers
#
# Lifted from the throwaway probes of epic 0lh (probe-grouping-tiling,
# probe-group-position, probe-active-tab) once they became asserted cases
# (tests/sandbox-fidelity.sh). They drive the NESTED compositor only — every one
# goes through `nested`, which is pinned to $NESTED_SIG — so they are usable only
# after sandbox_up. The nested compositor's Omarchy split settings come from
# tests/nested.lua now; nothing here sets config at run time.
#
# A scenario that sources this file may define a function of the same name AFTER
# the source line and win (sandbox-slots.sh does that with record_current).

ws()      { expected_ws "$(primary_monitor)" "$1"; }   # ws <slot> on the primary
addr_of() { nested clients -j | jq -r --arg c "$1" 'first(.[]|select(.class==$c)|.address)//empty'; }
cls_of()  { nested clients -j | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.class)//empty'; }
d()       { local out; out=$(nested dispatch "$1" 2>&1); echo "${out:-<empty>}"; }
focus()   { d "hl.dsp.focus({ window = \"address:$1\" })" >/dev/null; sleep 0.15; }
mv_ws()   { d "hl.dsp.window.move({ window = \"address:$1\", workspace = \"$2\", follow = false })" >/dev/null; sleep 0.2; }

# launch <app-id> <workspace> — a foot window with that class, opened silently on
# the workspace, waited for.
launch() {
  nested dispatch "hl.dsp.exec_cmd([[ [workspace $2 silent] foot --app-id=$1 ]])" >/dev/null
  poll 20 bash -c "[[ -n \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg c '$1' 'first(.[]|select(.class==\$c)|.address)//empty') ]]"
  sleep 0.3
}

# rects <ws> — one line per window of the workspace: class, rect, group, and the
# visibility fields, sorted by x,y.
rects() {
  nested clients -j | jq -r --argjson w "$1" '
    (map({key:.address, value:.class})|from_entries) as $c
    | [.[]|select(.workspace.id==$w)] | sort_by(.at[0], .at[1], .class)[]
    | "\(.class) at=\(.at|join(",")) size=\(.size|join("x")) float=\(.floating) hidden=\(.hidden|tostring) visible=\(.visible|tostring) grouped=[\(.grouped|map($c[.])|join(","))]"'
}
layout_of() { nested workspaces -j | jq -r --argjson w "$1" 'first(.[]|select(.id==$w)|.tiledLayout)//"?"'; }

# join <addr> <pred> <leader> — put a window into the group <leader> leads, by
# trying each side of <pred> (a member of the group) until it lands.
join() {
  local dir
  for dir in left right up down; do
    focus "$2"; focus "$1"
    d "hl.dsp.window.move({ into_group = \"$dir\" })" >/dev/null; sleep 0.2
    nested clients -j | jq -e --arg a "$1" --arg g "$3" 'first(.[]|select(.address==$a)|.grouped|index($g))!=null' >/dev/null && return 0
  done
  return 1
}

# group_order <leader-addr> — the group's classes in tab order, comma-joined.
group_order() { nested clients -j | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.grouped)|.[]' | while read -r x; do cls_of "$x"; done | paste -sd,; }

# record_current — record what is on screen NOW the way the panel does: build the
# live layout with the engine (handed the workspaces context, as the panel hands
# it), convert to slots with Slots.toRecorded, upsert it under the current
# topology.
record_current() {
  HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
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
      console.log("  · REC " + a.identityId + " slot " + a.slot + " float=" + a.floating
        + " group=" + (a.group ? a.group.groupId + "@" + a.group.index : "null")
        + " at=" + a.at + " size=" + a.size + " keys=" + Object.keys(a).join(","));
    });
  ' "$REPO_ROOT" "$STATE" "$(sb_blocks)"
}

# restore — trigger a restore and wait for the cycle. The cycle's own log lines
# stay in $RESTORE_LOG for the caller to grep; the interesting ones are echoed.
RESTORE_LOG=""
restore() {
  local before mark
  before=$(sb_count "restore cycle done")
  mark=$(sb_log | wc -l)
  trigger
  wait_for_cycle 90 "$before" || note "WARN: no 'restore cycle done' within 90 s"
  sleep 1
  RESTORE_LOG=$(sb_log | tail -n +"$((mark + 1))")
  echo "$RESTORE_LOG" | grep -iE "group|refus|split|swap|divider|tiling|placement|order|fail|warn|plan" | head -40 | sed 's/^/      log| /'
}

# save_rects <ws> <file> — the workspace's windows as [{c,at,size}], to compare
# against later with iou_report.
save_rects() { nested clients -j | jq -c --argjson w "$1" '[.[]|select(.workspace.id==$w)|{c:.class,at:.at,size:.size}]' > "$2"; }

# iou_report <label> <ws> <saved-rects-file> — the mean intersection-over-union of
# the workspace's windows now against the saved rects, by class. Echoes the line
# and leaves the number in $IOU_LAST (a window that is gone scores 0).
IOU_LAST=""
iou_report() {
  local now out; now=$(mktemp)
  nested clients -j | jq -c --argjson w "$2" '[.[]|select(.workspace.id==$w)|{c:.class,at:.at,size:.size}]' > "$now"
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

# ------------------------------------------------------------------ sandbox_up

sandbox_up() {
  trap cleanup EXIT
  # Conventional signal exit codes: 128 + signo. The EXIT trap above still runs.
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # ----------------------------------------------------------------- preflight

  local tool
  for tool in hyprctl Hyprland qs jq node foot flock; do
    command -v "$tool" >/dev/null || { echo "FAIL: $tool is not on PATH"; exit 1; }
  done

  # After the scenario's own assignments and before anything is built out of
  # them: a bad APP_ID is cheapest to catch here and dearest to catch in a case.
  echo "=== sandbox: configuration ==="
  sandbox_check_config

  # One sandbox run at a time, belt-and-braces on top of the ownership check
  # below. Two overlapping runs each launch a nested compositor into the same
  # $XDG_RUNTIME_DIR/hypr, and before the ownership check existed either could
  # adopt the other's instance, drive it, and rm -rf its socket dir on the way
  # out. Non-blocking: a second run says so and stops rather than queueing behind
  # a run that may take minutes.
  SANDBOX_LOCK="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/dock-recall-sandbox.lock"
  exec 9>"$SANDBOX_LOCK" || { echo "FAIL: cannot open the sandbox lock $SANDBOX_LOCK"; exit 1; }
  if ! flock -n 9; then
    echo "FAIL: another sandbox run holds $SANDBOX_LOCK."
    echo "      The nested-compositor sandbox is serialized across working trees"
    echo "      and across scenarios; wait for that run to finish and try again."
    exit 1
  fi
  [[ -n $LIVE_SIG ]] || { echo "FAIL: no HYPRLAND_INSTANCE_SIGNATURE — run this from inside a Hyprland session"; exit 1; }
  [[ -n ${WAYLAND_DISPLAY:-} ]] || { echo "FAIL: no WAYLAND_DISPLAY — the nested compositor needs a parent"; exit 1; }
  [[ -f $NESTED_CONF ]] || { echo "FAIL: missing $NESTED_CONF"; exit 1; }

  echo "=== sandbox: baseline of the LIVE session ==="

  LIVE_AW_BEFORE=$(live activewindow -j 2>/dev/null | jq -r '.address // "none"')
  LIVE_MONITORS_BEFORE=$(live monitors all -j | jq -c '[.[].name]|sort')
  LIVE_VISIBLE_BEFORE=$(live monitors -j | jq -c '[.[]|{monitor:.name,ws:.activeWorkspace.id,special:.specialWorkspace.name}]')
  if [[ -f $LIVE_STATE ]]; then
    LIVE_STATE_BEFORE=$(sha256sum "$LIVE_STATE" | cut -d' ' -f1)
  else
    LIVE_STATE_BEFORE="absent"
  fi
  note "activewindow  $LIVE_AW_BEFORE"
  note "monitors      $LIVE_MONITORS_BEFORE"
  note "visible ws    $LIVE_VISIBLE_BEFORE"
  note "state file    $LIVE_STATE_BEFORE"
  LIVE_MW_BEFORE=()
  local _f
  for _f in "${LIVE_MW_FILES[@]}"; do
    LIVE_MW_BEFORE+=("$(mtime_of "$_f")")
    note "desk mtime    ${_f##*/} ${LIVE_MW_BEFORE[-1]}"
  done

  SBOX=$(mktemp -d "${TMPDIR:-/tmp}/dr-sandbox.XXXXXX")
  mkdir -p "$SBOX/home/.local/state/omarchy" "$SBOX/bin" "$SBOX/qs"
  STATE="$SBOX/home/.local/state/omarchy/dock-recall.json"

  # The plugin toasts when a cycle finishes. With the real session bus reachable
  # through $XDG_RUNTIME_DIR/bus that toast lands on the USER's screen — measured,
  # 2026-09-02, and the one way this sandbox was seen to touch the live desktop.
  # A stub earlier on PATH is surgical: the plugin's notify path still runs, the
  # call is recorded, and nothing is delivered.
  cat > "$SBOX/bin/notify-send" <<'STUB'
#!/bin/bash
printf '%s\n' "notify-send $*" >> "$(dirname "$0")/../notify-send.calls"
exit 0
STUB
  chmod +x "$SBOX/bin/notify-send"

  # The scenario's chance to put something on disk that the plugin's service must
  # see on its very first read — a state file from the future, an identity whose
  # id is a reserved word. Everything it needs exists now ($SBOX, $STATE, the
  # state directory) and Quickshell has not started.
  if declare -F sandbox_seed_home >/dev/null; then
    echo "=== scenario seed (before the shell starts) ==="
    sandbox_seed_home
  fi

  # ----------------------------------------------- 1. the invisible compositor

  echo "=== nested Hyprland ==="

  local hypr_before wl_before
  hypr_before=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort)
  wl_before=$(ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | sort)

  # Launched THROUGH the live compositor rather than as a plain background job,
  # because only an exec dispatch can carry the `[workspace … silent]` rule that
  # parks the window out of sight without touching focus. The wrapper exists to
  # hand us back a pid: `hyprctl dispatch exec` reports none.
  #
  # It is ALSO where the sandbox's environment has to be established. The dispatch
  # comes from the live compositor, so this script starts with the user's real
  # env, and everything launched INSIDE the nested world inherits from it — the
  # plugin's own `foot --app-id=dr-sim`, and whatever the user's shell rc does
  # with a real HOME. Redirecting only the Quickshell that hosts the plugin is not
  # enough: exports have to happen here, before Hyprland is exec'd.
  # ONE wrapper, two callers. `sandbox_probe_unmarked_start` runs this same file
  # with marked=unmarked to prove the guard in tests/nested.lua, and a second
  # copy of a launcher would be a second copy of the HOME redirect and the
  # notify-send stub — the two things that keep a failed start off the user's
  # desk. One definition, so the failure case is contained exactly as the real
  # one is.
  cat > "$SBOX/launch-nested.sh" <<'LAUNCH'
#!/bin/bash
# $1 = sandbox root, $2 = nested Hyprland config, $3 = tag for this start's pid
# and log files, $4 = "marked" to stamp the parked-launch marker.
sbox="$1"; conf="$2"; tag="$3"; marked="$4"
echo $$ > "$sbox/$tag.pid"

# The redirect every client of the nested compositor inherits. HOME is the one
# that matters (Service.qml derives its state dir from HOME); the XDG_* vars go
# with it so nothing falls back to the real ones. XDG_RUNTIME_DIR is left alone
# — it is where the Wayland and hyprctl sockets have to live.
export HOME="$sbox/home"
export XDG_STATE_HOME="$sbox/home/.local/state"
export XDG_CONFIG_HOME="$sbox/home/.config"
export XDG_CACHE_HOME="$sbox/home/.cache"
export XDG_DATA_HOME="$sbox/home/.local/share"

# Stub-first, so a `notify-send` from anything in the nested world hits the
# recording stub instead of the user's screen. DBUS_SESSION_BUS_ADDRESS is
# deliberately NOT dropped — Hyprland wants a session bus — so the stub is the
# guard on the one path that was measured reaching the live desktop.
export PATH="$sbox/bin:$PATH"

# THE PARK MARKER, and the reason tests/nested.lua will configure at all. It
# holds the pid of the process that is about to BECOME Hyprland — `exec` below
# keeps the pid — and nested.lua compares it against /proc/self/stat, so a
# process that merely inherited this environment cannot pass the check. Nothing
# else in the tree sets it: a bare `Hyprland -c tests/nested.lua` from a shell
# has no marker at all and aborts before a surface exists. See the guard block
# at the top of tests/nested.lua for why the desktop needs this.
if [[ $marked == marked ]]; then
  export DR_NESTED_SANDBOX_PID="$$"
fi

exec Hyprland -c "$conf" > "$sbox/$tag-hyprland.log" 2>&1
LAUNCH
  chmod +x "$SBOX/launch-nested.sh"

  # `hl.dsp.exec_cmd([[ … ]])` is a Lua long string that Hyprland word-splits: the
  # arguments below cannot be quoted, so a path containing whitespace would arrive
  # as two arguments, and a `]]` would end the string early. Refusing is cheaper
  # and clearer than escaping. (This is why the wrapper takes the sandbox root and
  # derives its own paths — the user's PATH, which may well contain a space, is
  # built inside the wrapper and never crosses the dispatch.)
  local _p
  for _p in "$SBOX" "$NESTED_CONF"; do
    case $_p in
      *[[:space:]]*) echo "FAIL: path contains whitespace, which hl.dsp.exec_cmd's long string cannot carry: $_p"; exit 1 ;;
      *']]'*)        echo "FAIL: path contains ']]', which would terminate the Lua long string: $_p"; exit 1 ;;
    esac
  done

  live dispatch "hl.dsp.exec_cmd([[ [workspace $SPECIAL_WS silent] $SBOX/launch-nested.sh $SBOX $NESTED_CONF nested marked ]])" >/dev/null

  # The wrapper writes its pid before exec'ing Hyprland, so this pid IS the nested
  # compositor's — and it is what every later ownership question is answered
  # against, so it is collected FIRST.
  for _ in $(seq 60); do
    NESTED_PID=$(cat "$SBOX/nested.pid" 2>/dev/null)
    [[ -n $NESTED_PID ]] && break
    sleep 0.5
  done
  [[ -n $NESTED_PID ]] || { echo "FAIL: nested Hyprland wrote no pid (see $SBOX/nested-hyprland.log)"; exit 1; }

  # ADOPTION, ownership-checked. The old probe took the NEWEST new directory under
  # $XDG_RUNTIME_DIR/hypr, which two near-simultaneous runs can resolve to the
  # same instance: both would then drive one compositor, and the first to finish
  # would rm -rf a socket dir still in use. Every instance writes
  # `<sig>/hyprland.lock` = "<pid>\n<wayland socket>", so the directory can be
  # matched to OUR pid rather than to a timestamp — and the same file hands over
  # the Wayland display, which removes a second newest-wins probe.
  local NESTED_LOCK_PID="" unowned_seen="" cand lock cand_pid
  for _ in $(seq 60); do
    while read -r cand; do
      [[ -n $cand ]] || continue
      [[ -S $XDG_RUNTIME_DIR/hypr/$cand/.socket.sock ]] || continue
      lock="$XDG_RUNTIME_DIR/hypr/$cand/hyprland.lock"
      [[ -r $lock ]] || continue
      cand_pid=$(sed -n 1p "$lock" 2>/dev/null | tr -d '[:space:]')
      if owned_by_nested "$cand_pid"; then
        NESTED_SIG="$cand"
        NESTED_LOCK_PID="$cand_pid"
        NESTED_WD=$(sed -n 2p "$lock" 2>/dev/null | tr -d '[:space:]')
        break
      fi
      unowned_seen="$unowned_seen $cand(pid ${cand_pid:-?})"
    done < <(comm -13 <(echo "$hypr_before") <(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort))
    [[ -n $NESTED_SIG ]] && break
    sleep 0.5
  done
  if [[ -z $NESTED_SIG ]]; then
    echo "FAIL: no Hyprland instance directory belongs to our nested compositor (pid $NESTED_PID)."
    echo "      New instance dirs seen, none owned by us:${unowned_seen:- none}"
    echo "      Nothing was driven and NO socket directory was removed — another"
    echo "      run's instance is never touched. See $SBOX/nested-hyprland.log."
    exit 1
  fi
  note "ownership  $NESTED_SIG/hyprland.lock says pid $NESTED_LOCK_PID; launcher pid is $NESTED_PID — match"

  # The Wayland socket usually comes from that same lock file. The old
  # newest-socket diff stays as the fallback for a Hyprland that writes only a pid.
  if [[ -z $NESTED_WD ]]; then
    for _ in $(seq 40); do
      NESTED_WD=$(comm -13 <(echo "$wl_before") <(ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | sort) | tail -1)
      [[ -n $NESTED_WD ]] && break
      sleep 0.5
    done
    [[ -n $NESTED_WD ]] && note "display    from the socket diff (hyprland.lock carried no wayland line)"
  fi
  [[ -n $NESTED_WD ]] || { echo "FAIL: nested Hyprland exposed no new wayland socket"; exit 1; }

  poll 30 nested monitors -j >/dev/null || { echo "FAIL: nested Hyprland is not answering hyprctl"; exit 1; }
  note "instance   $NESTED_SIG"
  note "pid        $NESTED_PID"
  note "display    $NESTED_WD"

  # Invisibility, measured rather than assumed: the nested compositor's window is
  # a live client, and it must be sitting on the special workspace with no monitor
  # showing that workspace.
  # POLLED: the window maps a moment after the compositor answers hyprctl, and a
  # single read in that gap sees no client at all ("none"), which is what the
  # first 4.5 run saw (tick eth). Only a window that is mapped can be misparked.
  local nested_window_ws special_open
  _nested_window_ws() { live clients -j | jq -r --argjson p "$NESTED_PID" 'first(.[]|select(.pid==$p)|.workspace.name)//"none"'; }
  _nested_window_mapped() { [[ $(_nested_window_ws) != none ]]; }
  poll 10 _nested_window_mapped || true
  nested_window_ws=$(_nested_window_ws)
  special_open=$(live monitors -j | jq -r --arg s "$SPECIAL_WS" 'any(.[]; .specialWorkspace.name==$s)')
  if [[ $nested_window_ws == "$SPECIAL_WS" && $special_open == "false" ]]; then
    pass "nested compositor window is parked on $SPECIAL_WS, which no monitor is showing"
  else
    fail "nested compositor window is on '$nested_window_ws' (special open: $special_open)"
  fi

  # A FIXED OUTPUT SIZE (tick 5wo). The nested output is the size of the nested
  # compositor's window, and a parked window takes the size the live desk gives a
  # tiled client: 701x850 undocked, 2126x850 docked. Dwindle builds a different
  # tree on each, so the same case ran on different scenarios by desk. Float the
  # window and size it absolutely, so every case sees the same aspect. (The
  # float action is ignored by this Hyprland: it toggles, hence the read first.)
  # (`pid:` is not a selector this dispatcher honours — measured; the address is.)
  local _wf _wa
  _wf=$(live clients -j | jq -r --argjson p "$NESTED_PID" 'first(.[]|select(.pid==$p)|"\(.floating) \(.address)")//"none"')
  _wa=${_wf#* }
  if [[ $_wf == false\ * ]]; then
    live dispatch "hl.dsp.window.float({ window = \"address:$_wa\", action = \"toggle\" })" >/dev/null
    sleep 0.3
  fi
  live dispatch "hl.dsp.window.resize({ window = \"address:$_wa\", x = $NESTED_OUTPUT_W, y = $NESTED_OUTPUT_H })" >/dev/null
  _nested_output_pinned() { [[ $(nested monitors all -j | jq -r 'first(.[]|select(.id==0)|"\(.width)x\(.height)")') == "${NESTED_OUTPUT_W}x${NESTED_OUTPUT_H}" ]]; }
  if poll 10 _nested_output_pinned; then
    pass "nested output pinned at ${NESTED_OUTPUT_W}x${NESTED_OUTPUT_H}, whatever the live desk is"
  else
    fail "nested output is $(nested monitors all -j | jq -r 'first(.[]|select(.id==0)|"\(.width)x\(.height)")'), wanted ${NESTED_OUTPUT_W}x${NESTED_OUTPUT_H}"
  fi

  # NO persistent workspace rules (tick zf6). Up to 4.0 this loop pinned 1..10
  # as persistent so a `workspace.move` to a not-yet-launched window's workspace
  # found one. On 4.5 the nested compositor runs monitor-workspaces.lua (see
  # tests/nested.lua), which gives every monitor its own block of ten and
  # renumbers anything outside its owner's block on each reconcile — ten
  # persistent workspaces all minted on the first monitor are exactly what it
  # fights. The module's own `hyprland.start` reconcile is what a real 4.5 desk
  # starts from, so that is what the sandbox starts from too. Wait for it: the
  # block table is written by that reconcile, and a scenario that reads it
  # before then reads nothing.
  local mw_block="$SBOX/home/.local/state/omarchy/monitor-workspaces"
  if poll 15 test -s "$mw_block"; then
    pass "monitor-workspaces.lua ran in the nested compositor (block table in the sandbox: $(wc -l < "$mw_block") row(s))"
  else
    fail "monitor-workspaces.lua wrote no block table to $mw_block — see $SBOX/nested-hyprland.log"
  fi

  # ------------------------------------------- 2. the sandboxed Quickshell

  echo "=== sandboxed Quickshell ==="

  # Quickshell blackholes any import that resolves outside the config folder, so
  # the plugin cannot simply be imported by absolute path. A symlink INSIDE the
  # config folder is accepted, which keeps the gate reading this worktree's files
  # live — no copy to drift out of date. Commons/Ui are omarchy-shell's own
  # modules, symlinked the same way so Panel.qml's `import qs.Commons` resolves.
  ln -sfn "$REPO_ROOT" "$SBOX/qs/plugin"
  local PANEL_LINE=""
  if [[ -d $SHELL_DIR/Commons && -d $SHELL_DIR/Ui ]]; then
    ln -sfn "$SHELL_DIR/Commons" "$SBOX/qs/Commons"
    ln -sfn "$SHELL_DIR/Ui" "$SBOX/qs/Ui"
    PANEL_LINE="  Plugin.Panel {}"
    PANEL_HOSTED=1
  fi

  # A stripped shell: no bar, no other services, no omarchy-shell. The spike
  # (tests/nested-notes.md, 2026-09-02) settled this against running a second
  # omarchy-shell — the plugin's entry points are ordinary QML components and load
  # on their own, while a second omarchy-shell drags in the whole session.
  cat > "$SBOX/qs/shell.qml" <<EOF
import Quickshell
import "plugin" as Plugin

ShellRoot {
  Plugin.Service {}
$PANEL_LINE
}
EOF

  # env -i, so nothing of the caller's session leaks in: no DBUS address (the
  # toast has nowhere to go even past the stub), no live instance signature, no
  # live WAYLAND_DISPLAY. HOME is the redirect that matters — Service.qml derives
  # its state dir from HOME, not from XDG_STATE_HOME, so HOME is what has to move;
  # the XDG_* vars are set alongside it so nothing falls back to the real ones.
  # DR_TEST_LOCKED short-circuits the `omarchy-shell lock isLocked` probe, which
  # would otherwise be the one question the sandbox asks the live session.
  env -i \
    HOME="$SBOX/home" \
    PATH="$SBOX/bin:$PATH" \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
    XDG_STATE_HOME="$SBOX/home/.local/state" \
    XDG_CONFIG_HOME="$SBOX/home/.config" \
    XDG_CACHE_HOME="$SBOX/home/.cache" \
    XDG_DATA_HOME="$SBOX/home/.local/share" \
    WAYLAND_DISPLAY="$NESTED_WD" \
    HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" \
    DR_TEST_LOCKED=false \
    qs -p "$SBOX/qs" > "$SBOX/qs.log" 2>&1 9>&- &
  QS_PID=$!

  if poll 30 bash -c "grep -qF 'service-ready' '$SBOX/qs.log'"; then
    pass "plugin service loaded from $REPO_ROOT into the sandbox shell (pid $QS_PID)"
  else
    fail "sandbox Quickshell never logged service-ready"
    sed 's/\x1b\[[0-9;]*m//g' "$SBOX/qs.log" | tail -30
    exit 1
  fi
  poll 20 bash -c "grep -qF 'state-dir ready' '$SBOX/qs.log'" || note "warning: no state-dir line yet"
  (( PANEL_HOSTED )) && note "Panel.qml hosted too (qs.Commons/qs.Ui resolved from $SHELL_DIR)"
  return 0
}

# ============================================== sandbox_probe_unmarked_start
#
# Proves the park guard at the top of tests/nested.lua: a start that does NOT
# come through the parked launch path must not produce a compositor.
#
# THE CONTAINMENT, which is the whole reason this lives in the library.
#
# Proving a guard against `Hyprland -c tests/nested.lua` means ATTEMPTING that
# start — and that attempt is precisely what put a window in front of the human,
# twice. So the attempt is made through the SAME parked dispatch sandbox_up
# uses, with the marker deliberately withheld:
#
#   - if the guard holds, nothing comes up and the refusal is in the log;
#   - if the guard is BROKEN, the compositor that comes up is parked on
#     $SPECIAL_WS with `silent`, exactly like the legitimate one, so the failure
#     is still invisible — it is reported here instead of appearing on screen.
#
# A bare `Hyprland -c` is never run to prove a guard against bare `Hyprland -c`.
#
# sandbox_up is the CONTROL arm and has already run by the time this is called:
# the same wrapper, the same config, the same dispatch, marker present — and a
# compositor answered hyprctl. Without that arm, "nothing came up" would be
# equally consistent with a harness that cannot start Hyprland at all.
sandbox_probe_unmarked_start() {
  echo "=== park guard: an UNMARKED start must not produce a compositor ==="

  local before pid="" d lockpid sock_seen=0 alive=1 i
  before=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort)
  rm -f "$SBOX/unmarked.pid" "$SBOX/unmarked-hyprland.log"

  live dispatch "hl.dsp.exec_cmd([[ [workspace $SPECIAL_WS silent] $SBOX/launch-nested.sh $SBOX $NESTED_CONF unmarked unmarked ]])" >/dev/null

  for i in $(seq 60); do
    pid=$(cat "$SBOX/unmarked.pid" 2>/dev/null)
    [[ -n $pid ]] && break
    sleep 0.25
  done
  if [[ -z $pid ]]; then
    fail "park guard: the unmarked launch wrapper never wrote a pid — the probe never ran"
    return
  fi
  UNMARKED_PID="$pid"
  note "unmarked start dispatched as pid $pid, parked on $SPECIAL_WS like every start here"

  # Watch for BOTH answers at once: the process going away (the guard held), and
  # an IPC socket appearing under our pid (it did not). Polling for the socket
  # inside the same loop means a compositor that comes up and then exits cannot
  # slip past between two checks.
  for i in $(seq 80); do          # 20 s
    while read -r d; do
      [[ -n $d ]] || continue
      [[ -S $XDG_RUNTIME_DIR/hypr/$d/.socket.sock ]] || continue
      lockpid=$(sed -n 1p "$XDG_RUNTIME_DIR/hypr/$d/hyprland.lock" 2>/dev/null | tr -d '[:space:]')
      if [[ $lockpid == "$pid" ]]; then sock_seen=1; UNMARKED_SIG="$d"; fi
    done < <(comm -13 <(echo "$before") <(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort))
    if ! kill -0 "$pid" 2>/dev/null; then alive=0; break; fi
    sleep 0.25
  done

  if (( alive == 0 )); then
    pass "park guard: the unmarked start ended by itself — nothing is left running"
    UNMARKED_PID=""
  else
    fail "park guard: the unmarked start is STILL RUNNING after 20s (pid $pid) — nested.lua configured a compositor it was never meant to"
  fi

  if (( sock_seen == 0 )); then
    pass "park guard: it opened no Hyprland IPC socket — the abort landed before a compositor existed"
  else
    fail "park guard: an unmarked start produced a working compositor ($UNMARKED_SIG). It was parked, so nothing was visible — but the guard did not hold."
  fi

  # A silent death would be the worse bug: an abort nobody can read looks
  # exactly like a Hyprland that failed to build.
  local log="$SBOX/unmarked-hyprland.log"
  if grep -qF "REFUSING TO CONFIGURE" "$log" 2>/dev/null; then
    pass "park guard: it said why, in its own log"
    note "$(grep -F "REFUSING TO CONFIGURE" "$log" | head -1)"
  else
    fail "park guard: nothing in $log names a reason; a start that just disappears is indistinguishable from a broken harness"
    [[ -f $log ]] && sed -n '1,20p' "$log"
  fi
}

# =============================================================== sandbox_verdict
#
# Mandatory footer. Every one of these is about the LIVE session, and any delta
# fails the run however well the cases went.
#
# They are not all equally attributable, and the footer says which is which:
#
#   AUTHORITATIVE — a stray sandbox client on a visible workspace, a changed
#   live state file, a changed monitor set. Nothing the user does at their desk
#   produces any of these, so a delta is the sandbox leaking, full stop.
#
#   AMBIGUOUS — the active window and the visible workspaces. Both are things
#   the user changes constantly just by working, and this gate advertises itself
#   as safe to run WHILE they do. A delta still fails (the gate does not guess),
#   but it is reported through fail_ambiguous with the rerun instruction: on an
#   idle desk the same delta is real.
#
# Takes the run's own name for the verdict line, so a scenario's ALL PASS says
# which scenario passed.

sandbox_verdict() {
  local name="${1:-sandbox}"

  echo "--- [dock-recall] evidence from the SANDBOX shell ($SBOX/qs.log) ---"
  sb_log | tail -20
  echo "---"

  echo "=== isolation footer ==="

  local LIVE_AW_AFTER LIVE_MONITORS_AFTER LIVE_VISIBLE_AFTER LIVE_STATE_AFTER strays
  LIVE_AW_AFTER=$(live activewindow -j 2>/dev/null | jq -r '.address // "none"')
  LIVE_MONITORS_AFTER=$(live monitors all -j | jq -c '[.[].name]|sort')
  LIVE_VISIBLE_AFTER=$(live monitors -j | jq -c '[.[]|{monitor:.name,ws:.activeWorkspace.id,special:.specialWorkspace.name}]')
  if [[ -f $LIVE_STATE ]]; then
    LIVE_STATE_AFTER=$(sha256sum "$LIVE_STATE" | cut -d' ' -f1)
  else
    LIVE_STATE_AFTER="absent"
  fi

  if [[ $LIVE_AW_AFTER == "$LIVE_AW_BEFORE" ]]; then
    pass "isolation: live active window unchanged ($LIVE_AW_AFTER)"
  else
    fail_ambiguous "isolation [ambiguous]: live active window moved $LIVE_AW_BEFORE -> $LIVE_AW_AFTER"
  fi

  [[ $LIVE_STATE_AFTER == "$LIVE_STATE_BEFORE" ]] \
    && pass "isolation: live state file byte-identical ($LIVE_STATE_BEFORE)" \
    || fail "isolation [authoritative]: live state file changed $LIVE_STATE_BEFORE -> $LIVE_STATE_AFTER"

  [[ $LIVE_MONITORS_AFTER == "$LIVE_MONITORS_BEFORE" ]] \
    && pass "isolation: live monitor set unchanged ($LIVE_MONITORS_AFTER)" \
    || fail "isolation [authoritative]: live monitors changed $LIVE_MONITORS_BEFORE -> $LIVE_MONITORS_AFTER"

  if [[ $LIVE_VISIBLE_AFTER == "$LIVE_VISIBLE_BEFORE" ]]; then
    pass "isolation: live visible workspaces unchanged"
  else
    fail_ambiguous "isolation [ambiguous]: live visible workspaces changed
        before: $LIVE_VISIBLE_BEFORE
        after:  $LIVE_VISIBLE_AFTER"
  fi

  # The desk's own 4.5 workspace state, by mtime. AUTHORITATIVE in practice —
  # nothing at an idle desk rewrites these — but a monitor plug or a config
  # reload on the real session during the run does, so the message says so.
  local i mw_after
  for i in "${!LIVE_MW_FILES[@]}"; do
    mw_after=$(mtime_of "${LIVE_MW_FILES[$i]}")
    if [[ $mw_after == "${LIVE_MW_BEFORE[$i]:-unset}" ]]; then
      pass "isolation: desk ${LIVE_MW_FILES[$i]##*/} mtime unchanged ($mw_after)"
    else
      fail "isolation: desk ${LIVE_MW_FILES[$i]##*/} was rewritten during the run: ${LIVE_MW_BEFORE[$i]:-unset} -> $mw_after
      (a monitor plug or a Hyprland reload on the REAL session also does this;
       on an idle desk it is the nested monitor-workspaces.lua writing home)"
    fi
  done

  # The other side of the same redirect: the nested module wrote to the SANDBOX,
  # one row naming each monitor the nested compositor has now. Rows of monitors
  # that came and went stay in the table with an empty connector, as on a desk.
  local mw_block="$SBOX/home/.local/state/omarchy/monitor-workspaces" want got
  if [[ -s $mw_block ]]; then
    want=$(nested monitors all -j 2>/dev/null | jq -c '[.[]|select((.mirrorOf // "none")=="none")|.name]|sort')
    got=$(awk -F'\t' '$2!=""{print $2}' "$mw_block" | jq -Rsc 'split("\n")|map(select(.!=""))|sort')
    if [[ -n $want && $want == "$got" ]]; then
      pass "sandbox block table has one row per nested monitor $got"
    else
      fail "sandbox block table rows $got do not match the nested monitors ${want:-?}"
      sed 's/^/        /' "$mw_block"
    fi
  else
    fail "no sandbox block table at $mw_block — monitor-workspaces.lua did not run nested"
  fi

  # Nothing of ours may be sitting on a workspace the user can see. The only live
  # client this run is allowed to own is the nested compositor, and only on the
  # special workspace nobody opened.
  strays=$(live clients -j | jq -c --arg s "$SPECIAL_WS" --arg c "$APP_ID" --argjson p "${NESTED_PID:-0}" \
    '[.[]|select(.class==$c or ((.pid==$p or .class=="aquamarine") and .workspace.name!=$s))|{class,pid,ws:.workspace.name}]')
  [[ $strays == "[]" ]] \
    && pass "isolation: no sandbox window on any visible live workspace" \
    || fail "isolation [authoritative]: sandbox windows leaked into the live session: $strays"

  if [[ -f $SBOX/notify-send.calls ]]; then
    note "notify-send stub absorbed $(wc -l < "$SBOX/notify-send.calls") toast(s) — none reached the desktop"
  fi

  # ------------------------------------------------------------------ verdict

  local verb_errors
  verb_errors=$(sb_count "VERB-ERROR")
  if (( verb_errors > 0 )); then
    echo "--- VERB-ERROR lines in the sandbox log ($verb_errors) ---"
    sb_log | grep -F "VERB-ERROR" | tail -10
  fi

  if (( FAILURES == 0 )); then
    echo "$name: ALL PASS"
  else
    echo "$name: $FAILURES check(s) FAILED"
  fi
  exit "$FAILURES"
}
