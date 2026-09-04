// ToplevelBridge.qml — an hyprctl address, and the Wayland handle that can be
// photographed.
//
// WHY THIS FILE EXISTS. This plugin thinks in `hyprctl clients` JSON, where a
// window is an opaque `0x…` address. A picture of that window needs a
// `Toplevel` from the Wayland foreign-toplevel protocol, because that is the
// only thing `ScreencopyView.captureSource` accepts. `Quickshell.Hyprland`'s
// toplevel model carries both — `address` matching hyprctl's, and `wayland`
// typed exactly as the capture wants — so the join exists; it just has to be
// reached, and Panel.qml's `Quickshell.Wayland` import is for WlrLayershell
// only. This is the reach.
//
// The matching is in PanelModel.resolveToplevels / classifyToplevels, with
// tests. What is here is what cannot be pure: turning an index back into a live
// QObject, and THE CLOCK.
//
// THE CLOCK IS THE POINT (tick w25). `Hyprland.toplevels` is empty for about a
// second after a shell starts and then fills incrementally, so "the model does
// not have this address" means *the window closed* or *the model has not got
// there yet*, and the two are the same sentence. Nothing pure can tell them
// apart, because the difference is elapsed time and PanelModel.js is clock-free
// by rule (CLAUDE.md). So this file decides it, once, for everyone:
//
//   · a LATCH — the model has been non-empty at least once, and
//   · QUIESCENCE — it has held still for `settleMs` since it last changed.
//
// Both are needed. The latch alone would call a live window "closed" during the
// incremental fill that follows the first entry; quiescence alone would call
// the whole desktop closed in the first tick, when the model is empty and has
// never moved. Together: the model must have shown something, and then stopped
// moving. A window opening later moves it again, and the answer correctly goes
// back to "wait" until it settles.
//
// CONSUMERS: prefer `resolveWhenReady(addresses, callback)`. It is the bounded
// wait, built once here so the capture ticks do not each invent a timeout and
// one of them forget.
//
// WHAT WAS MEASURED (tick o2x, nested sandbox, quickshell 0.3.1, Hyprland 0.56;
// re-measured for the timing claims in tick w25):
//
//   · The model fills ASYNCHRONOUSLY. For roughly the first second of a shell's
//     life `Hyprland.toplevels` is empty; `refreshToplevels()` posts a request
//     and returns, so reading `.values` in the same tick reads nothing.
//
//   · A window that NO MONITOR IS SHOWING can be captured through the handle
//     this returns. That is the whole reason the feature is possible.
//
//   · A window whose monitor is not rendering at all cannot. In the sandbox
//     that is the nested compositor's own parked surface; on a real desk it is
//     a monitor that is off or asleep. `hasContent` simply never arrives — and
//     the HANDLE resolves perfectly, so `ready()` says yes and the capture
//     hangs. That is what `deadlineMs` is for, and why every capture needs a
//     timeout of its own on top of this one.

import QtQuick
import Quickshell.Hyprland
import "PanelModel.js" as PanelModel

