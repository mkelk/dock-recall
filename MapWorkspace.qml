// MapWorkspace.qml — one workspace box on the map, and everything drawn inside
// it: the number badge, the canvas, the chip slots, and the tabs fused into a
// slot when a tab group shares one window's worth of screen.
//
// WHY IT IS ITS OWN FILE. This was `Panel.qml`'s `workspaceSlot` delegate, and
// it sat twenty-seven levels deep — a Repeater in a Flow in a Column in a
// delegate in a Repeater in a Row, with three more delegates under that. At
// that depth the usable column is about twenty-eight characters, so a two-line
// binding carried thirty-six lines of comment, and heavy commenting is this
// plugin's main defence in a file of nearly five thousand lines. The depth had
// become a tax on the one thing holding the file together, and the tickets that
// followed drew window captures inside these very chips — which they now do
// (increment 06-bwf: `chipCapture` is below). Extracted in tick xk5 with no
// behaviour change at all: the same bindings in the same order, the same
// comments word for word, rewrapped to a column that fits them.
//
// THE INTERFACE IS ONE PROPERTY, and that is a measurement rather than a taste.
// The subtree reads twenty distinct members of the panel's root object — four
// colours and the font, the two hover keys, the keyboard cursor and its section,
// the two icon resolvers, the two report sinks, the render-key builder, the view
// flag, `toggleChip`, `ensureCursorVisible`, the tooltip width and the drift
// tone. Twenty pass-through properties would be twenty places to forget one when
// the next binding needs a twenty-first, so the component takes a handle on the
// panel itself and asks it directly.
//
// BOTH RENDER PATHS ARE HERE, and `positioned` is the branch. A workspace whose
// every window has geometry draws its chips where the windows really are; one
// missing a single rect falls back — wholesale, never mixed — to the stacked
// equal-height rows this panel drew before rects existed. The fallback NEVER
// calls chipRectsForCanvas, so any rule about chip size has to be checked
// against its fixed 17 px row as well as against a window-shaped chip.

import QtQuick
import QtQuick.Controls
import QtQuick.Shapes
import Quickshell
import qs.Commons
import qs.Ui
import "PanelModel.js" as PanelModel

