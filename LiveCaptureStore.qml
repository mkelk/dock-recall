// LiveCaptureStore.qml — what the windows look like RIGHT NOW, held in memory
// and nowhere else.
//
// WHAT THIS OWNS. One round of grabs taken when the panel opens, one picture per
// live watched window, kept as a URL an `Image` can be pointed at for
// as long as this component lives. It has no directory, no listing, no eviction
// and no file name, and that absence is not an omission — it IS the design.
//
// MEMORY ONLY, AND IT IS THE HUMAN'S RATIFIED CHOICE (epic tsp), made after
// being shown an on-disk cache as the alternative. `grabToImage` hands the
// callback a QQuickItemGrabResult whose `url` an `Image` can use as its source
// directly, valid for as long as a JS reference to the result is held — so a
// live picture can be drawn without ever reaching a disk. NOTHING HERE MAY EVER
// CALL saveToFile. Everything around the recorded store is about pictures that
// PERSIST: where they are, how they are evicted, what the switch deletes.
// A picture that never persists has none of that surface, and the next author
// who gives this component a cacheDir so it can "share the eviction" has taken
// the thing the human chose and given it back.
//
// -------------------------------------------- why it is not a mode on CaptureStore
//
// CaptureStore is FILE-SHAPED THROUGHOUT. Its `capture()` is mkdir -> evict ->
// resolve -> walk -> saveToFile; its results carry a `file`; its `busy` is read
// by the panel's `canRecord`; its plan carries a topology prefix that exists
// only so an eviction can name it. A "do not write" mode would have to switch
// off four of those five steps, and every one of them left standing would be a
// place a live picture could reach the disk after a later edit. The two rounds
// also want opposite failure policies: a recorded round must finish what a
// Record committed, and a live round must get out of the way the moment the user
// presses Record.
//
// WHAT IS SHARED is the part with no file in it: ToplevelBridge (an hyprctl
// address to a Wayland handle) and the 1x1 host window pattern, both of which
// are read straight from CaptureStore.qml — its comments carry four measurements
// from spike o2x and several defects that cost VM cycles, and they apply here
// word for word:
//
//   1. A FRESH VIEW PER WINDOW, destroyed after the grab.
//   2. With `live: false`, DO NOT CALL captureFrame().
//   3. SIZE FROM sourceSize, never from hyprctl.
//   4. A DEADLINE ON EVERY STEP — a window on a non-rendering monitor never
//      delivers `hasContent` and its handle resolves perfectly.
//
// And the step TOKEN, which is tick 070's repair: `Component.createObject` passes
// its property map through a QVariantMap, so an object handed to a view comes
// back a DEEP COPY and can never be compared by identity. The subject of a step
// is a NUMBER.
//
// ------------------------------------------------------------- RECORD COMES FIRST
//
// `captureStore.busy` gates `canRecord` (tick ilg), deliberately, so a Record
// cannot interleave with a capture round. A live round on every panel open would
// therefore make Record refuse for a moment every single time the panel appeared
// — a new defect, and a worse one than ilg fixed.
//
// So the priority is one-way and it is stated here rather than negotiated at
// each call site: RECORD NEVER WAITS FOR A LIVE ROUND, AND A LIVE ROUND ALWAYS
// WAITS FOR RECORD. Nothing reads this component's `busy` — `canRecord` does not
// mention it, and a test pins that — while `yielding` is bound to
// `captureStore.busy` in the panel. When it goes true this round PARKS: the view
// in flight is destroyed, its token is burnt so a late callback answers for
// nothing, and the queue is kept. When it goes false the round walks on.
//
// That also keeps the compositor to ONE capture session at a time, which is the
// invariant the spike's rule 1 is really about: `busy` is true from
// `capture()`'s first assignment, a whole mkdir before the recorded round builds
// its first view, so the live view is already gone by the time one exists.
//
// ------------------------------------------------------------ best-effort only
//
// A window that will not answer costs its step's deadline and nothing else. A
// chip with no live picture draws its icon, which is what it drew before this
// tick and is the honest fallback — see `captureDrawn` in MapWorkspace.qml,
// where the icon steps aside only for a picture that actually arrived.
//
// The pictures die with the panel, because this component does: the shell
// destroys the panel's Loader on hide, and `clear()` says the same thing out
// loud for the paths where it does not.

