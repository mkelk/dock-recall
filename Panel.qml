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
// QtQuick.Shapes left with the map's chip slots (MapWorkspace.qml): the ghost's
// dashed outline was the only Shape this file ever drew.
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

  // Every duration and curve this panel and its children animate with, from the
  // plugin's one statement of them. MapWorkspace reads it through `panel.motion`
  // — the same single-site rule the guard in tests/qml-plaintext.test.js keeps.
  readonly property Motion motion: Motion {}

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

  // WHERE THE PICTURES GO, and it is a CACHE and not state (tick sz6). A cache
  // is a directory a cleaner is allowed to wipe, and the correct behaviour when
  // it does is that the Recorded map falls back to icons — so nothing here ever
  // joins the atomic state write, and the README's "writes one state file"
  // promise survives a feature that writes pixels of the screen to disk.
  //
  // XDG_CACHE_HOME first, because a user who has moved their cache has moved it
  // for a reason (a tmpfs, a different disk) and a plugin that ignored the
  // variable would be the one thing still writing to ~/.cache.
  readonly property string cacheHome: {
    var xdg = String(Quickshell.env("XDG_CACHE_HOME") || "")
    return xdg ? xdg : root.home + "/.cache"
  }
  readonly property string captureDir: root.cacheHome + "/omarchy/dock-recall"

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

  // Which watched apps have a window on screen. Pure since tick v29: the loop
  // that used to live here deduped on a bare `{}` keyed by identity id, so an
  // app whose class is `Constructor` (id `constructor`) was discarded as a
  // duplicate the first time it was seen and its chip read "not running" with
  // the window right there.
  readonly property var runningIdentityIds:
    Engine.runningIdentityIds(root.liveClients, root.identities)

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
  readonly property string recordHint: PanelModel.recordBlockedHint(
    root.statusModel.restoring, captureStore.busy)
  // An identity that matches windows on this desk and wins none of them —
  // every one taken by an identity earlier in the list. It has no row of its
  // own to say so on (its windows are listed under the identity that took
  // them), so the reason goes here, next to the other two hints. Empty on a
  // healthy list. See engine.shadowedIdentities for what counts as shadowed
  // and, just as importantly, what does not.
  readonly property string shadowHint: PanelModel.shadowedIdentityHint(
    Engine.shadowedIdentities(root.liveClients, root.identities))

  // Why the state file cannot be written, when it cannot: a file from a newer
  // schema is read and shown, but never written back (StateModel.writeRefusal
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

  // And why nothing will be RESTORED from it either (tick t03). The same
  // question with the other consequence: the same file the panel may not write
  // is also one the service may not act on, because the fields a newer schema
  // used to narrow an identity are stripped on the way in. Said next to the
  // read-only line, because a user who only reads "read-only" will reasonably
  // expect their dock to keep putting windows back.
  readonly property string restoreRefusalReason: {
    var refusal = root.stateLoaded ? StateModel.restoreRefusal(root.stateModel) : null
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

  // The last PUBLISHED value of each, serialized (tick zkb).
  //
  // The /proc read lands roughly every four seconds while the panel is open —
  // a terminal's answer expires after 3 s by design, because what runs inside
  // one changes under a stable pid. Both maps were then reassigned whatever
  // came back, and QML notices an assignment, not a difference: the entire
  // derivation chain downstream of them re-evaluated on every read, almost
  // always to the identical answer. The READ is unchanged and still expires;
  // only a changed answer is published.
  //
  // Serialized rather than deep-compared because these are plain JSON-shaped
  // maps built the same way every time, so equal content serializes equally.
  // A false "changed" costs exactly what every read used to cost.
  property string argvByPidText: "{}"
  property string procTreeText: "{}"

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

  // -------------------------------------------------------------------- icons
  //
  // A chip that is an outlined rectangle with a truncated word in it makes three
  // terminals three identical boxes. The icon is what tells them apart at a
  // glance, and it is the one thing the desktop already knows about every app.
  //
  // TWO HALVES, and the split is the architectural rule. Which desktop entry
  // describes this app, and what NAME it gives its icon, is a fact about the
  // files on disk: pure, testable, PanelModel's (iconNameIndex). Turning that
  // name into something an Image can draw is the shell's, through
  // shell.appLibrary.iconSource — only the shell knows the icon theme, and only
  // it keeps the contextual app/device index that stops a name like "zoom"
  // resolving to an action icon instead of the app. We do not reimplement
  // either half.
  readonly property var appLibrary: root.shell ? root.shell.appLibrary : null

  // The generic executable icon, resolved through the same call every real icon
  // goes through. iconSource NEVER answers empty — it falls back to
  // application-x-executable — so "did this resolve?" cannot be asked of the
  // source alone, and this is what it is compared against.
  //
  // An empty name is the shortest way to ask for exactly that fallback (see
  // AppLibrary.iconSource's first line). If the theme has no such icon either,
  // this is "" and every unresolved chip's source is "" too, so the two still
  // agree — the panel then draws nothing rather than a wrong picture, and still
  // reports iconResolved false.
  //
  // The honest limit: an app whose desktop entry really does say
  // `Icon=application-x-executable` reports unresolved. It is drawing the
  // generic icon, which is what the flag is about.
  readonly property string genericIconSource: root.appLibrary
    ? String(root.appLibrary.iconSource("")) : ""

  // identity id / window class -> icon NAME, for the whole panel frame. One
  // pass over the desktop dump rather than one per chip; see
  // PanelModel.iconNameIndex.
  //
  // NOT bound on `liveClients`, and that is the point. liveClients is
  // reassigned whenever the TEXT of `hyprctl clients -j` differs, and that JSON
  // carries window titles — so on a desk where anything at all is happening it
  // is a new array on most 2 s ticks, with the same window classes in it. Bound
  // directly, this rebuilt the whole index (158 desktop files parsed, four
  // passes per key) on the GUI thread, in the same pass that rebuilds the map,
  // and handed every chip a new object to re-resolve its icon from.
  //
  // So the dependency is the CLASS KEY — a string, which notifies only when its
  // value differs — and the clients themselves are snapshotted when it does. A
  // window opening under a class the panel has not seen changes the key and
  // rebuilds the index; a browser retitling itself does neither.
  readonly property string iconClassKey: PanelModel.clientClassKey(root.liveClients)
  property var iconClients: []
  onIconClassKeyChanged: root.iconClients = root.liveClients
  readonly property var iconNames: PanelModel.iconNameIndex(
    root.identities, root.iconClients, root.desktopFiles)

  // ------------------------------------------- when this layout was recorded
  //
  // The clock the age is measured against, refreshed with the desk (see
  // root.refresh). Not a binding on Date.now() — that would never re-evaluate.
  property double nowMs: Date.now()

  // "recorded 3 days ago", from the RECORDING's own timestamp and never from a
  // file mtime. WHY not the mtime, and what ABSENT means beside null, are both
  // in the payload contract's one normative place: tests/acceptance/README.md,
  // "Absent vs `null` — the normative statement".
  //
  // "" here for a recording that carries no timestamp AND for no recording at
  // all — the header has nothing to say in either case; the payload is what
  // keeps the two apart.
  readonly property string recordedAgeLabel: root.recordedLayout
    ? PanelModel.recordedAgeLabel(root.recordedLayout.recordedAt, root.nowMs) : ""

  // The workspace in front of the user, as a monitor-qualified key. Computed
  // once per frame off the monitor read rather than per badge — see
  // PanelModel.focusedWorkspaceKey for why only the focused monitor has one.
  readonly property string focusedWorkspaceKey: PanelModel.focusedWorkspaceKey(root.liveMonitors)

  function iconNameOf(identityId, className) {
    return PanelModel.iconNameFor(root.iconNames, identityId, className)
  }

  // What an Image should draw for this app. Always something: a name that
  // resolves, or the generic executable icon.
  function iconSourceOf(identityId, className) {
    if (!root.appLibrary) return ""
    return String(root.appLibrary.iconSource(root.iconNameOf(identityId, className)))
  }

  // Did the app's own icon resolve, or is this the generic executable fallback?
  // Reported per chip and per row, because "every watched app shows its icon"
  // is not a claim a non-empty source can support on its own.
  function iconResolvedOf(identityId, className) {
    var source = root.iconSourceOf(identityId, className)
    if (!source) return false
    return source !== root.genericIconSource
  }

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
    // The first-Record dialogue owns Tab as well as the arrows (tick y28). It is
    // a question the panel is waiting on an answer to, so Tab walks the three
    // answers rather than leaving them: a Tab that stepped out of the prompt
    // would leave a modal surface up with the cursor somewhere behind it, and
    // Escape is the way out that exists on purpose.
    if (root.consentOpen) {
      root.moveConsentCursor(direction)
      return
    }
    root.focusSection = PanelModel.nextSection(root.focusOrder, root.focusSection, direction)
    if (root.focusSection === "chips" && !root.currentChip) root.moveChipCursor(1)
    if (root.focusSection === "failed" && !root.currentFailedRow) root.moveFailedCursor(1)
  }

  function handleMove(dx, dy) {
    // THE PROMPT IS CHECKED FIRST, before even the menu (tick y28). It is the
    // panel's only true modal — a question with the keyboard and a scrim over
    // everything behind it — and the arrows walking the map underneath would
    // move a cursor nobody can see, on a surface nobody can click. Horizontal
    // first, because the answers are a row.
    if (root.consentOpen) {
      root.moveConsentCursor(dx !== 0 ? dx : dy)
      return
    }
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
    // The prompt first, for the reason handleMove checks it first: while it is
    // up, Enter and Space belong to the answer under the cursor and to nothing
    // behind it.
    if (root.consentOpen) {
      root.activateConsent()
      return
    }
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
      if (root.canRestore) root.restoreNow()
      return
    }
    // Enter/Space on a failed row IS its Retry button, and Retry is the whole
    // restore — the same call the pointer makes, under the same guards the
    // button carries (`enabled`), so the keyboard cannot start a second cycle
    // over a running one, a restore with nothing recorded, or one from an inert
    // state file.
    if (root.focusSection === "failed") {
      if (root.canRestore && !root.statusModel.restoring) root.restoreNow()
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
    // here, so a summon cannot build a tick on a stale picture of the desk.
    //
    // This used to say "the panel object outlives open and close" (tick md1).
    // IT DOES NOT — the shell destroys the panel's Loader on hide, and two
    // things in this epic's blast radius depend on that as load-bearing fact:
    // CaptureStore's "the pictures die with the panel, because this component
    // does", and the acceptance suite's deleted-capture round, which is asserted
    // on a FRESH panel for exactly that reason. So on the ordinary path these
    // two resets find nothing to reset. They stay because a panel that is
    // summoned again WITHOUT having been destroyed (a re-summon of an open one,
    // with a different focusRequest) is the path where they do work, and because
    // "opens holding nothing" is cheaper to guarantee than to reason about.
    root.refusedTick = null
    root.forgetProcReads()

    root.refresh()
    root.refreshDerivations()
    // The shell's icon index is built once at startup and never re-scans on its
    // own, so an app installed since then has no icon until somebody asks. The
    // menu asks when it opens; so do we, for the same reason and at the same
    // moment — this is a rescan of the theme directories, not of our own state.
    if (root.appLibrary && typeof root.appLibrary.refreshIcons === "function") {
      root.appLibrary.refreshIcons()
    }
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
    // The clock, sampled where the panel already samples the desk. PanelModel
    // is clock-free by rule, so every age it computes is an age against a
    // number this side hands it — and putting the sample HERE is what makes the
    // Recorded tab's "recorded 3 days ago" tick over on the same 2 s beat as
    // everything else, rather than freezing at whatever it read when the panel
    // opened.
    root.nowMs = Date.now()
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
    // full text of every desktop file on the machine is a megabyte of
    // translated comments this never reads.
    //
    // `Icon=` is in the list because parseDesktopEntry retains it and the chips
    // and rows draw it. Anchored and unsuffixed like every other key here, so
    // `Icon[de]=` is not even shipped — parseDesktopEntry would ignore it
    // anyway, by the same rule it applies to `Name[de]`.
    + ' grep -E "^(\\[|Exec=|StartupWMClass=|Type=|Hidden=|Name=|Icon=)" "$f" || true;'
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
    // The published-value shadows go with them, or the next read would compare
    // against an hour-old picture and decline to publish the fresh one.
    root.argvByPidText = "{}"
    root.procTreeText = "{}"
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
      // Published only if it actually differs — see argvByPidText.
      var mergedText = JSON.stringify(merged)
      if (mergedText !== root.argvByPidText) {
        root.argvByPidText = mergedText
        root.argvByPid = merged
      }

      var freshTree = PanelModel.procTreeFromDump(text)
      var mergedTree = ({})
      for (var seen in root.procTree) {
        if (!asked[seen]) mergedTree[seen] = root.procTree[seen]
      }
      for (var root_pid in freshTree) mergedTree[root_pid] = freshTree[root_pid]
      var mergedTreeText = JSON.stringify(mergedTree)
      if (mergedTreeText !== root.procTreeText) {
        root.procTreeText = mergedTreeText
        root.procTree = mergedTree
      }

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

  // THE WRITE BLOCKS, AND THAT IS THE WHOLE POINT (tick m4s).
  //
  // `setText` schedules an asynchronous write job by default, so `writeState`
  // returned true — and `recordLayout` returned true, and the IPC answered
  // "recorded", and the Undo button armed — while the bytes on disk were still
  // the previous file. The acceptance VM caught it: `record` answered
  // "recorded" and a `jq` in the next process saw no layout at all.
  //
  // That is not merely an honesty problem. `freshState()` below re-reads this
  // file SYNCHRONOUSLY (`blockAllReads`) and five functions rewrite the WHOLE
  // file from what it returns — setPaused, setPicturedFor, undoRecord,
  // answerConsent, forgetLayout. Two of those are, by design, the next thing
  // the user does after a Record: Undo is armed by the record itself, and the
  // consent prompt appears BECAUSE of it. With the write still in flight, the
  // re-read hands back pre-record bytes and the rewrite files them back over
  // the recording — or the in-flight write lands afterwards and erases the
  // consent answer. Either way somebody's layout or somebody's answer is gone,
  // and nothing logs it.
  //
  // So the write is made blocking rather than the readers made to wait. The
  // file is a few KB and this is the panel's own click path; every comment in
  // this file that already calls the record "a single atomic write" becomes
  // true instead of nearly true.
  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    blockWrites: true
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

  // ------------------------------------------------------ the picture cache
  //
  // Everything about a stored picture that is not a pure decision lives in
  // CaptureStore.qml; the names and the plan are PanelModel's. This is the
  // instance and the four questions the panel asks it.
  //
  // Its host window is mapped for as long as the PANEL is, not for as long as a
  // capture is in flight: a window that has just become visible has not been
  // exposed yet, and a grab on an unexposed window fails in a way nothing can
  // tell from a compositor declining. It is 1x1, transparent, on the background
  // layer, and excluded from every reservation, so "mapped" costs a surface and
  // no pixels.
  CaptureStore {
    id: captureStore
    cacheDir: root.captureDir
    logPrefix: root.logPrefix
    hostScreen: root.focusedScreen
    hostMapped: root.opened
  }

  // The picture this (identity, occurrence) would have for the CURRENT
  // topology, or "" when the cache does not hold one.
  //
  // Gated on the listing rather than on the file simply being nameable: an
  // Image pointed at a path that is not there draws nothing and reports a
  // source anyway, and "the panel says it has a picture" has to mean the cache
  // does.
  //
  // THE LISTING IS PASSED IN, and that is what makes every chip's picture
  // refresh after an eviction (tick md1). A QML binding re-evaluates when a
  // property it READ changes, and `captureStore.files` read inside the store's
  // own `has()` is invisible at this call site. It used to be declared by a
  // `if (captureStore.generation < 0) return ""` — a branch that can never be
  // true, whose only job was to register the dependency, and which nothing
  // pinned: a future tidy-up deleting an obviously-dead line would silently stop
  // every chip refreshing, with no test failure and no visible error. Handing
  // `captureStore.files` to `hasIn` cannot be tidied away, because without it
  // there is no listing to look in.
  //
  // AND GATED ON THE CAMERA (tick sp7). Withdrawing a camera — the row's button,
  // "Not for these apps", or unticking the app — deletes that identity's
  // pictures on every desk, but a `find` is a process and a listing is another,
  // and until both have come back `captureStore.has()` still answers yes. Two
  // frames of the photograph a user has just withdrawn is exactly the moment
  // this feature must not have, so the gate is `pictured` and the delete is what
  // makes it true on disk as well as on screen.
  //
  // It also covers the case no eviction can: a recorded-but-unwatched ghost has
  // no identity in the file at all, so it has no camera, so it draws no picture.
  function captureFileFor(identityId, occurrence) {
    if (!identityId || !root.topologyKey) return ""
    if (!root.picturedOf(identityId)) return ""
    var name = PanelModel.captureFileName(identityId, occurrence, root.topologyKey)
    return captureStore.hasIn(captureStore.files, name) ? name : ""
  }

  function capturePathFor(identityId, occurrence) {
    var name = root.captureFileFor(identityId, occurrence)
    return name ? captureStore.pathFor(name) : ""
  }

  // The same picture as a URL an Image can be bound to, or "" (tick vbh).
  //
  // Util.fileUrl, not a hand-built "file://" + path: it percent-encodes each
  // segment, and a home directory with a space in it is the ordinary case that
  // breaks the hand-built one. The panel already resolves its icon paths this
  // way (AppLibrary.iconSource), so the map has one spelling of "a local file"
  // rather than two.
  //
  // ONLY ON THE RECORDED MAP, for the reason capturePathFor's payload half is:
  // the cache key is the recording's, and the Live tab draws the windows that
  // are on screen. A photograph of a window laid over the window itself is a
  // second, staler picture of the same thing.
  function captureSourceOf(identityId, occurrence) {
    if (!root.showRecorded) return ""
    var path = root.capturePathFor(identityId, occurrence)
    return path ? Util.fileUrl(path) : ""
  }

  // Re-read the directory when the panel opens: a cleaner may have run since it
  // was last up, and the listing is what tells "there is a picture for this
  // chip" from "there was one". The other re-read is on a topology change, and
  // it lives in the existing onTopologyKeyChanged below rather than in a second
  // handler — QML allows only one per signal per object.
  onOpenedChanged: if (root.opened) captureStore.refresh()

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
  //
  // It also dies with its window (tick 8rw). The re-ask alone could not do
  // that: it resolves through PanelModel.clientForTick, whose class fallback
  // would re-derive the hint against a DIFFERENT foot window, or — with no
  // window of the class left — leave the reason at "not-read" and offer "press
  // it again in a moment" forever about a terminal that is closed.
  property var refusedTick: null

  // The one moment a refused window can have gone away is the moment a fresh
  // client list lands, so that is where the question is asked. A signal handler
  // and not a binding: this CLEARS state rather than deriving any, and a
  // binding that wrote to its own dependency's neighbour would be the harder
  // thing to reason about.
  onLiveClientsChanged: {
    if (root.refusedTick && !PanelModel.refusalStillLive(root.liveClients, root.refusedTick)) {
      root.log("the window that refused a tick (\"" + root.refusedTick.className
        + "\") is gone — clearing the refusal")
      root.refusedTick = null
    }
  }

  readonly property string tickRefusalHint: {
    var pending = root.refusedTick
    if (!pending) return ""
    // Belt to the handler's braces (tick 8rw): the clear above is what removes
    // the state, and this is what keeps a sentence about a closed window off
    // the screen in whatever frame sits between the two.
    if (!PanelModel.refusalStillLive(root.liveClients, pending)) return ""
    // Referenced so the hint re-evaluates when either read lands.
    var argv = root.argvByPid
    var tree = root.procTree
    var reason = PanelModel.tickRefusalReason(pending.className, root.identities,
      root.tickDerivationFor(pending.address, pending.className))
    return PanelModel.tickRefusalHint(pending.className, reason)
  }

  // A watched TITLE identity whose class is on screen and which still matches
  // nothing, and — for a terminal — the exact command that would fix it.
  // Evidence-based and self-clearing, like shadowHint: it is gone the moment a
  // window matches.
  //
  // Since tick s7l this covers a hand-authored non-terminal title identity too
  // (`^chromium$` + `^Gmail$`), with a sentence that names its title patterns
  // instead of claiming a `--title` relaunch it has no convention for. The
  // inputs are unchanged: the same client list, identity list and matcher this
  // binding has always supplied.
  readonly property string untitledHint: {
    var list = root.identities
    return PanelModel.awaitingTitleHint(root.liveClients, list,
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

    // ONE question, asked once (tick zkb). This used to ask suggestIdentity
    // twice — through tickRefusalReason and again inside
    // toggleWatchedIdentities — and then diff the two lists with addedIdentity
    // to recover the identity the second call had already built. tickOutcome
    // answers all three at once: whether to refuse, what to write, and what
    // was added.
    var outcome = PanelModel.tickOutcome(root.identities, chip.className, chip.identityId,
      derivation, Engine.couldShadow)

    // A tick that cannot produce a working identity says so rather than writing
    // the `^foot$` catch-all (tick gpq). The reason is kept, not the sentence:
    // the hint re-asks the question every frame and clears itself.
    var refusal = chip.identityId ? "" : outcome.refusal
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

    var next = outcome.identities

    // DERIVE BEFORE THE WRITE (tick i07). A tick creates an identity with an
    // empty launch, and "" means never start this one — so if the panel can
    // already answer for the app in front of it (its .desktop file is in the
    // scan, or its argv is in the cmdline map), the launch goes into the SAME
    // write. When it cannot, the empty write still happens instantly, and the
    // scan this call kicks off fills it in through autoFillLaunches.
    var added = outcome.added
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
      // Name the identity the write actually created (tick l97), not the class
      // that was clicked — a title identity (foot hosting btop) creates an id
      // unrelated to the class ticked, and even the ordinary case (ticking
      // md.obsidian.Obsidian creates id "obsidian") reads clearer this way.
      //
      // THE SUCCESS LINE IS FOR A LIST THAT CHANGED (tick v5c). It used to fall
      // back to `chip.className` when `added` was null, which is how a duplicate
      // tick came to log `watching "foot" — 3 identities` about an identity
      // nobody created: the refusal above now catches that case, and this branch
      // is the belt to its braces. A byte-identical write returns true, so
      // "the write succeeded" has never been the same claim as "something
      // changed", and only `added` can tell them apart.
      if (chip.identityId) {
        // UNWATCHING TAKES THE PICTURES WITH IT (tick sp7), on every desk.
        //
        // The README has always promised "Unticking an app takes its camera
        // consent with it", and until this tick it took the FLAG: the identity
        // went, and with it the `pictured` field that lived on it — but the
        // photographs stayed, the recorded map's ghost chip went on rendering
        // them, and there was no longer even a camera button to press. This is
        // the harder half of the same promise, and the one a user would actually
        // check.
        //
        // AFTER the write, like every other eviction in this file: a refused
        // write must not take the pictures with it.
        captureStore.evictIdentities([chip.identityId], "unwatched")
        root.log("unwatched \"" + chip.identityId + "\" — " + next.length + " identities;"
          + " its stored pictures are deleted, on every desk")
      } else if (added) {
        root.log("watching \"" + added.id + "\" — " + next.length + " identities"
          + (inlineLaunch ? " (launch derived in the same write: " + inlineLaunch + ")" : ""))
      } else {
        root.log("no change: the tick on \"" + chip.className
          + "\" added nothing — the watched list still has " + next.length + " identities")
      }
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
  // something the button would have refused: PanelModel.singleLaunchRepair
  // filters the derivation map to this one identity and the backfill decides
  // whether the stored value may be replaced.
  //
  // The lookup used to be `root.derivedLaunch[identityId]` right here, and for
  // the id `constructor` on a KEY MISS — which is exactly when a row offers a
  // repair — a bare bracket lookup answers with the `Object` constructor rather
  // than undefined. `if (!command)` let it past, and the state file gained
  // `"launch": "function Object() { [native code] }"` (tick tnm). Both halves of
  // the answer are pure now: the guarded lookup and the check on the value.
  function learnLaunchFor(identityId) {
    var one = PanelModel.singleLaunchRepair(root.derivedLaunch, identityId)
    if (!one) return
    if (!PanelModel.learnableCount(root.identities, one)) return
    if (root.writeState(StateModel.setIdentities(root.stateModel,
        PanelModel.backfillLaunchCommands(root.identities, one)))) {
      root.log("learned launch for \"" + identityId + "\": " + PanelModel.own(one, identityId))
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

  // -------------------------------------------- the second consent (tick qnc)
  //
  // WATCHED IS NOT PICTURED. Watching an app means the tool may MOVE its
  // windows; picturing it means the tool may PHOTOGRAPH them and keep the
  // picture on disk. Someone who wants their password manager put back on the
  // right workspace has not agreed to have it photographed mid-reveal, so the
  // two are separate grants and the second one defaults OFF (schema v5 —
  // StateModel.normalizeIdentity materializes `pictured: false` on every
  // identity through every door, so nothing here ever has to tell absent from
  // withheld).
  //
  // WHERE THE AFFORDANCE LIVES: the app LIST, one camera button per row, and
  // not the map. The map is already the control surface for the first tick — a
  // chip click watches or unwatches — and a second consent on the same surface
  // would have to be a modifier-click or a second hit zone inside a rectangle
  // that is 16×10 px at its floor. Both are invisible, and an invisible
  // affordance for a privacy decision is the wrong kind of clever. The list is
  // where the panel already keeps its PER-APP facts (the watched switch, the
  // launch hint and its own separate click target, the placement), so the
  // second per-app fact belongs beside them, with the same grammar: a small
  // control that is not the row's toggle, clicked on its own.
  //
  // Only a WATCHED identity can be pictured, and that is not a UI restriction
  // but the shape of the data: `pictured` is a field ON an identity, and an
  // identity exists exactly while the app is watched. So an unwatched row and
  // an orphaned recorded ghost offer no camera at all rather than one that
  // writes nowhere.

  function picturedOf(identityId) {
    return StateModel.isPictured(root.stateModel, identityId)
  }

  // Is there anything for a camera on this row to write to? An identity id
  // that names a WATCHED identity — the recorded-but-unwatched ghost carries an
  // id too, and it is an id the file no longer has.
  function picturableOf(identityId) {
    if (!identityId) return false
    return StateModel.identityById(root.stateModel, identityId) !== null
  }

  // Grant or withdraw it, with the discipline setPaused established: a FRESH
  // read (this rewrites the whole file, which also carries every layout), the
  // adopt-what-the-file-says branch when somebody got there first, the
  // StateModel setter that touches one field, and a success line gated on
  // writeState's boolean — a refused write must not log a consent it did not
  // record.
  function setPicturedFor(identityId, want) {
    if (!identityId) return
    var fresh = root.freshState()
    if (!fresh) return

    var identity = StateModel.identityById(fresh, identityId)
    if (!identity) {
      root.warn("cannot picture \"" + identityId + "\": it is not on the watched list — "
        + "click its live window to watch it first")
      return
    }
    if ((identity.pictured === true) === (want === true)) {
      // Somebody got there first (a second panel, a hand edit). The user's
      // intent is already the file's content; adopt it rather than writing it
      // again, exactly as the pause toggle does.
      root.stateModel = fresh
      return
    }
    if (!root.writeState(StateModel.setPictured(fresh, identityId, want === true))) return
    // SWITCHING A CAMERA OFF DELETES THE PICTURES (tick sp7), on every desk, and
    // AFTER the write like every other eviction here.
    //
    // Until this tick it deleted nothing at all: the flag was written, the log
    // said "Record will store no picture of it" — true about the FUTURE only —
    // and the photographs already on disk stayed, with the Recorded map going on
    // drawing them until some unrelated act happened to clear their prefix.
    // Per-app withdrawal was absent from the whole eviction set. A camera is the
    // control this feature gives a user over their own pictures; a control that
    // only governs the next one is not that control.
    //
    // The map stops drawing them in the same instant rather than when the
    // listing comes back — captureFileFor is gated on `pictured` — so the delete
    // being asynchronous is not a window in which the user still sees what they
    // just withdrew.
    if (want !== true) captureStore.evictIdentities([identityId], "camera switched off")
    root.log(want === true
      ? "picturing \"" + identityId + "\" — Record will store a picture of its windows"
      : "no longer picturing \"" + identityId + "\" — its stored pictures are deleted,"
        + " on every desk, and Record will store no more")
  }

  // The flip. Computed against the panel's copy and re-checked against the file
  // inside setPicturedFor, which is what makes a stale copy adopt rather than
  // write the wrong way round.
  function togglePictured(identityId) {
    root.setPicturedFor(identityId, !root.picturedOf(identityId))
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
    // A different desk is a different capture prefix, so every chip's answer to
    // "do I have a picture" changed with it.
    captureStore.refresh()
  }

  // Returns whether the file now holds what the undo asked for, so the IPC and
  // any later caller can tell a performed undo from a refused one.
  function undoRecord() {
    if (!root.canUndoRecord) return false
    var stash = root.recordUndo
    // Same read-modify-write discipline as the pause toggle, and for the same
    // reason: this rewrites the whole file from an object that also carries
    // every OTHER topology's layout, so a copy that went stale while the panel
    // sat open would file yesterday's recordings alongside today's undo.
    var fresh = root.freshState()
    if (!fresh) return false

    // Cleared FIRST, and unconditionally: this is a one-shot: pressing it twice
    // must not put the same layout back twice, and a write that fails is not a
    // reason to keep offering an undo of a record the file may no longer hold.
    root.recordUndo = null

    // The slot is shared with Forget (tick gwa), and the log line names the act
    // it is undoing: a line reading "undid the record" after a Forget describes
    // a click the user never made.
    var act = PanelModel.undoStashAction(stash) === "forget" ? "forget" : "record"

    // THE PICTURES FOLLOW THE LAYOUT, in both branches (tick sz6). The files on
    // disk belong to the record this press is undoing, and the layout being put
    // back is one whose own pictures were overwritten the moment that record
    // ran. Leaving them would draw photographs of windows at positions the
    // restored recording does not describe — a picture that lies about the
    // layout it sits next to is worse than no picture, and "no picture" is a
    // state this feature is built to degrade into gracefully.
    //
    // So an undone re-record leaves the previous LAYOUT restored and picture-
    // less, and the map falls back to icons until the next Record. That is the
    // honest limit of a one-shot undo over an overwrite-in-place cache: the
    // pixels the previous record took are already gone, and this cannot invent
    // them. Stated here rather than discovered later.
    captureStore.evict(PanelModel.captureTopologyPrefix(stash.topologyKey), "undone")

    if (PanelModel.recordUndoRestores(stash)) {
      if (!root.writeState(StateModel.upsertLayout(fresh, stash.previousLayout))) return false
      root.log("undid the " + act + " for topology \"" + stash.topologyKey + "\" — put back the layout"
        + " recorded at " + (stash.previousLayout.recordedAt || "an unknown time")
        + " (" + (stash.previousLayout.apps || []).length + " apps)")
      return true
    }
    if (!root.writeState(StateModel.removeLayout(fresh, stash.topologyKey))) return false
    root.log("undid the " + act + " for topology \"" + stash.topologyKey + "\" — this setup had no"
      + " layout before it, so it has none again")
    return true
  }

  // Returns whether a layout was written, so the IPC can tell a record from a
  // refusal. The capture round below is NOT part of that answer: a Record whose
  // pictures all failed is still a good record.
  function recordLayout() {
    if (!root.canRecord) return false
    // ONE WINDOW INDEX, TWO USES (tick 3xi). `chosen` numbers every watched
    // identity's windows in placement order, and it is what makes "occurrence 1"
    // mean a particular window. The layout is built from it and the pictures are
    // taken of it, so both are talking about the same desk read at the same
    // instant. Computing it twice — which is what the capture used to do, a
    // Qt.callLater turn later and over the LIVE client list — is the one way a
    // picture can be filed under a correct key and be of a different window.
    var chosen = Engine.chosenWindows(root.liveClients, root.identities, root.liveMonitors)
    var layout = Engine.buildLayout(root.liveClients, root.liveMonitors, root.identities,
      new Date().toISOString(), chosen)
    if (!layout.topologyKey) {
      root.warn("record refused: the monitor list resolves to no topology at all")
      return false
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
    if (!root.writeState(StateModel.upsertLayout(base, layout))) return false
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

    // THE PICTURES, LAST AND OFF THIS STACK (tick sz6).
    //
    // A SCREENSHOT MUST NEVER BE ABLE TO FAIL A RECORD, and this is where that
    // is enforced rather than intended. Three things make it true:
    //
    //   · it is reached only through the success path — every `return false`
    //     above is before it, and the layout is on disk by the time it runs;
    //   · it is the LAST statement, so the write, the undo stash and every log
    //     line this function owes the user are already done;
    //   · Qt.callLater puts it in a LATER event-loop turn, so recordLayout has
    //     returned true to its caller before any capture code executes at all.
    //     Nothing the store can do — an exception, a hung compositor, a full
    //     disk — is on the recording's stack any more.
    //
    // The store never writes the state file, so there is no path from a failed
    // picture back to the recording either.
    Qt.callLater(function () { root.captureAfterRecord(layout, chosen) })
    return true
  }

  // Take the pictures the layout just committed asks for.
  //
  // THE WINDOW EACH PICTURE IS OF IS HANDED IN (tick 3xi). `chosen` is the very
  // index recordLayout built this layout from — the same object, not a second
  // computation — so a file stored under occurrence 1 is a photograph of the
  // window the recording calls occurrence 1.
  //
  // It used to call Engine.chosenWindows again right here, under a comment
  // claiming that was "the same index buildLayout numbered the occurrences with,
  // computed from the same clients and monitors". It was not. buildLayout
  // computed its index privately and did not return it, and this call ran a
  // Qt.callLater turn later, over the LIVE `root.liveClients` property, with
  // nothing making the two agree. That is the one place a capture can be filed
  // under a CORRECT key and be a photograph of a DIFFERENT window — the DoD's
  // "keyed on identity, occurrence and topology" passes unchanged, and no map
  // could ever show it.
  //
  // No index, no pictures. Building one here would be exactly the second opinion
  // this tick removed, and this codebase refuses rather than guesses.
  //
  // Consent is read from the identities, one `pictured === true` at a time, and
  // an app that has withheld it is `skipped` rather than merely absent, so the
  // log can say how many pictures were NOT taken as well as how many were.
  function captureAfterRecord(layout, chosen) {
    if (!chosen) {
      root.warn("this recording came with no window index, so no pictures were taken — a"
        + " picture whose window was matched a second time could be of a different window")
      return
    }
    var plan = PanelModel.capturePlan(layout, root.identities, chosen)
    if (!plan.captures.length) {
      // Still an eviction: a re-record with the consent since withdrawn has to
      // drop the pictures the previous record took, or the map would go on
      // showing photographs the user has asked it to stop taking.
      captureStore.evict(plan.prefix, "re-recorded")
      if (plan.skipped.length) {
        root.log("no pictures for this recording — " + PanelModel.captureLogLine(plan, []))
      }
      return
    }
    captureStore.capture(plan, function (results) {
      root.log(PanelModel.captureLogLine(plan, results))
      // THE CONSENT MOMENT, and this is where it belongs: the round has
      // finished, so the pictures the prompt is about are on disk and can be
      // shown. Asking before the round would mean asking about photographs
      // nobody has seen, which is the warning label this feature deliberately
      // is not (tick y28).
      root.offerConsent(results)
    })
  }

  // ----------------------------------------- the first-Record dialogue (y28)
  //
  // THE HUMAN'S DECISION, IN FULL: at the first Record with picturable apps the
  // panel shows THE CAPTURES JUST TAKEN and offers exactly three answers — Keep
  // pictures / Not for these apps / No pictures — and the answer survives a
  // shell restart. Asked ONCE.
  //
  // WHY IT SHOWS THE PICTURES. It is an onboarding moment that demonstrates the
  // feature, not a warning label. A sentence about photographs of your windows
  // is a scary abstraction; three photographs of your own windows is a thing you
  // can look at and have an opinion about. That framing is why this shows the
  // captures rather than describing them, and it is why it happens AFTER the
  // round rather than before it — there is no honest way to show somebody their
  // own captures before taking them, and the per-app camera is what authorised
  // taking them in the first place. What this adds is the chance to say the
  // result is not what they wanted, with an answer that takes it back.
  //
  // WHERE THE ANSWER LIVES: StateModel.pictureConsent, schema v6, beside
  // `paused` — panel-level, not per-identity, because it is an answer about the
  // FEATURE. The per-app grant is `Identity.pictured` and it is not replaced by
  // this; two of the three answers act by withdrawing it.
  //
  // The five parts of the modal are the overflow menu's five, mirrored: a bool
  // (consentOpen), focusSection set to its own value on open, a guard at the top
  // of handleMove so the panel cursor cannot walk behind it, an auto-close when
  // focus leaves, and Escape unwinding one level at a time. Plus a sixth this
  // one needs and the menu does not: the previous focusSection is STASHED and
  // restored, because the prompt arrives unbidden — the user did not tab to it
  // and did not ask for it, so putting the cursor back where they left it is the
  // difference between an interruption and a derailment.

  property bool consentOpen: false

  // The prompt's own cursor, held as a CHOICE ID rather than an index, for the
  // reason the map's is held as a chip key and the menu's as an action id: the
  // list is a binding, and an index is a promise about an order.
  property string consentCursor: ""

  // Where the panel's cursor was when the prompt took the keyboard. Restored on
  // the way out, whether the user answered or dismissed.
  property string consentReturnSection: ""

  // The strip: one entry per picture the round actually STORED, as
  // { identityId, occurrence, file, name, source }. The successes and nothing
  // else — see PanelModel.consentCaptureEntries for why a failed capture is not
  // a hole in the strip but an absence from it.
  property var consentEntries: []

  readonly property var consentChoiceModel: PanelModel.consentChoices()
  readonly property var consentChoiceIds: PanelModel.menuActionIds(root.consentChoiceModel)

  // What the file says the user answered, or "unasked".
  readonly property string pictureConsent: StateModel.pictureConsent(root.stateModel)

  // The app name the strip puts under a thumbnail. Looked up in appRows rather
  // than derived again here: the row is what the user reads this app's name off
  // everywhere else in the panel, and a second derivation could name the same
  // app two ways in one window. The id is the fallback, which is what a picture
  // of an app whose row has since gone honestly is.
  function consentAppName(identityId) {
    var rows = root.appRows || []
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].identityId || "") === String(identityId)) return String(rows[i].name)
    }
    return String(identityId)
  }

  // Offer the question, if it is still owed and there is something to ask about.
  // Called from the capture round's completion and nowhere else.
  function offerConsent(results) {
    var entries = PanelModel.consentCaptureEntries(results)
    if (!PanelModel.consentPromptDue(root.pictureConsent, entries)) return

    // The strip's rows, each carrying the two things the component cannot work
    // out for itself: what to call the app, and the URL its Image binds. The
    // URL comes from captureStore.pathFor and Util.fileUrl — the same spelling
    // of "a local file" the map's chips use, so a home directory with a space
    // in it works here for the same reason it works there.
    var strip = []
    for (var i = 0; i < entries.length; i++) {
      var path = captureStore.pathFor(entries[i].file)
      strip.push({
        identityId: entries[i].identityId,
        occurrence: entries[i].occurrence,
        file: entries[i].file,
        name: root.consentAppName(entries[i].identityId),
        source: path ? Util.fileUrl(path) : ""
      })
    }
    root.consentEntries = strip
    root.openConsent()
  }

  function openConsent() {
    // STASHED BEFORE it is overwritten, and only when the prompt was not
    // already up: a second offer while the first is on screen must not stash
    // "consent" as the place to go back to.
    if (!root.consentOpen) root.consentReturnSection = root.focusSection
    root.consentOpen = true
    root.focusSection = "consent"
    root.consentCursor = PanelModel.firstEnabledActionId(root.consentChoiceModel)
  }

  // Put the keyboard back where it was. The one exit that is NOT an answer —
  // Escape and a click on the scrim both land here — so nothing is written and
  // nothing is deleted: the question is still owed, and the next Record that
  // stores a picture asks it again. "Asked once" means asked once ANSWERED, and
  // recording an answer the user did not give is the single thing a consent
  // dialogue may never do.
  function closeConsent() {
    if (!root.consentOpen) return
    root.consentOpen = false
    root.consentCursor = ""
    root.consentEntries = []
    // Back where the user left it. `focusOrder` may no longer carry the stashed
    // section (the Undo button can disappear under a prompt that was open while
    // a topology changed), so an unknown one falls back to the map — which is
    // where the panel opens and the one section that is always there.
    var back = root.consentReturnSection
    root.consentReturnSection = ""
    root.focusSection = (back && root.focusOrder.indexOf(back) !== -1) ? back : "chips"
    if (root.focusSection === "chips" && !root.currentChip) root.moveChipCursor(1)
  }

  function dismissConsent() {
    root.closeConsent()
  }

  function moveConsentCursor(delta) {
    root.consentCursor = PanelModel.nextSection(root.consentChoiceIds, root.consentCursor, delta)
  }

  function activateConsent() {
    root.answerConsent(root.consentCursor)
  }

  // ANSWER IT. Returns whether the answer reached the file, so the IPC can tell
  // a recorded answer from a refused write.
  //
  // The discipline is setPaused's, because it is the same kind of write: a FRESH
  // read (this rewrites the whole file, which also carries every layout and
  // every identity), the adopt-what-the-file-says branch when somebody got there
  // first, a StateModel setter that touches only what the answer is about, a
  // success line gated on writeState's boolean, and the log line last.
  //
  // ONE WRITE for all three answers, and that is what StateModel.clearPictured
  // exists for: two of them withdraw a consent as well as recording one, and a
  // loop of setPictured calls would be N whole-file round trips with the state
  // after the third describing a decision the user never expressed.
  //
  //   Keep pictures      — records the answer. Nothing is deleted, nobody's
  //                        camera moves.
  //   Not for these apps — the apps in the strip lose their camera, and every
  //                        picture of them is deleted, on every desk (tick sp7).
  //                        THESE apps: the ones the user is looking at. Other
  //                        apps are untouched — but not other DESKS, because the
  //                        camera it withdraws is not a per-desk grant and a
  //                        photograph left on a desk whose camera is off is one
  //                        nothing would ever come back for.
  //   No pictures        — every camera goes off and EVERY stored picture is
  //                        deleted, on every desk. Not a standing gate on top of
  //                        the per-app consent, deliberately: `pictured` already
  //                        defaults to off and only an explicit camera press
  //                        turns it on, so after this answer nothing can be
  //                        photographed again without the user saying so, app by
  //                        app. A standing lock would add nothing except a way
  //                        out that the panel has no affordance for — an
  //                        unreachable off switch is not a consent model, it is
  //                        a bricked feature.
  function answerConsent(answer) {
    if (!PanelModel.isConsentChoice(answer)) return false
    var fresh = root.freshState()
    if (!fresh) return false

    var ids = PanelModel.consentIdentityIds(root.consentEntries)

    if (StateModel.pictureConsentAsked(fresh)) {
      // Somebody got there first (a second panel, a hand edit). The question is
      // already answered on disk; adopt that rather than overwriting it with a
      // second answer to a question that was only ever asked once.
      root.stateModel = fresh
      root.closeConsent()
      return false
    }

    var next = fresh
    if (answer === "not-these") next = StateModel.clearPictured(next, ids)
    else if (answer === "none") next = StateModel.clearPictured(next, null)
    next = StateModel.setPictureConsent(next, answer)

    if (!root.writeState(next)) return false

    // THE PICTURES, AFTER THE WRITE, like every other eviction in this file: a
    // refused write must not take the pictures with it.
    //
    // "Not for these apps" evicts BY IDENTITY, on every desk (tick sp7). It used
    // to evict this desk's topology prefix, which was wrong twice over and both
    // ways were reachable by ordinary use:
    //
    //   · the answer withdraws the camera GLOBALLY (clearPictured takes no
    //     topology), so a user who pressed Escape on desk A's prompt and then
    //     answered "Not for these apps" on desk B kept desk A's pictures of
    //     exactly those apps — cameras off, and nothing left that would ever
    //     clean them: Record's eviction only runs for the desk you are on, and
    //     so does Forget;
    //   · it read the LIVE topologyKey rather than the round's, so a dock while
    //     the prompt was up deleted another desk's pictures and left the ones
    //     the user was looking at while pressing the button.
    //
    // The identity patterns have no topology segment at all, so "every desk"
    // includes the one the prompt's own pictures were taken on whatever the
    // panel has since docked into — which is the whole point.
    //
    // "No pictures" still reaches further: every app, not only the ones in the
    // strip.
    if (answer === "not-these") {
      captureStore.evictIdentities(ids, "declined")
    } else if (answer === "none") {
      captureStore.evictAll("declined")
    }

    root.log(PanelModel.consentAnswerLine(answer, ids))
    root.closeConsent()
    return true
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
    // NOT reset here (tick be1): the row delegates are declared directly as
    // Popup.contentItem children, so QML instantiates them once, the moment
    // the Repeater's model first goes non-empty — the SAME instant on every
    // panel session, whether or not the menu has ever been opened — and they
    // are never destroyed by closing the popup, only by their row leaving the
    // model (which recreates the whole Repeater, per-row names included, and
    // re-fires Component.onCompleted for every surviving row too). A wipe here
    // raced that: it fired on every open, but the delegates that would refill
    // it fire only once, so the SECOND open (and the acceptance gate's very
    // first, because the delegates already existed by the time this ever ran)
    // found the store empty and stayed that way. "A shut menu lists nothing"
    // is still true — panelState() only reads overflowRowReports while
    // root.overflowOpen is true, and only for names the CURRENT
    // overflowModel.rows still names (see panelState() below) — so nothing
    // here needs to clear the store for that guarantee to hold.
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
  //
  // ONE HANDLER, both surfaces, because QML allows exactly one `onXChanged` per
  // signal per object — a second `onFocusSectionChanged` here would be a syntax
  // error, not a second listener.
  //
  // The prompt's half is not reachable by Tab (moveSection keeps Tab inside it)
  // but it IS reachable: `onCanUndoRecordChanged` sends the cursor to "record"
  // when the Undo button goes away, and `onFailedRowsChanged` sends it to
  // "restore" when a cycle succeeds. Either can fire while the prompt is up, and
  // a modal left hanging over a cursor that has moved on is exactly the state
  // this guard exists for. Dismissed, not answered — nothing the panel does to
  // itself may count as the user's answer.
  onFocusSectionChanged: {
    if (root.focusSection !== "overflow" && root.overflowOpen) root.closeOverflow()
    if (root.focusSection !== "consent" && root.consentOpen) root.closeConsent()
  }

  // Delete this topology's layout. No confirmation — the panel never blocks —
  // and the way back is the SAME one-shot undo Record arms, stashed before the
  // write and from the same fresh read the write is built on.
  // Returns whether a layout was actually removed.
  function forgetLayout() {
    var fresh = root.freshState()
    if (!fresh) return false
    var stash = PanelModel.forgetUndoStash(root.topologyKey,
      StateModel.layoutFor(fresh, root.topologyKey))
    if (!stash) {
      root.log("nothing to forget: no layout is recorded for topology \"" + root.topologyKey + "\"")
      root.closeOverflow()
      return false
    }
    // Armed after the write, for the reason recordLayout's comment gives: an
    // Undo button is a claim that something happened.
    if (!root.writeState(StateModel.removeLayout(fresh, root.topologyKey))) {
      root.closeOverflow()
      return false
    }
    root.recordUndo = stash
    // THE PICTURES GO WITH THE RECORDING (tick sz6). Forgetting a layout is the
    // delete point, and a photograph of a window kept after the arrangement it
    // belonged to was deleted is exactly the thing this epic's consent design
    // exists not to leave lying around. AFTER the write, like the log line: a
    // refused write must not take the pictures with it.
    //
    // The undo this arms puts the LAYOUT back and cannot put the pixels back —
    // see undoRecord for why that is the honest behaviour rather than a gap.
    captureStore.evict(PanelModel.captureTopologyPrefix(root.topologyKey), "forgotten")
    root.log("forgot the layout for topology \"" + root.topologyKey + "\" ("
      + (stash.previousLayout.apps || []).length + " apps) — undo puts it back")
    root.closeOverflow()
    return true
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
  //
  // AND A CAPTURE ROUND IN FLIGHT DIMS IT TOO (tick ilg). `captureStore.busy`
  // existed and was read nowhere, so the ONLY thing standing between a second
  // Record and two interleaved capture queues over one compositor session was
  // the store refusing — and that refusal ran on top of the live round's own
  // state. The refusal is now harmless, but the button is the right place to
  // stop it: a Record pressed against a live round could store no pictures
  // anyway, and an enabled button for an act that will be half-refused is the
  // affordance lying about what it does. Bounded by the store's whole-queue
  // deadline, so this can dim for at most `totalMs`; recordHint says why.
  readonly property bool canRecord: root.stateLoaded && root.haveLiveData
    && root.liveMonitors.length > 0 && !root.statusModel.restoring
    && root.writeRefusalReason === "" && !captureStore.busy

  // The same shape for the OTHER footer action (tick 66x). Restore now and a
  // failed row's Retry were lit while `restoreRefusalReason` held: the click
  // wrote the trigger, the panel dismissed itself, and the service refused the
  // cycle into its log — a dead end the user could only find by reading a log
  // file. The inert file is not a moment, it is a property of what is on disk,
  // so the affordance follows it exactly as Record follows the read-only half.
  //
  // Which of the two refusals applies is PanelModel's answer, not a binding's:
  // three call sites share it (the two buttons and the keyboard's Enter) and
  // three copies of the condition is how they drift apart.
  readonly property bool canRestore: PanelModel.mayManualRestore(
    !!root.recordedLayout, root.restoreRefusalReason)

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
    // The inert file, LAST LINE OF DEFENCE (tick 66x). Both buttons that reach
    // here are already dim while `restoreRefusalReason` holds, but this function
    // is the thing that writes the trigger and then dismisses the panel, and a
    // dismissed panel is a refusal the user can only read in a log file. So the
    // refusal happens BEFORE either: nothing is written, the panel STAYS OPEN,
    // and the Inert line — which says the whole reason, and is already on screen
    // — is scrolled to. Refusals are a feature, and a feature has to be visible
    // at the moment it costs the user their click.
    if (root.restoreRefusalReason !== "") {
      root.log("manual restore REFUSED — " + root.restoreRefusalReason)
      root.ensureCursorVisible(inertLine)
      return
    }

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

  // --------------------------------------------------------------------- IPC

  // What the panel computed, asked from outside it.
  //
  //   omarchy-shell dock-recall state                 the JSON below
  //   omarchy-shell dock-recall setView live|recorded which map is showing
  //
  // Two audiences. `omarchy-shell` gets a way to drive this panel's view the
  // way it drives the first-party ones (plugins/panels/network/Panel.qml owns
  // its own handler for the same kind of reason). And the acceptance VM gets
  // the only evidence that venue can honestly produce: it cannot prove a pixel
  // was rasterized, so the standard is that the panel COMPUTED and BOUND the
  // right value to the right chip, read back through here.
  //
  // The handler lives inside the panel component, and the shell's panel loader
  // instantiates that only while the panel is OPEN — so the `dock-recall`
  // target exists only while the panel is up. Summon it first
  // (`omarchy-shell shell summon mkelk.dock-recall '{}'`); opening and closing
  // stay the shell's verbs rather than being duplicated here, so the loader's
  // open-set and this panel can never disagree about whether it is up.
  //
  // The payload:
  //
  //   {
  //     "topologyName": "Laptop + Dell U2720Q",
  //     "showRecorded": false,
  //     "recordedAt": "2026-09-03T09:12:44.101Z" | null,   // ABSENT if none
  //     "recordedAge": "recorded 3 days ago" | null,       // ABSENT if none
  //     "headerTitle": "Laptop + Dell U2720Q" | null,
  //     "headerMeta": "In sync · 3 apps watched" | null,
  //     "paused": false | null,
  //     "badgeText": "In sync" | null,
  //     "badgeTone": "ok" | "muted" | "accent" | "urgent" | null,
  //     "overflowOpen": false,
  //     "overflowLayouts": [ { "name": "Laptop", "current": false } ],
  //     "pictureConsent": "unasked" | "keep" | "not-these" | "none",
  //     "consentOpen": false,
  //     "consentChoices": [ { "id": "keep", "label": "Keep pictures" } ],
  //     "consentCaptures": [ { "identityId": "obsidian", "occurrence": 0,
  //                            "name": "Obsidian", "source": "file:///…",
  //                            "ready": true } ],
  //     "hoveredLinkKey": "",
  //     "rows": [
  //       { "key": "obsidian", "name": "Obsidian", "watched": true,
  //         "ghost": false, "iconSource": "file:///…", "iconResolved": true,
  //         "linkKey": "id:obsidian", "linked": false }
  //     ],
  //     "workspaces": [
  //       { "id": 7, "name": "7", "monitorName": "eDP-1",
  //         "renderPath": "positioned" | "fallback" | null,
  //         "badgeValue": "7" | null, "badgeFocused": true | false | null }
  //     ],
  //     "chips": [
  //       { "key": "0x5581f0a1", "name": "Alacritty", "workspaceId": 7,
  //         "monitorName": "eDP-1", "watched": true,
  //         "renderPath": "positioned" | "fallback" | null,
  //         "placed": true | false | null,
  //         "width": 214, "height": 120,
  //         "iconSource": "file:///usr/share/icons/…/obsidian.svg" | null,
  //         "iconResolved": true | false | null,
  //         "treatment": "pill" | "badge" | "strip" | "veiled" | "field" | null,
  //         "fillState": "watched" | "ghost" | "unwatched" | null,
  //         "edgeTone": "drift" | "hover" | "watched" | "quiet" | null,
  //         "linkKey": "id:obsidian" | null, "linked": false | null,
  //         "fillMotionMs": 120 | null, "edgeMotionMs": 120 | null,
  //         "motionEasing": 0 | null }
  //     ]
  //   }
  //
  // The three motion fields are read off the chip's own ANIMATION OBJECTS, not
  // off Motion.qml's tokens: the venue cannot watch a colour move, so the most
  // it can honestly ask is whether the property is bound to an animation with a
  // real duration — and only a number that came from the animating thing
  // answers that. `motionEasing` is Qt's easing enum and is Linear (0) for the
  // two colour fades by design; the shell's own ColorAnimations declare no
  // curve. The bar widget's animations are NOT here — it is a separate entry
  // point the panel cannot see into, and reports through its own read-only
  // `dock-recall-bar` handler.
  //
  // ABSENT vs `null` is the payload's contract, and it is NORMATIVE in
  // tests/acceptance/README.md, "Absent vs `null` — the normative statement".
  // Read it there; it is not restated here, and adding a field to this payload
  // means extending that section rather than four copies of it.
  //
  // What is local to this file: every draw-time field (renderPath, placed,
  // width, height, iconSource, iconResolved, treatment, fillState, edgeTone,
  // badgeValue, badgeFocused, pictured) is present-and-`null` while the delegate
  // has not reported yet — which is `reported()` below, and is why that helper
  // exists rather than a bare property read.
  //
  // `key`, `renderPath`, `placed`, `width`, `height` and `monitorName` are
  // exact from the start, because every later assertion keys on them. The four
  // draw-time ones are NOT read off the model here: they are reported by the
  // delegate that actually drew the chip, from the same `positioned` flag and
  // the same resolved rect its x/y/width/height branch on. The map has two
  // layouts and the fallback one has hidden a broken model before
  // (.tick/learnings.md, "QML/JS boundary"), so a second derivation from the
  // model would be able to agree with the model while the screen did something
  // else.
  //
  // `renderPath: "positioned"` alone is not proof anything was drawn. Inside
  // the positioned branch there is a SECOND, silent branch: a chip whose slot
  // has no resolved rect draws a floor-sized marker at the canvas origin (see
  // the chipSlot x/y/width/height bindings below — the code calls it visibly
  // wrong), and during warm-up chipRectsForCanvas is handed a zero-width canvas
  // and answers with non-null 1×1 rects, so even the warning never fires.
  // `placed` separates the first case and `width`/`height` the second: a
  // positioned chip that really drew has placed:true AND clears the 16×10
  // floor. The treatment ladder needs the same two numbers — its answer is
  // PanelModel.chipTreatment(width, height) on the DRAWN size.

  // chip key -> { renderPath, placed, width, height },
  // workspace key -> { renderPath }, written by the delegates. Mutated in place
  // rather than reassigned: these are a side-channel for the IPC to read on
  // demand, never a binding source, and reassigning would re-run the map's
  // bindings from inside the map's own layout pass.
  //
  // Neither registry is ever pruned, and it needs no pruning: the shell
  // destroys the panel's Loader on hide (/usr/share/omarchy/shell/shell.qml,
  // the panel loader's active binding), so both maps die with the panel and a
  // fresh summon starts empty. Within one panel session they only grow, and
  // panelState() iterates the MODEL and merely looks entries up — so a stale
  // entry for a chip that is gone can never enter the payload.
  property var chipRenderReports: ({})
  property var workspaceRenderReports: ({})

  // Workspace ids are unique per desk in practice, but a stale recording can
  // name the same id under two monitors, so the monitor is part of the key.
  //
  // And the VIEW is part of it too, because both map models derive `box.name`
  // from the same mapGeometry: without the discriminator the recorded map's
  // workspace 7 on eDP-1 writes over the live map's, and a setView flip would
  // hand the live payload the recorded delegate's answer. Chips are already
  // safe — recorded chip keys carry a "recorded-" prefix, live ones are
  // addresses — but workspaces have no such prefix of their own.
  function workspaceRenderKey(showRecorded, monitorName, workspaceId) {
    return (showRecorded ? "recorded" : "live")
      + "/" + String(monitorName) + "/" + String(workspaceId)
  }

  // Merge rather than replace, so a later tick can report its own fields from
  // its own handler without knowing who else reports on the same chip.
  function mergeRenderReport(store, key, report) {
    if (!key) return
    var current = store[String(key)] || {}
    for (var field in report) current[field] = report[field]
    store[String(key)] = current
  }

  function reportChipRender(key, report) {
    root.mergeRenderReport(root.chipRenderReports, key, report)
  }

  // The header is one instance rather than a repeater, so its store has one
  // key. It reports through the same merge as the chips do — the hero, the
  // pause switch and the status badge each write their own fields without
  // knowing about the others, and the payload says what those three DREW rather
  // than re-reading the properties behind them.
  property var headerReports: ({})
  function reportHeader(report) {
    root.mergeRenderReport(root.headerReports, "header", report)
  }

  // The app list's rows, by the row key appRows already makes unique across its
  // three states (unwatched live, watched identity, recorded ghost). Same
  // discipline as the chips: the delegate writes, panelState iterates the MODEL
  // and looks entries up, so a stale row can never enter the payload.
  property var rowReports: ({})
  function reportRow(key, report) {
    root.mergeRenderReport(root.rowReports, key, report)
  }

  // The overflow menu's rows, by TOPOLOGY KEY, written by the delegates that
  // draw them.
  //
  // By the key and not by the name, for the reason every other registry here
  // has a purpose-built one (workspaceRenderKey was invented for exactly this
  // hazard): `name` is a DISPLAY string, and humanizeTopology truncates a desk
  // to two monitor labels. Two desks whose EDID serials differ but whose make
  // and model do not both humanize to "Laptop + AOC U34G2G", so both delegates
  // wrote to one slot and both rows then reported whichever finished last —
  // including its `current` flag, which is the one field in the payload that is
  // about identity rather than about drawing. `topologyKey` is unique by
  // construction and already on the row.
  //
  // Unlike the chip/row registries this is NOT scoped to "while the popup is
  // up" (tick be1 found that assumption false: the delegates are declared as
  // direct Popup.contentItem children, so QML creates them once, whenever the
  // Repeater's model first goes non-empty, and never destroys them merely
  // because the popup closes). Same discipline as chipRenderReports/rowReports
  // instead: never reset, and panelState() below iterates the MODEL
  // (overflowModel.rows) and looks a report up by key, so a layout the current
  // model does not carry can never enter the payload even though the store
  // itself is never cleared.
  property var overflowRowReports: ({})
  function reportOverflowRow(topologyKey, report) {
    root.mergeRenderReport(root.overflowRowReports, topologyKey, report)
  }

  function reportWorkspaceRender(key, report) {
    root.mergeRenderReport(root.workspaceRenderReports, key, report)
  }

  // The first-Record dialogue's two registries (tick y28): the answer buttons by
  // CHOICE ID, and the thumbnails by identity-and-occurrence.
  //
  // Same discipline as every registry above — written by the delegate, never
  // reset, and panelState() iterates the MODEL and looks entries up. That is
  // what makes "a shut prompt reports no answers" true without a wipe, and it is
  // the lesson tick be1 paid for: a Repeater's delegates are created once and
  // are not destroyed by the surface they sit on going away.
  property var consentChoiceReports: ({})
  function reportConsentChoice(id, report) {
    root.mergeRenderReport(root.consentChoiceReports, id, report)
  }

  property var consentCaptureReports: ({})
  function reportConsentCapture(key, report) {
    root.mergeRenderReport(root.consentCaptureReports, key, report)
  }

  // One field of a render report, as `null` rather than as nothing when the
  // delegate has not reported it. The distinction is the payload's whole
  // convention: JSON.stringify DROPS an undefined property, so reading a field
  // straight off a report that does not carry it yet would spell "not drawn
  // yet" the way the payload spells "no tick computes this". A reported field
  // is always present; only its value can be empty.
  function reported(report, field) {
    if (!report) return null
    return report[field] !== undefined ? report[field] : null
  }

  // The map as the panel has it, chip by chip. A projection of mapModel plus
  // what the delegates reported — deliberately thin, because everything with a
  // right answer in it was already decided by PanelModel.
  function panelState() {
    var chips = []
    var workspaces = []
    var monitors = (root.mapModel && root.mapModel.monitors) ? root.mapModel.monitors : []

    for (var m = 0; m < monitors.length; m++) {
      var box = monitors[m]
      var list = box.workspaces || []
      for (var w = 0; w < list.length; w++) {
        var workspace = list[w]
        var wsReport = root.workspaceRenderReports[
          root.workspaceRenderKey(root.showRecorded, box.name, workspace.id)] || null
        workspaces.push({
          id: workspace.id,
          name: String(workspace.name),
          // The monitor the key deliberately carries, carried through to the
          // payload as well: without it a consumer cannot reproduce the
          // disambiguation the key was built for, and a cross-check that
          // matches on `id` alone matches across monitors.
          monitorName: String(box.name),
          renderPath: root.reported(wsReport, "renderPath"),
          // What the number badge says, and whether it is the filled one. Both
          // from the delegate that drew the badge — `name` above is the model's
          // value and the badge's is derived from it, so reading the badge from
          // the model would be a second derivation that cannot disagree.
          badgeValue: root.reported(wsReport, "badgeValue"),
          badgeFocused: root.reported(wsReport, "badgeFocused")
        })

        var slots = workspace.slots || []
        for (var s = 0; s < slots.length; s++) {
          var members = slots[s].chips || []
          for (var c = 0; c < members.length; c++) {
            var chip = members[c]
            var report = root.chipRenderReports[chip.key] || null
            // THE STORED PICTURE, if the cache holds one for this chip (tick
            // sz6). Panel-computed rather than delegate-reported, and named
            // `capturePath` for exactly that reason: it is the claim "the cache
            // has a file for this identity, occurrence and topology", not the
            // claim "the chip drew it". The second claim is `captureSource`,
            // which the delegate reports.
            //
            // Only on the RECORDED map. The cache key is the recording's, and a
            // picture is a fact about a recorded layout — the Live tab draws the
            // windows that are actually on screen, and offering it a photograph
            // of one of them would be answering a question nobody asked.
            //
            // ABSENT, never "" or null, when there is none: the payload's
            // convention is that a key the panel has nothing to say about is not
            // there, and an empty string would be a consumer's problem to tell
            // from a path.
            var capturePath = root.showRecorded
              ? root.capturePathFor(chip.identityId, chip.occurrence) : ""
            chips.push({
              key: chip.key,
              name: chip.name,
              workspaceId: workspace.id,
              monitorName: String(box.name),
              watched: !!chip.watched,
              // Draw-time, all four from the delegate that drew this chip.
              renderPath: root.reported(report, "renderPath"),
              placed: root.reported(report, "placed"),
              width: root.reported(report, "width"),
              height: root.reported(report, "height"),
              // The icon the chip's Image was bound to, and whether it is the
              // app's own or the generic executable fallback. Both from the
              // delegate, for the reason the four above are.
              iconSource: root.reported(report, "iconSource"),
              iconResolved: root.reported(report, "iconResolved"),
              // The SECOND consent (tick qnc), reported beside `watched` and
              // never derived from it: the whole point of the pair is that they
              // move independently, so a consumer has to be able to read them
              // independently.
              pictured: root.reported(report, "pictured"),
              // The two colour channels, independently readable. A drifted chip
              // is fillState "watched" and edgeTone "drift" at once.
              fillState: root.reported(report, "fillState"),
              edgeTone: root.reported(report, "edgeTone"),
              // The row-to-chip link, from the chip's side.
              linkKey: root.reported(report, "linkKey"),
              linked: root.reported(report, "linked"),
              // Which of the five drawings this chip earned. Reproducible from
              // the width and height beside it — PanelModel.chipTreatment is
              // the one that decides — which is what makes a disagreement here
              // a real finding rather than two guesses.
              treatment: root.reported(report, "treatment"),
              // THAT THE CHIP'S TWO COLOUR CHANNELS ARE ANIMATED (tick fyi),
              // read off the animation objects themselves rather than off the
              // token they were bound from — see the comment at the report site
              // in MapWorkspace.qml for why that distinction is the whole
              // assertion.
              fillMotionMs: root.reported(report, "fillMotionMs"),
              edgeMotionMs: root.reported(report, "edgeMotionMs"),
              motionEasing: root.reported(report, "motionEasing")
            })
            // ADDED rather than assigned above, because the payload's rule is
            // that a key the panel has nothing to say about is ABSENT — and
            // "this chip has no stored picture" is exactly that. Never "",
            // which would be a second spelling of the same silence.
            //
            // TWO KEYS, TWO CLAIMS, and they are deliberately not one.
            // `capturePath` is the panel's own answer — the cache holds a file
            // for this identity, occurrence and topology. `captureSource` is
            // what the DELEGATE bound its Image to. They agree by construction,
            // which is what makes a disagreement worth failing on: a chip that
            // reports a path and no source is one the map decided not to draw.
            if (capturePath) chips[chips.length - 1].capturePath = capturePath
            var drawnCapture = root.reported(report, "captureSource")
            if (drawnCapture) chips[chips.length - 1].captureSource = drawnCapture
          }
        }
      }
    }

    // The app list, iterated off the MODEL exactly as the chips are — a report
    // for a row that is no longer in appRows cannot reach the payload.
    var rows = []
    var rowModel = root.appRows || []
    for (var r = 0; r < rowModel.length; r++) {
      var rowKey = rowModel[r].key
      var rowReport = root.rowReports[rowKey] || null
      rows.push({
        key: rowKey,
        name: root.reported(rowReport, "name"),
        watched: root.reported(rowReport, "watched"),
        ghost: root.reported(rowReport, "ghost"),
        iconSource: root.reported(rowReport, "iconSource"),
        iconResolved: root.reported(rowReport, "iconResolved"),
        // The second consent, and whether this row has anything to grant it
        // with. See the row delegate for why both are said.
        pictured: root.reported(rowReport, "pictured"),
        picturable: root.reported(rowReport, "picturable"),
        linkKey: root.reported(rowReport, "linkKey"),
        linked: root.reported(rowReport, "linked")
      })
    }

    // The header, from the three items that drew it: the hero (title and meta),
    // the pause switch (its own position) and the status badge (text and tone).
    var header = root.headerReports["header"] || null

    // The overflow menu's rows, and ONLY while it is open — the store itself
    // (tick be1) is never cleared, since its delegates outlive the popup being
    // closed, so visibility here is what keeps a shut menu reporting nothing.
    // Iterated from the MODEL, same discipline chips/rows use above: a layout
    // the current overflowModel.rows does not carry (a forgotten one whose
    // delegate has not been destroyed yet, or one the store still remembers
    // under a key no row has any more) can never enter the payload, and a key
    // the model DOES carry but no delegate has reported yet (a fresh row, this
    // same tick) is skipped rather than reported half-drawn.
    var layouts = []
    if (root.overflowOpen) {
      var menuRows = root.overflowModel.rows
      for (var mi = 0; mi < menuRows.length; mi++) {
        var menuRowModel = menuRows[mi]
        if (!menuRowModel) continue
        var row = root.overflowRowReports[menuRowModel.topologyKey] || null
        if (row) layouts.push({ name: row.name, current: !!row.current })
      }
    }

    // The first-Record dialogue, from the buttons and thumbnails that drew it,
    // and ONLY while it is up (tick y28). Iterated from the MODEL — the choice
    // list and the strip — for the reason the overflow rows are: a report left
    // over from a previous offer cannot enter the payload, and a row the model
    // carries but no delegate has drawn yet is skipped rather than reported
    // half-drawn.
    var consentChoices = []
    var consentCaptures = []
    if (root.consentOpen) {
      var choiceModel = root.consentChoiceModel
      for (var ci = 0; ci < choiceModel.length; ci++) {
        var choiceId = String(choiceModel[ci].id)
        var choiceReport = root.consentChoiceReports[choiceId] || null
        // The id from the MODEL, the label from the BUTTON. A prompt offering
        // the right three ids under the wrong three words is the failure this
        // pair catches; one value read off the model twice could not.
        if (choiceReport) consentChoices.push({ id: choiceId, label: String(choiceReport.label) })
      }
      var stripModel = root.consentEntries || []
      for (var si = 0; si < stripModel.length; si++) {
        var shotKey = String(stripModel[si].identityId) + "#" + String(stripModel[si].occurrence)
        var shotReport = root.consentCaptureReports[shotKey] || null
        if (!shotReport) continue
        consentCaptures.push({
          identityId: String(shotReport.identityId),
          occurrence: shotReport.occurrence,
          name: String(shotReport.name),
          // What the Image was bound to, and whether it ARRIVED. The pair is the
          // point: a strip that reports three sources and one ready picture is a
          // prompt showing the user two empty boxes.
          source: String(shotReport.source),
          ready: shotReport.ready === true
        })
      }
    }

    var payload = {
      topologyName: root.topologyName,
      showRecorded: root.showRecorded,
      // The hero's own two strings. `headerTitle` is what PanelHero was handed;
      // `topologyName` above is what the panel computed. They are the same
      // sentence by construction, and the pair is what shows a header that
      // stopped being given it.
      headerTitle: root.reported(header, "title"),
      headerMeta: root.reported(header, "meta"),
      // The pause switch's position, as the switch drew it.
      paused: root.reported(header, "paused"),
      // The status badge, whose TONE is four-valued and load-bearing.
      badgeText: root.reported(header, "badgeText"),
      badgeTone: root.reported(header, "badgeTone"),
      overflowOpen: root.overflowOpen,
      overflowLayouts: layouts,
      // THE FIRST-RECORD DIALOGUE (tick y28). Three keys, and they answer three
      // different questions:
      //
      //   pictureConsent  — what the FILE says the user answered, or "unasked".
      //                     The one that survives a shell restart, and therefore
      //                     the one that proves "asked once".
      //   consentOpen     — is the prompt on screen right now.
      //   consentChoices  — what the prompt is OFFERING, from the buttons that
      //                     drew it, and only while it is up.
      //   consentCaptures — the thumbnails it is showing, likewise.
      //
      // `pictureConsent` is always present; the prompt's own three are always
      // present too, empty when it is shut. Neither is a draw-time null: "the
      // prompt is not up" is a fact the panel has, not a value it is waiting for.
      pictureConsent: root.pictureConsent,
      consentOpen: root.consentOpen,
      consentChoices: consentChoices,
      consentCaptures: consentCaptures,
      // What the panel is hovering, and therefore what is lit on both surfaces.
      hoveredLinkKey: root.hoveredLinkKey,
      workspaces: workspaces,
      chips: chips,
      rows: rows
    }

    // The recording this topology has, whichever map is on screen: "when was
    // this recorded" is a fact about the layout, not about the tab.
    //
    // Absent when there is NO recording; present-and-null when there is one
    // that carries no timestamp. Those were the same answer before, and the
    // dated Recorded header has to tell them apart.
    if (root.recordedLayout) {
      payload.recordedAt = root.recordedLayout.recordedAt
        ? String(root.recordedLayout.recordedAt) : null
      // The same fact as the Recorded tab says it. `null` for a recording that
      // carries no timestamp — there is an age and it is genuinely unknowable —
      // which is the second half of the same distinction recordedAt makes.
      payload.recordedAge = root.recordedAgeLabel ? root.recordedAgeLabel : null
    }

    return payload
  }

  IpcHandler {
    target: "dock-recall"

    function state(): string {
      return JSON.stringify(root.panelState())
    }

    // Same guard the Recorded button carries: nothing recorded for this
    // topology means there is no recorded map to show, and the toggle dims
    // rather than flipping to an empty one.
    function setView(view: string): string {
      var want = String(view || "").toLowerCase()
      if (want === "live") {
        root.showRecorded = false
        return "live"
      }
      if (want !== "recorded") return "unknown"
      if (!root.recordedLayout) return "no-recording"
      root.showRecorded = true
      return "recorded"
    }

    // The Pause switch, driven the way a finger drives it. Through
    // root.setPaused and nothing else: that function is the ONE place that
    // re-reads the state file before writing, refuses a write that would be
    // rejected, and logs the change — an IPC path that set the flag directly
    // would be a second writer with none of that.
    //
    // Answers the position the switch is IN afterwards, which is not always the
    // one that was asked for: a read-only state file refuses the write and the
    // switch stays where it was. A caller comparing the answer to its request
    // learns that without reading a log.
    function setPaused(value: string): string {
      var want = String(value || "").toLowerCase()
      if (want !== "on" && want !== "off" && want !== "true" && want !== "false") return "unknown"
      if (!root.stateLoaded) return "no-state"
      root.setPaused(want === "on" || want === "true")
      return root.paused ? "paused" : "active"
    }

    // Tick a row, the way its Toggle does. Ui/Toggle's clicked() calls
    // root.toggleChip(row) and nothing else, so this is that call on the row
    // carrying this key — pressing the widget itself would need a virtual
    // pointer, which is a live-session rig this increment does not use.
    //
    // The row is looked up in appRows rather than taken from the caller, so a
    // key that no longer names a row answers "no-row" instead of acting on
    // something else; and a row the panel cannot act on answers so rather than
    // pretending.
    function toggleRow(key: string): string {
      var want = String(key || "")
      if (!want) return "unknown"
      var list = root.appRows || []
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].key) !== want) continue
        if (list[i].clickable === false) return "not-clickable"
        root.toggleChip(list[i])
        return "toggled"
      }
      return "no-row"
    }

    // The SECOND consent, driven the way its camera drives it (tick qnc).
    // Through root.setPicturedFor and nothing else — that function is the one
    // place that re-reads the state file before writing, adopts what the file
    // already says, and gates its log line on the write — for the same reason
    // setPaused above routes through the panel's own setter.
    //
    // Keyed by ROW, not by identity id, so a caller cannot grant a consent to
    // something the panel is not showing: the row is looked up in appRows, and
    // a key that names no row answers "no-row" rather than acting on something
    // else. A row with no identity to grant with — an unwatched window, an
    // orphaned recorded ghost — answers "not-picturable", which is the same
    // sentence its missing camera says.
    //
    // Answers the position the camera is IN afterwards, exactly as setPaused
    // does, so a caller comparing the answer to its request learns about a
    // refused write without reading a log.
    function setPictured(key: string, value: string): string {
      var want = String(value || "").toLowerCase()
      if (want !== "on" && want !== "off" && want !== "true" && want !== "false") return "unknown"
      if (!root.stateLoaded) return "no-state"
      var wanted = String(key || "")
      if (!wanted) return "unknown"
      var list = root.appRows || []
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].key) !== wanted) continue
        var identityId = String(list[i].identityId || "")
        if (!root.picturableOf(identityId)) return "not-picturable"
        root.setPicturedFor(identityId, want === "on" || want === "true")
        return root.picturedOf(identityId) ? "on" : "off"
      }
      return "no-row"
    }

    // The row-to-chip link, driven without a pointer. `hoveredLinkKey` is what
    // a hover on either surface sets, and everything that answers to the key
    // lights up in whichever direction the pointer came from — so setting it
    // directly is the same act the pointer performs, and it is the only way this
    // venue can watch a row and its chips light up together (a virtual pointer
    // is a live-session rig, and this increment does not touch the live
    // session).
    //
    // Answers the key that is actually hovered afterwards.
    function hoverLink(key: string): string {
      var want = String(key || "")
      if (want === "" || want === "none") {
        root.hoveredLinkKey = ""
        return "none"
      }
      root.setHoveredLink(want)
      return root.hoveredLinkKey
    }

    // THE THREE ACTS ON A RECORDING, driven the way their buttons drive them
    // (tick sz6). Through root.recordLayout / undoRecord / forgetLayout and
    // nothing else: those three own the fresh read, the atomic write, the
    // one-shot undo stash and the picture cache's eviction, and an IPC path
    // that wrote a layout directly would be a second recorder with none of it.
    //
    // They exist because Record is the moment a picture is taken, and until now
    // the only way to reach it was a finger on the button — `scripts/record-current`
    // writes through StateModel and never opens the panel, so it takes no
    // pictures and never could. A headless venue had no door onto the act this
    // whole epic is about.
    //
    // Each answers what HAPPENED rather than what was asked for, and none of
    // them waits for the pictures: the capture round is best-effort and runs
    // after the write, so "recorded" is a claim about the state file alone.
    function record(): string {
      if (!root.stateLoaded) return "no-state"
      if (!root.canRecord) return "cannot-record"
      return root.recordLayout() ? "recorded" : "refused"
    }

    function undoRecord(): string {
      if (!root.canUndoRecord) return "nothing-to-undo"
      return root.undoRecord() ? "undone" : "refused"
    }

    function forgetLayout(): string {
      if (!root.stateLoaded) return "no-state"
      return root.forgetLayout() ? "forgotten" : "nothing-to-forget"
    }

    // ANSWER THE FIRST-RECORD DIALOGUE (tick y28), the way its buttons answer
    // it. Through root.answerConsent and nothing else: that function owns the
    // fresh read, the single composed write, the eviction and the log line, and
    // an IPC path that set `pictureConsent` directly would record an answer
    // without performing it — a "No pictures" that deleted nothing.
    //
    // It exists because this prompt is otherwise reachable only by a finger on
    // one of three buttons, and the acceptance venue has no pointer. The verb is
    // the door a headless test drives it through, and the same door
    // `omarchy-shell` gets.
    //
    // Answers what HAPPENED rather than what was asked for, exactly as setPaused
    // and setPictured do: "not-asking" for a prompt that is not up, "unknown"
    // for a word that is not one of the three, "refused" for a write the file
    // would not take, and otherwise the answer that was recorded.
    function answerConsent(answer: string): string {
      var want = String(answer || "").toLowerCase()
      if (!PanelModel.isConsentChoice(want)) return "unknown"
      if (!root.stateLoaded) return "no-state"
      if (!root.consentOpen) return "not-asking"
      return root.answerConsent(want) ? want : "refused"
    }

    // The overflow menu, opened and closed by the panel's own verbs so the
    // popup and root.overflowOpen cannot disagree — the same reason summon and
    // hide stay the shell's.
    function setOverflow(value: string): string {
      var want = String(value || "").toLowerCase()
      if (want === "open") {
        root.openOverflow()
        return "open"
      }
      if (want === "closed" || want === "close") {
        root.closeOverflow()
        return "closed"
      }
      return "unknown"
    }
  }

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

  // The same answer as a Quickshell screen. Hoisted out of the PanelWindow's own
  // binding because the capture store's 1x1 host needs it too — and it needs it
  // to be the SAME screen, which is a rendering one by construction: it is the
  // monitor the user is looking at.
  readonly property var focusedScreen: {
    var screens = Quickshell.screens
    for (var i = 0; i < screens.length; i++) {
      if (screens[i] && screens[i].name === root.focusedMonitorName) return screens[i]
    }
    return screens.length > 0 ? screens[0] : null
  }

  PanelWindow {
    id: panelWindow

    screen: root.focusedScreen

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

        // Esc backs out ONE LEVEL AT A TIME: the first-Record dialogue if it is
        // up, then the menu, then the panel itself. The prompt is outermost
        // because it is the only surface here that took the keyboard away from
        // the panel entirely — and backing out of it is a dismissal, not an
        // answer, so the question is asked again at the next Record that stores
        // a picture (see closeConsent).
        onCloseRequested: root.consentOpen ? root.dismissConsent()
          : (root.overflowOpen ? root.closeOverflow() : root.dismiss())
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
            //
            // The shell's own PanelHero, not a hand-rolled row of anchors. It
            // owns the icon-title-meta layout and, crucially, RESERVES the
            // trailing control's width itself — the hand-rolled version chained
            // four anchors right-to-left and every addition to the row was
            // another link in that chain.
            //
            // What did NOT move into it: the status badge. PanelHero's `detail`
            // pill is a fixed accent-bordered slip, and this badge's TONE is
            // load-bearing — ok, muted, accent and urgent are four different
            // kinds of news (PanelModel.badgeFor), and flattening them to one
            // border colour would throw away the only channel a glance uses.
            // So the badge keeps its own pill, and the hero ends where it
            // begins.
            Item {
              width: parent.width
              implicitHeight: Math.max(heroBox.implicitHeight, badgePill.implicitHeight,
                overflowButton.implicitHeight)

              // The monitor glyph: a screen and a stand, outlined, in the
              // panel's own foreground. The same idea as the mini monitors in
              // the overflow menu below, at hero size — this panel is about
              // which SCREENS you are sitting at, and the title beside it is a
              // topology name.
              Component {
                id: heroMonitorGlyph

                Item {
                  implicitWidth: Style.font.display
                  implicitHeight: Style.font.display

                  Rectangle {
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.top: parent.top
                    anchors.topMargin: Math.round(parent.height * 0.14)
                    width: parent.width
                    height: Math.round(parent.height * 0.60)
                    radius: Math.max(1, Style.space(2))
                    color: "transparent"
                    border.width: Math.max(1, Style.space(1))
                    border.color: root.foreground
                  }

                  Rectangle {
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: Math.round(parent.height * 0.14)
                    width: Math.round(parent.width * 0.5)
                    height: Math.max(1, Style.space(1))
                    color: root.foreground
                  }
                }
              }

              // PAUSE, as a real switch rather than a button whose label had to
              // name the act to avoid reading as a status line. A switch has no
              // label to get wrong: it is ON when the tool is working, which is
              // the only polarity it can carry (PanelModel.pauseSwitchChecked).
              //
              // The tooltip still carries the consequence, because "off" does
              // not say WHICH monitor changes stop being acted on.
              Component {
                id: heroPauseControl

                ToggleSwitch {
                  id: pauseSwitch
                  checked: PanelModel.pauseSwitchChecked(root.paused)
                  // A panel that has not read the state file yet must not offer
                  // to write it.
                  interactive: root.stateLoaded
                  opacity: root.stateLoaded ? 1.0 : 0.45
                  hasCursor: root.focusSection === "pause"
                  foreground: root.foreground
                  accent: Color.accent
                  onToggled: root.setPaused(!root.paused)

                  // What the switch DREW, reported the way every chip reports
                  // its own drawing — `paused` in the payload is this control's
                  // position, not a second read of the flag behind it.
                  function reportRender() {
                    root.reportHeader({ paused: !pauseSwitch.checked })
                  }
                  onCheckedChanged: pauseSwitch.reportRender()
                  Component.onCompleted: pauseSwitch.reportRender()

                  HoverHandler { id: pauseHover }

                  PanelToolTip {
                    visible: pauseHover.hovered
                    text: PanelModel.wrapTooltip(PanelModel.pauseTooltip(root.paused))
                    fontFamily: root.fontFamily
                  }
                }
              }

              // PanelHero binds its own `width` to its parent, which is how the
              // shell uses it everywhere — so it gets a parent of exactly the
              // width it should have rather than a pair of anchors fighting
              // that binding.
              Item {
                id: heroBox
                anchors.left: parent.left
                anchors.right: badgePill.left
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                implicitHeight: hero.implicitHeight

                PanelHero {
                  id: hero
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  title: root.topologyName
                  // The age rides the meta line, and only on the RECORDED tab:
                  // "recorded 3 days ago" over the live map would be answering
                  // a question nobody asked of the windows on screen.
                  meta: PanelModel.headerMeta(root.badge.text, root.watchedCount,
                    root.showRecorded ? root.recordedAgeLabel : "")
                  iconComponent: heroMonitorGlyph
                  trailingControl: heroPauseControl

                  // The keyboard cursor's "pause" section lives inside the
                  // trailing control, and the hero is what has to be on screen
                  // for it to be reachable.
                  Connections {
                    target: root
                    function onFocusSectionChanged() {
                      if (root.focusSection === "pause") root.ensureCursorVisible(heroBox)
                    }
                  }

                  function reportRender() {
                    root.reportHeader({ title: hero.title, meta: hero.meta })
                  }
                  onTitleChanged: hero.reportRender()
                  onMetaChanged: hero.reportRender()
                  Component.onCompleted: hero.reportRender()
                }
              }

              BorderSurface {
                id: badgePill
                anchors.right: overflowButton.left
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                implicitWidth: badgeText.implicitWidth + Style.space(16)
                implicitHeight: badgeText.implicitHeight + Style.space(6)
                radius: Style.cornerRadius
                color: Style.hoverFillFor(root.toneColor(root.badge.tone), root.toneColor(root.badge.tone))
                borderSpec: Border.controlSpec("normal", root.toneColor(root.badge.tone), root.toneColor(root.badge.tone))

                // The badge's two values, from the pill that drew them. The
                // TONE is the point: four of them (ok, muted, accent, urgent)
                // for six states, and it is what makes "In sync" and "Restore
                // failed" different kinds of news at a glance rather than two
                // strings. Reported so the move into PanelHero can be shown not
                // to have flattened it.
                function reportRender() {
                  root.reportHeader({ badgeText: root.badge.text, badgeTone: root.badge.tone })
                }
                Component.onCompleted: badgePill.reportRender()
                Connections {
                  target: root
                  function onBadgeChanged() { badgePill.reportRender() }
                }

                Text {
                  id: badgeText
                  textFormat: Text.PlainText
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
                      textFormat: Text.PlainText
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

                        // This row, as the menu drew it. Read back over IPC, so
                        // "the overflow still lists the recorded layouts"
                        // is a claim about rows that exist rather than about a
                        // model that could have produced them.
                        // Keyed by the layout's topologyKey — unique — while
                        // the payload still carries the display `name`, which
                        // is what a consumer reads. Two desks can share a name;
                        // they cannot share a key.
                        Component.onCompleted: root.reportOverflowRow(menuRow.modelData.topologyKey, {
                          name: String(menuRow.modelData.name),
                          current: menuRow.modelData.current === true
                        })

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
                            textFormat: Text.PlainText
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
                            textFormat: Text.PlainText
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
                            textFormat: Text.PlainText
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
                      textFormat: Text.PlainText
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
                  textFormat: Text.PlainText
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
                            textFormat: Text.PlainText
                            text: monitorRect.modelData.name
                            color: root.faintForeground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            anchors.left: parent.left
                          }

                          Text {
                            id: monitorSize
                            textFormat: Text.PlainText
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

                            // ONE WORKSPACE BOX and all of its
                            // contents: MapWorkspace.qml.
                            //
                            // 1078 lines used to end here, twenty-seven
                            // levels down, where a comment had about
                            // twenty-eight usable columns and a two-line
                            // binding therefore cost thirty-six lines of
                            // it. Moved out whole in tick xk5 — same
                            // bindings, same words, no behaviour change,
                            // and both render paths went with it.
                            //
                            // `panel` IS THE INTERFACE, because the
                            // subtree reads twenty distinct members of
                            // this root and twenty pass-through
                            // properties would be twenty places to forget
                            // the twenty-first. The other two are what
                            // this scope knows and the panel does not.
                            delegate: MapWorkspace {
                              panel: root
                              monitorName: monitorRect.modelData.name
                              boxWidth: workspaceFlow.grid.boxW
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
              textFormat: Text.PlainText
              width: parent.width
              visible: root.emptyHint !== ""
              text: root.emptyHint
              color: root.dimForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
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
              textFormat: Text.PlainText
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
              textFormat: Text.PlainText
              width: parent.width
              visible: root.writeRefusalReason !== ""
              text: "Read-only: " + root.writeRefusalReason
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // ...and the other half of the same condition: no restore will run
            // from it either (tick t03). Separate line, because "read-only"
            // reads as "your layouts are safe, you just cannot change them" —
            // and the user needs to know the dock has stopped acting.
            //
            // Named, because restoreNow scrolls it into view when a manual
            // restore is refused (tick 66x): the line is always on screen while
            // the file is inert, but on a long panel "on screen" can mean below
            // the fold, and a dim button the user just pressed deserves to point
            // at the sentence that explains it.
            Text {
              id: inertLine
              textFormat: Text.PlainText
              width: parent.width
              visible: root.restoreRefusalReason !== ""
              text: "Inert: " + root.restoreRefusalReason
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
              textFormat: Text.PlainText
              width: parent.width
              visible: root.tickRefusalHint !== ""
              text: root.tickRefusalHint
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: root.untitledHint !== ""
              text: root.untitledHint
              color: Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
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
            //
            // Every row is the shell's Ui/Toggle: the LABELED one, which wraps a
            // ToggleSwitch with `interactive: false` so the ROW owns the click.
            // That is the component this list wanted — a hand-drawn teal square
            // that had to be clicked through the row around it was a checkbox
            // reimplemented, without the kit's fill, border, focus ring or
            // keyboard.
            //
            // Around it, unchanged in role: the app's icon on the left (same
            // resolution path as the chips), and on the right the launch hint
            // and the placement text with its drift colouring. They sit OUTSIDE
            // the Toggle rather than inside it because Toggle gives its label
            // whatever width is left after the switch, and there is no way to
            // reach in past that — anchoring them to the row and the Toggle to
            // them keeps every width derived rather than guessed.
            //
            // THREE ROW STATES come out of PanelModel.appRows and all three draw
            // here: an unwatched live window (unchecked, clickable), a watched
            // identity (checked), and a recorded-but-unwatched GHOST (dimmed,
            // and `clickable: false` when there is no pattern left to re-watch
            // from).
            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: root.appRows

                delegate: Item {
                  id: appRow
                  required property var modelData

                  width: parent.width
                  height: rowToggle.implicitHeight
                  opacity: appRow.modelData.ghost ? 0.6 : 1.0

                  // Is the pointer on this app — here, or on one of its chips
                  // up on the map?
                  readonly property bool linked: root.hoveredLinkKey !== ""
                    && root.hoveredLinkKey === appRow.modelData.linkKey
                  readonly property string tipText: PanelModel.wrapTooltip(
                    PanelModel.rowTooltipText(appRow.modelData),
                    root.chipTooltipColumns)

                  // The app's icon, resolved exactly as a chip's is — identity
                  // first, class second, so a ghost row (which has no window and
                  // therefore no class) still finds its own.
                  readonly property string iconSource: root.iconSourceOf(
                    appRow.modelData.identityId, appRow.modelData.className)
                  readonly property bool iconResolved: root.iconResolvedOf(
                    appRow.modelData.identityId, appRow.modelData.className)

                  // The second consent, as this row draws it (tick qnc). Held
                  // here rather than read twice, for the reason the icon pair
                  // above is: the payload has to carry what the camera was
                  // BOUND to, not a second derivation that could agree with the
                  // state file while the row drew something else.
                  readonly property bool picturable: root.picturableOf(appRow.modelData.identityId)
                  readonly property bool pictured: root.picturedOf(appRow.modelData.identityId)

                  // What this row DREW, read back over IPC. Keyed by the row's
                  // own key, which appRows already makes unique across all three
                  // states.
                  function reportRender() {
                    root.reportRow(appRow.modelData.key, {
                      name: String(appRow.modelData.name),
                      watched: appRow.modelData.watched === true,
                      ghost: appRow.modelData.ghost === true,
                      iconSource: appRow.iconSource,
                      iconResolved: appRow.iconResolved,
                      // The SECOND consent, and whether this row can carry one
                      // at all. Both, because "false" says two different things
                      // — a watched app that has withheld the grant, and a row
                      // (an unwatched window, an orphaned ghost) that has
                      // nothing to grant it with — and the camera draws only in
                      // the first case.
                      pictured: appRow.pictured,
                      picturable: appRow.picturable,
                      // The row's half of the row-to-chip link: the key it
                      // answers to, and whether it is answering right now.
                      linkKey: String(appRow.modelData.linkKey || ""),
                      linked: appRow.linked
                    })
                  }
                  onPicturedChanged: appRow.reportRender()
                  onPicturableChanged: appRow.reportRender()
                  onIconSourceChanged: appRow.reportRender()
                  // This was the bug (sm1): the desktop-file scan that resolves
                  // an icon lands AFTER open(), so both properties start out ""/
                  // false and are re-evaluated once the scan completes. `report
                  // Render()` above is called from `onIconSourceChanged`, and on
                  // that pass `iconSource`'s own notification fires and runs its
                  // handler BEFORE `iconResolved`'s pending re-evaluation is
                  // forced — so the report captured iconSource's fresh value
                  // beside iconResolved's stale pre-scan one. `iconResolvedOf`
                  // itself was never wrong; nothing told this delegate to report
                  // again once ITS value changed. The chip delegate `chipTab`
                  // has the identical property and has always carried this
                  // handler, which is why only the row's payload showed the
                  // disagreement. (Named, not cited by line number: a line
                  // reference is wrong at the next insertion above it, and this
                  // one was 120 lines out.)
                  onIconResolvedChanged: appRow.reportRender()
                  onLinkedChanged: appRow.reportRender()
                  onModelDataChanged: appRow.reportRender()
                  Component.onCompleted: appRow.reportRender()

                  // The link's list-side listener stays on the ROW rather than
                  // moving into the Toggle: it has to cover the icon and the
                  // placement text too, and it has to keep working on a row the
                  // Toggle itself is disabled on.
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

                  Image {
                    id: rowIcon
                    width: Style.font.iconLarge
                    height: Style.font.iconLarge
                    anchors.left: parent.left
                    anchors.leftMargin: Style.spacing.rowPaddingX
                    anchors.verticalCenter: parent.verticalCenter
                    fillMode: Image.PreserveAspectFit
                    smooth: true
                    // Decoded at physical pixels, for the reason the chip icon
                    // is: an upscaled PNG is the one thing an icon may not be.
                    sourceSize.width: width * Screen.devicePixelRatio
                    sourceSize.height: height * Screen.devicePixelRatio
                    asynchronous: true
                    source: appRow.iconSource
                  }

                  Toggle {
                    id: rowToggle
                    anchors.left: rowIcon.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: rowCamera.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter

                    label: appRow.modelData.name
                    checked: appRow.modelData.watched === true
                    // The list has no keyboard cursor of its own — the panel's
                    // walks the chips — so `hasCursor` carries the LINK instead.
                    // It drives the same hover fill the map uses, which is what
                    // the hand-drawn Rectangle behind this row used to do: one
                    // language for one hover, now the kit's.
                    hasCursor: appRow.linked
                    // A row the panel cannot act on does not offer to be
                    // clicked: the "recorded · no longer watched" row has no
                    // pattern left to re-watch from (PanelModel.appRows explains
                    // why), and its predecessor's ticked box and dead click were
                    // the review finding this replaces.
                    enabled: appRow.modelData.clickable !== false
                    foreground: root.foreground
                    accent: Color.accent
                    fontFamily: root.fontFamily
                    titleSize: Style.font.caption
                    onClicked: root.toggleChip(appRow.modelData)
                  }

                  // THE SECOND CONSENT, one camera per row (tick qnc).
                  //
                  // Drawn from primitives rather than set in an icon font, the
                  // way the hero's monitor glyph and the overflow menu's mini
                  // monitors are: this panel has no glyph font of its own and
                  // borrowing one would make the camera the only piece of
                  // chrome that changes shape with the user's theme.
                  //
                  // FILLED means granted. Outline-only means withheld, which is
                  // the default and the state most rows are in — so the list
                  // reads as "nothing is being photographed" at a glance, and a
                  // grant is the thing that stands out. It is the same polarity
                  // the watched switch uses and the opposite of a warning
                  // badge, deliberately: consent is a positive act.
                  //
                  // Absent entirely on a row with nothing to write to — an
                  // unwatched window, or the orphaned recorded ghost whose
                  // identity the file no longer carries. `width: 0` when hidden
                  // so the toggle beside it takes the space back rather than
                  // anchoring against a gap.
                  Item {
                    id: rowCamera
                    readonly property bool picturable: root.picturableOf(appRow.modelData.identityId)
                    readonly property bool pictured: root.picturedOf(appRow.modelData.identityId)
                    readonly property color tone: rowCamera.pictured ? Color.accent : root.faintForeground

                    visible: rowCamera.picturable
                    width: rowCamera.visible ? Style.font.iconLarge : 0
                    height: Style.font.iconLarge
                    anchors.right: rowLaunch.left
                    anchors.rightMargin: rowCamera.visible ? Style.space(8) : 0
                    anchors.verticalCenter: parent.verticalCenter
                    opacity: rowCamera.pictured ? 1.0 : 0.75

                    // The body: a rounded box, with a bump on top for the
                    // viewfinder hump. Filled when the consent is granted,
                    // hollow when it is not.
                    Rectangle {
                      id: cameraHump
                      anchors.horizontalCenter: parent.horizontalCenter
                      anchors.horizontalCenterOffset: -Math.round(parent.width * 0.14)
                      anchors.top: parent.top
                      anchors.topMargin: Math.round(parent.height * 0.14)
                      width: Math.round(parent.width * 0.30)
                      height: Math.round(parent.height * 0.14)
                      radius: Math.max(1, Style.space(1))
                      color: rowCamera.tone
                    }

                    Rectangle {
                      id: cameraBody
                      anchors.horizontalCenter: parent.horizontalCenter
                      anchors.bottom: parent.bottom
                      anchors.bottomMargin: Math.round(parent.height * 0.14)
                      width: parent.width
                      height: Math.round(parent.height * 0.58)
                      radius: Math.max(1, Style.space(2))
                      color: rowCamera.pictured ? rowCamera.tone : "transparent"
                      border.width: Math.max(1, Style.space(1))
                      border.color: rowCamera.tone

                      // The lens. On a granted camera it is a hole punched in
                      // the filled body (the panel's own background), so the
                      // shape still reads as a camera at 18 px rather than as a
                      // solid blob.
                      Rectangle {
                        anchors.centerIn: parent
                        width: Math.round(parent.height * 0.56)
                        height: width
                        radius: width / 2
                        color: rowCamera.pictured ? Color.popups.background : "transparent"
                        border.width: rowCamera.pictured ? 0 : Math.max(1, Style.space(1))
                        border.color: rowCamera.tone
                      }
                    }

                    HoverHandler { id: rowCameraHover }

                    // Its own click target, the way "learn launch" has one:
                    // pressing the camera must not also untick the app, and
                    // with the row's toggle confined to the Toggle itself that
                    // is structural rather than a declaration-order trick.
                    MouseArea {
                      anchors.fill: parent
                      cursorShape: Qt.PointingHandCursor
                      onClicked: root.togglePictured(appRow.modelData.identityId)
                    }

                    // The consequence, said out loud. A privacy grant is the
                    // one control in this panel where "what does this button
                    // do" must not be inferable only from its shape.
                    PanelToolTip {
                      visible: rowCameraHover.hovered
                      text: rowCamera.pictured
                        ? "Pictured: Record stores a picture of this app's windows.\nClick to stop."
                        : "Not pictured: Record stores no picture of this app.\nClick to allow one."
                      fontFamily: root.fontFamily
                    }
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
                    textFormat: Text.PlainText
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
                    textFormat: Text.PlainText
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
                    width: Math.min(implicitWidth, Math.round(appRow.width * 0.45))
                    horizontalAlignment: Text.AlignRight
                    anchors.right: parent.right
                    anchors.rightMargin: Style.spacing.rowPaddingX
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

                  // "learn launch" is its own click, and it sits OUTSIDE the
                  // Toggle now — so it no longer has to be declared after a
                  // row-wide MouseArea to win against it. Pressing it must not
                  // also untick the app, and with the toggle's click confined to
                  // the toggle that is structural rather than an ordering trick.
                  MouseArea {
                    anchors.fill: rowLaunch
                    enabled: appRow.modelData.launchRepairable === true
                    visible: enabled
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.learnLaunchFor(appRow.modelData.identityId)
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
                textFormat: Text.PlainText
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
                      textFormat: Text.PlainText
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
                      textFormat: Text.PlainText
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
                      textFormat: Text.PlainText
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
                      PanelModel.retryTooltip(failedRow.modelData, root.statusModel.restoring,
                        root.restoreRefusalReason),
                      root.footerTooltipColumns)
                    bordered: true
                    hasCursor: failedRow.hasCursor
                    enabled: !root.statusModel.restoring && root.canRestore
                    opacity: enabled ? 1.0 : 0.45
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.caption
                    onClicked: if (root.canRestore) root.restoreNow()
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
                    PanelModel.restoreTooltip(!!root.recordedLayout, root.topologyName,
                      root.restoreRefusalReason),
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
                  // only lit action. An INERT state file dims it too (tick
                  // 66x) — the service will refuse the cycle, and a lit button
                  // for a refused cycle is the affordance lying about what it
                  // does. Both reasons live in canRestore; the tooltip and the
                  // panel's own Inert line say which one holds.
                  enabled: root.canRestore
                  opacity: root.canRestore ? 1.0 : 0.45
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  onClicked: if (root.canRestore) root.restoreNow()
                }

                Button {
                  id: recordButton
                  text: PanelModel.recordLabel(root.watchedCount, root.topologyName)
                  // Says what pressing it will DO — including that it
                  // overwrites, and why it is dim when it is.
                  tooltipText: PanelModel.wrapTooltip(
                    PanelModel.recordTooltip(root.watchedCount, root.topologyName,
                      root.statusModel.restoring, captureStore.busy),
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

      // ------------------------------------ the first-Record dialogue (y28)
      //
      // OVER THE WHOLE CARD, and declared AFTER the key catcher so it is drawn
      // on top of it and its MouseAreas see a click first. It is not inside the
      // ScrollView on purpose: a question the panel is waiting on an answer to
      // must not be scrollable off the top of its own card, and the scroll
      // position the user left behind is still theirs when the prompt goes.
      //
      // A LOADER, not a `visible` binding, and the difference is the thumbnail
      // strip: the prompt's Images decode files off disk, and a shut prompt that
      // merely stopped painting would keep them decoded for the panel's life —
      // for pictures of windows the user may just have said they do not want
      // kept. Unloaded, the strip does not exist between offers.
      //
      // Everything about the keyboard lives on the panel (consentOpen, the
      // stashed section, the guards in handleMove/moveSection/activateCursor,
      // the Escape chain); the component draws, reports, and reports a press.
      Loader {
        anchors.fill: parent
        active: root.consentOpen
        visible: root.consentOpen
        sourceComponent: ConsentPrompt {
          panel: root
        }
      }
    }
  }
}
