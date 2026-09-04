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
#   fillState,   — the two colour channels, said separately BECAUSE they are
#   edgeTone       separate. Watched, ghost and unwatched each draw their own
#                  fill now; the outline carries drift and hover. The seeded app
#                  is recorded on a workspace it is not on, so it reports
#                  fillState "watched" AND edgeTone "drift" at once — which is
#                  the assertion a single blended field could not support.
#   badgeValue,  — what each workspace number badge reads, and whether it is the
#   badgeFocused   filled one. At most ONE badge is filled per payload: every
#                  monitor has an active workspace and only the focused monitor
#                  is in front of the user, so a second means the focus rule
#                  leaked across monitors.
#   headerTitle, — the PanelHero's own two strings. headerTitle is what the hero
#   headerMeta     was HANDED, topologyName is what the panel computed, and they
#                  agree by construction — so a hero that stopped being given
#                  one shows up as a disagreement rather than as a blank line
#                  nobody looks at. headerMeta must contain the badge word AND
#                  end in a watched count.
#   paused,      — the Pause switch's own position, and the badge that follows
#   badgeText,     it. The badge did NOT move into PanelHero's `detail` pill,
#   badgeTone      whose border is one fixed colour: four tones over six states
#                  is the only channel a glance uses, and this test drives Pause
#                  over IPC to watch the switch and the badge move together.
#   overflowOpen,— the overflow menu, and its rows as its DELEGATES drew them.
#   overflowLayouts A shut menu lists nothing however many layouts are on disk
#                  — not because the delegates come and go with the popup
#                  (tick be1: they do not; they live for the whole panel
#                  session), but because the payload only reads their reports
#                  while overflowOpen is true — which is what makes a non-empty
#                  list evidence of drawing rather than of a model.
#   rows         — the app list, every row on the shell's Ui/Toggle. appRows
#                  builds THREE states and all three are required: an unwatched
#                  live window, a watched identity, and a recorded-but-unwatched
#                  GHOST — which needs an identity that is never launched, so
#                  the seed carries one. Each row reports its icon the way its
#                  chip does; the ghost has no window and so no window class, so
#                  its resolved icon also pins the identity fallback on the list
#                  side.
#   linkKey,     — the row-to-chip pairing, on BOTH surfaces. One key, and
#   linked         everything answering to it lights up whichever direction the
#                  pointer came from. Driven here by setting `hoveredLinkKey`,
#                  which is exactly what a hover sets — a virtual pointer is a
#                  live-session rig, and this increment does not touch the live
#                  session.
#   recordedAge  — the same stamp in words, and the Recorded tab SAYS it: its
#                  headerMeta has to contain the string, and the Live tab's has
#                  to not, because when a layout was recorded is a fact about
#                  the other tab. Derived from the recording's own recordedAt
#                  and never from a file mtime — one state file holds every
#                  topology's layout, so its mtime is the last time ANY of them
#                  changed, and a stale recording under a fresh mtime is the lie
#                  this line exists to prevent.
#   pictured,    — THE SECOND CONSENT (tick qnc), on chips and on rows.
#   picturable     Watching an app lets the tool MOVE its windows; picturing it
#                  lets the tool PHOTOGRAPH them and keep the picture on disk,
#                  and the two are separate grants with the second defaulting
#                  OFF. `picturable` is rows-only and says whether the row has a
#                  watched identity to grant WITH — an unwatched window and an
#                  orphaned recorded ghost have none, and draw no camera. The
#                  invariants asserted on every payload: a chip that is not
#                  watched is never pictured, and a row that cannot be pictured
#                  never is. Section 7c then drives the grant over IPC and
#                  requires that ONLY `pictured` moved — on one app, in one
#                  direction, with the watched list byte-identical on disk — and
#                  that it survives a shell restart.
#
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

# A THIRD app that is never launched. It is watched (it is in the identity list)
# and it is in the recording, and nothing on the desk matches it — which is the
# definition of a GHOST: recorded, not running, drawn as "this is where it goes"
# rather than "this is where it is".
#
# Seeded because the fill states are three and the desk otherwise supplies two.
# A run that exercised only watched and unwatched would leave the ghost fill —
# the one state that used to have no fill at all — unasserted.
GHOST_IDENTITY="dr-ghost"
GHOST_CLASS="dock-recall-never-launched"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/dock-recall-panel-test.desktop"
GHOST_DESKTOP_FILE="$DESKTOP_DIR/dock-recall-ghost-test.desktop"

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

