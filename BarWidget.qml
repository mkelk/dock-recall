// BarWidget.qml — the ambient half of mkelk.dock-recall.
//
// A small monitor-shaped glyph and nothing else: no text in the bar, per the
// UX sketch. What it renders is decided entirely by
// ~/.local/state/omarchy/dock-recall.status.json, which the service
// publishes (see the status schema block in StateModel.js). That is the whole
// reason the status file exists — this widget runs one FileView and never a
// single hyprctl of its own, so a bar with the plugin enabled costs nothing.
//
// Clicking it opens the panel. The route is deliberately the SHELL's, not a
// nested panel of our own: the plugin also declares a `panel` entry point, and
// summoning through the shell means the bar click, the SUPER+SHIFT+L keybind
// and `omarchy-shell shell summon` all land on the same single panel instance.
//
// Reference: /usr/share/omarchy/shell/plugins/panels/clock/BarWidget.qml for
// the bar-widget contract, plugins/menu/BarWidget.qml for a bar button whose
// panel lives on the shell's loader rather than inside the widget.

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "StateModel.js" as StateModel
// For the two pure functions that turn the published status into the glyph's
// one line of text. Free: PanelModel.js is dependency- and clock-free, and the
// bar still runs one FileView and no process of its own.
import "PanelModel.js" as PanelModel

