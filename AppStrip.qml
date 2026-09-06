// AppStrip.qml — the apps under the map, as a STRIP: an icon, a name and a
// small switch, several to a line, and everything else on hover.
//
// WHAT IT REPLACES AND WHY (tick 0kv). This was ten bordered 54-px rows, each
// one a shell `Ui/Toggle` with a placement caption stranded on the far right —
// a form, sitting under a map that already says where every window is. The
// human's verdict on first use was that the panel felt clunky, and this list
// was half of the reason: it was heavier than the map, it repeated the map, and
// the one control on it that mattered was a big switch next to a caption nobody
// needed to read twice. The map is the hero; the strip is the switchboard.
//
// THE 54 IS NOT REACHABLE FROM OUT HERE. `Ui/Toggle.qml:45` reads
// `implicitHeight: Math.max(54, content.implicitHeight + Style.spacing.huge)` —
// a literal, with no property in front of it — so every row of a list built out
// of `Ui/Toggle` is 54 px tall whatever it contains. That is why this file uses
// `Ui/ToggleSwitch` directly instead: the switch inside the labeled row,
// factored out by the kit for exactly this, with `trackHeight` settable
// (`ToggleSwitch.qml:58`). The shell does the same thing in its own compact
// placements — `plugins/panels/network/Panel.qml:1317-1322` sizes the switch
// off the label beside it rather than off the theme's control height.
//
// A CELL IS FIXED-WIDTH, and that is not a detail — it is the answer to
// "the right edge holds when an app is unwatched". Every cell is
// `PanelModel.stripLayout`'s `cellWidth`, which is a function of the strip's
// WIDTH alone; the name elides inside it and the switch anchors to its right
// edge. Unticking an app changes a colour and the position of a knob. It cannot
// change a width, and it cannot change how many cells share a line — which is
// what the old list did every time, and what tick 5jl had already had to fix
// once on the caption.
//
// WHY A Grid AND NOT A Flow. The strip wants a wide gap between cells (they are
// separate controls) and a narrow one between lines (they are one list), and
// QtQuick's `Flow` has a single `spacing` for both axes — it inherits it from
// QQuickBasePositioner and adds only `flow` and `layoutDirection`. `Grid` is
// the positioner that carries `rowSpacing` and `columnSpacing` separately, and
// it is also the one that has a use for `stripLayout`'s `columns`: a Flow wraps
// by itself and would never ask. Same relationship to its pure function as the
// map's workspace Flow has to `workspaceGridLayout` — the arithmetic is tested
// in node, the positioner just obeys it.
//
// THREE ROW STATES come out of PanelModel.appRows and all three draw here: an
// unwatched live window (unchecked, clickable), a watched identity (checked),
// and a recorded-but-unwatched GHOST (dimmed, and `clickable: false` when there
// is no pattern left to re-watch from). A ghost sits in the same grid as the
// rest — a strip that reflowed around its ghosts would be telling the user
// about this component's internals rather than about their desktop.
//
// THE INTERFACE IS ONE PROPERTY, the measurement MapWorkspace.qml states at its
// own top and this file repeats. The strip reads thirteen distinct members of
// the panel's root object — the row model, the hover key and the two hover
// sinks, the two icon resolvers, the report sink, `toggleChip`,
// `learnLaunchFor`, the tooltip width, two colours and the font. Thirteen
// pass-through properties would be thirteen places to forget one when the next
// binding needs a fourteenth, so the component takes a handle on the panel
// itself and asks it directly. `grep -o 'panel\.[a-zA-Z]*' AppStrip.qml | sort
// -u` is the complete list, and tests/qml-interface.test.js is the guard that
// every name on it is really declared on Panel.qml's root.

import QtQuick
import qs.Commons
import qs.Ui
import "PanelModel.js" as PanelModel

