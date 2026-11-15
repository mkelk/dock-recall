#!/bin/bash
# dock-recall-motion-test.sh — that the motion is WIRED, in the VM (Tier C).
#
# Runs INSIDE a disposable Omarchy VM booted by omarchy-iso's harness, in a real
# Hyprland session with a real Quickshell shell.
#
# WHAT THIS FILE CAN AND CANNOT SAY, stated first because the whole design of it
# follows from the limit. This venue cannot watch a colour cross, a chip travel
# or a band sweep: there are no golden images, no Pillow on host or guest, and
# `undock-locked.sh` measured (2026-09-02) that the emulated framebuffer goes on
# showing a normal desktop while the session is genuinely locked, so a screendump
# here is an artifact and never evidence. The morph's definition of done is scoped to that limit
# in as many words — *that motion is wired, not that it looks right* — and
# whether the morph FEELS right is the human's own gate for it, not
# something any assertion below stands in for.
#
# So every claim here is of one of exactly three shapes:
#
#   A DURATION THAT CAME OFF AN ANIMATION OBJECT. Every number in the payload is
#   read from the animating thing itself — `fillFade.duration`,
#   `edgeFade.duration`, `morphFade.duration`, `glyphFade.duration`,
#   `sweepRun.duration` — and never from Motion.qml's tokens. That is what makes
#   "non-zero" worth asserting: a Behavior somebody deleted leaves an unresolved
#   id, the report falls to 0, and this test fails. A number restated from
#   Motion.qml and compared to the payload would agree with a panel that had
#   stopped animating altogether, which is why nothing below re-derives one.
#
#   A COUNTER THE ANIMATION ITSELF WROTE. `morph.runs` and `morph.settled` are
#   incremented by `morphFade`'s own `started` and `finished` handlers. `runs`
#   going up proves a morph BEGAN; `settled` catching up proves it ENDED, which
#   is the hard half — a flag that latches true proves nothing.
#
#   A SET THE PURE FUNCTION RETURNED. `morph.pairs`, `liveOnly` and
#   `recordedOnly` are `PanelModel.mapMorphPairs`'s own answer, projected once
#   (Panel.qml pairs the two maps into `root.morph`, and the animation, the
#   per-chip `morphRole` and the payload all read that one object). Asserting on
#   them is the only evidence available that the RIGHT chips morphed.
#
# `morph.active` IS NOT ASSERTED TRUE ANYWHERE, AND THAT IS DELIBERATE. The
# morph lasts 120 ms and an `omarchy-shell dock-recall state` round trip does
# not reliably land inside it, so `active == true` after a `setView` is a race
# whichever way it comes out — and stretching the animation to make a test pass
# would be changing the product to suit the venue. Section 7 fires a burst of
# reads straight after a switch and PRINTS how many of them caught the flag up,
# as a `#` note and never as a verdict, so a human reading the log can see the
# measurement rather than take this paragraph on trust. What IS asserted, in
# both directions and every time, is that the flag is DOWN once the counters
# agree: `settled == runs and active == false` is "the morph ended and nothing
# latched", and it is the assertion an earlier change's latched counter would have failed.
#
# WHAT IT PINS, one line per clause of the DoD:
#
#   THE THREE NAMED ANIMATIONS — toggling watched (the chip's fill), the drift
#                     edge (the chip's outline) and the bar widget's `sweeping`
#                     state each report a bound animation with a NON-ZERO
#                     duration. The first two are `fillMotionMs`/`edgeMotionMs`
#                     on every chip in `dock-recall state`; the third is
#                     `sweepMs` from `dock-recall-bar motion`, which is a
#                     SEPARATE IPC TARGET because the bar widget is a separate
#                     top-level entry point and nothing in Panel.qml can see
#                     into it.
#   ONE DURATION, FOUR OBJECTS — every chip's two colour fades, the morph fade
#                     and the bar's glyph fade all report the SAME number, which
#                     is a cross-check between four animation objects in two QML
#                     entry points read over two IPC targets. No token is
#                     restated to get it; the equality is the assertion.
#   THE CURVES — the two colour fades declare NO curve (Qt Linear, 0), which is
#                     Omarchy's own answer for a colour and is what
#                     `Ui/ToggleSwitch` does; the two things that MOVE (the
#                     morph, the glyph fade) declare one, and it is the same one
#                     on both sides of the IPC boundary. Said honestly: a
#                     Behavior that was deleted also reports 0, so the Linear
#                     clause is a statement of the convention and the DURATIONS
#                     are what catch a deletion.
#   THE FILL ACTUALLY MOVES — a row is ticked over IPC, its chip's `fillState`
#                     goes from unwatched to watched and back, and the chip that
#                     changed is the chip carrying the Behavior. The venue cannot
#                     watch the colour cross; it can insist that the property
#                     which changed is the animated one.
#   THE DRIFT EDGE — the recorded layout puts the running app on a workspace it
#                     is not on, so its chip reports `edgeTone: "drift"` while
#                     still reporting a non-zero `edgeMotionMs`.
#   THE PAIR SET, BY NAME — the pair is asserted by the running window's own
#                     hyprctl address on one end and by the recorded chip key on
#                     the other, never by a count. A count cannot tell one chip
#                     from another, and this increment has already paid for that
#                     twice (an earlier change: `cache_is 1` accepted the wrong desk's
#                     picture). The one-sided lists are named the same way: the
#                     unwatched window is in `liveOnly` and the recorded app that
#                     is not running is in `recordedOnly`.
#   THE PARTITION — every chip the map DREW is accounted for exactly once by the
#                     matcher: the drawn keys sort-equal the pair ends plus that
#                     side's one-sided list. A pairing that quietly dropped a
#                     chip fails here even if every named clause still passes.
#   A MORPH RAN AND ENDED — `runs` goes up across every view switch and `settled`
#                     catches up, in both directions, on both render paths.
#   THE FLIGHTS — a pair the panel could resolve to two drawn rectangles is
#                     TRANSLATED, and `morph.flights` is the very list the
#                     overlay's Repeater is built from. Each flight is required
#                     to belong to a pair the matcher returned with
#                     `geometry: true`, and both its rectangles have to clear the
#                     same 16x10 chip floor a drawn chip does — a 1x1 rect from a
#                     zero-width canvas is exactly what warm-up produces and it
#                     is non-null, so nothing else would complain.
#   THE DIRECTION — the flight's `from` and `to` SWAP when the view flips back.
#                     Two payloads, one comparison, no re-derivation: a resolver
#                     that ignored `showRecorded` would fly every chip the same
#                     way whichever tab the user came from, and would pass every
#                     other clause here.
#
# BOTH RENDER PATHS, because the project notes says so and because the project
# has been bitten: the fallback engaged silently and hid a broken model for two
# live rounds, and a rule calibrated on positioned chips can be wrong on the
# fallback's fixed-height rows. This file reaches both the way a user does:
#
#   POSITIONED — the layout is RECORDED for real, through the panel's own
#                `record` verb, so its apps carry the at/size the plugin itself
#                wrote. Both maps are then positioned, the pair reports
#                `geometry: true`, and it FLIES.
#   FALLBACK   — the same layout is then rewritten without at/size, which is the
#                shape of a v1 recording and of any read that came back without
#                geometry. Every recorded workspace drops to the stacked path,
#                the pair reports `geometry: false`, nothing flies, and the
#                chips have to go on reporting their two fade durations there —
#                which is the half a positioned-only run would never see.
#
# THE SEED, and why it is half recorded and half written. `record` supplies the
# one thing that is painful to construct by hand and easy to get subtly wrong:
# real at/size in global layout coordinates, and the topology key they belong to.
# What it cannot supply is a recorded app that is NOT running (nothing records a
# window that is not there) or a chip recorded somewhere it is not — so those two
# are written afterwards, through StateModel, on top of the recording the plugin
# made. Every geometry in the file is the plugin's own.
#
# The panel is DISMISSED, both windows are killed and the status file is put back
# however this test ends: the panel's layer takes keyboard focus exclusively, and
# the tests that share this boot want the desk and the bar back.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"
# The bar widget's ONE input. It runs a single FileView on this and no hyprctl
# of its own, which is the property that makes an enabled bar cost nothing —
# and it is why section 10 can drive the sweep by writing here.
STATUS="$STATE_DIR/dock-recall.status.json"

# Same pinning as the round trip and the panel test: `foot` is also the class of
# any other terminal this boot happens to have, so the identity carries
# titlePatterns and the engine ANDs the two axes. titlePatterns match the
# client's initialTitle, which is exactly what `foot --title=` sets.
APP_TITLE="dock-recall-motion"
APP_CLASS="foot"
IDENTITY="dr-motion-live"

# THE UNWATCHED WINDOW. It is on the desk and on the live map, and nothing in
# the recording answers to it — which makes it the `liveOnly` end of the
# matcher's three-way answer, and the row section 6b ticks and unticks to watch
# a fill move under its Behavior.
LOOSE_TITLE="dock-recall-motion-loose"
LOOSE_CLASS="dock-recall-motion-loose"

