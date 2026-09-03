#!/bin/bash
# dock-recall-panel-test.sh — the panel's own IPC surface, in the VM (Tier C).
#
# Runs INSIDE a disposable Omarchy VM booted by omarchy-iso's harness, in a real
# Hyprland session with a real Quickshell shell. Everything else in this
# directory watches the SERVICE — the state file, hyprctl, the `[dock-recall]`
# log. This one is the first test that opens the PANEL and asks it what it drew.
#
# WHY IT ASKS RATHER THAN LOOKS. This venue cannot prove a pixel was rasterized:
# no golden images, no Pillow on host or guest, and `undock-locked.sh` already
# measured (2026-09-02) that the emulated framebuffer goes on showing a normal
# desktop while the session is genuinely locked — so a screendump is an artifact
# here, never evidence. The standard increment 06-bwf adopted instead is
# bind-level: the panel reports the values it COMPUTED AND BOUND, queried over
# IPC in the guest and asserted the way every other test here asserts. It cannot
# catch a purely rasterization-layer bug (a theme override, zero opacity, a
# broken image codec), and that is the accepted limit of this venue.
#
# WHAT IT PINS, and why it is the first tick of the epic: the six ticks after it
# extend `dock-recall state`'s payload with icons, the treatment ladder, the
# watched fill, workspace badges and a dated Recorded header, and each asserts
# through this file. So the two fields their assertions key on are pinned here:
#
#   key         — every chip has one, and it is not empty
#   renderPath  — "positioned" or "fallback", per chip AND per workspace
#
# BOTH RENDER PATHS, in one panel session. Panel.qml draws a workspace either
# absolutely-positioned (chips at their real rectangles, scaled) or as the
# stacked fallback, and the fallback branch never calls chipRectsForCanvas at
# all. The project's own learnings record the fallback engaging silently and
# hiding a broken model for two live rounds, so neither path may go unasserted.
# They are reached the way a user reaches them:
#
#   LIVE map      — real windows carry at/size, so the workspace is positioned;
#   RECORDED map  — this test seeds a layout with NO at/size (the shape of a v1
#                   recording, and of any read that came back without geometry),
#                   which is precisely what drops a workspace to the fallback.
#
# The seed goes through the engine (node + StateModel.js) for the same reason
# the round trip's does: the schema is the engine's business, and a hand-written
# layout rots at the next STATE_VERSION bump. The one hand-written part — the
# identity — reads its `version` out of StateModel rather than typing it, so a
# seed can never claim a stale version and be read as a migration instead.
#
# The panel is DISMISSED on the way out, however this test ends: its layer takes
# keyboard focus exclusively, and the tests that run after it want the desk back.
#
# Screenshots land in $OMARCHY_ACCEPTANCE_DIR as success-/failure-<step>.png and
# both IPC payloads are copied into $ARTIFACTS, so the verdict is auditable
# after the VM is gone.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"

# Same pinning as the round trip: `foot` is also the class of any other terminal
# the session happens to have, so the identity carries titlePatterns and the
# engine ANDs the two axes. titlePatterns match the client's initialTitle, which
# is exactly what `foot --title=` sets.
APP_TITLE="dock-recall-panel"
APP_CLASS="foot"
IDENTITY="dr-panel"

# The panel's own layer, declared in Panel.qml (WlrLayershell.namespace).
PANEL_NAMESPACE="mkelk-dock-recall"
# The IPC target the panel's IpcHandler registers. It exists only while the
# panel is loaded, which is only while it is open — the shell's panel loader
# instantiates the component on summon and drops it on hide.
IPC_TARGET="dock-recall"

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }

app_field() {
  clients | jq -r --arg t "$APP_TITLE" --arg f "$1" \
    'first(.[]|select(.initialTitle==$t)|.[$f])//empty'
}
app_present() { [[ -n $(app_field address) ]]; }

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

# The panel's layer surface, by the namespace Panel.qml declares. POLLED, never
# slept on: the summon returns as soon as the shell has set its open-set, and
# the surface is mapped some frames later.
panel_layer_present() {
  hyprctl layers -j | jq -e --arg n "$PANEL_NAMESPACE" \
    '[..|.namespace?|select(. == $n)]|length > 0' >/dev/null
}
panel_layer_absent() { ! panel_layer_present; }

panel_state_json() { omarchy-shell "$IPC_TARGET" state 2>/dev/null; }

# The half both views must satisfy: there is at least one chip, every chip
# carries a non-empty key and one of the two render paths — the two fields the
# rest of this epic keys on — and no chip disagrees with the workspace it says
# it is on about which path drew it. `$state` is bound by the callers, because
# the chip-versus-workspace clause rebinds `.` inside its own iteration.
# shellcheck disable=SC2016  # $state is jq's variable, not the shell's
STATE_SHAPE='
  (.chips|type) == "array" and (.workspaces|type) == "array"
  and (.chips|length) > 0
  and ([.chips[]|select((.key|type) == "string" and (.key|length) > 0
        and (.renderPath == "positioned" or .renderPath == "fallback"))]|length) == (.chips|length)
  and ([.chips[] as $c | $state.workspaces[]
        | select(.id == $c.workspaceId and .renderPath != $c.renderPath)]|length) == 0