# Panel.qml's own account of its desktop-file scan (refreshDerivations),
# which is what iconNameIndex is built from — every iconSource/iconResolved
# assertion below is reading its answer. The scan starts only once the panel
# opens (it is logged "on the way IN, not only on success"), so this can only
# be polled AFTER the summon step, never before it.
desktop_scanned() { dr_log | grep -qE 'scanned [0-9]+ desktop files for launch commands'; }

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
# AND RE-DERIVING IT IS NOT ENOUGH ON ITS OWN. This clause is self-consistent by
# construction: it asks whether the reported tier equals chipTreatment(reported
# width, reported height), which a panel drawing a column of nameless icons
# satisfies perfectly — a 210x17 stacked row genuinely earns its tier, and the
# gate printed the regression as a pass. Two clauses below and one check after
# the recorded map give it teeth: every FALLBACK chip clears the same 16x10
# floor the positioned ones do (asserting it only where renderPath is
# "positioned" let a fallback lay every chip out at 0x0 and pass everything), a
# fallback chip must reach a tier that DRAWS ITS NAME, and a run must exercise
# more than one tier across its two maps.
#
# The empty-source clause is not pedantry: AppLibrary.iconSource cannot answer
# empty, because it falls back to application-x-executable, so an empty string
# here means either the panel never asked (no shell, and so no appLibrary) or
# the guest icon theme has no generic executable icon at all. The second would
# leave every unrecognised app drawing nothing, which is worth failing on.
#
# THE TWO COLOUR CHANNELS are asserted as two, and that is the point of them.
# `fillState` is the durable state — watched, ghost, unwatched, one fill each,
# where before the outline carried nearly all of it and the hover fill REPLACED
# the watched one. `edgeTone` is what the outline says, drift included. A
# drifted chip is fillState "watched" AND edgeTone "drift" at the same time, and
# a payload that folded the two into one field could not say so. The cross-check
# against `watched` is what stops a panel reporting a fill it did not draw:
# watched and unwatched are the map's own flag, and the fill has to follow it.
#
# THE HEADER is a PanelHero now, and three clauses say it did not lose anything
# in the move. `headerTitle` is what the hero was HANDED and `topologyName` is
# what the panel computed, so they agree by construction and a header that
# stopped being given one shows up as a disagreement. `headerMeta` has to
# contain the badge word AND end in a watched count, which is the whole of the
# status line the hero carries. And `badgeTone` is still one of four — the badge
# deliberately did NOT move into the hero own `detail` pill, whose border is one
# fixed colour, because four tones over six states is the only channel a glance
# uses (PanelModel.badgeFor, enumerated in tests/panel.test.js).
#
# THE BADGES: every workspace says what its number badge reads, and it must be
# that workspace's own name. At most one badge is the filled one — every monitor
# has an active workspace and only the focused monitor is in front of the user,
# so a second filled badge means the focus rule leaked across monitors. Zero is
# legitimate (a headless output set has no focus at all), which is why this is a
# ceiling rather than an equality.
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
        and (.pictured|type) == "boolean"
        and (.treatment == "pill" or .treatment == "badge" or .treatment == "strip"
             or .treatment == "veiled" or .treatment == "field")
        and (.fillState == "watched" or .fillState == "ghost" or .fillState == "unwatched")
        and (.edgeTone == "drift" or .edgeTone == "hover"
             or .edgeTone == "watched" or .edgeTone == "quiet"))]|length) == (.chips|length)
  and ([.chips[]|select(.watched == true and .fillState == "unwatched")]|length) == 0
  and ([.chips[]|select(.watched == false and .fillState != "unwatched")]|length) == 0
  and ([.chips[]|select(.watched == false and .pictured == true)]|length) == 0
  and ([.workspaces[]|select((.badgeValue|type) == "string" and (.badgeValue|length) > 0
        and (.badgeFocused|type) == "boolean")]|length) == (.workspaces|length)
  and ([.workspaces[]|select(.badgeValue != (.name|tostring))]|length) == 0
  and ([.workspaces[]|select(.badgeFocused == true)]|length) <= 1
  and ([.chips[]|select(.treatment != (
        if .width >= 140 and .height >= 56 then "pill"
        elif .width >= 56 and .height >= 40 then "badge"
        elif .width >= 140 and .height >= 16 then "strip"
        elif .width >= 24 and .height >= 16 then "veiled"
        else "field" end))]|length) == 0
  and ((.chips|map(.key)|unique|length) == (.chips|length))
  and ([.chips[]|select(.renderPath == "positioned"
        and (.placed == false or .width < $minw or .height < $minh))]|length) == 0
  and ([.chips[]|select(.renderPath == "fallback"
        and (.width < $minw or .height < $minh))]|length) == 0
  and ([.workspaces[]|select((.monitorName|type) == "string"
        and (.monitorName|length) > 0)]|length) == (.workspaces|length)
  and ([.chips[] as $c | $state.workspaces[]
        | select(.id == $c.workspaceId and .monitorName == $c.monitorName
                 and .renderPath != $c.renderPath)]|length) == 0
  and .headerTitle == .topologyName
  and (.headerMeta|type) == "string" and (.headerMeta|contains($state.badgeText))
  and (.headerMeta|test("[0-9]+ apps? watched"))
  and (.paused|type) == "boolean"
  and (.badgeText|type) == "string" and (.badgeText|length) > 0
  and (.badgeTone == "ok" or .badgeTone == "muted"
       or .badgeTone == "accent" or .badgeTone == "urgent")
  and (.overflowOpen|type) == "boolean" and (.overflowLayouts|type) == "array"
  and (.rows|type) == "array" and (.rows|length) > 0
  and ([.rows[]|select((.key|type) == "string" and (.key|length) > 0
        and (.name|type) == "string" and (.name|length) > 0
        and (.watched|type) == "boolean" and (.ghost|type) == "boolean"
        and (.iconSource|type) == "string" and (.iconSource|length) > 0
        and (.iconResolved|type) == "boolean"
        and (.pictured|type) == "boolean" and (.picturable|type) == "boolean"
        and (.linkKey|type) == "string" and (.linked|type) == "boolean")]|length) == (.rows|length)
  and ((.rows|map(.key)|unique|length) == (.rows|length))
  and ([.rows[]|select(.picturable == false and .pictured == true)]|length) == 0
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
    # The LIVE tab says nothing about when the layout was recorded — that is a
    # fact about the other tab, and "recorded 3 days ago" over the windows on
    # screen would be answering a question nobody asked of them.
    and (.headerMeta|test("recorded ")|not)
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
    # THE TWO COLOUR CHANNELS, on the POSITIONED path, and the whole claim in
    # one clause: the seeded app is recorded on a workspace it is not on, so it
    # is DRIFTED — and it reports the drift tone on its edge WHILE still
    # reporting the watched fill under it. A panel that spent one field on both
    # could not answer this, and a panel that let hover replace the watched fill
    # would drop the fill the moment the pointer crossed the map.
    and ([.chips[]|select(.key == $addr
          and .fillState == "watched" and .edgeTone == "drift")]|length) == 1
    and ([.chips[]|select(.key == $noicon and .fillState == "unwatched")]|length) == 1
    # The workspace the user is standing on is on the live map, and its badge is
    # the filled one.
    and ([.workspaces[]|select(.badgeFocused == true)]|length) == 1
    # THE APP LIST, all THREE row states at once. appRows builds three and a run
    # that exercised only the watched one would miss two: the seeded app is a
    # watched identity, the no-entry window is an unwatched live one, and the
    # identity that was never launched is a recorded GHOST.
    and ([.rows[]|select(.watched == true and .ghost == false)]|length) >= 1
    and ([.rows[]|select(.watched == false and .ghost == false)]|length) >= 1
    and ([.rows[]|select(.ghost == true)]|length) >= 1
    # The two whose apps have desktop entries resolve their OWN icon — the ghost
    # among them, which has no window and so no window class, so its row also
    # pins the identity fallback on the list side.
    and ([.rows[]|select(.watched == true and .ghost == false
          and .iconResolved == true and .iconSource == $icon)]|length) >= 1
    and ([.rows[]|select(.ghost == true
          and .iconResolved == true and .iconSource == $icon)]|length) == 1
    # And the window no desktop file claims draws the generic icon on its row
    # exactly as on its chip: never empty, never claimed as its own. The row is
    # found through the LINK KEY its chip reports, which is the pairing the
    # hover uses — so this clause is also the structural half of "a row and its
    # chips are the same app".
    and ([$state.chips[]|select(.key == $noicon)|.linkKey] as $link
         | [.rows[]|select(.linkKey == $link[0]
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
    # THE DATED RECORDED HEADER. The layout was seeded seconds ago through the
    # engine, so the age it earns is "recorded just now" — and the assertion is
    # that the hero SAYS it, not merely that the panel could compute it.
    and (.recordedAge|type) == "string" and (.recordedAge|length) > 0
    and (.headerMeta|contains($state.recordedAge))
    and ([.chips[]|select(.renderPath == "fallback")]|length) == (.chips|length)
    # A FALLBACK CHIP SAYS ITS NAME. The assertion whose absence let a
    # user-visible regression ship: the label was gated on the pill tier alone,
    # a stacked row is a fixed 17 px tall and can never reach it, and the whole
    # Recorded tab became nameless icons under a 55% veil while every other
    # clause here stayed green. The tiers that draw a name are pill and strip —
    # this asks for the OUTCOME the user sees, not for a tier by name, which is
    # why it lists both rather than pinning the one the stack happens to earn.
    and ([.chips[]|select(.renderPath == "fallback"
          and (.treatment == "pill" or .treatment == "strip"))]|length) > 0
    # THE SAME ICON, on the FALLBACK path — the half that matters, because the
    # stacked branch is the one that has hidden a broken model before. The
    # recorded chip has no window and therefore no window class at all, so this
    # also pins that the lookup falls back to the IDENTITY: an icon resolved by
    # class alone would report nothing here.
    and ([.chips[]|select(.renderPath == "fallback"
          and .iconSource == $icon and .iconResolved == true)]|length) > 0
    # THE GHOST FILL, which only this map can show: a ghost is by definition an
    # app that is not running, so it has no live chip anywhere. It is the state
    # that had no fill of its own at all before — recorded-but-closed was told
    # apart by a dashed outline and a drop in opacity, on a panel where the
    # outline was already carrying watched, hover and drift.
    and ([.chips[]|select(.fillState == "ghost")]|length) == 1
    # And the running app is recorded here too, so this map shows both fills at
    # once — which is what makes them distinct rather than merely present.
    and ([.chips[]|select(.fillState == "watched")]|length) == 1
    # The badge, on the FALLBACK path. The ghost is recorded on the workspace
    # the user is standing on, so this map carries it and its badge is filled.
    and ([.workspaces[]|select(.badgeFocused == true)]|length) == 1
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
  rm -f "$DESKTOP_FILE" "$GHOST_DESKTOP_FILE" 2>/dev/null
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

# And one for the app that is never launched. Its identity is watched and
# recorded, so it draws a GHOST row and a ghost chip — and neither has a window,
# which means neither has a window class either. Giving it an entry is what
# lets those two prove the lookup falls back to the IDENTITY's own patterns: an
# icon resolved by class alone would report nothing for a ghost.
cat > "$GHOST_DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Dock Recall Ghost Test
Exec=foot --app-id=$GHOST_CLASS
StartupWMClass=$GHOST_CLASS
Icon=$ICON_PATH
DESKTOP
pass "desktop entries for $APP_CLASS and $GHOST_CLASS naming Icon=$ICON_PATH (panel IPC)"

# ------------------------------------------------------------ 2. run the app

pkill -f "foot --title=$APP_TITLE" 2>/dev/null
launch_app "foot --title=$APP_TITLE"
wait_until "watched app window appeared (panel IPC)" 30 app_present

APP_WS=$(clients | jq -r --arg t "$APP_TITLE" 'first(.[]|select(.initialTitle==$t)|.workspace.id)//empty')
[[ -n $APP_WS ]] || fail "app has a workspace (panel IPC)"

# Anywhere the window is not. The layout records the running app HERE, which is
# what makes it drifted; the ghost stays on $APP_WS so the recorded map also
# carries the workspace the user is actually standing on, and its badge can be
# the filled one on the fallback path.
DRIFTED_WS=$((APP_WS + 1))

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
    },
    {
      "id": "$GHOST_IDENTITY",
      "patterns": ["^$GHOST_CLASS\$"],
      "launch": "foot --app-id=$GHOST_CLASS"
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
if ! poll 30 state_loaded 2 0; then
  diagnostics
  fail "the service read back the seeded identities (panel IPC)" \
    "no 'state loaded: 2 identities, 0 layouts' from the service after the identity seed"
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
  var ghostId = process.argv[5], driftedWs = Number(process.argv[6]);

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
      // Recorded somewhere the window is NOT, on purpose: that is what makes
      // this app DRIFTED, and drift is the state the two colour channels have
      // to be able to say at once — the drift tone on the edge while the
      // watched fill stays under it.
      identityId: identityId,
      monitorDescription: engine.monitorLabel(monitor),
      workspaceId: driftedWs,
      floating: false,
      group: null
    }, {
      // The ghost: recorded here, and nothing on the desk matches its
      // identity, so the recorded map draws it as a place rather than a
      // window. Same workspace as the app above, which is what makes the two
      // fills sit side by side on one canvas.
      identityId: ghostId,
      monitorDescription: engine.monitorLabel(monitor),
      workspaceId: ws,
      floating: false,
      group: null
    }]
  };
  fs.writeFileSync(statePath + ".seed", StateModel.serializeState(StateModel.upsertLayout(state, layout)));
  fs.renameSync(statePath + ".seed", statePath);
  process.stdout.write(layout.recordedAt);
