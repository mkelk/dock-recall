#!/bin/bash
# dock-recall-undock-locked-prepare-test.sh — the in-guest HALF of the
# undock-while-locked scenario (Tier C).
#
# WHY THIS FILE IS ONLY A HALF. `tests/nested-notes.md` closed an earlier change as
# DONE_WITH_CONCERNS with one gap: the undock focus failover's repair branch has
# never fired, because the state it targets — the lock surface holding keyboard
# focus on an output that is disappearing — needs a real lock screen and a real
# keyboard, and the nested sandbox has neither. A VM has both, but not in the
# same place:
#
#   the SESSION is reachable over the harness's SSH session — hyprctl, the
#   Quickshell log, `omarchy-shell lock lock`, the state file;
#   the KEYBOARD and the SCREEN are only reachable from the HOST, over QMP —
#   `send-key` types into a lock surface that no in-guest tool can reach, and
#   `screendump` photographs a framebuffer `grim` may refuse to hand over once
#   an ext-session-lock is up.
#
# So the scenario is split at that seam. This file runs inside the acceptance
# suite and leaves the guest in exactly the state the scenario starts from: the
# plugin live, one watched window parked on a fake dock, and a layout recorded
# for the docked topology. It locks NOTHING and removes NOTHING.
#
# `tests/acceptance/undock-locked.sh` — a HOST script, run by run.sh against the
# still-running VM (`--keep-running`) — then does the part that needs QMP: lock,
# undock the focused output, read the failover verdict out of the service's own
# log, unlock by typing the password, and redock. The two halves agree on the
# names below and nothing else.
#
# The runner globs `*-test.sh` in sorted order, so this file's name puts it
# last; stage.sh says why that matters.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"

# The contract with undock-locked.sh. Changing any of these means changing both.
APP_TITLE="dock-recall-locked"
APP_CLASS="foot"
IDENTITY="dr-locked"
OUTPUT="dr-lock-dock"
TARGET_SLOT=8
TARGET_WS=      # computed from the slot once the dock has its block (dr_ws_id)

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

as_root() { echo "$GUEST_PASSWORD" | sudo -S "$@" 2>/dev/null; }

shell_log() { qs log -p "${OMARCHY_PATH:-/usr/share/omarchy}/shell" --tail 6000 2>/dev/null; }
dr_log() { shell_log | grep -F "[dock-recall]"; }
service_ready() { dr_log | grep -qF "service-ready"; }

plugin_state() {
  omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id { print $2 }'
}
plugin_known() { [[ -n $(plugin_state) ]]; }

ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

# NO cleanup trap. Everything this file builds is the host driver's starting
# state, and a trap that tidied up on the way out would hand it an empty desk.

# --------------------------------------------------------- 0. prerequisites

[[ -d $PLUGIN_SRC ]] || fail "plugin payload present" "no plugin tree at $PLUGIN_SRC"

ensure_pkg jq jq       || fail "jq available in the guest"
ensure_pkg foot foot   || fail "foot available in the guest"
ensure_pkg node nodejs || fail "node available in the guest"

# ------------------------------------------------------- 1. install the plugin

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed" "rsync into $PLUGIN_DIR failed"

# Whatever the earlier tests in this boot left behind is not this scenario's
# starting point: only this file's own seed may explain anything the host driver
# sees later.
rm -f "$STATE"

omarchy-shell shell rescanPlugins >/dev/null 2>&1
wait_until "plugin registry knows $PLUGIN_ID (locked scenario)" 30 plugin_known

enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
[[ $enable_result == "ok" ]] ||
  fail "plugin enabled (locked scenario)" "omarchy-shell shell enablePlugin answered '$enable_result'"

omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after restart (locked scenario)" 60 pgrep -f 'quickshell -n -p'
wait_until "dock-recall service reported ready (locked scenario)" 60 service_ready

# ------------------------------------------------------------ 2. run the app

pkill -f "foot --title=$APP_TITLE" 2>/dev/null
launch_app "foot --title=$APP_TITLE"
wait_until "watched app window appeared (locked scenario)" 30 app_present

# ---------------------------------------------------- 3. dock (fake monitor)

hyprctl output create headless "$OUTPUT" >/dev/null 2>&1
wait_until "fake dock monitor appeared (locked scenario)" 20 monitor_present "$OUTPUT"

# ------------------------------------------------- 4. arrange, then record

addr=$(app_field address)
[[ -n $addr ]] || fail "app addressable before recording (locked scenario)"

# 4.5 assigns the dock its block of workspaces asynchronously after the output
# appears: wait for the row, then put the window on the dock's own slot by a
# plain window move. The workspace belongs to the dock because the block does;
# nothing moves a workspace between monitors.
wait_until "dock has a workspace block (locked scenario)" 20 dr_ws_id "$OUTPUT" "$TARGET_SLOT"
TARGET_WS=$(dr_ws_id "$OUTPUT" "$TARGET_SLOT") ||
  fail "dock workspace id resolved (locked scenario)" "no monitor-workspaces row for $OUTPUT"
hyprctl dispatch "hl.dsp.window.move({ window = \"address:$addr\", workspace = \"$TARGET_WS\", follow = false })" >/dev/null 2>&1 ||
  hyprctl dispatch movetoworkspacesilent "$TARGET_WS,address:$addr" >/dev/null 2>&1
sleep 2

# Same discipline as the round trip: the seed's `version` comes from StateModel
# so it is never read as a migration, and the LAYOUT is recorded through the
# engine so the schema is the engine's business rather than this file's.
SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel (locked scenario)" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

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
  if (!dock) { console.error("dock-recall locked prep: " + output + " not in the monitor list"); process.exit(1); }

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
  fail "layout recorded for the docked topology (locked scenario)"

on_dock=$(app_ws)
[[ $on_dock == "$TARGET_WS" ]] ||
  fail "watched app parked on the dock (locked scenario)" \
    "wanted the window on ws $TARGET_WS, it is on ws '$on_dock'"

screenshot "success-dock-recall-locked-00-prepared"
dr_log > "$ARTIFACTS/dock-recall-locked-prepare-service.log" 2>/dev/null || true

pass "dock-recall undock-while-locked: guest prepared ($IDENTITY on slot $TARGET_SLOT = ws $TARGET_WS @ $OUTPUT, session UNLOCKED)"
