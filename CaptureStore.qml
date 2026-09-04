// CaptureStore.qml — the picture cache, and the machinery that fills it.
//
// WHAT THIS OWNS. Everything about a recorded picture that is not a pure
// decision: the directory, the listing, the eviction, and the doubly
// asynchronous dance that turns an hyprctl address into a JPEG on disk. The
// NAMES are PanelModel's (captureFileName, captureTopologyPrefix, capturePlan)
// and so is the plan — this file only performs it.
//
// It is its own file for the reason MapWorkspace.qml is (tick xk5): Panel.qml
// is the panel, and a capture pipeline with a Wayland host window, a toplevel
// bridge, three subprocesses and a two-callback state machine is a subsystem
// rather than a section.
//
// ------------------------------------------------------------------ the shape
//
// A capture is doubly async and the spike (tick o2x) measured exactly how:
// `hasContent` arrives only after a Wayland buffer round trip, and
// `grabToImage` then queues a render-thread job with a callback of its own. So
// one window is a two-callback chain, and N windows is that chain run STRICTLY
// ONE AT A TIME:
//
//   next() -> a FRESH ScreencopyView(captureSource) -> onHasContentChanged
//          -> grabToImage(cb) -> cb saves -> next()
//
// FOUR THINGS THE SPIKE MEASURED, and each of them is a rule here:
//
//   1. A FRESH VIEW PER WINDOW, destroyed after the grab. Reusing one view
//      races `hasContent`: it is already true from the previous window, so the
//      handler either never fires or fires on the old buffer. Creating N views
//      at once opens N capture sessions on the compositor simultaneously.
//   2. With `live: false`, DO NOT CALL captureFrame(). Assigning `captureSource`
//      already starts one capture, and a captureFrame() in the same tick answers
//      "Cannot capture frame, as no recording context is ready".
//   3. SIZE FROM sourceSize, never from hyprctl. The compositor's captured size
//      and the window geometry hyprctl reports disagree.
//   4. A DEADLINE ON EVERY STEP. A window on a monitor that is not RENDERING —
//      asleep, off — never delivers `hasContent`, and its handle resolves
//      perfectly, so nothing else in the chain notices. Report "no frame" and
//      move on; never block, never write a blank.
//
// A window contributing zero pixels to the screen CAN be captured in full, which
// is the whole reason this feature is possible; a window on a non-rendering
// monitor cannot, which is the one real failure mode.
//
// -------------------------------------------------------------- the host window
//
// grabToImage needs its item in the scene graph of an EXPOSED, RENDERING window,
// so the views live in a 1x1 transparent background layer surface — the
// production-shaped candidate the spike proved. The views overflow it wildly and
// that is fine: a layer surface clips to its own size, so nothing is drawn.
//
// It is mapped for as long as the panel is open rather than only during a
// capture, deliberately: a window that has just become visible has not been
// exposed yet, and a grab on an unexposed window is the one failure this file
// could not tell apart from a compositor that will not answer.
//
// ------------------------------------------------------------ best-effort only
//
// NOTHING HERE MAY EVER FAIL A RECORD. The caller commits the layout first and
// hands this a plan afterwards, off a Qt.callLater so this code does not even
// run on the recording's stack. Every step that can fail records a reason and
// calls next(); the queue always drains; the state file is never touched.
//
// The pictures die with the panel, because this component does: the shell
// destroys the panel's Loader on hide. A user who dismisses the panel in the
// second after pressing Record keeps the recording and loses the pictures, which
// is what best-effort means.

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "PanelModel.js" as PanelModel