' "$PLUGIN_DIR" "$STATE" "$IDENTITY" "$APP_WS" "$GHOST_IDENTITY" "$DRIFTED_WS") ||
  fail "geometry-less layout recorded for this topology (panel IPC)"
[[ -n $RECORDED_AT ]] || fail "layout recorded (panel IPC)" "the seed printed no recordedAt"

# Same again for the layout: the panel reads the state the SERVICE holds, so the
# recorded map cannot be asked about until the service has taken the layout up.
if ! poll 30 state_loaded 2 1; then
  diagnostics
  fail "the service read back the seeded layout (panel IPC)" \
    "no 'state loaded: 2 identities, 1 layouts' from the service after the layout seed"
fi
pass "seeded: $IDENTITY watched and running, $GHOST_IDENTITY watched and never launched, in a layout with NO geometry (recordedAt $RECORDED_AT)"

# The drift is a fact the SERVICE computes, and the panel only reads it. Waited
# for HERE, with its own sentence, so a service that never reported drift fails
# where that is what happened rather than as a payload poll timing out five
# steps later with nothing to say about why.
drift_reported() { dr_log | grep -qE "status published .*drift=[1-9]"; }
if ! poll 30 drift_reported; then
  diagnostics
  fail "the service reports the seeded app as drifted (panel IPC)" \
    "no 'drift=<n>' above zero from the service, though $IDENTITY is on ws $APP_WS and recorded on ws $DRIFTED_WS"