# THE RECORDED APP THAT IS NOT RUNNING — the `recordedOnly` end. It cannot come
# out of a `record` (there is no window to record), so it is written into the
# layout afterwards, carrying the same geometry the real recording produced so
# its workspace is positioned like every other one.
#
# Its id deliberately shares no prefix with $IDENTITY: both recorded chip keys
# are spelled `recorded-<identity>`, and a prefix match over two keys where one
# is a prefix of the other is precisely the "assert by name" mistake this file
# is written against.
GHOST_IDENTITY="dr-motion-gone"
GHOST_CLASS="dock-recall-motion-gone"

# The panel's own layer, declared in Panel.qml (WlrLayershell.namespace).
PANEL_NAMESPACE="mkelk-dock-recall"
# The panel's IpcHandler, which exists only while the panel is loaded — which is
# only while it is open.
IPC_TARGET="dock-recall"
# THE BAR'S OWN HANDLER, and a second target rather than a second verb on the
# first. The bar widget is loaded by the BAR and not by the panel loader, so
# nothing in Panel.qml can reach it; the DoD requires the sweep to be reportable
# and there is no route from the panel's payload to it. Read-only, one verb.
BAR_TARGET="dock-recall-bar"

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# The chip floor, in pixels, from Panel.qml's `chipFloorWidth`/`chipFloorHeight`
# — the two numbers `chipRectsForCanvas` is handed by the map when it draws AND
# by the flight resolver when it works out where the map drew. A flight end
# below the floor was never resolved against a laid-out canvas: the floor is
# applied against min(canvas, floor), so a zero-width canvas during warm-up
# yields a non-null 1x1 rect and nothing warns.
CHIP_MIN_W=16
CHIP_MIN_H=10

# Filled in as the test goes; declared here because `set -u` is on and the
# predicates below name them.
APP_ADDRESS=""
LOOSE_ADDRESS=""
APP_WS=""
DRIFTED_WS=""
TOPOLOGY_KEY=""
# The recorded chips' own keys, READ OFF THE PAYLOAD rather than spelled here.
# `instanceKeyFor` folds an occurrence into the key once an identity has more
# than one instance, so `recorded-dr-motion-live` is right for this desk and
# wrong in general — deriving it from the pair whose live end is this test's own
# window address keeps the assertion by-name without hard-coding a rule that
# belongs to PanelModel.
RECORDED_KEY=""
GHOST_KEY=""
# The payloads the view predicates capture, so every assertion below reads the
# one that passed rather than a fresh one taken a refresh later.
LIVE_JSON=""
RECORDED_JSON=""
LIVE_BACK_JSON=""
BAR_JSON=""
# The status file as the service left it, restored on the way out.
STATUS_SAVED=""
STATUS_EXISTED=0

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }

client_field() {
  clients | jq -r --arg t "$1" --arg f "$2" \
    'first(.[]|select(.initialTitle==$t)|.[$f])//empty'
}
app_present() { [[ -n $(client_field "$APP_TITLE" address) ]]; }
loose_present() { [[ -n $(client_field "$LOOSE_TITLE" address) ]]; }

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

# NO `state loaded: <n> identities, <m> layouts` HELPER HERE, deliberately. That
# is the service's own account of taking a seed up and it is what the panel and
# captures tests wait on — but `qs log` spans the WHOLE boot, and
# dock-recall-captures-test.sh (which sorts before this file) waits for the exact
# same "2 identities, 0 layouts" sentence, so grepping for it here would match a
# line written by another test and prove nothing. Section 4b waits for the
# PANEL's own view of this test's own window instead.

plugin_state() {
  omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id { print $2 }'
}
plugin_known() { [[ -n $(plugin_state) ]]; }

# The panel's layer surface, by the namespace Panel.qml declares. POLLED, never
# slept on: the summon returns as soon as the shell has set its open-set, and the
# surface is mapped some frames later.
panel_layer_present() {
  hyprctl layers -j | jq -e --arg n "$PANEL_NAMESPACE" \
    '[..|.namespace?|select(. == $n)]|length > 0' >/dev/null
}
panel_layer_absent() { ! panel_layer_present; }

panel_state_json() { omarchy-shell "$IPC_TARGET" state 2>/dev/null; }
bar_motion_json() { omarchy-shell "$BAR_TARGET" motion 2>/dev/null; }

# THE SHAPE EVERY PAYLOAD MUST SATISFY, whichever tab is showing and whichever
# render path drew it.
#
# `$state` is bound by the callers (the chip clauses rebind `.` inside their own
# iteration) and `$minw`/`$minh` come in as jq --argjson.
#
# THE FOUR DURATIONS ARE COMPARED TO EACH OTHER AND TO NOTHING ELSE. Every chip
# reports the duration of the ColorAnimation on its fill and the one on its edge;
# the morph reports the duration of the NumberAnimation that drives it; section 10
# then requires the bar widget's glyph fade to report the same number over a
# different IPC target. Four animation objects in two QML entry points agreeing
# is a real statement. The number itself is deliberately not written down here:
# a literal from Motion.qml compared to the payload would be this test agreeing
# with a constant, and would pass on a panel whose Behaviors had all been
# deleted and whose reports had all fallen to the same 0 — which is exactly why
# the non-zero clause sits beside the equality and not instead of it.
#
# THE CURVES. The two colour fades declare none, so Qt answers Linear (0). That
# is copied from the shell rather than invented — `Ui/ToggleSwitch` gives its
# ColorAnimation no easing and its knob OutCubic, two shapes and one duration —
# and it is asserted as the convention, honestly and with its limit stated: a
# deleted Behavior would also report 0. The DURATION clause is what tells those
# apart. The morph, which MOVES, must declare a curve, so its easing is required
# to be something other than Linear.
#
# THE PARTITION is the clause that needs no name to be strong. Every chip the
# map drew is accounted for exactly once by the matcher: on the live tab the
# drawn keys sort-equal the pairs' live ends plus `liveOnly`, on the recorded tab
# the recorded ends plus `recordedOnly`. A pairing that dropped a chip, or
# invented one, fails here whatever the named clauses say.
#
# THE FLIGHTS are held to the pairs. Every flight has to name a pair the matcher
# returned AND one it marked `geometry: true`, and both of its rectangles have to
# clear the chip floor — a flight resolved against a canvas that had not laid out
# yet is 1x1 and non-null, which is the failure no warning fires on.
#
# NOTHING inside this string may carry an apostrophe or a `#`: it is a
# single-quoted shell string spliced into the callers, and an apostrophe would
# end it.
# shellcheck disable=SC2016  # $state, $minw and $minh are jq's, not the shell's
MOTION_SHAPE='
  (.chips|type) == "array" and (.chips|length) > 0
  and (.morph|type) == "object"
  and (.morph.active|type) == "boolean"
  and (.morph.durationMs|type) == "number" and .morph.durationMs > 0
  and (.morph.easing|type) == "number" and .morph.easing != 0
  and (.morph.runs|type) == "number" and (.morph.settled|type) == "number"
  and .morph.runs >= 0 and .morph.settled >= 0 and .morph.settled <= .morph.runs
  and (.morph.pairs|type) == "array"
  and (.morph.liveOnly|type) == "array"
  and (.morph.recordedOnly|type) == "array"
  and (.morph.flights|type) == "array"
  and ([.chips[]|select((.fillMotionMs|type) == "number" and .fillMotionMs > 0
        and (.edgeMotionMs|type) == "number" and .edgeMotionMs > 0
        and (.motionEasing|type) == "number"
        and (.morphRole == "paired" or .morphRole == "live-only"
             or .morphRole == "recorded-only" or .morphRole == "")
        and (.morphFlying|type) == "boolean"
        and (.renderPath == "positioned" or .renderPath == "fallback"))]|length)
      == (.chips|length)
  and ([.chips[]|select(.fillMotionMs != $state.morph.durationMs
        or .edgeMotionMs != $state.morph.durationMs)]|length) == 0
  and ([.chips[]|select(.motionEasing != 0)]|length) == 0
  and ([.chips[]|select((.breatheMs|type) == "number" and .breatheMs > 0
        and (.breathing|type) == "boolean"
        and (.drifted|type) == "boolean")]|length) == (.chips|length)
  and ([.chips[]|select(.breathing != .drifted)]|length) == 0
  and ([.chips[]|select(.breatheMs <= .fillMotionMs)]|length) == 0
  and (([.chips[]|.key]|sort)
       == (if .showRecorded
           then ([.morph.pairs[]|.recordedKey] + [.morph.recordedOnly[]|.key])|sort
           else ([.morph.pairs[]|.liveKey] + [.morph.liveOnly[]|.key])|sort end))
  and ([.morph.flights[]
        | . as $flight
        | select((([$state.morph.pairs[]
                    | select(.liveKey == $flight.liveKey
                             and .recordedKey == $flight.recordedKey
                             and .geometry == true)]|length) == 1)
                 and ($flight.from.width|type) == "number"
                 and ($flight.from.height|type) == "number"
                 and ($flight.to.width|type) == "number"
                 and ($flight.to.height|type) == "number"
                 and ($flight.from.x|type) == "number"
                 and ($flight.from.y|type) == "number"
                 and ($flight.to.x|type) == "number"
                 and ($flight.to.y|type) == "number"
                 and $flight.from.width >= $minw and $flight.from.height >= $minh
                 and $flight.to.width >= $minw and $flight.to.height >= $minh)]|length)
      == (.morph.flights|length)
