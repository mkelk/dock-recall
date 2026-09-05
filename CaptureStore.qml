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
  //
  // REASSIGNED on every listing, never mutated: a fresh object is what makes a
  // binding that read it re-evaluate. There used to be a `generation` counter
  // beside it for that job, read by the panel through a `< 0` branch that could
  // never be taken — a binding dependency disguised as a guard, pinned by
  // nothing, and one tidy-up away from every chip's picture never refreshing
  // again with no test failure and no visible error (tick md1). `hasIn` below
  // takes the listing as an ARGUMENT instead, so the dependency is in the call
  // and deleting it does not compile.
  property var files: ({})

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

  // Is this basename in THIS listing? The listing is a parameter so that a
  // caller's binding depends on the listing it asked about — a QML binding
  // re-evaluates when a property it READ changes, and `store.files` read inside
  // a function is a dependency nobody can see at the call site.
  //
  // `own`, not a bare lookup: a basename that collides with an Object.prototype
  // key would otherwise answer truthy for a picture that is not there
  // (.tick/learnings.md, tick 8hp).
  function hasIn(files, name) {
    if (!name || !files) return false
    return Object.prototype.hasOwnProperty.call(files, String(name))
  }

  function has(name) {
    return store.hasIn(store.files, name)
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
    store._enqueueEvict([String(prefix) + "*"], "dropped the pictures for this layout",
      reason, then)
  }

  // EVERY PICTURE OF THESE APPS, ON EVERY DESK (tick sp7). The eviction a
  // WITHDRAWN CAMERA needs, and the one this store had no shape for.
  //
  // A camera is a fact about an app, not about a desk. Withdrawing one and
  // deleting a single topology's copies left every other desk's holding
  // photographs with nobody who would ever clean them: Record's eviction runs
  // only for the desk you are on, and so does Forget. So "switch this camera
  // off" has to reach the pictures wherever they were taken, and that is what
  // PanelModel.captureIdentityPatterns names — the file name with the topology
  // segment wildcarded.
  //
  // ONE process for the whole list: withdrawing five cameras at once ("Not for
  // these apps") is one act, and five sequential `find` spawns would be five
  // moments at which it is half done.
  function evictIdentities(identityIds, reason) {
    if (!store.cacheDir) return
    var names = PanelModel.captureIdentityPatterns(identityIds)
    // Nothing to name is not the same as "name everything": an empty list here
    // must delete nothing, exactly as an empty prefix does above.
    if (!names.length) return
    store._enqueueEvict(names,
      "dropped every stored picture of " + names.length + " app(s), on every desk", reason, null)
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
    store._enqueueEvict(["*.jpg"], "dropped every stored picture, on every desk", reason, null)
  }

  // The jobs waiting, and the one running. `_evictMatch` is written by
  // `_startEvict` alone — it is the running job's match expression and nothing
  // else, so `evictProc.command` can never describe a job other than the one in
  // flight.
  //
  // A job carries its own SENTENCE as well as its own names, because the three
  // evictions delete different things and a line reading "this layout" after
  // "No pictures" describes an act narrower than the one that ran.
  property var _evictQueue: []
  property var _evictJob: null
  property var _evictMatch: []

  function _enqueueEvict(names, sentence, reason, then) {
    var queue = store._evictQueue.slice()
    queue.push({
      names: names.slice(),
      sentence: String(sentence),
      reason: String(reason || ""),
      then: (typeof then === "function") ? then : null
    })
    store._evictQueue = queue
    store._startEvict()
  }

  // `find`'s match expression for one job: one `-name`, or several ORed inside
  // a group. Each piece is its own argv element, so the parentheses need no
  // quoting — there is no shell to quote them from.
  function _matchArgs(names) {
    if (names.length === 1) return ["-name", names[0]]
    var out = ["("]
    for (var i = 0; i < names.length; i++) {
      if (i > 0) out.push("-o")
      out.push("-name")
      out.push(names[i])
    }
    out.push(")")
    return out
  }

  function _startEvict() {
    if (store._evictJob || store._evictQueue.length === 0) return
    var job = store._evictQueue[0]
    store._evictQueue = store._evictQueue.slice(1)
    store._evictJob = job
    store._evictMatch = store._matchArgs(job.names)
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
    command: ["find", store.cacheDir, "-maxdepth", "1", "-type", "f"]
      .concat(store._evictMatch).concat(["-delete"])
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
        store.warn("could not delete " + (job ? job.names.join(", ") : "the pictures") + " in "
          + store.cacheDir + " — some pictures may still be on disk"
          + (detail ? ": " + detail : " (find exited " + exitCode + ")"))
      }

      // Nothing is logged about the count, because `find -delete` does not
      // report one and a second listing to count what is gone would be a
      // process spawn for a log line. What IS logged is the act and its reason,
      // so the sequence in the log reads as the user's own sequence.
      //
      // The sentence is the JOB's, because the three evictions delete different
      // things and a line reading "this layout" after "No pictures" would
      // describe an act narrower than the one that ran.
      if (job && job.reason) store.log(job.sentence + " (" + job.reason + ")")
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

  // WHICH STEP IS IN FLIGHT, AS A NUMBER (tick 070). It counts up by one in
  // `_next()` for every step that is started, and the view created for that step
  // carries the same number.
  //
  // A NUMBER AND NOT THE ENTRY OBJECT, and this is the whole of tick 070's
  // repair. The three things that answer for a step — the frame handler, the
  // grab callback and the per-window guard — used to be handed `view.entry` and
  // ask `store._queue[0] === entry`. That comparison CAN NEVER BE TRUE:
  // `Component.createObject(parent, { entry: entry })` passes its properties
  // through a QVariantMap, so what comes back out of the view's `property var`
  // is a DEEP COPY of the queue entry, equal in every field and identical to
  // nothing. Measured in the nested sandbox, 2026-09-04:
  //
  //   entry={"address":"0x557bcc230660","file":"432df7d1-…-0.jpg",
  //          "identityId":"dr-pictured","occurrence":0}
  //   head ={"identityId":"dr-pictured","occurrence":0,
  //          "address":"0x557bcc230660","file":"432df7d1-…-0.jpg"}
  //   entry===head false   head===head2 true   entry.address===head.address true
  //
  // — the key order alone gives the copy away (a QVariantMap sorts them), and
  // reading `store._queue[0]` twice DOES give one object, so it is the view's
  // property that is the boundary and nothing else.
  //
  // What that cost: every answer for a step was discarded as stale. The grab
  // callback returned before saving, `_settle` returned before recording, and
  // the guard fell into its "not the step in flight" branch and called `_next()`
  // — which destroyed the view and built another one for the SAME queue head,
  // every 6 s, until the whole-queue deadline ended the round 45 s later with
  // one window "timed-out" and no picture. No line in between. That is the
  // acceptance VM's silent round, reproduced exactly.
  //
  // An integer crosses the boundary as itself. `_isCurrentStep` is the same
  // question `_isCurrentEntry` asked — is the head of the queue still this
  // step? — asked in a currency the boundary cannot copy.
  property int _step: 0

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

    // The step this window is, claimed before anything can answer for it.
    store._step = store._step + 1
    var step = store._step

    var entry = store._queue[0]
    var handle = Object.prototype.hasOwnProperty.call(store._handles, entry.address)
      ? store._handles[entry.address] : null
    if (!handle) {
      store._settle(step, false, "no-handle")
      return
    }

    // `step`, not `entry`: a JS object handed to createObject arrives in the
    // view as a COPY and can never be compared back (see `_step` above).
    var view = viewComponent.createObject(stage, { captureSource: handle, step: step })
    if (!view) {
      store._settle(step, false, "view-create-failed")
      return
    }
    store._current = view
    guard.restart()
    // NOT captureFrame(): with live:false, assigning captureSource has already
    // started the capture and a second call errors (spike o2x, measured).
  }

  // Is this step the one in flight? The head of the queue IS the step: every
  // path that answers for a step shifts it off and `_next()` claims a new
  // number, so a step that is no longer `_step` has already been answered for —
  // or the whole round has been abandoned underneath it.
  //
  // `step > 0` rejects the default: a view created without one, or a `_current`
  // that is gone, must not accidentally match step zero.
  // IS THIS APP STILL OWED A PICTURE, right now, at the instant we are about to
  // write one? Supplied by the panel, which owns the identity list; a store with
  // no predicate answers yes, so the store is still usable on its own (the
  // sandbox probes instantiate a bare one).
  //
  // Deliberately a QUESTION ASKED LATE rather than a flag copied into the plan.
  // The plan is built when the round starts, and everything this gate exists for
  // happens after that.
  property var stillOwed: null

  function _stillOwed(entry) {
    if (typeof store.stillOwed !== "function") return true
    if (!entry || !entry.identityId) return true
    return store.stillOwed(entry.identityId) === true
  }

  function _isCurrentStep(step) {
    return step > 0 && step === store._step && store._queue.length > 0
  }

  // The entry the step in flight is about, or null. The head of the queue, and
  // it is only ever asked for behind `_isCurrentStep`.
  function _currentEntry() {
    return store._queue.length > 0 ? store._queue[0] : null
  }

  // Record one answer and move on. The only way out of a step, so no path can
  // leave the queue holding an entry it has already answered for.
  //
  // IDEMPOTENT PER STEP (tick ilg). Two things can answer for the same step —
  // the per-window guard and the grab callback it outlived — and a second answer
  // was not merely a duplicate: it pushed an extra result AND shifted the queue
  // again, so one queue entry was dropped unphotographed and unreported. That
  // window is missing from `consentCaptureEntries`, so the prompt never shows it
  // and "Not for these apps" never turns its camera off.
  //
  // The subject is the STEP NUMBER and the entry is read from the queue (tick
  // 070): a caller holding a view's copy of the entry could never be recognised
  // as the step in flight, so every answer was thrown away and the queue never
  // moved.
  function _settle(step, ok, reason) {
    if (!store._isCurrentStep(step)) return
    var entry = store._currentEntry()
    // THE TOKEN IS BURNT HERE, and that is what keeps this idempotent. Shifting
    // the queue used to be enough on its own, because the subject was the entry
    // object and the shifted-off entry could never be the head again. A NUMBER
    // survives the shift, so answering a step has to end it explicitly —
    // otherwise the second answer for step N (the grab callback the guard
    // outlived) would be accepted against the entry that has just become the
    // head, which is tick ilg's dropped window wearing a different hat.
    store._step = store._step + 1
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
    var step = view.step
    // A view whose step is over answers for nothing — it is about to be
    // destroyed, and the round has moved on.
    if (!store._isCurrentStep(step)) return
    var entry = store._currentEntry()
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
      store._settle(step, false, "empty-source")
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
      if (!store._isCurrentStep(step)) return
      // AND THE CONSENT IS RE-ASKED AT THE MOMENT OF THE WRITE (tick 8vc).
      //
      // `_isCurrentStep` only says the step is still the one in flight. It says
      // nothing about whether this app is still owed a picture AT ALL, and the
      // two are not the same question: a round can be perfectly healthy while
      // the user unticks the very app it is photographing. The gate log caught
      // the exact interleave —
      //
      //   recorded 2 apps for topology "… | dr-cap-dock"
      //   unwatched "dr-pictured" — its stored pictures are deleted, on every desk
      //   dropped every stored picture of 1 app(s), on every desk (unwatched)
      //   1 picture(s) stored, 1 not pictured        <- the round's save, AFTER
      //
      // — consent withdrawn, the pictures deleted, and then an in-flight round
      // wrote one back. Making the WITHDRAWAL wait for the round would mean
      // tearing down a live ScreencopyView whose grabToImage can still fire,
      // which is the orphan class tick ilg exists to prevent. So the withdrawal
      // does not wait: the SAVE asks again, at the last instant before the
      // bytes hit the disk, and a picture nobody is owed is never written.
      if (!store._stillOwed(entry)) {
        store._settle(step, false, "withdrawn")
        return
      }
      if (!result) {
        store._settle(step, false, "grab-null")
        return
      }
      // saveToFile picks the format from the suffix, and the suffix is .jpg —
      // so a chip-sized photograph of a window is tens of kilobytes rather than
      // the megabyte a PNG of the same pixels would be.
      store._settle(step, result.saveToFile(path) === true, "save-failed")
    }, Qt.size(targetWidth, targetHeight))

    if (!started) store._settle(step, false, "grab-refused")
  }

  // The per-window deadline. Measurement 4: the handle resolves, the monitor is
  // not rendering, and `hasContent` never arrives.
  Timer {
    id: guard
    interval: Math.max(250, store.stepMs)
    repeat: false
    onTriggered: {
      var step = store._current ? store._current.step : 0
      // NOT THE STEP IN FLIGHT: AN IMPOSSIBLE STATE, AND IT SAYS SO (tick 070).
      // `_next()` arms this timer for the step it has just claimed, `_onContent`
      // stops it the moment a frame arrives, and nothing else moves `_step`, so
      // this branch cannot be reached by any sequence the round can perform.
      //
      // It used to call `store._next()`, which is the shape of the bug this tick
      // closed: `_next()` destroys the view and builds another one for the SAME
      // queue head, so a mismatch that is not self-correcting becomes a silent
      // loop — a fresh compositor capture session every `stepMs`, no result, no
      // log line, until the whole-queue deadline ends the round. A round that
      // cannot proceed has to say so, and stop.
      if (!store._isCurrentStep(step)) {
        store._abandonRound("capture round cannot proceed — the per-window deadline fired for step "
          + step + " while step " + store._step + " is in flight over "
          + store._queue.length + " remaining window(s); abandoning the round rather than retrying it",
          "round-broken")
        return
      }
      store._settle(step, false, "no-frame")
    }
  }

  // END THE ROUND, OUT LOUD (tick 070). The one way a round dies without
  // draining its queue, shared by the whole-queue deadline and by the per-window
  // guard's impossible state, so "a round that cannot proceed fails loudly"
  // has one implementation rather than one per caller.
  //
  // Every window still in the queue gets a result with `reason`, because the
  // consent prompt and the log line are built from the results and a window that
  // is simply absent from them is a window nobody can be told about.
  function _abandonRound(sentence, reason) {
    store.warn(sentence)
    guard.stop()
    total.stop()
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
        ok: false, reason: String(reason)
      })
    }
    store._results = results
    store.refresh()
    store._finish()
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
      store._abandonRound("capture round ran out of time after " + total.interval
        + "ms — " + store._queue.length + " window(s) unphotographed; the recording is unaffected",
        "timed-out")
    }
  }

  // THE SINGLE PLACE a round's state is torn down, and ONLY a round's OWN state
  // (tick ilg): every early-return path AFTER capture()'s guards has to reach
  // this, and no path before them may — a refusal that called this tore down the
  // round that was actually running. That audit is a TEST, not a comment in this
  // file: "_finish() tears down every piece of round state, and every
  // early-return path between the guard and completion reaches it" in
  // tests/panel.test.js walks each path here and asserts it. It resets
  // EVERYTHING the round owns, not
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
      // THE STEP THIS VIEW IS FOR, and deliberately an `int` (tick 070). It used
      // to be `property var entry` carrying the queue entry itself, and a JS
      // object assigned through `createObject`'s property map arrives here as a
      // copy — so the round could never recognise its own answers. See `_step`.
      property int step: 0
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
