// ConsentPrompt.qml — the first-Record dialogue: the pictures just taken, and
// the three answers.
//
// WHAT IT IS. An ONBOARDING MOMENT that demonstrates the feature, not a warning
// label. The user has already granted the per-app consent (the camera on the
// app row), a Record has just happened, and the pictures exist — so this shows
// them THE PICTURES IT JUST TOOK, of their own windows, and asks what they
// think. A sentence about photographs of your windows is a scary abstraction;
// three photographs of your own windows is a thing you can look at and have an
// opinion about. That is why this draws a thumbnail strip rather than describing
// one, and it is the reason the component exists at all.
//
// It is asked ONCE. The answer is StateModel.pictureConsent (schema v6), so it
// survives a shell restart; "unasked" is the only value that brings it back.
//
// -------------------------------------------------- why this is not first-party
//
// Three shell components were the obvious candidates and none of them fits, and
// this is a MEASUREMENT of the installed shell rather than a preference:
//
//   Ui/ConfirmDialog.qml — strictly TWO buttons (cancel/confirm, selectedIndex
//                          0 | 1) and no slot for content above them. Three
//                          answers do not fit a two-valued index, and there is
//                          nowhere to put the thumbnails.
//   Ui/PopupCard.qml     — a card with no buttons and no keyboard routing at
//                          all. Everything this prompt does is buttons and
//                          keyboard.
//   Ui/Dropdown.qml      — single-select over a list; a menu, not a question,
//                          and again no content slot.
//
// And `/usr/share/omarchy/shell` IS THE INSTALLED OMARCHY. It is not ours to
// edit: a plugin that requires a patched shell is not a plugin anybody can
// install. So this is built from the primitives that ARE ours to use —
// BorderSurface, Button, Image, Text — dressed in the same tokens the panel's
// own surfaces use, which is exactly what the overflow menu already does with a
// QtQuick.Controls Popup (see Panel.qml, "the header overflow menu").
//
// ---------------------------------------------------------------- the keyboard
//
// IT OWNS THE ARROWS AND TAB WHILE IT IS UP, and it gives them back on the way
// out. None of that machinery is here: this component draws, reports and
// reports a press. The panel owns `consentOpen`, the stashed focus section, the
// guards at the top of handleMove/moveSection/activateCursor and the Escape
// chain — for the same reason the overflow menu's cursor lives there. A surface
// that owned its own keyboard state would be a second answer to "where is the
// cursor", and this panel has exactly one.
//
// THE INTERFACE IS ONE PROPERTY, as it is for MapWorkspace.qml and for the same
// measured reason: the subtree reads the panel's four colours, its font, the
// choice list, the strip, the cursor, two report sinks, two act functions and
// the tooltip width. `grep -o 'panel\.[a-zA-Z]*' ConsentPrompt.qml | sort -u` is
// the complete list of what it needs.

import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "PanelModel.js" as PanelModel