'

# THE LIVE MAP, positioned, with the recording in place. Captures the payload it
# validated, so the assertions and the pass lines below read the one that passed.
#
# The chips are named by the two hyprctl addresses this test put on the desk, and
# the pair is named by BOTH its ends — a count over pairs cannot tell the running
# app from the unwatched window beside it, and this increment has already paid a
# gate cycle for exactly that shape of assertion.
capture_live_state() {
  LIVE_JSON=$(panel_state_json)
  printf '%s' "$LIVE_JSON" | jq -e --argjson minw "$CHIP_MIN_W" --argjson minh "$CHIP_MIN_H" \
    --arg addr "$APP_ADDRESS" --arg loose "$LOOSE_ADDRESS" \
    --arg link "id:$IDENTITY" --argjson dws "$DRIFTED_WS" \
    --arg id "$IDENTITY" --arg ghostid "$GHOST_IDENTITY" '. as $state |
    '"$MOTION_SHAPE"'
    and .showRecorded == false
    # THE DRIFT EDGE, on the chip that is actually drifted. The recording puts
    # this app on a workspace it is not on, so its outline wears the drift tone
    # while its fill goes on saying watched — and the edge fade it reports is a
    # real duration on a real animation, not a token.
    and ([.chips[]|select(.key == $addr and .renderPath == "positioned"
          and .watched == true and .fillState == "watched" and .edgeTone == "drift"
          and .edgeMotionMs > 0 and .fillMotionMs > 0)]|length) == 1
    # THE UNWATCHED WINDOW carries the same two animated channels. A chip that
    # never becomes watched still fades: the fill it is bound to is the one the
    # tick in section 6b moves.
    and ([.chips[]|select(.key == $loose and .fillState == "unwatched"
          and .fillMotionMs > 0 and .edgeMotionMs > 0)]|length) == 1
    # THE PAIR, BY NAME AT BOTH ENDS. The live end is this window own address;
    # the recorded end has to be a recorded chip key naming this identity. It is
    # the pair the matcher returned, so `geometry` and the two recorded
    # coordinates are its answer and not a second derivation.
    and ([.morph.pairs[]|select(.liveKey == $addr and .linkKey == $link
          and (.recordedKey|test("^recorded-" + $id + "(#[0-9]+)?$"))
          and .geometry == true
          and .workspaceChanged == true
          and .recordedWorkspaceId == $dws)]|length) == 1
    # THE THREE-WAY ANSWER, each side named. The unwatched window is in
    # liveOnly, the running app is NOT, and the recorded app that is not running
    # is in recordedOnly. Named rather than counted: liveOnly having one member
    # says nothing about WHICH chip the matcher decided was new.
    and ([.morph.liveOnly[]|select(.key == $loose)]|length) == 1
    and ([.morph.liveOnly[]|select(.key == $addr)]|length) == 0
    and ([.morph.recordedOnly[]|select(.key|test("^recorded-" + $ghostid + "(#[0-9]+)?$"))]|length) == 1
    # AND THE CHIPS WERE TOLD. `morphRole` is what the delegate that drew the
    # chip was handed, not what the panel could look up for itself: the pair set
    # reaching the thing that draws is the claim, and a panel agreeing with
    # itself is not.
    and ([.chips[]|select(.key == $addr and .morphRole == "paired")]|length) == 1
    and ([.chips[]|select(.key == $loose and .morphRole == "live-only")]|length) == 1
    # The app list is read below to find the row section 6b ticks, so it is
    # required here rather than discovered missing three steps later.
    and (.rows|type) == "array" and (.rows|length) > 0
  ' >/dev/null
}

# THE RECORDED MAP with geometry: every workspace positioned, so the pair can be
# TRANSLATED and the flight has two real rectangles to travel between.
capture_recorded_state() {
  RECORDED_JSON=$(panel_state_json)
  printf '%s' "$RECORDED_JSON" | jq -e --argjson minw "$CHIP_MIN_W" --argjson minh "$CHIP_MIN_H" \
    --arg addr "$APP_ADDRESS" --arg rkey "$RECORDED_KEY" --arg ghost "$GHOST_KEY" \
    '. as $state |
    '"$MOTION_SHAPE"'
    and .showRecorded == true
    # The recording carries the at/size the plugin own record wrote, so both of
    # its workspaces draw positioned. This is the clause the fallback half of
    # section 9 is the other side of.
    and ([.chips[]|select(.renderPath == "positioned")]|length) == (.chips|length)
    and ([.chips[]|select(.key == $rkey and .morphRole == "paired"
          and .fillMotionMs > 0 and .edgeMotionMs > 0)]|length) == 1
    and ([.chips[]|select(.key == $ghost and .morphRole == "recorded-only"
          and .fillMotionMs > 0 and .edgeMotionMs > 0)]|length) == 1
    # THE FLIGHT, named at both ends. The pair the matcher marked translatable is
    # the pair the overlay is carrying, and this is the very list the overlay
    # Repeater is built from — so a flight here is a rectangle that was drawn.
    and ([.morph.flights[]|select(.liveKey == $addr and .recordedKey == $rkey)]|length) == 1
    # And the app that is only in the recording is not flying anywhere: there is
    # no other end for it to come from.
    and ([.morph.flights[]|select(.recordedKey == $ghost)]|length) == 0
  ' >/dev/null
}

# BACK ON THE LIVE MAP, after a round trip through the recorded one. The whole
# live shape again — the workspace canvas registry outlives the view and is what
# both ends of a flight are resolved against, so a recorded delegate that wrote
# over a live entry would show up here — plus the flight, which exists on this
# tab now that the far map has been laid out once.
capture_live_back_state() {
  LIVE_BACK_JSON=$(panel_state_json)
  printf '%s' "$LIVE_BACK_JSON" | jq -e --argjson minw "$CHIP_MIN_W" --argjson minh "$CHIP_MIN_H" \
    --arg addr "$APP_ADDRESS" --arg rkey "$RECORDED_KEY" '. as $state |
    '"$MOTION_SHAPE"'
    and .showRecorded == false
    and ([.morph.flights[]|select(.liveKey == $addr and .recordedKey == $rkey)]|length) == 1
  ' >/dev/null
}

# THE FALLBACK HALF. The layout has had its geometry stripped, so every recorded
# workspace draws stacked — and a stacked workspace ignores its chips rects,
# which is why the matcher reports `geometry: false` and nothing flies. What must
# NOT change is that the chips go on reporting their two fade durations: a rule
# calibrated on positioned chips can be wrong on fixed-height rows, and the
# fallback path has hidden a broken model here before.
capture_fallback_state() {
  RECORDED_JSON=$(panel_state_json)
  printf '%s' "$RECORDED_JSON" | jq -e --argjson minw "$CHIP_MIN_W" --argjson minh "$CHIP_MIN_H" \
    --arg addr "$APP_ADDRESS" --arg rkey "$RECORDED_KEY" --arg ghost "$GHOST_KEY" \
    '. as $state |
    '"$MOTION_SHAPE"'
    and .showRecorded == true
    and ([.chips[]|select(.renderPath == "fallback")]|length) == (.chips|length)
    # THE ASSERTION THIS SECTION EXISTS FOR: the two colour fades are reported by
    # the stacked delegate exactly as by the positioned one. MOTION_SHAPE already
    # requires it of every chip; naming the two chips here is what makes the
    # failure legible rather than "some chip on some path".
    and ([.chips[]|select(.key == $rkey and .fillMotionMs > 0 and .edgeMotionMs > 0
          and .morphRole == "paired" and .morphFlying == false)]|length) == 1
    and ([.chips[]|select(.key == $ghost and .fillMotionMs > 0 and .edgeMotionMs > 0
          and .morphRole == "recorded-only" and .morphFlying == false)]|length) == 1
    # A fallback end makes the pair untranslatable, and the matcher says so
    # rather than flying it from a rectangle nothing was drawn at.
    and ([.morph.pairs[]|select(.liveKey == $addr and .recordedKey == $rkey
          and .geometry == false)]|length) == 1
    and ([.morph.flights[]|select(.recordedKey == $rkey)]|length) == 0
    # Nothing at all can be flying while the far end is stacked, so no chip on
    # this map is standing aside for an overlay that is carrying nothing.
    and ([.chips[]|select(.morphFlying == true)]|length) == 0
  ' >/dev/null
}

