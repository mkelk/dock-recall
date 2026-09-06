// map-chrome.test.js — the map draws ONE line weight, and everything else is a
// ground or nothing (tick ep6).
//
// WHY A SOURCE SCAN. Node cannot instantiate QML and this machine cannot look
// at the panel, so every claim here is a claim about the TREE: which element
// draws a border, which colour a ground is, what order two siblings are
// declared in. That is the same tactic tests/qml-plaintext.test.js uses for
// `textFormat` and tests/panel.test.js uses for the capture's layer order —
// there is no second copy of the logic to unit-test, only the question of who
// draws what.
//
// WHAT IT IS DEFENDING. Before this tick five nested border lines ran from the
// card to a window's picture — card (2 px) → mapSurface (1) → monitorRect (1)
// → workspaceSlot (1) → chipSlot (1), with a dashed sixth on a ghost — and the
// map surface was filled as well. No hierarchy for the eye; the thumbnails, the
// one thing that works, fought the chrome around them. After it the ONLY outline
// between the card and a picture is the chip's 1-px edge. Every assertion below
// is one clause of that sentence, and each one is the sort of thing that comes
// back silently: a `Border.controlSpec` re-added to a surface is one word, and
// nothing in node or `qmllint` would say a thing.
//
// AND TWO OF THEM ARE NOT COSMETIC AT ALL:
//
//   - `Border.withWidth` on the chip. `Commons/Style.qml` defaults
//     `selected-border-width` to 0, so a `controlSpec("selected", …)` edge is a
//     ZERO-WIDTH border on the default theme. The drifted chip — the one thing
//     the user is meant to act on — drew no edge at all, and the drift breathe
//     animated the alpha of nothing. A width the theme cannot zero is the fix,
//     and this is the guard that the state is never asked for the width again.
//
//   - `monitorRow` and the chain under it. `morphOverlay.height` binds to
//     `monitorRow.height`, and the workspace-canvas report path mirrors only
//     `workspaceSlot.x/y` — so a monitor box added or removed CONDITIONALLY
//     moves every workspace under it with no handler firing anywhere, and every
//     morph flight lands on a stale origin, silently. The redesign takes the box
//     away by changing what it DRAWS; this is what stops the next author taking
//     it away by changing whether it exists.
//
// Motion is pinned by tests/qml-plaintext.test.js (no `duration:` literal, no
// `Easing.`, no Behavior on a readonly) and is deliberately not restated here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const MAP = fs.readFileSync(path.join(REPO_ROOT, "MapWorkspace.qml"), "utf8");
const PANEL = fs.readFileSync(path.join(REPO_ROOT, "Panel.qml"), "utf8");

// ---------------------------------------------------------------------------
// The scanner. A QML binding is not a line — it wraps, and every binding this
// file cares about does — so the unit is "the opening line plus every line
// indented further than it". Anything at the opener's indent or less is the
// next binding, and that is where this one ended.
//
// Deliberately dumb about everything else: it does not parse QML, it quotes
// what it read, and every assertion below puts that quote in its own failure
// message. A source scan that fails without showing the text it scanned sends
// the reader back to the file to guess what it saw.
// ---------------------------------------------------------------------------

function bindingsOf(source, name) {
  const lines = source.split("\n");
  // `<name>:`, and the form a DECLARATION takes — `readonly property int
  // edgeWidth:`. Both are bindings and this file asks about each kind; matching
  // only the first read `side` and `edgeWidth` as absent, which is a test that
  // fails for the wrong reason on a file that is perfectly correct.
  const opener = new RegExp(
    "^(\\s*)(?:readonly\\s+)?(?:property\\s+[A-Za-z_][\\w.<>]*\\s+)?"
    + name.replace(/\./g, "\\.") + "\\s*:");
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const m = opener.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") break;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      body.push(lines[j]);
    }
    found.push({ line: i + 1, text: body.join("\n") });
  }

  return found;
}