fi
pass "the service reports drift: $IDENTITY is on ws $APP_WS and recorded on ws $DRIFTED_WS"

# ------------------------------------------------------- 4. summon the panel

omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "panel layer '$PANEL_NAMESPACE' appeared" "the panel never mapped a layer surface"
fi
screenshot "success-dock-recall-panel-01-open"
pass "panel summoned and its layer '$PANEL_NAMESPACE' is mapped"

# The icon assertions on both maps below (iconSource/iconResolved, on chips
# AND rows) all key on ONE scan: PanelModel.iconNameIndex is built from
# root.desktopFiles, and that array is empty until Panel.qml's own scan lands
# — which starts only now, on this summon (refreshDerivations), and not
# before it. The budget is sized for a COLD VM, not this sandbox: the sandbox
# has only a handful of .desktop files and would never exercise the wait,
# while the guest this test actually runs against ships ~87 of them across
# four directories, each read as its own grep in a bash loop, on a disk cache
# that has not warmed up yet. 90s covers that with room to spare; a warm guest
# clears it in well under a second.
if ! poll 90 desktop_scanned; then
  diagnostics
  fail "the desktop-file scan completed (panel IPC)" \
    "no 'scanned <n> desktop files for launch commands' from the service after the panel opened — the icon and desktop-entry assertions below would be reading a still-empty desktopFiles"
fi
pass "desktop-file scan completed; icon lookups below are reading its answer"

# ------------------------------------------------- 5. the LIVE map, over IPC

# Polled rather than read once: the panel's own hyprctl reads are a process
# spawn away and its delegates report a frame after that. The poll CAPTURES the
# payload it validated into $LIVE_JSON — everything below reads that one, so the
# numbers in the pass lines are the numbers that passed.
if ! poll 30 capture_live_state; then
  diagnostics
  # Named per clause rather than left as "the shape failed": capture_live_state
  # is one jq predicate over chips, rows AND workspaces, but this message used
  # to describe only the chip and workspace clauses — so a ROW clause failing
  # (tick sm1: a row's iconResolved disagreeing with its own chip's) printed a
  # paragraph about chips that were fine, and a full gate cycle went to a
  # wrong diagnosis before anyone thought to suspect the row side at all. If
  # you are reading this because the run failed, replay $LIVE_JSON (or the
  # last payload in the diagnostics above) against each clause in
  # capture_live_state with jq to find the one that is false; do not assume
  # it is a chip clause just because the chip clauses are listed first below.
  fail "panel IPC reports the live map" \
    "no live payload from '$IPC_TARGET state' satisfied the shape:
       CHIPS — uniquely-keyed, each placed above the ${CHIP_MIN_W}x${CHIP_MIN_H} floor on the positioned path, each carrying a non-empty iconSource and a treatment its own width and height earn, one of them the watched window $APP_ADDRESS reporting $ICON_URL resolved and fill=watched with edge=drift, $NOICON_ADDRESS reporting the generic icon unresolved and fill=unwatched;
       ROWS — all three of appRows' states present at once (watched/live, unwatched/live, ghost/recorded); the watched non-ghost row AND the ghost row (which has no window class, so this pins the identity-side fallback) both reporting $ICON_URL resolved; the no-entry window's row, found through its chip's own linkKey, reporting the generic icon unresolved with a non-empty source;
       WORKSPACES — exactly one workspace badge filled
       (see the raw payload above)"
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

live_fills=$(printf '%s' "$LIVE_JSON" | jq -r \
  '[.chips[]|"\(.key) fill=\(.fillState) edge=\(.edgeTone)"]|join(", ")')
pass "POSITIONED fills and edges, two channels: $live_fills"

live_badges=$(printf '%s' "$LIVE_JSON" | jq -r \
  '[.workspaces[]|"\(.monitorName)/\(.badgeValue)\(if .badgeFocused then " (focused)" else "" end)"]|join(", ")')
pass "POSITIONED workspace badges: $live_badges"

# The app list. All three of appRows' row states are required by the poll; this
# says which row came out as which, so a run in which one state never appeared
# would be visible rather than merely passing a ">= 1".
live_rows=$(printf '%s' "$LIVE_JSON" | jq -r \
  '[.rows[]|"\(.name) watched=\(.watched) ghost=\(.ghost) icon=\(if .iconResolved then "own" else "generic" end)"]|join(", ")')
pass "app list rows, all three states on Ui/Toggle: $live_rows"

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