# THE BAR, over its own target. Read-only, one verb, and the only route to the
# widget: it is loaded by the bar rather than by the panel loader.
capture_bar_motion() {
  BAR_JSON=$(bar_motion_json)
  printf '%s' "$BAR_JSON" | jq -e '
    (.glyphFadeMs|type) == "number" and .glyphFadeMs > 0
    and (.glyphFadeEasing|type) == "number" and .glyphFadeEasing != 0
    and (.sweepMs|type) == "number" and .sweepMs > 0
    # THE SWEEP IS A DIFFERENT KIND OF THING and keeps its own number: a long
    # looping hint that something is happening, not a transition between two
    # states. A sweep bound to the state-change duration would strobe, and that
    # is a real defect wearing the shape of a tidy-up.
    and .sweepMs > .glyphFadeMs
    and (.sweepRunning|type) == "boolean" and (.sweeping|type) == "boolean"
    # AND THE ANIMATION RUNS EXACTLY WHEN THE STATE SAYS. `running` is bound to
    # `sweeping`; a NumberAnimation on a property defaults to running, so a
    # binding somebody removed leaves the band travelling for ever under a glyph
    # that is not restoring — and this is the clause that catches it.
    and .sweepRunning == .sweeping
    and (.glyph|type) == "string" and (.glyph|length) > 0' >/dev/null
}

capture_service_log() { dr_log > "$ARTIFACTS/dock-recall-motion-service.log" 2>/dev/null || true; }

diagnostics() {
  echo "--- panel state: the morph subtree ---" >&2
  omarchy-shell "$IPC_TARGET" state 2>&1 | jq -c '.morph//"no morph key"' 2>/dev/null >&2 ||
    omarchy-shell "$IPC_TARGET" state 2>&1 | head -c 2000 >&2
  echo >&2
  echo "--- panel state: chips, motion fields only ---" >&2
  omarchy-shell "$IPC_TARGET" state 2>&1 | jq -c \
    '[.chips[]?|{key, renderPath, fillState, edgeTone, fillMotionMs, edgeMotionMs, motionEasing, morphRole, morphFlying}]' \
    2>/dev/null >&2
  echo >&2
  echo "--- panel state (raw, truncated) ---" >&2
  omarchy-shell "$IPC_TARGET" state 2>&1 | head -c 3000 >&2
  echo >&2
  echo "--- bar motion (raw) ---" >&2
  omarchy-shell "$BAR_TARGET" motion 2>&1 | head -c 1000 >&2
  echo >&2
  echo "--- status file ---" >&2
  head -30 "$STATUS" >&2 2>/dev/null
  echo "--- state file ---" >&2
  head -60 "$STATE" >&2 2>/dev/null
  echo "--- layers ---" >&2
  hyprctl layers -j | jq -c '[..|.namespace?|select(. != null)]' >&2
  echo "--- shell log: errors, and anything naming our QML (UNFILTERED) ---" >&2
  # THE FILTERED LOG BELOW CANNOT SHOW A PANEL THAT NEVER LOADED, and that cost
  # a whole VM cycle: a QML error carries no "[dock-recall]" prefix, so a panel
  # that failed to construct left `dr_log` looking perfectly healthy — the
  # service and the bar widget had both said their piece — while the one thing
  # this test needs had silently not been built. `qmllint` cannot see it either;
  # it exits 0 on an unknown id and on a handler for a signal that does not
  # exist. So the raw log is dumped first, narrowed to lines that could name a
  # fault or one of our files.
  shell_log | grep -iE "error|warning|cannot|unable|is not a type|unexpected|mkelk|\\.qml" \
    | tail -30 >&2
  echo "--- [dock-recall] log ---" >&2
  dr_log | tail -25 >&2
  capture_service_log
}

cleanup() {
  local status=$?
  set +e
  # The panel layer is keyboard-exclusive; nothing that runs after this test
  # should have to work around it. Through the shell, so the loader open-set and
  # the panel agree about it being gone.
  omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
  pkill -f "foot --title=$APP_TITLE" 2>/dev/null
  pkill -f "foot --app-id=$LOOSE_CLASS" 2>/dev/null
  # THE STATUS FILE IS PUT BACK. Section 10 writes a fiction into it — the bar
  # widget has no other input, so driving the sweep means writing the file the
  # service publishes — and the bar is shared with every test after this one. The
  # service is unaware either way: its FileView is write-only and it skips a
  # publish whose bytes are unchanged, so restoring the saved copy leaves it
  # exactly where it thought it was.
  if [[ $STATUS_EXISTED == 1 && -n $STATUS_SAVED && -f $STATUS_SAVED ]]; then
    cp -f "$STATUS_SAVED" "$STATUS" 2>/dev/null
  elif [[ $STATUS_EXISTED == 0 ]]; then
    rm -f "$STATUS" 2>/dev/null
  fi
  [[ -n $STATUS_SAVED ]] && rm -f "$STATUS_SAVED" 2>/dev/null
  # And take the seed with us. Everything this test writes to the state file is
  # its own fiction — an identity matching a window it just killed, and a layout
  # naming an app that was never launched — and the tests that share this boot
  # read the same file. The service handles the file vanishing; it is what this
  # test started from.
  rm -f "$STATE" 2>/dev/null
  return $status
}
trap cleanup EXIT

# --------------------------------------------------------- 0. prerequisites

[[ -d $PLUGIN_SRC ]] || fail "plugin payload present (motion)" "no plugin tree at $PLUGIN_SRC"

ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

ensure_pkg jq jq       || fail "jq available in the guest (motion)"
ensure_pkg foot foot   || fail "foot available in the guest (motion)"
ensure_pkg node nodejs || fail "node available in the guest (motion)"
pass "guest prerequisites present (jq, foot, node) — motion"

# ------------------------------------------------------- 1. install the plugin

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed (motion)" "rsync into $PLUGIN_DIR failed"

# Start from no recordings at all, so only this test own seed can explain the
# recorded map it asserts on.
rm -f "$STATE"

# rescanPlugins is asynchronous, so enabling in the next breath answers `unknown
# plugin` and leaves the plugin disabled: rescan, WAIT for the registry to admit
# it, enable, and check the answer.
omarchy-shell shell rescanPlugins >/dev/null 2>&1
wait_until "plugin registry knows $PLUGIN_ID (motion)" 30 plugin_known

enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
[[ $enable_result == "ok" ]] ||
  fail "plugin enabled (motion)" "omarchy-shell shell enablePlugin answered '$enable_result'"
# For a plugin whose kinds include "bar-widget", the shell's own `enabled` IS
# `inBar(id)` — so this line is also the check that the bar is carrying the
# widget, which is what section 10 talks to over its own IPC target.
[[ $(plugin_state) == "enabled" ]] ||
  fail "plugin enabled and in the bar (motion)" \
    "omarchy plugin list still reports '$(plugin_state)' — for a bar-widget plugin that field is inBar(), so the bar widget is not loaded and $BAR_TARGET will not answer"

# The panel hot-reloads, but this plugin is a SERVICE too and a hot-reloaded
# service runs QML while its Process and FileView never fire. Restarting is also
# what guarantees the panel loader and the bar are looking at the tree just
# installed. Safe here — this VM has no lock screen up and no user session to
# lose.
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after restart (motion)" 60 pgrep -f 'quickshell -n -p'
wait_until "dock-recall service reported ready (motion)" 60 service_ready
pass "plugin installed, enabled, in the bar, and its service is live (motion)"

# ------------------------------------------------------------ 2. run the apps

pkill -f "foot --title=$APP_TITLE" 2>/dev/null
launch_app "foot --title=$APP_TITLE"
wait_until "the watched app window appeared (motion)" 30 app_present

APP_WS=$(clients | jq -r --arg t "$APP_TITLE" 'first(.[]|select(.initialTitle==$t)|.workspace.id)//empty')
[[ -n $APP_WS ]] || fail "the watched app has a workspace (motion)"

# Anywhere the window is not. Section 5 rewrites the recording to put the app
# HERE, which is what makes it DRIFTED — and drift is the state the outline has
# to be able to wear while the fill under it goes on saying watched.
# Same block as the app, so the move is a slot change: at slot 10 go down instead.
if (( (APP_WS - 1) % 10 + 1 == 10 )); then DRIFTED_WS=$((APP_WS - 1)); else DRIFTED_WS=$((APP_WS + 1)); fi

APP_ADDRESS=$(client_field "$APP_TITLE" address)
[[ -n $APP_ADDRESS ]] || fail "the watched app has an address (motion)"

# THE UNWATCHED WINDOW. Its class is checked rather than assumed: `foot
# --app-id=` is what sets it, and a foot that ignored the flag would put a second
# window of class `foot` on the desk — which the watched identity DOES claim by
# class, so the pair assertion would then be about the wrong thing entirely.
pkill -f "foot --app-id=$LOOSE_CLASS" 2>/dev/null
launch_app "foot --app-id=$LOOSE_CLASS --title=$LOOSE_TITLE"
wait_until "the unwatched window appeared (motion)" 30 loose_present