BarWidget {
  id: root
  moduleName: "mkelk.dock-recall"

  readonly property string logPrefix: "[dock-recall]"
  readonly property string statusPath: Quickshell.env("HOME") + "/.local/state/omarchy/dock-recall.status.json"

  // The published status, and the glyph rendering it calls for. A status file
  // that is missing, empty or corrupt lands on the default — which reads as
  // "hollow", the honest answer for a service that has not spoken yet.
  property var status: StateModel.defaultStatus()
  readonly property string glyph: StateModel.glyphState(root.status)
  // The desk this status is about, named the way the panel header names it.
  //
  // The service publishes the humanized name alongside the key precisely so
  // this widget does not have to earn it: humanizing here, with no monitor
  // list, cannot tell a built-in laptop panel from any other screen and leaves
  // the part number in the tooltip. The local humanize stays as the fallback
  // for a status file written before the field existed — correct, just less
  // friendly — because reading hyprctl to do better is the one cost this
  // widget exists to avoid.
  readonly property string topologyName: root.status.topologyName
    ? root.status.topologyName
    : PanelModel.humanizeTopology(root.status.topologyKey, [])

  // Paused draws the HOLLOW silhouette with a slash across it: the tool is not
  // acting, so the glyph should not look like a tool that is. The slash is what
  // keeps it distinct from plain hollow ("nothing recorded here"), which is a
  // statement about this desktop rather than about the plugin.
  readonly property bool paused: root.glyph === "paused"
  readonly property bool filled: root.glyph !== "hollow" && !root.paused
  readonly property bool sweeping: root.glyph === "restoring"

  // ------------------------------------------------------------------ theme
  //
  // Everything is a theme token; nothing here picks a colour of its own. The
  // sketch calls the drift marker "amber", but an Omarchy theme has no amber —
  // it has ACCENT (the colour a theme uses for "look here") and URGENT (the
  // one it uses for "this went wrong"), and those are exactly the two
  // distinctions the two dots need to carry.
  //
  // Panel.qml's `driftTone` is this line's twin — the drift chip edge and its
  // `→ target` pill — and carries the gap in full (tick wgj, finding F1). The
  // bar and the panel are two views of one state; if a warning role ever
  // reaches the shell's Color singleton, both change together or neither does.
  readonly property color glyphColor: root.bar ? root.bar.barForeground : Color.foreground
  readonly property color driftColor: Color.accent
  readonly property color failColor: root.bar ? root.bar.urgent : Color.urgent
  // The dot sits half outside the screen rectangle and needs to read against
  // both the glyph and the bar behind it, so it is ringed in the bar's own
  // background — the same trick the sketch uses.
  readonly property color ringColor: root.bar ? root.bar.background : Color.bar.background

  // Two states carry a dot, and NOTHING else may: the dot is the whole
  // difference between "recorded and fine" and "look at this", and a glyph that
  // wears one permanently says neither.
  //
  // This is a state test rather than a colour test on purpose. The dot used to
  // be hidden with `dotColor !== "transparent"`, which never once fired: QML
  // compares a `color` property against a string by coercing the STRING to a
  // colour, and #00000000 is a perfectly good colour that is not equal to any
  // other one — so the expression was true in every state and an invisible
  // (fully transparent) dot was drawn over the filled and hollow glyphs too.
  // Ask the glyph what it is; never ask a colour what it means.
  // Paused needs no exception here: glyphState resolves to exactly one word, and
  // "paused" outranks both dot states, so a paused glyph cannot carry a dot.
  // The precedence lives in one function rather than in a condition on every
  // surface that draws it.
  readonly property bool showDot: root.glyph === "failed" || root.glyph === "drifted"

  readonly property color dotColor: root.glyph === "failed" ? root.failColor : root.driftColor

  // How present the glyph looks. Paused is dimmer than hollow — hollow is "I
  // have nothing to say about this desktop", paused is "I am not listening" —
  // but not so faint that the slash stops reading at bar size.
  readonly property real glyphOpacity: root.paused ? 0.5 : (root.filled ? 1.0 : 0.6)

  // ---------------------------------------------------------------- geometry
  //
  // Sized off the icon token rather than a fixed pixel count, so the glyph
  // grows with the bar when the user changes the text size.
  readonly property int screenWidth: Math.max(8, Math.round(Style.font.icon * 1.15))
  readonly property int screenHeight: Math.max(6, Math.round(root.screenWidth * 0.66))
  readonly property int standHeight: Math.max(1, Math.round(root.screenHeight * 0.16))
  readonly property int standGap: Math.max(1, Math.round(root.screenHeight * 0.10))
  readonly property int glyphHeight: root.screenHeight + root.standGap + root.standHeight
  readonly property int dotSize: Math.max(5, Math.round(root.screenWidth * 0.42))

  function log(message) {
    console.log(root.logPrefix + " " + message)
  }

  // ------------------------------------------------------------ panel access
  //
  // The shell owns the panel: `summon`/`hide`/`toggle` route by plugin id and
  // deliver the payload, which is how the keybinding's {"focus":"restore"}
  // reaches the same instance a bar click opens.
  readonly property var hostShell: root.bar ? root.bar.shell : null

  // Is the shell routing this plugin's summons to the PANEL loader?
  //
  // This is a guard against a real recursion, not a style check.
  // shell.summon() sends a plugin that is bar-widget-only straight back to the
  // bar widget's own open() — so calling summon() from open() without asking
  // first is an infinite loop the moment the panel entry point is missing or
  // the manifest has not been rescanned. Asking the shell which way it will
  // route means a click is simply inert until the panel is really there.
  readonly property bool panelRouted: root.hostShell
    && typeof root.hostShell.isBarWidgetPanelPlugin === "function"
    && root.hostShell.isBarWidgetPanelPlugin(root.moduleName) === false

  // The bar-widget contract: Bar.findPanelWidget needs open/close and a
  // readonly `opened` on the widget root, and the popout coordinator prefers
  // closeForPopoutSwitch over close.
  readonly property bool opened: root.hostShell && root.hostShell.openPanelIds
    ? root.hostShell.openPanelIds[root.moduleName] === true
    : false

  function summonPanel(payloadJson) {
    if (!root.panelRouted) {
      root.log("panel is not registered with the shell yet — bar click ignored")
      return
    }
    root.hostShell.summon(root.moduleName, payloadJson || "{}")
  }

  function open() { root.summonPanel("{}") }

  function close() {
    if (!root.panelRouted) return
    root.hostShell.hide(root.moduleName)
  }

  function togglePanel() {
    if (!root.panelRouted) {
      root.log("panel is not registered with the shell yet — bar click ignored")
      return
    }
    root.hostShell.toggle(root.moduleName, "{}")
  }

  function toggle() { root.togglePanel() }

  // Nothing extra to unwind: the panel is a shell-owned surface, so switching
  // popouts is an ordinary close.
  function closeForPopoutSwitch() { root.close() }

  // ------------------------------------------------------------ status feed

  function applyStatus(raw) {
    var read = StateModel.parseStatus(raw)
    root.status = read.status
  }

  // The glyph is a picture with no text, which makes it the one part of this
  // plugin that cannot be inspected from a log — so it says what it turned
  // into. Cheap (it fires on transitions, not on reads) and it is the only
  // way to tell "the widget is not reacting" from "the widget is not there".
  onGlyphChanged: root.log("bar glyph -> " + root.glyph
    + " (recorded=" + root.status.recorded + " drift=" + root.status.driftCount
    + " restoring=" + root.status.restoring + " paused=" + root.status.paused + ")")

  Component.onCompleted: root.log("bar widget ready, glyph " + root.glyph)

  FileView {
    id: statusFile
    path: root.statusPath
    watchChanges: true
    // The service may not have published yet (or at all, if the plugin's
    // service half is disabled). A missing file is an expected state here, not
    // a fault worth a stack trace.
    printErrors: false
    onLoaded: root.applyStatus(text())
    onLoadFailed: root.applyStatus("")
    onFileChanged: reload()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The label is the glyph's stand-in only for sizing; everything visible is
    // drawn below.
    text: ""
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.vertical ? -1 : Math.round(root.screenWidth + Style.spaceReal(8.5) * 2)
    fixedHeight: root.vertical ? Style.bar.iconSlot : -1
    // WHICH desk, and what the plugin thinks of it.
    //
    // The glyph is a picture with no text — that is the point of it — so the
    // tooltip is the only place the ambient half of this plugin can name the
    // topology it is talking about. It says what pausing actually does, too,
    // because a user who paused it a week ago and now wonders why a dock did
    // nothing gets the answer by hovering.
    //
    // The name is the one the SERVICE published (see topologyName above), so
    // the tooltip says "Laptop + AOC U34G2G" — the same words as the panel
    // header — rather than the EDID part numbers behind them.
    //
    // Wrapped like every other tooltip the plugin builds (PanelModel.wrapTooltip)
    // — the shell's ToolTip has no wrap mode of its own, so an unwrapped topology
    // name can run past the bar's edge exactly as the panel's tooltips did before
    // they were wrapped. 40 columns matches the panel's chip/row tooltips.
    tooltipText: PanelModel.wrapTooltip(PanelModel.barGlyphTooltip(root.glyph, root.status, root.topologyName), 40)

    onPressed: function (b) { root.togglePanel() }

    Item {
      id: glyph
      anchors.centerIn: parent
      width: root.screenWidth
      height: root.glyphHeight

      // The screen. Hollow is the same rectangle with no fill and a dimmed
      // outline, so the two states share a silhouette and only their weight
      // changes — which is what makes the difference readable at bar size.
      Rectangle {
        id: screen
        width: parent.width
        height: root.screenHeight
        radius: Math.max(1, Math.round(height * 0.2))
        color: root.filled ? root.glyphColor : "transparent"
        border.width: Math.max(1, Math.round(root.screenHeight * 0.14))
        border.color: root.glyphColor
        opacity: root.glyphOpacity
        clip: true

        Behavior on opacity {
          NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
        }

        // The restore sweep: a band of the bar's own background travelling
        // across the filled screen. Only ever running while the service says
        // it is working, so an idle bar animates nothing.
        Rectangle {
          id: sweepBand
          width: Math.max(2, Math.round(screen.width * 0.45))
          height: screen.height
          visible: root.sweeping
          color: Qt.rgba(root.ringColor.r, root.ringColor.g, root.ringColor.b, 0.55)

          NumberAnimation on x {
            running: root.sweeping
            from: -sweepBand.width
            to: screen.width
            duration: 1400
            loops: Animation.Infinite
          }
        }

        // The pause slash: corner to corner across the screen, in the glyph's
        // own colour so it needs no token of its own. Drawn INSIDE the screen
        // rectangle, which clips — so the line stops at the bezel instead of
        // hanging out over the bar, and the shape still reads as a monitor.
        Rectangle {
          id: pauseSlash
          visible: root.paused
          width: Math.round(Math.sqrt(screen.width * screen.width + screen.height * screen.height))
          height: Math.max(1, Math.round(root.screenHeight * 0.16))
          radius: height / 2
          color: root.glyphColor
          x: Math.round((screen.width - width) / 2)
          y: Math.round((screen.height - height) / 2)
          // The true corner-to-corner angle rather than a flat 45°: the screen
          // is wider than it is tall, and a 45° line would meet the sides
          // instead of the corners.
          rotation: -Math.atan2(screen.height, screen.width) * 180 / Math.PI
          transformOrigin: Item.Center
        }
      }

      // The stand, so the shape reads as a monitor and not as a button.
      Rectangle {
        width: Math.max(2, Math.round(parent.width * 0.42))
        height: root.standHeight
        radius: Math.max(1, Math.round(height / 2))
        color: root.glyphColor
        opacity: screen.opacity
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.screenHeight + root.standGap
      }

      // Drift / failure marker, half outside the top-right corner and ringed
      // in the bar background so it stays legible over the filled glyph.
      Rectangle {
        visible: root.showDot
        width: root.dotSize
        height: root.dotSize
        radius: width / 2
        color: root.dotColor
        border.width: Math.max(1, Math.round(root.dotSize * 0.2))
        border.color: root.ringColor
        x: parent.width - Math.round(width * 0.55)
        y: -Math.round(height * 0.3)
      }
    }
  }
}
