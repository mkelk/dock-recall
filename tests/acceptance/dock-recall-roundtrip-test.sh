#!/bin/bash
# dock-recall-roundtrip-test.sh — the VM acceptance round trip (Tier C).
#
# Runs INSIDE a disposable Omarchy VM booted by omarchy-iso's harness, in a real
# Hyprland session with a real Quickshell shell. It installs this plugin from
# the copy that rode into the guest beside this file, watches one app, records a
# layout for a docked topology, then undocks and redocks and asserts the window
# came back where the recording said it belonged.
#
# The fake dock is `hyprctl output create headless`, the same trick
# tests/sim-dock.sh uses on a live desk — except here the desk is a VM nobody is
# looking at, so this test may run unattended and may restart the shell.
#
# The layout is recorded THROUGH THE ENGINE (node + StateModel.js) rather than
# by hand-writing it: the schema is the engine's business, and a hand-written
# layout would rot at the next STATE_VERSION bump. One thing IS hand-written —
# the identity the test watches, seeded as literal JSON below — and its `version`
# field is read out of StateModel rather than typed, for exactly the same reason:
# a seed claiming a stale version is read as a MIGRATION, and v4's migration is
# not purely additive (it can rewrite `launch`), so a hardcoded number would
# quietly change what the test thinks it seeded. Both writes are atomic
# (temp + rename) because the service watches the file and a truncating write is
# observable.
#
# Screenshots land in $OMARCHY_ACCEPTANCE_DIR as success-/failure-<step>.png and
# are tarred back to the host by the harness.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"
TRIGGER="$STATE_DIR/dock-recall.trigger"

# The watched app is a foot window pinned by TITLE, not by class: `foot` is also
# the class of any other terminal the session happens to have, so the identity
# carries titlePatterns and the engine ANDs the two axes (engine.js, "patterns
# titlePatterns matches when"). titlePatterns are matched against the client's
# initialTitle, which is exactly what `foot --title=` sets.
APP_TITLE="dock-recall-acceptance"
APP_CLASS="foot"
IDENTITY="dr-acceptance"
OUTPUT="dr-acc-dock"
TARGET_SLOT=7
SCATTER_SLOT=1
# Workspace ids are computed from these once the monitors exist (dr_ws_id).
TARGET_WS=
SCATTER_WS=

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }

