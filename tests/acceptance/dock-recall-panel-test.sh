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
# through this file. So the fields their assertions key on are pinned here:
#
#   key          — every chip has one, it is not empty, and no two chips share
#                  one. Uniqueness is NOT free: instanceKeyFor spells a
#                  single-instance identity with its bare id, so two recorded
#                  entries of one identity at the same occurrence (reachable,
#                  and deliberately unrepaired — see StateModel's
#                  normalizeOccurrence) collide, and a live chip falls back to
#                  its className when the window has no address. Every later
#                  assertion selects chips BY key, so a collision would silently
#                  assert about one chip twice and about another never.
#   renderPath   — "positioned" or "fallback", per chip AND per workspace
#   placed,      — what "positioned" actually DREW. `renderPath: "positioned"`
#   width,         is true of the silent second branch inside that path too: a
#   height         chip whose slot never resolved a rect draws a floor-sized
#                  marker at the canvas origin (Panel.qml calls it visibly
#                  wrong), and a chip measured during warm-up gets a 1×1 rect
#                  from a zero-width canvas — non-null, so the delegate's own
#                  warning never fires either. A positioned chip must therefore
#                  also report placed:true AND clear the 16×10 floor. A 1-pixel
#                  chip fails this test.
#   monitorName  — on chips AND workspaces. The workspace render registry keys
#                  on the monitor because a stale recording can name one
#                  workspace id under two monitors; dropping it from the payload
#                  would leave the chip-versus-workspace cross-check below
#                  matching on id alone, across monitors.
#   iconSource,  — the icon the chip's Image was BOUND to, and whether it is the
#   iconResolved   app's own or the generic executable fallback.
#                  AppLibrary.iconSource never answers empty, so a non-empty
#                  source proves nothing on its own — the flag is what separates
#                  "this app's icon" from "a picture of a cog". Asserted on both
#                  paths, and on the fallback path the chip has no window class
#                  at all, so it also pins that the lookup falls back to the
#                  identity.
#   watched      — asserted against the window this test actually seeded, not
#                  merely required to be present. The live map draws every
#                  mappable client whether it is watched or not, so a payload in
#                  which the identity never loaded looks identical unless
#                  something names the seeded window.
#
# ABSENT vs null in the payload — the convention the later ticks inherit, spelled
# out in tests/acceptance/README.md: a key the panel has nothing to say about is
# ABSENT (a field no tick has implemented yet; `recordedAt` when this topology
# has no recording), and `null` means computed-and-genuinely-empty (`recordedAt`
# null is a recording that carries no timestamp). Consumers ask `has("k")` first.
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

# THE ICON HALF needs two apps, because the claim has two sides and one window
# can only be one of them.
#
#   the SEEDED app       — an app whose desktop entry names an icon. foot's real
#                          entry declares no Icon= at all (that is a fact about
#                          the packaged file, not an accident of this test), so
#                          the entry below is written into the guest's own
#                          applications directory, which the panel scans FIRST
#                          precisely so a user's file overrides a system one.
#   the NO-ENTRY app     — a window whose class no desktop file claims. It must
#                          still draw the generic executable icon and report
#                          iconResolved:false, never an empty source.
#
# The icon is an ABSOLUTE PATH, not a themed name, and that is deliberate:
# AppLibrary.iconSource turns a leading "/" straight into a file:// URL, so this
# side of the assertion does not depend on which icon theme the guest happens to
# ship. The file it points at is the plugin's own preview.png — installed by
# step 1, so it is certainly there.
NOICON_TITLE="dock-recall-noicon"
NOICON_CLASS="dock-recall-noicon"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/dock-recall-panel-test.desktop"

# The panel's own layer, declared in Panel.qml (WlrLayershell.namespace).
PANEL_NAMESPACE="mkelk-dock-recall"
# The IPC target the panel's IpcHandler registers. It exists only while the
# panel is loaded, which is only while it is open — the shell's panel loader
# instantiates the component on summon and drops it on hide.
IPC_TARGET="dock-recall"

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# Filled in at step 2 and asserted against the payload at step 5. Declared here
# because `set -u` is on and the capture predicate below names it.
APP_ADDRESS=""
NOICON_ADDRESS=""
# The file:// URL the seeded app's chip must report as its icon. Filled in at
# step 3 alongside the desktop entry that names it.
ICON_URL=""
# The payloads the two view predicates capture. Same reason.
LIVE_JSON=""
RECORDED_JSON=""

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