# And the same fact in words, derived from THAT stamp rather than from a file
# mtime — the state file holds every topology's layout, so its mtime is the last
# time any of them changed. Present on both tabs (it is a fact about the
# recording, not about the tab); only the RECORDED tab puts it in the header,
# which the two view predicates assert from opposite sides.
if ! printf '%s' "$LIVE_JSON" | jq -e 'has("recordedAge")' >/dev/null; then
  diagnostics
  fail "panel IPC reports how old the recording is" \
    "recordedAge is ABSENT while recordedAt is present — the two travel together"
fi
reported_age=$(printf '%s' "$LIVE_JSON" | jq -r '.recordedAge')
pass "and how old it is, in words, from that same stamp ($reported_age)"

# --------------------------------------------- 6. the RECORDED map, over IPC

view_answer=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
if [[ $view_answer != "recorded" ]]; then
  diagnostics
  fail "panel IPC switches to the recorded map" "setView recorded answered '$view_answer'"
fi

if ! poll 30 capture_recorded_state; then
  diagnostics
  fail "panel IPC reports the recorded map" \
    "no recorded payload from '$IPC_TARGET state' satisfied the shape: uniquely-keyed chips, all on the FALLBACK path, each above the ${CHIP_MIN_W}x${CHIP_MIN_H} floor, at least one of them reaching a tier that DRAWS ITS NAME (pill or strip — a stacked row is canvas-wide and one line tall, and gating the name on the pill tier alone is what emptied this tab once), agreeing with their own workspace on their own monitor, at least one resolving its identity icon to $ICON_URL, exactly one fill=ghost ($GHOST_IDENTITY) beside exactly one fill=watched, and exactly one workspace badge filled (see the raw payload above)"
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

# THE NAME, on the fallback path. Required by the poll above; restated here so
# the chip that proves it lands in the log, because the log is where this went
# wrong last time — "veiled 210x17, veiled 210x17" printed as a pass while the
# Recorded tab had lost every app name it had.
recorded_named=$(printf '%s' "$RECORDED_JSON" | jq -r \
  'first(.chips[]|select(.treatment == "pill" or .treatment == "strip")
     |"\(.key) \(.treatment) at \(.width|floor)x\(.height|floor)")//"NONE"')
pass "FALLBACK chips reach a tier that draws the app's name ($recorded_named)"

recorded_fills=$(printf '%s' "$RECORDED_JSON" | jq -r \
  '[.chips[]|"\(.key) fill=\(.fillState) edge=\(.edgeTone)"]|join(", ")')
pass "FALLBACK fills and edges, the ghost among them: $recorded_fills"

recorded_badges=$(printf '%s' "$RECORDED_JSON" | jq -r \
  '[.workspaces[]|"\(.monitorName)/\(.badgeValue)\(if .badgeFocused then " (focused)" else "" end)"]|join(", ")')
pass "FALLBACK workspace badges: $recorded_badges"

recorded_header=$(printf '%s' "$RECORDED_JSON" | jq -r '.headerMeta')
pass "the Recorded tab says when it was recorded: \"$recorded_header\""

# The two views are the two paths, and they are not the same chips: a payload
# that reported one constant for renderPath would have failed one of the two
# assertions above, and a payload that never rebuilt would fail this one.
live_keys=$(printf '%s' "$LIVE_JSON" | jq -c '[.chips[].key]|sort')
recorded_keys=$(printf '%s' "$RECORDED_JSON" | jq -c '[.chips[].key]|sort')
if [[ $live_keys == "$recorded_keys" ]]; then
  diagnostics
  fail "the two maps report their own chips" "both views reported the same chip keys: $live_keys"
fi

# THE LADDER IS A LADDER, and this run climbed more than one rung of it. Every
# clause so far is satisfied by a panel that answers ONE tier for every chip it
# ever draws — the re-derivation would agree with it, because it agrees with
# whatever chipTreatment says. A collapse to a single tier (a cutoff moved, a
# geometry that stopped varying, the drawn size stopped being asked for) is a
# real product failure and it was visible only to a human reading the tier list
# in the log. Across the two maps, because the two maps are the two shapes: real
# windows are window-shaped and the stacked rows are wide-and-short, so one tier
# across both means one of them stopped being itself.
run_tiers=$(jq -rn --argjson live "$LIVE_JSON" --argjson recorded "$RECORDED_JSON" \
  '[($live.chips[], $recorded.chips[])|.treatment]|unique|join(", ")')
run_tier_count=$(jq -rn --argjson live "$LIVE_JSON" --argjson recorded "$RECORDED_JSON" \
  '[($live.chips[], $recorded.chips[])|.treatment]|unique|length')
if ((run_tier_count < 2)); then
  diagnostics
  fail "the treatment ladder has more than one rung in a run" \
    "every chip on both maps came out as the same tier: $run_tiers.
       The ladder is meant to answer differently for a window-shaped chip and for a canvas-wide stacked row; one answer for both means a cutoff, the drawn size, or a whole render path stopped varying. Re-deriving the tier from the reported size cannot catch this — it agrees with a collapsed ladder as readily as with a working one."
fi
pass "the ladder answered $run_tier_count tiers across the run's two maps: $run_tiers"

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

# ------------------------------------- 7. the header: hero, Pause, overflow
#
# LAST on purpose. Pausing the tool changes what the badge says, and every
# assertion above wanted the badge the seeded desk earns; running this first
# would have made the drifted badge unreachable without a second wait for it to
# come back.

header_line=$(printf '%s' "$LIVE_JSON" | jq -r \
  '"\(.headerTitle) | \(.headerMeta) | badge \(.badgeText)/\(.badgeTone)"')
pass "the header is a PanelHero carrying the topology, the status line and the badge: $header_line"

# PAUSE, driven the way a finger drives the switch — through the panel's own
# setPaused, which is the one place that re-reads the file before writing and
# refuses a write that would be rejected.
was_paused=$(printf '%s' "$LIVE_JSON" | jq -r '.paused')
if [[ $was_paused != "false" ]]; then
  diagnostics
  fail "the tool starts un-paused (panel IPC)" "the payload reports paused=$was_paused before anything touched it"
fi