'

# The LIVE map: real windows carry at/size, so every workspace on it is
# positioned.
live_state_ready() {
  panel_state_json | jq -e '. as $state |
    '"$STATE_SHAPE"'
    and .showRecorded == false
    and ([.chips[]|select(.renderPath == "positioned")]|length) > 0
  ' >/dev/null
}

# The RECORDED map, built from a layout with no geometry: every chip on it is on
# the fallback path, and at least one exists.
recorded_state_ready() {
  panel_state_json | jq -e '. as $state |
    '"$STATE_SHAPE"'
    and .showRecorded == true
    and ([.chips[]|select(.renderPath == "fallback")]|length) == (.chips|length)
  ' >/dev/null
}

capture_service_log() { dr_log > "$ARTIFACTS/dock-recall-panel-service.log" 2>/dev/null || true; }

ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

diagnostics() {
  echo "--- layers ---" >&2
  hyprctl layers -j | jq -c '[..|.namespace?|select(. != null)]' >&2
  echo "--- panel state (raw) ---" >&2
  omarchy-shell "$IPC_TARGET" state 2>&1 | head -c 4000 >&2
  echo >&2
  echo "--- state file ---" >&2
  head -40 "$STATE" >&2 2>/dev/null
  echo "--- [dock-recall] log ---" >&2
  dr_log | tail -25 >&2
  capture_service_log
}

cleanup() {
  local status=$?
  set +e
  # The panel's layer is keyboard-exclusive; nothing that runs after this test
  # should have to work around it. Through the shell, so the loader's open-set
  # and the panel agree about it being gone.
  omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
  pkill -f "foot --title=$APP_TITLE" 2>/dev/null
  return $status
}
trap cleanup EXIT

# --------------------------------------------------------- 0. prerequisites

[[ -d $PLUGIN_SRC ]] || fail "plugin payload present" "no plugin tree at $PLUGIN_SRC"

ensure_pkg jq jq       || fail "jq available in the guest (panel IPC)"
ensure_pkg foot foot   || fail "foot available in the guest (panel IPC)"
ensure_pkg node nodejs || fail "node available in the guest (panel IPC)"
pass "guest prerequisites present (jq, foot, node) — panel IPC"

# ------------------------------------------------------- 1. install the plugin

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed (panel IPC)" "rsync into $PLUGIN_DIR failed"

# Start from no recordings at all, so only this test's own seed can explain the
# recorded map it asserts on.
rm -f "$STATE"

# rescanPlugins is asynchronous, so enabling in the next breath answers
# `unknown plugin` and leaves the plugin disabled: rescan, WAIT for the registry
# to admit it, enable, and check the answer.
omarchy-shell shell rescanPlugins >/dev/null 2>&1
wait_until "plugin registry knows $PLUGIN_ID (panel IPC)" 30 plugin_known

enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
[[ $enable_result == "ok" ]] ||
  fail "plugin enabled (panel IPC)" "omarchy-shell shell enablePlugin answered '$enable_result'"
[[ $(plugin_state) == "enabled" ]] ||
  fail "plugin enabled (panel IPC)" "omarchy plugin list still reports '$(plugin_state)'"

# The panel hot-reloads, but this plugin is a SERVICE too and a hot-reloaded
# service runs QML while its Process and FileView never fire. Restarting is also
# what guarantees the panel loader is looking at the tree just installed rather
# than at an instance created before it. Safe here — this VM has no lock screen
# up and no user session to lose.
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after restart (panel IPC)" 60 pgrep -f 'quickshell -n -p'
wait_until "dock-recall service reported ready (panel IPC)" 60 service_ready
pass "plugin installed, enabled, and its service is live (panel IPC)"

# ------------------------------------------------------------ 2. run the app

pkill -f "foot --title=$APP_TITLE" 2>/dev/null
launch_app "foot --title=$APP_TITLE"
wait_until "watched app window appeared (panel IPC)" 30 app_present

APP_WS=$(clients | jq -r --arg t "$APP_TITLE" 'first(.[]|select(.initialTitle==$t)|.workspace.id)//empty')
[[ -n $APP_WS ]] || fail "app has a workspace (panel IPC)"

# ------------------------------------------------- 3. seed identity + layout

SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel (panel IPC)" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

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