Grid {
  id: appStrip

  // THE PANEL — the whole interface, and the reason it is one property is at
  // the top of this file.
  required property var panel

  // THE CELL, in Style terms and nowhere else.
  //
  // `popupRowHeight` (28 at the default scale) rather than `controlHeight` or
  // anything derived from `Ui/Toggle`: a cell here is a line in a list you scan,
  // which is what a popup row is, and not a labeled form control.
  //
  // The minimum width is what a cell needs before it stops being readable —
  // an 18-px icon, a name worth eliding and a 27-px switch — and it is the
  // number that decides how many columns there are. The gap is wide (cells are
  // separate switches and must not read as one run-on control); the line
  // spacing is narrow (the lines are one list).
  readonly property int minCellWidth: Style.space(140)
  readonly property int cellGap: Style.space(8)
  readonly property int cellHeight: Style.spacing.popupRowHeight
  // Breathing room inside a cell, at the two ends where its content meets the
  // next cell's. Deliberately not `Style.spacing.rowPaddingX` (12): that is a
  // padding for a full-width row, and on a 150-px cell it would take a fifth of
  // the width away from the name.
  readonly property int cellPaddingX: Style.space(4)

  // How the cells pack, decided by the pure function and obeyed here. See
  // stripLayout for why the number of cells is not allowed to narrow the grid.
  readonly property var packing: PanelModel.stripLayout(
    appStrip.panel.appRows.length, appStrip.width,
    appStrip.minCellWidth, appStrip.cellGap)

  // WHAT THE STRIP ACTUALLY DID, for the payload — read off the delegates, not
  // off `packing`. The two agree by construction, which is exactly what makes a
  // disagreement worth reporting: `packing.columns` is what the arithmetic
  // asked for, and this is how many cells ended up sharing the first line. A
  // strip of three apps in a grid four columns wide answers 3, because 3 is
  // what is on the line.
  function drawnColumns() {
    var n = 0
    for (var i = 0; i < cells.count; i++) {
      var cell = cells.itemAt(i)
      // The Grid puts its first line at y 0; every later line is below it.
      if (cell && cell.y <= 0) n += 1
    }
    return n
  }

  // The height of a cell as laid out, for the same reason: a number restated
  // from Style would pass on a strip whose cells had all collapsed.
  function drawnRowHeight() {
    var first = cells.count > 0 ? cells.itemAt(0) : null
    return first ? Math.round(first.height) : 0
  }

  columns: Math.max(1, appStrip.packing.columns)
  columnSpacing: appStrip.cellGap
  rowSpacing: Style.space(2)

  Repeater {
    id: cells
    model: appStrip.panel.appRows

    delegate: Item {
      id: appCell
      required property var modelData

      width: appStrip.packing.cellWidth
      height: appStrip.cellHeight
      opacity: appCell.modelData.ghost ? 0.6 : 1.0

      // A cell the panel cannot act on does not offer to be clicked: the
      // "recorded · no longer watched" cell has no pattern left to re-watch
      // from (PanelModel.appRows explains why), and its predecessor's ticked
      // box and dead click were the review finding that rule replaced.
      readonly property bool clickable: appCell.modelData.clickable !== false

      // Is the pointer on this app — here, or on one of its chips up on the map?
      readonly property bool linked: appStrip.panel.hoveredLinkKey !== ""
        && appStrip.panel.hoveredLinkKey === appCell.modelData.linkKey

      // EVERYTHING THE CELL CANNOT FIT, which is now everything but the name:
      // the window class, where the app is, where it should be, what is wrong
      // with it, and what Restore can and cannot do for it. The old row printed
      // the last two beside the switch; the cell has no room and no need, since
      // the map above says where things are.
      readonly property string tipText: PanelModel.wrapTooltip(
        PanelModel.rowHoverText(appCell.modelData),
        appStrip.panel.chipTooltipColumns)

      // The app's icon, resolved exactly as a chip's is — identity first, class
      // second, so a ghost cell (which has no window and therefore no class)
      // still finds its own.
      readonly property string iconSource: appStrip.panel.iconSourceOf(
        appCell.modelData.identityId, appCell.modelData.className)
      readonly property bool iconResolved: appStrip.panel.iconResolvedOf(
        appCell.modelData.identityId, appCell.modelData.className)

      // What this cell DREW, read back over IPC. Keyed by the row's own key,
      // which appRows already makes unique across all three states.
      function reportRender() {
        var report = {
          name: String(appCell.modelData.name),
          watched: appCell.modelData.watched === true,
          ghost: appCell.modelData.ghost === true,
          iconSource: appCell.iconSource,
          iconResolved: appCell.iconResolved,
          // The cell's half of the row-to-chip link: the key it answers to, and
          // whether it is answering right now.
          linkKey: String(appCell.modelData.linkKey || ""),
          linked: appCell.linked
        }
        // THE TEXT THE TOOLTIP IS SHOWING, and only while there is a tooltip to
        // show it. Absent otherwise, which is the payload's contract for a key
        // the panel has nothing to say about — tests/acceptance/README.md,
        // "Absent vs `null`", is normative. This is the acceptance venue's only
        // way to read the details the strip moved to hover: it has no pointer
        // rig, so `hoverLink <key>` lights the cell and the cell says back what
        // a real pointer would have made it say.
        //
        // The registry MERGES, so this key survives in the store after the
        // hover ends; panelState() gates it on the `linked` above at read time
        // for exactly that reason, and neither gate is redundant — this one
        // keeps a text for an app nobody ever hovered out of the store, that
        // one keeps a stale one out of the payload.
        if (appCell.linked) report.hoverText = appCell.tipText
        appStrip.panel.reportRow(appCell.modelData.key, report)
      }
      onIconSourceChanged: appCell.reportRender()
      // This was the bug (sm1): the desktop-file scan that resolves an icon
      // lands AFTER open(), so both properties start out ""/false and are
      // re-evaluated once the scan completes. `reportRender()` above is called
      // from `onIconSourceChanged`, and on that pass `iconSource`'s own
      // notification fires and runs its handler BEFORE `iconResolved`'s pending
      // re-evaluation is forced — so the report captured iconSource's fresh
      // value beside iconResolved's stale pre-scan one. `iconResolvedOf` itself
      // was never wrong; nothing told this delegate to report again once ITS
      // value changed. The chip delegate `chipTab` has the identical property
      // and has always carried this handler, which is why only the row's payload
      // showed the disagreement. (Named, not cited by line number: a line
      // reference is wrong at the next insertion above it, and this one was 120
      // lines out.)
      onIconResolvedChanged: appCell.reportRender()
      onLinkedChanged: appCell.reportRender()
      // One handler per captured property, `hoverText` included — the whole of
      // the rule sm1 above cost us, applied to the field this tick adds.
      onTipTextChanged: appCell.reportRender()
      onModelDataChanged: appCell.reportRender()
      Component.onCompleted: appCell.reportRender()

      // The link's list-side listener stays on the CELL rather than moving into
      // the switch: it has to cover the icon and the name too, and it has to
      // keep working on a cell the click is disabled on.
      HoverHandler {
        id: cellHover
        onHoveredChanged: {
          if (cellHover.hovered) appStrip.panel.setHoveredLink(appCell.modelData.linkKey)
          else appStrip.panel.clearHoveredLink(appCell.modelData.linkKey)
        }
        // Re-claim the key on every move too — see the chip MouseArea's
        // onPositionChanged for why: a live pointer must always re-assert its
        // key, not just on entry.
        onPointChanged: {
          if (cellHover.hovered) appStrip.panel.setHoveredLink(appCell.modelData.linkKey)
        }
      }

      // HOVER, as a layer under the cell's content and in the map's own
      // language: the same `hoverFillFor` a chip lights up with, so a pointer on
      // either surface says one thing in one colour. Declared first so it paints
      // underneath, and translucent, as every Style *FillFor is.
      Rectangle {
        anchors.fill: parent
        visible: appCell.linked
        radius: Style.cornerRadius
        color: Style.hoverFillFor(appStrip.panel.foreground, Color.accent)
      }

      Image {
        id: cellIcon
        width: Style.font.iconLarge
        height: Style.font.iconLarge
        anchors.left: parent.left
        anchors.leftMargin: appStrip.cellPaddingX
        anchors.verticalCenter: parent.verticalCenter
        fillMode: Image.PreserveAspectFit
        smooth: true
        // Decoded at physical pixels, for the reason the chip icon is: an
        // upscaled PNG is the one thing an icon may not be.
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: height * Screen.devicePixelRatio
        asynchronous: true
        source: appCell.iconSource
      }

      // The app's name, and the only text on the cell. It ELIDES rather than
      // sizing the cell, because a cell that grew to fit its longest name would
      // put every switch in the strip at a different x — see stripLayout.
      Text {
        id: cellName
        textFormat: Text.PlainText
        text: appCell.modelData.name
        color: appCell.modelData.watched
          ? appStrip.panel.foreground : appStrip.panel.faintForeground
        font.family: appStrip.panel.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
        anchors.left: cellIcon.right
        anchors.leftMargin: Style.space(6)
        anchors.right: cellLearn.left
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
      }

      // "LEARN LAUNCH", which used to be three italic words on the row and is
      // now one accent mark: a command was derived for this app and one click
      // writes it into the state file. It appears only when there is something
      // to press — `launchRepairable` — so it is an offer and never a label,
      // and the words themselves survive in the tooltip, where
      // PanelModel.rowHoverText puts the launch hint.
      //
      // A PLAIN "+" AND NOT A SYMBOL, measured rather than assumed: the theme
      // picks the font family, the default is JetBrainsMono Nerd Font, and
      // `fc-list :charset=...` says that font has no U+270E pencil and no
      // U+21BB refresh arrow. The codepoints that would read best here are
      // emoji-presentation ones, which Qt resolves through a colour emoji font
      // — at which point it is no longer accent-coloured and no longer small.
      // "+" is in every font a theme can name, and it says "add the thing this
      // app is missing", which is precisely the offer.
      Text {
        id: cellLearn
        textFormat: Text.PlainText
        text: "+"
        visible: appCell.modelData.launchRepairable === true
        width: visible ? implicitWidth : 0
        color: Color.accent
        font.family: appStrip.panel.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
        anchors.right: cellSwitch.left
        anchors.rightMargin: cellLearn.visible ? Style.space(4) : 0
        anchors.verticalCenter: parent.verticalCenter
      }

      // The switch, at the cell's right edge — the one thing whose position is
      // identical on every cell in the strip, which is what makes the column of
      // them readable as a switchboard.
      //
      // `trackHeight` is the override the whole file exists for: 1.4 × the
      // caption is a control sized off the text beside it, the way the shell's
      // own compact placements are, instead of a full-size switch scaled down
      // onto fractional pixels.
      ToggleSwitch {
        id: cellSwitch
        anchors.right: parent.right
        anchors.rightMargin: appStrip.cellPaddingX
        anchors.verticalCenter: parent.verticalCenter

        trackHeight: Math.round(Style.font.caption * 1.4)
        cursorPad: Style.space(3)
        // The cell owns the click, so the switch is presentation only — exactly
        // how `Ui/Toggle` parks it at the end of a labeled row.
        interactive: false
        checked: appCell.modelData.watched === true
        foreground: appStrip.panel.foreground
        accent: Color.accent
      }

      // The same multi-line story the chips tell, on the surface that no longer
      // has room to tell any of it. Shown whenever the cell is hovered: the old
      // row had a "says more than the row already does" gate, and it went with
      // the caption it was about — a cell says a name, and the tooltip says the
      // class, the placement, the drift, the diagnosis and the launch hint, so
      // it always says more.
      PanelToolTip {
        visible: cellHover.hovered && appCell.tipText !== ""
        text: appCell.tipText
        fontFamily: appStrip.panel.fontFamily
      }

      // THE CELL OWNS THE CLICK, which is why the switch above is declared
      // `interactive: false` — the same division `Ui/Toggle` makes between the
      // labeled row and the switch parked at the end of it, and it is declared
      // in the same place Toggle declares its own: LAST, over the content, so
      // nothing about which sibling is on top has to be reasoned about. A
      // hand-drawn target that had to be hit exactly would be a checkbox
      // reimplemented, without the kit's fill, border or hover.
      MouseArea {
        id: cellClick
        anchors.fill: parent
        enabled: appCell.clickable
        // Spelled out rather than left to `enabled`: a cell that cannot be
        // acted on must not offer a pointing hand either, and that is a
        // separate claim from whether the click lands.
        cursorShape: appCell.clickable ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: appStrip.panel.toggleChip(appCell.modelData)
      }

      // "Learn launch" is its own click and must NOT also untick the app.
      // Structural rather than an ordering trick: this MouseArea covers the
      // mark alone, and it is declared after the cell-wide one so it wins the
      // press inside those few pixels.
      MouseArea {
        anchors.fill: cellLearn
        enabled: appCell.modelData.launchRepairable === true
        visible: enabled
        cursorShape: Qt.PointingHandCursor
        onClicked: appStrip.panel.learnLaunchFor(appCell.modelData.identityId)
      }
    }
  }
}
