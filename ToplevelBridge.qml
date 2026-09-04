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
// The matching is in PanelModel.resolveToplevels, with a test. What is here is
// what cannot be pure: the singleton, and turning an index back into a live
// QObject.
//
// WHAT WAS MEASURED (tick o2x, nested sandbox, quickshell 0.3.1, Hyprland 0.56):
//
//   · The model fills ASYNCHRONOUSLY. For roughly the first second of a shell's
//     life `Hyprland.toplevels` is empty; `refreshToplevels()` posts a request
//     and returns, so reading `.values` in the same tick reads nothing. Poll
//     `ready(addresses)` — do not sleep, and do not read once and give up.
//
//   · A window that NO MONITOR IS SHOWING can be captured through the handle
//     this returns. That is the whole reason the feature is possible.
//
//   · A window whose monitor is not rendering at all cannot. In the sandbox
//     that is the nested compositor's own parked surface; on a real desk it is
//     a monitor that is off or asleep. `hasContent` simply never arrives, so
//     every capture needs a timeout as well as a callback.

import QtQuick
import Quickshell.Hyprland
import "PanelModel.js" as PanelModel

QtObject {
  id: bridge

  readonly property string logPrefix: "[dock-recall]"

  // The model, copied into plain JS. Never hand `Hyprland.toplevels.values`
  // straight to a pure function: it is a QVariant-wrapped V4Sequence, which
  // indexes and has `.length` but is NOT an Array to `Object.prototype`, so
  // PanelModel's own `isArray()` would silently reject it and every lookup
  // would come back "missing" with nothing in the log to say why
  // (.tick/learnings.md § QML/JS boundary).
  function snapshot() {
    var values = Hyprland.toplevels.values;
    var out = [];
    for (var i = 0; i < values.length; i++) {
      out.push({
        address: values[i] ? values[i].address : "",
        hasWayland: !!(values[i] && values[i].wayland)
      });
    }
    return out;
  }

  // resolve(addresses) -> {
  //   handles:  [ { address, toplevel } ]  in the order asked, repeats collapsed
  //   invalid:  [ raw ]      not an address at all
  //   missing:  [ address ]  well-formed, not in the model — the window is gone
  //   unmapped: [ address ]  in the model, no Wayland handle YET — retry
  //   refusal:  one sentence, "" when everything resolved
  // }
  //
  // `toplevel` is the live QObject and is only valid while that window is; hold
  // it for the length of one capture, not across a cycle.
  function resolve(addresses) {
    var values = Hyprland.toplevels.values;
    var plan = PanelModel.resolveToplevels(bridge.snapshot(), addresses);
    var handles = [];
    for (var i = 0; i < plan.resolved.length; i++) {
      var entry = values[plan.resolved[i].index];
      if (!entry || !entry.wayland) {
        // The model moved between the snapshot and here. Report it the way an
        // absent handle is reported rather than pushing a null nobody checked.
        plan.unmapped.push(plan.resolved[i].address);
        continue;
      }
      handles.push({ address: plan.resolved[i].address, toplevel: entry.wayland });
    }
    return {
      handles: handles,
      invalid: plan.invalid,
      missing: plan.missing,
      unmapped: plan.unmapped,
      refusal: PanelModel.toplevelBridgeRefusal(plan)
    };
  }

  // True once every address asked for has a Wayland handle. The poll condition
  // for "is the model filled in yet", which is a real question for about a
  // second after the shell starts and after a window opens.
  function ready(addresses) {
    var plan = PanelModel.resolveToplevels(bridge.snapshot(), addresses);
    return plan.unmapped.length === 0 && plan.missing.length === 0
      && plan.resolved.length > 0;
  }

  // Ask Hyprland to re-read its client list. Asynchronous: the model is NOT
  // updated when this returns.
  function refresh() {
    Hyprland.refreshToplevels();
  }
}