LOOSE_ADDRESS=$(client_field "$LOOSE_TITLE" address)
loose_class=$(client_field "$LOOSE_TITLE" class)
[[ $loose_class == "$LOOSE_CLASS" ]] ||
  fail "the unwatched window carries its own class (motion)" \
    "hyprctl reports class '$loose_class', not '$LOOSE_CLASS' — foot ignored --app-id, and this window is indistinguishable from the watched one"
pass "two windows on the desk: $APP_TITLE (to be watched) on ws $APP_WS, and $LOOSE_TITLE, class $LOOSE_CLASS"

# ------------------------------------------------- 3. seed the two identities

SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel (motion)" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

# THE PICTURES ARE SEEDED OFF. This file is about MOTION, and pictures are on by
# default since schema v7 — so a Record here would photograph both windows and a
# panel open would photograph them again, writing JPEGs to ~/.cache for a test
# that never looks at one. Off is one boolean, it is a user-editable field like
# every other one in the file, and it keeps this test from writing a single
# picture to disk. What the switch DOES is covered end to end in
# dock-recall-captures-test.sh.
cat > "$STATE.seed" <<JSON
{
  "version": $SCHEMA_VERSION,
  "pictures": false,
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

# Polled, not slept on. The service logs what it read back; wait for the line
# that says it took the identities, so a seed rejected as junk or never noticed
# fails HERE rather than leaving the record below to explain itself.
pass "seeded: $IDENTITY watched and running, $GHOST_IDENTITY watched and never launched"

# ------------------------------------------------------- 4. summon the panel

omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "panel layer '$PANEL_NAMESPACE' appeared (motion)" "the panel never mapped a layer surface"
fi
screenshot "success-dock-recall-motion-01-open"
pass "panel summoned and its layer '$PANEL_NAMESPACE' is mapped (motion)"

# ------------------------------- 4b. wait for the PANEL's view of the seed
#
# NOT for the service's `state loaded: 2 identities, 0 layouts` line, and the
# reason is specific rather than a preference. `qs log` is the whole boot's log
# and the tests before this one share it: dock-recall-captures-test.sh seeds two
# identities and no layouts too, and waits for that exact sentence — so by the
# time this file runs, the line is already there and a grep for it would match
# instantly and prove nothing about THIS seed. (dock-recall-appid-migration-test
# hit the same wall and counted the lines instead.)
#
# What is unambiguous is the panel's own view of a fact the panel computes: a
# chip keyed by THIS test's window address, reporting watched. The live map draws
# every mappable client on the desk whether it is watched or not, so that flag is
# the only thing that separates "the identity loaded and this window matched it"
# from "the map drew the desk". Named by address, never counted.
seed_seen() {
  panel_state_json | jq -e --arg addr "$APP_ADDRESS" \
    '[.chips[]?|select(.key == $addr and .watched == true)]|length == 1' >/dev/null
}
if ! poll 60 seed_seen; then
  diagnostics
  fail "the panel sees the seeded identity on its own map (motion)" \
    "no payload reported a chip keyed $APP_ADDRESS with watched:true — the identity seed has not reached the panel, and a record taken now would record nothing"
fi
pass "the panel reports the seeded window as watched, keyed $APP_ADDRESS"

# ------------------------------------- 5. record, then place the two far ends
#
# THE RECORDING IS REAL. `record` routes to root.recordLayout and nothing else,
# and what it writes is the at/size the plugin itself read off the desk, in the
# global layout coordinates the recorded map scales against. That is the one part
# of this seed that is genuinely painful to fabricate and easy to get subtly
# wrong, so it is not fabricated.

record_answer=$(omarchy-shell "$IPC_TARGET" record 2>&1)
if [[ $record_answer != "recorded" ]]; then
  diagnostics
  fail "panel IPC records a layout (motion)" "record answered '$record_answer'"
fi

# NOT A POLL, for the reason an earlier change established: "recorded" is a promise that
# the bytes are on disk (the panel state FileView declares blockWrites, so
# writeState cannot answer true with a write still in flight), and polling would
# turn a broken promise into a slow one.
TOPOLOGY_KEY=$(jq -r 'first(.layouts|keys[])//empty' "$STATE" 2>/dev/null)
if [[ -z $TOPOLOGY_KEY ]]; then
  diagnostics
  fail "the record wrote a layout (motion)" \
    "no layout key in $STATE after record answered 'recorded' — the write did not block"
fi

recorded_apps=$(jq -r --arg k "$TOPOLOGY_KEY" '[.layouts[$k].apps[]|.identityId]|sort|join(",")' "$STATE")
[[ $recorded_apps == "$IDENTITY" ]] ||
  fail "the record names the one running watched app (motion)" \
    "the layout names '$recorded_apps', expected '$IDENTITY' — $GHOST_IDENTITY is not running and must not be in a recording the plugin made"

# THE TWO FAR ENDS, written on top of the plugin's own recording.
#
#   The running app is MOVED, in the recording only, to a workspace it is not on.
#   That is what makes it drifted (so its outline wears the drift tone under
#   section 6) and it is what makes the two ends of its flight land on two
#   different canvases — a chip recorded exactly where it is would fly nowhere,
#   and a flight from a rectangle to itself proves nothing about direction.
#
#   The app that is not running is ADDED, carrying the same at/size the record
#   produced. It is the `recordedOnly` end of the matcher's three-way answer, and
#   giving it real geometry is what keeps its workspace on the positioned path
#   like the other one.
#
# Through StateModel.upsertLayout rather than by hand-writing JSON: the schema is
# the engine's business and a hand-written layout rots at the next STATE_VERSION
# bump.
node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var Slots = require(process.argv[1] + "/Slots.js");
  var statePath = process.argv[2], key = process.argv[3];
  var identityId = process.argv[4], ghostId = process.argv[5];
  var driftedWs = Number(process.argv[6]), homeWs = Number(process.argv[7]);

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = StateModel.layoutFor(state, key);
  if (!layout) { console.error("dock-recall motion test: no layout for " + key); process.exit(1); }

  var recorded = null;
  for (var i = 0; i < layout.apps.length; i++) {
    if (layout.apps[i].identityId === identityId) recorded = layout.apps[i];
  }
  if (!recorded) { console.error("dock-recall motion test: " + identityId + " is not in the recording"); process.exit(1); }
  if (!recorded.at || !recorded.size) {
    console.error("dock-recall motion test: the recording carries no at/size for " + identityId
      + " — the recorded map would draw stacked and nothing could fly");
    process.exit(1);
  }

  var apps = [{
    identityId: identityId,
    monitorDescription: recorded.monitorDescription,
    slot: Slots.slotOf(driftedWs),
    floating: recorded.floating,
    group: recorded.group,
    at: recorded.at,
    size: recorded.size
  }, {
    identityId: ghostId,
    monitorDescription: recorded.monitorDescription,
    slot: Slots.slotOf(homeWs),
    floating: recorded.floating,
    group: null,
    at: recorded.at,
    size: recorded.size
  }];

  var next = StateModel.upsertLayout(state, {
    topologyKey: layout.topologyKey,
    recordedAt: layout.recordedAt,
    apps: apps
  });
  fs.writeFileSync(statePath + ".tmp", StateModel.serializeState(next));
  fs.renameSync(statePath + ".tmp", statePath);
' "$PLUGIN_DIR" "$STATE" "$TOPOLOGY_KEY" "$IDENTITY" "$GHOST_IDENTITY" "$DRIFTED_WS" "$APP_WS" ||
  fail "the recording can be placed for the morph (motion)" \
    "rewriting the layout to drift $IDENTITY to ws $DRIFTED_WS and add $GHOST_IDENTITY on ws $APP_WS failed"

# THE DRIFT IS THE SERVICE'S FACT and the chip's edge tone reads it, so it is
# waited for here — with the same caveat the missing state_loaded helper carries.
# `qs log` is the whole boot's, and an earlier test in it may well have published
# a drift above zero, so this line is a SIGNPOST and not the assertion: it makes
# a service that never noticed fail somewhere legible instead of as a payload
# poll timing out with nothing to say. What actually pins the drift is section 6,
# which requires edgeTone "drift" on the chip keyed by THIS test's own window.
drift_reported() { dr_log | grep -qE "status published .*drift=[1-9]"; }
if ! poll 40 drift_reported; then
  diagnostics
  fail "the service reports drift after the recording moved (motion)" \
    "no 'drift=<n>' above zero anywhere in the boot's log, though $IDENTITY is on ws $APP_WS and now recorded on ws $DRIFTED_WS"
fi
pass "recorded for real, then placed: $IDENTITY drifted to ws $DRIFTED_WS, $GHOST_IDENTITY recorded on ws $APP_WS"

# ------------------------------- 6. the LIVE map: the two animated channels
#
# Polled rather than read once, and the poll CAPTURES the payload it validated —
# the panel's own hyprctl reads are a process spawn away, its delegates report a
# frame after that, and the state file was rewritten a moment ago. Waiting for
# the PANEL's view of the recording (its own morph pair naming ws $DRIFTED_WS) is
# the point: a record taken before the panel noticed would file itself under the
# wrong answer, which is the mistake an earlier change paid for.

if ! poll 60 capture_live_state; then
  diagnostics
  # Named per clause. capture_live_state is one predicate over chips, the morph
  # object and three lists, and a message that described only one of them sent a
  # full gate cycle to the wrong diagnosis once already. If you are
  # reading this after a failure, replay $LIVE_JSON against each clause with jq
  # rather than assuming it is the first one listed.
  fail "panel IPC reports the live map with its motion wired" \
    "no live payload from '$IPC_TARGET state' satisfied the shape:
       EVERY CHIP — a non-zero fillMotionMs and edgeMotionMs, both equal to the morph animation's own durationMs, a Linear (0) motionEasing, one of the four morphRoles and a boolean morphFlying;
       THE MORPH — durationMs above zero, a non-Linear easing, runs and settled as numbers with settled <= runs, and the drawn chip keys accounted for exactly once across the pairs' live ends and liveOnly;
       BY NAME — $APP_ADDRESS watched, positioned, fill=watched with edge=drift, morphRole=paired, paired with a recorded-$IDENTITY chip on ws $DRIFTED_WS with geometry:true; $LOOSE_ADDRESS unwatched with morphRole=live-only and in liveOnly; a recorded-$GHOST_IDENTITY entry in recordedOnly
       (see the raw payload above)"
fi
printf '%s\n' "$LIVE_JSON" > "$ARTIFACTS/dock-recall-motion-state-live.json" 2>/dev/null || true

# The recorded end of the pair, READ OFF the answer rather than spelled here —
# PanelModel folds an occurrence into an instance key once an identity has more
# than one instance, so the exact string is its business. Everything after this
# names it.
RECORDED_KEY=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$APP_ADDRESS" \
  'first(.morph.pairs[]|select(.liveKey == $addr)|.recordedKey)//empty')
GHOST_KEY=$(printf '%s' "$LIVE_JSON" | jq -r --arg id "$GHOST_IDENTITY" \
  'first(.morph.recordedOnly[]|select(.key|test("^recorded-" + $id + "(#[0-9]+)?$"))|.key)//empty')
if [[ -z $RECORDED_KEY || -z $GHOST_KEY ]]; then
  diagnostics
  fail "the two recorded chips have keys to be named by (motion)" \
    "pair recordedKey '$RECORDED_KEY', recordedOnly key '$GHOST_KEY'"
fi

motion_ms=$(printf '%s' "$LIVE_JSON" | jq -r '.morph.durationMs')
motion_easing=$(printf '%s' "$LIVE_JSON" | jq -r '.morph.easing')
chip_motion=$(printf '%s' "$LIVE_JSON" | jq -r \
  '[.chips[]|"\(.key) fill=\(.fillState)/\(.fillMotionMs)ms edge=\(.edgeTone)/\(.edgeMotionMs)ms easing=\(.motionEasing)"]|join(", ")')
pass "POSITIONED chips report bound fades on both colour channels: $chip_motion"
pass "one duration off four animation objects: every chip fade and the morph fade report ${motion_ms}ms; the morph declares easing $motion_easing and the colour fades declare none (Linear 0), which is what Ui/ToggleSwitch does"

pair_line=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$APP_ADDRESS" \
  'first(.morph.pairs[]|select(.liveKey == $addr)
    |"\(.linkKey): \(.liveKey) on \(.liveMonitor)/\(.liveWorkspaceId) <-> \(.recordedKey) on \(.recordedMonitor)/\(.recordedWorkspaceId), geometry=\(.geometry), workspaceChanged=\(.workspaceChanged)")//"absent"')
