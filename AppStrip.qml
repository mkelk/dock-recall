// AppStrip.qml — the flat list under the map: one row per app, and everything
// drawn on it — the icon, the switch, the launch hint and the placement text.
//
// Every row is the shell's Ui/Toggle: the LABELED one, which wraps a
// ToggleSwitch with `interactive: false` so the ROW owns the click. That is the
// component this list wanted — a hand-drawn teal square that had to be clicked
// through the row around it was a checkbox reimplemented, without the kit's
// fill, border, focus ring or keyboard.
//
// Around it, unchanged in role: the app's icon on the left (same resolution
// path as the chips), and on the right the launch hint and the placement text
// with its drift colouring. They sit OUTSIDE the Toggle rather than inside it
// because Toggle gives its label whatever width is left after the switch, and
// there is no way to reach in past that — anchoring them to the row and the
// Toggle to them keeps every width derived rather than guessed.
//
// THREE ROW STATES come out of PanelModel.appRows and all three draw here: an
// unwatched live window (unchecked, clickable), a watched identity (checked),
// and a recorded-but-unwatched GHOST (dimmed, and `clickable: false` when there
// is no pattern left to re-watch from).
//
// WHY IT IS ITS OWN FILE. This was `Panel.qml`'s "the flat list" block: 277
// lines sitting six levels down — a Column in a Column in a ScrollView in a
// PanelKeyCatcher in a BorderSurface in a PanelWindow — with the row delegate
// at eight and its tooltip's condition at thirteen. Half of the block is
// comment (131 lines of the 277), and at that depth the usable column is about
// fifty-five characters, so the prose that is this list's only explanation cost
// close to twice the lines it needed and had already begun breaking identifiers
// across lines to fit: `reportRender()` was written `report` / `Render()`.
// Extracted in tick kex with no behaviour change at all: the same bindings in
// the same order, the same comments word for word, rewrapped to a column that
// fits them. Exactly as tick xk5 moved the map out to MapWorkspace.qml, and for
// the same reason.
//
// THE INTERFACE IS ONE PROPERTY, the measurement MapWorkspace.qml states at its
// own top and this file repeats. The strip reads thirteen distinct members of
// the panel's root object — the row model, the hover key and the two hover
// sinks, the two icon resolvers, the report sink, `toggleChip`,
// `learnLaunchFor`, the tooltip width, two colours and the font. Thirteen
// pass-through properties would be thirteen places to forget one when the next
// binding needs a fourteenth, so the component takes a handle on the panel
// itself and asks it directly.

import QtQuick
import qs.Commons
import qs.Ui
import "PanelModel.js" as PanelModel