// The binding of `name` on the element with `id: <id>`, and on THAT element:
// at the id's own indent, after it, and before the next id at the same indent
// or less (a sibling, or an ancestor's next child).
//
// THE BOUND IS THE WHOLE POINT, and neither half of it was in the first draft.
// Delete `visible:` from `monitorName` and an unbounded search walks straight on
// into `monitorSize` — whose `visible:` says exactly what the assertion was
// looking for — so the guard passed over a file with the defect in it, twice
// over: once because it left the element, and once because a match at any
// indent is a match on a CHILD. A source scan that finds SOMETHING is the
// vacuity this repository has already paid for (tests/qml-plaintext.test.js,
// tick md1), and it is measured here rather than argued: the mutations that
// were run against this file are in the tick's report.
function bindingAfterId(label, source, id, name) {
  const lines = source.split("\n");
  const idLine = new RegExp("^(\\s*)id: " + id + "\\s*$");
  const idAt = lines.findIndex((line) => idLine.test(line));
  assert.ok(idAt !== -1, `${label}: there is no element with \`id: ${id}\` any more`);
  const indent = idLine.exec(lines[idAt])[1].length;

  // `<name>:`, and the form a DECLARATION takes — `readonly property int
  // edgeWidth:`. Both are bindings and this file asks about each kind.
  const opener = new RegExp(
    "^\\s{" + indent + "}(?:readonly\\s+)?(?:property\\s+[A-Za-z_][\\w.<>]*\\s+)?"
    + name.replace(/\./g, "\\.") + "\\s*:");

  for (let i = idAt + 1; i < lines.length; i++) {
    const sibling = /^(\s*)id: \w+\s*$/.exec(lines[i]);
    if (sibling && sibling[1].length <= indent) break;
    if (!opener.test(lines[i])) continue;
    // A QML binding is not a line — it wraps, and most of the ones this file
    // asks about do. Everything indented further than the opener is still it.
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") break;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      body.push(lines[j]);
    }
    return body.join("\n");
  }

  return assert.fail(
    `${label}: \`${id}\` declares no \`${name}:\` binding of its own. What it`
    + ` does declare is:\n${lines.slice(idAt, idAt + 30).join("\n")}`);
}

// ---------------------------------------------------------------------------
// One line weight: everything from the card down to the chip is a ground or
// nothing
// ---------------------------------------------------------------------------

test("the map surface is a spacer: no line, no fill — the card is the frame", () => {
  const border = bindingAfterId("Panel.qml", PANEL, "mapSurface", "borderSpec");
  assert.match(border, /Border\.none\(\)/,
    "the map surface draws an outline inside the card's own again:\n" + border);

  const color = bindingAfterId("Panel.qml", PANEL, "mapSurface", "color");
  assert.match(color, /"transparent"/,
    "the map surface is filled again, so the faint ground is drawn twice — once"
    + " here and once on every workspace tile:\n" + color);

  // The padding is the one thing it keeps: it is the gap between the map and
  // the toggle row above it, and dropping it with the border would close that.
  const padding = bindingAfterId("Panel.qml", PANEL, "mapSurface", "padding");
  assert.match(padding, /Style\.space\(\d+\)/,
    "the map surface gave up its padding as well as its border, so the map now"
    + " touches what is above and below it:\n" + padding);
});

test("the monitor box draws nothing, on every monitor count", () => {
  const border = bindingAfterId("Panel.qml", PANEL, "monitorRect", "borderSpec");
  assert.match(border, /Border\.none\(\)/,
    "the monitor section draws a box again — the third of the five nested"
    + " rectangles this tick removed:\n" + border);
  // Unconditional: not `monitors.length > 1 ? … : Border.none()`. A box on some
  // desks and not others is a second thing for the eye to learn.
  assert.doesNotMatch(border, /\?/,
    "the monitor box is back on SOME desks — it draws nothing on every monitor"
    + " count, and the LABELS are what appear when there is more than one:\n" + border);

  const color = bindingAfterId("Panel.qml", PANEL, "monitorRect", "color");
  assert.match(color, /"transparent"/,
    "the monitor section is filled:\n" + color);

  const padding = bindingAfterId("Panel.qml", PANEL, "monitorRect", "padding");
  assert.match(padding, /padding:\s*0\s*$/,
    "the monitor section still holds a border's width off content that has no"
    + " border:\n" + padding);
});