BorderSurface {
  id: workspaceSlot

  // THE PANEL — the whole interface, and the reason it is one property is at
  // the top of this file. Everything this component asks of the panel it asks
  // through here, so `grep -o 'panel\.[a-zA-Z]*' MapWorkspace.qml | sort -u` is
  // the complete list of what an extraction has to keep working.
  required property var panel

  // The two things the map's outer scope knows and the panel does not: which
  // monitor box this workspace is sitting in (it qualifies the render key and
  // the focus key, because a stale recording can name one workspace id under
  // two monitors), and the width the Flow's grid allotted this box. Passed in
  // rather than reached for — a component that reads its parent's ids is not a
  // component.
  required property string monitorName
  required property real boxWidth

  required property var modelData

  // Is there geometry for every window in this workspace? When there is, the
  // chips are drawn where the windows really are; when there is not — a v1
  // recording, a read that came back without at/size — the whole workspace
  // falls back to the stacked slots this panel drew before, because mixing
  // the two would put an unplaced chip on top of a placed one.
  // PanelModel.workspaceModel owns that decision; this is the branch on it.
  readonly property bool positioned: workspaceSlot.modelData.fallback !== true
  readonly property int slotCount: workspaceSlot.modelData.slots.length

  // Which of the two layouts this workspace drew with, said by the delegate
  // that branches on it rather than derived a second time from the model.
  // Read back over IPC — see panel.panelState.
  readonly property string renderPath: workspaceSlot.positioned ? "positioned" : "fallback"
  readonly property string renderKey: panel.workspaceRenderKey(
    panel.showRecorded, workspaceSlot.monitorName, workspaceSlot.modelData.id)

  // WHAT THE BADGE SAYS. The workspace's own name, which for nearly every
  // desk is its number — the badge is a number badge, and "ws 7" spent three
  // characters saying what the box it sits on already says.
  readonly property string badgeValue: String(workspaceSlot.modelData.name)

  // Is this the workspace in front of the user? The ACTIVE workspace of the
  // FOCUSED monitor, and only that one — every monitor has an active
  // workspace, and filling all of them would say "you are here" three times
  // on a docked desk. Monitor-qualified, because a stale recording can name
  // one workspace id under two monitors.
  //
  // It is the live desk's focus on BOTH maps, and on the recorded one that is
  // the point: the recorded map is where the windows belong, and "you are
  // standing here" is the one thing about it that has to come from now rather
  // than from the recording.
  readonly property bool badgeFocused: panel.focusedWorkspaceKey !== ""
    && panel.focusedWorkspaceKey === PanelModel.workspaceKey(
      workspaceSlot.monitorName, workspaceSlot.modelData.id)

  function reportRender() {
    panel.reportWorkspaceRender(workspaceSlot.renderKey, {
      renderPath: workspaceSlot.renderPath,
      badgeValue: workspaceSlot.badgeValue,
      badgeFocused: workspaceSlot.badgeFocused
    })
  }
  onRenderPathChanged: workspaceSlot.reportRender()
  onBadgeValueChanged: workspaceSlot.reportRender()
  onBadgeFocusedChanged: workspaceSlot.reportRender()
  // A view flip rebuilds the map, but the key is view-namespaced, so report
  // under the new one whichever way the delegate gets there.
  onRenderKeyChanged: workspaceSlot.reportRender()
  Component.onCompleted: workspaceSlot.reportRender()

  // The drawing area, inside the border and under the workspace number badge
  // (`workspaceLabel` below — tick o9o replaced the flat "ws N" caption with
  // it, and the id outlived the wording).
  readonly property real canvasWidth: Math.max(1, workspaceSlot.boxWidth
    - workspaceSlot.contentLeftInset - workspaceSlot.contentRightInset)
  // A workspace fills its monitor, so its box is the MONITOR's shape —
  // anything else and every window drawn inside it is at the wrong
  // proportions, which is the whole point of drawing them to scale.
  readonly property real aspect: workspaceSlot.modelData.aspect > 0
    ? workspaceSlot.modelData.aspect : (16 / 9)
  readonly property real stackRowHeight: Style.space(17)
  readonly property real stackGap: Style.space(3)
  // Positioned: exactly the monitor's shape, which is what makes a half-width
  // window read as half a box. Fallback: the stacked rows this panel drew
  // before rects existed, and the box grows if there are more of them than
  // the monitor's shape has room for.
  readonly property real canvasHeight: workspaceSlot.positioned
    ? Math.max(1, Math.round(workspaceSlot.canvasWidth / workspaceSlot.aspect))
    : Math.max(Math.round(workspaceSlot.canvasWidth / workspaceSlot.aspect),
      workspaceSlot.slotCount * workspaceSlot.stackRowHeight
      + Math.max(0, workspaceSlot.slotCount - 1) * workspaceSlot.stackGap)

  // This workspace's fraction rects as a PLAIN JS array of plain objects, and
  // this copy is not ceremony — it is the repair.
  //
  // `modelData` reaches this delegate through Repeater.model, which is a
  // QVariant property, so the model's JS arrays are converted on the way in
  // and `modelData.slots` comes back as a QVariantList sequence wrapper. It
  // indexes and reports .length like an array, which is why everything else
  // about the delegate worked — but PanelModel.isArray asks
  // Object.prototype.toString for "[object Array]", and a sequence wrapper
  // answers something else. So chipRectsForCanvas took its `isArray(rects) ?
  // rects : []` branch and returned [] for EVERY workspace on the desk, with
  // no exception and no warning to show for it. Rebuilding the fractions here
  // hands the model a value it recognises.
  readonly property var slotRects: {
    var slots = workspaceSlot.modelData.slots
    var out = []
    for (var i = 0; i < (slots ? slots.length : 0); i++) {
      var r = slots[i] ? slots[i].rect : null
      out.push(r ? { rx: Number(r.rx), ry: Number(r.ry),
        rw: Number(r.rw), rh: Number(r.rh) } : null)
    }
    return out
  }

  // Where each chip lands, floors applied and the floors kept from drawing
  // two separate windows on top of each other — the defect the live round
  // caught on a workspace with two tiled windows. Resolved once per workspace
  // rather than per chip: a chip cannot know what its neighbours want.
  //
  // Sized from the canvas ITEM's laid-out width and height rather than from
  // the numbers that were fed to it. A Flow's first pass runs before its
  // width is known, and a rect resolved from a zero-width canvas must be a
  // frame, never a state: naming workspaceCanvas.width/height here is what
  // makes QML re-run this the moment the layout settles.
  //
  // THE FLOOR COMES FROM THE PANEL and is no longer spelled here (tick gug).
  // The morph's flight resolver calls this same function to work out where the
  // map drew a chip, and two callers handed different floors would put the
  // flight beside the chip instead of on it. `panel.chipFloorWidth` /
  // `chipFloorHeight` is the one site.
  readonly property var drawnRects: workspaceSlot.positioned
    ? PanelModel.chipRectsForCanvas(workspaceSlot.slotRects,
      workspaceCanvas.width, workspaceCanvas.height,
      panel.chipFloorWidth, panel.chipFloorHeight)
    : []

  // No silent degradation. `fallback: false` is the model's promise that
  // every slot in this workspace has geometry, so anything short of one
  // non-null rect per slot is a broken promise at this boundary — exactly the
  // shape of the defect above, which cost a whole live round precisely
  // because it threw nothing. Once per workspace, in `qs log`.
  property bool rectWarningShown: false
  onDrawnRectsChanged: {
    if (!workspaceSlot.positioned || workspaceSlot.rectWarningShown) return
    var rects = workspaceSlot.drawnRects
    var bad = !rects || rects.length !== workspaceSlot.slotCount
    for (var i = 0; !bad && i < rects.length; i++) {
      if (!rects[i]) bad = true
    }
    if (!bad) return
    workspaceSlot.rectWarningShown = true
    console.warn("dock-recall: ws " + workspaceSlot.modelData.name
      + " says fallback:false but chipRectsForCanvas returned "
      + (rects ? rects.length : "null") + " rect(s) for "
      + workspaceSlot.slotCount + " slot(s) — its chips cannot be placed")
  }

  width: workspaceSlot.boxWidth
  // Explicit, never derived from the children: the chips are positioned
  // INSIDE this height, so measuring the children to find it is a binding
  // loop even when the numbers happen to settle.
  height: workspaceLabel.implicitHeight + Style.space(3) + workspaceSlot.canvasHeight
    + workspaceSlot.contentTopInset + workspaceSlot.contentBottomInset
  color: "transparent"
  borderSpec: Border.controlSpec("normal", panel.faintForeground, panel.faintForeground)
  radius: Style.cornerRadius
  padding: Style.space(4)

  // THE WORKSPACE NUMBER BADGE. A filled pill rather than the flat "ws N" it
  // replaces: on a desk with ten workspaces per monitor the numbers are the
  // map's coordinates, and a caption in the faint foreground is the least
  // readable thing the panel draws.
  //
  // Accent-filled when this is the workspace in front of the user, quiet
  // otherwise — one filled badge on the whole map, so it reads as a position
  // rather than as a fifth state to decode. The quiet fill is the faint
  // foreground at low alpha, which is the same ink the flat label used and no
  // new colour.
  //
  // Its implicitHeight is load-bearing: the workspace box computes its own
  // height from it and the canvas is positioned under it.
  Rectangle {
    id: workspaceLabel
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.topMargin: workspaceSlot.contentTopInset
    anchors.leftMargin: workspaceSlot.contentLeftInset
    // Never narrower than it is tall: a one-digit badge is a circle, not a
    // sliver.
    implicitWidth: Math.max(workspaceBadgeText.implicitWidth + Style.space(7),
      workspaceLabel.implicitHeight)
    implicitHeight: workspaceBadgeText.implicitHeight + Style.space(2)
    width: implicitWidth
    height: implicitHeight
    // Follows the theme the way the kit's own switches do: pill on rounded
    // corners, square on sharp.
    radius: Style.cornerRadius > 0 ? height / 2 : 0
    color: workspaceSlot.badgeFocused
      ? Color.accent : Util.alpha(panel.faintForeground, 0.22)

    Text {
      id: workspaceBadgeText
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: workspaceSlot.badgeValue
      // On the accent fill the text has to be the panel's GROUND, not its
      // foreground — an accent-on-foreground badge is unreadable on any theme
      // whose accent is light.
      color: workspaceSlot.badgeFocused
        ? Color.popups.background : panel.faintForeground
      font.family: panel.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: workspaceSlot.badgeFocused
    }
  }

  Item {
    id: workspaceCanvas
    x: workspaceSlot.contentLeftInset
    y: workspaceSlot.contentTopInset + workspaceLabel.implicitHeight + Style.space(3)
    width: workspaceSlot.canvasWidth
    height: workspaceSlot.canvasHeight

    // WHERE THIS CANVAS ENDED UP, told to the panel because the panel cannot
    // work it out (tick gug). The morph's overlay flies a chip between two drawn
    // rectangles, and a drawn rectangle is this canvas's origin plus what
    // chipRectsForCanvas makes of the slot list inside it. The SIZE the panel
    // could almost derive; the ORIGIN it could not — it is under a
    // BorderSurface's insets and under a monitor-name Text whose height is font
    // metrics, inside a Flow whose wrapping depends on both.
    //
    // THE ITEM IS HANDED OVER, NOT ITS COORDINATES. This component does not know
    // what it is inside and must not: it reads no parent id, it maps nothing
    // upwards, it passes `workspaceCanvas` through the one interface it has and
    // the panel maps that into its own map canvas. `reportWorkspaceCanvas` is
    // idempotent, so calling it more often than necessary costs nothing.
    //
    // FOUR HANDLERS FOR FOUR VALUES, plus the two above this item: the report
    // captures an origin and a size, and the origin depends on where the WHOLE
    // workspace box landed in the Flow as much as on where the canvas sits
    // inside it. The report-site rule (.tick/learnings.md, tick sm1) is the
    // reason they are enumerated rather than assumed to cover each other, and
    // the Flow's first pass runs before its width is known — a report taken only
    // at completion is the warm-up answer, for ever.
    // THE KEY IS FROZEN AT CREATION, and that is what makes the missing
    // `onRenderKeyChanged` here correct rather than merely absent.
    //
    // The report-site rule (.tick/learnings.md, tick sm1) is one handler per
    // captured property, and `workspaceSlot.reportRender()` above obeys it. This
    // site cannot, because `renderKey` is bound to `panel.showRecorded`: on a
    // view flip the OUTGOING delegate's key flips to the incoming view before Qt
    // destroys it, so a handler here would re-report the outgoing map's geometry
    // under the incoming map's key — overwriting the very rect the flight's
    // destination end is resolved from. Freezing the key at creation makes it a
    // constant, so there is nothing left to watch and the rule is satisfied
    // rather than argued around.
    // Latched on FIRST report, not bound: a `readonly property … : expression`
    // is still a binding and would re-evaluate on the very flip this exists to
    // survive. Empty until then, and the first report is the one that fixes it.
    property string canvasKey: ""

    function reportCanvas() {
      if (!workspaceCanvas.canvasKey) {
        workspaceCanvas.canvasKey = panel.workspaceRenderKey(
          panel.showRecorded, workspaceSlot.monitorName, workspaceSlot.modelData.id)
      }
      panel.reportWorkspaceCanvas(workspaceCanvas.canvasKey, workspaceCanvas)
    }

    // THE BOX'S OWN POSITION IS HALF THE ANSWER, and it is watched from INSIDE
    // this item rather than from a handler on the box. The canvas's x and y do
    // not move when the Flow re-wraps and puts the whole workspace somewhere
    // else, so the box's position has to be an input too — but a handler up on
    // the box would fire before this item exists during creation, and would
    // then be calling a method on nothing. Mirrored into a property here, the
    // handler belongs to the object it uses.
    readonly property real boxX: workspaceSlot.x
    readonly property real boxY: workspaceSlot.y

    onBoxXChanged: workspaceCanvas.reportCanvas()
    onBoxYChanged: workspaceCanvas.reportCanvas()
    onXChanged: workspaceCanvas.reportCanvas()
    onYChanged: workspaceCanvas.reportCanvas()
    onWidthChanged: workspaceCanvas.reportCanvas()
    onHeightChanged: workspaceCanvas.reportCanvas()
    Component.onCompleted: workspaceCanvas.reportCanvas()

    Repeater {
      model: workspaceSlot.modelData.slots

      // A slot is one chip, or a fused run of chips that share a tab group —
      // drawn as one pill with dividers, because that is what a tab group is.
      // A tab group is also ONE window's worth of screen, which is why it
      // gets one rectangle however many tabs are in it.
      delegate: BorderSurface {
        id: chipSlot
        required property var modelData
        required property int index

        readonly property bool anyWatched: {
          for (var i = 0; i < modelData.chips.length; i++) {
            if (modelData.chips[i].watched) return true
          }
          return false
        }
        readonly property bool anyDrifted: {
          for (var j = 0; j < modelData.chips.length; j++) {
            if (modelData.chips[j].drifted) return true
          }
          return false
        }
        readonly property bool anyGhost: {
          for (var k = 0; k < modelData.chips.length; k++) {
            if (modelData.chips[k].ghost) return true
          }
          return false
        }
        // The drift tone outranks everything. The link highlight is carried
        // by the border STATE below rather than by a second colour, so a
        // drifted chip can light up under the pointer without stopping being
        // drifted — and a hovered chip that is NOT drifted brightens to the
        // ordinary foreground, which is the one thing the drift edge must
        // never be confused with. (panel.driftTone, and the gap it carries.)
        readonly property color edgeColor: chipSlot.anyDrifted
          ? panel.driftTone
          : (chipSlot.linkHovered ? panel.foreground
            : (chipSlot.anyWatched ? Color.accent : panel.faintForeground))

        // The same precedence as a WORD, so the payload can say which of the
        // four tones this edge is wearing. Reported beside the fill and
        // independent of it: a drifted chip has to be readable as drifted AND
        // as watched, and folding the two into one field is exactly how that
        // stops being possible.
        readonly property string edgeTone: chipSlot.anyDrifted
          ? "drift"
          : (chipSlot.linkHovered ? "hover"
            : (chipSlot.anyWatched ? "watched" : "quiet"))

        // THE TWO CHANNELS FADE RATHER THAN SNAP (tick fyi), and they fade
        // SEPARATELY because they mean separate things: a chip can become
        // drifted without becoming watched, and folding the two into one
        // animation would make the edge wait for the fill.
        //
        // No easing curve, deliberately. Omarchy's own Ui/ToggleSwitch gives
        // its ColorAnimation none — Qt's linear default is the shell's answer
        // for a colour, and OutCubic is its answer for something that MOVES.
        // Both durations come from Motion.qml; see the guard in
        // tests/qml-plaintext.test.js.
        // THE EDGE FADES ON A WRITABLE MIRROR, AND THAT IS NOT A STYLE CHOICE.
        // A Behavior is an INTERCEPTOR ON WRITES, and Qt refuses to install one
        // on a `readonly` property: `Behavior on edgeColor` made the whole
        // component unavailable — "Invalid property assignment: edgeColor is a
        // read-only property" — so Panel.qml could not build MapWorkspace and
        // the panel never mapped a surface at all. qmllint exits 0 on it.
        // `edgeColor` above stays readonly because it is the REPORTED channel
        // and `edgeTone` derives from the same precedence; this mirror is what
        // gets drawn, and it is the only thing the fade and the breathe touch.
        property color edgeDrawColor: chipSlot.edgeColor

        Behavior on color { ColorAnimation { id: fillFade; duration: panel.motion.duration } }
        Behavior on edgeDrawColor { ColorAnimation { id: edgeFade; duration: panel.motion.duration } }

        // THE DRIFT BREATHE (tick 5pu) — the epic's fourth named motion, and the
        // only one that is a LOOP rather than a transition.
        //
        // A drifted chip is the one thing on this map the user is meant to act
        // on, and until now it said so with colour alone: the accent edge, which
        // an ordinary watched chip also wears (an Omarchy theme has no amber —
        // see panel.driftTone and the gap it documents). A slow pulse is the
        // second channel, and it costs no new token and no new colour.
        //
        // IT MODULATES ALPHA, NOT THE TONE. `edgeColor` stays exactly what it
        // was — it is the reported channel, and `edgeTone` is derived from the
        // same precedence — so the payload keeps saying "drift" at full strength
        // while only the drawing breathes. Folding the pulse into edgeColor
        // would have made the fade Behavior above fight it every step.
        //
        // ONLY WHILE DRIFTED, so an in-sync desk animates nothing at all — the
        // same rule the bar's sweep follows. `alwaysRunToEnd` lets a chip that
        // stops drifting finish the half-breath it is in rather than snapping.
        property real driftBreathe: 1.0
        readonly property color breathingEdge: chipSlot.anyDrifted
          ? Qt.rgba(chipSlot.edgeDrawColor.r, chipSlot.edgeDrawColor.g,
              chipSlot.edgeDrawColor.b,
              chipSlot.edgeDrawColor.a * chipSlot.driftBreathe)
          : chipSlot.edgeDrawColor

        SequentialAnimation {
          id: driftBreathing
          running: chipSlot.anyDrifted
          loops: Animation.Infinite
          alwaysRunToEnd: true
          // The id is on the LEG, not on the group: a SequentialAnimation has no
          // `duration` of its own — it is the sum of its children and Qt does
          // not expose it — so reading `driftBreathing.duration` yielded
          // undefined and the report failed with "Unable to assign [undefined]
          // to int". Half a breath is the honest number to report anyway.
          NumberAnimation {
            id: breatheIn
            target: chipSlot; property: "driftBreathe"
            from: 1.0; to: 0.45
            duration: panel.motion.breatheDuration
            easing.type: panel.motion.easingType
          }
          NumberAnimation {
            target: chipSlot; property: "driftBreathe"
            from: 0.45; to: 1.0
            duration: panel.motion.breatheDuration
            easing.type: panel.motion.easingType
          }
        }

        // WHICH FILL, as a word — the state channel, and the reason it is a
        // channel at all.
        //
        // Watched, unwatched and ghost used to be told apart by outline
        // brightness with a fill on only one of them, and outline brightness
        // is the weakest signal in the panel: an accent edge at rest and an
        // accent edge under the pointer are a few percent of alpha apart.
        // Each state now has its own fill, from the kit's own helpers, so the
        // outline is free to carry drift and hover instead of carrying
        // everything.
        //
        // HOVER IS NOT IN HERE. It is drawn as a layer over whichever fill
        // this is (see chipHoverFill below), because the previous binding
        // REPLACED the watched fill with the hover fill and a watched chip
        // under the pointer became indistinguishable from an unwatched one.
        // It is also transient, and a payload polled over IPC would race it.
        //
        // Per SLOT, like anyWatched and anyGhost: the fill is the slot's
        // rectangle, and a fused tab group is one rectangle however many tabs
        // share it.
        readonly property string fillState: chipSlot.anyGhost
          ? "ghost"
          : (chipSlot.anyWatched ? "watched" : "unwatched")

        // Does the keyboard cursor sit on one of this slot's chips? Asked per
        // slot rather than per chip so a fused tab group shows one cursor, on
        // the pill.
        readonly property bool hasCursor: {
          if (panel.focusSection !== "chips") return false
          for (var c = 0; c < modelData.chips.length; c++) {
            if (modelData.chips[c].key === panel.cursorKey) return true
          }
          return false
        }

        // The map is the tallest thing in the card and the arrows walk it in
        // reading order, so a chip low on the last monitor is as far below
        // the fold as the footer is.
        onHasCursorChanged: if (hasCursor) panel.ensureCursorVisible(chipSlot)

        // THE MORPH, PER SLOT (tick gug). Does the pure matcher say one of the
        // windows in this slot is on the OTHER map too?
        //
        // Per slot rather than per chip because opacity is: the slot is the
        // rectangle, and a fused tab group is one rectangle however many tabs
        // share it. A group with one paired member counts as paired — it holds
        // a window that was already on screen, and fading the pill out from
        // under it would be a lie about the other tabs as much as about that
        // one.
        //
        // The panel answers from ONE pairing it computed once; this is a
        // lookup, never a match (PanelModel.morphChipRoles says why at length).
        //
        // "" COUNTS AS CONTINUOUS, and that is deliberate rather than sloppy: it
        // is a window that opened between two map builds and no pairing has
        // classified yet. Fading it out from under the user on the strength of
        // an index that has not caught up would be the worst of the three
        // answers, and morphRoleAt says in as many words that "" is not a fourth
        // role.
        //
        // Only two roles can appear on the map that is showing — the paired end
        // and that map's own one-sided list — so this needs no second question
        // about which tab it is on.
        readonly property bool morphContinuous: {
          for (var mp = 0; mp < modelData.chips.length; mp++) {
            var role = panel.morphRoleOf(modelData.chips[mp].key)
            if (role === "paired" || role === "") return true
          }
          return false
        }

        // IS THE OVERLAY CARRYING ONE OF THESE CHIPS RIGHT NOW? A pair the panel
        // could resolve to two drawn rectangles is TRANSLATED, by a rectangle of
        // the panel's own above this whole map — so the real chip has to stand
        // aside for the length of the flight or the user sees two of it, one
        // moving and one already arrived.
        //
        // GATED ON `panel.morphRunning`, WHICH IS THE ANIMATION'S OWN `running`.
        // That is the whole safety argument: whatever stops the animation —
        // finishing, a mid-flight reversal, a stop nobody planned — makes this
        // false in the same instant, and the chip is back. There is no state
        // here to get stuck in, which is the "it must go down again" rule
        // applied to the thing the flag controls rather than to the flag.
        //
        // The panel is asked which chips are flying rather than being told:
        // `morphFlights` is the list the overlay's own Repeater is built from,
        // so the chip that stands aside and the rectangle that flies cannot
        // disagree about which chips those are.
        readonly property bool morphFlying: {
          if (!panel.morphRunning) return false
          for (var mf = 0; mf < modelData.chips.length; mf++) {
            if (panel.morphFlyingKey(modelData.chips[mf].key)) return true
          }
          return false
        }

        // A CHIP THAT WAS ALREADY ON SCREEN MUST NOT BLINK; an entering one
        // fades in; one the overlay is flying stands aside entirely.
        // `panel.morphProgress` is 1.0 at rest and is driven by the panel's
        // single morph animation, so this binding costs nothing when no switch
        // is happening and cannot strand a chip when one is interrupted — see
        // the morph section in Panel.qml.
        readonly property real morphOpacity: chipSlot.morphFlying
          ? 0.0
          : (chipSlot.morphContinuous ? 1.0 : panel.morphProgress)

        // Is the thing the pointer is on — here or down in the list — this
        // app? Same question per slot, for the same reason.
        readonly property bool linkHovered: {
          if (panel.hoveredLinkKey === "") return false
          for (var h = 0; h < modelData.chips.length; h++) {
            if (modelData.chips[h].linkKey === panel.hoveredLinkKey) return true
          }
          return false
        }

        readonly property bool highlighted: chipSlot.hasCursor || chipSlot.linkHovered

        // The window's own rectangle, scaled onto this workspace's canvas —
        // or, when the workspace has no geometry to draw with, the stacked
        // row it always had.
        //
        // The floor is not cosmetic: a terminal occupying 8% of an ultrawide
        // is four pixels of chip, which is not a control and cannot be
        // clicked. It used to be 24 spacing units wide, which on the tiny
        // canvases the old layout produced clamped EVERY chip to the full
        // width of its workspace and drew two tiled windows one on top of the
        // other. It is 16×10 px now, and PanelModel.chipRectsForCanvas is
        // where the rule that the floor may never superimpose two separate
        // windows lives.
        readonly property var drawn: {
          if (!workspaceSlot.positioned) return null
          var rects = workspaceSlot.drawnRects
          if (!rects || chipSlot.index >= rects.length) return null
          return rects[chipSlot.index] || null
        }

        // Which of the two layouts this chip is in is the MODEL's answer and
        // nobody else's: the stacked rows are reachable only from `positioned
        // === false`, i.e. only when workspaceModel set fallback: true. They
        // used to be reachable from a null `drawn` as well, and that is how a
        // workspace with perfectly good geometry drew itself as a stack for a
        // whole release without a word in the log. A positioned workspace
        // missing a rect now draws a floor-sized marker at the canvas origin
        // — visibly wrong, and warned about above — rather than borrowing a
        // layout that looks deliberate.
        x: workspaceSlot.positioned
          ? (chipSlot.drawn ? chipSlot.drawn.x : 0)
          : 0
        y: workspaceSlot.positioned
          ? (chipSlot.drawn ? chipSlot.drawn.y : 0)
          : chipSlot.index * (workspaceSlot.stackRowHeight + workspaceSlot.stackGap)
        width: workspaceSlot.positioned
          ? (chipSlot.drawn ? chipSlot.drawn.width : panel.chipFloorWidth)
          : workspaceCanvas.width
        height: workspaceSlot.positioned
          ? (chipSlot.drawn ? chipSlot.drawn.height : panel.chipFloorHeight)
          : workspaceSlot.stackRowHeight
        radius: Style.cornerRadius
        // THE STATE FILL. Three states, three fills, all from Style so a
        // theme moves them together:
        //
        //   watched    the SELECTED fill — this app is in the recording
        //   ghost      the NORMAL fill — recorded, but nothing is running;
        //              the quieter ground under the dashed outline below
        //   unwatched  none at all, which is the right amount of ink for
        //              "the tool is not tracking this"
        color: chipSlot.fillState === "watched"
          ? Style.selectedFillFor(panel.foreground, Color.accent)
          : (chipSlot.fillState === "ghost"
            ? Style.normalFillFor(panel.foreground, Color.accent)
            : "transparent")
        // A ghost draws its outline with the Shape below instead, so the
        // solid one steps aside.
        //
        // The border STATE is where drift outranks everything: "selected" is
        // the kit's strongest resting edge, and it is what keeps a drifted
        // chip from reading as an ordinary watched one now that both wear the
        // accent (an Omarchy theme has no amber — see panel.driftTone and the
        // gap it documents). A drifted chip under the pointer keeps that edge
        // and picks up the hover FILL instead, which is the same
        // separate-channels rule applied twice.
        borderSpec: chipSlot.anyGhost && !chipSlot.highlighted
          ? Border.none()
          : Border.controlSpec(chipSlot.anyDrifted ? "selected"
              : (chipSlot.highlighted ? "hover-cursor" : "normal"),
            chipSlot.breathingEdge, chipSlot.breathingEdge)
        // A ghost is drawn quieter than a running window, and a chip entering
        // on a view switch is drawn quieter still while it arrives. The two are
        // multiplied rather than one overriding the other: a recorded ghost
        // fading in has to end up at a ghost's 0.6, not at full weight.
        opacity: (chipSlot.anyGhost ? 0.6 : 1.0) * chipSlot.morphOpacity

        // HOVER, as a layer over the state fill rather than instead of it.
        // Declared first so it paints under the ghost outline and the chip
        // content, and translucent (every Style *FillFor is), so what shows
        // through is the fill the chip already had.
        Rectangle {
          anchors.fill: parent
          visible: chipSlot.highlighted
          radius: chipSlot.radius
          color: Style.hoverFillFor(panel.foreground, Color.accent)
        }

        // Recorded-but-not-running: a dashed outline, the one shape in the
        // panel that says "this is where it goes" rather than "this is where
        // it is".
        Shape {
          anchors.fill: parent
          visible: chipSlot.anyGhost
          antialiasing: true

          ShapePath {
            strokeColor: Color.accent
            strokeWidth: 1
            strokeStyle: ShapePath.DashLine
            dashPattern: [3, 3]
            fillColor: "transparent"
            startX: 0.5
            startY: 0.5
            PathLine { x: chipSlot.width - 0.5; y: 0.5 }
            PathLine { x: chipSlot.width - 0.5; y: chipSlot.height - 0.5 }
            PathLine { x: 0.5; y: chipSlot.height - 0.5 }
            PathLine { x: 0.5; y: 0.5 }
          }
        }

        Row {
          id: chipRow
          anchors.fill: parent
          // A chip drawn at the minimum size is shorter than its label wants
          // to be. The label elides horizontally; this stops a descender
          // spilling onto the chip below. Clipped HERE rather than on the
          // slot, so the slot's own border is not clipped along with it.
          clip: true
          spacing: 0

          Repeater {
            model: chipSlot.modelData.chips

            delegate: Item {
              id: chipTab
              required property var modelData
              required property int index

              // The whole of what the panel knows about this window,
              // assembled by a pure function so the tooltip and the tests
              // read the same sentence.
              readonly property string tipText: PanelModel.wrapTooltip(
                PanelModel.chipTooltipText(chipTab.modelData),
                panel.chipTooltipColumns)

              // Which layout drew THIS chip. The same flag its slot's x, y,
              // width and height branch on, reported from inside the delegate
              // that applied it — see panel.panelState.
              readonly property string renderPath: workspaceSlot.positioned
                ? "positioned" : "fallback"

              // Did the slot get a resolved rectangle, or is this the silent
              // second branch inside `positioned` — the floor-sized marker at
              // the canvas origin that the x/y/width/height bindings above
              // fall back to? Same `drawn` those bindings read, so the
              // payload cannot claim placement the drawing did not have.
              readonly property bool placed: chipSlot.drawn !== null

              // This app's icon, and whether it is the app's OWN icon or the
              // generic executable one. Held as properties rather than
              // written straight into the Image below, because the same two
              // values are what the chip REPORTS — the payload has to carry
              // what was bound, not a second derivation that could agree with
              // the model while the Image drew something else.
              //
              // Identity first, class second: a recorded ghost has no window
              // and so no class at all, and its identity is the only handle
              // it has.
              readonly property string iconSource: panel.iconSourceOf(
                chipTab.modelData.identityId, chipTab.modelData.className)
              readonly property bool iconResolved: panel.iconResolvedOf(
                chipTab.modelData.identityId, chipTab.modelData.className)

              // THE SECOND CONSENT, per chip (tick qnc). Watched says the tool
              // may MOVE this window; pictured says it may PHOTOGRAPH it, and
              // the two are independent grants — so the payload says both
              // rather than one flag a consumer would have to guess the other
              // from. Off for every chip whose window matches no identity: an
              // app nobody watches has consented to nothing.
              readonly property bool pictured: panel.picturedOf(
                chipTab.modelData.identityId)

              // THE STORED PICTURE, as a URL the Image below binds (tick vbh).
              // "" when this chip has none — an unpictured app, a recording
              // taken before the consent was granted, a cache a cleaner has
              // wiped — and "" on the LIVE map always, because a photograph of
              // a window laid over the window itself is a staler picture of the
              // same thing.
              //
              // Held as a property rather than written straight into the Image
              // for the reason the icon pair is: the payload has to carry what
              // was BOUND, not a second derivation that could agree with the
              // cache while the Image drew nothing.
              //
              // THE CAMERA GATE IS THE PANEL'S, NOT A SECOND ONE HERE (tick
              // sp7). `panel.captureFileFor` already answers "" for an identity
              // whose camera is off, so a withdrawn picture stops being drawn in
              // the same frame the flag is written — before the `find` that
              // deletes it has even been spawned. Adding `&& chipTab.pictured`
              // to the Image below as well would be a SECOND derivation of the
              // same fact, and this property — the one the payload reports as
              // bound — would then be able to name a picture the chip is not
              // drawing. That is precisely the disagreement the paragraph above
              // exists to prevent, so the gate stays in the one place both
              // readers go through.
              readonly property string captureSource: panel.captureSourceOf(
                chipTab.modelData.identityId, chipTab.modelData.occurrence)

              // Is that picture actually ON THE CHIP? The source is what the
              // Image was pointed at; this is whether it arrived. They differ
              // for a real reason: the panel's cache listing is re-read when it
              // opens and when the desk changes, not on a timer, so a file
              // deleted under a live panel leaves a source that names a file
              // that is no longer there. The Image's own status is the only
              // thing that knows, and it is what the payload reports — so
              // `captureSource` in the payload always means "this chip is
              // drawing this", never "the panel thinks it could".
              readonly property bool captureDrawn:
                chipCapture.status === Image.Ready

              // WHICH OF FIVE DRAWINGS THIS CHIP EARNS, from the size it
              // actually got. The ladder:
              //
              //   pill    icon and name together on a ground
              //   badge   the icon alone, no text
              //   strip   icon and name on one line, for a chip that is wide
              //           but far too short for a pill — the fallback
              //           stack's rows, which are canvas-wide and 17 px tall
              //           and would otherwise be nameless icons forever
              //   veiled  the content veiled, the icon centred on it
              //   field   the colour field alone
              //
              // Asked with the DRAWN width and height, not with anything off
              // the model, and that is the whole reason
              // PanelModel.chipTreatment is a standalone function: the
              // fallback stacked path never calls chipRectsForCanvas, so a
              // treatment carried on the model would be silently wrong on it.
              // Asking at draw time is right on both paths.
              //
              // chipTab.width is one TAB's share — a fused tab group divides
              // its rectangle between its members, and three tabs in one pill
              // each earn their own tier.
              //
              // This SUPERSEDES chipLabelVisible, which decided the label on
              // width alone. Two thresholds disagreeing about whether a chip
              // has room for its name is exactly the confusion the ladder
              // exists to end, so the old one is gone rather than left beside
              // this.
              readonly property string treatment:
                PanelModel.chipTreatment(chipTab.width, chipTab.height)

              // Reported unrounded: a consumer reproducing the treatment has
              // to be handed the same numbers the panel used, not tidied
              // ones.
              function reportRender() {
                panel.reportChipRender(chipTab.modelData.key, {
                  renderPath: chipTab.renderPath,
                  placed: chipTab.placed,
                  width: chipTab.width,
                  height: chipTab.height,
                  // The two icon values the Image below actually binds.
                  // Reported from the same delegate on BOTH render paths —
                  // the delegate is one, only its geometry branches — so the
                  // fallback stack cannot quietly draw something else.
                  iconSource: chipTab.iconSource,
                  iconResolved: chipTab.iconResolved,
                  // The second consent, from the same delegate and on both
                  // render paths, for the same reason the icon pair is.
                  pictured: chipTab.pictured,
                  // The picture this chip IS DRAWING — the bound source, but
                  // only once the Image reports Ready. "" here becomes an
                  // ABSENT key in the payload, never an empty string, which
                  // would be a second spelling of "nothing to say".
                  //
                  // Gated on the status rather than reported raw, because the
                  // raw source is a claim the panel makes and this is a claim
                  // the CHIP makes. A capture deleted under a live panel leaves
                  // the panel's `capturePath` standing (its listing is stale by
                  // one open) and takes this away, and that disagreement is the
                  // information: the cache index says there is a picture, the
                  // chip could not draw it.
                  captureSource: chipTab.captureDrawn ? chipTab.captureSource : "",
                  // The tier the drawing below branches on, from the same
                  // property those bindings read — so a consumer can
                  // reproduce it with chipTreatment(width, height) on the two
                  // numbers reported beside it, and a disagreement is a real
                  // one.
                  treatment: chipTab.treatment,
                  // The two colour channels, said separately because they are
                  // separate. A drifted chip is fillState "watched" AND
                  // edgeTone "drift", and a consumer that could only read one
                  // of them could not tell a drifted watched chip from either
                  // half alone. Both live on the SLOT — the rectangle a fused
                  // tab group shares — and every chip in it reports the same
                  // pair, which is what the screen shows.
                  fillState: chipSlot.fillState,
                  edgeTone: chipSlot.edgeTone,
                  // The chip's half of the row-to- chip link: the key it
                  // answers to, and whether it is answering right now.
                  // `linkHovered` is per SLOT because a fused tab group
                  // lights up as one pill.
                  linkKey: String(chipTab.modelData.linkKey || ""),
                  linked: chipSlot.linkHovered,
                  // THAT THE TWO CHANNELS ARE ANIMATED AT ALL (tick fyi).
                  //
                  // Read off the ANIMATION OBJECTS, never off Motion.qml. The
                  // acceptance VM cannot see a colour move, so the most it can
                  // ask is "is this property bound to a running animation with a
                  // real duration" — and it can only ask that honestly if the
                  // number comes from the thing doing the animating. Reporting
                  // `panel.motion.duration` here would restate the token and
                  // pass on a chip whose Behavior somebody had deleted, which is
                  // the self-consistent assertion this increment has already
                  // been bitten by twice.
                  fillMotionMs: chipTab.fillMotionMs,
                  edgeMotionMs: chipTab.edgeMotionMs,
                  motionEasing: chipTab.motionEasing,
                  // THE DRIFT BREATHE (tick 5pu). Half a breath's duration, off
                  // the animation object, and whether it is RUNNING — which is
                  // the assertion that matters, because a loop bound to a chip
                  // that is not drifted would pulse the whole map, and a loop
                  // that never runs is not motion. `breathing` must agree with
                  // `drifted` on every chip, and a test can check that without
                  // knowing anything about the curve.
                  breatheMs: chipTab.breatheMs,
                  breathing: chipTab.breathing,
                  drifted: chipSlot.anyDrifted,
                  // WHICH SIDE OF THE MORPH THIS CHIP IS ON (tick gug), from
                  // the same lookup its slot's opacity binding reads. The
                  // panel could answer this about the chip without asking the
                  // chip — it holds the pairing — and that is exactly why the
                  // CHIP says it: an answer the panel gives itself would agree
                  // with the panel while the map faded something else, which
                  // is the self-consistent assertion this increment has
                  // already been bitten by twice.
                  morphRole: chipTab.morphRole,
                  // AND WHETHER THE OVERLAY IS CARRYING IT AT THIS INSTANT —
                  // "paired" says the matcher agreed about this window, which
                  // is not the same claim as "it is being translated": a pair
                  // whose ends are on a fallback workspace, or whose
                  // destination has not laid out yet, is paired and stays
                  // still. The chip on screen is the only thing that can say
                  // which of the two it is doing.
                  morphFlying: chipSlot.morphFlying
                })
              }

              // The bound animations, as numbers a payload can carry. They are
              // constants once bound — Motion.qml's tokens are readonly ints —
              // so there is nothing to re-report when they "change"; the
              // handlers below exist anyway, because the report-site rule
              // (.tick/learnings.md, tick sm1) is that a site carries an
              // onXChanged for EVERY property it captures, and an exception
              // argued per property is how that rule stops being checkable.
              readonly property int fillMotionMs: fillFade.duration
              readonly property int edgeMotionMs: edgeFade.duration
              // Qt's easing enum, straight off the fill's animation. A colour
              // fade declares no curve — the shell's own ColorAnimations do
              // not — so this is Easing.Linear by design, and the assertion
              // that matters is the DURATION being non-zero.
              readonly property int motionEasing: fillFade.easing.type

              // HALF A BREATH, off the loop's own first leg, and whether the
              // loop is running. `driftBreathing` lives on the SLOT — a fused
              // tab group is one pill with one edge, so it breathes once, not
              // once per tab — and every chip in it reports the same pair, the
              // way the fill and edge tones already do.
              readonly property int breatheMs: breatheIn.duration
              readonly property bool breathing: driftBreathing.running

              // This chip's place in the pure matcher's answer: "paired" on
              // both maps, "live-only" or "recorded-only" on one, "" for a
              // window no pairing has classified yet. Held as a property rather
              // than looked up inside reportRender for the reason every other
              // reported value here is — the report must carry what the drawing
              // read, and the slot's opacity binding reads this same lookup.
              readonly property string morphRole: panel.morphRoleOf(chipTab.modelData.key)

              onFillMotionMsChanged: chipTab.reportRender()
              onEdgeMotionMsChanged: chipTab.reportRender()
              onMotionEasingChanged: chipTab.reportRender()
              onBreatheMsChanged: chipTab.reportRender()
              // The one that genuinely moves under a live delegate: a chip
              // starts and stops drifting while the panel is open.
              onBreathingChanged: chipTab.reportRender()
              // The pairing is rebuilt on every desktop read, so this one DOES
              // move under a live delegate — a window opening on the other map
              // can turn a "live-only" chip into a "paired" one without
              // anything else about this chip changing. Per the report-site
              // rule (.tick/learnings.md, tick sm1) it would carry a handler
              // either way.
              onMorphRoleChanged: chipTab.reportRender()
              onRenderPathChanged: chipTab.reportRender()
              onPlacedChanged: chipTab.reportRender()
              onIconSourceChanged: chipTab.reportRender()
              onIconResolvedChanged: chipTab.reportRender()
              onPicturedChanged: chipTab.reportRender()
              onCaptureSourceChanged: chipTab.reportRender()
              // Both, per the report-site rule: a site must carry an onXChanged
              // for EVERY property it captures (.tick/learnings.md, tick sm1).
              // The image load is asynchronous, so `captureDrawn` lands after
              // `captureSource` and nothing else would report it.
              onCaptureDrawnChanged: chipTab.reportRender()
              onTreatmentChanged: chipTab.reportRender()
              // The slot owns both colour channels, so the chip has to be
              // told when they move — a tick that changes watched changes the
              // fill without touching anything else this delegate binds.
              Connections {
                target: chipSlot
                function onFillStateChanged() { chipTab.reportRender() }
                function onEdgeToneChanged() { chipTab.reportRender() }
                function onLinkHoveredChanged() { chipTab.reportRender() }
                // Reported beside `breathing`, and the pair is the assertion:
                // a chip that drifts must breathe and a chip that does not must
                // not. Neither alone says that.
                function onAnyDriftedChanged() { chipTab.reportRender() }
                // The flight flag lives on the slot for the same reason the two
                // colour channels do — it is the rectangle that stands aside —
                // and it moves twice per morph, up and down. Per the report-site
                // rule it needs its own handler here; without one the payload
                // would show every chip standing still through every flight.
                function onMorphFlyingChanged() { chipTab.reportRender() }
              }
              // The Flow's first pass runs before its width is known and the
              // rects settle a frame or two later, so the size has to be
              // re-reported when it lands — a report taken only at completion
              // is the 1×1 warm-up answer, for ever.
              onWidthChanged: chipTab.reportRender()
              onHeightChanged: chipTab.reportRender()
              // The same handler the app row carries, for the same reason.
              // This report captures values taken straight off `modelData` —
              // the key it is filed under, and `linkKey` — and NOTHING else
              // here fires when modelData is replaced under a delegate that
              // survives. That it cannot happen today is a fact about
              // QQuickRepeater regenerating its delegates on any model
              // change, which is a claim about a component's internals rather
              // than about this file; the `sm1` family of defects is what
              // "nothing told this delegate to report again" costs, and two
              // delegates reporting the same kind of value should not
              // disagree about when to do it. Cheap, and idempotent:
              // reportChipRender merges into a store.
              onModelDataChanged: chipTab.reportRender()
              Component.onCompleted: chipTab.reportRender()

              // The tab strip divides the slot's rectangle evenly; a solo
              // chip is simply a strip of one, which is why there is no
              // second code path for it.
              width: chipRow.width / chipSlot.modelData.chips.length
              height: chipRow.height

              // THE STORED PICTURE (tick vbh), and where it sits is the whole
              // design: FIRST in document order, so it is the chip's GROUND.
              // QML paints siblings in the order they are declared, so the veil
              // below it quietens it and the icon and the name paint on top —
              // the capture fills in UNDERNEATH the content rather than
              // replacing it.
              //
              // IT CANNOT PUSH THE NAME OUT. It is a sibling of `chipContent`,
              // not a member of it: the Column that lays out the pill, the icon
              // and the label never sees this item and its width is unchanged
              // by it. That matters here more than anywhere — the Recorded map
              // is entirely the FALLBACK path, whose 210x17 stacked rows are
              // where names were only just restored (tick ajp), and a capture
              // that cost them their label would undo that silently.
              //
              // The pill's own translucent ground is what keeps the name
              // legible over a photograph, which is exactly what its comment
              // has always said it was for.
              //
              // NO EMPTY-IMAGE FLASH, and no broken picture: `visible` is gated
              // on Image.Ready, so a source that is still loading, has failed,
              // or was never set draws nothing at all and the chip is what it
              // was before this tick — its icon and its name.
              //
              // A DELETED CAPTURE, in two halves. `panel.captureSourceOf` is
              // gated on a directory listing that is re-read whenever the panel
              // opens and whenever the desk changes, so a panel opened after a
              // cleaner ran never points an Image at a file that is not there —
              // and since the shell destroys the panel's Loader on hide, that is
              // every real "it went while I was not looking". Within ONE session
              // a chip that has already decoded its picture goes on drawing it,
              // which is right: a photograph the plugin legitimately took does
              // not become wrong because the file behind it was removed. The one
              // seam is an EXTERNAL delete followed by a re-evaluation of this
              // binding in the same session, which logs Qt's own "Cannot open"
              // and then draws nothing — correct, and noisy in the shell log
              // rather than in the panel.
              //
              // PreserveAspectCrop with clip, because the chip is the window's
              // own rectangle scaled and the picture is the same window: the
              // proportions already agree, and cropping the last pixel of a
              // rounding difference reads better than a letterbox bar.
              //
              // `cache: false` because the path does not change when the
              // picture does. A re-record writes a new file at the same name,
              // and Qt's image cache would happily serve the old pixels for the
              // rest of the panel session.
              Image {
                id: chipCapture
                anchors.fill: parent
                visible: chipCapture.status === Image.Ready
                source: chipTab.captureSource
                asynchronous: true
                cache: false
                clip: true
                fillMode: Image.PreserveAspectCrop
                // Decoded at the size it is DRAWN at, in physical pixels — a
                // 512px JPEG decoded at full size for a 40px chip is bytes and
                // milliseconds nobody sees. Floored so a warm-up frame with no
                // width does not ask for a 0x0 decode.
                sourceSize.width: Math.max(1, Math.round(chipTab.width * Screen.devicePixelRatio))
                sourceSize.height: Math.max(1, Math.round(chipTab.height * Screen.devicePixelRatio))
              }

              // THE VEIL, and it is a layer rather than a colour: it sits
              // over everything the chip's own rectangle draws and under
              // everything the content draws, so a centred icon reads against
              // a quietened ground. That ground is the chip's colour field, or
              // — since tick vbh — the captured picture above, and the veil is
              // what stops a busy screenshot from swallowing the icon on the
              // one tier that has nothing else to separate them. Declared after
              // the capture and before the content so it lands between them —
              // QML draws siblings in document order.
              Rectangle {
                anchors.fill: parent
                visible: chipTab.treatment === "veiled"
                color: Util.alpha(Color.popups.background, 0.55)
              }

              // Tab divider. Only between members, never at the ends — the
              // pill's own border does the outside.
              Rectangle {
                visible: chipTab.index > 0
                width: 1
                height: parent.height
                color: chipSlot.edgeColor
                opacity: 0.6
              }

              Column {
                id: chipContent
                anchors.centerIn: parent
                // Never negative: a chip drawn at the minimum size is
                // narrower than its own padding, and a Text with a negative
                // width elides to nothing at all rather than to one letter.
                width: Math.max(Style.space(8), chipTab.width - Style.space(8))
                spacing: Style.space(2)

                // THE LADDER'S TOP THREE TIERS, one shape. `pill` draws the
                // ground and the name beside the icon; `badge` and `veiled`
                // draw the same icon with the ground and the name off, which
                // leaves the icon centred by the Column it sits in. `field`
                // draws none of it and the chip is its colour rectangle
                // alone.
                //
                // One shape rather than three branches because the difference
                // between the tiers is genuinely how much of this is switched
                // on — and because a later epic fills a capture underneath
                // without touching any of it.
                //
                // Both render paths get here: this is ONE delegate, and only
                // its slot's x/y/width/height branch on `positioned`. The
                // stacked fallback rows draw all of this too — which is
                // exactly why the tier is asked for with the drawn size
                // rather than carried on the model.
                Rectangle {
                  id: chipPill
                  readonly property bool isPill: chipTab.treatment === "pill"
                  // THE TIERS THAT CARRY A NAME, and the one question every
                  // binding below asks instead of naming a tier twice.
                  // `strip` is a pill that has the width for a name and not
                  // the height for anything around it.
                  readonly property bool hasLabel: chipPill.isPill
                    || chipTab.treatment === "strip"
                  // Horizontal breathing room goes with the name; VERTICAL
                  // padding is the pill's alone, because a strip's whole
                  // height is one line of text and 3 px above and below it
                  // would spill into the row below in the stack.
                  readonly property real padX: chipPill.hasLabel ? Style.space(6) : 0
                  readonly property real padY: chipPill.isPill ? Style.space(3) : 0

                  visible: chipTab.treatment !== "field"
                  anchors.horizontalCenter: parent.horizontalCenter
                  width: Math.min(parent.width, pillRow.implicitWidth + chipPill.padX * 2)
                  height: pillRow.implicitHeight + chipPill.padY * 2
                  radius: height / 2
                  // The ground exists to keep the name legible over whatever
                  // is behind it. Translucent, and the popup's own background
                  // rather than a hue of its own: it must read as the panel
                  // quietening a patch of the chip, not as a second state to
                  // decode. It follows the NAME, not the pill tier: the strip
                  // draws a name over the same ground for the same reason.
                  color: chipPill.hasLabel
                    ? Util.alpha(Color.popups.background, 0.72) : "transparent"

                  Row {
                    id: pillRow
                    anchors.centerIn: parent
                    spacing: chipLabel.visible ? Style.space(4) : 0

                    // THE ICON. Sized from the chip, not from a constant: a
                    // chip is the window's own rectangle scaled, from the
                    // 16×10 floor up to a fullscreen window's whole
                    // workspace, and one fixed size would be a smear on the
                    // first and a stamp on the last. Capped at the kit's
                    // large icon so a big chip does not become a poster,
                    // floored at 8 px because below that an icon is noise —
                    // and the half-of-the-shorter-side rule is what keeps it
                    // inside a chip at any tier without a second fit test of
                    // its own. The LADDER decides whether it is drawn at all.
                    Image {
                      id: chipIcon
                      readonly property real side: Math.max(8,
                        Math.min(Style.font.iconLarge,
                          Math.min(chipTab.width, chipTab.height) * 0.5))
                      visible: chipTab.iconSource !== ""
                      width: chipIcon.side
                      height: chipIcon.side
                      anchors.verticalCenter: parent.verticalCenter
                      fillMode: Image.PreserveAspectFit
                      smooth: true
                      // Decoded at PHYSICAL pixels — a logical-size decode
                      // leaves PNG icons upscaled and blurry on HiDPI, which
                      // is the one thing an icon may not be. Copied from the
                      // shell's own app rows.
                      sourceSize.width: width * Screen.devicePixelRatio
                      sourceSize.height: height * Screen.devicePixelRatio
                      // Never blocks the map's layout pass on a disk read: a
                      // workspace full of chips is a workspace full of icon
                      // loads.
                      asynchronous: true
                      source: chipTab.iconSource
                    }

                    Text {
                      id: chipLabel
                      // PLAIN TEXT, and every Text in this file says so — see
                      // tests/qml-plaintext.test.js, which fails the moment a
                      // new one does not.
                      //
                      // Qt's default is AutoText: a string that looks like
                      // HTML is RENDERED as HTML, and this is the binding
                      // where that matters most. The name is usually derived
                      // and title-cased, but a terminal proposes the app
                      // INSIDE it from the window's own title, and a window
                      // title is a string an application picks for itself.
                      // The rule is every Text rather than the ones we can
                      // currently argue reach a title, because that argument
                      // has to be re-made correctly every time somebody adds
                      // a binding.
                      textFormat: Text.PlainText
                      // The name goes to the tiers that have room for a word:
                      // the pill, and the strip — a chip wide enough for a
                      // name and one line tall. Below those the label was one
                      // elided letter and a smear, which made a small chip
                      // look like a broken one; the chip keeps its hover, its
                      // click and its tooltip, which is where the whole story
                      // was already.
                      //
                      // The strip clause is not a relaxation, it is the
                      // repair: gating on the pill tier alone silently took
                      // the name off every chip on the Recorded tab, whose
                      // stacked rows are 17 px tall and can never reach it.
                      visible: chipPill.hasLabel
                      // Whatever is left after the icon and the padding, and
                      // never more than the text wants — a Row gives a Text
                      // no width of its own, and one with a negative width
                      // elides to nothing at all rather than to one letter.
                      width: Math.max(0, Math.min(chipLabel.implicitWidth,
                        chipContent.width - chipPill.padX * 2
                          - (chipIcon.visible ? chipIcon.width + pillRow.spacing : 0)))
                      anchors.verticalCenter: parent.verticalCenter
                      // The label is what survives a small chip; the whole
                      // story is in the tooltip.
                      elide: Text.ElideRight
                      maximumLineCount: 1
                      // The bare arrow is what the chip said before there was
                      // room to say WHERE. When the tag is up it says that in
                      // full, and repeating the arrow on the name would be
                      // the same sign twice.
                      text: (chipTab.modelData.drifted && !chipTag.visible)
                        ? chipTab.modelData.name + " →"
                        : chipTab.modelData.name
                      color: chipTab.modelData.watched ? panel.foreground : panel.faintForeground
                      font.family: panel.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                }

                // THE TAG PILL: one line the chip can say without being
                // hovered.
                //
                // Two different sentences, two different colours, and that
                // difference is the point. The drift tone — the chip edge's
                // own colour, panel.driftTone — means "a restore would move
                // this, and here is where to". Neutral means "the tool has
                // looked at this workspace's SHAPE and will not touch it",
                // which is a ceiling rather than a fault, and painting it
                // loud would file it as one.
                //
                // Drift wins when a chip has both: it is the half the user
                // can clear with one click, and the refusal is a line in the
                // tooltip either way.
                //
                // It rides the LABEL's visibility — and therefore the tiers
                // that draw a name — rather than inventing a threshold of its
                // own: a chip too small for its own name is far too small for
                // a tag. It also has to FIT, because an elided tag is a worse
                // signal than no tag at all. The height clause stays, and it
                // is what tells a labelled chip with room for two lines from
                // one without: a pill has that room by construction, a 17 px
                // stacked strip has not, and a strip that IS taller than two
                // lines gets its tag. On the narrow row the drift arrow
                // beside the name carries the signal instead — see
                // chipLabel.text — which is exactly what it did before the
                // ladder existed.
                Rectangle {
                  id: chipTag
                  readonly property bool isDrift: (chipTab.modelData.driftTag || "") !== ""
                  readonly property string tagText: chipTag.isDrift
                    ? chipTab.modelData.driftTag
                    : (chipTab.modelData.refusalTag || "")
                  // The pill wears the chip edge's own colour because it is
                  // the same signal said in words; the refusal pill stays
                  // neutral so the two never read as one.
                  readonly property color tone: chipTag.isDrift
                    ? panel.driftTone : panel.dimForeground

                  visible: chipLabel.visible && chipTag.tagText !== ""
                    && chipTag.width <= parent.width
                    && chipTab.height >= Style.space(34)
                  anchors.horizontalCenter: parent.horizontalCenter
                  width: tagLabel.implicitWidth + Style.space(8)
                  height: tagLabel.implicitHeight + Style.space(2)
                  radius: height / 2
                  color: "transparent"
                  border.width: 1
                  border.color: chipTag.tone
                  opacity: chipTag.isDrift ? 1.0 : 0.8

                  Text {
                    id: tagLabel
                    textFormat: Text.PlainText
                    anchors.centerIn: parent
                    text: chipTag.tagText
                    color: chipTag.tone
                    font.family: panel.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }

              MouseArea {
                id: chipMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: panel.toggleChip(chipTab.modelData)
                // The other half of the link: the row (or rows) for this app
                // light up while the pointer is here.
                onEntered: panel.setHoveredLink(chipTab.modelData.linkKey)
                onExited: panel.clearHoveredLink(chipTab.modelData.linkKey)
                // Re-claim the key on every move too — crossing straight from
                // one chip of this app to an adjacent one (same linkKey) can
                // otherwise land the old chip's exited() after the new chip's
                // entered() and wipe the highlight. See clearHoveredLink.
                onPositionChanged: panel.setHoveredLink(chipTab.modelData.linkKey)
              }

              // On ANY chip, not only a drifted one.
              //
              // A chip is three letters wide on a busy workspace, and the
              // window's own title is the only thing that tells two windows
              // of the same app apart — so the tooltip carries the title, the
              // class, and where the window is, and adds the drift arrow and
              // the WHAT-is- wrong sentence when there are any. ("recorded on
              // DP-2 · ws 10" is no help at all on a window already on DP-2
              // ws 10 whose tabs are in the wrong order.)
              // PanelModel.chipTooltipText decides what is worth saying; ""
              // is its way of saying nothing is, and the tooltip stays down.
              PanelToolTip {
                visible: chipMouse.containsMouse && chipTab.tipText !== ""
                text: chipTab.tipText
                fontFamily: panel.fontFamily
              }
            }
          }
        }
      }
    }
  }
}