Column {
  id: appStrip

  // THE PANEL — the whole interface, and the reason it is one property is at
  // the top of this file. Everything this component asks of the panel it asks
  // through here, so `grep -o 'panel\.[a-zA-Z]*' AppStrip.qml | sort -u` is the
  // complete list of what an extraction has to keep working.
  required property var panel

  spacing: Style.space(4)

  Repeater {
    model: panel.appRows

    delegate: Item {
      id: appRow
      required property var modelData

      width: parent.width
      height: rowToggle.implicitHeight
      opacity: appRow.modelData.ghost ? 0.6 : 1.0

      // Is the pointer on this app — here, or on one of its chips up on the map?
      readonly property bool linked: panel.hoveredLinkKey !== ""
        && panel.hoveredLinkKey === appRow.modelData.linkKey
      readonly property string tipText: PanelModel.wrapTooltip(
        PanelModel.rowTooltipText(appRow.modelData),
        panel.chipTooltipColumns)

      // The app's icon, resolved exactly as a chip's is — identity first, class
      // second, so a ghost row (which has no window and therefore no class)
      // still finds its own.
      readonly property string iconSource: panel.iconSourceOf(
        appRow.modelData.identityId, appRow.modelData.className)
      readonly property bool iconResolved: panel.iconResolvedOf(
        appRow.modelData.identityId, appRow.modelData.className)

      // What this row DREW, read back over IPC. Keyed by the row's own key,
      // which appRows already makes unique across all three states.
      function reportRender() {
        panel.reportRow(appRow.modelData.key, {
          name: String(appRow.modelData.name),
          watched: appRow.modelData.watched === true,
          ghost: appRow.modelData.ghost === true,
          iconSource: appRow.iconSource,
          iconResolved: appRow.iconResolved,
          // The row's half of the row-to-chip link: the key it answers to, and
          // whether it is answering right now.
          linkKey: String(appRow.modelData.linkKey || ""),
          linked: appRow.linked
        })
      }
      onIconSourceChanged: appRow.reportRender()
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
      onIconResolvedChanged: appRow.reportRender()
      onLinkedChanged: appRow.reportRender()
      onModelDataChanged: appRow.reportRender()
      Component.onCompleted: appRow.reportRender()

      // The link's list-side listener stays on the ROW rather than moving into
      // the Toggle: it has to cover the icon and the placement text too, and it
      // has to keep working on a row the Toggle itself is disabled on.
      HoverHandler {
        id: rowHover
        onHoveredChanged: {
          if (rowHover.hovered) panel.setHoveredLink(appRow.modelData.linkKey)
          else panel.clearHoveredLink(appRow.modelData.linkKey)
        }
        // Re-claim the key on every move too — see the chip MouseArea's
        // onPositionChanged for why: a live pointer must always re-assert its
        // key, not just on entry.
        onPointChanged: {
          if (rowHover.hovered) panel.setHoveredLink(appRow.modelData.linkKey)
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
        // Decoded at physical pixels, for the reason the chip icon is: an
        // upscaled PNG is the one thing an icon may not be.
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: height * Screen.devicePixelRatio
        asynchronous: true
        source: appRow.iconSource
      }

      Toggle {
        id: rowToggle
        anchors.left: rowIcon.right
        anchors.leftMargin: Style.space(8)
        anchors.right: rowLaunch.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter

        label: appRow.modelData.name
        checked: appRow.modelData.watched === true
        // The list has no keyboard cursor of its own — the panel's walks the
        // chips — so `hasCursor` carries the LINK instead. It drives the same
        // hover fill the map uses, which is what the hand-drawn Rectangle behind
        // this row used to do: one language for one hover, now the kit's.
        hasCursor: appRow.linked
        // A row the panel cannot act on does not offer to be clicked: the
        // "recorded · no longer watched" row has no pattern left to re-watch
        // from (PanelModel.appRows explains why), and its predecessor's ticked
        // box and dead click were the review finding this replaces.
        enabled: appRow.modelData.clickable !== false
        foreground: panel.foreground
        accent: Color.accent
        fontFamily: panel.fontFamily
        titleSize: Style.font.caption
        onClicked: panel.toggleChip(appRow.modelData)
      }

      // What Restore can and cannot do for this app, in three words. "no launch
      // cmd" is the honest dead end — nothing on this machine says how to start
      // it, so a restore will move its window if it is open and skip it if it is
      // not. "learn launch" is an offer: a command was derived and one click
      // writes it. "launch cmd looks broken" is a warning about a command
      // already in the file that cannot run (a whole command line quoted as one
      // word, from before the quoting fix) — an offer too when a replacement was
      // derived, which is what `launchRepairable` says and the colour shows.
      Text {
        id: rowLaunch
        textFormat: Text.PlainText
        text: appRow.modelData.launchHint || ""
        visible: text !== ""
        width: visible ? implicitWidth : 0
        color: appRow.modelData.launchRepairable ? Color.accent : panel.faintForeground
        font.family: panel.fontFamily
        font.pixelSize: Style.font.caption
        font.italic: true
        anchors.right: rowWhere.left
        anchors.rightMargin: rowLaunch.visible ? Style.space(8) : 0
        anchors.verticalCenter: parent.verticalCenter
      }

      // Where the app is, where it should be, and — since the verdict table —
      // WHAT is wrong with it.
      //
      // The arrow alone said the same thing about every kind of drift: a window
      // sitting in exactly the right place with its tabs the wrong way round got
      // "ws 10 → DP-2 · ws 10", which reads as a contradiction rather than as a
      // diagnosis. The mismatch phrase is the diagnosis, and when the last
      // restore tried and was refused it carries the compositor's reason too
      // (PanelModel.verdictLine).
      //
      // Capped and elided: a blocked reason can be a sentence, and the app's own
      // name must not be squeezed out by it. The full text is in the tooltip.
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
          ? Color.accent : panel.faintForeground
        font.family: panel.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
        // A FIXED COLUMN, NOT A CONTENT WIDTH (tick 5jl, second pass — found
        // live, by unwatching an app).
        //
        // This was `Math.min(implicitWidth, 45%)`, so the caption was as wide as
        // whatever it happened to say — and every control on the row anchors
        // leftwards off it. Unwatch an app and its caption grows from
        // "eDP-1 · ws 3" to "eDP-1 · ws 3 · recorded · no longer watched", which
        // dragged that row's switch and whole bordered box visibly inward while
        // its neighbours stayed put.
        //
        // The column is FIXED, so the right edge holds however long the caption
        // gets. (5jl's first pass reserved a column for the per-app camera,
        // which was the same defect one step further in; the camera is gone with
        // the consent model it belonged to, and this half of the answer is what
        // is left and still load-bearing.)
        //
        // The width is the old CAP, so nothing that fits today starts eliding; a
        // longer caption elides and keeps its tooltip, which is what the tooltip
        // is already for.
        width: Math.round(appRow.width * 0.45)
        horizontalAlignment: Text.AlignRight
        anchors.right: parent.right
        anchors.rightMargin: Style.spacing.rowPaddingX
        anchors.verticalCenter: parent.verticalCenter

        HoverHandler { id: rowWhereHover }

        // The same multi-line story the chips tell, on the surface where the
        // text is elided in the first place. Shown when it says MORE than the
        // row already does — either because the placement was cut short, or
        // because there are lines (the class, the drift arrow, the diagnosis)
        // the row has no room for at all. A tooltip that only repeats what is
        // already on screen teaches the user to stop hovering.
        //
        // rowTooltipText always leads with the app's name and the placement,
        // both of which the row shows on its own — an indexOf("\n") check is
        // therefore true unconditionally and cannot tell "more" from "the same".
        // Check the actual extra content instead: the class (never on the row),
        // the drift arrow (only implied by rowWhere's "→", not spelled out), or
        // a diagnosis this app has.
        PanelToolTip {
          visible: rowWhereHover.hovered && appRow.tipText !== ""
            && (rowWhere.truncated
              || appRow.modelData.className !== ""
              || (appRow.modelData.drifted && appRow.modelData.driftTo !== "")
              || appRow.modelData.mismatch !== "")
          text: appRow.tipText
          fontFamily: panel.fontFamily
        }
      }

      // "learn launch" is its own click, and it sits OUTSIDE the Toggle now — so
      // it no longer has to be declared after a row-wide MouseArea to win
      // against it. Pressing it must not also untick the app, and with the
      // toggle's click confined to the toggle that is structural rather than an
      // ordering trick.
      MouseArea {
        anchors.fill: rowLaunch
        enabled: appRow.modelData.launchRepairable === true
        visible: enabled
        cursorShape: Qt.PointingHandCursor
        onClicked: panel.learnLaunchFor(appRow.modelData.identityId)
      }
    }
  }
}