test("the workspace is a TILE: a ground, and no outline of its own", () => {
  const border = bindingAfterId("MapWorkspace.qml", MAP, "workspaceSlot", "borderSpec");
  assert.match(border, /Border\.none\(\)/,
    "the workspace box draws its outline again — the fourth nested rectangle,"
    + " and the one the thumbnails sit directly inside:\n" + border);

  // The ground the map surface gave up, landing where it separates one
  // workspace from the next instead of the map from the card.
  const color = bindingAfterId("MapWorkspace.qml", MAP, "workspaceSlot", "color");
  assert.match(color, /Style\.normalFillFor\(panel\.foreground,\s*Color\.accent\)/,
    "the workspace tile lost the faint ground that replaced its border, so a"
    + " workspace with no windows in it is now invisible:\n" + color);

  // The chips still sit inside the tile rather than on its edge.
  const padding = bindingAfterId("MapWorkspace.qml", MAP, "workspaceSlot", "padding");
  assert.match(padding, /Style\.space\(4\)/, padding);
});

// ---------------------------------------------------------------------------
// The chip's edge — the one line the map still spends
// ---------------------------------------------------------------------------

test("every drawn chip state carries a real edge, whatever the theme says a state's width is", () => {
  const border = bindingAfterId("MapWorkspace.qml", MAP, "chipSlot", "borderSpec");

  assert.match(border, /Border\.withWidth\(/,
    "the chip's border takes its WIDTH from the control state again."
    + " Commons/Style.qml defaults selected-border-width to 0, so a drifted chip"
    + " draws no edge at all on the default theme and the breathe animates"
    + " nothing:\n" + border);
  assert.match(border, /Border\.controlSpec\(/,
    "the chip's border no longer takes its COLOUR from the control state, so"
    + " drift, hover and watched are one tone:\n" + border);

  // The ghost is the one state that draws no solid edge — its dashed Shape IS
  // the ghost — and that clause has to survive the rewrite.
  assert.match(border, /chipSlot\.anyGhost[\s\S]*Border\.none\(\)/,
    "a ghost chip draws a solid edge as well as its dash:\n" + border);

  const width = bindingAfterId("MapWorkspace.qml", MAP, "chipSlot", "edgeWidth");
  assert.match(width, /Math\.max\(1,\s*Style\.normalBorderWidth\)/,
    "the chip's edge width is no longer floored at 1, so a theme that zeroes its"
    + " border widths takes the map's only line away:\n" + width);
  assert.match(border, /chipSlot\.edgeWidth/,
    "the border does not use the floored width the mask holds back for it, so"
    + " the edge and the picture can disagree about how wide the edge is:\n" + border);
});

test("no borderSpec anywhere asks the SELECTED state for its width", () => {
  // The general form of the defect above, and the reason it is stated over both
  // files rather than over the chip alone: `selected-border-width` is the one
  // control width Omarchy's own Style defaults to 0, so `controlSpec("selected",
  // …)` is the spelling that draws NOTHING and looks like it draws the kit's
  // strongest edge. The other states default to 1 and are left alone — a rule
  // that forbade `controlSpec` outright would be a rule about a helper rather
  // than about the defect.
  const offenders = [];
  for (const file of [["MapWorkspace.qml", MAP], ["Panel.qml", PANEL]]) {
    for (const binding of bindingsOf(file[1], "borderSpec")) {
      if (binding.text.indexOf('"selected"') === -1) continue;
      if (binding.text.indexOf("Border.withWidth(") !== -1) continue;
      offenders.push(file[0] + ":" + binding.line + "\n" + binding.text);
    }
  }
  assert.deepStrictEqual(offenders, [],
    "these borderSpecs take their width from the SELECTED control state, which"
    + " Commons/Style.qml defaults to 0 — so they draw no line at all on the"
    + " default theme, and anything animating that line animates nothing:\n"
    + offenders.join("\n\n"));
});

// ---------------------------------------------------------------------------
// No double frame: the picture is cut to the chip
// ---------------------------------------------------------------------------

test("the chip's picture is masked to the slot's rounded rectangle", () => {
  // The shell's own idiom — plugins/image-picker/ImagePicker.qml and
  // plugins/background/Background.qml both render into a layer and mask it with
  // a MultiEffect. Qt has no rounded clip, so this is the only way to do it and
  // the import is half of it.
  assert.match(MAP, /^import QtQuick\.Effects$/m,
    "MapWorkspace.qml no longer imports the module the mask comes from, so the"
    + " picture is back to square corners inside a rounded chip");

  const layer = bindingAfterId("MapWorkspace.qml", MAP, "chipCapture", "layer.effect");
  assert.match(layer, /MultiEffect/,
    "the picture's layer no longer carries an effect:\n" + layer);
  assert.match(layer, /maskEnabled:\s*true/, layer);
  assert.match(layer, /maskSource:\s*chipPictureMask/,
    "the picture's mask no longer points at the shape that rounds it:\n" + layer);

  // ONLY WHERE IT CHANGES THE PICTURE. Style.cornerRadius mirrors Hyprland's
  // decoration:rounding and defaults to 0, so on a square theme this mask is a
  // rectangle masking a rectangle — an offscreen texture and a shader pass per
  // chip for no pixel's difference. Both halves of the idiom carry the same
  // condition, or one of them allocates for a mask nobody samples.
  for (const id of ["chipCapture", "chipPictureMask"]) {
    const enabled = bindingAfterId("MapWorkspace.qml", MAP, id, "layer.enabled");
    assert.match(enabled, /chipSlot\.radius > 0/,
      `${id} renders into a layer unconditionally, so a square theme — which is`
      + " Style.cornerRadius's own default — pays for a mask that cannot change"
      + " one pixel:\n" + enabled);
  }

  // And the mask itself is never drawn, only sampled.
  const maskAt = MAP.indexOf("id: chipPictureMask\n");
  assert.ok(maskAt !== -1, "the mask shape is gone");
  const mask = MAP.slice(maskAt, MAP.indexOf("// THE VEIL"));
  assert.match(mask, /visible:\s*false/,
    "the mask shape is drawn as well as sampled:\n" + mask);
  // Its bounds are the PICTURE's, because a MultiEffect maps its mask onto the
  // LAYERED item — and the picture is inset from the tab by the edge's width.
  assert.match(mask, /anchors\.fill:\s*chipCapture/,
    "the mask no longer covers exactly what it masks, so the rounding lands"
    + " somewhere other than the picture's own corners:\n" + mask);

  // THE EDGE READS ON TOP OF THE PICTURE, and this is the half that applies on
  // EVERY theme, masked or not. QML paints an item's children over the Rectangle
  // that draws them, border included — the first VM look showed a watched
  // chip's picture covering the slot's border completely, so an in-sync chip
  // drew no edge at all. Holding the picture back by the edge's width is what
  // puts it back, and it costs the payload nothing: the tab's own width and
  // height, which the treatment ladder and the report both read, do not move.
  const margins = bindingAfterId("MapWorkspace.qml", MAP, "chipCapture", "anchors.margins");
  assert.match(margins, /chipSlot\.edgeWidth/,
    "the picture is not held back by the edge's width any more, so a chip with a"
    + " thumbnail paints over the one line the map has left:\n" + margins);

  // The mask's rectangle is the SLOT's, not the tab's: a fused tab group is one
  // pill, and rounding each tab would round the joins in the middle of it.
  const x = bindingAfterId("MapWorkspace.qml", MAP, "chipPictureShape", "x");
  assert.match(x, /-\s*chipTab\.x/,
    "the mask is the tab's own rectangle, so a fused tab group is rounded at"
    + " every internal join:\n" + x);
  for (const side of ["width", "height"]) {
    const geometry = bindingAfterId("MapWorkspace.qml", MAP, "chipPictureShape", side);
    assert.match(geometry, /chipRow\.\w+ - chipSlot\.edgeWidth \* 2/,
      `the mask's ${side} is no longer the pill's rectangle minus the ring the`
      + " picture is held back by, so the rounding is a different size from the"
      + " thing it rounds:\n" + geometry);
  }

  const radius = bindingAfterId("MapWorkspace.qml", MAP, "chipPictureShape", "radius");
  assert.match(radius, /chipSlot\.radius - chipSlot\.edgeWidth/,
    "the mask no longer follows the INSIDE of the chip's corner:\n" + radius);
});

// ---------------------------------------------------------------------------
// No box reads as empty: the icon scales with the chip
// ---------------------------------------------------------------------------

test("the chip icon scales with the chip instead of stamping 18 px on it", () => {
  const side = bindingAfterId("MapWorkspace.qml", MAP, "chipIcon", "side");

  assert.match(side, /Math\.min\(chipTab\.width,\s*chipTab\.height\)\s*\*\s*0\.5/,
    "the icon is no longer half the chip's shorter side:\n" + side);
  assert.match(side, /Math\.max\(8,/,
    "the icon lost its 8 px floor, below which it is noise rather than an"
    + " icon:\n" + side);
  assert.match(side, /Math\.min\(Style\.space\(56\),/,
    "the icon's cap is not Style.space(56):\n" + side);
  assert.doesNotMatch(side, /iconLarge/,
    "the icon is capped at the kit's large icon again — 18 px in a"
    + " workspace-sized chip, which is the tiny icon in a big box this tick"
    + " removed:\n" + side);

  // Decoded at the DRAWN size in physical pixels. Now that the icon can be 56 px
  // this matters more, not less: an upscaled PNG is the one thing an icon may
  // not be.
  const decode = bindingAfterId("MapWorkspace.qml", MAP, "chipIcon", "sourceSize.width");
  assert.match(decode, /width\s*\*\s*Screen\.devicePixelRatio/,
    "the icon is no longer decoded at physical pixels:\n" + decode);
});

test("the chip in flight wears what the chip wears", () => {
  // A flight that changes shape in mid-air is the one thing the eye is
  // guaranteed to catch, because motion is what it was already following.
  const width = bindingAfterId("Panel.qml", PANEL, "flyingChip", "border.width");
  assert.match(width, /Math\.max\(1,\s*Style\.normalBorderWidth\)/,
    "the flying chip's edge no longer matches the chip's own:\n" + width);

  const radius = bindingAfterId("Panel.qml", PANEL, "flyingChip", "radius");
  assert.match(radius, /Style\.cornerRadius/, radius);

  const side = bindingAfterId("Panel.qml", PANEL, "flyingIcon", "side");
  assert.match(side, /Math\.min\(flyingChip\.width,\s*flyingChip\.height\)\s*\*\s*0\.5/,
    "the flying chip's icon no longer follows the chip's own rule, so a chip"
    + " changes size the moment it starts moving:\n" + side);
  assert.match(side, /Style\.space\(56\)/, side);
});

// ---------------------------------------------------------------------------
// The badge is on the tile
// ---------------------------------------------------------------------------

test("the number badge overlays the tile's corner rather than owning a row above it", () => {
  const badgeAt = MAP.indexOf("id: workspaceLabel\n");
  const canvasAt = MAP.indexOf("id: workspaceCanvas\n");
  assert.ok(badgeAt !== -1 && canvasAt !== -1, "the badge or the canvas is gone");

  // QML paints siblings in document order, so being declared after the canvas
  // IS the z-order. The explicit `z` says the same thing where a reader looks
  // for it; either alone would be enough and both are cheap.
  assert.ok(badgeAt > canvasAt,
    "the badge is declared before the canvas, so the chips are painted over it"
    + " and a busy workspace hides its own number");
  const badge = MAP.slice(badgeAt, badgeAt + 400);
  assert.match(badge, /^\s*z: \d+$/m,
    "the badge carries no z, so its layering depends on document order alone:\n" + badge);

  // It is inset into the corner, not laid out above the canvas.
  assert.match(badge, /anchors\.topMargin:\s*Style\.space\(3\)/, badge);
  assert.match(badge, /anchors\.leftMargin:\s*Style\.space\(3\)/, badge);

  // Its quiet ground is the pill's, because it sits on photographs now: the
  // faint foreground at 0.22 was a tint on a bare box.
  const color = bindingAfterId("MapWorkspace.qml", MAP, "workspaceLabel", "color");
  assert.match(color, /Util\.alpha\(Color\.popups\.background,\s*0\.72\)/,
    "the badge's unfocused ground is not the pill's, so it is nearly invisible"
    + " over a thumbnail:\n" + color);
  assert.match(color, /Color\.accent/,
    "the focused badge is no longer accent-filled:\n" + color);
});

test("the canvas fills the tile on the positioned path, and steps below the badge on the fallback", () => {
  // BOTH RENDER PATHS, and here they genuinely want different answers
  // (.tick/learnings.md). On the positioned path a chip is a window's picture
  // and a number lying on one is the whole Exposé idea, so the canvas has the
  // tile and `badgeInset` is 0. On the fallback a "chip" is a canvas-wide 17 px
  // row carrying the app's NAME, and a 14 px badge lying on it covered the left
  // end of every tile's first row — which the first VM look found in both
  // tiles of the Recorded map.
  const inset = bindingAfterId("MapWorkspace.qml", MAP, "workspaceSlot", "badgeInset");
  assert.match(inset, /workspaceSlot\.positioned/,
    "the badge's room is no longer asked per render path, so one of the two"
    + " paths is wrong — the overlay on a row of names, or a gap above the"
    + " pictures:\n" + inset);
  assert.match(inset, /\?\s*0/,
    "the positioned path reserves a row for the badge again, so a picture no"
    + " longer runs to the top of its tile:\n" + inset);
  assert.match(inset, /workspaceLabel\.implicitHeight/,
    "the fallback's room for the badge is not the badge's own height, so it is a"
    + " number that can drift from the thing it is making room for:\n" + inset);

  // And both users of it: the box's height and the canvas's origin. Either one
  // alone is a tile whose contents do not fit it.
  const height = bindingAfterId("MapWorkspace.qml", MAP, "workspaceSlot", "height");
  assert.match(height, /workspaceSlot\.canvasHeight/, height);
  assert.match(height, /workspaceSlot\.badgeInset/,
    "the tile's height does not include the badge's room, so the fallback's last"
    + " stacked row is pushed out of the bottom of its own tile:\n" + height);
  assert.doesNotMatch(height, /workspaceLabel/,
    "the workspace box reserves the badge's height directly again, which is the"
    + " caption-stacked-on-a-picture this tick removed from the positioned"
    + " path:\n" + height);

  const y = bindingAfterId("MapWorkspace.qml", MAP, "workspaceCanvas", "y");
  assert.match(y, /^\s*y:\s*workspaceSlot\.contentTopInset \+ workspaceSlot\.badgeInset\s*$/,
    "the canvas does not start at the top of the tile plus the badge's room:\n" + y);
});

// ---------------------------------------------------------------------------
// The monitor labels, and the chain that must not become conditional
// ---------------------------------------------------------------------------

test("the monitor name and its mode appear only when there is more than one screen", () => {
  for (const id of ["monitorLabelRow", "monitorName", "monitorSize"]) {
    const visible = bindingAfterId("Panel.qml", PANEL, id, "visible");
    assert.match(visible, /root\.mapModel\.monitors\.length > 1/,
      `${id} is drawn on a single-monitor desk, where it is a caption over the`
      + " only thing on screen:\n" + visible);
  }

  // The WRAPPER carries it too, and that is the load-bearing half: a Column
  // skips an invisible item entirely, but an Item that is merely holding two
  // invisible Texts still reserves their height and the Column's spacing.
  const row = bindingAfterId("Panel.qml", PANEL, "monitorLabelRow", "visible");
  assert.match(row, /visible:\s*root\.mapModel\.monitors\.length > 1/, row);
});

test("the monitor chain is unconditional, and the morph still measures it", () => {
  // THE SILENT HAZARD. The workspace-canvas report path mirrors only
  // workspaceSlot.x/y, so a parent added or removed conditionally moves every
  // box under it with NO handler firing — and every morph flight then lands on
  // a stale origin, with nothing in the log and nothing on the payload. The
  // redesign takes the monitor box away by changing what it draws; these three
  // ids are what says it did not take it away by changing whether it exists.
  for (const id of ["monitorRow", "monitorRect", "monitorColumn", "workspaceFlow"]) {
    assert.ok(PANEL.indexOf("id: " + id + "\n") !== -1,
      "the map's monitor chain lost `" + id + "`. Every element in that chain is"
      + " unconditional on purpose: a conditional parent moves the boxes under it"
      + " without any handler firing, and every morph flight lands on a stale"
      + " origin, silently.");
  }

  const height = bindingAfterId("Panel.qml", PANEL, "morphOverlay", "height");
  assert.match(height, /^\s*height:\s*monitorRow\.height\s*$/,
    "the morph overlay no longer measures the monitor Row, so a flight is"
    + " clipped to the wrong box — or mapCanvas's childrenRect height becomes a"
    + " binding loop:\n" + height);

  // And nothing in the monitor Repeater's delegate is gated on the monitor
  // count except what it DRAWS.
  const delegate = PANEL.slice(PANEL.indexOf("delegate: BorderSurface {\n                      id: monitorRect"),
    PANEL.indexOf("id: workspaceFlow"));
  assert.ok(delegate.length > 0, "the monitor delegate could not be read");
  assert.doesNotMatch(delegate, /^\s*(active|sourceComponent|Loader)\b/m,
    "the monitor section is built through a Loader now, which is exactly the"
    + " conditional parent this chain must not have:\n" + delegate);
});

// ---------------------------------------------------------------------------
// The chip floor is still one number
// ---------------------------------------------------------------------------

test("the chip floor is still stated once, in the panel", () => {
  // Two callers of chipRectsForCanvas — the map when it draws, and the flight
  // resolver when it works out where the map drew — have to be handed the same
  // two numbers or the flight lands beside the chip instead of on it.
  for (const name of ["chipFloorWidth", "chipFloorHeight"]) {
    const declarations = (PANEL.match(
      new RegExp("readonly property int " + name + "\\s*:", "g")) || []);
    assert.strictEqual(declarations.length, 1,
      "Panel.qml declares " + name + " " + declarations.length + " time(s) — it is"
      + " the ONE site both the map and the morph's flight resolver read");

    assert.strictEqual(MAP.indexOf("property int " + name), -1,
      "MapWorkspace.qml declares its own " + name + ", so the map and the flight"
      + " resolver can floor a chip differently and the flight lands beside it");
    assert.ok(MAP.indexOf("panel." + name) !== -1,
      "MapWorkspace.qml no longer reads panel." + name);
  }
});