import QtQuick
import Quickshell
import Quickshell.Wayland
import "PanelModel.js" as PanelModel

Item {
  id: liveStore

  property string logPrefix: "[dock-recall]"

  // Which screen hosts the 1x1 grab window. It has to be one the compositor is
  // actually rendering, so the panel hands over the focused monitor.
  property var hostScreen: null

  // Mapped while the panel is open, not while a round is in flight, for the
  // reason CaptureStore's host is: a window that has just become visible has not
  // been exposed yet, and a grab on an unexposed window is the one failure this
  // file could not tell apart from a compositor that will not answer.
  property bool hostMapped: false

  // STAND ASIDE FOR RECORD. Bound to `captureStore.busy` by the panel; see
  // "RECORD COMES FIRST" above. Nothing binds the other way.
  property bool yielding: false

  // The widest a live picture is drawn. Same number and same reason as the
  // recorded store's: a chip is a few hundred logical pixels and the map scales
  // to fit, so anything larger is bytes nobody looks at. Here it is also the
  // memory bound — this is the only limit a picture that is never written has.
  property int captureWidth: 512

  // What one window gets before it is declared unphotographable, and what the
  // whole queue gets. Both exist because of measurement 4 above: the handle
  // resolves and the frame never comes.
  property int stepMs: 6000
  property int totalMs: 45000

  // IS THIS APP STILL OWED A PICTURE, at the instant the picture would be kept?
  // Supplied by the panel, which owns the identity list; a store with no
  // predicate answers yes, so this component is still usable on its own.
  //
  // The same shape as CaptureStore's `stillOwed` and for the same reason (tick
  // zxg): a round can be perfectly healthy while the user unticks the very app
  // it is photographing, and the plan is older than the question.
  property var stillOwed: null

  // THE PICTURES, BY WINDOW ADDRESS — and the address is the key precisely
  // because there is no file name to key them by. A live chip IS a window
  // address (PanelModel.chipFor), so the lookup needs no topology, no occurrence
  // and no hash.
  //
  // REASSIGNED on every change, never mutated: a fresh object is what makes a
  // binding that read it re-evaluate. `urlIn` below takes the map as an ARGUMENT
  // for the reason CaptureStore.hasIn does (tick md1) — a binding re-evaluates
  // when a property it READ changes, and `liveStore.pictures` read inside a function
  // is a dependency nobody can see at the call site.
  property var pictures: ({})

  // WHAT KEEPS THE PIXELS ALIVE. A QQuickItemGrabResult is destroyed when the
  // grab callback returns unless a JS reference survives it, and `url` is only
  // valid while the result is. So the results are held here, by address, beside
  // the identity each one belongs to — the identity is what `retain()` needs
  // and what nothing else in a live picture carries.
  //
  // Mutated in place rather than reassigned: no binding reads it, and its only
  // job is to be a GC root.
  property var _held: ({})

  // IS A ROUND IN FLIGHT? Read by `start()`'s own guard and by the panel's log
  // line, and DELIBERATELY BY NOTHING ELSE — `canRecord` must never mention it.
  // See "RECORD COMES FIRST".
  readonly property bool busy: liveStore._queue.length > 0 || liveStore._active

  function log(message) { console.log(liveStore.logPrefix + " " + message) }
  function warn(message) { console.warn(liveStore.logPrefix + " " + message) }

  // ------------------------------------------------------------- the lookup

  // The live picture for this window, out of THIS map. `own`, not a bare lookup:
  // an address that collided with an Object.prototype key would otherwise answer
  // truthy for a picture that is not there (.tick/learnings.md, tick 8hp).
  function urlIn(pictures, address) {
    if (!address || !pictures) return ""
    var key = String(address)
    return Object.prototype.hasOwnProperty.call(pictures, key) ? String(pictures[key]) : ""
  }

  // ------------------------------------------------------------- the round

  property var _queue: []
  property var _results: []
  property var _handles: ({})
  property bool _active: false
  property var _current: null
  property var _plan: null

  // WHICH STEP IS IN FLIGHT, AS A NUMBER (tick 070). An entry handed to
  // `createObject` arrives in the view as a DEEP COPY and can never be compared
  // back, so the thing both sides agree on is an integer — and the token is
  // BURNT when a step ends, or the second answer for a step lands on the item
  // that has just become the head.
  property int _step: 0

  // start(plan) — take a picture of every window the plan names, in order.
  //
  // The plan is PanelModel.liveCapturePlan's: `{ captures: [{ address,
  // identityId, occurrence }], skipped: [...] }`. It carries no prefix and no
  // file names, because there is no file.
  // A ROUND THAT DOES NOTHING SAYS SO, AND THIS IS WHY (tick 2zi, second pass).
  //
  // The first VM run of this feature failed with NO LINE FROM THIS FILE ANYWHERE
  // in a 400-line log, and that absence was the whole diagnosis — because three
  // completely different faults produce it: a round never started, a round
  // started with an EMPTY PLAN (which reached `_finish()` and logged nothing,
  // since the end line was gated on there being something to report), and a
  // round that started and stalled. One silence, three causes, and nothing in
  // the evidence a VM leaves behind to tell them apart.
  //
  // So a round is a BRACKET: one line when it opens saying what it is about to
  // do, one when it closes saying what happened, both unconditional once
  // `start()` has been called. An unclosed bracket is a stall and names itself;
  // a bracket around zero is a desk with nothing to photograph and says that
  // too — including the desk whose pictures are switched off. Tick
  // 070's lesson — a stalled recorded round was invisible for 45 seconds —
  // applied before it costs a second VM cycle rather than after.
  function start(plan) {
    if (liveStore.busy) {
      // One round at a time, exactly as the recorded store has one: two queues
      // over one compositor session is the interleave tick ilg exists to stop.
      // Said out loud even though no user pressed anything, per the bracket rule
      // above: a round that does not happen must not be silent.
      liveStore.warn("a live picture round is already running — this one took no pictures")
      return
    }
    var captures = (plan && plan.captures) ? plan.captures : []
    var withheld = (plan && plan.skipped) ? plan.skipped.length : 0
    liveStore._plan = plan
    liveStore._results = []
    liveStore._queue = captures.slice()
    liveStore._handles = ({})
    liveStore.log("live picture round: " + captures.length + " window(s) to photograph, "
      + withheld + " not pictured")
    if (liveStore._queue.length === 0) {
      liveStore._finish()
      return
    }
    liveStore._resolveThenWalk()
  }

  // EVERY PICTURE, GONE. The panel closing is the only caller: the pictures are
  // discarded when the panel is, and on the path where the Loader survives a
  // hide this is what makes that true anyway.
  function clear() {
    liveStore._abandon("")
    liveStore.pictures = ({})
    liveStore._held = ({})
  }

  // KEEP ONLY WHAT IS STILL WATCHED — unwatching an app, in the only currency
  // this component has.
  //
  // It is NOT an eviction and there is nothing here for one to get right: no
  // process, no directory, no ordering against a write, no failure mode. It is a
  // delete from a map.
  //
  // A SET TO KEEP RATHER THAN AN ID TO DROP, and that shape is the point: a
  // caller handing over "the ids that are left" cannot half-apply it, while a
  // `forget(id)` at each site that drops one app is a duty the next such site
  // would forget. `clear()` above is the other half — the pictures switch takes
  // them ALL, and takes them in one call rather than by handing this an empty
  // set, because "keep nothing" and "there is nothing to keep" are different
  // sentences.
  //
  // The draw-time gate is still what makes the SCREEN correct in the same frame
  // (Panel.liveSourceOf is gated on `picturesOn`, which reads the state model).
  // This is about the pixels: pictures switched off and on again inside one
  // panel session must not bring back a photograph taken before the switch.
  function retain(identityIds) {
    var keep = ({})
    var ids = identityIds || []
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] || "")
      if (id) keep[id] = true
    }

    var pictures = ({})
    var held = ({})
    var dropped = 0
    for (var address in liveStore._held) {
      if (!Object.prototype.hasOwnProperty.call(liveStore._held, address)) continue
      var entry = liveStore._held[address]
      var owner = entry ? String(entry.identityId) : ""
      // `own`, not a bare lookup: an identity id that collides with an
      // Object.prototype key would otherwise keep a picture of an app nobody
      // watches (.tick/learnings.md, tick 8hp).
      if (!owner || !Object.prototype.hasOwnProperty.call(keep, owner)) {
        dropped += 1
        continue
      }
      held[address] = entry
      if (Object.prototype.hasOwnProperty.call(liveStore.pictures, address)) {
        pictures[address] = liveStore.pictures[address]
      }
    }
    if (!dropped) return
    liveStore._held = held
    liveStore.pictures = pictures
    liveStore.log("dropped " + dropped
      + " live picture(s) from memory — their app is no longer watched;"
      + " they were never on disk")
  }

  // The addresses, through the bridge's BOUNDED wait — the same one the recorded
  // round uses, so a live round does not invent a timeout and forget a case.
  function _resolveThenWalk() {
    var addresses = []
    for (var i = 0; i < liveStore._queue.length; i++) addresses.push(liveStore._queue[i].address)

    liveStore._active = true
    total.restart()
    bridge.resolveWhenReady(addresses, function (result) {
      var handles = ({})
      var list = (result && result.handles) ? result.handles : []
      for (var h = 0; h < list.length; h++) handles[String(list[h].address)] = list[h].toplevel
      liveStore._handles = handles
      // The bridge has logged its own refusal if there was one. Walk regardless:
      // a desk on which one window closed still photographs the rest.
      liveStore._next()
    })
  }

  // ONE STEP. Tear the previous view down first — a ScreencopyView holds a
  // compositor capture session, and leaving it alive would keep N of them open
  // across a queue of N.
  function _next() {
    if (liveStore._current) {
      liveStore._current.destroy()
      liveStore._current = null
    }
    guard.stop()

    if (liveStore._queue.length === 0) {
      total.stop()
      liveStore._finish()
      return
    }

    // PARKED. Not an error and not the end of the round: the queue is kept
    // exactly as it is and `_onYield` has already burnt the token, so nothing
    // in flight can answer. `_resume()` calls this again.
    if (liveStore.yielding) return

    liveStore._step = liveStore._step + 1
    var step = liveStore._step

    var entry = liveStore._queue[0]
    var handle = Object.prototype.hasOwnProperty.call(liveStore._handles, entry.address)
      ? liveStore._handles[entry.address] : null
    if (!handle) {
      liveStore._settle(step, false, "no-handle")
      return
    }

    // `step`, not `entry`: a JS object handed to createObject arrives in the
    // view as a COPY and can never be compared back (see `_step`).
    var view = viewComponent.createObject(stage, { captureSource: handle, step: step })
    if (!view) {
      liveStore._settle(step, false, "view-create-failed")
      return
    }
    liveStore._current = view
    guard.restart()
    // NOT captureFrame(): with live:false, assigning captureSource has already
    // started the capture and a second call errors (spike o2x, measured).
  }

  function _isCurrentStep(step) {
    return step > 0 && step === liveStore._step && liveStore._queue.length > 0
  }

  function _currentEntry() {
    return liveStore._queue.length > 0 ? liveStore._queue[0] : null
  }

  function _stillOwed(entry) {
    if (typeof liveStore.stillOwed !== "function") return true
    if (!entry || !entry.identityId) return true
    return liveStore.stillOwed(entry.identityId) === true
  }

  // Record one answer and move on. The only way out of a step, and idempotent
  // per step: the token is burnt here, so the grab callback a guard outlived
  // cannot be accepted against the entry that has just become the head (tick
  // ilg, tick 070).
  function _settle(step, ok, reason) {
    if (!liveStore._isCurrentStep(step)) return
    var entry = liveStore._currentEntry()
    liveStore._step = liveStore._step + 1
    var results = liveStore._results.slice()
    results.push({
      identityId: entry.identityId,
      occurrence: entry.occurrence,
      address: entry.address,
      ok: ok === true,
      reason: ok === true ? "" : String(reason || "")
    })
    liveStore._results = results
    liveStore._queue = liveStore._queue.slice(1)
    // Off this call's stack: `_next` destroys the view whose own signal handler
    // is very often what got us here.
    Qt.callLater(function () { liveStore._next() })
  }

  function _onContent(view) {
    var step = view.step
    if (!liveStore._isCurrentStep(step)) return
    var entry = liveStore._currentEntry()
    // THE PER-WINDOW DEADLINE ENDS HERE (tick ilg): it measures one thing —
    // "does this window ever deliver a frame" — and the frame has arrived. Left
    // running it could fire while `grabToImage` was still on the render thread.
    // The whole-queue deadline below is what still bounds the grab.
    guard.stop()
    var width = view.sourceSize.width
    var height = view.sourceSize.height
    // FROM sourceSize, never from hyprctl — the two disagree (spike o2x).
    if (!(width > 0) || !(height > 0)) {
      liveStore._settle(step, false, "empty-source")
      return
    }

    var targetWidth = Math.max(1, Math.min(liveStore.captureWidth, Math.round(width)))
    var targetHeight = Math.max(1, Math.round(height * (targetWidth / width)))
    var address = String(entry.address)

    var started = view.grabToImage(function (result) {
      // The render thread answers on its own schedule, and the whole-queue
      // deadline or a yield can end this step while it works. A callback whose
      // step is over keeps nothing and says nothing.
      if (!liveStore._isCurrentStep(step)) return
      // AND THE CONSENT IS RE-ASKED AT THE MOMENT THE PICTURE WOULD BE KEPT
      // (tick zxg's rule, in memory rather than on disk). `_isCurrentStep` only
      // says the step is still the one in flight; it says nothing about whether
      // this app is still owed a picture at all.
      if (!liveStore._stillOwed(entry)) {
        liveStore._settle(step, false, "withdrawn")
        return
      }
      if (!result) {
        liveStore._settle(step, false, "grab-null")
        return
      }
      // THE WHOLE OF "MEMORY ONLY", IN TWO LINES. `result.url` is an in-process
      // image URL an Image can be pointed at, valid while the result object is
      // alive — so the result is held (that is what `_held` is for) and the URL
      // is published. There is no saveToFile on this path and there must never
      // be one.
      var url = String(result.url)
      if (!url) {
        liveStore._settle(step, false, "no-url")
        return
      }
      liveStore._held[address] = { identityId: String(entry.identityId), result: result }
      var pictures = ({})
      for (var key in liveStore.pictures) {
        if (Object.prototype.hasOwnProperty.call(liveStore.pictures, key)) {
          pictures[key] = liveStore.pictures[key]
        }
      }
      pictures[address] = url
      liveStore.pictures = pictures
      liveStore._settle(step, true, "")
    }, Qt.size(targetWidth, targetHeight))

    if (!started) liveStore._settle(step, false, "grab-refused")
  }

  // ---------------------------------------------------------- standing aside

  // The panel binds `yielding` to `captureStore.busy`, so this is where a Record
  // takes the compositor back. Parking BURNS THE TOKEN: the view about to be
  // destroyed may already have a grabToImage on the render thread, and its
  // callback must answer for nothing when it lands.
  //
  // The queue is untouched, so the window this step was for is photographed
  // again when the round walks on — a live picture is meant to be of NOW, and
  // the "now" that matters is the one the user is looking at when the panel is
  // in front of them.
  onYieldingChanged: {
    if (liveStore.yielding) liveStore._park()
    else liveStore._resume()
  }

  function _park() {
    if (!liveStore._active) return
    guard.stop()
    total.stop()
    liveStore._step = liveStore._step + 1
    if (liveStore._current) {
      liveStore._current.destroy()
      liveStore._current = null
    }
  }

  // The whole-queue deadline is RESTARTED rather than resumed, and that is
  // deliberate: it budgets this round's own work, not the time it spent standing
  // aside for a Record that may itself run for `totalMs`.
  function _resume() {
    if (!liveStore._active) return
    if (liveStore._queue.length === 0) return
    total.restart()
    liveStore._next()
  }

  // The per-window deadline. Measurement 4: the handle resolves, the monitor is
  // not rendering, and `hasContent` never arrives.
  Timer {
    id: guard
    interval: Math.max(250, liveStore.stepMs)
    repeat: false
    onTriggered: {
      var step = liveStore._current ? liveStore._current.step : 0
      // NOT THE STEP IN FLIGHT: AN IMPOSSIBLE STATE, AND IT SAYS SO (tick 070).
      // `_next()` arms this for the step it has just claimed, `_onContent` stops
      // it when a frame arrives, and `_park()` stops it too — so this branch
      // cannot be reached by any sequence the round can perform. A round that
      // cannot proceed says so and stops; it must NEVER call `_next()`, which
      // would rebuild a view for the same queue head every `stepMs` for ever.
      if (!liveStore._isCurrentStep(step)) {
        liveStore._abandon("live picture round cannot proceed — the per-window deadline fired for step "
          + step + " while step " + liveStore._step + " is in flight over "
          + liveStore._queue.length + " window(s); abandoning the round")
        return
      }
      liveStore._settle(step, false, "no-frame")
    }
  }

  // The whole-queue deadline, on top of the per-window one, for the step that
  // never even reaches a view — a bridge callback that is never called would
  // otherwise leave this round alive for the panel's lifetime.
  Timer {
    id: total
    interval: Math.max(1000, liveStore.totalMs)
    repeat: false
    onTriggered: {
      if (!liveStore._active) return
      liveStore._abandon("live picture round ran out of time after " + total.interval
        + "ms — " + liveStore._queue.length + " window(s) not pictured")
    }
  }

  // END THE ROUND WITHOUT DRAINING IT. `sentence` is "" for the ordinary
  // teardown (`clear()`), and a warning otherwise: a round that cannot proceed
  // fails loudly, in one place rather than one per caller.
  //
  // The pictures ALREADY TAKEN ARE KEPT. That is the difference from the
  // recorded store's `_abandonRound`, and it is right: a live picture is not
  // part of a transaction with a layout, and a chip that has one should go on
  // drawing it whatever became of the windows behind it in the queue.
  function _abandon(sentence) {
    if (sentence) liveStore.warn(sentence)
    guard.stop()
    total.stop()
    liveStore._step = liveStore._step + 1
    if (liveStore._current) {
      liveStore._current.destroy()
      liveStore._current = null
    }
    liveStore._finish()
  }

  // THE SINGLE PLACE a round's state is torn down, and only a round's own state
  // — the pictures are not round state, they are what the round was for.
  function _finish() {
    var plan = liveStore._plan
    var results = liveStore._results
    liveStore._active = false
    liveStore._queue = []
    liveStore._handles = ({})
    liveStore._plan = null
    liveStore._results = []
    // THE CLOSING BRACKET, and it is UNCONDITIONAL once a round has opened one.
    // `_plan` is non-null exactly when `start()` has run and this round has not
    // been torn down yet, so this line pairs one-for-one with the opening line
    // and nothing else — a `clear()` on a panel that never ran a round stays
    // silent, and an empty round now says "0 live picture(s)" rather than
    // nothing at all. It used to be gated on there being something to report,
    // which is precisely how an empty round became indistinguishable from one
    // that never started (see `start()`).
    if (plan) {
      liveStore.log(PanelModel.liveCaptureLogLine(plan, results))
    }
  }

  // --------------------------------------------------------------- the parts

  ToplevelBridge { id: bridge }

  Component {
    id: viewComponent

    ScreencopyView {
      // THE STEP THIS VIEW IS FOR, and deliberately an `int` (tick 070): a JS
      // object assigned through `createObject`'s property map arrives here as a
      // copy, so the round could never recognise its own answers.
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
      onHasContentChanged: if (hasContent) liveStore._onContent(this)
    }
  }

  // The 1x1 host. Background layer, no exclusion, not focusable, transparent —
  // a scene graph on a rendering output and nothing else. Its own namespace, so
  // the two hosts are distinguishable in a layer-shell listing.
  PanelWindow {
    id: host
    screen: liveStore.hostScreen
    visible: liveStore.hostMapped
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    focusable: false
    implicitWidth: 1
    implicitHeight: 1
    WlrLayershell.layer: WlrLayer.Background
    WlrLayershell.namespace: "mkelk-dock-recall-live-capture"

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