pause_answer=$(omarchy-shell "$IPC_TARGET" setPaused on 2>&1)
if [[ $pause_answer != "paused" ]]; then
  diagnostics
  fail "panel IPC pauses the tool" "setPaused on answered '$pause_answer'"
fi

# The switch's own position AND the badge that follows from it. `Paused` outranks
# `Drifted` on the badge for the same reason it does on the bar glyph: a repair
# that is not going to happen is not news.
paused_seen() {
  panel_state_json | jq -e '.paused == true and .badgeText == "Paused" and .badgeTone == "muted"' >/dev/null
}
if ! poll 20 paused_seen; then
  diagnostics
  fail "the paused switch and the paused badge agree" \
    "after setPaused on, the payload never reported paused=true with badge Paused/muted"
fi
pass "Pause flips the reported switch position and the badge follows it (Paused/muted)"

resume_answer=$(omarchy-shell "$IPC_TARGET" setPaused off 2>&1)
if [[ $resume_answer != "active" ]]; then
  diagnostics
  fail "panel IPC un-pauses the tool" "setPaused off answered '$resume_answer'"
fi
active_seen() {
  panel_state_json | jq -e '.paused == false and .badgeText != "Paused"' >/dev/null
}
if ! poll 20 active_seen; then
  diagnostics
  fail "the switch goes back" "after setPaused off, the payload never reported paused=false again"
fi
resumed_badge=$(panel_state_json | jq -r '"\(.badgeText)/\(.badgeTone)"')
pass "and back: paused=false, and the badge is the desk again ($resumed_badge)"

# THE OVERFLOW MENU. `overflowLayouts` is reported by the row DELEGATES and
# gated on `overflowOpen` at read time (tick be1: the delegates themselves live
# for the whole panel session, not just while the popup is up — a shut menu
# reports none because panelState() only reads their reports while
# overflowOpen is true, not because the delegates come and go). This topology
# is recorded, so exactly one row is the current one.
overflow_answer=$(omarchy-shell "$IPC_TARGET" setOverflow open 2>&1)
if [[ $overflow_answer != "open" ]]; then
  diagnostics
  fail "panel IPC opens the overflow menu" "setOverflow open answered '$overflow_answer'"
fi
overflow_listed() {
  panel_state_json | jq -e '.overflowOpen == true
    and (.overflowLayouts|length) > 0
    and ([.overflowLayouts[]|select(.current == true)]|length) == 1' >/dev/null
}
if ! poll 20 overflow_listed; then
  diagnostics
  # Named per clause (tick be1: the three conjuncts printed nothing on the
  # gate run that first exercised this assertion) — replay the numbers below
  # rather than re-deriving them from the raw payload above.
  overflow_conjuncts=$(panel_state_json | jq -c '{
    overflowOpen,
    overflowLayoutsLength: (.overflowLayouts|length),
    currentCount: ([.overflowLayouts[]|select(.current == true)]|length)
  }' 2>&1)
  fail "the overflow menu lists the recorded layouts" \
    "after setOverflow open, the payload never reported drawn layout rows with exactly one marked current
       (overflowOpen, overflowLayouts length, and the current count): $overflow_conjuncts"
fi
overflow_rows=$(panel_state_json | jq -r \
  '[.overflowLayouts[]|"\(.name)\(if .current then " (current)" else "" end)"]|join(", ")')
screenshot "success-dock-recall-panel-03-overflow"
pass "the overflow menu opens and lists its recorded layouts: $overflow_rows"

closed_answer=$(omarchy-shell "$IPC_TARGET" setOverflow closed 2>&1)
if [[ $closed_answer != "closed" ]]; then
  diagnostics
  fail "panel IPC closes the overflow menu" "setOverflow closed answered '$closed_answer'"
fi
overflow_gone() {
  panel_state_json | jq -e '.overflowOpen == false and (.overflowLayouts|length) == 0' >/dev/null
}
if ! poll 20 overflow_gone; then
  diagnostics
  fail "a shut overflow menu lists nothing" \
    "after setOverflow closed, the payload still reported drawn layout rows"
fi
pass "and a shut menu reports no rows — the list is what was drawn, not what is on disk"

# ------------------------------- 7b. ticking a row, and the row-to-chip link
#
# THE LINK first, because it is what the tick below is then found through.
#
# One key, and everything that answers to it lights up on BOTH surfaces at once.
# Driven by setting the key rather than by a pointer: `hoveredLinkKey` is exactly
# what a hover on either surface sets, and a virtual pointer is a live-session
# rig this increment does not use.
seeded_link=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$APP_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey)//empty')
[[ -n $seeded_link ]] ||
  fail "the seeded chip reports a link key (panel IPC)" "no linkKey on the chip keyed $APP_ADDRESS"

hover_answer=$(omarchy-shell "$IPC_TARGET" hoverLink "$seeded_link" 2>&1)
if [[ $hover_answer != "$seeded_link" ]]; then
  diagnostics
  fail "panel IPC can light a link" "hoverLink answered '$hover_answer', expected '$seeded_link'"
fi

link_lit() {
  panel_state_json | jq -e --arg link "$seeded_link" '
    .hoveredLinkKey == $link
    and ([.rows[]|select(.linkKey == $link and .linked == true)]|length) == 1
    and ([.chips[]|select(.linkKey == $link and .linked == true)]|length) >= 1
    and ([.rows[]|select(.linkKey != $link and .linked == true)]|length) == 0
    and ([.chips[]|select(.linkKey != $link and .linked == true)]|length) == 0' >/dev/null
}
if ! poll 20 link_lit; then
  diagnostics
  fail "hovering an app lights its row AND its chips, and nothing else" \
    "with hoveredLinkKey '$seeded_link', the payload did not report exactly that row and its chips linked"
fi
pass "the row-to-chip link still pairs them: '$seeded_link' lights its row and its chips, and nothing else"

