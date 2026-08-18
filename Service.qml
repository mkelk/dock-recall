// Service.qml — the mkelk.dock-recall service.
//
// Three jobs: watch the Hyprland event stream for topology changes, own the
// state file at ~/.local/state/omarchy/dock-recall.json (the contract
// documented in StateModel.js), and RESTORE the recorded layout when the
// topology changes.
//
// The division of labour this file commits to: every DECISION is a pure
// function in engine.js or StateModel.js; QML only holds what a pure function
// cannot — the FileViews, the processes, the timers, and the ordering between
// them. Nothing in here decides where a window belongs.
//
// Reference implementations on this machine:
//   /usr/share/omarchy/shell/plugins/services/idle/Service.qml  (raw events)
//   /usr/share/omarchy/shell/plugins/notifications/Service.qml  (state dir)
//   /usr/share/omarchy/shell/plugins/clipboard/Clipboard.qml    (watched FileView)
//   ~/.config/omarchy/scripts/session-layout                    (dispatch verbs)

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "engine.js" as Engine
import "StateModel.js" as StateModel
// Only for humanizeTopology: the completion toast names the topology, and the
// user reads "Laptop + AOC U34G2G", not "Samsung Display Corp. ATNA60HR07-0 |
// AOC Inc. U34G2G". Nothing else here goes through the panel's model.
import "PanelModel.js" as PanelModel

