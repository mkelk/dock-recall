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
# THE THREE ISOLATION RULES, enforced by the footer at the bottom of this file:
#   1. the nested compositor's window lives on a special workspace that is never
#      toggled open, so nothing appears on any visible workspace;
#   2. nothing steals focus — the live `activewindow` is compared before/after;
#   3. nothing writes live state — ~/.local/state/omarchy/dock-recall.json is
#      compared byte-for-byte, and the sandbox's HOME is a mktemp dir.
#
# Usage: tests/sandbox-dock.sh        exit 0 = all cases passed
#        DR_SANDBOX_KEEP=1 tests/sandbox-dock.sh   keep the sandbox dir + logs
#
# See tests/nested-notes.md for what was measured while building this.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NESTED_CONF="$REPO_ROOT/tests/nested.lua"
SHELL_DIR="${OMARCHY_PATH:-/usr/share/omarchy}/shell"

# The live session, captured ONCE: every later `live …` call uses this rather
# than the ambient variable, which the nested exports would otherwise shadow.
LIVE_SIG="${HYPRLAND_INSTANCE_SIGNATURE:-}"
LIVE_STATE="$HOME/.local/state/omarchy/dock-recall.json"

# A special workspace is hidden unless something toggles it open, and nothing
# here ever does. `[workspace <name> silent]` on the exec keeps the launch from
# taking focus as well (learnings § QML/JS boundary).
SPECIAL_WS="special:dr-sandbox"

APP_ID="dr-sim"
OUTPUT="sbx-test"
TARGET_WS=9
SCATTER_WS=1

SBOX=""
NESTED_PID=""
NESTED_SIG=""
NESTED_WD=""
QS_PID=""
FAILURES=0

# ------------------------------------------------------------------ primitives

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
note() { echo "  · $*"; }

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

sim_ws()    { nested clients -j | jq -r --arg c "$APP_ID" 'first(.[]|select(.class==$c)|.workspace.id)//empty'; }
sim_field() { nested clients -j | jq -r --arg c "$APP_ID" --arg f "$1" 'first(.[]|select(.class==$c)|.[$f])//empty'; }
monitor_id() { nested monitors all -j | jq -r --arg n "$1" 'first(.[]|select(.name==$n)|.id)//empty'; }
monitor_present() { [[ -n $(monitor_id "$1") ]]; }

sim_placed() {
  local ws mon want
  ws=$(sim_ws); mon=$(sim_field monitor); want=$(monitor_id "$OUTPUT")
  [[ -n $ws && $ws == "$TARGET_WS" && -n $want && $mon == "$want" ]]
}

trigger() { date +%s.%N > "$SBOX/home/.local/state/omarchy/dock-recall.trigger"; }

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
  echo "--- teardown ---"
  [[ -n $QS_PID ]] && kill_wait "$QS_PID"
  [[ -n $NESTED_PID ]] && kill_wait "$NESTED_PID"
  # Hyprland does not remove its own socket directory when it is killed, and a
  # drift of dead instance dirs is what the newest-directory probe reads.
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
trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------------- preflight

for tool in hyprctl Hyprland qs jq node foot; do
  command -v "$tool" >/dev/null || { echo "FAIL: $tool is not on PATH"; exit 1; }
done
[[ -n $LIVE_SIG ]] || { echo "FAIL: no HYPRLAND_INSTANCE_SIGNATURE — run this from inside a Hyprland session"; exit 1; }
[[ -n ${WAYLAND_DISPLAY:-} ]] || { echo "FAIL: no WAYLAND_DISPLAY — the nested compositor needs a parent"; exit 1; }
[[ -f $NESTED_CONF ]] || { echo "FAIL: missing $NESTED_CONF"; exit 1; }

echo "=== sandbox-dock: baseline of the LIVE session ==="

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

# ------------------------------------------------- 1. the invisible compositor

echo "=== nested Hyprland ==="

hypr_before=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort)
wl_before=$(ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | sort)

# Launched THROUGH the live compositor rather than as a plain background job,
# because only an exec dispatch can carry the `[workspace … silent]` rule that
# parks the window out of sight without touching focus. The wrapper exists to
# hand us back a pid: `hyprctl dispatch exec` reports none.
cat > "$SBOX/launch-nested.sh" <<'LAUNCH'
#!/bin/bash
echo $$ > "$1"
exec Hyprland -c "$2" > "$3" 2>&1
LAUNCH
chmod +x "$SBOX/launch-nested.sh"

live dispatch "hl.dsp.exec_cmd([[ [workspace $SPECIAL_WS silent] $SBOX/launch-nested.sh $SBOX/nested.pid $NESTED_CONF $SBOX/nested-hyprland.log ]])" >/dev/null

# The new instance announces itself by creating its socket directory.
for _ in $(seq 60); do
  NESTED_SIG=$(comm -13 <(echo "$hypr_before") <(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort) | tail -1)
  [[ -n $NESTED_SIG && -S $XDG_RUNTIME_DIR/hypr/$NESTED_SIG/.socket.sock ]] && break
  NESTED_SIG=""
  sleep 0.5
