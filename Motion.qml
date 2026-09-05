// Motion.qml — how long anything in this plugin takes, stated once.
//
// WHY THIS FILE EXISTS AT ALL. Omarchy's theme has colours, spacing and radii
// as tokens; it has NO animation tokens. So a plugin that animates either
// invents its own numbers or copies the shell's, and either way the number ends
// up spelled in every file that moves. This project has already paid for a value
// living in two places four times in two increments — the test count drifted
// three times, and the payload contract's rationale was written out in four
// files — and the fix each time was to nominate ONE normative site. A duration
// spelled in six QML files is the same defect with a longer fuse, so it gets its
// single site before the first animation is written rather than after the third
// one disagrees.
//
// WHERE THE NUMBERS COME FROM, and they are copied deliberately rather than
// invented: Omarchy's own `Ui/ToggleSwitch.qml` moves its knob with
// `duration: 120; easing.type: Easing.OutCubic` and fades its colours with a
// bare `duration: 120`. That is the shell's answer for "a control changed
// state", which is what most of this plugin's motion is.
//
// ONE HONEST WRINKLE, FLAGGED RATHER THAN SMOOTHED OVER. 120 is what
// ToggleSwitch uses, but it is not the most common number in the shell: across
// `Ui/`, `duration: 140; easing.type: Easing.OutCubic` appears six times against
// three for 120 — and this plugin's own BarWidget fade was already written at
// 140. So "the house convention" is really two neighbouring values, and the
// increment's spec named the ToggleSwitch one. That is the one used here. The
// difference is 20ms and no assertion can tell anyone which is right; whether
// the motion FEELS right is the human's gate for this epic (tick 0c7), and this
// is on the list to look at when they answer it.
//
// A COLOUR FADE DECLARES NO EASING. ToggleSwitch does not give its
// ColorAnimation an easing curve, so neither do we — Qt's linear default is the
// shell's answer for a colour, and OutCubic is its answer for something that
// MOVES. Two shapes, one duration.

import QtQuick

QtObject {
  // A control changed state: a toggle, a fill, an edge, an opacity.
  readonly property int duration: 120

  // For anything that travels. Colours deliberately do not use it — see above.
  readonly property int easingType: Easing.OutCubic

  // The bar widget's restore sweep, which is a different KIND of thing: a long
  // looping hint that something is happening, not a transition between two
  // states. It keeps its own number because sharing one with the toggles would
  // be a coincidence dressed as a rule.
  readonly property int sweepDuration: 1400
}