Item {
  id: root

  // Injected by omarchy-shell (the first-party service loader).
  property var shell: null
  // Injected the same way, and only for one thing: the plugin id, so this
  // service can ask the shell to close THIS plugin's panel before a restore
  // that needs the keyboard. Declared with the same fallback the panel uses —
  // a plugin loaded without a manifest is not a plugin, but a hard-coded id
  // beats a crash.
  property var manifest: null
  readonly property string pluginId: (manifest && manifest.id)
    ? String(manifest.id) : "mkelk.dock-recall"

  // One prefix on every line this plugin logs, so `qs log | grep` is a
  // complete filter — the shell log is shared by every service.
  readonly property string logPrefix: "[dock-recall]"

  readonly property string home: Quickshell.env("HOME")
  // XDG_STATE_HOME, like the notifications service: recorded layouts are user
  // state a `rm -rf ~/.cache` must not take with it.
  readonly property string stateDir: home + "/.local/state/omarchy"
  readonly property string statePath: stateDir + "/dock-recall.json"
  // The manual trigger. Writing ANYTHING to this file starts a restore cycle —
  // it is the whole test surface (and the panel's "Restore now" hook until the
  // panel epic gives the service a real IPC method).
  readonly property string triggerPath: stateDir + "/dock-recall.trigger"
  // What the UI reads. Written by this service and nobody else — see the
  // status schema block in StateModel.js for the contract and the two rules
  // that keep it trustworthy (atomic writes; a failed read publishes nothing).
  readonly property string statusPath: stateDir + "/dock-recall.status.json"
  // Where a cycle that ended badly leaves everything needed to reproduce it.
  // One file per failed cycle, newest 10 kept — see the forensics block in
  // StateModel.js and writeForensics() below.
  readonly property string forensicsDir: stateDir + "/dock-recall-forensics"

  // The parsed state file. Always a valid State (StateModel.parseState never
  // throws and never yields a half-object), so consumers need no guards.
  property var state: StateModel.defaultState()
  property bool stateLoaded: false
  property string lastWrittenText: ""
  // A read-only state file (schema newer than this build — see
  // StateModel.writeRefusal) is a thing the user has to be TOLD, not merely
  // logged at: every edit they make from now on will be turned away. The warning
  // goes in the log on every reload, the toast once per session, because the
  // FileView reloads on every touch of the file and four seconds of toast per
  // touch is how a notification stops being read.
  property bool futureVersionAnnounced: false

  // ------------------------------------------------------------ cycle state
  //
  // A restore CYCLE is what one trigger produces. It runs three settle PASSES,
  // because a topology change lands in stages: the monitor appears, then
  // Hyprland re-homes workspaces, then windows finish redrawing. Planning once
  // and walking away restores against a desktop that is still moving.
  //
  // Each pass runs a convergence LOOP: plan, execute, re-plan, until the plan
  // comes back empty. That is only safe because engine.planRestore is
  // idempotent — a conforming desktop plans to zero ops.

  readonly property var settleDelays: [1000, 3000, 7000]   // ms after the trigger
  readonly property int maxIterations: 5

  // …and the SECOND budget, which is not a second opinion about the first one
  // (tick eqb). A plan made only of tiled refinement ops is one deliberate step
  // of a bounded walk down a split tree: one divider nudge per workspace per
  // plan, n − 1 cuts in a tree of n windows. Seven windows therefore need six
  // iterations, all of them progress, and the general cap of five turned that
  // into a GIVE-UP warning plus a counted failure on a cycle that went on to
  // converge perfectly — a "1 failed" toast for a restore that worked. So
  // refinement iterations are counted separately and capped separately, at
  // engine.TILED_REFINEMENT_MAX_NUDGES, which is where the reasoning for the
  // number lives. The no-progress check is untouched and still stops a stuck
  // refinement on its very next iteration; this bound is only ever reached by a
  // workspace that is genuinely still converging.
  property int refinementIterations: 0
  readonly property int generalIterations: root.iteration - root.refinementIterations

  property bool cycleActive: false
  property bool rerunQueued: false
  // Whether the request that queued the rerun was a MANUAL one. A user who
  // presses Restore while a cycle is finishing has asked for a restore, and a
  // paused tool that silently swallowed the rerun would be the one case where
  // pause eats an explicit instruction.
  property bool rerunManual: false
  property string cycleReason: ""
  // A restore asked for before the state file finished loading, replayed by
  // flushPendingRestore() the moment it has. "" means none is waiting.
  property string pendingRestoreReason: ""
  // …and whether THAT one was manual. Held requests are the one path where the
  // paused flag cannot be consulted when the request arrives — the state file
  // is by definition not loaded yet — so the answer has to be carried until it
  // can be.
  property bool pendingRestoreManual: false
  property int passIndex: 0
  property int iteration: 0

  // What this cycle actually CHANGED, for the completion toast.
  //
  // The accounting is a union of DISTINCT EFFECTS over the whole cycle, not a
  // tally of dispatches. Every pass re-plans, and the convergence loop inside a
  // pass re-plans again, so a single window nudged once was being counted by
  // each iteration that still saw it out of place — "12 moved" for one window.
  // cycleEffects is the dedupe key set ("kind:subject"), reset per cycle, and a
  // counter only moves the first time an effect is seen.
  //
  // The two halves of "honest" here differ on purpose:
  //   move / workspace-monitor / group — counted when DISPATCHED. There is no
  //     cheap confirmation for them, and a rejected verb is already shouted
  //     about as a VERB-ERROR.
  //   launch — counted when CONFIRMED, in waitForIdentity, because that one has
  //     a confirmation (a window appeared) and because a launch the user can
  //     see none of is the least excusable thing to claim credit for. Its
  //     subject carries a per-op serial (launchSerial) so two launches of the
  //     same app are two effects rather than one — see noteEffect.
  property var cycleEffects: ({})
  // Anything that went visibly wrong during the cycle: a rejected dispatch, a
  // launch that never produced a window, a plan that would not converge. It is
  // the only input to the status file's lastResult.ok, so it is deliberately
  // pessimistic — the red dot on the glyph means "look at the log", and a
  // cycle that shouted a VERB-ERROR is exactly that.
  property int cycleFailures: 0
  property int opsMoved: 0
  property int opsLaunched: 0
  property int opsWorkspace: 0
  property int opsGrouped: 0
  property int opsUngrouped: 0
  property int opsFloated: 0
  property int opsPlaced: 0
  // Tiled refinement (tick pyo): swaps and divider nudges together, because
  // they are two halves of one act — putting a workspace's tiling back — and a
  // toast that said "1 swapped, 2 nudged" would be describing the mechanism
  // rather than the outcome.
  property int opsTiled: 0
  property string cycleTopologyKey: ""

  // ------------------------------------------------------- per-op outcomes
  //
  // What the cycle ATTEMPTED, op by op, and what came of each attempt. The
  // counters above say how much was done; this says what was tried and what
  // refused — and it is the only thing that can answer "why is telegram still
  // out of place" with a sentence instead of a shrug.
  //
  //   { seq, kind, subject, identityIds, ok, reason, at }
  //
  // `identityIds` is resolved from the op's window addresses at execution time
  // (an op names addresses; a user names apps), which is what lets a verdict
  // carry blockedBy. `ok` starts true and only ever goes false: an op with two
  // dispatches where the second is rejected did not succeed.
  //
  // Kept until the NEXT cycle starts rather than cleared at the end, because a
  // drift refresh minutes later still wants to say why the last restore left
  // this app where it is.
  property var cycleOutcomes: []
  property int outcomeSeq: 0
  // Every plan this cycle built, in order: { pass, iteration, ops }. Forensics
  // only — a failure's shape is usually in how the plan changed (or did not)
  // from one iteration to the next.
  property var cyclePlans: []

  // The identity a live window belongs to, or "" — the address→app translation
  // an outcome needs. Reads nothing: root.liveClients is whatever the last
  // successful read left.
  function identityForAddress(address) {
    var client = root.clientByAddress(address)
    if (!client) return ""
    return Engine.matchClient(client, StateModel.identities(root.state)) || ""
  }

  function identitiesForAddresses(addresses) {
    var list = addresses || []
    var ids = []
    var seen = ({})
    for (var i = 0; i < list.length; i++) {
      var id = root.identityForAddress(list[i])
      if (!id || seen[id]) continue
      seen[id] = true
      ids.push(id)
    }
    return ids
  }

  // Open the ledger entry for one op. The record is handed to whoever executes
  // the op rather than kept in a "current op" property: executePlan expands the
  // WHOLE plan into steps before the first one runs, so there is no single
  // current op to point at, and a property would name the last op expanded
  // instead of the one executing.
  //
  // There is deliberately NO `if (op.kind === …)` ladder here any more.
  //
  // This function used to enumerate the kinds, and tick qkv's new `geometry` op
  // was not added to the single-window branch: it fell through to the
  // multi-address one, resolved to an EMPTY identity list, and an empty
  // identity list is invisible to engine.blockedByIndex. A geometry op the
  // service loudly REFUSED still left the app's row carrying no blockedBy —
  // silent on the one surface a user reads — and a blank subject in the ledger.
  // The trap was not the missing branch, it was that a list of kinds has to be
  // remembered in three files at once (engine.planAddresses, engine.opSubjectOf
  // and here); so the list is gone rather than corrected.
  //
  // engine.opAddressesOf / engine.opSubjectOf answer from the op's SHAPE, and
  // the identity list follows the same rule: `address`/`addresses` resolve
  // through the live read, an op that names an `identityId` (launch) already
  // has its answer. A future op kind following either convention lands in the
  // ledger complete on the day it is written.
  function beginOp(op) {
    root.outcomeSeq += 1
    var addresses = Engine.opAddressesOf(op)
    var identityIds = addresses.length
      ? root.identitiesForAddresses(addresses)
      : ((op && typeof op.identityId === "string" && op.identityId) ? [op.identityId] : [])
    var subject = Engine.opSubjectOf(op)

    var record = {
      seq: root.outcomeSeq,
      kind: op.kind,
      subject: subject,
      identityIds: identityIds,
      ok: true,
      reason: "",
      at: new Date().toISOString()
    }
    // Reassigned rather than pushed in place: QML property change notification
    // is by assignment, and a debugger or a future binding reading this list
    // must not see an array that never announces itself.
    root.cycleOutcomes = root.cycleOutcomes.concat([record])
    return record
  }

  // Mark an op failed. `identityIds` may be narrowed to the ONE window that
  // refused (a group of four where the third would not join is not four blocked
  // apps), otherwise the op's own list is kept.
  //
  // FIRST REASON WINS — see engine.failOutcome, which owns both rules and is
  // tested there. Used where a failure is worth recording against the op but is
  // not the cycle's business to count (a read that failed before any dispatch
  // went out: nothing was asked of the compositor, so nothing was refused).
  function failOp(record, reason, identityIds) {
    Engine.failOutcome(record, reason, identityIds)
  }

  // Fail an op AND count it against the cycle — the pairing every caller that
  // used to write `cycleFailures += 1` next to a failOp() wanted, and got
  // wrong whenever an op could fail twice. `cycleFailures` is read by
  // lastResult.ok, by the "— N failed" toast and by the forensics gate, so it
  // counts OPS THAT DID NOT LAND: a geometry op whose resize the compositor
  // refuses (VERB-ERROR) and which then confirms as unmoved is one window that
  // did not move, not two failures. engine.failOutcome returns true only on the
  // transition, so the increment happens exactly once per op.
  function failAndCount(record, reason, identityIds) {
    if (Engine.failOutcome(record, reason, identityIds)) root.cycleFailures += 1
  }

  // A serial handed to each launch OP, so two launches of the same app are two
  // distinct effects. The dedupe below is keyed on kind+subject, and a launch's
  // natural subject is the identity id — which made a deficit-of-two cycle (two
  // dispatches, two windows) report "1 launched". Only launch subjects carry
  // it; every other kind's dedupe is unchanged, and has to be: a move re-seen
  // by the next pass is still one window that moved. Reset with cycleEffects,
  // whose keys it appears in.
  property int launchSerial: 0

  function noteEffect(kind, subject) {
    var key = kind + ":" + subject
    if (root.cycleEffects[key]) return
    root.cycleEffects[key] = true
    if (kind === "move") root.opsMoved += 1
    else if (kind === "launch") root.opsLaunched += 1
    else if (kind === "workspace-monitor") root.opsWorkspace += 1
    else if (kind === "group") root.opsGrouped += 1
    else if (kind === "ungroup") root.opsUngrouped += 1
    else if (kind === "floating") root.opsFloated += 1
    else if (kind === "geometry") root.opsPlaced += 1
    else if (kind === "swap" || kind === "divider" || kind === "split") root.opsTiled += 1
  }

  // Live snapshots, refreshed by snapshot() before every plan.
  property var liveClients: []
  property var liveMonitors: []

  function log(message) {
    console.log(root.logPrefix + " " + message)
  }

  function warn(message) {
    console.warn(root.logPrefix + " " + message)
  }

  // ---------------------------------------------------------------- events

  // The topology-changing events. `monitoraddedv2` / `monitorremovedv2` carry
  // id,name,description; the v1 spellings carry just the name and are still
  // emitted alongside v2, so both are listened for — and debounced together,
  // since one hotplug produces both.
  readonly property var topologyEvents: ({
    "monitoraddedv2": true,
    "monitoradded": true,
    "monitorremovedv2": true,
    "monitorremoved": true
  })

  // The events that can change DRIFT without changing the topology — a window
  // dragged to another workspace, an app closed, a workspace pushed to the
  // other monitor, a tab group made or broken, a window floated. engine.driftOf
  // compares FIVE things (monitor, workspace, group, floating, geometry); this
  // list covers four of them, plus the two events that change whether a
  // recorded app is running at all.
  //
  // GEOMETRY IS THE ONE IT CANNOT COVER, and the reason is that no event for it
  // exists. Probed live on Hyprland 0.56.2 (tick ae1, raw socket2 tap on a
  // scratch float on an invisible workspace): an absolute move, an absolute
  // resize, six relative moves and six relative resizes produced ZERO socket2
  // lines between them, in a run where the same tap saw openwindow,
  // windowtitle/v2, activewindow/v2, changefloatingmode, movewindow/v2 and
  // create/destroyworkspace. The compositor announces where a window LIVES, not
  // where it SITS. See docs/state-matrix.md § 4b.
  //
  // activewindowv2 is deliberately NOT listed as a proxy for a mouse drag. It
  // fires when the click SELECTS the window — before the drag — so a refresh
  // debounced 2 s behind it would read the rect the user is still in the middle
  // of changing, and report the old numbers with new confidence. It would also
  // put two hyprctl reads and a status-file write behind every alt-tab in the
  // session. A stale badge until the next real event is the honest cost.
  //
  // The gap this closes: the status file was only ever refreshed on a monitor
  // event, a state-file load or the end of a restore cycle, so dragging a
  // watched window somewhere else left the bar sitting on a driftCount from
  // minutes ago — the amber dot was unreachable by ordinary use, and an open
  // panel showed amber chips beside an "In sync" badge, which is the worst of
  // both: two of our own surfaces contradicting each other.
  //
  // The v2 spellings are listened for beside the v1 ones for the same reason
  // the monitor events are: Hyprland emits both, and the debounce collapses
  // them. Names verified against Hyprland 0.56 and the idle service's own raw
  // event handler (openwindow/closewindow).
  readonly property var driftEvents: ({
    "openwindow": true,
    "closewindow": true,
    "movewindow": true,
    "movewindowv2": true,
    "moveworkspace": true,
    "moveworkspacev2": true,
    "togglegroup": true,
    "moveintogroup": true,
    "moveoutofgroup": true,
    // Floating became a drift dimension in tick 8t4 (engine.driftOf compares
    // it, the "floating" op restores it), so SUPER+T on a watched window has
    // to reach the badge the same way a drag does.
    "changefloatingmode": true
  })

  // The monitor Hyprland last told us has focus. Kept up to date from the
  // focusedmon events and from every monitors read, because after an undock
  // there may be no focused monitor left to ask — and that is precisely when
  // it is read: StateModel.pickFailoverTarget prefers it over "whichever
  // output hyprctl lists first" when focus went away with the removed monitor.
  property string lastFocusedMonitor: ""

  function handleHyprlandEvent(event) {
    var name = String(event && event.name ? event.name : "")
    var data = String(event && event.data ? event.data : "")

    if (name === "focusedmon" || name === "focusedmonv2") {
      root.lastFocusedMonitor = data.split(",")[0]
      return
    }

    if (root.driftEvents[name]) {
      // Not logged: these fire on every window a user opens or drags, and one
      // log line per keystroke-speed event is how a shared log becomes
      // unreadable. The refresh that follows logs its own publish.
      driftDebounceTimer.restart()
      return
    }

    if (!root.topologyEvents[name]) return
    root.log("event " + name + " data=" + data)

    // Failover runs IMMEDIATELY, ahead of the debounce and the settle passes.
    // An undock that leaves focus on a monitor that no longer exists is the
    // freeze this project exists to fix, and waiting a second to fix it is a
    // second of a dead session — worse when the screen is locked, because the
    // lock surface takes input on the focused output.
    //
    // NOT gated on `paused`, deliberately. Pausing says "do not rearrange my
    // windows"; it cannot be allowed to mean "leave the session focused on a
    // monitor that no longer exists", which is the freeze this whole project
    // was written to fix. Failover moves no window and restores no layout — it
    // hands focus to an output that still exists. The skip line below is about
    // the restore cycle, and only that.
    if (name === "monitorremoved" || name === "monitorremovedv2") root.checkFocusFailover(data)

    root.cycleReason = name
    eventDebounceTimer.restart()
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) { root.handleHyprlandEvent(event) }
  }

  // One hotplug fires up to four events (v1 + v2, and a dock can add several
  // outputs). Collapse them into one cycle.
  Timer {
    id: eventDebounceTimer
    interval: 400
    repeat: false
    onTriggered: {
      root.requestRestore(root.cycleReason || "monitor event")
      // Covers the cases requestRestore does NOT start a cycle for (state file
      // not loaded yet, a cycle already running): the topology still changed
      // and the glyph has to follow. A cycle that did start owns the reads and
      // publishes its own status, so this stands down.
      root.refreshStatus("monitor events settled")
    }
  }

  // Window churn is bursty — a drag across workspaces is several events, and a
  // restore cycle's own dispatches produce dozens — so the refresh is coalesced
  // into one read per quiet moment. 2s is picked to be slower than a human
  // finishing a drag and faster than a human wondering whether the bar noticed.
  //
  // No cycle interlock is needed here beyond the one refreshStatus already has:
  // during a restore it stands down (the cycle owns the read machinery and
  // publishes its own status at the end), and the timer that keeps restarting
  // under the cycle's own event storm simply fires once more after it, which
  // republishes identical bytes and costs a skipped write.
  Timer {
    id: driftDebounceTimer
    interval: 2000
    repeat: false
    onTriggered: root.refreshStatus("window events settled")
  }

  // The SLOW POLL — the one thing in this plugin that is not event-driven, and
  // the reason is a compositor limitation rather than a design choice
  // (docs/state-matrix.md §4b, live-proven in tick ae1): Hyprland announces
  // where a window LIVES, never where it SITS. An absolute move, an absolute
  // resize, six relative moves and six relative resizes emitted ZERO events in
  // a run where the same socket tap saw six other event families. So a user who
  // drags or resizes a watched FLOAT in place leaves the badge exactly as it
  // was, for as long as nothing else happens on the desktop — which on a quiet
  // afternoon is hours. (A drag that crosses to another workspace or monitor
  // does fire `movewindow`, and the 2 s debounce above covers it.)
  //
  // 30 s is the bound this puts on that staleness. It is deliberately slow: the
  // event path stays PRIMARY and this is only the floor under it, so the number
  // is chosen to be far below "the user gave up looking" and far above "two
  // hyprctl reads worth noticing". Nothing else in the plugin polls, and this
  // one is switched off whenever it would have nothing to say.
  readonly property int slowPollMs: 30000

  // THE GATE, and it is a binding rather than a check inside the handler on
  // purpose: an idle desk with nothing recorded must issue ZERO extra hyprctl
  // reads, and a timer that fires and then decides not to read has already paid
  // for the wakeup. `running` is false unless the state file is loaded, a
  // layout exists for the topology on screen, the tool is not paused and no
  // cycle is in flight — StateModel.shouldSlowPoll holds the last three so they
  // can be tested in node.
  Timer {
    id: slowPollTimer
    interval: root.slowPollMs
    repeat: true
    running: root.stateLoaded && !root.cycleActive && StateModel.shouldSlowPoll(root.statusModel)
    onTriggered: root.refreshStatus("slow poll")
  }

  // -------------------------------------------------- undock focus failover

  property string removedMonitorName: ""

  function checkFocusFailover(eventData) {
    // v2 carries "id,name,description"; v1 carries the bare name. Either way
    // the first comma-separated field that is not a number is the name — but
    // only logging depends on it, so keep it simple and take the name field.
    var parts = String(eventData || "").split(",")
    root.removedMonitorName = parts.length > 1 ? parts[1] : parts[0]
    // `monitors` without `all`: disabled outputs cannot take focus, so the
    // failover target has to come from the ACTIVE list.
    if (!activeMonitorsProc.running) activeMonitorsProc.running = true
  }

  function evaluateFocusFailover(raw, exitCode, stderrText) {
    var read = StateModel.parseHyprctlArray(raw, exitCode, stderrText)
    if (!read.ok) {
      // Nothing to do but say so: guessing a focus target from a read that
      // failed is how focus lands on an output that is not there.
      root.warn("monitor \"" + root.removedMonitorName + "\" removed but the monitor read FAILED ("
        + read.error + ") — focus left untouched")
      return
    }

    var choice = StateModel.pickFailoverTarget(read.value, root.lastFocusedMonitor)

    if (choice.kind === "none") {
      root.warn("monitor \"" + root.removedMonitorName + "\" removed and no monitor is left — nothing to focus")
      return
    }

    if (choice.kind === "intact") {
      root.lastFocusedMonitor = choice.name
      root.log("monitor \"" + root.removedMonitorName + "\" removed; focus intact on \"" + choice.name + "\"")
      return
    }

    // No surviving monitor claims focus: it went with the monitor that left.
    root.warn("monitor \"" + root.removedMonitorName + "\" removed and took focus with it — failing over to \""
      + choice.name + "\"")
    root.lastFocusedMonitor = choice.name
    failoverProc.command = ["bash", "-c", "hyprctl dispatch \"$1\" 2>&1", "--",
      'hl.dsp.focus({ monitor = "' + choice.name + '" })']
    failoverProc.running = true
  }

  Process {
    id: activeMonitorsProc
    command: ["hyprctl", "monitors", "-j"]
    stdout: StdioCollector { id: activeMonitorsOut; waitForEnd: true }
    stderr: StdioCollector { id: activeMonitorsErr; waitForEnd: true }
    onExited: function (exitCode) {
      root.evaluateFocusFailover(activeMonitorsOut.text, exitCode, activeMonitorsErr.text)
    }
  }

  // Its own Process, deliberately not the step queue's: the failover must not
  // wait behind whatever a restore pass is in the middle of dispatching.
  Process {
    id: failoverProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var output = String(text || "").replace(/^\s+|\s+$/g, "")
        if (output !== "ok") root.warn("VERB-ERROR focus failover -> " + (output || "(no output)"))
        else root.log("focus failover ok")
      }
    }
  }

  // ------------------------------------------------------------ state file

  // Re-reads of a file that exists but did not parse. A writer that truncates
  // before it writes (`cat > file`, or any non-atomic editor) leaves an empty
  // file for a few milliseconds, and the watcher fires on the truncation.
  property int stateReadRetries: 0
  readonly property int maxStateReadRetries: 3

  // `exists` distinguishes the two ways a read fails, and they get opposite
  // treatment:
  //   missing  — create it. That is the one write this service makes on its
  //              own, and the panel and the watcher both need the file to be
  //              there.
  //   unusable — re-read, then LEAVE IT ALONE. Writing a default over a file
  //              that exists is how a service eats somebody's layouts: it lost
  //              a race with a non-atomic writer (measured: sim-dock's seed
  //              vanished exactly this way), or the file is corrupt and the
  //              user still wants to look at it.
  function loadState(raw, exists) {
    var result = StateModel.parseState(raw)
    // Captured before anything is assigned: "did this reload bring a new
    // recording with it?" is a question about the difference between the two
    // states, and root.state is about to stop being the old one.
    var previous = root.state

    if (result.recovered && exists) {
      if (root.stateReadRetries < root.maxStateReadRetries) {
        root.stateReadRetries += 1
        root.log("state file unreadable (" + result.error + ") — re-reading, someone may be mid-write ("
          + root.stateReadRetries + "/" + root.maxStateReadRetries + ")")
        stateRetryTimer.restart()
        return
      }
      root.warn("state file is still unusable after " + root.maxStateReadRetries + " re-reads ("
        + result.error + ") — keeping the last good state in memory and NOT overwriting the file")
      root.stateLoaded = true
      root.stateReadRetries = 0
      root.flushPendingRestore()
      root.refreshStatus("state file unusable")
      return
    }

    root.stateReadRetries = 0

    if (result.recovered) {
      // The file is not there at all: first run. Say so, then write the
      // default — FileView cannot watch a file that does not exist.
      root.warn("no state file (" + result.error + ") — creating a fresh default")
    } else if (result.error) {
      root.warn("state: " + result.error)
      // The only `error` that is not a recovery is a version from the future,
      // and it has a consequence worth spelling out: the file still drives
      // restores, but nothing may write it (tick 291). Said in the same words
      // the refusals themselves use, so the log reads as one story.
      var refusal = StateModel.writeRefusal(result.state)
      if (refusal) {
        root.warn("running READ-ONLY from this file — " + refusal)
        if (!root.futureVersionAnnounced) {
          root.futureVersionAnnounced = true
          root.notify("Dock Recall is read-only",
            "The state file is schema v" + result.state.version + "; this build understands v"
              + StateModel.STATE_VERSION + ". Restores still run, but recording and edits are refused.")
        }
      }
    } else if (result.migrated) {
      // An older schema, upgraded on the way in (v1 -> v2: geometry fields and
      // the paused flag, all additive). Logged, NOT written back: the upgrade
      // is lossless in memory, and rewriting a file nobody asked to change
      // would both undo any backup discipline around it and strand a user who
      // downgrades the plugin. It persists the next time something legitimately
      // writes the file — a Record, a panel edit, a pause toggle.
      root.log("state file upgraded to schema v" + StateModel.STATE_VERSION
        + " on read (geometry + paused are additive; the file on disk is untouched until the next write)")
    }

    // Writable again — the user upgraded the plugin, or moved the newer file
    // aside. Rearm the toast so a second downgrade is announced as loudly as
    // the first.
    if (!StateModel.writeRefusal(result.state)) root.futureVersionAnnounced = false

    // Captured before the assignment, for the same reason `previous` is: the
    // toast below is about the DIFFERENCE, and only a reload that CHANGES the
    // flag is a toggle. The very first load is never one — a shell that starts
    // up paused must not announce that the user just paused it.
    var wasLoaded = root.stateLoaded
    var wasPaused = StateModel.isPaused(previous)

    root.state = result.state
    root.stateLoaded = true
    root.log("state loaded: " + StateModel.identities(result.state).length + " identities, "
      + StateModel.topologyKeys(result.state).length + " layouts"
      + (StateModel.isPaused(result.state) ? ", PAUSED" : ""))

    if (result.recovered) root.writeState(result.state)

    root.notePauseChange(wasLoaded, wasPaused, result.state)
    root.noteLayoutRerecord(previous, result.state)

    // Order matters: a held restore gets replayed first, so that when one is
    // waiting the cycle it starts owns the read machinery and the refresh
    // below stands down — the cycle publishes a fresher status at its end
    // than this one could have.
    root.flushPendingRestore()
    root.refreshStatus("state loaded")
  }

  // The pause switch was flipped: say so, on the bar and in a toast.
  //
  // Detected on the state RELOAD rather than signalled by the panel, for the
  // same reason noteLayoutRerecord is: the panel is not the only writer of this
  // file, and the reload path is where every writer arrives. Flip the flag with
  // an editor and the glyph and the toast still follow.
  //
  // The status echo is published HERE and not left to the refresh that follows,
  // because publishing it needs no live read at all: the flag came out of the
  // file we just read. A hyprctl hiccup must not be able to leave the bar
  // showing an active tool that is not acting.
  function notePauseChange(wasLoaded, wasPaused, next) {
    var paused = StateModel.isPaused(next)
    if (!wasLoaded || paused === wasPaused) return
    root.log(paused
      ? "paused — event-triggered restore cycles will be ignored; the manual trigger still runs"
      : "active — event-triggered restore cycles resume")
    root.publishStatus({}, paused ? "paused" : "activated")
    root.notify(paused ? "Dock Recall paused" : "Dock Recall active")
  }

  // A Record retires the previous restore's verdict.
  //
  // The user arranges the desktop, presses Record, and the ux-sketch promises
  // the badge flips to "In sync" — but lastResult.ok === false outranks drift
  // in glyphState, so a restore that failed an hour ago kept the badge on
  // "Restore failed" and the bar dot red over a layout that was just recorded
  // from what is on screen. The verdict is about a cycle that ran against a
  // layout that no longer exists.
  //
  // Detected here rather than signalled by the panel because the panel is not
  // the only writer (scripts/record-current writes the same file), and the
  // state-reload path is where every writer arrives. Only a change to THIS
  // topology's layout counts — ticking a chip or learning a launch command
  // rewrites the file too and says nothing about any restore.
  function noteLayoutRerecord(previous, next) {
    // No published topology yet means no status worth patching — the first
    // refresh after this load will establish one.
    var key = root.statusModel.topologyKey
    if (!key) return
    // Nothing to retire when there is no verdict, and nothing to retire when
    // the layout was FORGOTTEN rather than re-recorded (the badge goes hollow
    // on its own, and hollow already outranks the verdict).
    if (!root.statusModel.lastResult) return
    var stamp = StateModel.layoutStampFor(next, key)
    if (!stamp) return
    if (stamp === StateModel.layoutStampFor(previous, key)) return
    root.log("layout for \"" + key + "\" was re-recorded — clearing the previous restore verdict")
    root.publishStatus({ lastResult: null }, "layout re-recorded")
  }

  // Replay a restore that was asked for before the state file was readable.
  // Called from every path that sets stateLoaded, and a no-op once nothing is
  // waiting — later reloads of the file must not re-fire an old request.
  function flushPendingRestore() {
    if (!root.pendingRestoreReason) return
    var reason = root.pendingRestoreReason
    var manual = root.pendingRestoreManual
    root.pendingRestoreReason = ""
    root.pendingRestoreManual = false
    root.log("state file is loaded — replaying the held restore request (" + reason + ")")
    // requestRestore now knows whether the tool is paused, which it could not
    // when the request arrived. An event-born request replayed into a paused
    // service is dropped there, with the same log line every other one gets.
    root.requestRestore(reason, manual)
  }

  Timer {
    id: stateRetryTimer
    interval: 200
    repeat: false
    onTriggered: stateFile.reload()
  }

  // Persist a state object. Writing the exact bytes already on disk is skipped:
  // atomic writes replace the file, which wakes the watcher, which reloads —
  // harmless but noisy, and pointless.
  //
  // A state from a NEWER schema than this build is never written (tick 291): the
  // reader strips the fields it does not know and keeps the newer version
  // number, so a write here would quietly delete a later generation's data.
  // Refused out loud, with the reason, exactly as every other refusal in this
  // plugin is. The rule itself lives in StateModel.writeRefusal so this file and
  // Panel.qml cannot drift apart on it.
  function writeState(next) {
    var refusal = StateModel.writeRefusal(next)
    if (refusal) {
      root.warn("not writing the state file: " + refusal)
      return
    }
    var text = StateModel.serializeState(next)
    if (text === root.lastWrittenText && stateFile.loaded) return
    root.lastWrittenText = text
    stateFile.setText(text)
  }

  // Ensure the state DIRECTORY exists, and that the trigger file exists at all
  // — neither FileView can watch a path that is not there, and setText does
  // not mkdir. Also the ONE place the monitor-watch → dock-recall rename is
  // healed (v0.2.0): if the new state file is absent and the old one exists,
  // the state, status and forensics artifacts are MOVED (byte-identical) before
  // anything reads or writes them. The trigger file is deliberately not
  // migrated — its content carries no meaning. Running inside this process is
  // what makes it safe: `startupReady` below keeps the state FileView's
  // creation-time load from writing a fresh default over the not-yet-migrated
  // recordings.
  Process {
    id: ensureStateDirProc
    command: ["bash", "-c",
      "cd \"$1\" 2>/dev/null || mkdir -p \"$1\"; cd \"$1\"; " +
      "if [ ! -e dock-recall.json ] && [ -f monitor-watch.json ]; then " +
      "  mv monitor-watch.json dock-recall.json; " +
      "  [ -f monitor-watch.status.json ] && mv monitor-watch.status.json dock-recall.status.json; " +
      "  [ -d monitor-watch-forensics ] && mv monitor-watch-forensics dock-recall-forensics; " +
      "  echo migrated; " +
      "fi; " +
      "touch \"$2\"; exit 0",
      "--", root.stateDir, root.triggerPath]
    stdout: StdioCollector { id: ensureStateDirOut; waitForEnd: true }
    onExited: {
      if (String(ensureStateDirOut.text).indexOf("migrated") !== -1)
        root.log("state migrated on rename: monitor-watch.* moved to dock-recall.* (bytes untouched)")
      root.log("state-dir ready")
      root.startupReady = true
      stateFile.reload()
      triggerFile.reload()
    }
  }

  // False until ensureStateDirProc has run. The state FileView starts loading
  // the moment it exists, and on a missing file loadState writes a default —
  // which, during the rename migration window, would create dock-recall.json
  // and stop the move above from ever happening. So pre-ready load events are
  // dropped; the reload in onExited above delivers the authoritative first read.
  property bool startupReady: false

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    // The first read of a not-yet-existing file is an expected miss, not
    // something to print a stack trace about; onLoadFailed handles it.
    printErrors: false
    onLoaded: if (root.startupReady) root.loadState(text(), true)
    // The file is not there (first run) or cannot be opened at all — the only
    // case in which this service writes a default over nothing.
    onLoadFailed: if (root.startupReady) root.loadState("", false)
    onFileChanged: reload()
  }

  // The manual trigger. Nothing reads its content for meaning — but a restore
  // fires only when that content CHANGED, which is what makes the trigger
  // usable at all:
  //   - the service touches the file itself at startup so the watcher has
  //     something to attach to, and the reload that follows must not look like
  //     a request to restore;
  //   - a FileView can report the same file more than once during startup.
  // So: WRITE something new to trigger a restore (`date > …/dock-recall.trigger`).
  // A bare `touch` changes no bytes and is deliberately ignored.
  property bool triggerPrimed: false
  property string lastTriggerText: ""

  FileView {
    id: triggerFile
    path: root.triggerPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var content = String(text())
      if (!root.triggerPrimed) {
        root.triggerPrimed = true
        root.lastTriggerText = content
        return
      }
      // `date > trigger` is TWO file events: the shell truncates the file, then
      // writes. The watcher fires on the truncation as well, and an empty read
      // is a different string from the last one — so every trigger started two
      // cycles, the second of which was immediately queued as a rerun. Empty
      // content is never a request, and it is deliberately NOT remembered as
      // lastTriggerText, so the write that follows still counts as new.
      if (!content.replace(/^\s+|\s+$/g, "")) return
      if (content === root.lastTriggerText) return
      root.lastTriggerText = content
      // MANUAL, always: somebody wrote to this file on purpose. This is the one
      // request a paused service still honours in full.
      root.requestRestore("trigger file", true)
    }
    onLoadFailed: root.triggerPrimed = true
  }

  // ----------------------------------------------------------- status file
  //
  // The one thing this service publishes for the UI. Everything about its
  // shape is decided by StateModel (defaultStatus/statusPatchFor/mergeStatus);
  // QML owns only the FileView, the freshness of the reads, and the timing.

  // The last status actually written. Every publish is a PATCH on top of this
  // rather than a rebuild, which is what lets the restore cycle flip
  // `restoring` without knowing the drift count and vice versa.
  property var statusModel: StateModel.defaultStatus()
  property string lastStatusText: ""

  // Write-only FileView: nothing else writes this file, so there is nothing to
  // watch for and no load to wait on. printErrors because the first setText on
  // a path that does not exist yet is an expected miss, not a fault.
  FileView {
    id: statusFile
    path: root.statusPath
    atomicWrites: true
    printErrors: false
  }

  function publishStatus(patch, reason) {
    // `paused` is stamped on EVERY publish from the state file, never passed in
    // by a caller. It is an echo of a value this service does not own (the
    // panel writes it), and one choke point is the only way the echo cannot go
    // stale: a status that said "active" while the state file said "paused"
    // would put a normal glyph on a bar over a tool that is ignoring the
    // desktop.
    //
    // A SHALLOW COPY of the caller's patch, not a merge into it: mergeStatus
    // turns whatever it is given into a whole status, and a partial patch
    // ({ restoring: true }) run through it would arrive carrying an empty
    // topologyKey and a zeroed drift count as if the caller had meant them.
    var stamped = {}
    var source = patch && typeof patch === "object" ? patch : {}
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) stamped[key] = source[key]
    }
    stamped.paused = StateModel.isPaused(root.state)

    var next = StateModel.mergeStatus(root.statusModel, stamped)

    // The humanized name is stamped here for the same reason `paused` is: it is
    // a function of a value no caller carries, and one choke point is the only
    // way it cannot end up naming a different desk than the key beside it.
    //
    // It is stamped at ALL because of who reads it. The bar widget has only
    // this file — no monitor list, and no hyprctl, which is the entire point of
    // publishing a status — so humanizeTopology there cannot recognise a
    // built-in panel and leaves it as "Samsung Display Corp. ATNA60HR07-0".
    // This service does hold the live list, so the name travels with the key.
    //
    // Derived from the key that actually LANDED (a patch need not carry one),
    // and only when there is one: an empty key means nothing was resolvable,
    // and "No monitors" written into the file would be this service asserting
    // something it did not read.
    if (next.topologyKey) {
      next = StateModel.mergeStatus(next, {
        topologyName: PanelModel.humanizeTopology(next.topologyKey, root.liveMonitors)
      })
    }

    var text = StateModel.serializeStatus(next)
    root.statusModel = next
    // Same reasoning as writeState: an atomic write replaces the file and
    // wakes every watcher, and republishing identical bytes only costs the
    // bar widget a reload.
    if (text === root.lastStatusText) return
    root.lastStatusText = text
    statusFile.setText(text)
    root.log("status published (" + reason + "): topology \"" + next.topologyKey + "\" recorded="
      + next.recorded + " drift=" + next.driftCount + " restoring=" + next.restoring
      + (next.paused ? " paused=true" : ""))
  }

  // The verdict table for a drift report, with the last cycle's per-op
  // outcomes folded in as blockedBy.
  //
  // The outcomes are only offered when they are about THIS topology. A cycle
  // that failed to join a group while docked says nothing about the same app
  // on the laptop alone, and carrying its reason across a hotplug would be the
  // UI explaining a mismatch with the story of a different desktop.
  function verdictsNow(driftReport) {
    if (!driftReport) return []
    var sameTopology = root.cycleTopologyKey
      && root.cycleTopologyKey === (driftReport.topologyKey || "")
    return Engine.verdictsFor(driftReport, sameTopology ? root.cycleOutcomes : [])
  }

  // Recompute the live half of the status (topology, recorded, driftCount)
  // from a FRESH read, and publish it.
  //
  // Two abort paths, and neither of them writes anything — this is the whole
  // reason the status is patched rather than rebuilt. A failed hyprctl read
  // and a mid-hotplug moment with no resolvable topology both look, to a naive
  // recompute, exactly like "nothing is recorded for this setup", and the bar
  // glyph would go hollow on a machine whose layout is on file.
  function refreshStatus(reason) {
    if (!root.stateLoaded) return
    // The restore cycle owns the read machinery while it runs (one Process,
    // one callback slot), and it ends with a refresh of its own — so there is
    // nothing to queue here, only a collision to stay out of.
    if (root.cycleActive || clientsProc.running || monitorsProc.running) return

    root.snapshot(function (ok) {
      if (!ok) {
        root.warn("status refresh (" + reason + ") abandoned: the live read failed"
          + " — leaving the last published status alone")
        return
      }
      var key = Engine.topologyKey(root.liveMonitors)
      var layout = key ? StateModel.layoutFor(root.state, key) : null
      var drift = layout
        ? Engine.driftOf(root.liveClients, root.liveMonitors, layout, StateModel.identities(root.state))
        : null
      // Published on EVERY refresh, not only at the end of a cycle: the table
      // is a statement about the desktop as it is now, and a user who drags a
      // window out of its group gets the precise reason on the row two seconds
      // later without pressing anything.
      var patch = StateModel.statusPatchFor(key, layout, drift, root.verdictsNow(drift))
      if (!patch) {
        root.warn("status refresh (" + reason + ") abandoned: the monitor list resolves to no topology at all"
          + " (" + root.liveMonitors.length + " monitors) — leaving the last published status alone")
        return
      }
      root.publishStatus(patch, reason)
    })
  }

  // ------------------------------------------------------- reading the live
  //
  // Everything the planner needs comes from two hyprctl reads, in the exact
  // shape the Layer-1 fixtures were captured in.
  //
  // EVERY read reports whether it SUCCEEDED, and every caller has to look. A
  // read that failed used to arrive as an empty array, indistinguishable from a
  // desktop with nothing open — and the restore plan for a desktop with nothing
  // open is "launch every recorded app". One hiccup from hyprctl duplicated the
  // user's whole session. Exit code and stderr are now part of the answer
  // (StateModel.parseHyprctlArray decides), and a failed read leaves
  // liveClients/liveMonitors untouched rather than blanking them.

  property var clientsCallback: null
  property var monitorsCallback: null

  // done(ok) — ok === false means "do not plan against this".
  function readClients(done) {
    root.clientsCallback = done || null
    clientsProc.running = true
  }

  function readMonitors(done) {
    root.monitorsCallback = done || null
    monitorsProc.running = true
  }

  // Both reads, in order, then done(ok). Monitors are read with `all` so a
  // disabled-but-present output still counts towards the topology key, exactly
  // as engine.topologyKey documents. A failed clients read short-circuits: the
  // monitors are of no use without them.
  function snapshot(done) {
    root.readClients(function (ok) {
      if (!ok) {
        if (done) done(false)
        return
      }
      root.readMonitors(done)
    })
  }

  Process {
    id: clientsProc
    command: ["hyprctl", "clients", "-j"]
    stdout: StdioCollector { id: clientsOut; waitForEnd: true }
    stderr: StdioCollector { id: clientsErr; waitForEnd: true }
    onExited: function (exitCode) {
      var read = StateModel.parseHyprctlArray(clientsOut.text, exitCode, clientsErr.text)
      if (read.ok) root.liveClients = read.value
      else root.warn("READ-FAILED hyprctl clients: " + read.error + " — refusing to treat that as an empty desktop")
      var done = root.clientsCallback
      root.clientsCallback = null
      if (done) done(read.ok)
    }
  }

  Process {
    id: monitorsProc
    command: ["hyprctl", "monitors", "all", "-j"]
    stdout: StdioCollector { id: monitorsOut; waitForEnd: true }
    stderr: StdioCollector { id: monitorsErr; waitForEnd: true }
    onExited: function (exitCode) {
      var read = StateModel.parseHyprctlArray(monitorsOut.text, exitCode, monitorsErr.text)
      if (read.ok) {
        root.liveMonitors = read.value
        for (var i = 0; i < root.liveMonitors.length; i++) {
          if (root.liveMonitors[i].focused === true) root.lastFocusedMonitor = root.liveMonitors[i].name
        }
      } else {
        root.warn("READ-FAILED hyprctl monitors: " + read.error + " — refusing to plan against an unknown topology")
      }
      var done = root.monitorsCallback
      root.monitorsCallback = null
      if (done) done(read.ok)
    }
  }

  function clientByAddress(address) {
    for (var i = 0; i < root.liveClients.length; i++) {
      if (root.liveClients[i].address === address) return root.liveClients[i]
    }
    return null
  }

  // ------------------------------------------------------- the user's focus
  //
  // Tick 35n's placement choreography focuses a window on the destination
  // workspace before each move, because that is the only thing that decides
  // which tile the arrival splits (docs/state-matrix.md § Tiled placement § 4).
  // The probe also measured the price: focusing a window on a HIDDEN workspace
  // pulls that workspace onto the monitor (§ 5). So every one of those focuses
  // has to be given back, and this is where the service remembers to whom.
  //
  // Read out of the client list the pass already took — `focusHistoryID` 0 is
  // the focused window — rather than a second `hyprctl activewindow`: a
  // dispatch per op is exactly the kind of cost that gets added once and never
  // removed, and the answer is already in hand.
  //
  // Captured ONCE PER CYCLE, on the first read that finds a focused window, and
  // deliberately not refreshed per iteration: by iteration two the focus is
  // whatever this choreography last set, so re-reading would let one dropped
  // refocus turn a scratch window into "home" for the rest of the cycle.
  property string focusHome: ""

  function noteFocusHome() {
    if (root.focusHome) return
    for (var i = 0; i < root.liveClients.length; i++) {
      if (root.liveClients[i].focusHistoryID === 0) {
        root.focusHome = String(root.liveClients[i].address || "")
        return
      }
    }
  }

  // Which workspaces have had their SHAPE given up on for this pass.
  //
  // Keyed by workspace id, filled in by the focus read-back below, cleared at
  // the start of every pass. Per pass and not per cycle on purpose: the usual
  // reason a focus does not land is that something else holds the keyboard, and
  // the two things this tick does about that — closing the panel before a
  // choreographed plan, and standing the shape down when the focus misses — are
  // both allowed to have worked by the time the next settle pass runs.
  property var shapeAbandoned: ({})

  // Did the focus land where the choreography aimed it?
  //
  // The choreography's ONLY input is this: dwindle splits the tile of the
  // window that holds the focus (state-matrix § Tiled placement § 4), so a
  // focus that did not arrive means the arrival splits whatever tile the mouse
  // pointer happens to be over — the pointer fallback the whole mechanism
  // exists to remove — and the workspace is built in a shape nobody chose. That
  // was unverified until tick eqb: every dispatch answered "ok" (the focus verb
  // answers "ok" whether or not a layer surface is holding the keyboard) and
  // the only symptom was a score.
  //
  // `hyprctl activewindow` and not the clients read, because they answer two
  // different questions. focusHistoryID 0 is the last window to have held the
  // focus, which is still populated while a layer surface — this plugin's own
  // panel, a launcher, a notification with a text field — has taken the
  // keyboard away from every window. `activewindow` is empty in exactly that
  // case, which is exactly the case worth catching.
  //
  // A READ that fails is not a focus that failed: exit code non-zero, or output
  // that is not JSON, leaves the choreography alone and says so. Standing the
  // shape down on a broken read would trade a rare wrong shape for a common
  // one.
  property var activeWindowCallback: null

  function readActiveWindow(done) {
    root.activeWindowCallback = done || null
    activeProc.running = true
  }

  Process {
    id: activeProc
    command: ["hyprctl", "activewindow", "-j"]
    stdout: StdioCollector { id: activeOut; waitForEnd: true }
    stderr: StdioCollector { id: activeErr; waitForEnd: true }
    onExited: function (exitCode) {
      var address = ""
      var ok = exitCode === 0
      if (ok) {
        try {
          var parsed = JSON.parse(String(activeOut.text || "{}"))
          // `{}` — a valid answer meaning "no window has the focus", which is
          // what a focused layer surface produces. Not a failure: an empty
          // address with ok = true is the read saying the focus is nowhere.
          address = (parsed && parsed.address) ? String(parsed.address) : ""
        } catch (e) {
          ok = false
          root.warn("READ-FAILED hyprctl activewindow: " + e
            + " — not treating that as a focus that missed")
        }
      } else {
        root.warn("READ-FAILED hyprctl activewindow: exit " + exitCode + " "
          + String(activeErr.text || "").replace(/^\s+|\s+$/g, "")
          + " — not treating that as a focus that missed")
      }
      var done = root.activeWindowCallback
      root.activeWindowCallback = null
      if (done) done(ok, address)
    }
  }

  // The step that follows every focus dispatch in the placement choreography.
  //
  // On a miss it stands the SHAPE down and nothing else: the move itself still
  // runs, because the window genuinely does belong on that workspace and a
  // window left behind is a worse restore than a window in the wrong tile. What
  // it stops is the pretence — the op is failed with a sentence that says the
  // shape was not attempted, the rest of this workspace's moves this pass go out
  // as plain moves with no focus at all, and nothing silently falls back to the
  // pointer while claiming a placement it did not make.
  //
  // failOp and not failAndCount, deliberately. The cycle's failure count drives
  // the "— N failed" half of the toast and the red dot, and it counts ops that
  // did not land; this move DID land. What did not happen is an approximation
  // this project grades nowhere, measures in `docs/bench`, and is honest about
  // in the ledger row the panel shows.
  function verifyFocusStep(op, outcome) {
    return { kind: "fn", fn: function (done) {
      root.readActiveWindow(function (ok, address) {
        if (!ok) { done(); return }
        if (address && address === op.splitParent) { done(); return }
        root.shapeAbandoned[String(op.workspaceId)] = true
        root.warn("placement choreography: focus at the split parent " + op.splitParent
          + " did not land (activewindow reads " + (address || "no window — a layer surface has the keyboard")
          + ") — standing the shape down for workspace " + op.workspaceId
          + " this pass; the moves still go out, with no focus and no pointer fallback")
        root.failOp(outcome, "focus did not land — placement shape not attempted")
        done()
      })
    } }
  }

  // Hand the keyboard back. Returns [] when there is nobody to hand it to —
  // an empty desktop, or a focused window that has closed since — because a
  // focus dispatch at an address that is gone is answered and does nothing,
  // and would leave the user's focus on the scratch window we borrowed.
  function refocusHomeSteps() {
    if (!root.focusHome) return []
    if (!root.clientByAddress(root.focusHome)) return []
    return [root.dispatchStep('hl.dsp.focus({ window = "address:' + root.focusHome + '" })',
      "focus home " + root.focusHome)]
  }

  // ------------------------------------------------------------ step engine
  //
  // One flat queue of steps, run strictly in order through a single Process.
  // A step that only knows what to do once it has seen live state (join this
  // group; did the launch appear?) PREPENDS the steps it decided on, so the
  // queue stays flat and there is never more than one Process in flight.
  //
  //   { kind: "dispatch", payload, label }  — one hyprctl dispatch
  //   { kind: "wait", ms }                  — let the compositor settle
  //   { kind: "fn", fn: function(done) }    — decide, optionally prepend, done()

  property var stepQueue: []
  property var stepsDoneCb: null
  property var currentStep: null

  function runSteps(steps, done) {
    root.stepQueue = steps || []
    root.stepsDoneCb = done || null
    root.nextStep()
  }

  function prependSteps(steps) {
    root.stepQueue = (steps || []).concat(root.stepQueue)
  }

  function nextStep() {
    if (root.stepQueue.length === 0) {
      var done = root.stepsDoneCb
      root.stepsDoneCb = null
      if (done) done()
      return
    }

    var step = root.stepQueue[0]
    root.stepQueue = root.stepQueue.slice(1)

    if (step.kind === "dispatch") {
      root.currentStep = step
      // The Lua payload travels as an argv element, never through shell
      // quoting: launch commands and window titles contain quotes, and a
      // single stray one would otherwise rewrite the command. 2>&1 so a
      // dispatch error lands in the one stream we read.
      execProc.command = ["bash", "-c", "hyprctl dispatch \"$1\" 2>&1", "--", step.payload]
      execProc.running = true
      return
    }

    if (step.kind === "wait") {
      stepWaitTimer.interval = step.ms
      stepWaitTimer.restart()
      return
    }

    if (step.kind === "fn") {
      step.fn(function () { root.nextStep() })
      return
    }

    root.nextStep()
  }

  Timer {
    id: stepWaitTimer
    repeat: false
    onTriggered: root.nextStep()
  }

  Process {
    id: execProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var step = root.currentStep
        root.currentStep = null
        var output = String(text || "").replace(/^\s+|\s+$/g, "")
        // Every successful `hyprctl dispatch` answers exactly "ok". Anything
        // else is the compositor rejecting the verb or its arguments — the
        // failure mode this whole project has to be able to see, since a bad
        // dispatch is silent otherwise and just makes the plan never converge.
        if (output !== "ok") {
          root.warn("VERB-ERROR " + (step ? step.label : "dispatch") + " -> " + (output || "(no output)")
            + " | payload: " + (step ? step.payload : "?"))
          // The compositor's own words, verbatim, so the verdict says what it
          // said rather than a paraphrase of it — and, being the FIRST thing to
          // go wrong on this op, the words the row keeps: the confirm read that
          // follows can only report the symptom of this sentence.
          if (step && step.outcome) {
            root.failAndCount(step.outcome, "compositor refused " + (step.label || "the dispatch")
              + ": " + (output || "(no output)"))
          } else {
            // A dispatch with no ledger record behind it (a focus step, a
            // cleanup toggle) has no op to attribute the failure to, so it
            // counts on its own rather than not at all.
            root.cycleFailures += 1
          }
        }
        root.nextStep()
      }
    }
  }

  // `outcome` (optional) is the ledger record this dispatch belongs to, so a
  // VERB-ERROR lands on the op the user can see rather than only in the log.
  function dispatchStep(payload, label, outcome) {
    return { kind: "dispatch", payload: payload, label: label, outcome: outcome || null }
  }

  // engine.opToCommand returns complete shell strings (`hyprctl dispatch
  // '<lua>'`). Peel the single-quoted payload back out rather than handing the
  // string to a shell: see the quoting note in nextStep.
  function stepFromEngineCommand(command, label, outcome) {
    var match = String(command).match(/^hyprctl dispatch '([\s\S]*)'$/)
    if (!match) {
      root.warn("unrecognized engine command, skipped: " + command)
      return null
    }
    return root.dispatchStep(match[1], label, outcome)
  }

  function focusStep(address) {
    return root.dispatchStep('hl.dsp.focus({ window = "address:' + address + '" })', "focus " + address)
  }

  // Create or dissolve the group a NAMED window is in, without going through
  // focus. See the live-verified selector notes in engine.js: group.toggle
  // honours `window = "address:…"`, and doing it this way is what makes a group
  // rebuild work while the panel holds the keyboard.
  function groupToggleStep(address, label, outcome) {
    return root.dispatchStep('hl.dsp.group.toggle({ window = "address:' + address + '" })', label, outcome)
  }

  // ------------------------------------------------------------- op → steps

  function stepsForOp(op) {
    var outcome = root.beginOp(op)

    if (op.kind === "launch") return root.stepsForLaunch(op, outcome)
    if (op.kind === "group") {
      root.noteEffect("group", (op.addresses || []).join("+"))
      // Everything about a group depends on live state (who is grouped with
      // whom right now), so the work is decided at execution time.
      return [{ kind: "fn", fn: function (done) { root.executeGroup(op, outcome, done) } }]
    }
    if (op.kind === "ungroup") {
      // Same reason as "group": which toggles actually dissolve something is a
      // live-state question, answered per member by the claim-based machinery.
      return [{ kind: "fn", fn: function (done) { root.executeUngroup(op, outcome, done) } }]
    }
    if (op.kind === "floating") {
      // The float dispatcher is a TOGGLE on this compositor (live-verified,
      // see the evidence block in engine.js), so it must never run blind — a
      // window that is already right would be flipped wrong. Decided against a
      // fresh read at execution time.
      return [{ kind: "fn", fn: function (done) { root.executeFloating(op, outcome, done) } }]
    }
    if (op.kind === "geometry") {
      // Both dispatches ARE idempotent, so unlike the float toggle this one
      // would survive a stale plan. It still goes through a read: the plan was
      // built before the moves and the float toggle ran, and the one thing the
      // read has to establish is that the window is still FLOATING — the resize
      // half aimed at a tiled window rearranges the dwindle split and answers
      // "ok" (tick y29). See executeGeometry.
      return [{ kind: "fn", fn: function (done) { root.executeGeometry(op, outcome, done) } }]
    }
    if (op.kind === "swap") {
      return [{ kind: "fn", fn: function (done) { root.executeSwap(op, outcome, done) } }]
    }
    if (op.kind === "divider") {
      return [{ kind: "fn", fn: function (done) { root.executeDivider(op, outcome, done) } }]
    }
    if (op.kind === "split") {
      // FOCUS, TOGGLESPLIT, KEYBOARD BACK — the same bracketing a choreographed
      // move uses, and for the same reason: `togglesplit` has no window selector
      // (it flips the FOCUSED window's parent node), so the focus is the aim,
      // and holding it for longer than the dispatch takes the user's screen to
      // a workspace they did not ask to see.
      return root.stepsForSplit(op, outcome)
    }

    var commands = Engine.opToCommand(op)
    if (!commands.length) {
      root.warn("op produced no command, skipped: " + JSON.stringify(op))
      root.failOp(outcome, "the engine produced no dispatch for this op")
      return []
    }

    if (op.kind === "move") root.noteEffect("move", op.address)
    if (op.kind === "workspace-monitor") {
      root.noteEffect("workspace-monitor", op.workspaceId + "@" + op.monitorName)
    }

    // A CHOREOGRAPHED move is a move the planner stamped with the window whose
    // tile the arrival has to split; engine.opToCommand puts exactly one focus
    // dispatch in front of it and the move second (see opToCommand's move
    // branch, which is the only place that ordering is decided).
    var choreographed = op.kind === "move" && !!op.splitParent
    var abandoned = choreographed && root.shapeAbandoned[String(op.workspaceId)] === true
    if (abandoned) {
      root.log("placement: workspace " + op.workspaceId + " already lost its shape this pass —"
        + " moving " + op.address + " plainly, with no focus")
    }

    var steps = []
    for (var i = 0; i < commands.length; i++) {
      var isFocus = choreographed && i === 0
      // The shape is already gone for this workspace: sending the focus anyway
      // would take the user's screen to a hidden workspace to buy nothing.
      if (isFocus && abandoned) continue
      var step = root.stepFromEngineCommand(commands[i], op.kind, outcome)
      if (!step) continue
      steps.push(step)
      if (isFocus) steps.push(root.verifyFocusStep(op, outcome))
    }

    // A move that names a split parent borrowed the keyboard to do it. Give it
    // back IMMEDIATELY — not once at the end of the plan — because the borrow
    // is visible: the focus dispatch pulled the destination workspace onto the
    // monitor, and holding it there for the length of a plan is the difference
    // between a flicker and the user's screen being taken away for a second.
    // Measured either way in tick or5: bracketing each move changed no tree.
    //
    // The refocus is attributed to no op. It is not work the recording asked
    // for, and a failure to hand the keyboard back is not the move failing —
    // the window did land where the plan said. The focus dispatch IN FRONT of
    // the move is attributed to the op, because a focus that did not land means
    // the arrival split the wrong tile, and that is exactly the fidelity tick
    // 35n exists to buy — and since tick eqb it is READ BACK rather than
    // assumed (verifyFocusStep, just above).
    //
    // …and it is handed back only when a focus was actually sent. A workspace
    // whose shape has already been stood down borrowed nothing this time, so
    // there is nothing to give back.
    if (choreographed && !abandoned) steps = steps.concat(root.refocusHomeSteps())

    return steps
  }

  // ONE FLIP of one dwindle node (tick uk5).
  //
  // The whole safety of this op is in the focus. `togglesplit` names no window —
  // it flips the parent node of whatever is focused — so a dispatch sent while
  // the focus is somewhere else does not miss, it flips the WRONG node, on a
  // workspace the user may not even be looking at. That is a shape nobody
  // recorded, produced silently, and it is the one failure mode this op has.
  //
  // So the focus is READ BACK before the toggle goes out, exactly as tick eqb
  // made the placement choreography do, and a focus that did not land stands the
  // flip down for this pass with a counted failure rather than dispatching
  // anyway. The plan is idempotent: the next pass asks again, and if the panel
  // was what held the keyboard it has been closed by then.
  function stepsForSplit(op, outcome) {
    var commands = Engine.opToCommand(op)
    if (commands.length !== 2) {
      root.warn("split: the engine produced no dispatch for " + JSON.stringify(op))
      root.failOp(outcome, "the engine produced no dispatch for this split flip")
      return []
    }
    var focusFirst = root.stepFromEngineCommand(commands[0], "split focus " + op.address, outcome)
    var toggle = root.stepFromEngineCommand(commands[1], "split " + op.address, outcome)
    if (!focusFirst || !toggle) {
      root.failOp(outcome, "the split flip could not be turned into dispatches")
      return []
    }

    var verify = { kind: "fn", fn: function (done) {
      root.readActiveWindow(function (ok, address) {
        if (ok && address && address === op.address) {
          root.noteEffect("split", op.address)
          root.prependSteps([toggle])
          done()
          return
        }
        root.warn("split: the focus at " + op.address + " did not land (activewindow reads "
          + (address || "no window — a layer surface has the keyboard")
          + ") — NOT dispatching togglesplit, which would flip whichever node the"
          + " compositor is holding instead of the one the recording names")
        root.failAndCount(outcome, "the focus the split flip needs did not land")
        done()
      })
    } }

    return [focusFirst, verify].concat(root.refocusHomeSteps())
  }

  function stepsForLaunch(op, outcome) {
    var command = StateModel.launchCommandFor(root.state, op.identityId)
    if (!command) {
      // A launch-less identity is a deliberate choice (see the Identity schema
      // note), not an error — but it does mean this app can never converge, so
      // say so once per pass rather than silently looping.
      root.log("identity \"" + op.identityId + "\" is not running and has no launch command — leaving it")
      root.failOp(outcome, "no launch command is recorded for this app")
      return []
    }
    if (command.indexOf("]]") !== -1) {
      // The command travels inside a Lua long string; a `]]` inside it would
      // close the literal early and turn the rest into syntax.
      root.warn("launch command for \"" + op.identityId + "\" contains ]] and cannot be dispatched: " + command)
      root.failOp(outcome, "its launch command contains ]] and cannot be dispatched")
      return []
    }

    // The launch command is an IDENTITY-level fact and stays one: two windows of
    // an app are opened by running the same command twice. Which is why a
    // deficit of two is two launch ops with the same payload, and why they have
    // to run SERIALLY — see the ctx below.
    //
    // `ctx` is filled in at EXECUTION time rather than here. A plan with a
    // deficit of two builds both launches' steps up front (executePlan), so a
    // baseline captured now would be the same for both, and the second launch
    // would see the FIRST window and stop waiting the moment it was dispatched.
    // The `fn` step runs immediately before its own dispatch, when
    // root.liveClients is the read the previous wait just refreshed.
    var ctx = ({ before: ({}), expected: 1, serial: 0 })

    // NOT counted here: a dispatched `exec_cmd` is a hope, not a launch. The
    // count lands in waitForIdentity, once a window has actually shown up.
    return [
      { kind: "fn", fn: function (done) {
        // What was already on screen when we dispatched. Free: no new read. It
        // exists so a failed launch can name the windows that DID turn up (see
        // waitForIdentity), and so the wait knows what "one more" means.
        ctx.before = root.addressSet(root.liveClients)
        ctx.expected = root.liveWindowCountFor(op.identityId) + 1
        // This op's own effect key. Taken here, once per launch op, so the
        // count in the toast is a count of launches and not of app names.
        root.launchSerial += 1
        ctx.serial = root.launchSerial
        done()
      } },
      root.dispatchStep("hl.dsp.exec_cmd([[" + command + "]])", "launch " + op.identityId, outcome),
      { kind: "fn", fn: function (done) {
        root.waitForIdentity(op.identityId, 0, done, ctx.before, outcome, ctx.expected, ctx.serial)
      } }
    ]
  }

  // How many windows of an identity are open in the last read. 0 for an
  // identity that is not on the watched list at all.
  function liveWindowCountFor(identityId) {
    var identity = StateModel.identityById(root.state, identityId)
    if (!identity) return 0
    return Engine.liveWindowCount(root.liveClients, identity, StateModel.identities(root.state))
  }

  // { "<address>": true } for a client list.
  function addressSet(clients) {
    var set = ({})
    var list = clients || []
    for (var i = 0; i < list.length; i++) {
      var address = list[i] ? String(list[i].address || "") : ""
      if (address) set[address] = true
    }
    return set
  }

  // The classes of the windows present now that were not in `before`, deduped
  // and comma-joined. Reads nothing: root.liveClients was refreshed by the poll
  // that is about to give up.
  //
  // This is the line that turns "launch produced no window" from a dead end
  // into a diagnosis: the launch command worked and opened SOMETHING, it just
  // wasn't the class the identity watches (the shared-Chromium bug wrote
  // `--app=…gmail` as chromium's launch, so the window that appeared was
  // chrome-mail.google.com…, and the WARN now says so).
  function launchedClassesSince(before) {
    var seen = ({})
    var out = []
    var known = before || ({})
    var list = root.liveClients || []
    for (var i = 0; i < list.length; i++) {
      var client = list[i]
      if (!client) continue
      var address = String(client.address || "")
      if (!address || known[address]) continue
      var name = String(client.class || client.initialClass || "?")
      if (seen[name]) continue
      seen[name] = true
      out.push(name)
    }
    return out.join(", ")
  }

  // Poll until the identity has `expected` windows open ANYWHERE (10s cap).
  // Anywhere, not on the target workspace: a cold Electron start can take
  // longer than the wait, and the next re-plan moves whatever it finds. The
  // match is engine.clientsFor, so launch-detection and record-time matching
  // can never disagree.
  //
  // EXPECTED-COUNT semantics (tick l64). `expected` defaults to 1, which is
  // "any window of this app exists" — exactly what this did before schema v3,
  // and what every deficit-of-one launch still asks for. A deficit of two asks
  // for 2 on the second launch, so the two dispatches cannot collapse into one
  // wait that was already satisfied. The timeout is PER INSTANCE and keeps the
  // behavior it always had: warn with the classes that did appear, count the
  // failure, and continue — a second window that never opens must not strand
  // the ops queued behind it.
  readonly property int launchPollMs: 500
  readonly property int launchTimeoutMs: 10000

  // The address of the window this launch actually opened: the one matching
  // client that was NOT already on screen when the command was dispatched.
  // "" when every match predates the dispatch, which is the honest answer when
  // the wait was satisfied by a window somebody else opened.
  //
  // Naming clients[length - 1] instead — hyprctl's own listing order, which is
  // neither creation order nor stable — could put a window the user has had
  // open for an hour into a line that reads "launched foo -> 0x…".
  function newAddressSince(clients, before) {
    var known = before || ({})
    var list = clients || []
    for (var i = list.length - 1; i >= 0; i--) {
      var address = list[i] ? String(list[i].address || "") : ""
      if (address && !known[address]) return address
    }
    return ""
  }

  // `before` is the address set from dispatch time (stepsForLaunch): it names
  // the window this launch opened on success, and the windows that turned up
  // instead on failure.
  //
  // `serial` is this launch op's effect key — see noteEffect.
  function waitForIdentity(identityId, waitedMs, done, before, outcome, expected, serial) {
    var want = (typeof expected === "number" && expected > 1) ? expected : 1
    root.readClients(function (ok) {
      // A failed read is not evidence the window is missing — poll again. The
      // 10s cap still ends this eventually.
      var identity = ok ? StateModel.identityById(root.state, identityId) : null
      var clients = identity
        ? Engine.clientsFor(root.liveClients, identity, StateModel.identities(root.state))
        : []
      if (clients.length >= want) {
        root.noteEffect("launch", identityId + "#" + (typeof serial === "number" ? serial : 0))
        var opened = root.newAddressSince(clients, before)
        root.log("launched " + identityId + " -> "
          + (opened || (clients[clients.length - 1].address + " (unconfirmed)"))
          + (want > 1 ? " (window " + want + " of " + want + " so far)" : ""))
        done()
        return
      }
      if (waitedMs >= root.launchTimeoutMs) {
        var appeared = root.launchedClassesSince(before)
        root.warn("launch of \"" + identityId + "\" produced no window within "
          + (root.launchTimeoutMs / 1000) + "s — continuing without it"
          + (want > 1 ? " (waiting for window " + want + " of this app)" : "")
          + (appeared
            ? " (windows that did appear since the dispatch: " + appeared + ")"
            : " (no new window appeared at all)"))
        root.failAndCount(outcome, "launch produced no window within " + (root.launchTimeoutMs / 1000) + "s"
          + (appeared ? " (saw " + appeared + " instead)" : ""))
        done()
        return
      }
      root.prependSteps([
        { kind: "wait", ms: root.launchPollMs },
        { kind: "fn", fn: function (next) { root.waitForIdentity(identityId, waitedMs + root.launchPollMs, next, before, outcome, want, serial) } }
      ])
      done()
    })
  }

  // A group is rebuilt, never patched: dissolve whatever grouping the recorded
  // members are in, then tab them together in RECORDED ORDER. Ported from
  // session-layout, which learned each of these the hard way, and then taught
  // to care about the order (user gate finding 4).
  //
  // Nothing is queued ahead of time. Each stage queues the next one only once
  // it has seen the previous one land, which is what makes "the order came out
  // wrong, start over" possible at all: a pre-queued rebuild would have the
  // rest of the failed attempt's joins still sitting in front of it.
  function executeGroup(op, outcome, done) {
    var addresses = (op.addresses || []).slice()
    var missing = op.missing || []

    if (missing.length) {
      // Said once per group op, not per member: a partial group is a normal
      // outcome (the user closed an app), but which app is missing is the
      // difference between "as recorded" and "as recorded, minus Slack".
      root.log("group " + addresses.join("+") + ": recorded member(s) "
        + missing.join(", ") + " are not here — grouping the " + addresses.length + " that are")
    }

    if (addresses.length < 2) {
      done()
      return
    }

    root.prependSteps([
      { kind: "fn", fn: function (next) { root.rebuildGroup(op, 0, outcome, next) } }
    ])
    done()
  }

  // One full attempt: dissolve every member's current grouping, create the
  // group around the first recorded window, then join the rest in order.
  //
  // The dissolve list is decided from a live read rather than from op.addresses
  // alone, because after a suspend/resume the members' `grouped` arrays can
  // DISAGREE about who is in the group (see the split-brain block in
  // engine.js). Two things follow, and both are what Engine.dissolveTargets
  // returns:
  //   - a member whose own array under-reports is still dissolved, on the
  //     strength of its peers naming it;
  //   - a window that is not a recorded member but is tangled in the same claim
  //     is dissolved too, because group.toggle acts on whole groups and leaving
  //     it in place leaves the rebuild fighting a group it did not make.
  // A member nobody claims is left alone: toggling a genuinely ungrouped window
  // CREATES a solo group, which is the state we are here to remove.
  function rebuildGroup(op, attempt, outcome, done) {
    var addresses = op.addresses || []

    root.prependSteps([
      {
        kind: "fn",
        fn: function (next) {
          root.readClients(function (ok) {
            // A read that failed says nothing about who is grouped with whom.
            // Fall back to the recorded members, which is what this did before
            // it could see claims at all.
            var targets = ok ? Engine.dissolveTargets(addresses, root.liveClients) : addresses.slice()

            if (ok) {
              var strangers = []
              for (var s = 0; s < targets.length; s++) {
                if (addresses.indexOf(targets[s]) === -1) strangers.push(targets[s])
              }
              if (strangers.length) {
                root.warn("SPLIT-BRAIN: " + strangers.join(", ") + " claim(s) shared group membership with "
                  + addresses.join("+") + " without being a recorded member — dissolving them too,"
                  + " or the rebuild fights a group it did not make")
              }
              for (var m = 0; m < addresses.length; m++) {
                var address = addresses[m]
                if (targets.indexOf(address) !== -1) continue
                if (!Engine.groupClaimants(root.liveClients, address).length) continue
                // Claimed by a peer but not dissolvable: the only way to be here
                // is a claim naming a window the read does not contain.
                root.warn("SPLIT-BRAIN: " + address + " is claimed by a group peer but is not itself"
                  + " grouped in this read — leaving it, it has nothing to dissolve")
              }
            }

            var steps = []
            for (var i = 0; i < targets.length; i++) steps.push(root.dissolveStep(targets[i]))

            // The moves that ran before us used follow = false; the windows need
            // a moment to land in the tiling before into_group can find them.
            steps.push({ kind: "wait", ms: 300 })
            steps.push(root.groupToggleStep(addresses[0], "create group", outcome))
            steps.push({ kind: "fn", fn: function (inner) { root.joinFrom(op, 1, attempt, outcome, inner) } })

            root.prependSteps(steps)
            next()
          })
        }
      }
    ])
    done()
  }

  // Join member `index`, then check the order, then — and only then — go on to
  // the next one.
  function joinFrom(op, index, attempt, outcome, done) {
    var addresses = op.addresses || []
    if (index >= addresses.length) {
      root.log("group " + addresses.join("+") + " rebuilt in recorded order")
      // Land the view on the finished group. The joins have dragged the focus
      // anyway — possibly through a scratch workspace, whose emptied husk a
      // monitor could otherwise be left showing — so the group is the one
      // honest place to leave it.
      root.prependSteps([root.focusStep(addresses[0])])
      done()
      return
    }

    root.prependSteps([
      {
        kind: "fn",
        fn: function (next) {
          // The predecessor is focused first because into_group inserts after
          // the group's FOCUSED tab — live-verified: joining a third window
          // while the FIRST tab was focused put it at position 1, not at the
          // end. Focusing member[index - 1] is what nominates the insertion
          // point, and it is the whole of the ordering guarantee.
          root.joinGroup(addresses[index], addresses[index - 1], addresses[0], 0, outcome, next)
        }
      },
      { kind: "fn", fn: function (next) { root.verifyGroupOrder(op, index, attempt, outcome, next) } }
    ])
    done()
  }

  // The recorded prefix must be what the compositor actually built.
  //
  // A join that landed in the wrong slot answers "ok" exactly like one that did
  // not, and a group whose tabs are in the wrong order is the failure the user
  // reported — so it is checked here, after every single join, against a fresh
  // read. One retry (a clean dissolve and rebuild), then stop and say so:
  // repeating a choreography the compositor is not honouring is the no-progress
  // loop this project already has one lesson about.
  function verifyGroupOrder(op, index, attempt, outcome, done) {
    var addresses = op.addresses || []
    var anchor = addresses[0]
    var wanted = addresses.slice(0, index + 1)

    root.readClients(function (ok) {
      if (ok && Engine.groupOrderMatches(root.clientByAddress(anchor), wanted, anchor)) {
        root.prependSteps([
          { kind: "fn", fn: function (next) { root.joinFrom(op, index + 1, attempt, outcome, next) } }
        ])
        done()
        return
      }

      var live = ok ? root.liveGroupOrder(anchor) : []
      var sawIt = ok ? live.join("+") : "(clients read failed)"

      if (attempt === 0) {
        root.warn("group order wrong after joining " + addresses[index]
          + " — wanted " + wanted.join("+") + ", got " + sawIt + "; dissolving and retrying once")
        root.prependSteps([
          { kind: "fn", fn: function (next) { root.rebuildGroup(op, 1, outcome, next) } }
        ])
        done()
        return
      }

      // Blamed on the window that would not take its place, not on the whole
      // group: the other members are exactly where the recording asks, and a
      // toast naming four apps for one refusal is the imprecision this tick is
      // about. The two failures the user can tell apart are told apart — a
      // window that never joined at all, and one that joined in the wrong slot.
      //
      // No addresses in the reason. This sentence ends up in a notification
      // and on a panel row, where "0x55c6f731db30+0x55c6f658f640" is not
      // information, it is noise with a hex prefix; the WARN below and the
      // forensics dump both carry the addresses for whoever needs them.
      root.failAndCount(outcome,
        live.indexOf(addresses[index]) === -1
          ? "group join refused by compositor"
          : "compositor put it in the wrong tab slot",
        root.identitiesForAddresses([addresses[index]]))
      root.warn("no-progress: group " + addresses.join("+")
        + " will not assemble in its recorded order — wanted " + wanted.join("+")
        + ", got " + sawIt + " on the retry too; leaving the group as it is."
        + " Both rounds included a guaranteed-adjacent scratch-workspace join,"
        + " so this is not the known adjacency gate — not a plan that needs another pass")
      if (live.length === 1 && live[0] === anchor) {
        // The create-group step is the one thing the failed attempt provably
        // did; left behind it is the group-of-itself residue the forensics
        // dump shows (a one-tab group bar the recording never asked for).
        // One toggle clears it, and the next cycle starts from clean state.
        // No outcome handed over: the ledger already carries the join verdict,
        // and a failed cleanup must not overwrite it (VERB-ERROR still warns).
        root.prependSteps([root.groupToggleStep(anchor, "clear solo-group residue")])
      }
      done()
    })
  }

  // The live tab order of the group around `anchor`, rotated to start there.
  // Reads nothing: the caller has just refreshed liveClients.
  function liveGroupOrder(anchor) {
    var client = root.clientByAddress(anchor)
    if (!client) return []
    return Engine.normalizeGroupOrder(client.grouped || [], anchor)
  }

  // Take ONE member out of whatever group it is in, deciding from a FRESH read.
  //
  // The bug this shape exists to prevent: two recorded members commonly sit in
  // the same stale group, and dissolving it through member #1 ungroups member
  // #2 as well. Decided from one snapshot taken before any toggle ran, member
  // #2 still looked grouped, so it got a second toggle — which on an ungrouped
  // window CREATES a solo group instead of dissolving one, and the rebuild then
  // had to fight the group it had just made. Re-reading before each toggle
  // costs one hyprctl call per member and makes the decision true.
  // The decision is Engine.isGroupClaimed over the WHOLE read, not
  // StateModel.isGrouped over this one client: a window whose own `grouped`
  // array is empty while its peers still name it is exactly the split-brain
  // member that has to be toggled, and asking only its own array is what left
  // it in place.
  function dissolveStep(address, outcome) {
    return {
      kind: "fn",
      fn: function (next) {
        root.readClients(function (ok) {
          if (!ok) {
            root.warn("clients read failed while dissolving groups — leaving " + address + " as it is")
            next()
            return
          }
          if (Engine.isGroupClaimed(root.liveClients, address)) {
            root.prependSteps([
              root.groupToggleStep(address, "dissolve group", outcome),
              root.dissolveConfirmStep(address, outcome)
            ])
          }
          next()
        })
      }
    }
  }

  // Did that toggle actually dissolve something?
  //
  // group.toggle is one verb for two opposite actions, and which one it
  // performs is the compositor's opinion of whether the window is grouped —
  // the very opinion a split-brain read makes untrustworthy. So the toggle is
  // checked: if the window came out of it sitting in a group of ITSELF and
  // nobody else claims it, the toggle CREATED a group instead of clearing one,
  // and one more toggle undoes it. That corrective runs at most once per
  // dissolve (this step queues no confirmation of its own), so it cannot
  // oscillate.
  function dissolveConfirmStep(address, outcome) {
    return {
      kind: "fn",
      fn: function (next) {
        root.readClients(function (ok) {
          if (!ok) {
            next()
            return
          }
          var grouped = (root.clientByAddress(address) || {}).grouped || []
          var claimants = Engine.groupClaimants(root.liveClients, address)
          if (grouped.length === 1 && grouped[0] === address && !claimants.length) {
            root.log("dissolve of " + address + " created a solo group instead of clearing one"
              + " — toggling once more to leave it ungrouped")
            root.prependSteps([root.groupToggleStep(address, "clear solo group", outcome)])
            next()
            return
          }
          if (Engine.isGroupClaimed(root.liveClients, address)) {
            root.warn("SPLIT-BRAIN: " + address + " still reads as grouped after a dissolve"
              + " (own=" + grouped.length + ", claimed by " + (claimants.join(", ") || "nobody") + ")"
              + " — the rebuild may not hold")
            root.failOp(outcome, "the group would not dissolve: " + address
              + " still reads as grouped (claimed by " + (claimants.join(", ") || "nobody") + ")",
              root.identitiesForAddresses([address]))
          }
          next()
        })
      }
    }
  }

  // Dissolve a live group the recording says should not exist: every member is
  // RECORDED UNGROUPED, and the live desktop has tabbed them together anyway
  // (the post-wake ws-10 state this op was born from: four windows recorded
  // group:null, one live four-tab group, an amber badge no button could clear).
  //
  // Nothing new is invented here — each member goes through dissolveStep, the
  // same claim-based, re-read-before-every-toggle machinery the group rebuild
  // uses. group.toggle on the first member takes the whole group down; the
  // re-read in each subsequent dissolveStep then sees an ungrouped window and
  // does nothing, which is exactly the double-toggle protection the machinery
  // exists for. Split-brain reads are covered the same way they are in a
  // rebuild: a member whose own array under-reports is still dissolved on the
  // strength of its peers' claims.
  function executeUngroup(op, outcome, done) {
    var addresses = (op.addresses || []).slice()
    if (addresses.length === 0) {
      done()
      return
    }
    root.noteEffect("ungroup", addresses.join("+"))
    root.log("ungroup " + addresses.join("+") + ": recorded ungrouped, dissolving the live group")

    var steps = []
    for (var i = 0; i < addresses.length; i++) steps.push(root.dissolveStep(addresses[i], outcome))
    root.prependSteps(steps)
    done()
  }

  // The targeted float-toggle, spelled once. See the evidence block in
  // engine.js: `action` is ignored by Hyprland 0.56's float dispatcher — every
  // spelling toggles — so the TOGGLE spelling is used deliberately, and the
  // caller owns the read that makes toggling correct.
  function floatToggleStep(address, label, outcome) {
    return root.dispatchStep('hl.dsp.window.float({ window = "address:' + address + '", action = "toggle" })',
      label, outcome)
  }

  // Restore one window's floating state, against a FRESH read.
  //
  // Three outcomes, and only one of them dispatches:
  //   - the window already matches the recording: nothing to do. The plan was
  //     built from an older read; toggling here would flip a correct window
  //     wrong, which is the exact hazard of a toggle-only verb.
  //   - it differs: one targeted toggle, then a confirming re-read. A toggle
  //     that did not land is warned about and counted as a cycle failure — no
  //     retry, because re-dispatching a toggle on a state that did not change
  //     risks oscillation, and the next settle pass re-plans anyway.
  //   - the window is gone from the read: nothing safe to dispatch.
  function executeFloating(op, outcome, done) {
    root.readClients(function (ok) {
      if (!ok) {
        root.warn("clients read failed before restoring floating on " + op.address + " — leaving it")
        root.failOp(outcome, "the clients read failed before the float toggle")
        done()
        return
      }
      var client = root.clientByAddress(op.address)
      if (!client) {
        root.warn("floating restore: " + op.address + " is not in the read any more — leaving it")
        root.failOp(outcome, "the window was gone from the read before the float toggle")
        done()
        return
      }
      if (!!client.floating === !!op.value) {
        // Converged between plan and execution — a re-plan would not ask again.
        done()
        return
      }

      root.noteEffect("floating", op.address)
      root.prependSteps([
        root.floatToggleStep(op.address, (op.value ? "float " : "tile ") + op.address, outcome),
        {
          kind: "fn",
          fn: function (next) {
            root.readClients(function (okAfter) {
              if (!okAfter) {
                next()
                return
              }
              var after = root.clientByAddress(op.address)
              if (after && !!after.floating !== !!op.value) {
                root.failAndCount(outcome, "the float toggle did not land (still reads floating="
                  + !!after.floating + ", wanted " + !!op.value + ")")
                root.warn("floating restore: " + op.address + " still reads floating=" + !!after.floating
                  + " after a targeted toggle (wanted " + !!op.value + ") — not toggling again,"
                  + " a second toggle on an unchanged state can only oscillate")
              }
              next()
            })
          }
        }
      ])
      done()
    })
  }

  // Is this window already where the op wants it, within the tolerance band?
  // Asked through engine.geometryDelta + engine.withinTolerance and never
  // re-implemented here: the band that decides "converged" during execution has
  // to be the same band that decided "drifted" during planning, or the service
  // and the badge are two opinions about one desktop.
  function geometryConverged(client, op) {
    var delta = Engine.geometryDelta(
      { at: op.at, size: op.size },
      { at: client.at, size: client.size })
    return Engine.withinTolerance(delta, Engine.GEOMETRY_TOLERANCE_PX)
  }

  function geometryText(at, size) {
    return "[" + (at || []).join(",") + "] " + (size || []).join("x")
  }

  // Put one floating window back on its recorded pixels, against a FRESH read.
  //
  // Two dispatches, resize then move, both naming the window — the spelling and
  // the order are live-proven (tick y29, FLOAT ACTUATOR SEMANTICS in engine.js).
  // Unlike executeFloating the dispatches are idempotent and could survive a
  // stale plan, so the read here is not protecting the window from the op. It is
  // protecting it from ONE thing:
  //
  //   the window must still be FLOATING.
  //
  // The plan was built before this pass ran its moves and its float toggle, and
  // a window that is tiled by the time we get here would take the resize as a
  // dwindle SPLIT adjustment — the divider moves, the neighbouring tile is
  // dragged with it, the compositor answers "ok", and nothing downstream can
  // tell. That is the one failure this whole op has to be unable to produce, and
  // a read is the only instrument that can see it coming.
  //
  // Four outcomes, and only one of them dispatches:
  //   - the read failed, or the window is gone: nothing safe to dispatch;
  //   - the window is no longer floating: REFUSED, loudly. Not "float it first"
  //     — that is planRestore's job on the next pass, which will order the
  //     toggle ahead of the pixels the way it always does;
  //   - it is already within tolerance: converged between plan and execution,
  //     nothing to do and nothing to report;
  //   - otherwise: resize, move, then a confirming re-read.
  //
  // A confirm that fails WARNs and counts a cycle failure, and does not retry
  // in place. The no-progress discipline owns retries: the next iteration
  // re-plans, and because the op carries the recorded rect rather than a delta
  // its signature is identical, so engine.samePlan names it and stops the pass
  // instead of dispatching at a window that is refusing to move.
  function executeGeometry(op, outcome, done) {
    root.readClients(function (ok) {
      if (!ok) {
        root.warn("clients read failed before placing " + op.address + " — leaving it")
        root.failOp(outcome, "the clients read failed before the geometry dispatch")
        done()
        return
      }
      var client = root.clientByAddress(op.address)
      if (!client) {
        root.warn("geometry restore: " + op.address + " is not in the read any more — leaving it")
        root.failOp(outcome, "the window was gone from the read before the geometry dispatch")
        done()
        return
      }
      if (!client.floating) {
        root.warn("geometry restore: " + op.address + " reads TILED, refusing to resize it — "
          + "a resize aimed at a tiled window moves the dwindle split, not the window")
        root.failAndCount(outcome, "the window was tiled when the geometry op came up, so it was refused")
        done()
        return
      }
      if (root.geometryConverged(client, op)) {
        // Converged between plan and execution — a re-plan would not ask again.
        done()
        return
      }

      root.noteEffect("geometry", op.address)
      var commands = Engine.opToCommand(op)
      if (!commands.length) {
        root.warn("geometry restore: the engine produced no dispatch for " + JSON.stringify(op))
        root.failOp(outcome, "the engine produced no dispatch for this geometry op")
        done()
        return
      }

      var steps = []
      for (var i = 0; i < commands.length; i++) {
        var step = root.stepFromEngineCommand(
          commands[i], "place " + op.address + " -> " + root.geometryText(op.at, op.size), outcome)
        if (step) steps.push(step)
      }
      steps.push({
        kind: "fn",
        fn: function (next) {
          root.readClients(function (okAfter) {
            if (!okAfter) {
              next()
              return
            }
            var after = root.clientByAddress(op.address)
            if (after && !root.geometryConverged(after, op)) {
              // failAndCount, not a bare increment plus a failOp: if the resize
              // or the move was REFUSED, that VERB-ERROR already failed this op
              // and counted it, and it is also the sentence that says why. This
              // read only observes the consequence. See engine.failOutcome.
              root.failAndCount(outcome, "the geometry dispatch did not land (reads "
                + root.geometryText(after.at, after.size) + ", wanted "
                + root.geometryText(op.at, op.size) + ")")
              root.warn("geometry restore: " + op.address + " reads "
                + root.geometryText(after.at, after.size) + " after resize+move (wanted "
                + root.geometryText(op.at, op.size) + ") — not retrying here,"
                + " the next re-plan asks again and the no-progress check names it")
            }
            next()
          })
        }
      })
      root.prependSteps(steps)
      done()
    })
  }

  // ------------------------------------------------- tiled refinement (pyo)
  //
  // Two ops, and they fix two different halves of a tiling that came back
  // wrong: `swap` puts the right window in the right SLOT, `divider` puts the
  // line between two slots where the recording had it. Both are read-gated
  // against a FRESH read for the same reason the geometry op is — the plan was
  // built before the moves in front of it ran — and both refuse rather than
  // guess when the read says something has changed underneath them.

  // Exchange two tiles.
  //
  // The dispatch is exact and focus-free (tick or5 § Tiled placement § 7), so
  // the read here is not protecting the windows from the op. It establishes the
  // three things that make the op MEAN anything, all of which the plan could
  // only assert about a desktop that has since been moved:
  //
  //   - both windows are still here;
  //   - both are still TILED — a window that floated in the meantime holds no
  //     tile, so "swap the tiles" is not a sentence about it;
  //   - they are still on the SAME workspace. `swap` across workspaces is not
  //     a thing the recording ever asked for, and this is the read that can
  //     tell.
  //
  // A confirm read follows, because the compositor answers a swap it did not
  // do with a `warning:` line rather than a failure, and a warning is not
  // something the step queue's VERB-ERROR check sees.
  function executeSwap(op, outcome, done) {
    root.readClients(function (ok) {
      if (!ok) {
        root.warn("clients read failed before swapping " + op.address + " — leaving it")
        root.failOp(outcome, "the clients read failed before the swap")
        done()
        return
      }
      var a = root.clientByAddress(op.address)
      var b = root.clientByAddress(op.target)
      if (!a || !b) {
        root.warn("swap: " + (a ? op.target : op.address) + " is not in the read any more — leaving it")
        root.failOp(outcome, "one of the two windows was gone before the swap")
        done()
        return
      }
      if (a.floating || b.floating) {
        root.warn("swap: " + (a.floating ? op.address : op.target) + " reads FLOATING — refusing,"
          + " a float holds no tile to exchange")
        root.failAndCount(outcome, "one of the two windows was floating when the swap came up")
        done()
        return
      }
      if (!a.workspace || !b.workspace || a.workspace.id !== b.workspace.id) {
        root.warn("swap: " + op.address + " and " + op.target + " are on different workspaces now"
          + " — refusing")
        root.failAndCount(outcome, "the two windows were on different workspaces when the swap came up")
        done()
        return
      }

      var wantedA = root.geometryText(b.at, b.size)
      root.noteEffect("swap", op.address + "+" + op.target)
      var commands = Engine.opToCommand(op)
      if (!commands.length) {
        root.warn("swap: the engine produced no dispatch for " + JSON.stringify(op))
        root.failOp(outcome, "the engine produced no dispatch for this swap")
        done()
        return
      }

      var steps = []
      for (var i = 0; i < commands.length; i++) {
        var step = root.stepFromEngineCommand(
          commands[i], "swap " + op.address + " with " + op.target, outcome)
        if (step) steps.push(step)
      }
      steps.push({
        kind: "fn",
        fn: function (next) {
          root.readClients(function (okAfter) {
            if (!okAfter) { next(); return }
            var after = root.clientByAddress(op.address)
            if (after && root.geometryText(after.at, after.size) !== wantedA) {
              root.failAndCount(outcome, "the swap did not land (" + op.address + " reads "
                + root.geometryText(after.at, after.size) + ", wanted " + wantedA + ")")
              root.warn("swap: " + op.address + " reads " + root.geometryText(after.at, after.size)
                + " after the swap (wanted " + wantedA + ") — not retrying here,"
                + " the next re-plan asks again and the no-progress check names it")
            }
            next()
          })
        }
      })
      root.prependSteps(steps)
      done()
    })
  }

  // Move ONE divider, one axis, toward the recorded size — and stop this window
  // if the line will not move.
  //
  // The planner emits at most one of these per workspace per plan, because a
  // divider move changes the rects every later nudge would have been computed
  // from. So this is the "confirm read after each nudge" the refinement needs,
  // and the loop around it is the pass's own re-plan.
  //
  // THE AXIS THE OP IS NOT MOVING comes from THIS read and not from the plan.
  // `resize` requires both x and y (or5's method notes), so the op carries the
  // window's other dimension as the planner last saw it — and a nudge earlier
  // in the same pass, on a neighbouring divider, may have changed it since.
  // Dispatching the stale number would move a second divider nobody asked
  // about. Rebuilding the pair from the fresh read is what stops that, and it
  // is also why the op's SIGNATURE carries only the axis and the target: the
  // other half is not part of what is being asked for.
  //
  // NO-PROGRESS, per window, here rather than in the planner: an unreachable
  // target is not a refused dispatch. Hyprland answers "ok" and CLAMPS — asked
  // for 30 px it gives 62, asked for 1400 it gives 1340 (or5 § 8) — so the only
  // instrument that can tell "moved a little" from "will not move" is the rect
  // before against the rect after. Identical means this line is against its
  // stop, and asking again is how a refinement pass turns into an oscillation.
  // The op is failed with that sentence; the re-plan then produces the
  // identical op and engine.samePlan ends the pass, which is the second, outer
  // half of the same discipline.
  function executeDivider(op, outcome, done) {
    root.readClients(function (ok) {
      if (!ok) {
        root.warn("clients read failed before nudging " + op.address + " — leaving it")
        root.failOp(outcome, "the clients read failed before the divider nudge")
        done()
        return
      }
      var client = root.clientByAddress(op.address)
      if (!client) {
        root.warn("divider: " + op.address + " is not in the read any more — leaving it")
        root.failOp(outcome, "the window was gone before the divider nudge")
        done()
        return
      }
      if (client.floating) {
        // A float has no divider. Refusing is not politeness: `resize` at a
        // float is the geometry op's own first half, and running it here would
        // move the user's floating window to a size nobody planned.
        root.warn("divider: " + op.address + " reads FLOATING — refusing, a float sits in no split")
        root.failAndCount(outcome, "the window was floating when the divider nudge came up")
        done()
        return
      }

      var axis = op.axis === 1 ? 1 : 0
      var target = (op.size || [])[axis]
      if (!(target > 0)) {
        root.warn("divider: " + op.address + " has no usable target on axis " + axis)
        root.failOp(outcome, "the divider nudge carried no usable target size")
        done()
        return
      }
      var before = root.geometryText(client.at, client.size)
      if (Math.abs(client.size[axis] - target) <= Engine.GEOMETRY_TOLERANCE_PX) {
        // Converged between plan and execution — a neighbouring nudge in this
        // same pass can do that, and it is a success, not a skip.
        done()
        return
      }

      var size = [client.size[0], client.size[1]]
      size[axis] = target
      root.noteEffect("divider", op.address)
      var commands = Engine.opToCommand({ kind: "divider", address: op.address, axis: axis, size: size })
      if (!commands.length) {
        root.warn("divider: the engine produced no dispatch for " + JSON.stringify(op))
        root.failOp(outcome, "the engine produced no dispatch for this divider nudge")
        done()
        return
      }

      var steps = []
      for (var i = 0; i < commands.length; i++) {
        var step = root.stepFromEngineCommand(
          commands[i], "divider " + op.address + " -> " + size.join("x"), outcome)
        if (step) steps.push(step)
      }
      steps.push({
        kind: "fn",
        fn: function (next) {
          root.readClients(function (okAfter) {
            if (!okAfter) { next(); return }
            var after = root.clientByAddress(op.address)
            if (!after) { next(); return }
            if (root.geometryText(after.at, after.size) === before) {
              root.failAndCount(outcome, "the divider would not move (" + op.address
                + " still reads " + before + ", asked for " + size.join("x") + ")")
              root.warn("divider: " + op.address + " did not move at all (still " + before
                + ", asked " + size.join("x") + ") — this line is against its stop;"
                + " stopping this window rather than asking again")
            }
            next()
          })
        }
      })
      root.prependSteps(steps)
      done()
    })
  }

  // The one step in a restore that still needs the keyboard focus: into_group
  // IGNORES a `window = "address:…"` selector and always acts on the ACTIVE
  // window (live-verified — see engine.js). Everything else in the plan names
  // its subject, so this is the only place a focused panel could still get in
  // the way, and the panel now closes itself before a manual restore starts.
  //
  // into_group is a NO-OP when there is no group in the given direction, and
  // which direction that is depends on the tiling. Try them all, checking
  // after each whether the window actually joined THE GROUP WE ARE BUILDING —
  // `anchor` is the window the group was created around. "Is it grouped at
  // all?" is not the same question: the window may already be in a group of
  // its own, in which case every direction "succeeds" on the first try and the
  // recorded group is never assembled.
  readonly property var groupDirections: ["left", "right", "up", "down"]

  // `predecessor` is the member this one must land AFTER — the tab that has to
  // hold the group's focus when into_group fires. `anchor` is the window the
  // group was created around, and is what "did it join THE RIGHT group" is
  // asked about. They are the same window only for the first join.
  //
  // Both focuses are re-issued on every direction attempt: a failed attempt is
  // not guaranteed to have left the focus where it found it, and a join that
  // lands after the wrong tab is worse than one that does not land at all.
  //
  // `viaScratch` marks the second, geometry-independent round. The first round
  // probes the four directions where the windows already sit — zero extra
  // churn whenever the tiling happens to put candidate and anchor side by
  // side. On exhaustion the member is NOT declared refused: live evidence
  // (2026-08-16, dispatch-by-dispatch replay of forensics dump
  // 2026-08-16T06:34:51.393Z) proved into_group only joins a group that is the
  // directly ADJACENT tile in the asked direction. With a full column of other
  // windows between candidate and anchor, all four directions answer "ok" and
  // do nothing — with the focus verifiably landing (activewindow read back)
  // and the workspace visible, so the earlier "compositor ignoring the focus"
  // theory is dead. A dock transition scrambles exactly this geometry, and
  // geometry is not a recorded dimension, so adjacency is manufactured
  // instead: scratchJoin re-runs this with the pair alone on an empty
  // workspace, where two layout nodes cannot be anything but adjacent.
  function joinGroup(address, predecessor, anchor, directionIndex, outcome, done, viaScratch) {
    if (directionIndex >= root.groupDirections.length) {
      if (!viaScratch) {
        root.log("window " + address + " is not tiling-adjacent to " + anchor
          + "'s group in any direction — assembling on an empty workspace instead")
        root.scratchJoin(address, predecessor, anchor, outcome, done)
        return
      }
      root.warn("window " + address + " would not join " + anchor + "'s group in any direction,"
        + " even alone with it on an empty workspace")
      // Recorded here as well as in verifyGroupOrder, because this is the
      // precise sentence: the compositor was asked in all four directions,
      // with adjacency guaranteed by construction, and took the window in none
      // of them. verifyGroupOrder's own failOp comes later and may overwrite
      // it with the same verdict; both are true and the last one wins, which
      // is the rule the ledger already follows.
      root.failOp(outcome, "group join refused by compositor (all four directions)",
        root.identitiesForAddresses([address]))
      done()
      return
    }

    var direction = root.groupDirections[directionIndex]
    root.prependSteps([
      root.focusStep(predecessor),
      root.focusStep(address),
      root.dispatchStep('hl.dsp.window.move({ into_group = "' + direction + '" })', "into_group " + direction),
      {
        kind: "fn",
        fn: function (next) {
          root.readClients(function (ok) {
            // A read that failed says nothing about where the window went, so
            // treat it like a miss and try the next direction rather than
            // declaring a group that may not exist.
            if (ok && StateModel.inGroupWith(root.clientByAddress(address), anchor)) {
              next()
              return
            }
            root.joinGroup(address, predecessor, anchor, directionIndex + 1, outcome, next, viaScratch)
          })
        }
      }
    ])
    done()
  }

  // Assemble one member on an empty workspace, where adjacency is guaranteed,
  // then bring the group home. Every step was live-verified BY HAND on the
  // failing desktop before it was coded (2026-08-16):
  //   - window.move({ window, workspace, follow = false }) on a grouped window
  //     moves the WHOLE group, solo groups included — so one dispatch at the
  //     anchor carries whatever has been assembled so far;
  //   - alone on the empty workspace the two nodes tile side by side, and the
  //     same focus-predecessor / focus-candidate / into_group choreography
  //     that had refused in place joined on the first adjacent direction;
  //   - moving the anchor home brings the joined member with it.
  // The trailing candidate→home move exists for the failure path only: if even
  // the guaranteed-adjacent join refused, the candidate must not be left
  // stranded on the scratch workspace. When the join worked it is a no-op
  // (the candidate is already home, inside the group).
  //
  // The workspace is picked fresh per join (Engine.pickScratchWorkspace):
  // empty of windows and not visible on any monitor, so the detour is not
  // churn the user watches. `home` is the anchor's CURRENT workspace, read
  // now — the moves phase has already put the anchor on its recorded one.
  function scratchJoin(address, predecessor, anchor, outcome, done) {
    root.readClients(function (ok) {
      var anchorClient = ok ? root.clientByAddress(anchor) : null
      var candidate = ok ? root.clientByAddress(address) : null
      if (!anchorClient || !candidate || !anchorClient.workspace) {
        root.warn("scratch join: " + (ok ? "the windows are gone from the read" : "the clients read failed")
          + " — leaving " + address + " unjoined")
        root.failOp(outcome, ok ? "the window vanished before the scratch-workspace join"
          : "the clients read failed before the scratch-workspace join",
          root.identitiesForAddresses([address]))
        done()
        return
      }
      var home = anchorClient.workspace.id
      root.readMonitors(function (okMon) {
        var scratch = Engine.pickScratchWorkspace(root.liveClients, okMon ? root.liveMonitors : [])
        root.log("scratch join: " + anchor + "+" + address + " via empty ws " + scratch
          + ", home ws " + home)
        root.prependSteps([
          root.dispatchStep('hl.dsp.window.move({ window = "address:' + anchor
            + '", workspace = "' + scratch + '", follow = false })', "group to scratch ws " + scratch, outcome),
          root.dispatchStep('hl.dsp.window.move({ window = "address:' + address
            + '", workspace = "' + scratch + '", follow = false })', "candidate to scratch ws " + scratch, outcome),
          // The same settle the rebuild gives its own moves: the two windows
          // must land in the scratch tiling before into_group can see them.
          { kind: "wait", ms: 200 },
          { kind: "fn", fn: function (next) { root.joinGroup(address, predecessor, anchor, 0, outcome, next, true) } },
          root.dispatchStep('hl.dsp.window.move({ window = "address:' + anchor
            + '", workspace = "' + home + '", follow = false })', "group home to ws " + home, outcome),
          root.dispatchStep('hl.dsp.window.move({ window = "address:' + address
            + '", workspace = "' + home + '", follow = false })', "candidate home to ws " + home, outcome),
          { kind: "wait", ms: 150 }
        ])
        done()
      })
    })
  }

  // ------------------------------------------------------- the lock probe
  //
  // ONE QUESTION: is the session locked right now?
  //
  // It matters for exactly one op kind. `into_group` ignores its window selector
  // and acts on the FOCUSED window (live-verified, learnings § Dispatch selector
  // traps), so a group rebuild focuses each member in turn — and under an
  // ext-session-lock there is no window to focus. A rebuild attempted there
  // assembles in whatever order the compositor was left in, which is a wrong
  // desktop the user meets when they come back. Everything else in a plan names
  // its subject and does not care (state-matrix §7).
  //
  // `omarchy-shell lock isLocked` printing "true"/"false" is THE decisive query.
  // Not loginctl's LockedHint, which is blind to this lock, and not
  // `omarchy-hyprland-session-locked`, whose LOCK blocker is sticky after a lock
  // client dies (learnings § Plugin dev loop).
  //
  // FAIL OPEN, always. A missing binary, a non-zero exit or an answer that is
  // neither word is treated as UNLOCKED, with one warn per session. The cost of
  // being wrong in that direction is a group rebuilt in the wrong tab order,
  // which the next restore fixes; the cost of failing closed is a tool that
  // stops rebuilding groups for ever the day the query is renamed, and says
  // nothing about why.
  //
  // THE TEST OVERRIDE: DR_TEST_LOCKED = "true" | "false" answers the question
  // without touching the session, and wins over the real probe. It exists
  // because an agent must NEVER lock or unlock this session (learnings), so the
  // only way to exercise the deferral path in a live round is to lie to the
  // probe about it. Read on EVERY query rather than cached at startup, so a
  // scenario can flip it between passes. An unset or unrecognised value means
  // "ask the real thing" — the override cannot be switched on by accident.
  readonly property string lockProbeCommand: "omarchy-shell lock isLocked"
  readonly property string lockOverrideVar: "DR_TEST_LOCKED"
  property bool lockProbeWarned: false
  // Queued so two askers (a pass and the unlock poll) can never collide over
  // one Process: whoever asks first starts it, everybody gets the same answer.
  property var lockProbeWaiting: []

  function queryLocked(done) {
    if (!done) return
    var override = Quickshell.env(root.lockOverrideVar)
    if (override === "true" || override === "false") {
      root.log("lock probe: " + root.lockOverrideVar + "=" + override + " overrides the real query")
      done(override === "true")
      return
    }
    root.lockProbeWaiting = root.lockProbeWaiting.concat([done])
    if (!lockProc.running) lockProc.running = true
  }

  function answerLockProbe(locked) {
    var waiting = root.lockProbeWaiting
    root.lockProbeWaiting = []
    for (var i = 0; i < waiting.length; i++) waiting[i](locked)
  }

  Process {
    id: lockProc
    command: ["bash", "-c", root.lockProbeCommand]
    stdout: StdioCollector { id: lockOut; waitForEnd: true }
    stderr: StdioCollector { id: lockErr; waitForEnd: true }
    onExited: function (exitCode) {
      var output = String(lockOut.text || "").replace(/^\s+|\s+$/g, "")
      if (exitCode !== 0 || (output !== "true" && output !== "false")) {
        if (!root.lockProbeWarned) {
          root.lockProbeWarned = true
          root.warn("lock probe failed (`" + root.lockProbeCommand + "` exit " + exitCode
            + ", said \"" + (output || String(lockErr.text || "").replace(/^\s+|\s+$/g, "") || "(nothing)")
            + "\") — treating the session as UNLOCKED for this probe;"
            + " the query will be retried next time."
            + " Failing the other way would switch group rebuilds off silently")
        }
        root.answerLockProbe(false)
        return
      }
      root.answerLockProbe(output === "true")
    }
  }

  // ------------------------------------------ joins deferred while locked
  //
  // Set when a pass found group joins in its plan while the session was locked
  // and ran everything else instead. It is not a failure — the desk is drifted
  // for a stated reason, the status file says so (`deferredLocked`), and the
  // poll below clears it by re-running the restore the moment the session
  // unlocks. The replan is idempotent, so "run it again" is the whole of the
  // repair: the joins are still in the plan, and now they can have the focus.
  property bool pendingJoins: false
  // One log line per cycle, not per pass: three settle passes over a locked
  // session would otherwise say the same thing three times.
  property bool lockDeferralLogged: false
  readonly property int unlockPollMs: 5000

  function noteJoinsDeferred(plan) {
    root.pendingJoins = true
    if (!root.lockDeferralLogged) {
      root.lockDeferralLogged = true
      root.log("session is LOCKED — deferring " + (plan.length - Engine.planWithoutFocusOps(plan).length)
        + "/" + plan.length + " ops' worth of focus-dependent work until it unlocks."
        + " `into_group` and `togglesplit` both act on the focused window and a locked"
        + " session has none, so a rebuild here would assemble the tabs in the wrong"
        + " order and a flip would land on whichever node the compositor is holding")
    }
    root.publishStatus({ deferredLocked: true }, "focus-dependent ops deferred while locked")
    if (!unlockPollTimer.running) unlockPollTimer.start()
  }

  function clearJoinsDeferred(reason) {
    if (!root.pendingJoins) return
    root.pendingJoins = false
    unlockPollTimer.stop()
    root.log("session unlocked — replanning so the deferred focus-dependent ops can run (" + reason + ")")
    root.publishStatus({ deferredLocked: false }, "session unlocked")
    root.requestRestore("session unlocked")
  }

  // Runs ONLY while joins are waiting. A timer that polled a shell command
  // every five seconds for the life of the session would be a cost this plugin
  // has spent the whole project avoiding — the drift path is event-driven
  // precisely so nothing has to poll.
  Timer {
    id: unlockPollTimer
    interval: root.unlockPollMs
    repeat: true
    running: false
    onTriggered: {
      if (!root.pendingJoins) { unlockPollTimer.stop(); return }
      root.queryLocked(function (locked) {
        if (!locked) root.clearJoinsDeferred("unlock poll")
      })
    }
  }

  // --------------------------------------------------------- restore cycle

  // `manual` — the user asked for this one BY HAND (the trigger file: the panel's
  // Restore button, scripts, `date > …/dock-recall.trigger`). Everything else
  // is the desktop asking on its own: a hotplug, a settle pass, a replayed or
  // queued request that inherits its origin.
  //
  // THE PAUSE CONTRACT lives here, in one place, because "paused" has to mean
  // exactly one thing and every caller has to get the same answer:
  //
  //   - event-triggered cycles are SKIPPED, with one log line naming the event;
  //   - the manual trigger ALWAYS runs a full cycle. Pausing is "stop acting on
  //     your own", not "stop working" — a switch that ignored the user's own
  //     button would just be a broken tool;
  //   - drift refreshes are untouched (they read, they never dispatch), so the
  //     badge keeps telling the truth about a desktop the tool is not fixing;
  //   - focus failover on an undock is untouched too — see handleHyprlandEvent.
  function requestRestore(reason, manual) {
    var byHand = manual === true

    if (root.stateLoaded && !byHand && StateModel.isPaused(root.state)) {
      root.log("paused — ignoring " + reason)
      return
    }

    if (!root.stateLoaded) {
      // Held, not dropped. Startup is exactly when this happens: the monitor
      // events of a dock that woke the machine can beat the first state-file
      // read, and dropping the request meant the one restore the user was
      // actually waiting for never ran.
      root.pendingRestoreReason = reason
      root.pendingRestoreManual = root.pendingRestoreManual || byHand   // OR, like rerunManual: a held manual request must never be downgraded by a later event
      root.log("restore requested (" + reason + ") before the state file loaded — held until it is")
      return
    }
    if (root.cycleActive) {
      // Single flight: a dock event during a restore must not interleave two
      // plans against the same desktop. Remember it and rerun once.
      root.rerunQueued = true
      root.rerunManual = root.rerunManual || byHand
      root.log("restore requested (" + reason + ") while a cycle is running — queued")
      return
    }

    root.cycleActive = true
    root.rerunManual = false
    root.cycleReason = reason
    root.passIndex = 0
    root.cycleEffects = ({})
    root.launchSerial = 0
    // The previous cycle's ledger is retired HERE and not at its own end: the
    // verdicts published by every drift refresh in between keep explaining why
    // an app is where it is, and "the last restore could not join this group"
    // stays true until a new restore says otherwise.
    root.cycleOutcomes = []
    root.cyclePlans = []
    root.outcomeSeq = 0
    root.cycleFailures = 0
    root.opsMoved = 0
    root.opsLaunched = 0
    root.opsWorkspace = 0
    root.opsGrouped = 0
    root.opsUngrouped = 0
    root.opsFloated = 0
    root.opsPlaced = 0
    root.opsTiled = 0
    root.cycleTopologyKey = ""
    // Whose keyboard this is. Cleared at cycle start and filled in from the
    // first successful read of the cycle, so the placement choreography has
    // somewhere to put the focus back. See noteFocusHome.
    root.focusHome = ""
    root.loggedRefusals = ({})
    // Per cycle, not per pass: three settle passes over one locked session say
    // the deferral once between them.
    root.lockDeferralLogged = false
    root.log("restore cycle start (" + reason + "), settle passes at "
      + root.settleDelays.join("/") + "ms")
    // Announced before the first settle delay, not after it: the glyph's sweep
    // is the only sign the user gets that a dock is being worked on, and a
    // second of stillness first reads as nothing happening.
    root.publishStatus({ restoring: true }, "restore cycle start")

    passTimer.interval = root.settleDelays[0]
    passTimer.restart()
  }

  Timer {
    id: passTimer
    repeat: false
    onTriggered: root.runPass()
  }

  // The plan the previous iteration of THIS pass executed, kept so the next one
  // can tell "shrinking" from "stuck". Reset per pass: a fresh pass plans
  // against a desktop the previous pass has been moving, and the settle delay
  // between them is exactly the "give it another moment" the comparison would
  // otherwise be denying.
  property var lastPlan: null

  function runPass() {
    root.iteration = 0
    root.refinementIterations = 0
    // A fresh pass may try the shape again — see shapeAbandoned.
    root.shapeAbandoned = ({})
    root.lastPlan = null
    root.planAndExecute()
  }

  function planAndExecute() {
    root.snapshot(function (ok) {
      // Every abandoned pass below ends with finishPass(), never finishCycle():
      // the cycle's later settle passes are the retry. finishCycle() would
      // cancel the 3s and 7s passes on the strength of one bad read — and the
      // read most likely to fail is the one taken while the compositor is
      // mid-hotplug, which is exactly the moment the later passes exist for.
      if (!ok) {
        root.warn("pass " + (root.passIndex + 1) + " abandoned: the live read failed"
          + " — the next settle pass will retry")
        root.finishPass()
        return
      }

      root.noteFocusHome()

      var key = Engine.topologyKey(root.liveMonitors)
      if (!key) {
        // No monitors, or none with a usable label. Mid-hotplug this is a
        // transient state, and planning against it would mean "the topology
        // where nothing is plugged in".
        root.warn("pass " + (root.passIndex + 1) + " abandoned: the monitor list resolves to no topology at all"
          + " (" + root.liveMonitors.length + " monitors) — the next settle pass will retry")
        root.finishPass()
        return
      }
      root.cycleTopologyKey = key

      var layout = StateModel.layoutFor(root.state, key)
      if (!layout) {
        // A real topology with nothing recorded for it is a final answer, not a
        // transient one: retrying cannot invent a layout. End the whole cycle.
        root.log("no layout recorded for topology \"" + key + "\" — nothing to restore")
        root.finishCycle()
        return
      }

      var identities = StateModel.identities(root.state)
      var plan = Engine.planRestore(root.liveClients, root.liveMonitors, layout, identities)

      // Before the empty-plan check, because a REFUSAL is most often exactly
      // that: a workspace whose tiling this tool will not touch plans no ops at
      // all, and "converged, 0 ops" over a workspace sitting at 0.78 is the one
      // line in this log that would be a lie by omission.
      root.logTilingRefusals(layout, identities)

      if (plan.length === 0) {
        root.log("converged, 0 ops (topology \"" + key + "\", pass " + (root.passIndex + 1) + ")")
        root.finishPass()
        return
      }

      // The plan/snapshot address invariant, checked against the very read this
      // plan was built from (see the block in engine.js). It cannot fail while
      // planRestore is the only planner and root.liveClients is only ever
      // assigned from a fresh successful read — which is the point: if it ever
      // does fail, something has started serving a plan or a snapshot older
      // than it claims, and dispatching it would aim focus/into_group/move at
      // windows that are not on the desktop. Those dispatches are answered
      // (hyprctl says "window not found" for focus, and nothing at all for
      // some verbs), the group never assembles, and the only visible symptom is
      // a cycle that will not converge. Refuse the pass and NAME the addresses.
      var unknown = Engine.unknownPlanAddresses(plan, root.liveClients)
      if (unknown.length) {
        root.cycleFailures += 1
        root.warn("SNAPSHOT-STALE: pass " + (root.passIndex + 1) + " planned "
          + unknown.length + " window address(es) that the read it planned from does not contain ("
          + unknown.join(", ") + "; " + root.liveClients.length + " windows were read)"
          + " — abandoning this pass rather than dispatching at windows that are not there")
        root.finishPass()
        return
      }

      root.iteration += 1
      // Which budget this iteration spends. See the refinementIterations block
      // at the top of this file: a plan of nothing but swaps and divider nudges
      // is one step of a bounded walk down a split tree, and the general cap is
      // not about that work.
      if (Engine.isRefinementPlan(plan)) root.refinementIterations += 1

      // Zero progress: this plan asks for exactly the work the previous
      // iteration just dispatched, op for op and subject for subject. Nothing
      // moved, so nothing will — the remaining iterations would only re-issue
      // dispatches the compositor has already answered "ok" to while doing
      // nothing. Stop the pass here and NAME the op, because "GIVE-UP after 5
      // iterations" five seconds later is a symptom and this is the diagnosis.
      //
      // Checked before the iteration cap so the loud line is the useful one:
      // both would fire on a stuck plan, and only this one says which op is
      // being ignored.
      //
      // The pass is ended rather than the cycle: a later settle pass runs
      // against a desktop that has had seconds more to finish a hotplug, and
      // that genuinely does sometimes unstick a plan this one could not act on.
      if (root.lastPlan && Engine.samePlan(plan, root.lastPlan)) {
        root.cycleFailures += 1
        root.warn("no-progress: " + Engine.describeOp(plan[0]) + " had no effect"
          + " — pass " + (root.passIndex + 1) + " iteration " + root.iteration
          + " re-planned the identical " + plan.length + " op(s) (" + root.planSummary(plan)
          + "); stopping this pass rather than repeating it "
          + Math.max(0, root.maxIterations - root.generalIterations + 1) + " more time(s)")
        root.lastPlan = null
        root.finishPass()
        return
      }
      root.lastPlan = plan

      if (root.generalIterations > root.maxIterations) {
        // Loud on purpose: a plan that will not shrink means a dispatch is
        // being rejected or ignored, and the VERB-ERROR lines just above say
        // which. This is the signature of a wrong verb spelling.
        //
        // Counted in GENERAL iterations (total minus refinement ones), which is
        // the whole of tick eqb's fix for the spurious GIVE-UP: a workspace of
        // seven windows spends six iterations converging its dividers, and
        // those six must not exhaust the budget that exists for dispatches
        // nobody is honouring.
        root.cycleFailures += 1
        root.warn("GIVE-UP after " + root.maxIterations + " iterations on pass "
          + (root.passIndex + 1) + " — plan still has " + plan.length + " ops: " + root.planSummary(plan))
        root.finishPass()
        return
      }

      if (root.refinementIterations > Engine.TILED_REFINEMENT_MAX_NUDGES) {
        // The refinement's own bound. Reaching it is not the same event as the
        // one above: nothing is being ignored, the tiling is simply deeper than
        // this tool promises to walk. It ends the pass with a counted failure
        // all the same — a workspace still this far from its recording after
        // twelve nudges is something the log should carry.
        root.cycleFailures += 1
        root.warn("GIVE-UP after " + Engine.TILED_REFINEMENT_MAX_NUDGES
          + " tiled refinement nudges on pass " + (root.passIndex + 1)
          + " — plan still has " + plan.length + " ops: " + root.planSummary(plan)
          + "; this tiling is deeper than the refinement's stated bound")
        root.finishPass()
        return
      }

      root.log("pass " + (root.passIndex + 1) + " iteration " + root.iteration + ": "
        + plan.length + " ops — " + root.planSummary(plan))
      root.cyclePlans = root.cyclePlans.concat([{
        pass: root.passIndex + 1,
        iteration: root.iteration,
        ops: plan
      }])
      // THE LOCK GATE (tick 97e). Only a plan that carries group JOINS asks the
      // question — the probe is a shell-out, and a desk that is merely moving
      // windows has no reason to pay for it. Everything else in a plan names
      // its subject and runs the same whether the screen is locked or not.
      if (!Engine.planHasFocusOps(plan)) {
        root.runPlan(plan)
        return
      }
      root.queryLocked(function (locked) {
        if (!locked) {
          // Whatever was waiting can run now, and this pass is what runs it.
          root.noteJoinsRunnable()
          root.runPlan(plan)
          return
        }
        root.noteJoinsDeferred(plan)
        var runnable = Engine.planWithoutFocusOps(plan)
        if (runnable.length === 0) {
          // Nothing left but the joins. Ending the pass here is what keeps the
          // deferral quiet: dispatching nothing and re-planning would produce
          // this identical plan on the next iteration, and the no-progress
          // check would report a stuck op — a WARN and a counted failure for a
          // decision the service made on purpose.
          root.log("pass " + (root.passIndex + 1) + ": nothing in this plan can run while the"
            + " session is locked — ending the pass; the unlock poll will re-run it")
          root.finishPass()
          return
        }
        root.runPlan(runnable)
      })
    })
  }

  // Dispatch a plan and loop. Split out of planAndExecute so the locked path and
  // the ordinary one cannot drift apart on what "run a plan" means.
  function runPlan(plan) {
    root.closePanelForChoreography(plan)
    root.executePlan(plan, function () { root.planAndExecute() })
  }

  // The joins are runnable again and a pass is about to run them. Quieter than
  // clearJoinsDeferred: no re-request, because the cycle that would service it
  // is the one asking.
  function noteJoinsRunnable() {
    if (!root.pendingJoins) return
    root.pendingJoins = false
    unlockPollTimer.stop()
    root.publishStatus({ deferredLocked: false }, "session unlocked — the deferred joins are running now")
  }

  // GET OUT OF THE WAY of a plan that needs the keyboard.
  //
  // The panel already closes itself before a MANUAL restore (Panel.restoreNow),
  // for the group rebuild's sake: `into_group` ignores a window selector and
  // acts on the active window, so a focused panel surface breaks it. Tick 35n
  // then gave the plan a second thing that needs the keyboard — the placement
  // choreography's focus at the split parent — and that one runs on AUTO cycles
  // too, where nobody pressed a button and the panel may be sitting open on the
  // user's screen with the keyboard. The result was a silent one: every
  // dispatch answered "ok", the focus never arrived, and the workspace was
  // built under the mouse pointer.
  //
  // So the rule is extended to its real shape: ANY cycle whose plan carries a
  // choreographed move closes this plugin's panel first. Manual or automatic no
  // longer comes into it — what matters is whether the plan needs the focus.
  // Logged, because a window closing itself while the user is reading it is the
  // kind of thing that has to be explainable afterwards.
  //
  // Nothing here reaches into the panel object: the shell owns the open set (a
  // panel that closed itself behind the shell's back leaves the next summon
  // toggling the wrong way), and `hide` on a plugin that is not open is a no-op
  // the shell answers for itself.
  // Tick uk5 added the second op that borrows the keyboard on an AUTO cycle: a
  // `split` flip is a focus plus a `togglesplit`, and a panel holding the
  // keyboard makes the focus read-back fail and stands the flip down every pass
  // for as long as the panel is open. Same rule, same reason, so the same
  // predicate answers for both.
  function planHasChoreography(plan) {
    for (var i = 0; i < plan.length; i++) {
      if (!plan[i]) continue
      if (plan[i].kind === "move" && plan[i].splitParent) return true
      if (plan[i].kind === "split") return true
    }
    return false
  }

  function closePanelForChoreography(plan) {
    if (!root.planHasChoreography(plan)) return
    if (!root.shell || typeof root.shell.hide !== "function") return
    if (typeof root.shell.isPluginOpen === "function"
      && root.shell.isPluginOpen(root.pluginId) !== true) return
    root.log("closing the panel: this plan carries placement choreography, and a focused"
      + " panel surface takes the keyboard away from every window — the focus at the split"
      + " parent would not land and the tiling would be built under the mouse pointer")
    root.shell.hide(root.pluginId)
  }

  // Say out loud which finished workspaces the tiled refinement will not touch.
  //
  // A refusal is the ceiling working, not a fault — but a ceiling nobody can
  // see is indistinguishable from a bug, and the report it produces ("workspace
  // 8 sits at 0.78 and the tool does nothing, for ever") is one this project
  // has already had to answer once. engine.driftOf computes the refusals as
  // part of the report every reader shares with `scripts/verify`, so the words
  // in the log are the same words in the verify table.
  //
  // Once per cycle per workspace: the pass loop asks the same question on every
  // iteration and three settle passes ask it again, and a refusal that is still
  // true is not news.
  property var loggedRefusals: ({})

  function logTilingRefusals(layout, identities) {
    var report = Engine.driftOf(root.liveClients, root.liveMonitors, layout, identities)
    var refusals = report.tilingRefusals || []
    for (var i = 0; i < refusals.length; i++) {
      var refusal = refusals[i]
      var key = refusal.monitorDescription + "\u0000" + refusal.workspaceId + "\u0000" + refusal.reason
      if (root.loggedRefusals[key]) continue
      root.loggedRefusals[key] = true
      root.log("tiled refinement REFUSED workspace " + refusal.workspaceId
        + " on " + refusal.monitorDescription + " (" + refusal.reason + "): "
        + Engine.tilingRefusalPhrase(refusal.reason))
    }
  }

  function planSummary(plan) {
    var counts = {}
    var order = []
    for (var i = 0; i < plan.length; i++) {
      var kind = plan[i].kind
      if (counts[kind] === undefined) {
        counts[kind] = 0
        order.push(kind)
      }
      counts[kind] += 1
    }
    var parts = []
    for (var j = 0; j < order.length; j++) parts.push(order[j] + "x" + counts[order[j]])
    return parts.join(", ")
  }

  function executePlan(plan, done) {
    // Say the deficit out loud before doing anything about it. A plan that
    // opens a SECOND window of an app is the one shape of this tool's work that
    // looks like a bug from the outside ("why did it start another terminal?"),
    // so the log has to answer that question without a re-plan.
    var deficits = Engine.launchDeficits(plan)
    for (var d = 0; d < deficits.length; d++) {
      if (deficits[d].count < 2) continue
      root.log("launch deficit: the recording wants " + deficits[d].count
        + " more windows of \"" + deficits[d].identityId + "\" — launching them one at a time")
    }

    var steps = []
    for (var i = 0; i < plan.length; i++) steps = steps.concat(root.stepsForOp(plan[i]))
    if (steps.length === 0) {
      // Every op in the plan was unexecutable (launch-less identities, say).
      // Re-planning would produce the same plan forever, so stop the pass here.
      root.log("nothing executable in this plan — ending the pass")
      root.finishPass()
      return
    }
    root.runSteps(steps, done)
  }

  function finishPass() {
    var next = root.passIndex + 1
    if (next >= root.settleDelays.length) {
      root.finishCycle()
      return
    }
    root.passIndex = next
    // Measured from the end of the previous pass rather than from the trigger:
    // a pass that took seconds (a cold launch) has already provided the settle
    // time the schedule was asking for.
    passTimer.interval = Math.max(200, root.settleDelays[next] - root.settleDelays[next - 1])
    passTimer.restart()
  }

  function finishCycle() {
    var total = root.opsMoved + root.opsLaunched + root.opsWorkspace + root.opsGrouped
      + root.opsUngrouped + root.opsFloated + root.opsPlaced + root.opsTiled
    root.log("restore cycle done (" + root.cycleReason + "): " + total + " ops — "
      + root.opsMoved + " moved, " + root.opsLaunched + " launched, "
      + root.opsWorkspace + " workspace, " + root.opsGrouped + " grouped, "
      + root.opsUngrouped + " ungrouped, " + root.opsFloated + " floated, "
      + root.opsPlaced + " placed, " + root.opsTiled + " retiled")

    root.cycleActive = false

    // Stale-latch clear (tick co9 nit): pendingJoins/deferredLocked can only be
    // set by noteJoinsDeferred, which also flips lockDeferralLogged — reset to
    // false at the top of THIS cycle (see requestRestore). If the latch is
    // still up here but no pass of this cycle ever deferred a join, the group
    // this session was waiting to rebuild is gone (the windows closed while
    // locked), and nothing will ever service the poll. Clear it quietly: no
    // re-request, because there is nothing left to run. A cycle that DID defer
    // a join this time leaves lockDeferralLogged true and the latch untouched.
    if (root.pendingJoins && !root.lockDeferralLogged) {
      root.pendingJoins = false
      unlockPollTimer.stop()
      root.log("no focus-dependent ops planned this cycle — the earlier deferral has nothing left to"
        + " run; clearing the stale latch")
      root.publishStatus({ deferredLocked: false }, "nothing focus-dependent left to defer")
    }

    // The measurement, taken from the last read of the cycle. That read is
    // fresh by construction: the final act of every pass is planAndExecute's
    // own snapshot, which is what decided the pass was finished.
    var verdicts = root.cycleVerdicts()
    var summary = Engine.verdictSummary(verdicts)
    // Fall back to the op tally only when there is nothing to measure against
    // (no layout, or the last read failed) — the tally is what this said
    // before verdicts existed, and it is still better than an empty string.
    var sentence = verdicts.length ? summary.text : root.cycleSummary(total)

    // Only speak up when something actually happened, OR when something went
    // wrong. A dock that needed no work must not produce a toast; a dock that
    // could not finish must not be silent about it.
    if (total > 0 || root.cycleFailures > 0) {
      // The human name, not the key: the key is a join of EDID descriptions
      // ("Samsung Display Corp. ATNA60HR07-0 | AOC Inc. U34G2G") and it does not
      // fit in a toast, let alone read like one. The live monitor list is passed
      // so the built-in panel can be recognised as "Laptop" rather than by its
      // part number.
      //
      // The body counts VERDICTS, not dispatches. "1 grouped — 6 failed" was
      // the honest tally of what the service tried, and no user can read a
      // desktop out of it; "8/9 arranged — telegram: group join refused" is the
      // same cycle described in the only terms the user has — their apps.
      var where = PanelModel.humanizeTopology(root.cycleTopologyKey, root.liveMonitors)
      root.notify("Dock Recall", where + " — " + sentence)
    }

    // Two writes, in this order and on purpose. The first is synchronous and
    // cannot fail: it clears `restoring` and records the outcome from what
    // this cycle already knows. The second needs a fresh hyprctl read to say
    // what the drift is now, and is allowed to abandon itself — leaving a
    // status that is stale in one field rather than one that is wrong in all
    // of them.
    root.publishStatus({
      restoring: false,
      lastResult: {
        ok: root.cycleFailures === 0,
        summary: sentence,
        at: new Date().toISOString()
      },
      verdicts: verdicts
    }, "restore cycle done")

    // A cycle that did not come out clean leaves the whole scene behind it.
    //
    // Gated on cycleFailures — the same thing lastResult.ok reports — and NOT
    // on "some verdict is not ok". A desktop can legitimately sit with an
    // unclearable verdict for as long as the user leaves it there (an app with
    // no launch command that is not running), and dumping the entire client
    // list on every cycle for a state nothing went wrong in would bury the ten
    // dumps that matter under a hundred that do not.
    if (root.cycleFailures > 0) root.writeForensics(verdicts, summary)

    if (root.rerunQueued) {
      root.rerunQueued = false
      var wasManual = root.rerunManual
      root.rerunManual = false
      root.requestRestore("queued rerun", wasManual)
      return
    }
    root.refreshStatus("restore cycle end")
  }

  // The verdict table as the cycle leaves the desktop.
  //
  // Built from root.liveClients/liveMonitors — the last read the cycle took —
  // rather than from a fresh one, because the toast, the status and the
  // forensics dump all have to describe the SAME moment. refreshStatus runs
  // straight after and republishes from a genuinely fresh read; that is the
  // right place for "and here is what it looks like now".
  function cycleVerdicts() {
    var key = Engine.topologyKey(root.liveMonitors)
    if (!key) return []
    var layout = StateModel.layoutFor(root.state, key)
    if (!layout) return []
    var drift = Engine.driftOf(root.liveClients, root.liveMonitors, layout, StateModel.identities(root.state))
    return Engine.verdictsFor(drift, root.cycleOutcomes)
  }

  // ------------------------------------------------------------- forensics
  //
  // A failed cycle is the only moment this project can capture the exact
  // inputs that produced it, and by the time a human looks the desktop has
  // moved. Everything a fixture needs goes in one file: the reads, the
  // recording, every plan, every op outcome, the verdicts.
  //
  // Two processes rather than one: the first lists the directory, the second
  // writes and prunes. The listing exists so the "keep the newest 10" decision
  // is made by a tested pure function (StateModel.forensicsPrune) instead of by
  // a pipeline of `ls | tail | xargs rm` whose off-by-one nobody would notice
  // until the dump they wanted was the one that got deleted.

  property var pendingForensics: null

  function writeForensics(verdicts, summary) {
    if (root.pendingForensics) {
      root.warn("a forensics dump is already being written — skipping this one")
      return
    }
    var at = new Date().toISOString()
    var name = StateModel.forensicsFileName(at)
    if (!name) {
      root.warn("could not build a forensics filename from \"" + at + "\" — no dump written")
      return
    }

    root.pendingForensics = {
      name: name,
      dump: {
        at: at,
        reason: root.cycleReason,
        topologyKey: root.cycleTopologyKey,
        ok: false,
        failures: root.cycleFailures,
        summary: (summary && summary.text) || "",
        recording: StateModel.layoutFor(root.state, root.cycleTopologyKey),
        identities: StateModel.identities(root.state),
        // The raw reads, verbatim: a dump that had been through a normalizer
        // could not reproduce a bug in the normalizer.
        clients: root.liveClients,
        monitors: root.liveMonitors,
        plans: root.cyclePlans,
        outcomes: root.cycleOutcomes,
        verdicts: verdicts
      }
    }
    forensicsListProc.running = true
  }

  Process {
    id: forensicsListProc
    command: ["bash", "-c", "mkdir -p \"$1\" && ls -1 \"$1\" 2>/dev/null || true", "--", root.forensicsDir]
    stdout: StdioCollector { id: forensicsListOut; waitForEnd: true }
    onExited: function (exitCode) {
      var pending = root.pendingForensics
      if (!pending) return
      if (exitCode !== 0) {
        root.warn("could not prepare " + root.forensicsDir + " (exit " + exitCode + ") — no dump written")
        root.pendingForensics = null
        return
      }

      var names = String(forensicsListOut.text || "").split("\n")
      var prune = StateModel.forensicsPrune(names, StateModel.FORENSICS_KEEP)

      // Temp-then-rename inside the same directory, like every other write
      // this project makes: a reader that catches a half-written dump learns
      // less than nothing.
      var script = 'dir="$1"; name="$2"; payload="$3"; shift 3;'
        + ' printf "%s" "$payload" > "$dir/.$name.tmp" && mv "$dir/.$name.tmp" "$dir/$name" || exit 1;'
        + ' if [ "$#" -gt 0 ]; then (cd "$dir" && rm -f -- "$@"); fi; exit 0'
      var command = ["bash", "-c", script, "--", root.forensicsDir, pending.name,
        JSON.stringify(pending.dump, null, 2) + "\n"]
      forensicsWriteProc.command = command.concat(prune)
      root.pendingForensics = { name: pending.name, pruned: prune.length }
      forensicsWriteProc.running = true
    }
  }

  Process {
    id: forensicsWriteProc
    onExited: function (exitCode) {
      var pending = root.pendingForensics
      root.pendingForensics = null
      if (!pending) return
      if (exitCode !== 0) {
        root.warn("forensics dump failed (exit " + exitCode + "): " + root.forensicsDir + "/" + pending.name)
        return
      }
      // ONE line, and it names the file — the whole point is that the next
      // person to ask "what happened" has a path instead of an investigation.
      root.log("forensics: cycle failed, wrote " + root.forensicsDir + "/" + pending.name
        + (pending.pruned ? " (rotated out " + pending.pruned + " older dump(s))" : ""))
    }
  }

  // The human sentence the panel shows under the badge. Says what changed, or
  // says plainly that nothing needed to.
  function cycleSummary(total) {
    var parts = []
    if (root.opsMoved > 0) parts.push(root.opsMoved + " moved")
    if (root.opsLaunched > 0) parts.push(root.opsLaunched + " launched")
    if (root.opsWorkspace > 0) parts.push(root.opsWorkspace + " workspace")
    if (root.opsGrouped > 0) parts.push(root.opsGrouped + " grouped")
    if (root.opsUngrouped > 0) parts.push(root.opsUngrouped + " ungrouped")
    if (root.opsFloated > 0) parts.push(root.opsFloated + " floated")
    if (root.opsPlaced > 0) parts.push(root.opsPlaced + " placed")
    if (root.opsTiled > 0) parts.push(root.opsTiled + " retiled")
    var text = total > 0 ? parts.join(", ") : "already in place"
    if (root.cycleFailures > 0) text += " — " + root.cycleFailures + " failed"
    return text
  }

  // The one place this plugin speaks to the notification daemon. `body` is
  // optional: a toast with only a summary is exactly right for a state change
  // ("Dock Recall paused") and padding it out with a second line would be
  // words for their own sake.
  //
  // Fire-and-forget through a single Process, so a toast that arrives while an
  // earlier one is still being delivered replaces the command rather than
  // queueing. The two callers cannot collide in practice — a cycle-completion
  // toast and a pause toggle are seconds apart at the closest — and dropping a
  // notification is a better failure than a Process that never gets reset.
  function notify(summary, body) {
    var command = ["notify-send", "-a", "Dock Recall", "-t", "4000", summary]
    if (body !== undefined && body !== "") command.push(body)
    notifyProc.command = command
    notifyProc.running = true
  }

  Process { id: notifyProc }

  Component.onCompleted: {
    root.log("service-ready")
    ensureStateDirProc.running = true
  }
}