# The service's own account of what it read back off the state file, which is
# the only observable that says a seed has actually been taken up. This test
# starts from a REMOVED state file, so each "<n> identities, <m> layouts" pair
# below is reached exactly once and cannot match an earlier line.
state_loaded() { dr_log | grep -qF "state loaded: $1 identities, $2 layouts"; }

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

# The chip floor, in pixels, from Panel.qml's positioned branch: chipRectsForCanvas
# is handed Style.space(16) x Style.space(10) and every resolved rect is grown to
# at least that. A chip AT the floor is legitimate — that is a real window
# clamped up to a clickable size. A chip BELOW it was never placed on a laid-out
# canvas: chipRectsForCanvas floors against min(canvas, floor), so a zero-width
# canvas during warm-up yields 1x1 and nothing complains.
CHIP_MIN_W=16
CHIP_MIN_H=10

# The half both views must satisfy: there is at least one chip, every chip
# carries a non-empty key, a distinct one, one of the two render paths and the
# geometry it drew with, a positioned chip really was placed and really has a
# size, an icon source that is NEVER empty, a flag saying whether that source is
# the app's own icon, and one of the four treatments — and no chip disagrees
# with the workspace it says it is on, ON ITS OWN MONITOR, about which path drew
# it.
#
# THE TREATMENT IS RECOMPUTED HERE, not merely required to be one of four words.
# The cutoffs below are PanelModel.chipTreatment's, restated in jq on purpose:
# the panel reports the tier it drew with and the width and height it drew at,
# and this re-derives the tier from those two numbers. A panel that asked
# chipTreatment with the wrong numbers — the model's instead of the drawn ones,
# say, which is exactly the mistake the fallback path invites — reports a tier
# its own geometry does not earn, and that is what this catches. Every chip on
# every path, so neither the positioned nor the stacked branch can drift.
#
# If the ratified cutoffs ever change, they change in two places: PanelModel and
# here. That is deliberate — a test that imported the answer would agree with a
# wrong answer.
#
# The empty-source clause is not pedantry: AppLibrary.iconSource cannot answer
# empty, because it falls back to application-x-executable, so an empty string
# here means either the panel never asked (no shell, and so no appLibrary) or
# the guest icon theme has no generic executable icon at all. The second would
# leave every unrecognised app drawing nothing, which is worth failing on.
#
# NOTHING inside the shape below may carry an apostrophe or a `#` comment: it is
# a single-quoted shell string, and an apostrophe ends it. `$state` is bound by
# the callers, because
# the chip-versus-workspace clause rebinds `.` inside its own iteration; `$minw`
# and `$minh` come in as jq --argjson.
# shellcheck disable=SC2016  # $state, $minw and $minh are jq's, not the shell's
STATE_SHAPE='
  (.chips|type) == "array" and (.workspaces|type) == "array"
  and (.chips|length) > 0
  and ([.chips[]|select((.key|type) == "string" and (.key|length) > 0
        and (.monitorName|type) == "string" and (.monitorName|length) > 0
        and (.renderPath == "positioned" or .renderPath == "fallback")
        and (.placed|type) == "boolean"
        and (.width|type) == "number" and (.height|type) == "number"
        and (.iconSource|type) == "string" and (.iconSource|length) > 0
        and (.iconResolved|type) == "boolean"
        and (.treatment == "pill" or .treatment == "badge"
             or .treatment == "veiled" or .treatment == "field"))]|length) == (.chips|length)
  and ([.chips[]|select(.treatment != (
        if .width >= 140 and .height >= 56 then "pill"
        elif .width >= 56 and .height >= 40 then "badge"
        elif .width >= 24 and .height >= 16 then "veiled"
        else "field" end))]|length) == 0
  and ((.chips|map(.key)|unique|length) == (.chips|length))
  and ([.chips[]|select(.renderPath == "positioned"
        and (.placed == false or .width < $minw or .height < $minh))]|length) == 0
  and ([.workspaces[]|select((.monitorName|type) == "string"
        and (.monitorName|length) > 0)]|length) == (.workspaces|length)
  and ([.chips[] as $c | $state.workspaces[]
        | select(.id == $c.workspaceId and .monitorName == $c.monitorName
                 and .renderPath != $c.renderPath)]|length) == 0
