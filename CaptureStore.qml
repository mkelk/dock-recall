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

  // IS A ROUND IN FLIGHT? The one truth, and it is LOAD-BEARING (tick ilg):
  // `capture()`'s own guard reads it, and so does the panel — `canRecord` is
  // false while it holds, so a second Record cannot be pressed against a live
  // round at all. Before that it was read nowhere, and a refused Record was the
  // only thing standing between two interleaved queues over one compositor
  // session.
  //
  // `_plan` is in the OR beside the two obvious fields because a round is alive
  // from `capture()`'s first assignment: between there and `_resolveThenWalk`
  // the queue can be empty and `_active` still false, and that window is a whole
  // mkdir and a whole `find` wide.
  readonly property bool busy: store._queue.length > 0 || store._active || store._plan !== null

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
      // Whether the directory is THERE, which is a different question from
      // whether it holds anything — and the one an eviction's failure has to be
      // read against. `find` exits non-zero for a cache directory that was never
      // created, and that is the state the plugin ships in rather than a fault.
      store._cacheDirPresent = (exitCode === 0)
      store.generation = store.generation + 1
    }
  }

  property bool _cacheDirPresent: false

  // ------------------------------------------------------------- eviction

  // Delete every picture of one recording. The prefix is
  // PanelModel.captureTopologyPrefix — eight hex digits and a dash, so it
  // carries no glob metacharacter of its own and needs no shell to quote.
  //
  // `find -delete` rather than a listing round trip and `rm`: a name that came
  // back from a listing has to be handed to a second process, and a cache
  // directory is a place other software also writes. One process, no name ever
  // leaving the kernel, and nothing outside the prefix can be named.
  //
  // ONE AT A TIME, QUEUED, NEVER CLOBBERED (tick ilg). `evictProc` is a single
  // Process shared by five callers, and the pattern, the reason and the
  // continuation used to live in properties beside it. A second eviction
  // therefore SIGTERMed the first and then ran the first's `onExited` against
  // the SECOND's pattern: the wrong sentence in the log, and — the part that
  // mattered — the capture round's "now start walking" continuation fired on a
  // `find` that had been KILLED, breaking the one invariant this sequence has,
  // that the eviction COMPLETES before the first save. Every request is now a
  // job carrying its own pattern, reason and continuation, and the jobs run in
  // the order they were asked for.
  //
  // `then` is how the capture sequence chains onto its own eviction; nobody else
  // passes one.
  function evict(prefix, reason, then) {
    if (!store.cacheDir || !prefix) return
    store._enqueueEvict(String(prefix) + "*", reason, then)
  }

  // EVERY picture, on every desk. The third answer to the first-Record dialogue
  // ("No pictures", tick y28) is the only caller, and it is deliberately a
  // separate function rather than `evict("")`: the prefix form refuses an empty
  // prefix precisely so a caller with an unresolved topology key cannot delete
  // the whole cache by accident, and a wholesale delete has to be something a
  // caller ASKED for by name.
  //
  // The pattern is `*.jpg` and not `*`, so this names only the files this store
  // writes. The directory is ours and holds nothing else today; saying so in the
  // pattern is what keeps that true if it ever stops being.
  function evictAll(reason) {
    if (!store.cacheDir) return
    store._enqueueEvict("*.jpg", reason, null)
  }

  // The jobs waiting, and the one running. `_evictPattern` is written by
  // `_startEvict` alone — it is the running job's pattern and nothing else, so
  // `evictProc.command` can never describe a job other than the one in flight.
  property var _evictQueue: []
  property var _evictJob: null
  property string _evictPattern: ""

  function _enqueueEvict(pattern, reason, then) {
    var queue = store._evictQueue.slice()
    queue.push({
      pattern: String(pattern),
      reason: String(reason || ""),
      then: (typeof then === "function") ? then : null
    })
    store._evictQueue = queue
    store._startEvict()
  }

  function _startEvict() {
    if (store._evictJob || store._evictQueue.length === 0) return
    var job = store._evictQueue[0]
    store._evictQueue = store._evictQueue.slice(1)
    store._evictJob = job
    store._evictPattern = job.pattern
    // The same false/true idiom the listing and the mkdir use, and here it kills
    // nothing: this function is only ever reached with no job in flight. It is
    // needed because `running` is not reliably back to false by the time
    // `onExited` runs, and assigning `true` to a property that is already true
    // is not a change and would start nothing.
    evictProc.running = false
    evictProc.running = true
  }

  Process {
    id: evictProc
    command: ["find", store.cacheDir, "-maxdepth", "1", "-type", "f",
              "-name", store._evictPattern, "-delete"]
    stderr: StdioCollector { id: evictErr; waitForEnd: true }
    onExited: function (exitCode) {
      var job = store._evictJob
      store._evictJob = null

      // A DELETE THAT FAILED IS SAID OUT LOUD (tick ilg). `find`'s exit code was
      // ignored and its stderr went to a collector nothing read, so a picture
      // that could not be removed — a permission, a read-only cache, a full
      // inode table — left a log line claiming the pictures were dropped. The
      // whole promise of this feature is that withdrawing consent removes the
      // files; failing to remove one is precisely the thing a user has to be
      // able to find out about.
      //
      // Read against `_cacheDirPresent`, because the OTHER way `find` exits
      // non-zero is a cache directory that was never created — the state the
      // plugin ships in, which the listing swallows for the same reason.
      if (exitCode !== 0 && store._cacheDirPresent) {
        var detail = String(evictErr.text || "").replace(/\s+$/, "")
        store.warn("could not delete " + (job ? job.pattern : "the pictures") + " in "
          + store.cacheDir + " — some pictures may still be on disk"
          + (detail ? ": " + detail : " (find exited " + exitCode + ")"))
      }

      // Nothing is logged about the count, because `find -delete` does not
      // report one and a second listing to count what is gone would be a
      // process spawn for a log line. What IS logged is the act and its reason,
      // so the sequence in the log reads as the user's own sequence.
      //
      // WHICH pictures, because the two evictions delete different things and a
      // line reading "this layout" after "No pictures" would describe an act
      // narrower than the one that ran.
      if (job && job.reason) {
        store.log((job.pattern === "*.jpg"
          ? "dropped every stored picture, on every desk ("
          : "dropped the pictures for this layout (") + job.reason + ")")
      }
      store.refresh()
      // The continuation belongs to THIS job, and the next job starts whatever
      // it does — a throw in a round's continuation must not strand the queue.
      try {
        if (job && job.then) job.then()
      } finally {
        store._startEvict()
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

  // BOTH REFUSALS COME BEFORE ANY ROUND STATE IS TOUCHED (tick ilg), and
  // neither calls `_finish()`.
  //
  // That ordering is the whole of this repair. `_finish()` is — correctly, since
  // tick gox — the place a round tears ITSELF down, resetting everything it
  // owns. Calling it from a REFUSAL, after `_plan`/`_done`/`_results` had
  // already been overwritten, meant a second Record during a live round tore the
  // FIRST round down instead of the second: the first round's `_done` was lost
  // (so its consent prompt never appeared), `_current` was left alive with a
  // pending `grabToImage`, and `busy` went false — so the round after that
  // passed the guard and ran `mkdir` -> `evict` -> walk while an orphan of round
  // one was still in flight. The orphan then saved a picture over round three's
  // eviction and settled into round three's queue.
  //
  // Before gox, `_finish()` left `_queue` populated, so `busy` stayed true and
  // the third Record was refused too — the latch bug accidentally hid this one.
  // Fixing the latch is what exposed it; nothing here reintroduces the latch,
  // because nothing here writes round state before the guard has passed.
  //
  // A refused Record still owes its caller an answer, so `done([])` is called
  // directly: the caller logs "0 picture(s) stored" and offers no consent
  // prompt, exactly as it did when `_finish()` handed it the same empty list.
  function capture(plan, done) {
    var callback = (typeof done === "function") ? done : null

    if (store.busy) {
      // One round at a time. A second Record while the first is still
      // photographing would interleave two queues over one compositor session,
      // and the second round's eviction would delete the first round's files
      // as it wrote them. `busy` is also what dims Record in the panel, so
      // reaching this at all now takes an IPC call or a race with the binding.
      store.warn("a capture round is already running — this Record stored no pictures")
      if (callback) callback([])
      return
    }
    if (!store.cacheDir) {
      store.warn("no cache directory to store pictures in — nothing was captured")
      if (callback) callback([])
      return
    }

    var captures = (plan && plan.captures) ? plan.captures : []
    store._plan = plan
    store._done = callback
    store._results = []
    store._queue = captures.slice()
    store._handles = ({})

    // mkdir, then evict the replaced set, then photograph. Chained through the
    // process exits rather than fired together, because each step's output is
    // the next step's precondition.
    store._evictThen = function () { store._resolveThenWalk() }
    mkdirProc.running = false
    mkdirProc.running = true
  }

  // The round's continuation, run when the round's OWN eviction job finishes.
  // `_finish()` clears `_evictThen`, so an abandoned round's eviction — one that
  // was still queued when the whole-queue deadline fired — completes and then
  // finds nothing to start.
  function _runEvictThen() {
    var then = store._evictThen
    store._evictThen = null
    if (then) then()
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
      // The directory is there now, so an eviction failing from here on is a
      // real failure and gets said out loud.
      store._cacheDirPresent = true
      store.evict(store._plan ? store._plan.prefix : "", "re-recorded",
        function () { store._runEvictThen() })
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

  // Is this entry the step in flight? The head of the queue IS the step: every
  // path that answers for an entry shifts it off, so an entry that is no longer
  // the head has already been answered for — or the whole round has been
  // abandoned underneath it.
  function _isCurrentEntry(entry) {
    return !!entry && store._queue.length > 0 && store._queue[0] === entry
  }

  // Record one answer and move on. The only way out of a step, so no path can
  // leave the queue holding an entry it has already answered for.
  //
  // IDEMPOTENT PER ENTRY (tick ilg). Two things can answer for the same step —
  // the per-window guard and the grab callback it outlived — and a second answer
  // was not merely a duplicate: it pushed an extra result AND shifted the queue
  // again, so one queue entry was dropped unphotographed and unreported. That
  // window is missing from `consentCaptureEntries`, so the prompt never shows it
  // and "Not for these apps" never turns its camera off.
  function _settle(entry, ok, reason) {
    if (!store._isCurrentEntry(entry)) return
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
    // THE PER-WINDOW DEADLINE ENDS HERE (tick ilg). It measures exactly one
    // thing — "does this window ever deliver a frame" — and the frame has just
    // arrived. Left running, it could fire while `grabToImage` was still on the
    // render thread: the step was settled "no-frame", the view destroyed, and
    // the surviving callback then wrote a picture for a capture already reported
    // failed. The whole-queue deadline below is what still bounds the grab.
    guard.stop()
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
      // THE SAVE ITSELF IS GATED, not just the result (tick ilg). The render
      // thread answers on its own schedule and the whole-queue deadline can end
      // this step while it works; a file written after that is a picture no
      // consent prompt ever showed, that "Not for these apps" cannot reach, and
      // that can land after `evictAll("declined")` has run. So a callback whose
      // step is over writes nothing and says nothing.
      if (!store._isCurrentEntry(entry)) return
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
      // Not the step in flight any more — `_settle` would (rightly) no-op, and
      // nothing would advance the queue. `_next()` is the honest answer.
      if (!store._isCurrentEntry(entry)) {
        store._next()
        return
      }
      store._settle(entry, false, "no-frame")
    }
  }

  // The whole-queue deadline, on top of the per-window one. Belt to its braces:
  // a step that never even reaches a view (a bridge callback that is never
  // called) would otherwise leave the store busy for the panel's lifetime, and
  // `busy` is what stops a second Record from interleaving — and what dims
  // Record in the panel, so a latched round would be a dead button.
  //
  // Since tick ilg it is also the ONLY bound on the grab phase: the per-window
  // guard stops the moment a frame arrives, so a `grabToImage` whose callback
  // never comes is caught here rather than after one more step budget. Its
  // result is honest either way — the entry is reported "timed-out", and a
  // callback that turns up afterwards finds its step over and writes nothing.
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

  // THE SINGLE PLACE a round's state is torn down, and ONLY a round's OWN state
  // (tick ilg): every early-return path AFTER capture()'s guards has to reach
  // this, and no path before them may — a refusal that called this tore down the
  // round that was actually running. It resets EVERYTHING the round owns, not
  // just the fields `busy` reads, because a partially-torn-down round
  // (the queue left populated, say) latches the guard in capture() forever:
  // the next Record sees `busy` still true and refuses, silently, for the
  // panel's lifetime.
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