Item {
  id: prompt

  // THE PANEL — the whole interface. See the note above for why it is one
  // property and not a dozen.
  required property var panel

  // The strip: one entry per picture the round actually stored, as
  // { identityId, occurrence, name, source }. Built by the panel from the
  // capture round's own results (PanelModel.consentCaptureEntries), so the
  // thumbnails are the files on disk and not a second guess at what should be
  // there.
  readonly property var entries: prompt.panel.consentEntries

  // The three answers, from PanelModel.consentChoices. Shaped like the overflow
  // menu's actions so the same cursor helpers drive both.
  readonly property var choices: prompt.panel.consentChoiceModel

  // A DISMISSAL SCRIM OVER THE WHOLE CARD, and it is not decoration: this
  // prompt takes the panel's keyboard, so the surface behind it is inert and
  // has to LOOK inert. The MouseArea under it also swallows every click that
  // would otherwise reach a chip or a row behind the prompt — a click that
  // toggled a watch through a dialogue asking about photographs would be the
  // panel acting on a press the user aimed at something else.
  //
  // Clicking it DISMISSES rather than answering. Escape does the same thing,
  // and neither is an answer: the question is still owed, and the next Record
  // that stores a picture asks it again. "Asked once" means asked once
  // ANSWERED — a prompt the user swiped away has not been answered, and
  // recording an answer they did not give is the one thing a consent dialogue
  // may never do.
  Rectangle {
    anchors.fill: parent
    color: Color.menu.scrim

    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.AllButtons
      onClicked: prompt.panel.dismissConsent()
    }
  }

  BorderSurface {
    id: promptCard
    anchors.centerIn: parent
    width: Math.min(Style.space(520), prompt.width - Style.space(24))
    height: Math.min(promptColumn.implicitHeight + promptCard.contentTopInset
      + promptCard.contentBottomInset, prompt.height - Style.space(16))
    color: Color.popups.background
    borderSpec: Border.surfaceSpec("popups", "border", Color.accent,
      Math.max(1, Style.space(2)))
    radius: Style.cornerRadius
    padding: Style.spacing.popupPadding

    // Swallow clicks on the card so they never reach the scrim behind it and
    // dismiss the question the user is reading. Declared before the content, so
    // the content still gets them first — the same order Panel.qml's own card
    // uses.
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.AllButtons
    }

    Column {
      id: promptColumn
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.topMargin: promptCard.contentTopInset
      anchors.leftMargin: promptCard.contentLeftInset
      anchors.rightMargin: promptCard.contentRightInset
      spacing: Style.space(10)

      Text {
        textFormat: Text.PlainText
        width: promptColumn.width
        text: PanelModel.consentTitle(prompt.entries.length)
        color: prompt.panel.foreground
        font.family: prompt.panel.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
        wrapMode: Text.WordWrap
      }

      // THE STRIP. A Flow rather than a Row: the number of pictures is the
      // number of apps whose camera is on, which has no upper bound, and a Row
      // would run off the card at four.
      Flow {
        id: strip
        width: promptColumn.width
        spacing: Style.space(8)

        Repeater {
          model: prompt.entries

          delegate: Column {
            id: shot
            required property var modelData
            spacing: Style.space(3)

            readonly property string captureKey:
              String(shot.modelData.identityId) + "#" + String(shot.modelData.occurrence)

            // What this thumbnail DREW, read back over IPC — the same
            // discipline every chip and every row in this panel follows, and
            // for the same reason: "the prompt showed the captures just taken"
            // is a claim about Images that loaded, not about a model that could
            // have produced them. `ready` is Image.Ready and nothing looser: a
            // source that is still loading or has failed is a picture the user
            // is not looking at.
            function reportRender() {
              prompt.panel.reportConsentCapture(shot.captureKey, {
                identityId: String(shot.modelData.identityId),
                occurrence: shot.modelData.occurrence,
                name: String(shot.modelData.name),
                source: String(shot.modelData.source),
                ready: thumb.status === Image.Ready
              })
            }
            Component.onCompleted: shot.reportRender()

            BorderSurface {
              width: Style.space(148)
              height: Style.space(92)
              radius: Math.max(1, Style.space(3))
              clip: true
              color: Style.hoverFillFor(prompt.panel.foreground, prompt.panel.foreground)
              borderSpec: Border.controlSpec("normal", prompt.panel.foreground, Color.accent)

              Image {
                id: thumb
                anchors.fill: parent
                anchors.margins: Math.max(1, Style.space(1))
                source: shot.modelData.source
                // PreserveAspectCrop, like the map's chips: the picture is a
                // reminder of which window this is, and letterboxing it inside
                // a fixed box would spend the thumbnail's pixels on background.
                fillMode: Image.PreserveAspectCrop
                asynchronous: true
                cache: false
                smooth: true
                visible: thumb.status === Image.Ready
                onStatusChanged: shot.reportRender()
              }
            }

            Text {
              textFormat: Text.PlainText
              width: Style.space(148)
              // A WINDOW'S OWN NAME, which is a string an application chose for
              // itself — the exact reason tests/qml-plaintext.test.js scans this
              // file too.
              text: shot.modelData.name
              color: prompt.panel.dimForeground
              font.family: prompt.panel.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
              horizontalAlignment: Text.AlignHCenter
            }
          }
        }
      }

      Text {
        textFormat: Text.PlainText
        width: promptColumn.width
        text: PanelModel.consentBody()
        color: prompt.panel.dimForeground
        font.family: prompt.panel.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      PanelSeparator { foreground: prompt.panel.foreground }

      // THE THREE ANSWERS, in the order PanelModel.consentChoices draws them:
      // the affirming one first, then the two refusals by scope. Nothing is
      // preselected beyond "the cursor starts on the first", and there is no
      // dimmed option — a prompt with a disabled answer is a question whose
      // answer the asker has already decided.
      Flow {
        id: answerRow
        width: promptColumn.width
        spacing: Style.spacing.controlGap

        Repeater {
          model: prompt.choices

          delegate: Button {
            id: answerButton
            required property var modelData

            text: answerButton.modelData.label
            tooltipText: PanelModel.wrapTooltip(answerButton.modelData.tooltip,
              prompt.panel.footerTooltipColumns)
            bordered: true
            // The FIRST answer is the emphasized one, the way Record is
            // emphasized in the footer: it is the answer the moment is for.
            active: answerButton.modelData.id === "keep"
            hasCursor: prompt.panel.consentCursor === answerButton.modelData.id
            foreground: prompt.panel.foreground
            accent: Color.accent
            fontFamily: prompt.panel.fontFamily
            fontSize: Style.font.caption
            onClicked: prompt.panel.answerConsent(answerButton.modelData.id)

            // What this button DREW: its id and the words on it. Which is what
            // makes "it offers exactly Keep these / Delete these / Delete all"
            // a claim about buttons that exist rather than about a model that
            // could have produced them.
            Component.onCompleted: prompt.panel.reportConsentChoice(
              String(answerButton.modelData.id), { label: answerButton.text })
          }
        }
      }
    }
  }
}