'

# The two view predicates below CAPTURE what they validated. The payload used to
# be read twice — once to satisfy the poll, once for the assertions and the pass
# line — with the panel's refresh timer running in between, so the numbers in the
# headline came from a payload nothing had checked and could read "null chip(s)"
# on an `ok -` line. Now there is one read per view, it is the one that passed,
# and it is the one every later assertion and the pass line use.
#
# `poll` calls these as functions in this shell, so the assignment survives; on
# timeout the variable holds the last, failing payload, which is what
# diagnostics wants anyway.

# The LIVE map: real windows carry at/size, so every workspace on it is
# positioned — and the window this test seeded is on it, watched, keyed by its
# own hyprctl address.
capture_live_state() {
  LIVE_JSON=$(panel_state_json)
  printf '%s' "$LIVE_JSON" | jq -e --argjson minw "$CHIP_MIN_W" --argjson minh "$CHIP_MIN_H" \
    --arg addr "$APP_ADDRESS" --arg noicon "$NOICON_ADDRESS" --arg icon "$ICON_URL" \
    '. as $state |
    '"$STATE_SHAPE"'
    and .showRecorded == false
    and ([.chips[]|select(.renderPath == "positioned")]|length) > 0
    and ([.chips[]|select(.key == $addr and .watched == true
          and .renderPath == "positioned")]|length) == 1
    # THE ICON, on the POSITIONED path. The seeded app has an entry naming an
    # icon, so its chip reports that icon resolved; the no-entry window has
    # none, so its chip reports the generic one and says so.
    and ([.chips[]|select(.key == $addr and .renderPath == "positioned"
          and .iconSource == $icon and .iconResolved == true)]|length) == 1
    and ([.chips[]|select(.key == $noicon and .renderPath == "positioned"
          and .iconResolved == false and (.iconSource|length) > 0)]|length) == 1
  ' >/dev/null
}