QtObject {
  id: bridge

  readonly property string logPrefix: "[dock-recall]"

  // ---------------------------------------------------------------- the clock

  // How long the model must hold still before "not in the model" is read as
  // "the window is gone" rather than "the model has not got there yet".
  // Measured fill is ~1s; this is that, with room.
  property int settleMs: 1200

  // What `resolveWhenReady` spends before it gives up and says so.
  property int deadlineMs: 5000

  // How often a pending wait re-asks. The model is event-driven, so this is a
  // safety net rather than the mechanism.
  property int pollMs: 120

  // Private, and only written by `observe()`. `_lastShape` starts at a sentinel
  // no real model can produce, so the very first observation always registers
  // as a change and starts the settle clock.
  property bool _everFilled: false
  property double _lastChangeMs: 0
  property string _lastShape: "<never observed>"
  property var _waits: []

  property Timer _poller: Timer {
    interval: Math.max(16, bridge.pollMs)
    repeat: true
    running: false
    onTriggered: bridge.pump()
  }

  // Has the model finished filling in? The whole judgement, in one place.
  //
  // A function rather than a property because it depends on `Date.now()`, and a
  // binding over a clock never re-evaluates — it would answer whatever was true
  // when it was first read and never change its mind, which is precisely the
  // bug this file exists to remove.
  function modelSettled() {
    if (!bridge._everFilled) return false;
    if (bridge._lastChangeMs <= 0) return false;
    return (Date.now() - bridge._lastChangeMs) >= Math.max(0, bridge.settleMs);
  }

  // Every snapshot notes the model's SHAPE — which addresses are in it and
  // which of them have a handle — and restarts the settle clock when it
  // changes. Counts alone would miss a swap of one window for another.
  function observe(entries) {
    var shape = [];
    for (var i = 0; i < entries.length; i++) {
      shape.push(entries[i].address + (entries[i].hasWayland ? "!" : "?"));
    }
    var key = shape.join(",");
    if (entries.length > 0) bridge._everFilled = true;
    if (key !== bridge._lastShape) {
      bridge._lastShape = key;
      bridge._lastChangeMs = Date.now();
    }
  }

  // ------------------------------------------------------------- the readings

  // The model, copied into plain JS, with the settle clock updated on the way
  // through. The copy is not tidiness: `Hyprland.toplevels.values` is a
  // QVariant-wrapped V4Sequence, which indexes and has `.length` but is NOT an
  // Array to `Object.prototype`, so a pure function's `isArray()` would
  // silently reject it and every lookup would come back "missing" with nothing
  // in the log to say why (.tick/learnings.md § QML/JS boundary).
  function snapshot() {
    var model = Hyprland.toplevels;
    var entries = PanelModel.toplevelSnapshot(model ? model.values : null);
    bridge.observe(entries);
    return entries;
  }

  // resolve(addresses) -> {
  //   handles:  [ { address, toplevel } ]  in the order asked, repeats collapsed
  //   invalid:  [ raw ]      not an address at all        — PERMANENT
  //   gone:     [ address ]  the settled model does not have it — PERMANENT
  //   pending:  [ address ]  no handle yet, or the model is still filling — RETRY
  //   missing:  [ address ]  the raw bucket `gone`/`pending` was split from
  //   unmapped: [ address ]  ditto
  //   asked:    how many distinct addresses were understood
  //   settled:  whether the model was judged complete when this was read
  //   decided:  nothing here can change — stop polling. NOT "it worked".
  //   ok:       it worked: every address asked for has a handle.
  //   refusal:  one sentence, "" when nothing failed
  // }
  //
  // `refusal === ""` is NOT on its own a success signal — an empty ask refuses
  // nothing. `ok` is the success signal, and `asked` says whether anything was
  // attempted.
  //
  // `toplevel` is the live QObject and is only valid while that window is; hold
  // it for the length of one capture, not across a cycle.
  function resolve(addresses) {
    var result = bridge.evaluate(addresses);
    if (result.refusal !== "") {
      console.warn(bridge.logPrefix, "toplevel bridge:", result.refusal);
    }
    return result;
  }

  // resolve() without the log line. Internal: the poll loop calls this many
  // times a second, and a refusal logged on every tick is a refusal nobody
  // reads. Everything a consumer should call logs.
  function evaluate(addresses) {
    var listRefusal = PanelModel.toplevelAddressListRefusal(addresses);
    if (listRefusal !== "") {
      // Refuse out loud rather than returning an empty plan with an empty
      // refusal, which is this plugin's worst failure mode: "nothing to do,
      // everything fine" over a whole batch nobody photographed.
      return {
        handles: [], invalid: [], missing: [], unmapped: [],
        pending: [], gone: [], asked: 0,
        settled: bridge.modelSettled(), decided: true, ok: false,
        timedOut: false, waitedMs: 0, refusal: listRefusal
      };
    }

    var model = Hyprland.toplevels;
    var values = model ? model.values : null;
    var verdict = PanelModel.classifyToplevels(
      bridge.snapshot(), addresses, bridge.modelSettled());

    var handles = [];
    for (var i = 0; i < verdict.resolved.length; i++) {
      var want = verdict.resolved[i];
      var row = values ? values[want.index] : null;
      if (!PanelModel.toplevelHandleStillValid(
            want, row ? row.address : "", !!(row && row.wayland))) {
        // The model moved between the snapshot and here. Report it as pending —
        // it is exactly the retryable case — rather than pushing a null nobody
        // checked, or a handle for the wrong window.
        verdict.pending.push(want.address);
        continue;
      }
      handles.push({ address: want.address, toplevel: row.wayland });
    }

    verdict.decided = verdict.pending.length === 0;
    verdict.ok = verdict.decided && verdict.gone.length === 0
      && verdict.invalid.length === 0 && handles.length === verdict.asked;
    verdict.handles = handles;
    verdict.timedOut = false;
    verdict.waitedMs = 0;
    verdict.refusal = PanelModel.toplevelBridgeRefusal(verdict);
    return verdict;
  }

  // THE POLL PREDICATE, and it answers one question only: CAN ANY OF THESE
  // ANSWERS STILL CHANGE? False means ask again; true means stop.
  //
  // Derived from the taxonomy rather than from a hunch, which is what the first
  // version was not: `pending` is the only retryable bucket, so `pending` is the
  // only bucket that gates. Both permanent kinds — a junk string and a window
  // that has closed — make it TRUE, because waiting will not improve them. The
  // old predicate gated on `missing` and ignored `invalid`, so a consumer
  // following the documented "poll, do not sleep" advice spun forever on a
  // window the user had shut.
  //
  //   ready([])                     -> true. Nothing was asked, so nothing can
  //                                    change. `resolve([]).asked` is 0 and
  //                                    `ok` is true — an empty queue is not a
  //                                    failure, and not a capture either.
  //   ready(a QML sequence)         -> true. The argument is permanently wrong;
  //                                    polling cannot fix it. `resolve()` says
  //                                    so out loud.
  //   ready(["0xclosed"])           -> false for `settleMs`, then true.
  //   ready(["not-an-address"])     -> true, immediately.
  //
  // TRUE IS NOT SUCCESS. Ask `resolve(addresses).ok` for that, or use
  // `allResolved()`.
  function ready(addresses) {
    if (PanelModel.toplevelAddressListRefusal(addresses) !== "") return true;
    return bridge.evaluate(addresses).decided;
  }

  // The other question: did every address asked for produce a handle?
  function allResolved(addresses) {
    return bridge.evaluate(addresses).ok;
  }

  // ------------------------------------------------------------ bounded waits

  // resolveWhenReady(addresses, callback) — poll until every answer is decided,
  // or `deadlineMs` passes, then call `callback(result)` EXACTLY ONCE with a
  // `resolve()` result carrying `timedOut` and `waitedMs`.
  //
  // This is the wait every capture needs, written once. Without it each capture
  // tick builds its own timer, and the one that forgets hangs the whole cycle
  // on a monitor that is asleep — the handle resolves, `hasContent` never
  // arrives, and nothing times out (measured, tick o2x).
  //
  // Returns false when the call itself was wrong (no callback, a QML sequence
  // for `addresses`); the callback still fires for the latter, with the refusal.
  function resolveWhenReady(addresses, callback) {
    if (typeof callback !== "function") {
      console.warn(bridge.logPrefix,
        "toplevel bridge: resolveWhenReady needs a callback; nothing was scheduled.");
      return false;
    }

    // `evaluate` rather than `resolve`: a wait that is merely PENDING at its
    // first look is the normal case and not a refusal, and a log line saying
    // "cannot picture" about a window that arrives 100ms later is a line that
    // teaches the reader to ignore the log. Anything terminal still logs, here
    // or in `pump`.
    var listRefusal = PanelModel.toplevelAddressListRefusal(addresses);
    var first = bridge.evaluate(addresses);
    if (first.decided) {
      if (first.refusal !== "") {
        console.warn(bridge.logPrefix, "toplevel bridge:", first.refusal);
      }
      // Uniformly asynchronous: a consumer that assigns to a variable after
      // this call must not have the callback beat it there.
      Qt.callLater(function () { callback(first); });
      return listRefusal === "";
    }

    // Post a refresh; the model is NOT updated when it returns.
    bridge.refresh();

    var now = Date.now();
    var waits = bridge._waits.slice();
    waits.push({
      addresses: addresses,
      callback: callback,
      startedMs: now,
      ticks: 0,
      expiresMs: now + Math.max(1, bridge.deadlineMs)
    });
    bridge._waits = waits;
    bridge._poller.running = true;
    return true;
  }

  // One poll tick over every outstanding wait. Public only because QML has no
  // other kind of function; call `resolveWhenReady` instead.
  function pump() {
    if (bridge._waits.length === 0) {
      bridge._poller.running = false;
      return;
    }

    var now = Date.now();
    var still = [];
    var fire = [];
    var i;

    for (i = 0; i < bridge._waits.length; i++) {
      var wait = bridge._waits[i];
      wait.ticks++;
      // The model is event-driven, so this is belt and braces — but a request
      // that was posted before the compositor was answering would otherwise be
      // the whole wait.
      if (wait.ticks % 8 === 0) bridge.refresh();

      var result = bridge.evaluate(wait.addresses);
      if (result.decided) {
        fire.push({ wait: wait, result: result, timedOut: false });
      } else if (now >= wait.expiresMs) {
        fire.push({ wait: wait, result: result, timedOut: true });
      } else {
        still.push(wait);
      }
    }

    bridge._waits = still;
    if (still.length === 0) bridge._poller.running = false;

    // Callbacks last, and off the list: one of them may well start another
    // wait, and it must not be pruned by the loop that is still running.
    for (i = 0; i < fire.length; i++) {
      var done = fire[i];
      done.result.waitedMs = Date.now() - done.wait.startedMs;
      done.result.timedOut = done.timedOut;
      if (done.timedOut) {
        done.result.ok = false;
        done.result.refusal =
          PanelModel.toplevelBridgeRefusal(done.result, done.result.waitedMs);
      }
      if (done.result.refusal !== "") {
        console.warn(bridge.logPrefix, "toplevel bridge:", done.result.refusal);
      }
      done.wait.callback(done.result);
    }
  }

  // Ask Hyprland to re-read its client list. Asynchronous: the model is NOT
  // updated when this returns.
  function refresh() {
    Hyprland.refreshToplevels();
  }
}