done
[[ -n $NESTED_SIG ]] || { echo "FAIL: nested Hyprland never came up (see $SBOX/nested-hyprland.log)"; exit 1; }
NESTED_PID=$(cat "$SBOX/nested.pid" 2>/dev/null)
[[ -n $NESTED_PID ]] || { echo "FAIL: nested Hyprland wrote no pid"; exit 1; }

# Its Wayland socket is the one that appeared alongside it. The plugin's
# Quickshell has to connect to THAT display, not the user's.
for _ in $(seq 40); do
  NESTED_WD=$(comm -13 <(echo "$wl_before") <(ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | sort) | tail -1)
  [[ -n $NESTED_WD ]] && break
  sleep 0.5
done
[[ -n $NESTED_WD ]] || { echo "FAIL: nested Hyprland exposed no new wayland socket"; exit 1; }

poll 30 nested monitors -j >/dev/null || { echo "FAIL: nested Hyprland is not answering hyprctl"; exit 1; }
note "instance   $NESTED_SIG"
note "pid        $NESTED_PID"
note "display    $NESTED_WD"

# Invisibility, measured rather than assumed: the nested compositor's window is
# a live client, and it must be sitting on the special workspace with no monitor
# showing that workspace.
nested_window_ws=$(live clients -j | jq -r --argjson p "$NESTED_PID" 'first(.[]|select(.pid==$p)|.workspace.name)//"none"')
special_open=$(live monitors -j | jq -r --arg s "$SPECIAL_WS" 'any(.[]; .specialWorkspace.name==$s)')
if [[ $nested_window_ws == "$SPECIAL_WS" && $special_open == "false" ]]; then
  pass "nested compositor window is parked on $SPECIAL_WS, which no monitor is showing"
else
  fail "nested compositor window is on '$nested_window_ws' (special open: $special_open)"
fi

# Workspaces that exist BEFORE a restore runs. A bare nested Hyprland creates
# workspaces on demand, so `hl.dsp.workspace.move({ workspace = "9", … })`
# answers "Workspace not found" for a workspace whose only window is about to be
# launched — a race the real desk does not have, because a used desktop has its
# workspaces already. Persistent rules reproduce the real desk, and
# `hyprctl keyword` is rejected by the Lua parser, so this goes through eval.
for ws in 1 2 3 4 5 6 7 8 9 10; do
  nested eval "hl.workspace_rule({ workspace = \"$ws\", persistent = true })" >/dev/null
done
poll 10 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl workspaces -j | jq 'length') -ge 10 ]]" \
  || note "warning: fewer than 10 workspaces materialised"

# --------------------------------------------- 2. the sandboxed Quickshell

echo "=== sandboxed Quickshell ==="

# Quickshell blackholes any import that resolves outside the config folder, so
# the plugin cannot simply be imported by absolute path. A symlink INSIDE the
# config folder is accepted, which keeps the gate reading this worktree's files
# live — no copy to drift out of date. Commons/Ui are omarchy-shell's own
# modules, symlinked the same way so Panel.qml's `import qs.Commons` resolves.
ln -sfn "$REPO_ROOT" "$SBOX/qs/plugin"
PANEL_LINE=""
if [[ -d $SHELL_DIR/Commons && -d $SHELL_DIR/Ui ]]; then
  ln -sfn "$SHELL_DIR/Commons" "$SBOX/qs/Commons"
  ln -sfn "$SHELL_DIR/Ui" "$SBOX/qs/Ui"
  PANEL_LINE="  Plugin.Panel {}"
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
  qs -p "$SBOX/qs" > "$SBOX/qs.log" 2>&1 &
QS_PID=$!

if poll 30 bash -c "grep -qF 'service-ready' '$SBOX/qs.log'"; then
  pass "plugin service loaded from $REPO_ROOT into the sandbox shell (pid $QS_PID)"
else
  fail "sandbox Quickshell never logged service-ready"
  sed 's/\x1b\[[0-9;]*m//g' "$SBOX/qs.log" | tail -30
  exit 1
fi
poll 20 bash -c "grep -qF 'state-dir ready' '$SBOX/qs.log'" || note "warning: no state-dir line yet"
[[ -n $PANEL_LINE ]] && note "Panel.qml hosted too (qs.Commons/qs.Ui resolved from $SHELL_DIR)"

# ------------------------------------------------------------------ 3. the seed
#
# Same shape as sim-dock: seed the identity, create the output so the topology
# key can be computed, record a layout THROUGH THE ENGINE, then take the output
# away again — the run proper starts undocked.

echo "=== seed ==="

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

nested output create headless "$OUTPUT" >/dev/null
poll 15 monitor_present "$OUTPUT" || { echo "FAIL: $OUTPUT never appeared in the nested instance"; exit 1; }

HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], output = process.argv[3];
  var appId = process.argv[4], ws = Number(process.argv[5]);

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
      workspaceId: ws,
      floating: false,
      group: null
    }]
  };
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  console.log("  · seeded layout for \"" + layout.topologyKey + "\": " + appId + " on ws " + ws
    + " @ " + layout.apps[0].monitorDescription);