# The RECORDED map, built from a layout with no geometry: every chip on it is on
# the fallback path, and at least one exists.
capture_recorded_state() {
  RECORDED_JSON=$(panel_state_json)
  printf '%s' "$RECORDED_JSON" | jq -e --argjson minw "$CHIP_MIN_W" --argjson minh "$CHIP_MIN_H" \
    --arg icon "$ICON_URL" '. as $state |
    '"$STATE_SHAPE"'
    and .showRecorded == true
    and ([.chips[]|select(.renderPath == "fallback")]|length) == (.chips|length)
    # THE SAME ICON, on the FALLBACK path — the half that matters, because the
    # stacked branch is the one that has hidden a broken model before. The
    # recorded chip has no window and therefore no window class at all, so this
    # also pins that the lookup falls back to the IDENTITY: an icon resolved by
    # class alone would report nothing here.
    and ([.chips[]|select(.renderPath == "fallback"
          and .iconSource == $icon and .iconResolved == true)]|length) > 0
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
  pkill -f "foot --app-id=$NOICON_CLASS" 2>/dev/null
  # The desktop entry is this test's fiction too — it claims foot's window class
  # for an app that is not foot — and the tests that share this boot scan the
  # same directory.
  rm -f "$DESKTOP_FILE" 2>/dev/null
  # And take the seed with us. Everything this test writes to the state file is
  # its own fiction — an identity matching a window it just killed, and a layout
  # with no geometry at all — and the tests that share this boot read the same
  # file. The service handles the file vanishing; it is what this test started
  # from.
  rm -f "$STATE" 2>/dev/null
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

# --------------------------------------------- 1b. the desktop entry with an icon
#
# Written AFTER the rsync, because the Icon it names is a file the rsync put
# there, and BEFORE the panel is ever summoned, because the panel scans the
# applications directories once per opening (a hundred-file scan twice a second
# on an idle desktop is not a thing this plugin does).
#
# Icon= is an absolute path so the assertion does not ride on the guest's icon
# theme: AppLibrary.iconSource turns a leading "/" into a file:// URL and asks
# the theme nothing. StartupWMClass is the field that exists to answer "which
# window belongs to this launcher", which is the pass the panel's own lookup
# tries first.
ICON_PATH="$PLUGIN_DIR/preview.png"
[[ -f $ICON_PATH ]] ||
  fail "an icon file to name in the desktop entry (panel IPC)" "no $ICON_PATH after the install"
# The panel builds this URL with Util.fileUrl, which percent-encodes each path
# segment. Nothing in an unremarkable $HOME needs encoding, and this is the
# check that says so rather than assuming it — an encoded byte would make the
# equality below fail for a reason that has nothing to do with icons.
[[ $ICON_PATH =~ ^[A-Za-z0-9/._~-]+$ ]] ||
  fail "the icon path needs no percent-encoding (panel IPC)" \
    "$ICON_PATH contains a character Util.fileUrl would escape"
ICON_URL="file://$ICON_PATH"

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Dock Recall Panel Test
Exec=foot --title=$APP_TITLE
StartupWMClass=$APP_CLASS
Icon=$ICON_PATH
DESKTOP
pass "desktop entry for $APP_CLASS naming Icon=$ICON_PATH (panel IPC)"

# ------------------------------------------------------------ 2. run the app

pkill -f "foot --title=$APP_TITLE" 2>/dev/null
launch_app "foot --title=$APP_TITLE"
wait_until "watched app window appeared (panel IPC)" 30 app_present

APP_WS=$(clients | jq -r --arg t "$APP_TITLE" 'first(.[]|select(.initialTitle==$t)|.workspace.id)//empty')
[[ -n $APP_WS ]] || fail "app has a workspace (panel IPC)"

# The compositor's own name for this window, and the key PanelModel.chipFor
# gives its live chip. Step 5 asserts the payload contains exactly this key,
# watched — which is the only thing that distinguishes "the identity loaded and
# this window matched it" from "the live map drew every client on the desk", and
# the live map does the second whether anything is watched or not.
APP_ADDRESS=$(app_field address)
[[ -n $APP_ADDRESS ]] || fail "app has an address (panel IPC)"

# The other half of the icon claim: a window whose class NO desktop file claims.
# It is never watched (the identity's title axis excludes it), so it exercises
# the lookup's class branch and finds nothing there — which must still draw the
# generic executable icon rather than an empty source.
#
# The class is checked rather than assumed. `foot --app-id=` is what sets it,
# and a foot that ignored the flag would put a second window of class `foot` on
# the desk — which the entry written above DOES claim, so the assertion would
# then be about the wrong thing entirely. Better to say so here.
pkill -f "foot --app-id=$NOICON_CLASS" 2>/dev/null
launch_app "foot --app-id=$NOICON_CLASS --title=$NOICON_TITLE"
noicon_present() {
  [[ -n $(clients | jq -r --arg t "$NOICON_TITLE" \
    'first(.[]|select(.initialTitle==$t)|.address)//empty') ]]
}
wait_until "the no-entry window appeared (panel IPC)" 30 noicon_present

NOICON_ADDRESS=$(clients | jq -r --arg t "$NOICON_TITLE" \
  'first(.[]|select(.initialTitle==$t)|.address)//empty')
noicon_reported_class=$(clients | jq -r --arg t "$NOICON_TITLE" \
  'first(.[]|select(.initialTitle==$t)|.class)//empty')
[[ $noicon_reported_class == "$NOICON_CLASS" ]] ||
  fail "the no-entry window carries its own class (panel IPC)" \
    "hyprctl reports class '$noicon_reported_class', not '$NOICON_CLASS' — foot ignored --app-id, and this window is indistinguishable from the seeded one"
pass "a second window, class $NOICON_CLASS, which no desktop file claims (panel IPC)"

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

# Polled, not slept on — and it is the identity seed that most needs it, because
# nothing downstream used to depend on this write at all. The service logs what
# it read back; wait for the line that says it took the identity, so a seed that
# was rejected as junk or never noticed fails HERE rather than passing quietly
# and leaving step 5's watched-chip assertion to explain itself.
if ! poll 30 state_loaded 1 0; then
  diagnostics
  fail "the service read back the seeded identity (panel IPC)" \
    "no 'state loaded: 1 identities, 0 layouts' from the service after the identity seed"
fi

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

# Same again for the layout: the panel reads the state the SERVICE holds, so the
# recorded map cannot be asked about until the service has taken the layout up.
if ! poll 30 state_loaded 1 1; then
  diagnostics
  fail "the service read back the seeded layout (panel IPC)" \
    "no 'state loaded: 1 identities, 1 layouts' from the service after the layout seed"
fi
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
# spawn away and its delegates report a frame after that. The poll CAPTURES the
# payload it validated into $LIVE_JSON — everything below reads that one, so the
# numbers in the pass lines are the numbers that passed.
if ! poll 30 capture_live_state; then
  diagnostics
  fail "panel IPC reports the live map" \
    "no live payload from '$IPC_TARGET state' satisfied the shape: uniquely-keyed chips, each placed above the ${CHIP_MIN_W}x${CHIP_MIN_H} floor on the positioned path and each carrying a non-empty iconSource, one of them the watched window $APP_ADDRESS reporting $ICON_URL resolved, and $NOICON_ADDRESS reporting the generic icon unresolved (see the raw payload above)"
fi
printf '%s\n' "$LIVE_JSON" > "$ARTIFACTS/dock-recall-panel-state-live.json" 2>/dev/null || true

live_chips=$(printf '%s' "$LIVE_JSON" | jq -r '.chips|length')
live_positioned=$(printf '%s' "$LIVE_JSON" | jq -r '[.chips[]|select(.renderPath == "positioned")]|length')
topology=$(printf '%s' "$LIVE_JSON" | jq -r '.topologyName')
if [[ -z $topology || $topology == "null" ]]; then
  diagnostics
  fail "panel IPC reports a topology name" "topologyName came back as '$topology'"
fi
pass "live map over IPC: $live_chips chip(s), $live_positioned on the POSITIONED path, topology \"$topology\""

# The seeded window itself: watched, on the positioned path, keyed by the
# address hyprctl gives it. Already required by the poll above — restated here
# so the size of the chip that proves it lands in the log.
seeded_size=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$APP_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|"\(.width)x\(.height), placed=\(.placed), ws \(.monitorName)/\(.workspaceId)")//"absent"')
pass "the seeded window is a watched live chip keyed $APP_ADDRESS ($seeded_size)"

