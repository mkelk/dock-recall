// Panel.qml — the map, and the two buttons under it.
//
// A `panel`-kind plugin: the shell's panel loader owns one instance, hands it
// a summon payload, and both the bar glyph's click and the SUPER+SHIFT+L
// keybinding route to it — so there is exactly one panel however it was asked
// for. Reference: plugins/panels/wifiqr/Panel.qml for the standalone-overlay
// shape, plugins/panels/monitor/Panel.qml for the theme and component usage.
//
// The centrepiece is a map of the monitors drawn to scale, and the map IS the
// control surface: clicking an app chip toggles whether that app is watched.
// There is no separate checkbox list to keep in sync — the flat list below the
// map is a mirror of the same model, there for keyboard and screen readers.
//
// Division of labour, same as everywhere else in this plugin: every question
// with a right answer is answered by a pure function in PanelModel.js (map
// geometry, chip models, list rows, pattern derivation, the badge) or by the
// engine (which identity a window is, where it drifted from). This file is
// layout, input, and the three pieces of I/O — two hyprctl reads, one atomic
// state write, one trigger touch.

import QtQuick
import QtQuick.Controls
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "engine.js" as Engine
import "StateModel.js" as StateModel
import "PanelModel.js" as PanelModel

Item {
  id: root

  // Injected by the shell's panel loader.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  // The service half of this plugin, when it is loaded. Not required: the
  // panel reads and writes the same files the service does, so it works on its
  // own — the badge simply stops moving without a service to publish status.
  property var service: null

  readonly property string pluginId: (manifest && manifest.id) ? String(manifest.id) : "mkelk.dock-recall"
  readonly property string logPrefix: "[dock-recall]"

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: root.home + "/.local/state/omarchy"
  readonly property string statePath: root.stateDir + "/dock-recall.json"
  readonly property string statusPath: root.stateDir + "/dock-recall.status.json"
  readonly property string triggerPath: root.stateDir + "/dock-recall.trigger"

  // ------------------------------------------------------------------ state

  property bool opened: false
  // "Live" or "Recorded" — which map the toggle is showing.
  property bool showRecorded: false

  // The one hovered thing, named the way BOTH surfaces name it.
  //
  // The map and the list are two pictures of the same desktop, and the panel
  // holds exactly one link key rather than a hovered chip and a hovered row:
  // one app can be several chips (three terminal windows) and is always one
  // row, so a pointer-to-object relation would need maintaining and a KEY does
  // not. Everything that answers to the key lights up, in whichever direction
  // the pointer came from. PanelModel.linkKeyFor is the single rule for what
  // that key is; "" is nothing hovered.
  property string hoveredLinkKey: ""

  // Enter/leave pairs arrive out of order when the pointer crosses straight
  // from one chip to the next, so a leave only clears the key if it is still
  // the one it set — otherwise the new hover is wiped by the old one's exit.
  // That guard only helps when the two keys DIFFER, though: crossing directly
  // between two adjacent chips of the SAME app (equal linkKey) can still wipe
  // the highlight if the old chip's exited() lands after the new chip's
  // entered(), because the "still the one it set" check passes either way.
  // The hover handlers cover that case by re-asserting the key on every
  // pointer move (see onPositionChanged/onPointChanged below), so a live
  // pointer always re-claims its key regardless of arrival order.
  function setHoveredLink(key) {
    root.hoveredLinkKey = key || ""
  }

  function clearHoveredLink(key) {
    if (root.hoveredLinkKey === key) root.hoveredLinkKey = ""
  }

  property var stateModel: StateModel.defaultState()
  property bool stateLoaded: false
  property string lastWrittenText: ""
  property var statusModel: StateModel.defaultStatus()

  // The live desktop. Only ever replaced by a read that SUCCEEDED — see the
  // READ-FAILED discipline in Service.qml and StateModel.parseHyprctlArray. A
  // failed read looks exactly like an empty desktop, and an empty desktop is
  // what "Record layout" would then write over the user's layout.
  property var liveClients: []
  property var liveMonitors: []
  property bool haveLiveData: false
  property string readError: ""

  // The exact bytes the last successful read returned. The refresh timer runs
  // while the panel is open, and every reassignment of liveClients rebuilds
  // the whole map model — which rebuilds every Repeater delegate under it,
  // dropping hover and flickering the panel twice a second on a desktop where
  // nothing is happening. hyprctl's output is stable when the desktop is, so
  // comparing the raw text is enough to make an idle panel genuinely idle.
  property string lastClientsText: ""
  property string lastMonitorsText: ""

  // The clients half of a snapshot in flight, held until the monitors half
  // arrives. The two reads are one PICTURE of the desktop and are committed
  // together: assigning liveClients the moment they arrived re-evaluated every
  // binding under it against the PREVIOUS monitor list, and for the length of
  // one hyprctl call the panel drew new windows on an old desk — chips homed to
  // a monitor id that had just been renumbered by a hotplug, and a drift report
  // computed across two different moments. The monitors read is a whole process
  // spawn away, so that window is frames long, not instructions long — and when
  // it FAILS the mismatch becomes permanent, since the clients half had already
  // been committed and nothing rolls it back. null means nothing is pending.
  property var pendingClients: null
  property string pendingClientsText: ""

  // ------------------------------------------------------------- derivations

  readonly property var identities: StateModel.identities(root.stateModel)
  readonly property int watchedCount: root.identities.length

  readonly property string topologyKey: Engine.topologyKey(root.liveMonitors)
  readonly property string topologyName: PanelModel.humanizeTopology(root.topologyKey, root.liveMonitors)
  readonly property var recordedLayout: StateModel.layoutFor(root.stateModel, root.topologyKey)

  readonly property var driftReport: root.recordedLayout
    ? Engine.driftOf(root.liveClients, root.liveMonitors, root.recordedLayout, root.identities)
    : null

  // The per-identity verdict table, computed from the panel's OWN read for the
  // same reason the badge is (below): the panel's eyes are seconds fresher than
  // the status file, and a row must not describe a mismatch the user has just
  // fixed by hand.
  //
  // What the panel cannot see is WHY a restore could not fix something — that
  // happened inside a cycle, minutes ago, and only the service was there. So
  // the service's published verdicts are consulted for exactly one field:
  // blockedBy, and only where the mismatch is still the one the cycle failed
  // on. Everything else is measured here and now.
  readonly property var verdicts: {
    if (!root.driftReport) return []
    return Engine.verdictsFor(root.driftReport, root.publishedOutcomes)
  }

  // The service's blockedBy reasons, turned back into the outcome shape
  // engine.verdictsFor takes. Round-tripping through the ledger shape rather
  // than patching verdicts afterwards keeps ONE rule about when a reason is
  // shown: verdictsFor attaches blockedBy only to a verdict that is not ok, so
  // a stale reason cannot outlive the mismatch it explains.
  readonly property var publishedOutcomes: {
    var out = []
    var published = root.statusModel.verdicts || []
    // A verdict table from a different topology is about a different desktop.
    if (root.statusModel.topologyKey !== root.topologyKey) return out
    for (var i = 0; i < published.length; i++) {
      var verdict = published[i]
      if (!verdict || !verdict.blockedBy) continue
      out.push({
        kind: verdict.blockedBy.kind,
        reason: verdict.blockedBy.reason,
        ok: false,
        identityIds: [verdict.identityId]
      })
    }
    return out
  }

  // The badge is the SERVICE's status with this panel's own drift count laid
  // over it.
  //
  // The status file is the shared truth — it is what the bar glyph renders, and
  // the two must not tell different stories — but while the panel is open it
  // has something the file cannot have: a hyprctl read from at most two seconds
  // ago, and a drift report computed from it. The file is refreshed on a
  // debounce, so for a moment after a drag the header would say "In sync" over
  // a map full of amber chips. Where they disagree, the panel's own eyes win;
  // `restoring` and the last restore's verdict stay the service's to tell,
  // because the panel knows nothing about either.
  //
  // statusPatchFor + mergeStatus rather than a hand-built object: those are the
  // same two functions the service publishes through, so "recorded", the drift
  // count and the precedence between them are computed once, in one place.
  // The tool's on/off switch, as the STATE file says it — not as the status
  // file echoes it. Same "the panel's own eyes win" rule as the drift count:
  // the panel wrote this flag, and waiting for the service to reload the file
  // and republish would leave the control it was just pressed on showing the
  // position it was in before.
  readonly property bool paused: StateModel.isPaused(root.stateModel)

  readonly property var badgeStatus: {
    var base = StateModel.mergeStatus(root.statusModel, { paused: root.paused })
    if (!root.haveLiveData) return base
    var patch = StateModel.statusPatchFor(root.topologyKey, root.recordedLayout, root.driftReport)
    if (!patch) return base
    return StateModel.mergeStatus(base, patch)
  }

  readonly property var badge: PanelModel.badgeFor(StateModel.glyphState(root.badgeStatus), root.badgeStatus)

  readonly property var runningIdentityIds: {
    var ids = []
    var seen = ({})
    var list = root.identities
    for (var i = 0; i < root.liveClients.length; i++) {
      var id = Engine.matchClient(root.liveClients[i], list)
      if (!id || seen[id]) continue
      seen[id] = true
      ids.push(id)
    }
    return ids
  }

  readonly property int mapWidth: Math.max(Style.space(240), mapSurface.width - mapSurface.contentLeftInset - mapSurface.contentRightInset)
  // The map is laid out by WIDTH now — monitor sections share the panel's
  // content width, and each one packs its workspaces into as many rows as they
  // need (see PanelModel.workspaceGridLayout). This is only the target the
  // model's own scaled boxes are fitted to; it is proportional to the width
  // rather than fixed because a fixed height is exactly what bound the scale
  // before, leaving 70 % of the map's width empty on a 7-workspace desk.
  //
  // mapWidth/mapHeight only feed mapGeometry's shared-scale computation
  // (scale, geometry.width/height, and each box's x/y/width/height) — the
  // rendering below (mapCanvas.sectionWidths, workspaceGridLayout) reads only
  // logicalWidth/logicalHeight/sizeLabel/name/label/workspaces off the model
  // and never touches those scaled fields, a leftover from when the map WAS
  // one scaled picture (see the "why this exists" comment on mapGeometry).
  // Left in rather than trimmed: mapGeometry.label is still what
  // recordedMapModel groups a recorded app onto its monitor by, the sort that
  // orders sectionWidths left-to-right lives there too, and
  // tests/panel.test.js asserts directly on the scaled x/width/height/scale —
  // mapGeometry is still exactly the function those tests describe.
  readonly property int mapHeight: Math.round(root.mapWidth * 0.6)
  // The map's shortest sensible height: enough for the "No monitors" line.
  readonly property int mapMinHeight: Style.space(60)
  // The gap between monitor sections, and between workspace boxes.
  readonly property int mapGap: Style.space(6)

  // How narrow a FOOTER button's tooltip wraps. The footer row is anchored to
  // the panel's right edge and Ui/Button builds its own ToolTip centred on the
  // button, so nothing clamps the popup to the card: at the default 56 columns
  // the Record tooltip measured ~390 logical px wide and ended ~95 logical px
  // outside the panel, floating over the desktop (evidence increment-03/m9u,
  // round 2, Finding 5). The string is the only lever the panel still owns, so
  // the footer's tooltips wrap to a narrower box than the ones further left.
  //
  // 36 is the narrowest wrap that still reads as prose (the Record sentence
  // becomes four short lines rather than a column of two-word ones). It does
  // not make the popup fit the panel outright: the box is centred on a button
  // sitting at the panel's right edge, so arithmetic off the round-2 frames
  // says ~36 columns cuts the ~95 px overflow to roughly a third of that.
  // Closing it completely would need the tooltip clamped to the card, which
  // lives in Ui/Button, not here.
  readonly property int footerTooltipColumns: 36

  // How narrow a CHIP or ROW tooltip wraps. Both sit further left than the
  // footer, but they carry a class string straight from Hyprland — no
  // spaces, so the default greedy wrap never breaks it. At the default 56
  // columns a 46-char class string ("chrome-www.rememberthemilk.com__app_-
  // Profile_1") pushed the popup ~100 logical px past the panel's left edge
  // (evidence increment-03/m9u, round 3, Finding 7). PanelModel.wrapTooltip
  // now hard-breaks an overlong word, so the narrower budget here shrinks
  // the popup instead of relying on that alone.
  readonly property int chipTooltipColumns: 40

  // WHICH window is which instance of its identity, for the whole frame.
  //
  // Built ONCE and handed to all three models below, because a row's linkKey, a
  // live chip's linkKey and a recorded chip's linkKey have to be the same string
  // for hover to pair them — and three models each deciding it from their own
  // inputs is how those three strings would drift apart. See
  // PanelModel.instanceIndex.
  readonly property var instanceIndex: {
    var list = root.identities
    return PanelModel.instanceIndex(root.liveClients, root.liveMonitors,
      function (client) { return Engine.matchClient(client, list) || "" },
      root.driftReport, root.recordedLayout)
  }

  readonly property var mapModel: {
    // Referenced so the map rebuilds when the watched list changes — the
    // resolver below closes over it, and a closure is invisible to QML's
    // dependency tracking.
    var list = root.identities
    if (root.showRecorded) {
      return PanelModel.recordedMapModel(root.recordedLayout, root.liveMonitors,
        root.runningIdentityIds, root.mapWidth, root.mapHeight, root.instanceIndex)
    }
    return PanelModel.liveMapModel(root.liveClients, root.liveMonitors,
      function (client) { return Engine.matchClient(client, list) || "" },
      root.driftReport, root.mapWidth, root.mapHeight, root.verdicts, root.instanceIndex)
  }

  readonly property var appRows: {
    var list = root.identities
    return PanelModel.appRows(root.liveClients, root.liveMonitors,
      function (client) { return Engine.matchClient(client, list) || "" },
      root.driftReport, root.recordedLayout, list, root.derivedLaunch, root.verdicts,
      root.instanceIndex, root.launchRefusals)
  }

  // ------------------------------------------------- the failed-restore list
  //
  // The sketch's auto-restore flow: "failures: red dot on the glyph; the panel
  // lists which apps failed, each with a retry". Driven off `lastResult` alone,
  // so the section CLEARS the moment a cycle succeeds — the service writes an ok
  // result and the header goes empty with it, which is what keeps a list of
  // yesterday's failures from sitting under a desktop that has since come right.
  readonly property string failedTitle: PanelModel.failedRestoreTitle(root.statusModel.lastResult)
  readonly property var failedRows: root.failedTitle === ""
    ? [] : PanelModel.failedRestoreRows(root.verdicts, root.appRows)

  readonly property string emptyHint: PanelModel.emptyStateHint(root.watchedCount)
  // Why Record is unavailable, when it is. Separate from emptyHint because they
  // are different sentences about different problems and can be true at once.
  readonly property string recordHint: PanelModel.recordBlockedHint(root.statusModel.restoring)
  // An identity that matches windows on this desk and wins none of them —
  // every one taken by an identity earlier in the list. It has no row of its
  // own to say so on (its windows are listed under the identity that took
  // them), so the reason goes here, next to the other two hints. Empty on a
  // healthy list. See engine.shadowedIdentities for what counts as shadowed
  // and, just as importantly, what does not.
  readonly property string shadowHint: PanelModel.shadowedIdentityHint(
    Engine.shadowedIdentities(root.liveClients, root.identities))

  // Why the state file cannot be written, when it cannot: a file from a newer
  // schema is read and run from, but never written back (StateModel.writeRefusal
  // owns the rule and the reason).
  //
  // A PERSISTENT line rather than a message on the click that failed (tick sma).
  // The condition is a property of the file, not of the moment, and every
  // affordance in the panel is dead while it holds; the only other place it was
  // ever said out loud is the service's notify-send at load time, possibly hours
  // earlier, on a desk that may have no notification daemon at all.
  readonly property string writeRefusalReason: {
    var refusal = root.stateLoaded ? StateModel.writeRefusal(root.stateModel) : null
    return refusal ? String(refusal) : ""
  }

  // ------------------------------------------------------ launch derivation
  //
  // The user-found gap this closes: the panel writes `launch: ""` for every
  // identity it creates, "" means NEVER LAUNCH, and so Restore could put a
  // watched window back on its workspace but could never bring the app back
  // once it was closed — which is most of what a restore is for.
  //
  // The panel learns the command rather than guessing it: from the argv of the
  // running process, or from the app's own .desktop entry when it is not
  // running (the case that matters, since a restore is what you press AFTER
  // closing things). Every decision is a pure function in PanelModel; this
  // half is the two reads that feed them.
  //
  // Everything below is a BINDING on purpose. The two reads only ever fill
  // `desktopFiles` and `argvByPid`; what follows from them — who still needs a
  // command, what was derived, how many rows the repair button can fix — falls
  // out declaratively, so a click that changes the watched list updates the
  // hints without anybody remembering to recompute.

  // { path, text } for every .desktop file on the machine, user's own first.
  property var desktopFiles: []
  // { "<pid>": argv } for the pids of watched windows that need a command.
  property var argvByPid: ({})
  // The same read's CHILD processes, as a tree (see PanelModel.procTreeFromDump).
  // A terminal's own cmdline is just the terminal; the app it hosts is its
  // child, and this is the only place the panel can see it.
  property var procTree: ({})

  // The identities with no launch command, paired with whatever the live
  // desktop knows about them.
  readonly property var launchRequests: {
    var list = root.identities
    var need = PanelModel.identitiesNeedingLaunch(list)
    var byPid = root.argvByPid
    var out = []
    for (var i = 0; i < need.length; i++) {
      var identity = StateModel.identityById(root.stateModel, need[i])
      if (!identity) continue
      // The ONE matcher, as everywhere else: the pid we read a cmdline from
      // must belong to the window the engine says is this identity's — which
      // is the window the RECORD would choose, not merely the first one
      // hyprctl lists (see engine.pickClientFor).
      //
      // The request SHAPE is PanelModel's (launchRequestFor), shared with the
      // one a toggle builds for the identity it has just created — the pid
      // travels with it so the derivation can ask whether this process owns
      // other windows too.
      var request = PanelModel.launchRequestFor(identity,
        Engine.pickClientFor(root.liveClients, identity, list), byPid)
      if (request) out.push(request)
    }
    return out
  }

  // How many windows each live pid owns — the structural shared-process test's
  // only input, tallied from the client list the panel already reads.
  readonly property var windowsByPid: PanelModel.windowCountByPid(root.liveClients)

  // Both halves of the derivation, computed once: what could be learned, and
  // what was REFUSED because naming it would mean guessing (tick dwv).
  readonly property var launchDerivation: PanelModel.launchDerivation(
    root.launchRequests, root.desktopFiles, root.windowsByPid, root.procTree)
  readonly property var derivedLaunch: root.launchDerivation.commands
  readonly property var launchRefusals: root.launchDerivation.refusals
  readonly property int learnableLaunches: PanelModel.learnableCount(root.identities, root.derivedLaunch)

  // -------------------------------------------------------- keyboard cursor
  //
  // Three focus sections — the chips, then the two footer buttons — because
  // that is the whole panel: arrows walk the map, Space toggles what the
  // cursor is on, Tab reaches the footer, Enter activates. (UX sketch,
  // "Interaction rules".)
  //
  // The chip cursor is held as a chip KEY rather than an index. The map model
  // is rebuilt from scratch every couple of seconds by the refresh timer, and
  // an index would quietly slide onto a different window each time a client
  // list came back in a different order. A key is a window address; it either
  // still exists or it does not.
  property string focusSection: "chips"
  property string cursorKey: ""

  readonly property var flatChips: PanelModel.flattenChips(root.mapModel)

  readonly property var currentChip: {
    var chips = root.flatChips
    for (var i = 0; i < chips.length; i++) {
      if (chips[i].key === root.cursorKey) return chips[i]
    }
    return null
  }

  function moveChipCursor(delta) {
    root.cursorKey = PanelModel.nextCursorKey(root.flatChips, root.cursorKey, delta)
  }

  // Where the cursor sits inside the failed-restore section, held as a ROW key
  // for exactly the reason the chip cursor is held as a chip key: the section
  // is a binding on the status file, rebuilt whenever a cycle writes one, and
  // an index would slide onto a different app's Retry between the look and the
  // keystroke.
  property string failedCursorKey: ""

  readonly property var currentFailedRow: {
    var rows = root.failedRows
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === root.failedCursorKey) return rows[i]
    }
    return null
  }

  function moveFailedCursor(delta) {
    root.failedCursorKey = PanelModel.nextCursorKey(root.failedRows, root.failedCursorKey, delta)
  }

  // The section can vanish under the cursor — a successful cycle clears it, and
  // the panel stays open across cycles. Restore is where the cursor goes, being
  // the button the whole section was an argument for.
  onFailedRowsChanged: {
    if (root.failedRows.length === 0) {
      root.failedCursorKey = ""
      if (root.focusSection === "failed") root.focusSection = "restore"
      return
    }
    // A row that went away while the cursor was on it: land on the first one
    // still listed rather than on nothing.
    if (root.focusSection === "failed" && !root.currentFailedRow) root.moveFailedCursor(1)
  }

  // Tab order: chips -> [Retry rows] -> [Learn launch] -> Restore now ->
  // Record layout -> [Undo record] -> Pause/Activate -> ⋯ overflow -> back to
  // the chips. "failed", "learn" and "undo" join the chain only while the thing
  // they act on exists, so Tab never stops on nothing.
  //
  // Undo sits immediately AFTER Record, which is both where it is drawn and
  // where a keyboard user is: the one keystroke after the one that overwrote
  // their layout. (UX sketch, "Everything in the panel is keyboard-reachable".)
  //
  // The pause switch and the overflow sit LAST even though they are drawn
  // first, in the header. Tab order here is by weight, not by pixel position —
  // the chips and the two footer actions are what the panel is opened to do, and
  // neither a switch that changes the tool's mode nor a menu of things it
  // remembers should be the first thing a Tab lands on.
  //
  // The chain itself is PanelModel.panelFocusOrder, so a test can ask what Tab
  // reaches without a compositor — which is how the missing Retry stop is
  // pinned.
  readonly property var focusOrder: PanelModel.panelFocusOrder({
    learnable: root.learnableLaunches,
    failed: root.failedRows.length,
    canUndo: root.canUndoRecord
  })

  function moveSection(direction) {
    root.focusSection = PanelModel.nextSection(root.focusOrder, root.focusSection, direction)
    if (root.focusSection === "chips" && !root.currentChip) root.moveChipCursor(1)
    if (root.focusSection === "failed" && !root.currentFailedRow) root.moveFailedCursor(1)
  }

  function handleMove(dx, dy) {
    // An open menu owns the arrows: it is the only thing on screen the user is
    // looking at, and walking the map behind it would move a cursor nobody can
    // see. Vertical first, because the menu is a column.
    if (root.overflowOpen) {
      root.moveOverflowCursor(dy !== 0 ? dy : dx)
      return
    }
    if (root.focusSection === "chips") {
      // The flattened order is the reading order of the map, so horizontal
      // and vertical arrows both walk it — there is no grid to move around
      // in, only a sequence.
      root.moveChipCursor(dx !== 0 ? dx : dy)
      return
    }
    // The failed list is a COLUMN of rows, so the vertical arrows walk it and
    // the horizontal ones behave like the footer's (they move on to the next
    // section). Up off the top row goes back to the map, which is the same
    // gesture the footer offers and the same place it leads.
    if (root.focusSection === "failed") {
      if (dy < 0 && root.failedRows.length > 0
        && root.failedCursorKey === root.failedRows[0].key) {
        root.focusSection = "chips"
        if (!root.currentChip) root.moveChipCursor(1)
        return
      }
      if (dy !== 0) {
        root.moveFailedCursor(dy)
        return
      }
      if (dx !== 0) root.moveSection(dx)
      return
    }
    // On the footer, left/right walks the two buttons and up returns to the map.
    if (dy < 0) {
      root.focusSection = "chips"
      if (!root.currentChip) root.moveChipCursor(1)
      return
    }
    if (dx !== 0) root.moveSection(dx)
  }

  function activateCursor() {
    if (root.overflowOpen) {
      root.activateOverflow()
      return
    }
    if (root.focusSection === "overflow") {
      root.openOverflow()
      return
    }
    if (root.focusSection === "learn") {
      if (root.learnableLaunches > 0) root.learnLaunches()
      return
    }
    if (root.focusSection === "restore") {
      if (root.recordedLayout) root.restoreNow()
      return
    }
    // Enter/Space on a failed row IS its Retry button, and Retry is the whole
    // restore — the same call the pointer makes, under the same two guards the
    // button carries (`enabled`), so the keyboard cannot start a second cycle
    // over a running one or a restore with nothing recorded.
    if (root.focusSection === "failed") {
      if (root.recordedLayout && !root.statusModel.restoring) root.restoreNow()
      return
    }
    if (root.focusSection === "record") {
      root.recordLayout()
      return
    }
    if (root.focusSection === "undo") {
      root.undoRecord()
      return
    }
    if (root.focusSection === "pause") {
      if (root.stateLoaded) root.setPaused(!root.paused)
      return
    }
    if (root.currentChip) root.toggleChip(root.currentChip)
  }

  // ------------------------------------------------------------ the viewport
  //
  // The card caps at 88% of the screen and the content is taller than that on
  // an ordinary laptop — 1440×900 logical, fifteen app rows, and the failed
  // list and the whole footer sit below the fold (live verification, finding
  // F3). The ScrollView underneath has always been able to scroll; what it had
  // no way of doing was FOLLOWING the keyboard, and this panel takes the
  // keyboard exclusively, so a Tab onto Restore now moved a cursor the user
  // could not see onto a button they could not reach.
  //
  // These two functions are that follow. Every cursor target below calls
  // ensureCursorVisible on the frame it gains the cursor — chips, failed rows,
  // and each of the footer and header buttons — which is the canonical shape
  // the shell's own dev-gallery documents for a multi-section Column (see
  // $OMARCHY_PATH/shell/plugins/dev-gallery/GalleryPanel.qml).
  //
  // The maths is on the FLICKABLE, not on the ScrollBar: ScrollView's
  // contentItem is the Flickable, `contentY` is the viewport's top edge in
  // content coordinates, and mapping the item into the flickable's own content
  // item is what turns "where is this row on screen" into that number.
  function scrollFlickable() {
    if (!scrollArea) return null
    var flick = scrollArea.contentItem
    if (!flick || flick.contentY === undefined) return null
    return flick
  }

  function resetScroll() {
    var flick = root.scrollFlickable()
    if (flick) flick.contentY = 0
  }

  function ensureCursorVisible(item) {
    var flick = root.scrollFlickable()
    if (!flick || !item) return
    // Nothing overflows: there is no scrolling to do and a contentY nudge on a
    // short card would only bounce.
    var maxY = Math.max(0, (flick.contentHeight || 0) - flick.height)
    if (maxY <= 0) {
      flick.contentY = 0
      return
    }
    var margin = Style.space(12)
    var point = item.mapToItem(flick.contentItem || flick, 0, 0)
    var top = point.y
    var bottom = top + (item.height || 0)
    var viewTop = flick.contentY
    var viewBottom = viewTop + flick.height
    // Clamped both ways, but only the top-branch is top-guaranteeing: when the
    // target's top is at or above the viewport (straddling it, or scrolled to
    // from above) this scrolls to show the top. Approached from below instead —
    // top already past viewBottom, so only the bottom test fires — the
    // else-branch bottom-aligns, and a target taller than the viewport would
    // have its top pushed back off-screen. No real cursor target is taller
    // than the viewport, so this never bites in practice.
    if (top < viewTop + margin) flick.contentY = Math.max(0, Math.min(maxY, top - margin))
    else if (bottom > viewBottom - margin)
      flick.contentY = Math.max(0, Math.min(maxY, bottom + margin - flick.height))
  }

  // ------------------------------------------------------------------- theme

  readonly property color foreground: Color.popups.text
  readonly property color dimForeground: Qt.darker(root.foreground, 1.6)
  readonly property color faintForeground: Qt.darker(root.foreground, 2.2)
  readonly property string fontFamily: Style.font.family

  // Drift's one colour, named once so the chip EDGE and the `→ target` pill on
  // it can never drift apart from each other (they are one signal: "a restore
  // would move this, and here is where to").
  //
  // ---- documented gap (tick wgj, finding F1) -------------------------------
  // The UX sketch calls this amber. An Omarchy theme has no amber and no way to
  // acquire one: Color.qml's palette is foreground / background / accent /
  // urgent / muted, its colors.toml reader only ever looks at foreground,
  // background, accent, muted, color0/1/4/7/8 and red, and neither shell.toml
  // nor Style.qml surfaces a warning or caution role. There is no first-party
  // token to point at, and inventing one here would mean writing a hex into a
  // themed plugin — a colour that would survive every theme switch and be wrong
  // after most of them.
  //
  // So this stays ACCENT, which is the theme's own "look here", and it is the
  // same choice BarWidget.driftColor makes for the drifted dot, on purpose:
  // the bar glyph and the panel are two views of one state and must not
  // disagree about what drift looks like. On themes whose accent is green the
  // sketch's amber/attention reading is lost — the CONTRAST it asks for
  // survives (loud accent vs the quiet dimForeground the refusal pill wears),
  // the hue does not. If a warning role is ever added to the shell's Color
  // singleton, this property and BarWidget.driftColor are the two lines to
  // change.
  readonly property color driftTone: Color.accent

  function toneColor(tone) {
    if (tone === "urgent") return Color.urgent
    if (tone === "accent") return Color.accent
    if (tone === "muted") return root.faintForeground
    return root.foreground
  }

  function log(message) {
    console.log(root.logPrefix + " " + message)
  }

  function warn(message) {
    console.warn(root.logPrefix + " " + message)
  }

  // ------------------------------------------------------------- lifecycle

  // The payload the shell delivered with the summon. Read here, acted on in
  // the keyboard tick; keeping it means a re-summon with a different payload
  // is not lost between open() and the surface mapping.
  property string focusRequest: ""

  function open(payloadJson) {
    var payload = {}
    try { payload = JSON.parse(payloadJson || "{}") || {} } catch (e) { payload = {} }
    root.focusRequest = payload.focus === undefined ? "" : String(payload.focus)

    // The keybinding's whole trick: SUPER+SHIFT+L summons with
    // {"focus":"restore"}, so the panel opens with Restore now under the
    // cursor and Enter is the second keystroke of a manual restore. Without a
    // payload the cursor starts on the map, where the panel's other job is.
    root.focusSection = root.focusRequest === "restore" ? "restore"
      : (root.focusRequest === "record" ? "record" : "chips")
    root.cursorKey = ""
    root.failedCursorKey = ""
    // A panel re-summoned after being scrolled must not open half-way down
    // itself: the viewport is part of the panel's state, and the top is where
    // the topology and the badge are.
    root.resetScroll()

    // A refusal belongs to the moment it was pressed in, and every /proc answer
    // this panel holds belongs to the last time it was open. Both are dropped
    // here: the panel object outlives open and close, and a summon an hour
    // later must not build a tick on an hour-old picture of the desk.
    root.refusedTick = null
    root.forgetProcReads()

    root.refresh()
    root.refreshDerivations()
    root.opened = true
    root.log("panel opened (focus=" + (root.focusRequest || "chips") + ")")
    // The window is instantiated hidden, so `focus: true` inside it is
    // evaluated before the surface is mapped and Escape would land nowhere.
    Qt.callLater(function () {
      if (root.opened) keyCatcher.forceActiveFocus()
    })
  }

  function close() {
    root.opened = false
    root.focusRequest = ""
    // The undo is a net under the moment, not a history: it lives on this
    // object, in memory, and closing the panel is the end of the moment. A
    // button offering to undo a record the user made three sessions ago would
    // be a promise about a file that has been rewritten since by the service,
    // by scripts/record-current, or by a second panel.
    root.recordUndo = null
    root.closeOverflow()
    root.log("panel closed")
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  // Going through the shell rather than flipping `opened` directly keeps the
  // loader's open-set, the bar glyph's `opened` binding, and this panel in
  // agreement — a panel that closed itself behind the shell's back would leave
  // the next summon toggling the wrong way.
  function dismiss() {
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
    else root.close()
  }

  // ------------------------------------------------------------- live reads

  function noteReadFailure(what, error) {
    root.readError = what + ": " + error
    root.warn("READ-FAILED hyprctl " + what + ": " + error
      + " — keeping the last good snapshot rather than showing an empty desktop")
  }

  function refresh() {
    if (clientsProc.running || monitorsProc.running) return
    clientsProc.running = true
  }

  Process {
    id: clientsProc
    command: ["hyprctl", "clients", "-j"]
    stdout: StdioCollector { id: clientsOut; waitForEnd: true }
    stderr: StdioCollector { id: clientsErr; waitForEnd: true }
    onExited: function (exitCode) {
      var raw = String(clientsOut.text || "")
      var read = StateModel.parseHyprctlArray(raw, exitCode, clientsErr.text)
      if (!read.ok) {
        root.noteReadFailure("clients", read.error)
        return
      }
      // Parked, not published — see pendingClients. An unchanged read parks
      // nothing, which is what keeps an idle panel from rebuilding its
      // delegates twice a second.
      if (raw !== root.lastClientsText) {
        root.pendingClientsText = raw
        root.pendingClients = read.value
      } else {
        root.pendingClients = null
      }
      monitorsProc.running = true
    }
  }

  Process {
    id: monitorsProc
    // `all`, so a disabled-but-present output still counts towards the
    // topology key exactly as it does in the service. mapGeometry drops the
    // disabled ones from the DRAWING; they still decide which layout applies.
    command: ["hyprctl", "monitors", "all", "-j"]
    stdout: StdioCollector { id: monitorsOut; waitForEnd: true }
    stderr: StdioCollector { id: monitorsErr; waitForEnd: true }
    onExited: function (exitCode) {
      var raw = String(monitorsOut.text || "")
      var read = StateModel.parseHyprctlArray(raw, exitCode, monitorsErr.text)
      if (!read.ok) {
        root.noteReadFailure("monitors", read.error)
        // The parked clients go with it: half a snapshot is exactly what this
        // pairing exists to avoid, and the next refresh reads both again.
        root.pendingClients = null
        return
      }
      // Both halves land here, together.
      if (root.pendingClients !== null) {
        root.lastClientsText = root.pendingClientsText
        root.liveClients = root.pendingClients
        root.pendingClients = null
      }
      if (raw !== root.lastMonitorsText) {
        root.lastMonitorsText = raw
        root.liveMonitors = read.value
      }
      root.haveLiveData = true
      root.readError = ""
      // A fresh client list can have brought a watched app's window with it,
      // and its pid is the best source of a launch command. Cheap: a no-op
      // unless some identity still needs one AND its window is new to us.
      root.refreshCmdlines()
    }
  }

  // Only while the panel is up: a closed panel has nothing to keep fresh, and
  // two hyprctl calls a second in the background is exactly the kind of thing
  // that makes a plugin unwelcome.
  Timer {
    interval: 2000
    running: root.opened
    repeat: true
    onTriggered: root.refresh()
  }

  // -------------------------------------------------- reading the derivations
  //
  // Two Processes, both of them a single `bash -c` loop that prints a marker
  // line before each item — one Process per desktop file would be a hundred of
  // them, and one per pid nearly as bad. PanelModel.parseSectionedDump splits
  // the result back up; the marker and the parser are tested together.
  //
  // Neither read is ON the refresh timer, and only one of them expires.
  // Desktop files change when software is installed and a process's own argv
  // never changes at all, so once per panel opening is right for both; a
  // hundred-file scan twice a second on an idle desktop is not.
  //
  // The exception is a TERMINAL's process tree, which answers "what is running
  // inside this window" — a question whose answer changes under a stable pid
  // (tick gpq). That one expires; see cmdlineMaxAgeMs.

  readonly property string desktopDumpScript:
    'for f in "$HOME"/.local/share/applications/*.desktop'
    + ' "$HOME"/.nix-profile/share/applications/*.desktop'
    + ' /usr/local/share/applications/*.desktop'
    + ' /usr/share/applications/*.desktop; do'
    + ' [ -f "$f" ] || continue;'
    + ' printf "@@mw@@ %s\\n" "$f";'
    // Only the keys parseDesktopEntry looks at, group headers included — the
    // full text of every desktop file on the machine is a megabyte of icons
    // and translated comments this never reads.
    + ' grep -E "^(\\[|Exec=|StartupWMClass=|Type=|Hidden=|Name=)" "$f" || true;'
    + ' done'

  // The user's own directory is scanned FIRST because a file there overrides
  // the system one of the same name, and launchFromDesktopFiles takes the
  // first match.
  Process {
    id: desktopScanProc
    command: ["bash", "-c", root.desktopDumpScript]
    stdout: StdioCollector { id: desktopScanOut; waitForEnd: true }
    onExited: function (exitCode) {
      if (exitCode !== 0) {
        root.warn("desktop-file scan exited " + exitCode + " — launch derivation will use the running processes only")
        return
      }
      root.desktopFiles = PanelModel.desktopFilesFromDump(String(desktopScanOut.text || ""))
      root.log("scanned " + root.desktopFiles.length + " desktop files for launch commands")
      root.autoFillLaunches("desktop-file scan")
    }
  }

  // The pids whose argv is wanted and not yet known. Empty is the common case
  // — every watched app either has a command already or is not running.
  //
  // TWO sources, and the second one is not about launch commands at all:
  //
  //   1. the watched identities that still need a launch command, through the
  //      ONE matcher, as everywhere else;
  //   2. every live TERMINAL window, watched or not (tick 1uz). A terminal's
  //      class names no app, so ticking one has to propose the app INSIDE it,
  //      and that proposal is built synchronously at the moment of the click.
  //      An unwatched terminal is in neither half of source 1 — it is not
  //      watched, and it is not missing a launch — so without this the answer
  //      would never be ready in time and every terminal tick would fall back
  //      to the useless class-only `^foot$`.
  function missingCmdlinePids() {
    var wanted = []
    var seen = ({})
    var list = root.identities
    var need = PanelModel.identitiesNeedingLaunch(list)
    var pids = []
    for (var i = 0; i < need.length; i++) {
      var identity = StateModel.identityById(root.stateModel, need[i])
      if (!identity) continue
      var client = Engine.pickClientFor(root.liveClients, identity, list)
      if (!client || client.pid === undefined || client.pid === null) continue
      pids.push(String(client.pid))
    }
    var terminals = PanelModel.terminalPids(root.liveClients)
    var isTerminal = ({})
    for (var t = 0; t < terminals.length; t++) {
      isTerminal[terminals[t]] = true
      pids.push(terminals[t])
    }

    var now = Date.now()
    for (var p = 0; p < pids.length; p++) {
      var pid = pids[p]
      // A pid is only digits by construction; the guard is here because this
      // value is about to be interpolated into a shell loop.
      if (!/^[0-9]+$/.test(pid)) continue
      if (seen[pid]) continue
      // `cmdlineTriedAt` and not just `argvByPid`: a pid whose cmdline came back
      // empty (it exited between the two reads) would otherwise be asked for
      // again on every refresh tick, which is a Process every two seconds for
      // as long as the panel is open.
      var asked = root.cmdlineTriedAt[pid]
      if (asked !== undefined) {
        // AN ORDINARY APP'S argv never changes while its pid lives, so asked
        // once is asked for good. A TERMINAL's does not change either — but the
        // question asked about a terminal is what is RUNNING INSIDE it, and that
        // changes under a stable pid every time the user quits one program and
        // starts another. Tick gpq: a tree read when the panel opened said
        // "herdr", btop was running by the time the user ticked, and the panel
        // wrote herdr's identity and herdr's launch command. So a terminal's
        // answer expires; everything else is read once per panel opening.
        if (!isTerminal[pid]) continue
        if (now - asked < root.cmdlineMaxAgeMs) continue
      }
      seen[pid] = true
      wanted.push(pid)
    }
    return wanted
  }

  property string cmdlinePidList: ""
  // Pids this panel has already asked about, answered or not, and WHEN — see
  // missingCmdlinePids for which of them go stale.
  property var cmdlineTriedAt: ({})
  // How old a terminal's process tree may be before it is read again. Longer
  // than the 2 s refresh so an idle panel is not spawning a shell on every
  // cycle (it lands on every other one), short enough that the worst-case age
  // of the tree a tick is built on is a few seconds rather than the whole time
  // the panel has been open.
  readonly property int cmdlineMaxAgeMs: 3000

  // Everything read from /proc, forgotten. Called when the panel opens: the
  // panel object OUTLIVES open and close, so without this a panel summoned
  // again an hour later starts from an hour-old picture of every terminal on
  // the desk.
  function forgetProcReads() {
    root.cmdlineTriedAt = ({})
    root.argvByPid = ({})
    root.procTree = ({})
  }

  function refreshCmdlines() {
    if (cmdlineProc.running) return
    var pids = root.missingCmdlinePids()
    if (!pids.length) return
    var tried = ({})
    for (var known in root.cmdlineTriedAt) tried[known] = root.cmdlineTriedAt[known]
    // Stamped when ASKED rather than when answered, deliberately: a pid that
    // answers nothing (it exited between the two reads) must not be asked again
    // on every refresh tick. The expiry above is what keeps a terminal's answer
    // from going stale in spite of that.
    var now = Date.now()
    for (var i = 0; i < pids.length; i++) tried[pids[i]] = now
    root.cmdlineTriedAt = tried
    root.cmdlinePidList = pids.join(" ")
    cmdlineProc.running = true
  }

  Process {
    id: cmdlineProc
    // The pid list travels as $1 rather than being spliced into the script, so
    // even a pid that somehow got past the digits check cannot become code.
    // Two levels of children as well as the window pid itself (tick dwv): a
    // terminal's own cmdline is just the terminal, the app is its child, and an
    // interactive shell sits between them often enough that the grandchild has
    // to be reachable too. Same one Process, same marker protocol; the header
    // carries the path of pids so PanelModel can rebuild the shape.
    //
    // `children` is read from /proc/<pid>/task/*/children — the kernel's own
    // answer, one read, no process table walk — and `cat` is allowed to fail
    // for a pid that exited between the two reads.
    command: ["bash", "-c",
      'dump() { printf "@@mw@@ %s\\n" "$1"; tr "\\0" "\\n" < "/proc/$2/cmdline" 2>/dev/null || true; };'
      + ' kids() { cat /proc/"$1"/task/*/children 2>/dev/null; };'
      + ' for p in $1; do dump "$p" "$p";'
      + ' for c in $(kids "$p"); do dump "$p/$c" "$c";'
      + ' for g in $(kids "$c"); do dump "$p/$c/$g" "$g"; done; done; done',
      "--", root.cmdlinePidList]
    stdout: StdioCollector { id: cmdlineOut; waitForEnd: true }
    onExited: function (exitCode) {
      if (exitCode !== 0) {
        root.warn("cmdline read exited " + exitCode + " — falling back to desktop files")
        return
      }
      var text = String(cmdlineOut.text || "")
      var fresh = PanelModel.argvByPidFromDump(text)
      // Merged rather than replaced, and reassigned rather than mutated: a
      // later read asks only about the pids it does not know yet, and QML only
      // notices a whole new object.
      //
      // But the pids this read ASKED about are dropped first (tick gpq). A
      // terminal that has stopped running anything answers with no children at
      // all, and a merge would leave the previous answer standing — the panel
      // would keep proposing an app that is no longer there.
      var asked = ({})
      var askedList = String(root.cmdlinePidList || "").split(" ")
      for (var a = 0; a < askedList.length; a++) {
        if (askedList[a]) asked[askedList[a]] = true
      }

      var merged = ({})
      for (var known in root.argvByPid) {
        if (!asked[known]) merged[known] = root.argvByPid[known]
      }
      for (var pid in fresh) merged[pid] = fresh[pid]
      root.argvByPid = merged

      var freshTree = PanelModel.procTreeFromDump(text)
      var mergedTree = ({})
      for (var seen in root.procTree) {
        if (!asked[seen]) mergedTree[seen] = root.procTree[seen]
      }
      for (var root_pid in freshTree) mergedTree[root_pid] = freshTree[root_pid]
      root.procTree = mergedTree

      root.autoFillLaunches("cmdline read")
    }
  }

  // Both reads, kicked off together. Called when the panel opens and whenever
  // the watched list changes — ticking a chip is exactly when a new identity
  // with an empty launch appears.
  function refreshDerivations() {
    if (!desktopScanProc.running && root.desktopFiles.length === 0) {
      // Logged on the way IN, not only on success: "started the scan" and
      // "finished the scan" are different facts, and the gap between them is
      // where a Process that never ran shows up.
      root.log("scanning desktop files for launch commands")
      desktopScanProc.running = true
    }
    root.refreshCmdlines()
  }

  // ------------------------------------------------------------- state file

  function loadState(raw, exists) {
    var result = StateModel.parseState(raw)
    if (result.recovered && exists) {
      // The file is there but unreadable: almost always a writer mid-flight.
      // The panel's job here is to wait, not to repair — the service owns
      // recovery, and a panel that adopted a default would happily write it
      // back over the user's layouts on the next click.
      root.warn("state file unreadable (" + result.error + ") — keeping the last good copy in memory")
      return
    }
    root.stateModel = result.state
    root.stateLoaded = true
  }

  // Persist. Atomic, because the service watches this file and a truncating
  // write is observable (see the state-file rule in .tick/learnings.md), and
  // round-tripped through StateModel so what the panel shows after a click is
  // literally what the file now says — normalization included.
  //
  // THE ONE PLACE THE PANEL TOUCHES THE STATE FILE. Every action above and below
  // — tick a chip, learn a launch, Record, undo, Forget, pause — arrives here,
  // which is why the read-only check for a newer-schema file sits here and
  // nowhere else (tick 291). Such a file is read and shown, but writing it would
  // strip whatever a later version added and stamp the newer number back on the
  // remains; StateModel.writeRefusal owns that rule and the service asks it too.
  //
  // RETURNS whether the file now says what the caller asked for (tick sma).
  // Every caller gates its success log on that, because the alternative is what
  // this repo exists not to do: the refusal below was a console.warn and the
  // next line of the caller logged "recorded 7 apps" regardless, so the panel
  // AFFIRMED a write it had just refused. A byte-identical write is `true` —
  // nothing was refused and the file already says it.
  function writeState(next) {
    if (!root.stateLoaded) {
      root.warn("refusing to write the state file before it has been read")
      return false
    }
    var refusal = StateModel.writeRefusal(next)
    if (refusal) {
      root.warn("not writing the state file: " + refusal)
      return false
    }
    var text = StateModel.serializeState(next)
    if (text === root.lastWrittenText) return true
    root.lastWrittenText = text
    root.stateModel = StateModel.parseState(text).state
    stateFile.setText(text)
    return true
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadState(text(), true)
    onLoadFailed: root.loadState("", false)
    onFileChanged: reload()
  }

  // A SECOND view on the state file, for one job: reading the bytes that are on
  // disk at the instant of a click, synchronously.
  //
  // `stateModel` above is what the watched view last loaded, which is fresh
  // enough for the writes that only ever ADD (a learned launch command, a
  // ticked identity — see learnLaunches). The pause toggle is not one of those:
  // it rewrites the whole file from an object that also carries every layout,
  // so a copy that went stale while the panel sat open would file yesterday's
  // recordings alongside today's flag. blockAllReads makes reload() + text()
  // return the current file rather than schedule a load for later.
  FileView {
    id: stateReader
    path: root.statePath
    blockAllReads: true
    printErrors: false
  }

  // The file as it is RIGHT NOW, or null when there is nothing safe to build a
  // write on. A fresh default is NEVER the answer: writing one over a file we
  // merely failed to read is how a panel eats somebody's layouts.
  function freshState() {
    stateReader.reload()
    var result = StateModel.parseState(stateReader.text())
    if (!result.recovered) return result.state

    // Nothing usable came back. Fall back to the copy the WATCHED view holds —
    // the same freshness every other write in this file relies on — rather than
    // leaving a button that quietly does nothing. Warned, not silent: a
    // blocking read that stopped working should show up in the log, not in a
    // lost recording.
    if (root.stateLoaded) {
      root.warn("could not re-read the state file fresh (" + result.error
        + ") — falling back to the copy the watcher last loaded")
      return root.stateModel
    }
    root.warn("the state file has not been read yet — refusing to write")
    return null
  }

  FileView {
    id: statusFile
    path: root.statusPath
    watchChanges: true
    printErrors: false
    onLoaded: root.statusModel = StateModel.parseStatus(text()).status
    onLoadFailed: root.statusModel = StateModel.defaultStatus()
    onFileChanged: reload()
  }

  // Write-only. The service restores on a CONTENT change, so the timestamp is
  // the message: it is always new, and it says in the file itself when the
  // request was made.
  FileView {
    id: triggerFile
    path: root.triggerPath
    atomicWrites: true
    printErrors: false
  }

  // FileView.setText does not mkdir, and with the service disabled nobody else
  // will have.
  Process {
    id: ensureStateDirProc
    command: ["mkdir", "-p", root.stateDir]
    onExited: {
      stateFile.reload()
      statusFile.reload()
    }
  }

  // ---------------------------------------------------------------- actions

  // What terminalChildDerivation answers about the window a chip (or a list
  // row) points at, or null when there is nothing to ask.
  //
  // This is the panel's half of the title-identity rule (tick 1uz): a plain
  // `foot` window running `herdr` must not be watched as "every foot window",
  // and the only thing that can name the app inside it is the child process.
  // The read is already here — `argvByPid` and `procTree` come from the one
  // cmdline Process — and it deliberately stays here: Service.qml runs all the
  // time and must never touch /proc.
  //
  // Untick asks nothing (the identity is already known), and a window whose
  // cmdline has not come back yet answers "not-read" — a REFUSAL since tick
  // gpq, not the class-only catch-all it used to fall back to.
  //
  // The window's `initialTitle` travels with the question: a terminal already
  // launched `foot --title=herdr herdr` carries the answer on its own window,
  // and reading the child process is only the third-best source (see
  // PanelModel.terminalTickDerivation).
  function tickDerivationFor(address, className) {
    if (!className) return null
    var client = PanelModel.clientForTick(root.liveClients, address, className)
    if (!client || client.pid === undefined || client.pid === null) return null
    var pid = String(client.pid)
    return PanelModel.terminalTickDerivation(className, root.argvByPid[pid], root.procTree[pid],
      client.initialTitle)
  }

  function tickDerivation(chip) {
    if (!chip || chip.identityId || !chip.className) return null
    return root.tickDerivationFor(chip.address, chip.className)
  }

  // The window a tick REFUSED, kept so the panel can say why: { className,
  // address }. Not a message but the question that produced one — the hint
  // below re-asks it against the live desktop every frame, so a refusal that
  // was only "the /proc read has not come back" clears itself the moment it
  // does, and one that was "this terminal runs two things" stays up for as long
  // as that is true.
  property var refusedTick: null

  readonly property string tickRefusalHint: {
    var pending = root.refusedTick
    if (!pending) return ""
    // Referenced so the hint re-evaluates when either read lands.
    var argv = root.argvByPid
    var tree = root.procTree
    var reason = PanelModel.tickRefusalReason(pending.className, root.identities,
      root.tickDerivationFor(pending.address, pending.className))
    return PanelModel.tickRefusalHint(pending.className, reason)
  }

  // A watched title identity whose window is on screen but was not launched
  // with --title, and the exact command that would fix it. Evidence-based and
  // self-clearing, like shadowHint: it is gone the moment a window matches.
  readonly property string untitledHint: {
    var list = root.identities
    return PanelModel.untitledTerminalHint(root.liveClients, list,
      function (client) { return Engine.matchClient(client, list) || "" },
      root.argvByPid, root.procTree)
  }

  // Click a chip: tick or untick the app it belongs to. Watched-ness is per
  // identity, so this changes every window of that app at once — which is why
  // the chip hands over the identity it already matched instead of letting the
  // write path re-derive one and possibly disagree.
  function toggleChip(chip) {
    if (!chip) return
    if (!chip.identityId && !chip.className) return
    // Belt and braces for every surface at once (the list row, the recorded
    // map's chips, the keyboard cursor): an identity that is referenced by the
    // recording but is no longer watched has no class to re-derive a pattern
    // from, so "untick" would remove nothing and "tick" has nothing to add.
    // Saying so beats a click that quietly does nothing.
    if (chip.identityId && !chip.className && !StateModel.identityById(root.stateModel, chip.identityId)) {
      root.log("\"" + chip.identityId + "\" is in the recording but no longer watched — "
        + "click its live window to watch it again")
      return
    }
    var derivation = root.tickDerivation(chip)

    // A tick that cannot produce a working identity says so rather than writing
    // the `^foot$` catch-all (tick gpq). The reason is kept, not the sentence:
    // the hint re-asks the question every frame and clears itself.
    var refusal = chip.identityId ? ""
      : PanelModel.tickRefusalReason(chip.className, root.identities, derivation)
    if (refusal) {
      root.refusedTick = { className: chip.className, address: chip.address || "" }
      root.warn("tick refused for \"" + chip.className + "\" (" + refusal + "): "
        + PanelModel.tickRefusalHint(chip.className, refusal))
      // The read may simply not be back yet, and pressing again is the whole
      // remedy — so go and get it.
      root.refreshDerivations()
      return
    }
    root.refusedTick = null

    var next = PanelModel.toggleWatchedIdentities(root.identities, chip.className, chip.identityId,
      derivation, Engine.couldShadow)

    // DERIVE BEFORE THE WRITE (tick i07). A tick creates an identity with an
    // empty launch, and "" means never start this one — so if the panel can
    // already answer for the app in front of it (its .desktop file is in the
    // scan, or its argv is in the cmdline map), the launch goes into the SAME
    // write. When it cannot, the empty write still happens instantly, and the
    // scan this call kicks off fills it in through autoFillLaunches.
    var added = PanelModel.addedIdentity(root.identities, next)
    // A title identity arrives with its launch already filled: the derivation
    // that named the app also built the command, so there is nothing left for
    // the autofill pass to fill and the log would otherwise claim nothing was
    // derived.
    var inlineLaunch = (added && added.launch) ? String(added.launch) : ""
    if (added) {
      var request = PanelModel.launchRequestFor(added,
        Engine.pickClientFor(root.liveClients, added, next), root.argvByPid)
      var derived = PanelModel.launchDerivation(request ? [request] : [],
        root.desktopFiles, root.windowsByPid, root.procTree).commands
      var fills = PanelModel.launchAutofillIndex(next, derived)
      // `own`, never `fills[added.id]` (tick 8hp, and the one lookup its sweep
      // missed): for an id like "constructor" a bare read answers with
      // Object.prototype's member — truthy, and a native function where a
      // command belongs, which the log line would then print. The WRITE was
      // already safe (autofillLaunchCommands is own()-guarded); this is the
      // sentence that would have lied about it.
      var fill = PanelModel.own(fills, added.id)
      if (fill) {
        next = PanelModel.autofillLaunchCommands(next, fills)
        inlineLaunch = fill
      }
    }

    if (root.writeState(StateModel.setIdentities(root.stateModel, next))) {
      root.log((chip.identityId ? "unwatched \"" + chip.identityId + "\"" : "watching \"" + chip.className + "\"")
        + " — " + next.length + " identities"
        + (inlineLaunch ? " (launch derived in the same write: " + inlineLaunch + ")" : ""))
    }
    // A newly ticked app whose launch could NOT be derived here has an empty one
    // by construction; go and find out what would start it while its window is
    // still in front of us.
    root.refreshDerivations()
  }

  // Write the derived launch commands into the identities that have none — and
  // into the ones whose stored command cannot run, which is the same repair
  // arriving one gate test later. Both are USER-pressed; nothing on a timer or
  // a refresh ever rewrites a launch command (PanelModel.launchRepairIndex is
  // the single rule).
  //
  // Standalone as well as part of Record, because the two are separate repairs
  // and the user needs the cheap one on its own: Record OVERWRITES the layout
  // for this topology with what is on screen now, so a user whose watched apps
  // are closed — the exact state that exposed this bug — cannot reach the
  // backfill through Record without destroying the recording they are trying
  // to restore.
  //
  // Returns { state, line } — the state to write and the line to log ONCE IT IS
  // WRITTEN — or null when there is nothing to do. The callers decide whether to
  // write it alone or together with a layout, so a Record is still ONE atomic
  // write and not two.
  //
  // The line travels back rather than being logged here (tick sma): this ran
  // before the write was even attempted, so a refused Record still announced
  // that it had learned three launch commands.
  function withLearnedLaunches(base) {
    var next = PanelModel.backfillLaunchCommands(StateModel.identities(base), root.derivedLaunch)
    var learned = []
    for (var i = 0; i < next.length; i++) {
      var before = StateModel.identityById(base, next[i].id)
      // `before.launch !== next.launch` rather than "was empty": the backfill
      // also replaces a stored command that cannot run (see
      // PanelModel.launchRepairIndex), and that repair has to show up in the
      // log the same way a first-time learn does.
      if (before && before.launch !== next[i].launch && next[i].launch) {
        learned.push(next[i].id + " -> " + next[i].launch)
      }
    }
    if (!learned.length) return null
    return {
      state: StateModel.setIdentities(base, next),
      line: "learned " + learned.length + " launch command(s): " + learned.join("; ")
    }
  }

  // What a finished scan is allowed to write on its own (tick i07).
  //
  // The bug this closes: ticking an app writes `launch: ""` instantly — "" means
  // NEVER START THIS ONE — and the scan that could have filled it finishes a
  // moment after the write. Nothing brought the two together, so a state file
  // could keep an empty launch for the rest of the session for an app whose
  // .desktop file was on disk all along, and Restore would move it but never
  // reopen it.
  //
  // The rule is narrow on purpose and lives in PanelModel.launchAutofillIndex:
  // only EMPTY launches, only identities that already exist, and only what the
  // derivation actually answered. A stored command that cannot RUN is still
  // user-pressed only ("Learn launch"), because that value may have been typed
  // by hand and rewriting it unasked is a silent edit of the user's file.
  //
  // ONE write, guarded: `autofillLaunchCommands` hands back the SAME list when
  // there is nothing to fill, and writeState drops a byte-identical text — so a
  // scan over an already-complete file writes nothing, which is what keeps this
  // off the file the service watches.
  function autoFillLaunches(source) {
    if (!root.stateLoaded) return
    var fills = PanelModel.launchAutofillIndex(root.identities, root.derivedLaunch)
    var line = PanelModel.autofillLaunchLog(fills, source)
    if (!line) return
    if (root.writeState(StateModel.setIdentities(root.stateModel,
        PanelModel.autofillLaunchCommands(root.identities, fills)))) {
      root.log(line)
    }
  }

  function learnLaunches() {
    // `stateModel` is what the WATCHED FileView last loaded, so it already
    // carries anything the service or a second panel wrote — the same freshness
    // discipline every other write in this file relies on. The backfill only
    // touches launches that are empty or unrunnable, so even a write that raced
    // ours can lose nothing but the derivation, which the next press redoes.
    var learned = root.withLearnedLaunches(root.stateModel)
    if (!learned) {
      root.log("nothing to learn: every watched app either has a launch command or has no derivable one")
      return
    }
    if (root.writeState(learned.state)) root.log(learned.line)
  }

  // One row's worth of the same repair. The list is where the user SEES that an
  // app has no launch command — or that the one it has looks broken — so it is
  // where the offer to fix it belongs; the footer button is the same act for
  // all of them at once.
  //
  // Routed through the same repair rule as the button, so a row can never write
  // something the button would have refused: the map is filtered to this one
  // identity and the backfill decides whether the stored value may be replaced.
  function learnLaunchFor(identityId) {
    var command = root.derivedLaunch[identityId]
    if (!command) return
    var one = ({})
    one[identityId] = command
    if (!PanelModel.learnableCount(root.identities, one)) return
    if (root.writeState(StateModel.setIdentities(root.stateModel,
        PanelModel.backfillLaunchCommands(root.identities, one)))) {
      root.log("learned launch for \"" + identityId + "\": " + command)
    }
  }

  // Switch the tool off, or back on.
  //
  // Read-modify-write against a FRESH read, not against the panel's in-memory
  // copy: this is the one panel write that rewrites the whole file over a value
  // the user could have been staring at for an hour, and the service and
  // scripts/record-current write the same path. The write itself is the
  // ordinary atomic round trip every other action here uses.
  //
  // No toast and no glyph poke from this side. The SERVICE owns both, off the
  // state reload (Service.notePauseChange), so flipping the flag by any route —
  // this button, a script, an editor — produces exactly the same feedback.
  function setPaused(next) {
    var fresh = root.freshState()
    if (!fresh) return
    if (StateModel.isPaused(fresh) === next) {
      // Somebody got there first. Adopt what the file says rather than writing
      // it again: the user's intent is already the file's content.
      root.stateModel = fresh
      return
    }
    if (!root.writeState(StateModel.setPaused(fresh, next))) return
    root.log(next
      ? "paused — monitor changes will be ignored until this is switched back on"
      : "activated — monitor changes will be acted on again")
  }

  // ------------------------------------------------ the one-shot record undo
  //
  // Record OVERWRITES this topology's layout and says so in its own tooltip;
  // the sketch's answer to that is not a confirmation dialog (the panel never
  // blocks) but a single undo kept IN MEMORY until the next record. This is that
  // memory: one stash, holding the layout Record replaced — or null, when this
  // topology had none and undoing means forgetting instead.
  //
  // { topologyKey, previousLayout: null | layout }
  property var recordUndo: null

  readonly property bool canUndoRecord:
    PanelModel.recordUndoValid(root.recordUndo, root.topologyKey)

  // The button is gone and the keyboard cursor cannot stay on it. Record is
  // where it goes back to, which is the button the undo belonged to.
  onCanUndoRecordChanged: {
    if (!root.canUndoRecord && root.focusSection === "undo") root.focusSection = "record"
  }

  // A dock or an undock retires it. The layout it holds belongs to a monitor
  // arrangement that is no longer on the desk, and writing it back would file a
  // recording for a topology the user is not looking at. `canUndoRecord` already
  // answers false the moment the key changes; dropping the object too is what
  // keeps a re-dock from resurrecting an undo the user has long since forgotten.
  onTopologyKeyChanged: {
    if (root.recordUndo && root.recordUndo.topologyKey !== root.topologyKey) {
      root.recordUndo = null
    }
  }

  function undoRecord() {
    if (!root.canUndoRecord) return
    var stash = root.recordUndo
    // Same read-modify-write discipline as the pause toggle, and for the same
    // reason: this rewrites the whole file from an object that also carries
    // every OTHER topology's layout, so a copy that went stale while the panel
    // sat open would file yesterday's recordings alongside today's undo.
    var fresh = root.freshState()
    if (!fresh) return

    // Cleared FIRST, and unconditionally: this is a one-shot: pressing it twice
    // must not put the same layout back twice, and a write that fails is not a
    // reason to keep offering an undo of a record the file may no longer hold.
    root.recordUndo = null

    // The slot is shared with Forget (tick gwa), and the log line names the act
    // it is undoing: a line reading "undid the record" after a Forget describes
    // a click the user never made.
    var act = PanelModel.undoStashAction(stash) === "forget" ? "forget" : "record"

    if (PanelModel.recordUndoRestores(stash)) {
      if (!root.writeState(StateModel.upsertLayout(fresh, stash.previousLayout))) return
      root.log("undid the " + act + " for topology \"" + stash.topologyKey + "\" — put back the layout"
        + " recorded at " + (stash.previousLayout.recordedAt || "an unknown time")
        + " (" + (stash.previousLayout.apps || []).length + " apps)")
      return
    }
    if (!root.writeState(StateModel.removeLayout(fresh, stash.topologyKey))) return
    root.log("undid the " + act + " for topology \"" + stash.topologyKey + "\" — this setup had no"
      + " layout before it, so it has none again")
  }

  function recordLayout() {
    if (!root.canRecord) return
    var layout = Engine.buildLayout(root.liveClients, root.liveMonitors, root.identities, new Date().toISOString())
    if (!layout.topologyKey) {
      root.warn("record refused: the monitor list resolves to no topology at all")
      return
    }
    // READ before the write, ARMED after it (tick sma). The layout this record
    // is about to replace has to be read from the state the write will replace
    // — but the undo BUTTON is the panel's one positive confirmation that a
    // record happened, and arming it before the write meant a refused write
    // grew an Undo button for a record that never took place. One stash, so a
    // second record discards the first one's undo: the sketch's "single undo
    // kept in memory until next record" exactly — the net is under the last
    // thing you did, not under everything you have ever done.
    var replaced = StateModel.layoutFor(root.stateModel, layout.topologyKey)
    // Backfill FIRST, then file the layout on top of the result, so recording
    // and learning land in the file as a single atomic write. Recording is the
    // moment the user says "this arrangement matters", which is exactly when an
    // app that cannot be relaunched stops being a curiosity and starts being
    // the reason Restore does nothing.
    var learned = root.withLearnedLaunches(root.stateModel)
    var base = learned ? learned.state : root.stateModel
    if (!root.writeState(StateModel.upsertLayout(base, layout))) return
    root.recordUndo = { topologyKey: layout.topologyKey, previousLayout: replaced }
    if (learned) root.log(learned.line)
    root.log("recorded " + layout.apps.length + " apps for topology \"" + layout.topologyKey + "\"")
    // A short recording says why it is short. `excluded` is the engine's
    // structured note (tick pqv): apps deliberately left out of the layout, not
    // apps that failed to record. Today the only reason is a scratchpad
    // workspace, whose negative id no dispatch can act on.
    var excluded = layout.excluded || []
    for (var e = 0; e < excluded.length; e++) {
      root.warn("not recorded: \"" + excluded[e].identityId + "\" is on special workspace "
        + (excluded[e].workspaceName || excluded[e].workspaceId)
        + " — a scratchpad placement cannot be restored, so it is left out of the layout")
    }
  }

  // --------------------------------------------- the header overflow menu (gwa)
  //
  // "Overflow menu: list of recorded topologies (with mini monitor glyphs),
  // forget this layout, re-record." (UX sketch, panel anatomy.)
  //
  // The list is a MEMORY and nothing else: every desk this plugin has been
  // taught, drawn the way the header draws the one in front of you. Rows for
  // topologies you are not plugged into carry no action, because every act this
  // panel has is about the monitors on the desk right now — a "restore that
  // one" on an absent desk would arrange a desktop nobody can see.

  // Every stored layout, as a list. Sorted by StateModel.topologyKeys; the model
  // hoists the current desk to the top.
  readonly property var recordedLayouts: {
    var keys = StateModel.topologyKeys(root.stateModel)
    var out = []
    for (var i = 0; i < keys.length; i++) {
      var layout = StateModel.layoutFor(root.stateModel, keys[i])
      if (layout) out.push(layout)
    }
    return out
  }

  readonly property var overflowModel: PanelModel.overflowMenuModel(
    root.recordedLayouts, root.topologyKey, root.liveMonitors, root.canRecord, root.topologyName)
  readonly property var overflowActionIds: PanelModel.menuActionIds(root.overflowModel.actions)

  property bool overflowOpen: false
  // The menu's own cursor, held as an action ID for the same reason the map's is
  // held as a chip key: the action list is rebuilt from a binding whenever the
  // state file changes, and an index would slide onto the other action.
  property string overflowCursor: ""

  // The surface is driven imperatively, the way qs.Ui/Dropdown drives its own:
  // a Popup dismissed by a click outside sets its own `visible`, and a panel
  // that had BOUND that property would be left holding a menu it can no longer
  // reopen. `overflowOpen` is this object's truth; the popup follows it.
  function openOverflow() {
    root.overflowOpen = true
    root.focusSection = "overflow"
    root.overflowCursor = PanelModel.firstEnabledActionId(root.overflowModel.actions)
    overflowPopup.open()
  }

  function closeOverflow() {
    root.overflowOpen = false
    root.overflowCursor = ""
    overflowPopup.close()
  }

  function toggleOverflow() {
    if (root.overflowOpen) root.closeOverflow()
    else root.openOverflow()
  }

  function moveOverflowCursor(delta) {
    root.overflowCursor = PanelModel.nextSection(root.overflowActionIds, root.overflowCursor, delta)
  }

  function activateOverflow() {
    var action = PanelModel.menuAction(root.overflowModel.actions, root.overflowCursor)
    if (!action || !action.enabled) return
    if (action.id === "forget") {
      root.forgetLayout()
      return
    }
    if (action.id === "rerecord") {
      // recordLayout arms the undo itself, which is the whole reason Re-record
      // is a second door onto the same function rather than its own write.
      root.recordLayout()
      root.closeOverflow()
    }
  }

  // Tabbing away from the ⋯ closes what it opened: a menu left hanging over a
  // panel whose keyboard cursor has moved on is a surface with no owner.
  onFocusSectionChanged: {
    if (root.focusSection !== "overflow" && root.overflowOpen) root.closeOverflow()
  }

  // Delete this topology's layout. No confirmation — the panel never blocks —
  // and the way back is the SAME one-shot undo Record arms, stashed before the
  // write and from the same fresh read the write is built on.
  function forgetLayout() {
    var fresh = root.freshState()
    if (!fresh) return
    var stash = PanelModel.forgetUndoStash(root.topologyKey,
      StateModel.layoutFor(fresh, root.topologyKey))
    if (!stash) {
      root.log("nothing to forget: no layout is recorded for topology \"" + root.topologyKey + "\"")
      root.closeOverflow()
      return
    }
    // Armed after the write, for the reason recordLayout's comment gives: an
    // Undo button is a claim that something happened.
    if (!root.writeState(StateModel.removeLayout(fresh, root.topologyKey))) {
      root.closeOverflow()
      return
    }
    root.recordUndo = stash
    root.log("forgot the layout for topology \"" + root.topologyKey + "\" ("
      + (stash.previousLayout.apps || []).length + " apps) — undo puts it back")
    root.closeOverflow()
  }

  // Recording during a restore would file the half-restored desktop as the
  // layout — the recording overwritten by a snapshot of its own restore in
  // flight. `restoring` comes from the service's status file, so the button
  // follows the same signal the bar glyph's sweep does, and recordHint says out
  // loud why it went dim.
  //
  // A read-only file dims it too (tick sma): the button's whole act is a write,
  // and an enabled button for a write that will be refused is the affordance
  // lying about what it does. writeRefusalReason says why, in the hint stack.
  readonly property bool canRecord: root.stateLoaded && root.haveLiveData
    && root.liveMonitors.length > 0 && !root.statusModel.restoring
    && root.writeRefusalReason === ""

  // Ask the service to restore, and GET OUT OF THE WAY first.
  //
  // The panel is a keyboard-focused layer surface, and while it is up the
  // compositor's "active window" is not a window at all. Every restore dispatch
  // that names its subject is fine with that — engine.js makes sure almost all
  // of them do — but the group rebuild's `into_group` cannot be told which
  // window to act on and works off the focus, so a restore run underneath an
  // open panel could still fail to re-tab a recorded group.
  //
  // Closing is also just the right UX: the sketch's manual restore is "press it
  // and watch the desktop rearrange itself", and the panel is sitting on top of
  // the thing the user wants to watch. It is dismissed BEFORE the trigger is
  // written so the surface is already gone by the time the service's first
  // settle delay expires.
  //
  // THIS IS NO LONGER THE ONLY PLACE THE RULE LIVES (tick eqb). A manual
  // restore is not the only cycle that needs the keyboard: tick 35n's placement
  // choreography focuses the split parent before each move, and an AUTO cycle
  // — a dock, an undock — runs that with whatever is on screen, this panel
  // included. So the service closes this panel itself before executing any plan
  // that carries a choreographed move (Service.closePanelForChoreography). This
  // function stays, because it closes the panel one settle delay EARLIER and
  // because a manual restore should get out of the way whether or not the plan
  // turns out to need the focus.
  function restoreNow() {
    var wasOpen = root.opened
    if (wasOpen) {
      root.log("closing the panel before the restore — the desktop is the thing to watch,"
        + " and a focused panel surface gets in the way of the group rebuild")
    }
    root.log("restore requested from the panel")
    triggerFile.setText(new Date().toISOString() + "\n")

    // LAST, and nothing may touch this panel afterwards. dismiss() goes through
    // the shell, which UNLOADS the panel: the first version of this closed
    // first and logged second, and the trailing log threw "Property 'log' of
    // object Panel_QMLTYPE is not a function" against the half-destroyed
    // object. Writing the trigger first costs nothing — the service waits out
    // its first settle delay (a full second) before it plans anything, so the
    // surface is long gone by the time a single dispatch is sent.
    if (wasOpen) root.dismiss()
  }

  Component.onCompleted: ensureStateDirProc.running = true

  // ------------------------------------------------------------------ window

  // Put the panel on the monitor that has focus. Without this it lands on
  // whichever screen Quickshell considers first, which on a docked laptop is
  // routinely not the one the user is looking at.
  readonly property string focusedMonitorName: {
    for (var i = 0; i < root.liveMonitors.length; i++) {
      if (root.liveMonitors[i] && root.liveMonitors[i].focused === true) return String(root.liveMonitors[i].name || "")
    }
    return ""
  }

  PanelWindow {
    id: panelWindow

    screen: {
      var screens = Quickshell.screens
      for (var i = 0; i < screens.length; i++) {
        if (screens[i] && screens[i].name === root.focusedMonitorName) return screens[i]
      }
      return screens.length > 0 ? screens[0] : null
    }

    visible: root.opened
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "mkelk-dock-recall"
    WlrLayershell.layer: WlrLayer.Overlay
    // Exclusive: the panel is summoned by a hotkey with nothing to click
    // first, and Enter has to reach it (the UX sketch's one-keystroke manual
    // restore lives on that).
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive

    anchors {
      top: true
      bottom: true
      left: true
      right: true
    }

    // Dismissal scrim. Clicking anywhere outside the card closes, which is the
    // whole dismissal story — there are no modals to get in its way.
    Rectangle {
      anchors.fill: parent
      color: Color.menu.scrim

      MouseArea {
        anchors.fill: parent
        onClicked: root.dismiss()
      }
    }

    BorderSurface {
      id: card
      anchors.centerIn: parent
      width: Math.min(Style.space(660), Math.round(panelWindow.width * 0.94))
      height: Math.min(cardColumn.implicitHeight + card.contentTopInset + card.contentBottomInset,
        Math.round(panelWindow.height * 0.88))
      color: Color.popups.background
      borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
      radius: Style.cornerRadius
      padding: Style.spacing.popupPadding

      // Swallow clicks on the card so they never reach the scrim behind it.
      // Declared before the content so the content still gets them first.
      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.AllButtons
      }

      PanelKeyCatcher {
        id: keyCatcher
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset

        // Esc closes the MENU first when one is open, and the panel only when
        // there is nothing else to back out of — one key, one level at a time.
        onCloseRequested: root.overflowOpen ? root.closeOverflow() : root.dismiss()
        onMoveRequested: function (dx, dy) { root.handleMove(dx, dy) }
        // Space and Enter both land here (PanelKeyCatcher emits
        // activateRequested for each), which is exactly the rule the sketch
        // asks for: Space toggles the chip under the cursor, Enter activates
        // whatever has focus — and on the footer those are the same act.
        onActivateRequested: root.activateCursor()
        onTabRequested: function (direction) { root.moveSection(direction) }

        ScrollView {
          id: scrollArea
          anchors.fill: parent
          clip: true

          // Does the card have more in it than it can show? One question, asked
          // once, because three separate things below depend on the answer and
          // they must not be able to disagree about it.
          readonly property bool overflowing: cardColumn.implicitHeight > scrollArea.height

          // Wired EXPLICITLY rather than left to ScrollView's implicit-size
          // inference. The inference does work here (a Column reports its
          // stacked height as implicitHeight, so contentHeight comes out
          // right), but it is one refactor away from not: give this Column a
          // child that anchors instead of stacking, or wrap it in an Item, and
          // implicitHeight goes to 0, contentHeight goes to -1, and the panel
          // silently stops scrolling with nothing in the log to say so. The
          // height the card is SIZED from is the height the viewport scrolls
          // over; saying so once is cheaper than discovering the day they
          // parted.
          contentWidth: scrollArea.availableWidth
          contentHeight: cardColumn.implicitHeight

          ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
          // AlwaysOn, not AsNeeded, and this is the difference between a
          // scrollbar and no scrollbar. AsNeeded leaves the handle at opacity 0
          // until the ScrollBar goes `active` — i.e. until the pointer is
          // already on it or a scroll is already under way (QtQuick Controls
          // Basic, ScrollBar.qml: the "active" state is the only thing that
          // raises the handle). This panel is summoned by a hotkey onto a
          // keyboard-exclusive surface; a user who never touches the mouse was
          // never shown that there was anything below the fold.
          ScrollBar.vertical.policy: scrollArea.overflowing ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff

          // The shell's own idiom (monitor and audio panels): a card with
          // nothing to scroll should not rubber-band under a stray wheel.
          Binding {
            target: scrollArea.contentItem
            property: "interactive"
            value: scrollArea.overflowing
          }

          Column {
            id: cardColumn
            width: scrollArea.availableWidth
            spacing: Style.space(12)

            // ------------------------------------------------ header
            Item {
              width: parent.width
              implicitHeight: Math.max(topologyLabel.implicitHeight, badgePill.implicitHeight)

              Text {
                id: topologyLabel
                text: root.topologyName
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
                elide: Text.ElideRight
                anchors.left: parent.left
                anchors.right: badgePill.left
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
              }

              // The on/off switch, right beside the badge it explains: the
              // badge says "Paused" and this is the thing that made it say so.
              // Labelled with the ACT, not the state — a control reading
              // "Paused" beside a badge reading "Paused" is a status line
              // pretending to be a button.
              Button {
                id: pauseButton
                anchors.right: overflowButton.left
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                text: root.paused ? "Activate" : "Pause"
                tooltipText: PanelModel.wrapTooltip(PanelModel.pauseTooltip(root.paused))
                bordered: true
                // Emphasized while paused: switching the tool back on is the
                // one action that changes what everything else in this panel
                // means, and it should not look like a secondary control.
                active: root.paused
                accent: Color.accent
                hasCursor: root.focusSection === "pause"
                onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(pauseButton)
                enabled: root.stateLoaded
                opacity: root.stateLoaded ? 1.0 : 0.45
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                onClicked: root.setPaused(!root.paused)
              }

              BorderSurface {
                id: badgePill
                anchors.right: pauseButton.left
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                implicitWidth: badgeText.implicitWidth + Style.space(16)
                implicitHeight: badgeText.implicitHeight + Style.space(6)
                radius: Style.cornerRadius
                color: Style.hoverFillFor(root.toneColor(root.badge.tone), root.toneColor(root.badge.tone))
                borderSpec: Border.controlSpec("normal", root.toneColor(root.badge.tone), root.toneColor(root.badge.tone))

                Text {
                  id: badgeText
                  anchors.centerIn: parent
                  text: root.badge.text
                  color: root.toneColor(root.badge.tone)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }

                // The badge is one word; this is what the word means and what
                // to do about it. Both come from the same glyph state, so the
                // badge and its explanation cannot describe different desktops.
                HoverHandler { id: badgeHover }

                PanelToolTip {
                  id: badgeTip
                  visible: badgeHover.hovered && badgeTip.text !== ""
                  text: PanelModel.wrapTooltip(
                    PanelModel.badgeTooltip(StateModel.glyphState(root.badgeStatus), root.badgeStatus))
                  fontFamily: root.fontFamily
                }
              }

              // The overflow menu: recorded topologies, forget this layout,
              // re-record (tick gwa).
              //
              // A QtQuick.Controls Popup dressed in the kit's own surface
              // tokens, which is the shell's own idiom for a menu that lives
              // INSIDE a panel — qs.Ui/Dropdown.qml does exactly this, and the
              // two first-party alternatives do not fit: PopupCard is a
              // PopupWindow anchored to the bar, and ConfirmDialog is the modal
              // this panel's interaction rules forbid.
              Button {
                id: overflowButton
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: "⋯"
                tooltipText: PanelModel.wrapTooltip(PanelModel.overflowTooltip(),
                  root.footerTooltipColumns)
                bordered: true
                selected: root.overflowOpen
                hasCursor: root.focusSection === "overflow"
                onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(overflowButton)
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.title
                onClicked: root.toggleOverflow()

                Popup {
                  id: overflowPopup
                  // Hung from the right edge of the ⋯, and never wider than the
                  // card it is drawn over.
                  x: overflowButton.width - width
                  y: overflowButton.height + Style.spacing.xxs
                  width: Math.min(Style.space(340), card.width - Style.space(24))
                  padding: Style.spacing.popupPadding
                  // The panel's own key catcher keeps the keyboard. The menu is
                  // driven by the same arrows / Enter / Esc as every other
                  // section (root.handleMove, root.activateCursor), and a Popup
                  // that grabbed focus would leave Esc closing nothing.
                  focus: false
                  closePolicy: Popup.CloseOnPressOutside
                  onClosed: root.closeOverflow()

                  background: BorderSurface {
                    color: Color.popups.background
                    borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border,
                      Math.max(1, Style.space(2)))
                    radius: Style.cornerRadius
                  }

                  contentItem: Column {
                    id: menuColumn
                    spacing: Style.space(6)

                    Text {
                      width: menuColumn.width
                      text: root.overflowModel.title
                      color: root.dimForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      elide: Text.ElideRight
                    }

                    // One row per recorded topology. INFORMATIONAL: there is no
                    // action on a desk that is not on the desk.
                    Repeater {
                      model: root.overflowModel.rows

                      delegate: Item {
                        id: menuRow
                        required property var modelData
                        width: menuColumn.width
                        implicitHeight: Math.max(glyphRow.implicitHeight,
                          rowText.implicitHeight + Style.space(2))

                        // The mini monitor glyph: one outlined rectangle per
                        // screen, three at most, accented on the desk you are
                        // sitting at.
                        Row {
                          id: glyphRow
                          anchors.left: parent.left
                          anchors.verticalCenter: parent.verticalCenter
                          spacing: Style.space(2)

                          Repeater {
                            model: menuRow.modelData.glyphs

                            delegate: Rectangle {
                              width: Style.space(11)
                              height: Style.space(8)
                              radius: Style.space(1)
                              color: "transparent"
                              border.width: 1
                              border.color: menuRow.modelData.current
                                ? Color.accent : root.faintForeground
                            }
                          }

                          Text {
                            visible: menuRow.modelData.moreMonitors
                            anchors.verticalCenter: parent.verticalCenter
                            text: "+"
                            color: root.faintForeground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                          }
                        }

                        Column {
                          id: rowText
                          anchors.left: glyphRow.right
                          anchors.leftMargin: Style.space(8)
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                          spacing: 0

                          Text {
                            width: parent.width
                            text: menuRow.modelData.note
                              ? menuRow.modelData.name + " · " + menuRow.modelData.note
                              : menuRow.modelData.name
                            color: menuRow.modelData.current ? Color.accent : root.foreground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            font.bold: menuRow.modelData.current
                            elide: Text.ElideRight
                          }

                          Text {
                            width: parent.width
                            text: menuRow.modelData.appLabel
                            color: root.dimForeground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideRight
                          }
                        }
                      }
                    }

                    Text {
                      width: menuColumn.width
                      visible: root.overflowModel.hint !== ""
                      text: root.overflowModel.hint
                      color: root.dimForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      wrapMode: Text.WordWrap
                    }

                    PanelSeparator { foreground: root.foreground }

                    // The two acts, both about the CURRENT topology. Neither
                    // asks twice; Forget arms the footer's one-shot undo.
                    Repeater {
                      model: root.overflowModel.actions

                      delegate: Button {
                        id: actionButton
                        required property var modelData
                        width: menuColumn.width
                        leftAlign: true
                        text: actionButton.modelData.label
                        tooltipText: PanelModel.wrapTooltip(actionButton.modelData.tooltip,
                          root.footerTooltipColumns)
                        bordered: true
                        hasCursor: root.overflowCursor === actionButton.modelData.id
                        enabled: actionButton.modelData.enabled
                        opacity: actionButton.modelData.enabled ? 1.0 : 0.45
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        fontSize: Style.font.caption
                        onClicked: {
                          root.overflowCursor = actionButton.modelData.id
                          root.activateOverflow()
                        }
                      }
                    }
                  }
                }
              }
            }

            PanelSeparator { foreground: root.foreground }

            // ------------------------------------------------ view toggle
            Row {
              spacing: Style.spacing.xs

              Button {
                text: "Live"
                bordered: true
                selected: !root.showRecorded
                tooltipText: PanelModel.wrapTooltip(PanelModel.viewToggleTooltip(false, !!root.recordedLayout))
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                onClicked: root.showRecorded = false
              }

              Button {
                text: "Recorded"
                bordered: true
                selected: root.showRecorded
                tooltipText: PanelModel.wrapTooltip(PanelModel.viewToggleTooltip(true, !!root.recordedLayout))
                // Nothing recorded for this topology means nothing to show;
                // the toggle dims rather than flipping to an empty map.
                enabled: !!root.recordedLayout
                opacity: root.recordedLayout ? 1.0 : 0.45
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                onClicked: if (root.recordedLayout) root.showRecorded = true
              }
            }

            // ------------------------------------------------ the map
            BorderSurface {
              id: mapSurface
              width: parent.width
              // Height follows the canvas, and the canvas follows its
              // children. mapCanvas is deliberately NOT anchored to fill this
              // surface: filling would make its height depend on the height it
              // is being asked to determine, which is a binding loop even when
              // the numbers happen to settle.
              height: Math.max(root.mapMinHeight, mapCanvas.height)
                + mapSurface.contentTopInset + mapSurface.contentBottomInset
              color: Style.normalFillFor(root.foreground, Color.accent)
              borderSpec: Border.controlSpec("normal", root.foreground, Color.accent)
              radius: Style.cornerRadius
              padding: Style.space(8)

              Item {
                id: mapCanvas
                x: mapSurface.contentLeftInset
                y: mapSurface.contentTopInset
                width: Math.max(1, mapSurface.width - mapSurface.contentLeftInset - mapSurface.contentRightInset)
                height: childrenRect.height

                // How the panel's width is shared out between the monitors —
                // proportional to their real widths, floored so the narrowest
                // one can still hold a readable workspace box. The monitors
                // arrive already ordered left to right (mapGeometry sorts them
                // by their place on the desk), so the row below IS the desk's
                // arrangement.
                readonly property var sectionWidths: {
                  var monitors = root.mapModel.monitors
                  var widths = []
                  for (var i = 0; i < monitors.length; i++) widths.push(monitors[i].logicalWidth)
                  return PanelModel.monitorSectionWidths(widths, mapCanvas.width,
                    root.mapGap, Style.space(112))
                }

                Text {
                  // Positioned rather than centred: anchoring to a parent
                  // whose height comes from childrenRect would put this text
                  // in its own way.
                  anchors.horizontalCenter: parent.horizontalCenter
                  y: Style.space(20)
                  visible: root.mapModel.monitors.length === 0
                  text: root.readError ? "Could not read the desktop" : "No monitors"
                  color: root.faintForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                // The desk, left to right. The monitors were drawn at their
                // scaled positions before, inside a box of fixed height — which
                // is what made a 7-workspace laptop come out as a strip of
                // portrait slivers with most of the panel's width unused. A
                // section keeps the monitor's PLACE in the row and its share of
                // the width; what it gives up is being a to-scale rectangle,
                // because a workspace you cannot read is not a truer picture
                // than a section that is a little too tall.
                Row {
                  id: monitorRow
                  width: parent.width
                  spacing: root.mapGap

                  Repeater {
                    model: root.mapModel.monitors

                    delegate: BorderSurface {
                      id: monitorRect
                      required property var modelData
                      required property int index

                      readonly property int sectionWidth: {
                        var widths = mapCanvas.sectionWidths
                        return (monitorRect.index >= 0 && monitorRect.index < widths.length)
                          ? widths[monitorRect.index] : mapCanvas.width
                      }

                      // The monitor's own shape, which is the shape every
                      // workspace box under it is drawn at — a workspace fills
                      // its monitor, so any other ratio draws every window
                      // inside it at the wrong proportions.
                      readonly property real aspect: monitorRect.modelData.logicalHeight > 0
                        ? (monitorRect.modelData.logicalWidth / monitorRect.modelData.logicalHeight)
                        : (16 / 9)

                      width: monitorRect.sectionWidth
                      // Follows its content: the workspaces decide how many rows
                      // they need, and the map grows rather than shrinking them.
                      height: monitorColumn.implicitHeight
                        + monitorRect.contentTopInset + monitorRect.contentBottomInset
                      color: "transparent"
                      borderSpec: Border.controlSpec("normal", root.foreground, Color.accent)
                      radius: Style.cornerRadius
                      padding: Style.space(5)

                      Column {
                        id: monitorColumn
                        anchors.top: parent.top
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.topMargin: monitorRect.contentTopInset
                        anchors.leftMargin: monitorRect.contentLeftInset
                        anchors.rightMargin: monitorRect.contentRightInset
                        spacing: Style.space(4)

                        Item {
                          width: parent.width
                          implicitHeight: monitorName.implicitHeight

                          Text {
                            id: monitorName
                            text: monitorRect.modelData.name
                            color: root.faintForeground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            anchors.left: parent.left
                          }

                          Text {
                            id: monitorSize
                            text: monitorRect.modelData.sizeLabel
                            color: root.faintForeground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            anchors.right: parent.right
                            // A narrow laptop rectangle has room for the name or
                            // the mode, not both.
                            visible: parent.width > monitorName.implicitWidth + monitorSize.implicitWidth + Style.space(8)
                          }
                        }

                        // Uniform mini-monitors, wrapped into as many rows as the
                        // section's width needs. The packing (how many columns,
                        // how wide a box) is a pure function so it can be argued
                        // with in a test rather than in a screenshot.
                        Flow {
                          id: workspaceFlow
                          width: parent.width
                          spacing: root.mapGap

                          readonly property var grid: PanelModel.workspaceGridLayout(
                            monitorRect.modelData.workspaces.length, monitorRect.aspect,
                            workspaceFlow.width, root.mapGap, Style.space(96), Style.space(220))

                          Repeater {
                            model: monitorRect.modelData.workspaces

                            delegate: BorderSurface {
                              id: workspaceSlot
                              required property var modelData

                              // Is there geometry for every window in this
                              // workspace? When there is, the chips are drawn
                              // where the windows really are; when there is not
                              // — a v1 recording, a read that came back without
                              // at/size — the whole workspace falls back to the
                              // stacked slots this panel drew before, because
                              // mixing the two would put an unplaced chip on top
                              // of a placed one. PanelModel.workspaceModel owns
                              // that decision; this is the branch on it.
                              readonly property bool positioned: workspaceSlot.modelData.fallback !== true
                              readonly property int slotCount: workspaceSlot.modelData.slots.length

                              // The drawing area, inside the border and under the
                              // "ws N" label.
                              readonly property real canvasWidth: Math.max(1, workspaceFlow.grid.boxW
                                - workspaceSlot.contentLeftInset - workspaceSlot.contentRightInset)
                              // A workspace fills its monitor, so its box is the
                              // MONITOR's shape — anything else and every window
                              // drawn inside it is at the wrong proportions,
                              // which is the whole point of drawing them to
                              // scale.
                              readonly property real aspect: workspaceSlot.modelData.aspect > 0
                                ? workspaceSlot.modelData.aspect : (16 / 9)
                              readonly property real stackRowHeight: Style.space(17)
                              readonly property real stackGap: Style.space(3)
                              // Positioned: exactly the monitor's shape, which is
                              // what makes a half-width window read as half a box.
                              // Fallback: the stacked rows this panel drew before
                              // rects existed, and the box grows if there are more
                              // of them than the monitor's shape has room for.
                              readonly property real canvasHeight: workspaceSlot.positioned
                                ? Math.max(1, Math.round(workspaceSlot.canvasWidth / workspaceSlot.aspect))
                                : Math.max(Math.round(workspaceSlot.canvasWidth / workspaceSlot.aspect),
                                  workspaceSlot.slotCount * workspaceSlot.stackRowHeight
                                  + Math.max(0, workspaceSlot.slotCount - 1) * workspaceSlot.stackGap)

                              // This workspace's fraction rects as a PLAIN JS
                              // array of plain objects, and this copy is not
                              // ceremony — it is the repair.
                              //
                              // `modelData` reaches this delegate through
                              // Repeater.model, which is a QVariant property, so
                              // the model's JS arrays are converted on the way in
                              // and `modelData.slots` comes back as a QVariantList
                              // sequence wrapper. It indexes and reports .length
                              // like an array, which is why everything else about
                              // the delegate worked — but PanelModel.isArray asks
                              // Object.prototype.toString for "[object Array]",
                              // and a sequence wrapper answers something else. So
                              // chipRectsForCanvas took its `isArray(rects) ?
                              // rects : []` branch and returned [] for EVERY
                              // workspace on the desk, with no exception and no
                              // warning to show for it. Rebuilding the fractions
                              // here hands the model a value it recognises.
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

                              // Where each chip lands, floors applied and the
                              // floors kept from drawing two separate windows on
                              // top of each other — the defect the live round
                              // caught on a workspace with two tiled windows.
                              // Resolved once per workspace rather than per chip:
                              // a chip cannot know what its neighbours want.
                              //
                              // Sized from the canvas ITEM's laid-out width and
                              // height rather than from the numbers that were fed
                              // to it. A Flow's first pass runs before its width
                              // is known, and a rect resolved from a zero-width
                              // canvas must be a frame, never a state: naming
                              // workspaceCanvas.width/height here is what makes
                              // QML re-run this the moment the layout settles.
                              readonly property var drawnRects: workspaceSlot.positioned
                                ? PanelModel.chipRectsForCanvas(workspaceSlot.slotRects,
                                  workspaceCanvas.width, workspaceCanvas.height,
                                  Style.space(16), Style.space(10))
                                : []

                              // No silent degradation. `fallback: false` is the
                              // model's promise that every slot in this workspace
                              // has geometry, so anything short of one non-null
                              // rect per slot is a broken promise at this
                              // boundary — exactly the shape of the defect above,
                              // which cost a whole live round precisely because it
                              // threw nothing. Once per workspace, in `qs log`.
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

                              width: workspaceFlow.grid.boxW
                              // Explicit, never derived from the children: the
                              // chips are positioned INSIDE this height, so
                              // measuring the children to find it is a binding
                              // loop even when the numbers happen to settle.
                              height: workspaceLabel.implicitHeight + Style.space(3) + workspaceSlot.canvasHeight
                                + workspaceSlot.contentTopInset + workspaceSlot.contentBottomInset
                              color: "transparent"
                              borderSpec: Border.controlSpec("normal", root.faintForeground, root.faintForeground)
                              radius: Style.cornerRadius
                              padding: Style.space(4)

                              Text {
                                id: workspaceLabel
                                text: "ws " + workspaceSlot.modelData.name
                                color: root.faintForeground
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                                anchors.top: parent.top
                                anchors.left: parent.left
                                anchors.topMargin: workspaceSlot.contentTopInset
                                anchors.leftMargin: workspaceSlot.contentLeftInset
                              }

                              Item {
                                id: workspaceCanvas
                                x: workspaceSlot.contentLeftInset
                                y: workspaceSlot.contentTopInset + workspaceLabel.implicitHeight + Style.space(3)
                                width: workspaceSlot.canvasWidth
                                height: workspaceSlot.canvasHeight

                                Repeater {
                                  model: workspaceSlot.modelData.slots

                                  // A slot is one chip, or a fused run of chips
                                  // that share a tab group — drawn as one pill
                                  // with dividers, because that is what a tab
                                  // group is. A tab group is also ONE window's
                                  // worth of screen, which is why it gets one
                                  // rectangle however many tabs are in it.
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
                                    // The drift tone outranks everything. The
                                    // link highlight is carried by the border
                                    // STATE below rather than by a second
                                    // colour, so a drifted chip can light up
                                    // under the pointer without stopping being
                                    // drifted — and a hovered chip that is NOT
                                    // drifted brightens to the ordinary
                                    // foreground, which is the one thing the
                                    // drift edge must never be confused with.
                                    // (root.driftTone, and the gap it carries.)
                                    readonly property color edgeColor: chipSlot.anyDrifted
                                      ? root.driftTone
                                      : (chipSlot.linkHovered ? root.foreground
                                        : (chipSlot.anyWatched ? Color.accent : root.faintForeground))

                                    // Does the keyboard cursor sit on one of
                                    // this slot's chips? Asked per slot rather
                                    // than per chip so a fused tab group shows
                                    // one cursor, on the pill.
                                    readonly property bool hasCursor: {
                                      if (root.focusSection !== "chips") return false
                                      for (var c = 0; c < modelData.chips.length; c++) {
                                        if (modelData.chips[c].key === root.cursorKey) return true
                                      }
                                      return false
                                    }

                                    // The map is the tallest thing in the card
                                    // and the arrows walk it in reading order,
                                    // so a chip low on the last monitor is as
                                    // far below the fold as the footer is.
                                    onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(chipSlot)

                                    // Is the thing the pointer is on — here or
                                    // down in the list — this app? Same question
                                    // per slot, for the same reason.
                                    readonly property bool linkHovered: {
                                      if (root.hoveredLinkKey === "") return false
                                      for (var h = 0; h < modelData.chips.length; h++) {
                                        if (modelData.chips[h].linkKey === root.hoveredLinkKey) return true
                                      }
                                      return false
                                    }

                                    readonly property bool highlighted: chipSlot.hasCursor || chipSlot.linkHovered

                                    // The window's own rectangle, scaled onto
                                    // this workspace's canvas — or, when the
                                    // workspace has no geometry to draw with,
                                    // the stacked row it always had.
                                    //
                                    // The floor is not cosmetic: a terminal
                                    // occupying 8% of an ultrawide is four pixels
                                    // of chip, which is not a control and cannot
                                    // be clicked. It used to be 24 spacing units
                                    // wide, which on the tiny canvases the old
                                    // layout produced clamped EVERY chip to the
                                    // full width of its workspace and drew two
                                    // tiled windows one on top of the other. It
                                    // is 16×10 px now, and
                                    // PanelModel.chipRectsForCanvas is where the
                                    // rule that the floor may never superimpose
                                    // two separate windows lives.
                                    readonly property var drawn: {
                                      if (!workspaceSlot.positioned) return null
                                      var rects = workspaceSlot.drawnRects
                                      if (!rects || chipSlot.index >= rects.length) return null
                                      return rects[chipSlot.index] || null
                                    }

                                    // Which of the two layouts this chip is in is
                                    // the MODEL's answer and nobody else's: the
                                    // stacked rows are reachable only from
                                    // `positioned === false`, i.e. only when
                                    // workspaceModel set fallback: true. They used
                                    // to be reachable from a null `drawn` as well,
                                    // and that is how a workspace with perfectly
                                    // good geometry drew itself as a stack for a
                                    // whole release without a word in the log.
                                    // A positioned workspace missing a rect now
                                    // draws a floor-sized marker at the canvas
                                    // origin — visibly wrong, and warned about
                                    // above — rather than borrowing a layout that
                                    // looks deliberate.
                                    x: workspaceSlot.positioned
                                      ? (chipSlot.drawn ? chipSlot.drawn.x : 0)
                                      : 0
                                    y: workspaceSlot.positioned
                                      ? (chipSlot.drawn ? chipSlot.drawn.y : 0)
                                      : chipSlot.index * (workspaceSlot.stackRowHeight + workspaceSlot.stackGap)
                                    width: workspaceSlot.positioned
                                      ? (chipSlot.drawn ? chipSlot.drawn.width : Style.space(16))
                                      : workspaceCanvas.width
                                    height: workspaceSlot.positioned
                                      ? (chipSlot.drawn ? chipSlot.drawn.height : Style.space(10))
                                      : workspaceSlot.stackRowHeight
                                    radius: Style.cornerRadius
                                    color: chipSlot.highlighted
                                      ? Style.hoverFillFor(root.foreground, Color.accent)
                                      : (chipSlot.anyWatched && !chipSlot.anyGhost
                                        ? Style.selectedFillFor(root.foreground, Color.accent)
                                        : "transparent")
                                    // A ghost draws its outline with the Shape
                                    // below instead, so the solid one steps
                                    // aside.
                                    borderSpec: chipSlot.anyGhost && !chipSlot.highlighted
                                      ? Border.none()
                                      : Border.controlSpec(chipSlot.highlighted ? "hover-cursor" : "normal",
                                        chipSlot.edgeColor, chipSlot.edgeColor)
                                    opacity: chipSlot.anyGhost ? 0.6 : 1.0

                                    // Recorded-but-not-running: a dashed outline,
                                    // the one shape in the panel that says "this
                                    // is where it goes" rather than "this is
                                    // where it is".
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
                                      // A chip drawn at the minimum size is
                                      // shorter than its label wants to be. The
                                      // label elides horizontally; this stops a
                                      // descender spilling onto the chip below.
                                      // Clipped HERE rather than on the slot, so
                                      // the slot's own border is not clipped
                                      // along with it.
                                      clip: true
                                      spacing: 0

                                      Repeater {
                                        model: chipSlot.modelData.chips

                                        delegate: Item {
                                          id: chipTab
                                          required property var modelData
                                          required property int index

                                          // The whole of what the panel knows
                                          // about this window, assembled by a
                                          // pure function so the tooltip and the
                                          // tests read the same sentence.
                                          readonly property string tipText: PanelModel.wrapTooltip(
                                            PanelModel.chipTooltipText(chipTab.modelData),
                                            root.chipTooltipColumns)

                                          // The tab strip divides the slot's
                                          // rectangle evenly; a solo chip is
                                          // simply a strip of one, which is why
                                          // there is no second code path for it.
                                          width: chipRow.width / chipSlot.modelData.chips.length
                                          height: chipRow.height

                                          // Tab divider. Only between members,
                                          // never at the ends — the pill's own
                                          // border does the outside.
                                          Rectangle {
                                            visible: chipTab.index > 0
                                            width: 1
                                            height: parent.height
                                            color: chipSlot.edgeColor
                                            opacity: 0.6
                                          }

                                          Column {
                                            anchors.centerIn: parent
                                            // Never negative: a chip drawn at the
                                            // minimum size is narrower than its
                                            // own padding, and a Text with a
                                            // negative width elides to nothing at
                                            // all rather than to one letter.
                                            width: Math.max(Style.space(8), chipTab.width - Style.space(8))
                                            spacing: Style.space(2)

                                            Text {
                                              id: chipLabel
                                              // Under ~40 px the label is one
                                              // elided letter and a smear, and it
                                              // makes a small chip look like a
                                              // broken one. It comes off; the chip
                                              // keeps its hover, its click and its
                                              // tooltip, which is where the whole
                                              // story was already.
                                              visible: PanelModel.chipLabelVisible(chipTab.width, Style.space(40))
                                              width: parent.width
                                              horizontalAlignment: Text.AlignHCenter
                                              // The label is what survives a small
                                              // chip; the whole story is in the
                                              // tooltip.
                                              elide: Text.ElideRight
                                              maximumLineCount: 1
                                              // The bare arrow is what the chip
                                              // said before there was room to say
                                              // WHERE. When the tag is up it says
                                              // that in full, and repeating the
                                              // arrow on the name would be the
                                              // same sign twice.
                                              text: (chipTab.modelData.drifted && !chipTag.visible)
                                                ? chipTab.modelData.name + " →"
                                                : chipTab.modelData.name
                                              color: chipTab.modelData.watched ? root.foreground : root.faintForeground
                                              font.family: root.fontFamily
                                              font.pixelSize: Style.font.caption
                                            }

                                            // THE TAG PILL: one line the chip can
                                            // say without being hovered.
                                            //
                                            // Two different sentences, two
                                            // different colours, and that
                                            // difference is the point. The drift
                                            // tone — the chip edge's own colour,
                                            // root.driftTone — means "a restore
                                            // would move this, and here is where
                                            // to". Neutral means "the tool has
                                            // looked at this workspace's SHAPE
                                            // and will not touch it", which is a
                                            // ceiling rather than a fault, and
                                            // painting it loud would file it as
                                            // one.
                                            //
                                            // Drift wins when a chip has both: it
                                            // is the half the user can clear with
                                            // one click, and the refusal is a line
                                            // in the tooltip either way.
                                            //
                                            // It rides the LABEL's visibility
                                            // threshold rather than inventing a
                                            // second one — a chip too small for its
                                            // own name is far too small for a tag —
                                            // and it also has to FIT, because an
                                            // elided tag is a worse signal than no
                                            // tag at all.
                                            Rectangle {
                                              id: chipTag
                                              readonly property bool isDrift: (chipTab.modelData.driftTag || "") !== ""
                                              readonly property string tagText: chipTag.isDrift
                                                ? chipTab.modelData.driftTag
                                                : (chipTab.modelData.refusalTag || "")
                                              // The pill wears the chip edge's
                                              // own colour because it is the
                                              // same signal said in words; the
                                              // refusal pill stays neutral so
                                              // the two never read as one.
                                              readonly property color tone: chipTag.isDrift
                                                ? root.driftTone : root.dimForeground

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
                                                anchors.centerIn: parent
                                                text: chipTag.tagText
                                                color: chipTag.tone
                                                font.family: root.fontFamily
                                                font.pixelSize: Style.font.caption
                                              }
                                            }
                                          }

                                          MouseArea {
                                            id: chipMouse
                                            anchors.fill: parent
                                            hoverEnabled: true
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: root.toggleChip(chipTab.modelData)
                                            // The other half of the link: the
                                            // row (or rows) for this app light
                                            // up while the pointer is here.
                                            onEntered: root.setHoveredLink(chipTab.modelData.linkKey)
                                            onExited: root.clearHoveredLink(chipTab.modelData.linkKey)
                                            // Re-claim the key on every move too — crossing straight
                                            // from one chip of this app to an adjacent one (same
                                            // linkKey) can otherwise land the old chip's exited()
                                            // after the new chip's entered() and wipe the highlight.
                                            // See clearHoveredLink.
                                            onPositionChanged: root.setHoveredLink(chipTab.modelData.linkKey)
                                          }

                                          // On ANY chip, not only a drifted one.
                                          //
                                          // A chip is three letters wide on a
                                          // busy workspace, and the window's own
                                          // title is the only thing that tells
                                          // two windows of the same app apart —
                                          // so the tooltip carries the title, the
                                          // class, and where the window is, and
                                          // adds the drift arrow and the WHAT-is-
                                          // wrong sentence when there are any.
                                          // ("recorded on DP-2 · ws 10" is no
                                          // help at all on a window already on
                                          // DP-2 ws 10 whose tabs are in the
                                          // wrong order.) PanelModel.chipTooltipText
                                          // decides what is worth saying; "" is
                                          // its way of saying nothing is, and the
                                          // tooltip stays down.
                                          PanelToolTip {
                                            visible: chipMouse.containsMouse && chipTab.tipText !== ""
                                            text: chipTab.tipText
                                            fontFamily: root.fontFamily
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }

            // ------------------------------------------------ empty state
            Text {
              width: parent.width
              visible: root.emptyHint !== ""
              text: root.emptyHint
              color: root.dimForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              width: parent.width
              visible: root.recordHint !== ""
              text: root.recordHint
              color: root.dimForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // A watched app that no open window reaches while the list is in
            // this order. Urgent rather than dim: unlike the two hints above it,
            // this one is about windows on screen right now, being recorded
            // under another identity's name. What the sentence ASKS FOR varies
            // with the evidence — an instruction only where the identity in
            // front is wider by construction, an observation otherwise (see
            // PanelModel.shadowNoticeFor).
            Text {
              width: parent.width
              visible: root.shadowHint !== ""
              text: root.shadowHint
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // The file is read-only, so nothing in this panel can change it.
            // Said once, persistently, in the urgent colour — the alternative
            // was a Record that logged success and grew an Undo button for a
            // write that never happened (tick sma).
            Text {
              width: parent.width
              visible: root.writeRefusalReason !== ""
              text: "Read-only: " + root.writeRefusalReason
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // A tick that refused, and a watched app whose window cannot match
            // it until it is relaunched. Both are urgent for the same reason
            // the shadow line is: the user pressed something and the desktop
            // does not say what they expect it to say.
            Text {
              width: parent.width
              visible: root.tickRefusalHint !== ""
              text: root.tickRefusalHint
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              width: parent.width
              visible: root.untitledHint !== ""
              text: root.untitledHint
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              width: parent.width
              visible: root.readError !== ""
              text: "Could not read the desktop — showing the last good snapshot. (" + root.readError + ")"
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSeparator { foreground: root.foreground }

            // ------------------------------------------------ the flat list
            Column {
              width: parent.width
              spacing: 0

              Repeater {
                model: root.appRows

                delegate: Item {
                  id: appRow
                  required property var modelData

                  width: parent.width
                  height: rowLabel.implicitHeight + Style.space(10)
                  opacity: appRow.modelData.ghost ? 0.6 : 1.0

                  // Is the pointer on this app — here, or on one of its chips
                  // up on the map?
                  readonly property bool linked: root.hoveredLinkKey !== ""
                    && root.hoveredLinkKey === appRow.modelData.linkKey
                  readonly property string tipText: PanelModel.wrapTooltip(
                    PanelModel.rowTooltipText(appRow.modelData),
                    root.chipTooltipColumns)

                  // Declared FIRST so it sits behind the row's own content: the
                  // list's half of the link, and the same hover fill the map
                  // uses, so the two surfaces answer a hover in one language.
                  Rectangle {
                    anchors.fill: parent
                    visible: appRow.linked
                    color: Style.hoverFillFor(root.foreground, Color.accent)
                    radius: Style.cornerRadius
                  }

                  HoverHandler {
                    id: rowHover
                    onHoveredChanged: {
                      if (rowHover.hovered) root.setHoveredLink(appRow.modelData.linkKey)
                      else root.clearHoveredLink(appRow.modelData.linkKey)
                    }
                    // Re-claim the key on every move too — see the chip
                    // MouseArea's onPositionChanged for why: a live pointer
                    // must always re-assert its key, not just on entry.
                    onPointChanged: {
                      if (rowHover.hovered) root.setHoveredLink(appRow.modelData.linkKey)
                    }
                  }

                  // The checkbox mirrors the chip: same state, same click.
                  Rectangle {
                    id: rowBox
                    width: Style.space(11)
                    height: Style.space(11)
                    radius: Math.max(1, Math.round(width * 0.25))
                    color: appRow.modelData.watched ? Color.accent : "transparent"
                    border.width: 1
                    border.color: appRow.modelData.watched ? Color.accent : root.faintForeground
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: rowLabel
                    text: appRow.modelData.name
                    color: appRow.modelData.watched ? root.foreground : root.faintForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: appRow.modelData.watched
                    elide: Text.ElideRight
                    anchors.left: rowBox.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: rowLaunch.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  // What Restore can and cannot do for this app, in three
                  // words. "no launch cmd" is the honest dead end — nothing on
                  // this machine says how to start it, so a restore will move
                  // its window if it is open and skip it if it is not.
                  // "learn launch" is an offer: a command was derived and one
                  // click writes it. "launch cmd looks broken" is a warning
                  // about a command already in the file that cannot run (a
                  // whole command line quoted as one word, from before the
                  // quoting fix) — an offer too when a replacement was derived,
                  // which is what `launchRepairable` says and the colour shows.
                  Text {
                    id: rowLaunch
                    text: appRow.modelData.launchHint || ""
                    visible: text !== ""
                    width: visible ? implicitWidth : 0
                    color: appRow.modelData.launchRepairable ? Color.accent : root.faintForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.italic: true
                    anchors.right: rowWhere.left
                    anchors.rightMargin: rowLaunch.visible ? Style.space(8) : 0
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  // Where the app is, where it should be, and — since the
                  // verdict table — WHAT is wrong with it.
                  //
                  // The arrow alone said the same thing about every kind of
                  // drift: a window sitting in exactly the right place with its
                  // tabs the wrong way round got "ws 10 → DP-2 · ws 10", which
                  // reads as a contradiction rather than as a diagnosis. The
                  // mismatch phrase is the diagnosis, and when the last restore
                  // tried and was refused it carries the compositor's reason
                  // too (PanelModel.verdictLine).
                  //
                  // Capped and elided: a blocked reason can be a sentence, and
                  // the app's own name must not be squeezed out by it. The full
                  // text is in the tooltip.
                  Text {
                    id: rowWhere
                    readonly property string placement: appRow.modelData.drifted && appRow.modelData.driftTo
                      ? appRow.modelData.position + " → " + appRow.modelData.driftTo
                      : appRow.modelData.position
                    text: appRow.modelData.mismatch
                      ? rowWhere.placement + " · " + appRow.modelData.mismatch
                      : rowWhere.placement
                    color: (appRow.modelData.drifted || appRow.modelData.mismatch)
                      ? Color.accent : root.faintForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                    width: Math.min(implicitWidth, Math.round(appRow.width * 0.62))
                    horizontalAlignment: Text.AlignRight
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter

                    HoverHandler { id: rowWhereHover }

                    // The same multi-line story the chips tell, on the surface
                    // where the text is elided in the first place. Shown when
                    // it says MORE than the row already does — either because
                    // the placement was cut short, or because there are lines
                    // (the class, the drift arrow, the diagnosis) the row has
                    // no room for at all. A tooltip that only repeats what is
                    // already on screen teaches the user to stop hovering.
                    //
                    // rowTooltipText always leads with the app's name and the
                    // placement, both of which the row shows on its own — an
                    // indexOf("\n") check is therefore true unconditionally
                    // and cannot tell "more" from "the same". Check the actual
                    // extra content instead: the class (never on the row),
                    // the drift arrow (only implied by rowWhere's "→", not
                    // spelled out), or a diagnosis this app has.
                    PanelToolTip {
                      visible: rowWhereHover.hovered && appRow.tipText !== ""
                        && (rowWhere.truncated
                          || appRow.modelData.className !== ""
                          || (appRow.modelData.drifted && appRow.modelData.driftTo !== "")
                          || appRow.modelData.mismatch !== "")
                      text: appRow.tipText
                      fontFamily: root.fontFamily
                    }
                  }

                  // A row the panel cannot act on does not offer to be
                  // clicked: the "recorded · no longer watched" row has no
                  // pattern left to re-watch from (PanelModel.appRows explains
                  // why), and its predecessor's ticked box and dead click were
                  // the review finding this replaces.
                  MouseArea {
                    anchors.fill: parent
                    enabled: appRow.modelData.clickable !== false
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: root.toggleChip(appRow.modelData)
                  }

                  // Declared AFTER the row-wide area so it wins the click:
                  // pressing "learn launch" must not also untick the app.
                  MouseArea {
                    anchors.fill: rowLaunch
                    enabled: appRow.modelData.launchRepairable === true
                    visible: enabled
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.learnLaunchFor(appRow.modelData.identityId)
                  }

                  Rectangle {
                    anchors.bottom: parent.bottom
                    width: parent.width
                    height: 1
                    color: root.faintForeground
                    opacity: 0.25
                  }
                }
              }
            }

            // ---------------------------------------- failed restores (jzx)
            //
            // Between the list and the footer on purpose: it is a consequence of
            // the desktop above it and an argument for the button below it, and
            // a user who opens the panel because a toast said "restore failed"
            // finds it without reading nine rows to work out which two are red.
            //
            // Every word in it comes from `verdict.blockedBy` — the ledger of
            // what the last cycle attempted and how it went — so a line here and
            // the same app's row in the list can never disagree.
            Column {
              width: parent.width
              spacing: Style.space(4)
              visible: root.failedTitle !== "" && root.failedRows.length > 0

              PanelSeparator { foreground: root.foreground }

              Text {
                width: parent.width
                text: root.failedTitle
                color: Color.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                elide: Text.ElideRight
              }

              Repeater {
                model: root.failedRows

                delegate: Item {
                  id: failedRow
                  required property var modelData
                  width: parent.width
                  implicitHeight: Math.max(retryButton.implicitHeight,
                    failedText.implicitHeight + Style.space(4))

                  // The same cursor question the chips and the footer buttons
                  // ask, asked here for the same reason: this row's Retry is in
                  // the Tab chain now (tick wgj / finding F4), and a section the
                  // keyboard can reach has to SHOW where the keyboard is.
                  readonly property bool hasCursor: root.focusSection === "failed"
                    && root.failedCursorKey === failedRow.modelData.key

                  onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(failedRow)

                  Column {
                    id: failedText
                    anchors.left: parent.left
                    anchors.right: retryButton.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 0

                    Text {
                      width: parent.width
                      text: failedRow.modelData.instanceLabel
                        ? failedRow.modelData.name + " · " + failedRow.modelData.instanceLabel
                        : failedRow.modelData.name
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }

                    // The compositor's or the service's own words, wrapped
                    // rather than elided: a blocked reason is a sentence and it
                    // is the only thing on this row worth reading.
                    Text {
                      width: parent.width
                      text: failedRow.modelData.reason
                      color: root.dimForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      wrapMode: Text.WordWrap
                    }

                    // The one failure retrying cannot fix on its own. Said on
                    // the row and not only in the tooltip, because a user who
                    // presses Retry three times against a browser has been told
                    // nothing by a button that keeps looking willing.
                    Text {
                      width: parent.width
                      visible: failedRow.modelData.caveat !== ""
                      text: failedRow.modelData.caveat
                      color: Color.accent
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.italic: true
                      wrapMode: Text.WordWrap
                    }
                  }

                  // Retry is the WHOLE restore, and the tooltip says so. The
                  // restore is idempotent, so per-app scoping would reach the
                  // same desktop through a second planner nobody needs — the
                  // button's job is to say which failure the user is acting on.
                  Button {
                    id: retryButton
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.statusModel.restoring ? "Restoring…" : "Retry"
                    tooltipText: PanelModel.wrapTooltip(
                      PanelModel.retryTooltip(failedRow.modelData, root.statusModel.restoring),
                      root.footerTooltipColumns)
                    bordered: true
                    hasCursor: failedRow.hasCursor
                    enabled: !root.statusModel.restoring && !!root.recordedLayout
                    opacity: enabled ? 1.0 : 0.45
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.caption
                    onClicked: if (root.recordedLayout) root.restoreNow()
                  }
                }
              }
            }

            // ------------------------------------------------ footer
            PanelSeparator { foreground: root.foreground }

            Item {
              width: parent.width
              implicitHeight: Math.max(restoreButton.implicitHeight, recordButton.implicitHeight)

              Row {
                anchors.right: parent.right
                spacing: Style.spacing.controlGap

                // The repair action, and the only one in this panel that
                // appears and disappears: it exists exactly while there is a
                // watched app whose launch command is empty AND derivable.
                // Once pressed there is nothing left for it to do, so it goes.
                Button {
                  id: learnButton
                  visible: root.learnableLaunches > 0
                  text: PanelModel.learnLaunchLabel(root.learnableLaunches)
                  tooltipText: PanelModel.wrapTooltip(
                    PanelModel.learnLaunchTooltip(root.learnableLaunches),
                    root.footerTooltipColumns)
                  bordered: true
                  hasCursor: root.focusSection === "learn"
                  onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(learnButton)
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  onClicked: root.learnLaunches()
                }

                Button {
                  id: restoreButton
                  text: "Restore now"
                  tooltipText: PanelModel.wrapTooltip(
                    PanelModel.restoreTooltip(!!root.recordedLayout, root.topologyName),
                    root.footerTooltipColumns)
                  bordered: true
                  // The keyboard cursor is the panel's own, not Qt's focus
                  // chain: PanelKeyCatcher takes Tab before any child sees it,
                  // so a focusable button would advertise a focus ring it can
                  // never receive.
                  hasCursor: root.focusSection === "restore"
                  onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(restoreButton)
                  // Nothing recorded for this topology means nothing to
                  // restore; the sketch's empty state leaves Record as the
                  // only lit action.
                  enabled: !!root.recordedLayout
                  opacity: root.recordedLayout ? 1.0 : 0.45
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  onClicked: if (root.recordedLayout) root.restoreNow()
                }

                Button {
                  id: recordButton
                  text: PanelModel.recordLabel(root.watchedCount, root.topologyName)
                  // Says what pressing it will DO — including that it
                  // overwrites, and why it is dim when it is.
                  tooltipText: PanelModel.wrapTooltip(
                    PanelModel.recordTooltip(root.watchedCount, root.topologyName,
                      root.statusModel.restoring),
                    root.footerTooltipColumns)
                  bordered: true
                  hasCursor: root.focusSection === "record"
                  onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(recordButton)
                  // The primary action, and in the empty state the only
                  // emphasized one.
                  active: true
                  enabled: root.canRecord
                  opacity: root.canRecord ? 1.0 : 0.45
                  foreground: root.foreground
                  accent: Color.accent
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  onClicked: root.recordLayout()
                }

                // The safety net Record's tooltip promises, drawn right beside
                // it and appearing only when there is something to undo. It is
                // ONE-SHOT and in memory: pressing it uses the stash up, and
                // closing the panel drops it.
                //
                // Its LABEL changes with what it will do, because the first
                // recording for a topology has no previous layout to put back
                // and undoing it means forgetting — a different act, and one the
                // user has to be told about before they press it.
                Button {
                  id: undoButton
                  visible: root.canUndoRecord
                  text: PanelModel.undoRecordLabel(root.recordUndo)
                  tooltipText: PanelModel.wrapTooltip(
                    PanelModel.undoRecordTooltip(root.recordUndo, root.topologyName),
                    root.footerTooltipColumns)
                  bordered: true
                  hasCursor: root.focusSection === "undo"
                  onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(undoButton)
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  onClicked: root.undoRecord()
                }
              }
            }
          }
        }
      }
    }
  }
}
