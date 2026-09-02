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
#   2. nothing steals focus — the live `activewindow` is compared before/after
#      (this one and the visible-workspace check are AMBIGUOUS: your own clicking
#      about during the run trips them too, so they fail loudly but say so);
#   3. nothing writes live state — ~/.local/state/omarchy/dock-recall.json is
#      compared byte-for-byte, and the sandbox's HOME is a mktemp dir.
#
# Usage: tests/sandbox-dock.sh        exit 0 = all cases passed
#        DR_SANDBOX_KEEP=1 tests/sandbox-dock.sh   keep the sandbox dir + logs
#
# Runs alongside your work, but only ONE AT A TIME: a flock on
# $XDG_RUNTIME_DIR/dock-recall-sandbox.lock turns a second concurrent run into a
# busy message, because two runs share one $XDG_RUNTIME_DIR/hypr.
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
trap cleanup EXIT
# Conventional signal exit codes: 128 + signo. The EXIT trap above still runs.
trap 'exit 130' INT
trap 'exit 143' TERM

# ------------------------------------------------------------------- preflight

for tool in hyprctl Hyprland qs jq node foot flock; do
  command -v "$tool" >/dev/null || { echo "FAIL: $tool is not on PATH"; exit 1; }
done

# One sandbox run at a time, belt-and-braces on top of the ownership check
# below. Two overlapping runs each launch a nested compositor into the same
# $XDG_RUNTIME_DIR/hypr, and before the ownership check existed either could
# adopt the other's instance, drive it, and rm -rf its socket dir on the way
# out. Non-blocking: a second run says so and stops rather than queueing behind
# a run that may take minutes.
SANDBOX_LOCK="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/dock-recall-sandbox.lock"
exec 9>"$SANDBOX_LOCK" || { echo "FAIL: cannot open the sandbox lock $SANDBOX_LOCK"; exit 1; }
if ! flock -n 9; then
  echo "FAIL: another sandbox-dock.sh run holds $SANDBOX_LOCK."
  echo "      The nested-compositor sandbox is serialized across working trees;"
  echo "      wait for that run to finish and try again."
  exit 1
fi
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
#
# It is ALSO where the sandbox's environment has to be established. The dispatch
# comes from the live compositor, so this script starts with the user's real
# env, and everything launched INSIDE the nested world inherits from it — the
# plugin's own `foot --app-id=dr-sim`, and whatever the user's shell rc does
# with a real HOME. Redirecting only the Quickshell that hosts the plugin is not
# enough: exports have to happen here, before Hyprland is exec'd.
cat > "$SBOX/launch-nested.sh" <<'LAUNCH'
#!/bin/bash
# $1 = sandbox root, $2 = nested Hyprland config.
sbox="$1"; conf="$2"
echo $$ > "$sbox/nested.pid"

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

exec Hyprland -c "$conf" > "$sbox/nested-hyprland.log" 2>&1
LAUNCH
chmod +x "$SBOX/launch-nested.sh"

# `hl.dsp.exec_cmd([[ … ]])` is a Lua long string that Hyprland word-splits: the
# arguments below cannot be quoted, so a path containing whitespace would arrive
# as two arguments, and a `]]` would end the string early. Refusing is cheaper
# and clearer than escaping. (This is why the wrapper takes the sandbox root and
# derives its own paths — the user's PATH, which may well contain a space, is
# built inside the wrapper and never crosses the dispatch.)
for _p in "$SBOX" "$NESTED_CONF"; do
  case $_p in
    *[[:space:]]*) echo "FAIL: path contains whitespace, which hl.dsp.exec_cmd's long string cannot carry: $_p"; exit 1 ;;
    *']]'*)        echo "FAIL: path contains ']]', which would terminate the Lua long string: $_p"; exit 1 ;;
  esac
done

live dispatch "hl.dsp.exec_cmd([[ [workspace $SPECIAL_WS silent] $SBOX/launch-nested.sh $SBOX $NESTED_CONF ]])" >/dev/null

# The wrapper writes its pid before exec'ing Hyprland, so this pid IS the nested
# compositor's — and it is what every later ownership question is answered
# against, so it is collected FIRST.
for _ in $(seq 60); do
  NESTED_PID=$(cat "$SBOX/nested.pid" 2>/dev/null)
  [[ -n $NESTED_PID ]] && break
  sleep 0.5
done
[[ -n $NESTED_PID ]] || { echo "FAIL: nested Hyprland wrote no pid (see $SBOX/nested-hyprland.log)"; exit 1; }

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

# ADOPTION, ownership-checked. The old probe took the NEWEST new directory under
# $XDG_RUNTIME_DIR/hypr, which two near-simultaneous runs can resolve to the
# same instance: both would then drive one compositor, and the first to finish
# would rm -rf a socket dir still in use. Every instance writes
# `<sig>/hyprland.lock` = "<pid>\n<wayland socket>", so the directory can be
# matched to OUR pid rather than to a timestamp — and the same file hands over
# the Wayland display, which removes a second newest-wins probe.
NESTED_LOCK_PID=""
unowned_seen=""
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
  pass "case 1 LAUNCH — $APP_ID launched onto ws $TARGET_WS on $OUTPUT"
else
  fail "case 1 LAUNCH — $APP_ID is on ws '$(sim_ws)' monitor '$(sim_field monitor)' (want ws $TARGET_WS on monitor $(monitor_id "$OUTPUT"))"
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
  nested dispatch "hl.dsp.window.move({ workspace = \"$SCATTER_WS\", follow = false })" >/dev/null
  if poll 10 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg c '$APP_ID' 'first(.[]|select(.class==\$c)|.workspace.id)//empty') == $SCATTER_WS ]]"; then
    note "scattered to ws $(sim_ws)"
  else
    note "warning: the scatter dispatch left $APP_ID on ws $(sim_ws)"
  fi

  cycles_before=$(sb_count "restore cycle done")
  trigger
  if poll 40 sim_placed; then
    pass "case 2 SCATTER — $APP_ID back on ws $TARGET_WS on $OUTPUT"
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

echo "--- [dock-recall] evidence from the SANDBOX shell ($SBOX/qs.log) ---"
sb_log | tail -20
echo "---"

# The state the plugin wrote is in the temp HOME, and only there.
if [[ -s $STATE ]]; then
  pass "sandbox state written to the temp HOME only: $STATE ($(wc -c < "$STATE") bytes, version $(jq -r .version "$STATE"))"
else
  fail "no sandbox state file at $STATE"
fi

# =============================================================== ISOLATION
#
# Mandatory footer. Every one of these is about the LIVE session, and any delta
# fails the gate however well the cases went.
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

echo "=== isolation footer ==="

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