# The icons, on the positioned path. Both halves are already required by the
# poll above; restated so the values that proved them land in the log.
seeded_icon=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$APP_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|"\(.iconSource) resolved=\(.iconResolved)")//"absent"')
noicon_icon=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$NOICON_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|"\(.iconSource) resolved=\(.iconResolved)")//"absent"')
pass "POSITIONED icons: the entry's own icon on the seeded chip ($seeded_icon)"
pass "POSITIONED icons: the generic executable icon on a class no file claims ($noicon_icon)"

# The ladder, on the positioned path. Every chip has been checked against
# chipTreatment's own cutoffs by the poll; this says what the tiers came out as,
# so a run whose chips all landed in one tier is visible in the log rather than
# looking like coverage it is not.
live_tiers=$(printf '%s' "$LIVE_JSON" | jq -r \
  '[.chips[]|"\(.treatment) \(.width|floor)x\(.height|floor)"]|join(", ")')
pass "POSITIONED treatments, each matching chipTreatment(width, height): $live_tiers"

# The Recorded tab's date, which the dated-header tick asserts on, is the
# recording's own — not the tab's, and not the clock's. And it is PRESENT: an
# absent recordedAt is the payload's way of saying this topology has no
# recording at all, which would make the assertion below vacuous.
if ! printf '%s' "$LIVE_JSON" | jq -e 'has("recordedAt")' >/dev/null; then
  diagnostics
  fail "panel IPC reports when the layout was recorded" \
    "recordedAt is ABSENT, which the payload's convention reserves for 'no recording for this topology'"