pass "the matched pair, named at both ends: $pair_line"

sides=$(printf '%s' "$LIVE_JSON" | jq -r \
  '"pairs \(.morph.pairs|length), liveOnly [\([.morph.liveOnly[].key]|join(" "))], recordedOnly [\([.morph.recordedOnly[].key]|join(" "))]"')
pass "and the three-way answer accounts for every drawn chip: $sides"

# THE FLAG IS DOWN AND THE COUNTERS AGREE, before anything has been switched.
# This is the only shape in which `active` can be asserted honestly, and it is
# the half that matters: a flag that latched true would fail here, and a counter
# that latched would show as settled behind runs with nothing running.
runs_at_rest=$(printf '%s' "$LIVE_JSON" | jq -r '.morph.runs')
settled_at_rest=$(printf '%s' "$LIVE_JSON" | jq -r '.morph.settled')
at_rest=$(printf '%s' "$LIVE_JSON" | jq -r '.morph.active')
if [[ $at_rest != "false" || $runs_at_rest != "$settled_at_rest" ]]; then
  diagnostics
  fail "the morph flag is down at rest (motion)" \
    "with no view switch in flight the payload reports active=$at_rest, runs=$runs_at_rest, settled=$settled_at_rest"
fi
pass "at rest the morph flag is down and the counters agree (runs $runs_at_rest, settled $settled_at_rest)"