' "$REPO_ROOT" "$STATE" "$OUTPUT" "$APP_ID" "$TARGET_WS" || { echo "FAIL: seeding failed"; exit 1; }

sleep 1
nested output remove "$OUTPUT" >/dev/null
poll 15 bash -c "! HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl monitors all -j | jq -e --arg n '$OUTPUT' 'any(.[]; .name==\$n)' >/dev/null"
sleep 3

# ------------------------------------------------------- 4. the loop, proven

echo "=== loop proof: dock event -> plugin -> nested compositor ==="

ops_before=$(sb_count "restore cycle done")
nested output create headless "$OUTPUT" >/dev/null

if poll 40 sim_placed; then
  pass "$APP_ID launched onto ws $TARGET_WS on $OUTPUT inside the nested compositor"
else
  fail "$APP_ID is on ws '$(sim_ws)' monitor '$(sim_field monitor)' (want ws $TARGET_WS on monitor $(monitor_id "$OUTPUT"))"
  sb_log | tail -25
fi

poll 40 bash -c "[[ \$(sed 's/\x1b\[[0-9;]*m//g' '$SBOX/qs.log' | grep -cF 'restore cycle done' || true) -gt $ops_before ]]" \
  || note "warning: no cycle-done line after the dock event"

echo "--- [dock-recall] evidence from the SANDBOX shell ($SBOX/qs.log) ---"
sb_log | tail -20
echo "---"

# The state the plugin wrote is in the temp HOME, and only there.
if [[ -s $STATE ]]; then
  pass "sandbox state file written: $STATE ($(wc -c < "$STATE") bytes, version $(jq -r .version "$STATE"))"
else
  fail "no sandbox state file at $STATE"
fi

# =============================================================== ISOLATION
#
# Mandatory footer. Every one of these is about the LIVE session, and any delta
# fails the gate however well the cases went.

echo "=== isolation footer ==="

LIVE_AW_AFTER=$(live activewindow -j 2>/dev/null | jq -r '.address // "none"')
LIVE_MONITORS_AFTER=$(live monitors all -j | jq -c '[.[].name]|sort')
LIVE_VISIBLE_AFTER=$(live monitors -j | jq -c '[.[]|{monitor:.name,ws:.activeWorkspace.id,special:.specialWorkspace.name}]')
if [[ -f $LIVE_STATE ]]; then
  LIVE_STATE_AFTER=$(sha256sum "$LIVE_STATE" | cut -d' ' -f1)
else
  LIVE_STATE_AFTER="absent"
fi

[[ $LIVE_AW_AFTER == "$LIVE_AW_BEFORE" ]] \
  && pass "isolation: live active window unchanged ($LIVE_AW_AFTER)" \
  || fail "isolation: live active window moved $LIVE_AW_BEFORE -> $LIVE_AW_AFTER"

[[ $LIVE_STATE_AFTER == "$LIVE_STATE_BEFORE" ]] \
  && pass "isolation: live state file byte-identical ($LIVE_STATE_BEFORE)" \
  || fail "isolation: live state file changed $LIVE_STATE_BEFORE -> $LIVE_STATE_AFTER"

[[ $LIVE_MONITORS_AFTER == "$LIVE_MONITORS_BEFORE" ]] \
  && pass "isolation: live monitor set unchanged ($LIVE_MONITORS_AFTER)" \
  || fail "isolation: live monitors changed $LIVE_MONITORS_BEFORE -> $LIVE_MONITORS_AFTER"

[[ $LIVE_VISIBLE_AFTER == "$LIVE_VISIBLE_BEFORE" ]] \
  && pass "isolation: live visible workspaces unchanged" \
  || fail "isolation: live visible workspaces changed $LIVE_VISIBLE_BEFORE -> $LIVE_VISIBLE_AFTER"

# Nothing of ours may be sitting on a workspace the user can see. The only live
# client this run is allowed to own is the nested compositor, and only on the
# special workspace nobody opened.
strays=$(live clients -j | jq -c --arg s "$SPECIAL_WS" --arg c "$APP_ID" --argjson p "${NESTED_PID:-0}" \
  '[.[]|select(.class==$c or ((.pid==$p or .class=="aquamarine") and .workspace.name!=$s))|{class,pid,ws:.workspace.name}]')
[[ $strays == "[]" ]] \
  && pass "isolation: no sandbox window on any visible live workspace" \
  || fail "isolation: sandbox windows leaked into the live session: $strays"

if [[ -f $SBOX/notify-send.calls ]]; then
  note "notify-send stub absorbed $(wc -l < "$SBOX/notify-send.calls") toast(s) — none reached the desktop"
fi

# ------------------------------------------------------------------ verdict

verb_errors=$(sb_count "VERB-ERROR")
if (( verb_errors > 0 )); then
  echo "--- VERB-ERROR lines in the sandbox log ($verb_errors) ---"
  sb_log | grep -F "VERB-ERROR" | tail -10
fi

if (( FAILURES == 0 )); then
  echo "sandbox-dock: ALL PASS"
else
  echo "sandbox-dock: $FAILURES check(s) FAILED"
fi
exit "$FAILURES"