fi
reported_at=$(printf '%s' "$LIVE_JSON" | jq -r '.recordedAt')
if [[ $reported_at != "$RECORDED_AT" ]]; then
  diagnostics
  fail "panel IPC reports when the layout was recorded" \
    "recordedAt came back as '$reported_at', the seed wrote '$RECORDED_AT'"
fi
pass "panel IPC reports the recording's own timestamp ($reported_at)"

# --------------------------------------------- 6. the RECORDED map, over IPC

view_answer=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
if [[ $view_answer != "recorded" ]]; then
  diagnostics
  fail "panel IPC switches to the recorded map" "setView recorded answered '$view_answer'"
fi

if ! poll 30 capture_recorded_state; then
  diagnostics
  fail "panel IPC reports the recorded map" \
    "no recorded payload from '$IPC_TARGET state' satisfied the shape: uniquely-keyed chips, all on the FALLBACK path, agreeing with their own workspace on their own monitor, at least one resolving its identity's icon to $ICON_URL (see the raw payload above)"
fi
printf '%s\n' "$RECORDED_JSON" > "$ARTIFACTS/dock-recall-panel-state-recorded.json" 2>/dev/null || true
screenshot "success-dock-recall-panel-02-recorded"

recorded_chips=$(printf '%s' "$RECORDED_JSON" | jq -r '.chips|length')
recorded_fallback=$(printf '%s' "$RECORDED_JSON" | jq -r '[.chips[]|select(.renderPath == "fallback")]|length')
pass "recorded map over IPC: $recorded_chips chip(s), $recorded_fallback on the FALLBACK path"

recorded_icon=$(printf '%s' "$RECORDED_JSON" | jq -r \
  'first(.chips[]|select(.iconResolved == true)|"\(.key) → \(.iconSource)")//"absent"')
pass "FALLBACK icons: a stacked chip resolves its identity's icon ($recorded_icon)"

recorded_tiers=$(printf '%s' "$RECORDED_JSON" | jq -r \
  '[.chips[]|"\(.treatment) \(.width|floor)x\(.height|floor)"]|join(", ")')
pass "FALLBACK treatments, each matching chipTreatment(width, height): $recorded_tiers"

# The two views are the two paths, and they are not the same chips: a payload
# that reported one constant for renderPath would have failed one of the two
# assertions above, and a payload that never rebuilt would fail this one.
live_keys=$(printf '%s' "$LIVE_JSON" | jq -c '[.chips[].key]|sort')
recorded_keys=$(printf '%s' "$RECORDED_JSON" | jq -c '[.chips[].key]|sort')
if [[ $live_keys == "$recorded_keys" ]]; then
  diagnostics
  fail "the two maps report their own chips" "both views reported the same chip keys: $live_keys"
fi

back=$(omarchy-shell "$IPC_TARGET" setView live 2>&1)
if [[ $back != "live" ]]; then
  diagnostics
  fail "panel IPC switches back to the live map" "setView live answered '$back'"
fi

# And the flip back is the test of the render registries, which outlive the view.
# Workspace render reports are keyed by view AND monitor AND id for exactly this
# moment: both map models derive their monitor boxes from the same mapGeometry,
# so an un-namespaced key would have let the recorded delegate — fallback, every
# time — write over the live map's positioned answer for the same monitor and
# workspace. The whole live shape is re-asserted, so the cross-check between each
# chip and its own workspace has to hold a second time, on reports written while
# the other view was on screen.
if ! poll 30 capture_live_state; then
  diagnostics
  fail "the live map survives a view flip" \
    "after setView recorded and back, the live payload no longer satisfies its own shape — a recorded delegate's render report has most likely overwritten a live one"
fi
pass "the live map is intact after a round trip through the recorded view"

# ---------------------------------------------------------- 7. leave it closed

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
poll 20 panel_layer_absent ||
  fail "panel dismissed" "the panel's layer '$PANEL_NAMESPACE' is still mapped"
pass "panel dismissed; the desk is back for the tests after this one"

capture_service_log
pass "dock-recall panel IPC: chips keyed and reported on both render paths, positioned and fallback"