# ------------------------- 6b. ticking watched moves the fill under its Behavior
#
# The fill is the property the ColorAnimation is a Behavior ON, so the strongest
# thing this venue can say about it is that the property MOVED and that the chip
# it moved on is the chip reporting the animation. It cannot watch the colour
# cross; nothing here pretends otherwise.
#
# The row ticked is the UNWATCHED window, not the watched one: unticking the
# watched app would delete the identity its recorded layout names, and ticking it
# back would mint a new id rather than restore $IDENTITY. This one starts
# unwatched, so the round trip really is a round trip.
loose_link=$(printf '%s' "$LIVE_JSON" | jq -r --arg addr "$LOOSE_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey)//empty')
loose_row_key=$(printf '%s' "$LIVE_JSON" | jq -r --arg link "$loose_link" \
  'first(.rows[]|select(.linkKey == $link)|.key)//empty')
if [[ -z $loose_row_key ]]; then
  diagnostics
  fail "the unwatched window has a row to tick (motion)" \
    "no row reports the link key '$loose_link' that its chip does"
fi

tick_answer=$(omarchy-shell "$IPC_TARGET" toggleRow "$loose_row_key" 2>&1)
if [[ $tick_answer != "toggled" ]]; then
  diagnostics
  fail "panel IPC ticks a row (motion)" "toggleRow '$loose_row_key' answered '$tick_answer'"
fi

# Found through the CHIP's key, which is the window address and does not change —
# the row's own key and link key both do, because a ticked window stops being a
# class row and becomes an identity row.
fill_moved() {
  panel_state_json | jq -e --arg addr "$LOOSE_ADDRESS" --arg want "$1" \
    --argjson ms "$motion_ms" '
    ([.chips[]|select(.key == $addr and .fillState == $want
       and .fillMotionMs > 0 and .fillMotionMs == $ms)]|length) == 1' >/dev/null
}
if ! poll 30 fill_moved watched; then
  diagnostics
  fail "ticking watched moves the fill the Behavior is on" \
    "after toggleRow '$loose_row_key', the chip keyed $LOOSE_ADDRESS never reported fillState watched with its ${motion_ms}ms fill fade intact"
fi

untick_key=$(panel_state_json | jq -r --arg addr "$LOOSE_ADDRESS" \
  'first(.chips[]|select(.key == $addr)|.linkKey) as $l | first(.rows[]|select(.linkKey == $l)|.key)//empty')
untick_answer=$(omarchy-shell "$IPC_TARGET" toggleRow "$untick_key" 2>&1)
if [[ $untick_answer != "toggled" ]]; then
  diagnostics
  fail "panel IPC unticks a row (motion)" "toggleRow '$untick_key' answered '$untick_answer'"
fi
if ! poll 30 fill_moved unwatched; then
  diagnostics
  fail "unticking puts the fill back" \
    "after unticking '$untick_key', the chip keyed $LOOSE_ADDRESS did not report fillState unwatched again"
fi
pass "a tick moves the chip fill between unwatched and watched, and the ${motion_ms}ms fade stays bound to it across both"

# --------------------------------- 7. LIVE -> RECORDED: a morph ran and ended

# The counter as it stands BEFORE a switch, read through a guard rather than
# straight into a jq argument: an unreadable count would make every predicate
# below false and turn "the panel stopped answering" into "no morph ever ran",
# which is a diagnosis five steps away from the truth.
#
# It answers into a GLOBAL rather than onto stdout, and that is not a style
# choice: `fail` exits, and an exit inside a command substitution kills only the
# subshell — the caller would carry on with an empty string and the guard would
# have done nothing.
RUNS_NOW=""
SETTLED_NOW=""
read_runs() {
  RUNS_NOW=$(panel_state_json | jq -r '.morph.runs' 2>/dev/null)
  SETTLED_NOW=$(panel_state_json | jq -r '.morph.settled' 2>/dev/null)
  if ! [[ $RUNS_NOW =~ ^[0-9]+$ ]] || ! [[ $SETTLED_NOW =~ ^[0-9]+$ ]]; then
    diagnostics
    fail "the morph counters are readable (motion)" \
      "morph.runs/settled came back as '$RUNS_NOW'/'$SETTLED_NOW' before $1 — the panel is not answering at all, which is not the same fact as a morph that did not run"
  fi
}

read_runs "the switch to the recorded map"
runs_before="$RUNS_NOW"; settled_before="$SETTLED_NOW"

view_answer=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
if [[ $view_answer != "recorded" ]]; then
  diagnostics
  fail "panel IPC switches to the recorded map (motion)" "setView recorded answered '$view_answer'"
fi

# THE HONEST MEASUREMENT OF `morph.active`, PRINTED AND NEVER ASSERTED. A morph
# lasts as long as morph.durationMs says and an `omarchy-shell … state` round
# trip is a process spawn, a socket and a JSON encode of the whole payload — so
# this usually catches nothing, and a gate that required it to catch something
# would be a race dressed as a verdict. It is here so the claim in this file's
# header is a measurement in the log rather than an assurance. If a future run
# finds a way to observe the flag up reliably, this is the place that would say
# so; nothing has, and `runs`/`settled` below are what carry the claim instead.
active_hits=0
for _probe in 1 2 3 4 5 6 7 8; do
  panel_state_json | jq -e '.morph.active == true' >/dev/null 2>&1 && active_hits=$((active_hits + 1))
done
echo "# morph.active caught up in $active_hits of 8 reads straight after the switch (a ${motion_ms}ms flag against an omarchy-shell round trip; not asserted, see this file's header)"

# THE ASSERTION THAT DOES CARRY IT. `runs` is incremented by the animation's own
# `started` and `settled` by its own `finished`, so this one predicate says a
# morph BEGAN, that it ENDED, and that the flag went down again — none of which
# needs the 120ms window to be caught.
# `settled == runs` IS NOT AN INVARIANT, and asserting it would have been a trap
# laid for a future run rather than a check. `restart()` emits `stopped`, not
# `finished` — Panel.qml documents that deliberately — so ONE mid-morph reversal
# leaves runs permanently one ahead of settled, and this predicate could never be
# satisfied again for the life of that panel. The gate passes today only because
# its own switches are seconds apart; a human double-tapping the view toggle
# while reproducing it by hand would get a hard failure reporting nothing wrong.
#
# So assert what is actually monotone: a morph STARTED (runs went up) and one
# ENDED (settled went up) and the flag is down. That survives a reversal, and it
# still fails if either counter stops moving.
morph_ran_and_ended() {
  panel_state_json | jq -e --argjson runs "$1" --argjson settled "$2" \
    '.morph.runs > $runs and .morph.settled > $settled and .morph.active == false' >/dev/null
}
if ! poll 30 morph_ran_and_ended "$runs_before" "$settled_before"; then
  diagnostics
  fail "switching to the recorded map runs a morph and finishes it" \
    "after setView recorded the payload never reported runs above $runs_before with settled also above $settled_before and active false: $(panel_state_json | jq -c '.morph|{active, runs, settled}' 2>&1)"
fi
pass "LIVE -> RECORDED: a morph started and finished (runs $runs_before -> $(panel_state_json | jq -r '.morph.runs'), settled caught up, flag down)"

if ! poll 60 capture_recorded_state; then
  diagnostics
  fail "panel IPC reports the recorded map with its motion wired" \
    "no recorded payload satisfied the shape: every chip POSITIONED (the recording carries the at/size the plugin's own record wrote) with non-zero fill and edge fades; $RECORDED_KEY reporting morphRole=paired and $GHOST_KEY reporting morphRole=recorded-only; exactly one flight named $APP_ADDRESS -> $RECORDED_KEY, both of its rectangles clearing the ${CHIP_MIN_W}x${CHIP_MIN_H} chip floor and belonging to a pair the matcher marked geometry:true; and no flight for $GHOST_KEY, which has no other end to come from
       (see the raw payload above)"
fi
printf '%s\n' "$RECORDED_JSON" > "$ARTIFACTS/dock-recall-motion-state-recorded.json" 2>/dev/null || true
screenshot "success-dock-recall-motion-02-recorded"

recorded_motion=$(printf '%s' "$RECORDED_JSON" | jq -r \
  '[.chips[]|"\(.key) \(.renderPath) role=\(.morphRole) fill=\(.fillMotionMs)ms edge=\(.edgeMotionMs)ms"]|join(", ")')
pass "POSITIONED recorded chips, roles from the matcher: $recorded_motion"

flight_line=$(printf '%s' "$RECORDED_JSON" | jq -r --arg addr "$APP_ADDRESS" \
  'first(.morph.flights[]|select(.liveKey == $addr)
    |"\(.liveKey) -> \(.recordedKey): from \(.from.width|floor)x\(.from.height|floor) at \(.from.x|floor),\(.from.y|floor) to \(.to.width|floor)x\(.to.height|floor) at \(.to.x|floor),\(.to.y|floor)")//"absent"')
pass "the pair is TRANSLATED, and the overlay's own list says between which two drawn rectangles: $flight_line"

# ---------------------------- 8. RECORDED -> LIVE: the flight turns around

read_runs "the switch back to the live map"
runs_before_back="$RUNS_NOW"; settled_before_back="$SETTLED_NOW"
back=$(omarchy-shell "$IPC_TARGET" setView live 2>&1)
if [[ $back != "live" ]]; then
  diagnostics
  fail "panel IPC switches back to the live map (motion)" "setView live answered '$back'"
fi
if ! poll 30 morph_ran_and_ended "$runs_before_back" "$settled_before_back"; then
  diagnostics
  fail "switching back runs a second morph and finishes it" \
    "after setView live the payload never reported runs above $runs_before_back with settled caught up: $(panel_state_json | jq -c '.morph|{active, runs, settled}' 2>&1)"
fi

if ! poll 60 capture_live_back_state; then
  diagnostics
  fail "the live map survives a view flip, and keeps its flight" \
    "after setView recorded and back, the live payload no longer satisfies the whole motion shape, or no longer carries the flight $APP_ADDRESS -> $RECORDED_KEY. The workspace canvas registry outlives the view and both ends of a flight are resolved against it, so a recorded delegate's report overwriting a live one would show up exactly here"
fi
printf '%s\n' "$LIVE_BACK_JSON" > "$ARTIFACTS/dock-recall-motion-state-live-back.json" 2>/dev/null || true

# THE DIRECTION, from two payloads and no re-derivation. `from` and `to` are the
# only thing in this file that says which way the user just went, and a resolver
# that ignored `showRecorded` would fly every chip the same way from either tab
# and pass every other clause here. The two rectangles must also DIFFER: the app
# is recorded on a workspace it is not on, so its two ends are on two different
# canvases, and a flight from a rectangle to itself would be a morph that moved
# nothing.
if ! jq -e -n --argjson recorded "$RECORDED_JSON" --argjson live "$LIVE_BACK_JSON" \
  --arg addr "$APP_ADDRESS" '
    (first($recorded.morph.flights[]|select(.liveKey == $addr))) as $onRecorded |
    (first($live.morph.flights[]|select(.liveKey == $addr))) as $onLive |
    $onRecorded != null and $onLive != null
    and $onRecorded.from == $onLive.to
    and $onRecorded.to == $onLive.from
    and $onRecorded.from != $onRecorded.to' >/dev/null; then
  diagnostics
  fail "the flight turns around with the view" \
    "the flight for $APP_ADDRESS does not swap its two ends between the tabs, or its two ends are the same rectangle:
       on RECORDED: $(printf '%s' "$RECORDED_JSON" | jq -c --arg a "$APP_ADDRESS" 'first(.morph.flights[]|select(.liveKey == $a))|{from, to}' 2>&1)
       on LIVE:     $(printf '%s' "$LIVE_BACK_JSON" | jq -c --arg a "$APP_ADDRESS" 'first(.morph.flights[]|select(.liveKey == $a))|{from, to}' 2>&1)"
fi
pass "and the flight turns around: the two drawn rectangles swap ends when the tab does, and they are two different rectangles"

# ------------------------- 9. THE FALLBACK PATH: the same fades, no flight
#
# The layout is rewritten WITHOUT at/size, which is the shape of a v1 recording
# and of any read that came back without geometry, and it is what drops every
# recorded workspace to the stacked path. Nothing is re-recorded and no identity
# changes; only the geometry goes.
#
# Two things then have to be true at once, and only one of them is obvious. The
# obvious one is that the morph stops flying: a stacked workspace ignores its
# chips' rects, so the matcher reports `geometry: false` and the overlay carries
# nothing. The one this section exists for is that the chips go on reporting
# their two fade durations there — the fallback branch draws its own rows and has
# hidden a broken model for two live rounds before, and a rule calibrated on
# positioned chips can be wrong on fixed-height ones.
node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], key = process.argv[3];
  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = StateModel.layoutFor(state, key);
  if (!layout) { console.error("dock-recall motion test: no layout for " + key); process.exit(1); }
  var stripped = {
    topologyKey: layout.topologyKey,
    recordedAt: layout.recordedAt,
    apps: layout.apps.map(function (app) {
      return { identityId: app.identityId, occurrence: app.occurrence,
               monitorDescription: app.monitorDescription, slot: app.slot,
               floating: app.floating, group: app.group };
    })
  };
  fs.writeFileSync(statePath + ".tmp", StateModel.serializeState(StateModel.upsertLayout(state, stripped)));
  fs.renameSync(statePath + ".tmp", statePath);