# The layout, through the engine — and DELIBERATELY without at/size. That is
# the shape of a v1 recording, and it is the only honest way to reach the
# fallback layout: PanelModel.workspaceModel sets fallback:true for a workspace
# in which any slot has no rect, and Panel.qml's positioned branch reads that
# flag and nothing else.
RECORDED_AT=$(node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], identityId = process.argv[3], ws = Number(process.argv[4]);

  var monitors = JSON.parse(cp.execFileSync("hyprctl", ["monitors", "all", "-j"], { encoding: "utf8" }));
  var clients = JSON.parse(cp.execFileSync("hyprctl", ["clients", "-j"], { encoding: "utf8" }));
  var home = null;
  for (var c = 0; c < clients.length; c++) {
    if (clients[c].workspace && clients[c].workspace.id === ws) home = clients[c].monitor;
  }
  var monitor = null;
  for (var m = 0; m < monitors.length; m++) {
    if (home === null || monitors[m].id === home) { monitor = monitors[m]; break; }
  }
  if (!monitor) { console.error("dock-recall panel test: no monitor for ws " + ws); process.exit(1); }

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = {
    topologyKey: engine.topologyKey(monitors),
    recordedAt: new Date().toISOString(),
    apps: [{
      identityId: identityId,
      monitorDescription: engine.monitorLabel(monitor),
      workspaceId: ws,
      floating: false,
      group: null
    }]
  };
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  process.stdout.write(layout.recordedAt);
' "$PLUGIN_DIR" "$STATE" "$IDENTITY" "$APP_WS") ||
  fail "geometry-less layout recorded for this topology (panel IPC)"
[[ -n $RECORDED_AT ]] || fail "layout recorded (panel IPC)" "the seed printed no recordedAt"
pass "seeded: $IDENTITY watched, and a layout with NO geometry on ws $APP_WS (recordedAt $RECORDED_AT)"

# ------------------------------------------------------- 4. summon the panel

omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "panel layer '$PANEL_NAMESPACE' appeared" "the panel never mapped a layer surface"
fi
screenshot "success-dock-recall-panel-01-open"
pass "panel summoned and its layer '$PANEL_NAMESPACE' is mapped"

# ------------------------------------------------- 5. the LIVE map, over IPC

# Polled rather than read once: the panel's own hyprctl reads are a process
# spawn away and its delegates report a frame after that.
if ! poll 30 live_state_ready; then
  diagnostics
  fail "panel IPC reports the live map" \
    "no positioned chip with a key came back from '$IPC_TARGET state' (see the raw payload above)"
fi
LIVE_JSON=$(panel_state_json)
printf '%s\n' "$LIVE_JSON" > "$ARTIFACTS/dock-recall-panel-state-live.json" 2>/dev/null || true

live_chips=$(printf '%s' "$LIVE_JSON" | jq -r '.chips|length')
live_positioned=$(printf '%s' "$LIVE_JSON" | jq -r '[.chips[]|select(.renderPath == "positioned")]|length')
topology=$(printf '%s' "$LIVE_JSON" | jq -r '.topologyName')
[[ -n $topology && $topology != "null" ]] ||
  fail "panel IPC reports a topology name" "topologyName came back as '$topology'"
pass "live map over IPC: $live_chips chip(s), $live_positioned on the POSITIONED path, topology \"$topology\""

# The Recorded tab's date, which the dated-header tick asserts on, is the
# recording's own — not the tab's, and not the clock's.
reported_at=$(printf '%s' "$LIVE_JSON" | jq -r '.recordedAt')
[[ $reported_at == "$RECORDED_AT" ]] ||
  fail "panel IPC reports when the layout was recorded" \
    "recordedAt came back as '$reported_at', the seed wrote '$RECORDED_AT'"
pass "panel IPC reports the recording's own timestamp ($reported_at)"

# --------------------------------------------- 6. the RECORDED map, over IPC

view_answer=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $view_answer == "recorded" ]] ||
  fail "panel IPC switches to the recorded map" "setView recorded answered '$view_answer'"

if ! poll 30 recorded_state_ready; then
  diagnostics
  fail "panel IPC reports the recorded map" \
    "no fallback chip with a key came back from '$IPC_TARGET state' after setView recorded"
fi
RECORDED_JSON=$(panel_state_json)
printf '%s\n' "$RECORDED_JSON" > "$ARTIFACTS/dock-recall-panel-state-recorded.json" 2>/dev/null || true
screenshot "success-dock-recall-panel-02-recorded"

recorded_chips=$(printf '%s' "$RECORDED_JSON" | jq -r '.chips|length')
recorded_fallback=$(printf '%s' "$RECORDED_JSON" | jq -r '[.chips[]|select(.renderPath == "fallback")]|length')
pass "recorded map over IPC: $recorded_chips chip(s), $recorded_fallback on the FALLBACK path"

# The two views are the two paths, and they are not the same chips: a payload
# that reported one constant for renderPath would have failed one of the two
# assertions above, and a payload that never rebuilt would fail this one.
live_keys=$(printf '%s' "$LIVE_JSON" | jq -c '[.chips[].key]|sort')
recorded_keys=$(printf '%s' "$RECORDED_JSON" | jq -c '[.chips[].key]|sort')
[[ $live_keys != "$recorded_keys" ]] ||
  fail "the two maps report their own chips" "both views reported the same chip keys: $live_keys"

back=$(omarchy-shell "$IPC_TARGET" setView live 2>&1)
[[ $back == "live" ]] || fail "panel IPC switches back to the live map" "setView live answered '$back'"

# ---------------------------------------------------------- 7. leave it closed

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
poll 20 panel_layer_absent ||
  fail "panel dismissed" "the panel's layer '$PANEL_NAMESPACE' is still mapped"
pass "panel dismissed; the desk is back for the tests after this one"

capture_service_log
pass "dock-recall panel IPC: chips keyed and reported on both render paths, positioned and fallback"