Item {
  id: store

  // ~/.cache/omarchy/dock-recall, handed in by the panel so this file owns no
  // paths of its own.
  property string cacheDir: ""
  property string logPrefix: "[dock-recall]"

  // Which screen hosts the 1x1 capture window. It has to be one the compositor
  // is actually rendering, so the panel hands over the focused monitor.
  property var hostScreen: null

  // Mapped while the panel is open. See "the host window" above for why this is
  // not gated on a capture being in flight.
  property bool hostMapped: false

  // The widest a stored picture is. A chip is at most a few hundred logical
  // pixels and the map scales to fit, so anything larger is bytes nobody looks
  // at; 512 is wide enough that a HiDPI chip is not upscaled.
  //
  // MEASURED, not estimated (tick sz6, nested sandbox, this component driven
  // against three text-dense terminal windows — the worst case for JPEG, since
  // a screen of small type is exactly what does not compress):
  //
  //   512 x 575   35,084 bytes      640 x 719   110,023 bytes
  //   512 x 287   21,157 bytes      640 x 359    32,094 bytes
  //   512 x 575   35,703 bytes      640 x 719   110,023 bytes
  //
  // So 21-35 KB a picture at 512, against the design note's 40-60 KB estimate,
  // and twenty apps across three topologies is about 2 MB rather than 3. The
  // 640 column is why the number is not larger: a third more width costs three
  // times the bytes on a tall window, for detail no chip on the map can show.
  property int captureWidth: 512

  // What one window is given before it is declared unphotographable, and what
  // the whole queue is given before it is abandoned. Both exist because of
  // measurement 4 above: the handle resolves and the frame never comes.
  property int stepMs: 6000
  property int totalMs: 45000

  // The basenames the last listing found, as a set. The panel reads this to
  // decide whether a chip has a picture at all — an Image that simply fails to
  // load would draw nothing and report a source that is not there.
  property var files: ({})
  // Bumped on every listing, so a binding can depend on the CONTENT of `files`
  // without `files` having to be reassigned (it is mutated in place, like the
  // panel's render registries).
  property int generation: 0

  readonly property bool busy: store._queue.length > 0 || store._active

  function log(message) { console.log(store.logPrefix + " " + message) }
  function warn(message) { console.warn(store.logPrefix + " " + message) }

  // ------------------------------------------------------------ the listing

  function has(name) {
    if (!name) return false
    return Object.prototype.hasOwnProperty.call(store.files, String(name))
  }

  function pathFor(name) {
    if (!store.cacheDir || !name) return ""
    return store.cacheDir + "/" + String(name)
  }

  // Re-read the directory. Cheap, and the only thing that can tell "there is a
  // picture for this chip" from "there was one before a cleaner ran".
  function refresh() {
    if (!store.cacheDir) return
    listProc.running = false
    listProc.running = true
  }

  // A MISSING CACHE DIRECTORY IS NOT AN ERROR. It is the state the plugin ships
  // in, the state a cleaner leaves behind, and the state a user who has never
  // granted the second consent stays in for ever. `find` exits non-zero for it
  // and says so on stderr; both are swallowed here on purpose, and the answer
  // is an empty set, which is what makes the map fall back to icons.
  Process {
    id: listProc
    command: ["find", store.cacheDir, "-maxdepth", "1", "-type", "f",
              "-name", "*.jpg", "-printf", "%f\n"]
    stdout: StdioCollector { id: listOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function (exitCode) {
      store.files = PanelModel.captureFileIndex(exitCode === 0 ? String(listOut.text || "") : "")
      store.generation = store.generation + 1
    }
  }

  // ------------------------------------------------------------- eviction

  // Delete every picture of one recording. The prefix is
  // PanelModel.captureTopologyPrefix — eight hex digits and a dash, so it
  // carries no glob metacharacter of its own and needs no shell to quote.
  //
  // `find -delete` rather than a listing round trip and `rm`: a name that came
  // back from a listing has to be handed to a second process, and a cache
  // directory is a place other software also writes. One process, no name ever
  // leaving the kernel, and nothing outside the prefix can be named.
  function evict(prefix, reason) {
    if (!store.cacheDir || !prefix) return
    store._evictPrefix = String(prefix)
    store._evictReason = String(reason || "")
    evictProc.running = false
    evictProc.running = true
  }

  property string _evictPrefix: ""
  property string _evictReason: ""

  Process {
    id: evictProc
    command: ["find", store.cacheDir, "-maxdepth", "1", "-type", "f",
              "-name", store._evictPrefix + "*", "-delete"]
    stderr: StdioCollector { waitForEnd: true }
    onExited: {
      // Nothing is logged about the count, because `find -delete` does not
      // report one and a second listing to count what is gone would be a
      // process spawn for a log line. What IS logged is the act and its reason,
      // so the sequence in the log reads as the user's own sequence.
      if (store._evictReason) {
        store.log("dropped the pictures for this layout (" + store._evictReason + ")")
      }
      store.refresh()
      if (store._evictThen) {
        var then = store._evictThen
        store._evictThen = null
        then()
      }
    }
  }

  property var _evictThen: null

  // -------------------------------------------------------------- capturing
  //
  // capture(plan, done) — take every picture the plan asks for, then call
  // `done(results)` exactly once with one entry per capture:
  //
  //   { identityId, occurrence, address, file, ok, reason }
  //
  // `reason` is "" when ok. It is a fact, not an excuse: "no-handle" is a window
  // that closed between the record and the capture, "no-frame" is the
  // non-rendering monitor, "empty-source" is a compositor answering with a zero
  // size, "grab-failed"/"save-failed" are Qt's two ways of declining.
  //
  // THE REPLACED PICTURES GO FIRST. Re-recording a topology overwrites its
  // layout, so it must overwrite its pictures — and the eviction has to COMPLETE
  // before the first save, or `find -delete` would race a file that was just
  // written. That is why the eviction is a step of this sequence rather than a
  // separate call the caller has to remember to make first.

  property var _queue: []
  property var _results: []
  property var _handles: ({})
  property var _plan: null
  property var _done: null
  property bool _active: false
  property var _current: null

  function capture(plan, done) {
    var captures = (plan && plan.captures) ? plan.captures : []
    store._plan = plan
    store._done = (typeof done === "function") ? done : null
    store._results = []

    if (!store.cacheDir) {
      store.warn("no cache directory to store pictures in — nothing was captured")
      store._finish()
      return
    }
    if (store._active || store._queue.length > 0) {
      // One round at a time. A second Record while the first is still
      // photographing would interleave two queues over one compositor session,
      // and the second round's eviction would delete the first round's files
      // as it wrote them.
      store.warn("a capture round is already running — this Record stored no pictures")
      store._finish()
      return
    }

    store._queue = captures.slice()
    store._handles = ({})

    // mkdir, then evict the replaced set, then photograph. Chained through the
    // process exits rather than fired together, because each step's output is
    // the next step's precondition.
    store._evictThen = function () { store._resolveThenWalk() }
    mkdirProc.running = false
    mkdirProc.running = true
  }

  Process {
    id: mkdirProc
    command: ["mkdir", "-p", store.cacheDir]
    stderr: StdioCollector { waitForEnd: true }
    onExited: function (exitCode) {
      if (exitCode !== 0) {
        store.warn("could not create " + store.cacheDir + " — this Record stored no pictures")
        store._finish()
        return
      }
      store.evict(store._plan ? store._plan.prefix : "", "re-recorded")
    }
  }

  // The addresses, through the bridge's BOUNDED wait. `resolveWhenReady` exists
  // exactly so a capture does not invent its own timeout and forget one of the
  // cases — the model fills asynchronously for about a second after a shell
  // start, and "not in the model" means *closed* or *not there yet* until it
  // has settled.
  function _resolveThenWalk() {
    if (store._queue.length === 0) {
      store._finish()
      return
    }
    var addresses = []
    for (var i = 0; i < store._queue.length; i++) addresses.push(store._queue[i].address)

    store._active = true
    total.restart()
    bridge.resolveWhenReady(addresses, function (result) {
      var handles = ({})
      var list = (result && result.handles) ? result.handles : []
      for (var h = 0; h < list.length; h++) handles[String(list[h].address)] = list[h].toplevel
      store._handles = handles
      // The bridge has already logged its own refusal if there was one. Walk
      // the queue regardless: a batch in which one window closed still
      // photographs the rest, which is the whole of best-effort.
      store._next()
    })
  }

  // ONE STEP. Tear the previous view down first — a ScreencopyView holds a
  // compositor capture session, and leaving it alive would keep N of them open
  // across a queue of N.
  function _next() {
    if (store._current) {
      store._current.destroy()
      store._current = null
    }
    guard.stop()

    if (store._queue.length === 0) {
      total.stop()
      store.refresh()
      store._finish()
      return
    }

    var entry = store._queue[0]
    var handle = Object.prototype.hasOwnProperty.call(store._handles, entry.address)
      ? store._handles[entry.address] : null
    if (!handle) {
      store._settle(entry, false, "no-handle")
      return
    }

    var view = viewComponent.createObject(stage, { captureSource: handle, entry: entry })
    if (!view) {
      store._settle(entry, false, "view-create-failed")
      return
    }
    store._current = view
    guard.restart()
    // NOT captureFrame(): with live:false, assigning captureSource has already
    // started the capture and a second call errors (spike o2x, measured).
  }

  // Record one answer and move on. The only way out of a step, so no path can
  // leave the queue holding an entry it has already answered for.
  function _settle(entry, ok, reason) {
    var results = store._results.slice()
    results.push({
      identityId: entry.identityId,
      occurrence: entry.occurrence,
      address: entry.address,
      file: entry.file,
      ok: ok === true,
      reason: ok === true ? "" : String(reason || "")
    })
    store._results = results
    store._queue = store._queue.slice(1)
    // Off this call's stack: `_next` destroys the view whose own signal handler
    // is very often what got us here.
    Qt.callLater(function () { store._next() })
  }

  function _onContent(view) {
    var entry = view.entry
    var width = view.sourceSize.width
    var height = view.sourceSize.height
    // FROM sourceSize, never from hyprctl — the two disagree (spike o2x).
    if (!(width > 0) || !(height > 0)) {
      store._settle(entry, false, "empty-source")
      return
    }

    var targetWidth = Math.max(1, Math.min(store.captureWidth, Math.round(width)))
    var targetHeight = Math.max(1, Math.round(height * (targetWidth / width)))
    var path = store.pathFor(entry.file)

    var started = view.grabToImage(function (result) {
      if (!result) {
        store._settle(entry, false, "grab-null")
        return
      }
      // saveToFile picks the format from the suffix, and the suffix is .jpg —
      // so a chip-sized photograph of a window is tens of kilobytes rather than
      // the megabyte a PNG of the same pixels would be.
      store._settle(entry, result.saveToFile(path) === true, "save-failed")
    }, Qt.size(targetWidth, targetHeight))

    if (!started) store._settle(entry, false, "grab-refused")
  }

  // The per-window deadline. Measurement 4: the handle resolves, the monitor is
  // not rendering, and `hasContent` never arrives.
  Timer {
    id: guard
    interval: Math.max(250, store.stepMs)
    repeat: false
    onTriggered: {
      var entry = store._current ? store._current.entry : null
      if (!entry) {
        store._next()
        return
      }
      store._settle(entry, false, "no-frame")
    }
  }

  // The whole-queue deadline, on top of the per-window one. Belt to its braces:
  // a step that never even reaches a view (a bridge callback that is never
  // called) would otherwise leave the store busy for the panel's lifetime, and
  // `busy` is what stops a second Record from interleaving.
  Timer {
    id: total
    interval: Math.max(1000, store.totalMs)
    repeat: false
    onTriggered: {
      if (!store._active) return
      store.warn("capture round ran out of time after " + total.interval
        + "ms — " + store._queue.length + " window(s) unphotographed; the recording is unaffected")
      guard.stop()
      if (store._current) {
        store._current.destroy()
        store._current = null
      }
      var abandoned = store._queue.slice()
      var results = store._results.slice()
      for (var i = 0; i < abandoned.length; i++) {
        results.push({
          identityId: abandoned[i].identityId, occurrence: abandoned[i].occurrence,
          address: abandoned[i].address, file: abandoned[i].file,
          ok: false, reason: "timed-out"
        })
      }
      store._results = results
      store.refresh()
      store._finish()
    }
  }

  // THE SINGLE PLACE a round's state is torn down. Every early-return path
  // between the guard in capture() and a normal completion must reach this —
  // see the audit above capture(). It resets EVERYTHING the round owns, not
  // just the two fields `busy` reads, because a partially-torn-down round
  // (the queue left populated, say) latches the guard in capture() forever:
  // the next Record sees `busy` — or the queue-length check right below it —
  // still true and refuses, silently, for the panel's lifetime.
  //
  // `_results` is read into a local BEFORE it is reset, so resetting it here
  // does not touch what `done` receives below.
  function _finish() {
    var done = store._done
    var results = store._results
    store._done = null
    store._active = false
    store._queue = []
    store._handles = ({})
    store._evictThen = null
    store._plan = null
    store._results = []
    if (done) done(results)
  }

  // --------------------------------------------------------------- the parts

  ToplevelBridge { id: bridge }

  Component {
    id: viewComponent

    ScreencopyView {
      property var entry: null
      live: false
      paintCursor: false
      visible: true
      x: 0
      y: 0
      // Sized from what the compositor answered with, floored so an unanswered
      // view still has a valid size.
      width: hasContent && sourceSize.width > 0 ? sourceSize.width : 16
      height: hasContent && sourceSize.height > 0 ? sourceSize.height : 16
      onHasContentChanged: if (hasContent) store._onContent(this)
    }
  }

  // The 1x1 host. Background layer, no exclusion, not focusable, transparent —
  // it is a scene graph on a rendering output and nothing else.
  PanelWindow {
    id: host
    screen: store.hostScreen
    visible: store.hostMapped
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    focusable: false
    implicitWidth: 1
    implicitHeight: 1
    WlrLayershell.layer: WlrLayer.Background
    WlrLayershell.namespace: "mkelk-dock-recall-capture"

    anchors {
      top: true
      left: true
    }

    Item {
      id: stage
      anchors.fill: parent
      clip: false
    }
  }
}