# Omarchy 4.5 gives each monitor a block of ten workspaces (block*10+slot) and
# records the blocks in monitor-workspaces (`block<TAB>connector<TAB>identity`).
# Same signature and contract as vm-lib.sh's host-side dr_ws_id, which reads the
# same file over SSH: echo the id, or fail loudly with no row. A workspace id is
# never typed into this file — it is computed from the slot.
dr_ws_id() {
  local connector="${1:-}" slot="${2:-}" block
  [[ -n $connector && $slot =~ ^([1-9]|10)$ ]] || {
    echo "dr_ws_id: usage: dr_ws_id <connector> <slot 1..10> (got '$connector' '$slot')" >&2
    return 2
  }
  block=$(awk -F'\t' -v c="$connector" '$2 == c && $1 ~ /^[0-9]+$/ { print $1; exit }' \
    "$HOME/.local/state/omarchy/monitor-workspaces" 2>/dev/null)
  [[ $block =~ ^[0-9]+$ ]] || {
    echo "dr_ws_id: no monitor-workspaces row for '$connector'" >&2
    return 1
  }
  echo $((10#$block * 10 + slot))
}

app_field() {
  clients | jq -r --arg t "$APP_TITLE" --arg f "$1" \
    'first(.[]|select(.initialTitle==$t)|.[$f])//empty'
}
app_ws() {
  clients | jq -r --arg t "$APP_TITLE" \
    'first(.[]|select(.initialTitle==$t)|.workspace.id)//empty'
}
app_present() { [[ -n $(app_field address) ]]; }

monitor_id() {
  hyprctl monitors all -j | jq -r --arg n "$1" 'first(.[]|select(.name==$n)|.id)//empty'
}
monitor_present() { [[ -n $(monitor_id "$1") ]]; }
monitor_absent() { ! monitor_present "$1"; }

# The window exists, sits on the recorded workspace, and sits on the fake dock.
app_restored() {
  local ws mon want want_ws
  ws=$(app_ws)
  mon=$(app_field monitor)
  want=$(monitor_id "$OUTPUT")
  # Recomputed: the redocked output may have been given a block afresh.
  want_ws=$(dr_ws_id "$OUTPUT" "$TARGET_SLOT" 2>/dev/null)
  [[ -n $ws && -n $want_ws && $ws == "$want_ws" && -n $want && $mon == "$want" ]]
}

trigger() { date +%s.%N > "$TRIGGER"; }   # content must CHANGE; a bare touch is ignored

# base-test.sh's wait_until aborts the run on timeout, which is right for most
# steps but leaves no room to dump diagnostics first. poll returns instead.
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

shell_log() { qs log -p "${OMARCHY_PATH:-/usr/share/omarchy}/shell" --tail 3000 2>/dev/null; }
dr_log() { shell_log | grep -F "[dock-recall]"; }
service_ready() { dr_log | grep -qF "service-ready"; }

plugin_state() {
  omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id { print $2 }'
}
plugin_known() { [[ -n $(plugin_state) ]]; }

# The Quickshell log buffer dies with the next shell restart and this VM is
# discarded when the run ends, so the service's own account of the cycle is
# copied out while it still exists — on the failure path especially.
capture_service_log() { dr_log > "$ARTIFACTS/dock-recall-service.log" 2>/dev/null || true; }

ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

diagnostics() {
  echo "--- monitors ---" >&2
  hyprctl monitors all -j | jq -c '[.[]|{id,name}]' >&2
  echo "--- windows matching $APP_TITLE ---" >&2
  clients | jq -c --arg t "$APP_TITLE" \
    '[.[]|select(.initialTitle==$t)|{address,class,initialTitle,workspace:.workspace.id,monitor}]' >&2
  echo "--- state file ---" >&2
  cat "$STATE" 2>/dev/null | head -40 >&2
  echo "--- plugin state: $(plugin_state) ---" >&2
  echo "--- [dock-recall] log ---" >&2
  dr_log | tail -25 >&2
  capture_service_log
}

cleanup() {
  local status=$?
  set +e
  pkill -f "foot --title=$APP_TITLE" 2>/dev/null
  monitor_present "$OUTPUT" && hyprctl output remove "$OUTPUT" >/dev/null 2>&1
  return $status
}
trap cleanup EXIT

# --------------------------------------------------------- 0. prerequisites

[[ -d $PLUGIN_SRC ]] || fail "plugin payload present" "no plugin tree at $PLUGIN_SRC"

ensure_pkg jq jq       || fail "jq available in the guest"
ensure_pkg foot foot   || fail "foot available in the guest"
ensure_pkg node nodejs || fail "node available in the guest"
pass "guest prerequisites present (jq, foot, node)"

# ------------------------------------------------------- 1. install the plugin

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed" "rsync into $PLUGIN_DIR failed"

# Start from no recordings at all, so nothing but this test's own seed can
# explain a restore.
rm -f "$STATE"

# Dropping the directory in is not enough, and neither is firing rescan and
# enable back to back. rescanPlugins is asynchronous: enabling in the next
# breath makes the registry answer `PluginRegistry.setEnabled: unknown plugin`,
# the plugin stays DISABLED, the service never loads — and every later step
# still "passes" because Hyprland's own workspace memory happens to put the
# window back. So: rescan, WAIT for the registry to admit the plugin, enable,
# and check the answer.
omarchy-shell shell rescanPlugins >/dev/null 2>&1
wait_until "plugin registry knows $PLUGIN_ID" 30 plugin_known

enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
[[ $enable_result == "ok" ]] ||
  fail "plugin enabled" "omarchy-shell shell enablePlugin answered '$enable_result'"
[[ $(plugin_state) == "enabled" ]] ||
  fail "plugin enabled" "omarchy plugin list still reports '$(plugin_state)'"

# A SERVICE plugin only becomes live inside a real reload cycle: a hot-reloaded
# service runs QML but its Process and FileView never fire (scripts/dev-install
# spells this out). The shell must actually restart. Safe here — this VM has no
# lock screen up and no user session to lose.
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after restart" 60 pgrep -f 'quickshell -n -p'

# The service saying so itself, rather than a sleep long enough to look safe.
wait_until "dock-recall service reported ready" 60 service_ready

screenshot "success-dock-recall-01-installed"
pass "plugin installed, enabled, and its service is live"

# ------------------------------------------------------------ 2. run the app

pkill -f "foot --title=$APP_TITLE" 2>/dev/null
launch_app "foot --title=$APP_TITLE"
wait_until "watched app window appeared" 30 app_present
screenshot "success-dock-recall-02-app-running"

# ---------------------------------------------------- 3. dock (fake monitor)

hyprctl output create headless "$OUTPUT" >/dev/null 2>&1
wait_until "fake dock monitor appeared" 20 monitor_present "$OUTPUT"
screenshot "success-dock-recall-03-docked"

# ------------------------------------------------- 4. arrange, then record

addr=$(app_field address)
[[ -n $addr ]] || fail "app addressable before recording"

# 4.5 assigns the dock its block of workspaces asynchronously after the output
# appears: wait for the row, then put the window on the dock's own slot by a
# plain window move. The workspace belongs to the dock because the block does;
# nothing moves a workspace between monitors.
wait_until "dock has a workspace block" 20 dr_ws_id "$OUTPUT" "$TARGET_SLOT"
TARGET_WS=$(dr_ws_id "$OUTPUT" "$TARGET_SLOT") ||
  fail "dock workspace id resolved" "no monitor-workspaces row for $OUTPUT"
hyprctl dispatch "hl.dsp.window.move({ window = \"address:$addr\", workspace = \"$TARGET_WS\", follow = false })" >/dev/null 2>&1 ||
  hyprctl dispatch movetoworkspacesilent "$TARGET_WS,address:$addr" >/dev/null 2>&1
sleep 2

# Seed the identity, then record the layout through the engine itself. The
# topology key for laptop+dock can only be computed while the dock exists, which
# is why this runs here and not before step 3.
#
# The schema version the seed declares comes from StateModel, not from this
# file: see the header. It is the only part of the seed the engine owns.
SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

cat > "$STATE.seed" <<JSON
{
  "version": $SCHEMA_VERSION,
  "identities": [
    {
      "id": "$IDENTITY",
      "patterns": ["^$APP_CLASS\$"],
      "titlePatterns": ["^$APP_TITLE\$"],
      "launch": "foot --title=$APP_TITLE"
    }
  ],
  "layouts": {}
}
JSON
mv -f "$STATE.seed" "$STATE"
sleep 1

node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], output = process.argv[3];
  var identityId = process.argv[4], slot = Number(process.argv[5]);

  var monitors = JSON.parse(cp.execFileSync("hyprctl", ["monitors", "all", "-j"], { encoding: "utf8" }));
  var dock = null;
  for (var i = 0; i < monitors.length; i++) if (monitors[i].name === output) dock = monitors[i];
  if (!dock) { console.error("dock-recall acceptance: " + output + " not in the monitor list"); process.exit(1); }

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = {
    topologyKey: engine.topologyKey(monitors),
    recordedAt: new Date().toISOString(),
    apps: [{
      identityId: identityId,
      monitorDescription: engine.monitorLabel(dock),
      slot: slot,
      floating: false,
      group: null
    }]
  };
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  console.log("recorded \"" + layout.topologyKey + "\": " + identityId
    + " on slot " + slot + " @ " + layout.apps[0].monitorDescription);
' "$PLUGIN_DIR" "$STATE" "$OUTPUT" "$IDENTITY" "$TARGET_SLOT" ||
  fail "layout recorded for the docked topology"

screenshot "success-dock-recall-04-recorded"
pass "layout recorded for the docked topology"

# ------------------------------------------------------------- 5. undock

hyprctl output remove "$OUTPUT" >/dev/null 2>&1
wait_until "fake dock monitor removed" 20 monitor_absent "$OUTPUT"
# Let the undock cycle run out: with no layout recorded for the laptop-only
# topology it ends immediately, but the trigger debounce still has to expire.
sleep 4

# Scatter the window off its recorded WORKSPACE as well, and this is the step
# that gives the whole test its teeth.
#
# Removing the monitor is not on its own enough to prove anything: the window
# cannot be "on the dock" while the dock does not exist, so the redock
# assertion would pass the moment Hyprland put workspace 7 back on the
# reappearing output out of its own workspace->monitor memory, with the plugin
# asleep. Moving the window to a workspace the recording does not name removes
# that explanation — only something that has read the recording can put it back
# on workspace 7.
addr=$(app_field address)
[[ -n $addr ]] || fail "app addressable while undocked"
# The surviving monitor's own slot 1 (its block is whatever 4.5 gave it).
PRIMARY=$(hyprctl monitors all -j | jq -r --arg n "$OUTPUT" 'first(.[]|select(.name!=$n)|.name)//empty')
[[ -n $PRIMARY ]] || fail "a monitor survives the undock" "no monitor other than $OUTPUT"
SCATTER_WS=$(dr_ws_id "$PRIMARY" "$SCATTER_SLOT") ||
  fail "scatter workspace id resolved" "no monitor-workspaces row for $PRIMARY"
hyprctl dispatch "hl.dsp.window.move({ window = \"address:$addr\", workspace = \"$SCATTER_WS\", follow = false })" >/dev/null 2>&1 ||
  hyprctl dispatch movetoworkspacesilent "$SCATTER_WS,address:$addr" >/dev/null 2>&1
sleep 2
screenshot "success-dock-recall-05-undocked-and-scattered"

scattered=$(app_ws)
[[ -n $scattered && $scattered == "$SCATTER_WS" ]] ||
  fail "window scattered off its recorded workspace" \
    "wanted the window on ws $SCATTER_WS while undocked, it is on ws '$scattered'"
pass "undocked, and the window scattered to ws $SCATTER_WS (recorded place was slot $TARGET_SLOT = ws $TARGET_WS on $OUTPUT)"

# ------------------------------------------------------ 6. redock and restore

hyprctl output create headless "$OUTPUT" >/dev/null 2>&1
wait_until "fake dock monitor came back" 20 monitor_present "$OUTPUT"
trigger

if poll 60 app_restored; then
  screenshot "success-dock-recall-06-restored"
  pass "window restored to its recorded workspace and monitor"
else
  diagnostics
  fail "window restored to its recorded workspace and monitor" \
    "window is on ws '$(app_ws)' monitor '$(app_field monitor)' (want slot $TARGET_SLOT = ws $(dr_ws_id "$OUTPUT" "$TARGET_SLOT" 2>/dev/null) on monitor $(monitor_id "$OUTPUT"))"
fi

capture_service_log
pass "dock-recall round trip: record, undock, scatter, redock, restored"