' "$PLUGIN_DIR" "$STATE" "$TOPOLOGY_KEY" ||
  fail "the layout can be rewritten without geometry (motion)"

read_runs "the switch to the stacked recorded map"
runs_before_fallback="$RUNS_NOW"; settled_before_fallback="$SETTLED_NOW"
fallback_view=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
if [[ $fallback_view != "recorded" ]]; then
  diagnostics
  fail "panel IPC switches to the stacked recorded map (motion)" \
    "setView recorded answered '$fallback_view'"
fi
if ! poll 30 morph_ran_and_ended "$runs_before_fallback" "$settled_before_fallback"; then
  diagnostics
  fail "a morph with nothing to fly still runs and ends on the fallback path" \
    "after setView recorded on a geometry-less layout the payload never reported runs above $runs_before_fallback with settled caught up: $(panel_state_json | jq -c '.morph|{active, runs, settled}' 2>&1)"
fi

if ! poll 60 capture_fallback_state; then
  diagnostics
  fail "the FALLBACK path reports the same two fades, and flies nothing" \
    "after stripping the layout's geometry, no recorded payload satisfied the shape: every chip on the FALLBACK path, still reporting a non-zero fillMotionMs and edgeMotionMs equal to the morph's own durationMs; $RECORDED_KEY reporting morphRole=paired with morphFlying=false and $GHOST_KEY reporting morphRole=recorded-only; the pair $APP_ADDRESS <-> $RECORDED_KEY reporting geometry:false; and morph.flights carrying nothing at all, because a stacked workspace ignores its chips' rectangles and there is nowhere honest to fly from
       (see the raw payload above)"
fi
printf '%s\n' "$RECORDED_JSON" > "$ARTIFACTS/dock-recall-motion-state-fallback.json" 2>/dev/null || true
screenshot "success-dock-recall-motion-03-fallback"

fallback_motion=$(printf '%s' "$RECORDED_JSON" | jq -r \
  '[.chips[]|"\(.key) \(.renderPath) \(.width|floor)x\(.height|floor) role=\(.morphRole) flying=\(.morphFlying) fill=\(.fillMotionMs)ms edge=\(.edgeMotionMs)ms"]|join(", ")')
pass "FALLBACK chips report the same two bound fades the positioned ones do: $fallback_motion"
pass "and the pair cuts instead of flying: geometry=false, morph.flights empty, no chip standing aside for an overlay carrying nothing"

# ------------------------------------------ 10. THE BAR, over its own target

if ! poll 30 capture_bar_motion; then
  diagnostics
  fail "the bar widget reports its two animations" \
    "no answer from '$BAR_TARGET motion' satisfied the shape: a non-zero glyphFadeMs with a non-Linear easing, a non-zero sweepMs LONGER than the glyph fade (the sweep is a long looping hint, not a state change, and Motion.qml keeps its number separate for that reason), sweepRunning equal to sweeping, and a non-empty glyph. If the answer is empty, the bar is not carrying the widget and there is no route to these two objects at all — Panel.qml cannot see into a bar widget."
fi
printf '%s\n' "$BAR_JSON" > "$ARTIFACTS/dock-recall-motion-bar.json" 2>/dev/null || true

bar_line=$(printf '%s' "$BAR_JSON" | jq -r \
  '"glyph \(.glyph): glyphFade \(.glyphFadeMs)ms easing \(.glyphFadeEasing), sweep \(.sweepMs)ms running=\(.sweepRunning) sweeping=\(.sweeping)"')
pass "the bar widget's own IPC reports both its animations: $bar_line"

# THE FOURTH OBJECT AGREES, ACROSS THE IPC BOUNDARY. The bar widget is a separate
# top-level entry point with its own Motion instance, reached through a different
# target; that its glyph fade reports the same duration and the same curve as the
# panel's morph is a real cross-check and not a token compared to itself.
if ! jq -e -n --argjson bar "$BAR_JSON" --argjson ms "$motion_ms" --argjson easing "$motion_easing" \
  '$bar.glyphFadeMs == $ms and $bar.glyphFadeEasing == $easing' >/dev/null; then
  diagnostics
  fail "the bar and the panel report one convention" \
    "the panel's morph animation reports ${motion_ms}ms/easing $motion_easing and the bar's glyph fade reports $(printf '%s' "$BAR_JSON" | jq -r '"\(.glyphFadeMs)ms/easing \(.glyphFadeEasing)"') — two entry points, one Motion.qml, and they disagree"
fi
pass "one convention across two entry points: the bar's glyph fade is ${motion_ms}ms at easing $motion_easing, the same numbers the panel's morph reports"

# THE SWEEP ACTUALLY SWEEPS, driven through the widget's ONE input.
#
# The bar widget renders the published status file and nothing else — it runs a
# single FileView and no hyprctl of its own, which is the whole reason the status
# file exists. So the honest way to put it into its `restoring` state from here is
# to write that file, through the plugin's own StateModel so the bytes are a
# status and not this test's idea of one. What that proves is exactly what the
# DoD asks: the sweep animation is bound to the `sweeping` state and RUNS when the
# state says so. What it deliberately does not prove is that the SERVICE publishes
# `restoring` at the right moment — that is a fact about a restore cycle, and
# dock-recall-roundtrip-test.sh is where it is earned.
#
# The service is none the wiser: its own FileView here is write-only, and it skips
# a publish whose bytes are unchanged, so the copy restored on the way out leaves
# it exactly where it thought it was.
STATUS_SAVED=$(mktemp "${TMPDIR:-/tmp}/dock-recall-motion-status.XXXXXX")
if [[ -f $STATUS ]]; then
  STATUS_EXISTED=1
  cp -f "$STATUS" "$STATUS_SAVED" ||
    fail "the published status can be saved before the sweep is driven (motion)"
fi

node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statusPath = process.argv[2];
  var raw = "";
  try { raw = fs.readFileSync(statusPath, "utf8"); } catch (e) { raw = ""; }
  var current = StateModel.parseStatus(raw).status;
  var next = StateModel.mergeStatus(current, { restoring: true });
  if (StateModel.glyphState(next) !== "restoring") {
    console.error("dock-recall motion test: a restoring status does not resolve to the restoring glyph");
    process.exit(1);
  }
  fs.writeFileSync(statusPath + ".tmp", StateModel.serializeStatus(next));
  fs.renameSync(statusPath + ".tmp", statusPath);
' "$PLUGIN_DIR" "$STATUS" ||
  fail "a restoring status can be published for the bar to read (motion)"

sweeping_now() {
  bar_motion_json | jq -e '.glyph == "restoring" and .sweeping == true
    and .sweepRunning == true and .sweepMs > 0' >/dev/null
}
if ! poll 30 sweeping_now; then
  diagnostics
  fail "the bar's sweeping state actually sweeps" \
    "with a restoring status on disk, '$BAR_TARGET motion' never reported glyph restoring with sweeping AND sweepRunning true: $(bar_motion_json | head -c 400)"
fi
sweeping_line=$(bar_motion_json | jq -r '"glyph \(.glyph), sweeping=\(.sweeping), sweepRunning=\(.sweepRunning), \(.sweepMs)ms"')
pass "the sweep RUNS when the state says it should: $sweeping_line"

# AND IT STOPS. The other half of the same claim, and the one a bound-but-never-
# checked `running` would fail: a NumberAnimation on a property runs by default,
# so a widget whose binding was removed sweeps for ever under a glyph that is not
# restoring.
if [[ $STATUS_EXISTED == 1 ]]; then
  cp -f "$STATUS_SAVED" "$STATUS" || fail "the published status can be put back (motion)"
else
  rm -f "$STATUS"
fi
sweep_stopped() {
  bar_motion_json | jq -e '.glyph != "restoring" and .sweeping == false
    and .sweepRunning == false' >/dev/null
}
if ! poll 30 sweep_stopped; then
  diagnostics
  fail "the sweep stops when the state does" \
    "with the service's own status back on disk, the bar still reports $(bar_motion_json | jq -c '{glyph, sweeping, sweepRunning}' 2>&1)"
fi
pass "and it stops again when the status does — sweepRunning follows sweeping in both directions"

# ---------------------------------------------------------- 11. leave it closed

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
if ! poll 20 panel_layer_absent; then
  diagnostics
  fail "panel dismissed (motion)" "the panel's layer '$PANEL_NAMESPACE' is still mapped"
fi
pass "panel dismissed; the desk is back for the tests after this one (motion)"

capture_service_log
pass "dock-recall motion: bound durations on both render paths, and a morph that ran and ended"