cleared=$(omarchy-shell "$IPC_TARGET" hoverLink none 2>&1)
[[ $cleared == "none" ]] || fail "panel IPC clears the link" "hoverLink none answered '$cleared'"
link_dark() {
  panel_state_json | jq -e '.hoveredLinkKey == ""
    and ([.rows[]|select(.linked == true)]|length) == 0
    and ([.chips[]|select(.linked == true)]|length) == 0' >/dev/null
}
if ! poll 20 link_dark; then
  diagnostics
  fail "the link goes out again" "after hoverLink none, something is still reported as linked"
fi
pass "and it goes out again on both surfaces"

# TICKING A ROW. Ui/Toggle's clicked() calls root.toggleChip(row) and nothing
# else, and `toggleRow` is that call on the row carrying a given key — pressing
# the widget itself would need the same virtual pointer this venue does not have.
#
# The row ticked is the NO-ENTRY window, not the seeded one: unticking the seeded
# app would delete the identity its recorded layout names, and ticking it back
# would mint a new id rather than restore `dr-panel`. This one is unwatched to
# begin with, so the round trip really is a round trip.
#
# The proof is that both surfaces move in ONE query. The row's `watched` and the
# chip's `fillState` are written by two different delegates reporting
# independently, so a payload in which only one of them changed is a real split
# between the list and the map — which is exactly what a row that stopped
# driving toggleChip would look like.
noicon_link=$(panel_state_json | jq -r --arg addr "$NOICON_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey)//empty')
noicon_row_key=$(panel_state_json | jq -r --arg link "$noicon_link" \
  'first(.rows[]|select(.linkKey == $link)|.key)//empty')
if [[ -z $noicon_row_key ]]; then
  diagnostics
  fail "the no-entry window has a row of its own (panel IPC)" \
    "no row reports the link key '$noicon_link' that its chip does"
fi

tick_answer=$(omarchy-shell "$IPC_TARGET" toggleRow "$noicon_row_key" 2>&1)
if [[ $tick_answer != "toggled" ]]; then
  diagnostics
  fail "panel IPC ticks a row" "toggleRow '$noicon_row_key' answered '$tick_answer'"
fi

# Found through the CHIP's key, which is the window address and does not change
# — the row's own key and link key both do, because a ticked window stops being
# a class row and becomes an identity row.
row_and_chip() {
  panel_state_json | jq -e --arg addr "$NOICON_ADDRESS" --arg want "$1" '
    [.chips[]|select(.key == $addr)] as $c
    | ($c|length) == 1
    and $c[0].fillState == $want
    and ([.rows[]|select(.linkKey == $c[0].linkKey
          and .watched == ($want == "watched"))]|length) == 1' >/dev/null
}
if ! poll 20 row_and_chip watched; then
  diagnostics
  fail "ticking a row moves the row AND its chip" \
    "after toggleRow '$noicon_row_key', the payload never reported that row watched with its chip filled as watched in the same query"
fi
pass "a tick through the row flips its own watched flag and its chip's fill together"

reticked_key=$(panel_state_json | jq -r --arg addr "$NOICON_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey) as $l | first(.rows[]|select(.linkKey == $l)|.key)//empty')
untick_answer=$(omarchy-shell "$IPC_TARGET" toggleRow "$reticked_key" 2>&1)
if [[ $untick_answer != "toggled" ]]; then
  diagnostics
  fail "panel IPC unticks a row" "toggleRow '$reticked_key' answered '$untick_answer'"
fi
if ! poll 20 row_and_chip unwatched; then
  diagnostics
  fail "unticking puts both back" \
    "after unticking '$reticked_key', the row and its chip did not both go back to unwatched"
fi
pass "and unticking puts both back — the list and the map never disagree"

# ------------------------------------------- 7c. the SECOND consent (tick qnc)
#
# WATCHED IS NOT PICTURED. Watching an app means the tool may MOVE its windows.
# Picturing it means the tool may PHOTOGRAPH them at Record and keep the picture
# on disk — a change in category, not a feature — so it is a separate grant and
# it defaults OFF. The whole of this section is the claim that the two flags are
# INDEPENDENT, which is a claim a payload carrying one of them could not make.
#
# Driven through `setPictured <row key> on|off`, which is the panel's own
# setPicturedFor and nothing else: a fresh read of the file, the one-field
# StateModel setter, and a log line gated on the write. Pressing the camera
# itself would need a virtual pointer, which is a live-session rig this
# increment does not use.
#
# The row driven is the SEEDED app, not the no-entry one: only a watched
# identity has a `pictured` field to move, and the seeded app is the one this
# test knows is watched by name.

# Nothing has granted anything yet, so nothing is pictured anywhere — the
# default, asserted before it is changed so the flip below has a floor.
before_pictured=$(panel_state_json | jq -r \
  '[([.rows[]|select(.pictured == true)]|length),
    ([.chips[]|select(.pictured == true)]|length)]|join("/")')
if [[ $before_pictured != "0/0" ]]; then
  diagnostics
  fail "pictured defaults off everywhere (panel IPC)" \
    "$before_pictured row(s)/chip(s) already report pictured:true before anything granted it"
fi

# Only the two watched identities can be pictured at all. The unwatched live
# window and the orphaned ghost report picturable:false and draw no camera — an
# affordance that wrote nowhere is the bug this flag exists to prevent.
picturable_rows=$(panel_state_json | jq -r '[.rows[]|select(.picturable == true)]|length')
if ! [[ $picturable_rows =~ ^[0-9]+$ ]] || ((picturable_rows < 1)); then
  diagnostics
  fail "a watched row offers the consent (panel IPC)" \
    "no row reports picturable:true, so no camera is drawn anywhere"
fi
pass "pictured defaults off on every row and every chip; $picturable_rows row(s) can grant it"

seeded_row_key=$(panel_state_json | jq -r --arg addr "$APP_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey) as $l
   | first(.rows[]|select(.linkKey == $l and .picturable == true)|.key)//empty')
if [[ -z $seeded_row_key ]]; then
  diagnostics
  fail "the seeded app has a picturable row (panel IPC)" \
    "no picturable row shares the link key of the chip keyed $APP_ADDRESS"
fi

# A row with nothing to grant WITH answers so, rather than writing nowhere and
# reporting success. Found through the no-entry window, which step 7b left
# unwatched.
noicon_row_now=$(panel_state_json | jq -r --arg addr "$NOICON_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey) as $l
   | first(.rows[]|select(.linkKey == $l)|.key)//empty')
if [[ -n $noicon_row_now ]]; then
  refused=$(omarchy-shell "$IPC_TARGET" setPictured "$noicon_row_now" on 2>&1)
  [[ $refused == "not-picturable" ]] ||
    fail "an unwatched row refuses the consent (panel IPC)" \
      "setPictured '$noicon_row_now' on answered '$refused', expected 'not-picturable'"
fi
missing_answer=$(omarchy-shell "$IPC_TARGET" setPictured "no-such-row" on 2>&1)
[[ $missing_answer == "no-row" ]] ||
  fail "a key that names no row is refused (panel IPC)" \
    "setPictured 'no-such-row' on answered '$missing_answer', expected 'no-row'"
pass "the consent is refused where there is nothing to grant it with (not-picturable, no-row)"

grant=$(omarchy-shell "$IPC_TARGET" setPictured "$seeded_row_key" on 2>&1)
if [[ $grant != "on" ]]; then
  diagnostics
  fail "panel IPC grants the picture consent" \
    "setPictured '$seeded_row_key' on answered '$grant'"
fi

# ONE app, ONE flag. The row is still watched, its chips are still watched, and
# NOTHING ELSE on either surface became pictured — which is what "the two are
# independent" means when written down.
only_this_pictured() {
  panel_state_json | jq -e --arg row "$seeded_row_key" --arg addr "$APP_ADDRESS" --arg want "$1" '
    ([.rows[]|select(.key == $row and .pictured == ($want == "on")
       and .watched == true and .picturable == true)]|length) == 1
    and ([.chips[]|select(.key == $addr and .pictured == ($want == "on")
          and .watched == true)]|length) == 1
    and ([.rows[]|select(.key != $row and .pictured == true)]|length) == 0' >/dev/null
}
if ! poll 20 only_this_pictured on; then
  diagnostics
  fail "granting the consent moves pictured and nothing else" \
    "after setPictured '$seeded_row_key' on, the payload never reported that row pictured AND still watched with no other row pictured"
fi

# THE FILE, not just the payload. `pictured` is written by StateModel.setPictured
# — one field on one identity — so the watched list on disk has to be
# byte-identical apart from that flag. A setter that rebuilt the identity list
# would pass every clause above and still have dropped a pattern.
file_check=$(jq -r --arg id "$IDENTITY" --arg ghost "$GHOST_IDENTITY" '
  [(.identities|length),
   (first(.identities[]|select(.id == $id)|.pictured)|tostring),
   (first(.identities[]|select(.id == $ghost)|.pictured)|tostring),
   (first(.identities[]|select(.id == $id)|.patterns|join(","))),
   (first(.identities[]|select(.id == $id)|.launch))]|join("|")' "$STATE" 2>/dev/null)
expected_file="2|true|false|^$APP_CLASS\$|foot --title=$APP_TITLE"
if [[ $file_check != "$expected_file" ]]; then
  diagnostics
  fail "the grant reaches the file and touches one field" \
    "the state file reads '$file_check', expected '$expected_file'"
fi
pass "the consent is granted on $IDENTITY alone: pictured true, watched unchanged, $GHOST_IDENTITY untouched"

# IT SURVIVES A SHELL RESTART, which is the only thing that separates a flag
# held in a panel property from a consent the user actually gave. The panel dies
# with the shell, so this also re-establishes it from scratch.
omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after the consent restart (panel IPC)" 60 pgrep -f 'quickshell -n -p'
wait_until "service is live again after the consent restart (panel IPC)" 60 service_ready
omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "the panel comes back after the consent restart" "the panel never mapped its layer again"
fi
if ! poll 90 desktop_scanned; then
  diagnostics
  fail "the desktop-file scan completed after the consent restart (panel IPC)" \
    "no 'scanned <n> desktop files' line after the restart"
fi
restart_row_key=$(panel_state_json | jq -r --arg addr "$APP_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey) as $l
   | first(.rows[]|select(.linkKey == $l and .picturable == true)|.key)//empty')
if [[ -z $restart_row_key ]]; then
  diagnostics
  fail "the seeded app still has a picturable row after the restart" "no picturable row for $APP_ADDRESS"
fi
seeded_row_key="$restart_row_key"
if ! poll 30 only_this_pictured on; then
  diagnostics
  fail "the consent survives a shell restart" \
    "after restarting the shell, the payload does not report $IDENTITY pictured and watched"
fi
pass "and it survives a shell restart — a fresh panel reads the same consent back"

# AND BACK. Withdrawing leaves the app watched, which is the other direction of
# the same independence claim.
withdraw=$(omarchy-shell "$IPC_TARGET" setPictured "$seeded_row_key" off 2>&1)
if [[ $withdraw != "off" ]]; then
  diagnostics
  fail "panel IPC withdraws the picture consent" \
    "setPictured '$seeded_row_key' off answered '$withdraw'"
fi
if ! poll 20 only_this_pictured off; then
  diagnostics
  fail "withdrawing the consent leaves the app watched" \
    "after setPictured '$seeded_row_key' off, the payload never reported that row unpictured AND still watched"
fi
withdrawn_file=$(jq -r --arg id "$IDENTITY" \
  '[(.identities|length), (first(.identities[]|select(.id == $id)|.pictured)|tostring)]|join("|")' \
  "$STATE" 2>/dev/null)
[[ $withdrawn_file == "2|false" ]] ||
  fail "the withdrawal reaches the file" \
    "the state file reads '$withdrawn_file', expected '2|false'"
pass "and withdrawing it leaves $IDENTITY watched — the two consents move independently"

# ---------------------------------------------------------- 8. leave it closed

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
if ! poll 20 panel_layer_absent; then
  diagnostics
  fail "panel dismissed" "the panel's layer '$PANEL_NAMESPACE' is still mapped"
fi
pass "panel dismissed; the desk is back for the tests after this one"

capture_service_log
pass "dock-recall panel IPC: chips keyed and reported on both render paths, positioned and fallback"
