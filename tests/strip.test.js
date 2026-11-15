// strip.test.js — the app strip: how it packs, what it says on hover, and what
// its cells report.
//
// TWO KINDS OF ASSERTION, and the split is the same one the rest of this suite
// makes. `stripLayout` and `rowTooltipText` are pure functions with right answers,
// so they are called. Everything about the CELL — that it is a `ToggleSwitch`
// and not the 54-px `Ui/Toggle` it replaced, that the switch is at the right
// edge, that the report carries `hoverText` only while the cell is lit — can
// only be checked by reading the tree, because node cannot instantiate QML and
// `qmllint -I "$OMARCHY_PATH/shell" *.qml` is syntax-only here (measured once:
// it exits 0 on an unknown id and on a handler for a signal that does
// not exist). Same tactic as tests/qml-plaintext.test.js and
// tests/qml-interface.test.js: the scan IS the assertion, so every scanner
// below carries a vacuity guard that fails when it stops matching.
//
// WHAT IT IS PROTECTING. The strip replaced a list whose right edge moved every
// time an app was unticked, and the redesign's own
// checklist item 5 is that the right edge holds. That is an arithmetic claim
// about `stripLayout` and a structural claim about the cell, and both are here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const panel = require("../PanelModel.js");

const REPO_ROOT = path.join(__dirname, "..");
const APP_STRIP = fs.readFileSync(path.join(REPO_ROOT, "AppStrip.qml"), "utf8");
const PANEL_QML = fs.readFileSync(path.join(REPO_ROOT, "Panel.qml"), "utf8");

// The tokens the strip is built from, at the default theme scale — Style.space
// is the identity there, `Style.spacing.popupRowHeight` is 28 and
// `Style.font.caption` is 10. Spelled here only so the arithmetic below is
// about the numbers the panel actually passes.
const MIN_CELL = 140;
const GAP = 8;

// A line that is nothing but prose. Every source scan skips these: this
// repository comments heavily and its comments quote the very identifiers they
// discuss — AppStrip.qml's own header spells `Ui/Toggle` in a sentence about
// why it stopped using it.
function isComment(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function codeOf(source) {
  return source.split("\n").filter((line) => !isComment(line)).join("\n");
}

// The whole `{ … }` block the line matching `inside` belongs to: walk back to
// the nearest line that opens one, then count braces forward.
//
// BRACE-COUNTED, not regex-matched, because a QML binding routinely contains a
// brace of its own; and ANCHORED ON THE OPENER, because the interesting lines
// here are inside the block rather than on it — the learn-launch MouseArea is
// found by the sibling it anchors to, and a scanner that started counting from
// THAT line would return two lines that contain nothing and pass every
// assertion made about them. That is an earlier change's lesson in this file's own
// currency: an opener that matches the wrong thing is an assertion that ran
// over an empty string.
function blockAround(source, inside) {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => inside.test(line));
  assert.ok(at >= 0, "the scanner found no line matching " + inside);

  let start = at;
  while (start >= 0 && !/\{\s*$/.test(lines[start])) start -= 1;
  assert.ok(start >= 0, "no block opener above the line matching " + inside);

  let depth = 0;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    body.push(lines[i]);
    if (depth === 0) break;
  }
  assert.ok(depth === 0, "the block opened at line " + (start + 1) + " never closes");
  assert.ok(body.length > 2,
    "the scanner parsed a " + body.length + "-line block for " + inside
    + " — it has most likely anchored on the wrong line, which would make every"
    + " assertion about that block vacuous");
  return body.join("\n");
}

test("the block scanner finds a whole block, and says so when it cannot", () => {
  // The negative control. Every claim below is "this text is NOT in that block",
  // and a scanner that returned a stub would satisfy all of them at once.
  const probe = [
    "Item {",
    "  MouseArea {",
    "    anchors.fill: parent",
    "    onClicked: takeTheClick()",
    "  }",
    "  MouseArea {",
    "    anchors.fill: sibling",
    "    onClicked: doNotTakeIt()",
    "  }",
    "}"
  ].join("\n");
  const found = blockAround(probe, /anchors\.fill:\s*sibling/);
  assert.ok(found.indexOf("doNotTakeIt") !== -1, found);
  assert.ok(found.indexOf("takeTheClick") === -1,
    "the scanner walked back past its own block's opener:\n" + found);
  assert.throws(() => blockAround(probe, /notInThisProbeAtAll/));
});

// ---------------------------------------------------------------------------
// stripLayout — how many cells fit, and how wide each one is
// ---------------------------------------------------------------------------

test("stripLayout packs fixed-width cells across the width it is given", () => {
  // Two at the width the panel's card had before this increment; the cells
  // share out everything left after the one gap between them.
  assert.deepStrictEqual(panel.stripLayout(6, 400, MIN_CELL, GAP),
    { columns: 2, cellWidth: 196 });

  // More room, more columns — and the cells stay above the readable minimum.
  const wide = panel.stripLayout(6, 900, MIN_CELL, GAP);
  assert.ok(wide.columns > 2, "a 900 px strip fits more than a 400 px one: " + wide.columns);
  assert.ok(wide.cellWidth >= MIN_CELL,
    "a cell may be wider than the minimum but never narrower while there is room for it: "
    + wide.cellWidth);

  // Too narrow for even one readable cell: ONE cell at the whole width, which
  // is honest, where a cell drawn wider than the strip it sits in is not.
  assert.deepStrictEqual(panel.stripLayout(6, 100, MIN_CELL, GAP),
    { columns: 1, cellWidth: 100 });

  // Nothing to pack is no columns, the way workspaceGridLayout answers its own
  // empty case. The caller floors it at 1 before handing it to a positioner.
  assert.deepStrictEqual(panel.stripLayout(0, 628, MIN_CELL, GAP),
    { columns: 0, cellWidth: 0 });
});

test("a strip never asks for more width than it has, and never for no cell at all", () => {
  // Every width the card can plausibly take, at the two spacing scales a theme
  // is likely to land on. The invariant is the one a positioner cannot recover
  // from: the row of cells plus its gaps must fit.
  let checked = 0;
  for (const gap of [0, 4, 8, 16]) {
    for (const minCell of [80, 140, 220]) {
      for (let width = 1; width <= 1400; width += 7) {
        const packed = panel.stripLayout(9, width, minCell, gap);
        checked += 1;
        assert.ok(packed.columns >= 1,
          `columns fell to ${packed.columns} at width ${width}, minCell ${minCell}, gap ${gap}`);
        assert.ok(packed.cellWidth >= 0,
          `a negative cell at width ${width}, minCell ${minCell}, gap ${gap}`);
        const used = packed.columns * packed.cellWidth + (packed.columns - 1) * gap;
        assert.ok(used <= width,
          `${packed.columns} × ${packed.cellWidth} + gaps = ${used} > ${width}`
          + ` (minCell ${minCell}, gap ${gap})`);
      }
    }
  }
  assert.ok(checked > 2000, "the sweep ran: " + checked + " widths");
});

test("THE RIGHT EDGE HOLDS: how many apps there are cannot change the grid", () => {
  // Checklist item 5, as arithmetic. Unticking an app genuinely changes the
  // number of rows — a watched identity with two windows is two rows, and the
  // unwatched class it falls back to is one — so if the count narrowed the
  // grid, every tick would reflow the whole strip to a different cell width.
  // That is the defect an earlier change fixed on the old list's caption, and this is
  // the shape it would come back in.
  const one = panel.stripLayout(1, 628, MIN_CELL, GAP);
  for (const count of [2, 3, 4, 5, 9, 40]) {
    assert.deepStrictEqual(panel.stripLayout(count, 628, MIN_CELL, GAP), one,
      "the packing moved when the strip held " + count + " apps instead of one");
  }
  // And the sanity check that makes the equality above worth anything: the
  // WIDTH does move it.
  assert.notDeepStrictEqual(panel.stripLayout(4, 900, MIN_CELL, GAP), one);
});

test("stripLayout survives the widths a warming-up panel really hands it", () => {
  // A component's width is 0 until its parent has laid it out, and a binding
  // that threw there would take the whole strip down with it.
  assert.deepStrictEqual(panel.stripLayout(3, 0, MIN_CELL, GAP), { columns: 1, cellWidth: 0 });
  assert.deepStrictEqual(panel.stripLayout(3, -50, MIN_CELL, GAP), { columns: 1, cellWidth: 0 });
  assert.deepStrictEqual(panel.stripLayout(3, NaN, MIN_CELL, GAP), { columns: 1, cellWidth: 0 });
  assert.deepStrictEqual(panel.stripLayout(3, undefined, MIN_CELL, GAP), { columns: 1, cellWidth: 0 });
  // A theme that pinned every spacing token to 0 still gets a grid.
  const noGap = panel.stripLayout(3, 400, 0, 0);
  assert.ok(noGap.columns >= 1 && noGap.cellWidth >= 0, JSON.stringify(noGap));
});

// ---------------------------------------------------------------------------
// rowTooltipText — the details the cell no longer has room for
// ---------------------------------------------------------------------------

const DRIFTED_ROW = {
  key: "obsidian", identityId: "obsidian", className: "md.obsidian.Obsidian",
  linkKey: "id:obsidian", name: "Obsidian", position: "eDP-1 · ws 3",
  drifted: true, driftTo: "DP-2 · ws 7", mismatch: "", launchHint: "learn launch"
};

test("a cell's hover text is the row tooltip, and its last line is what Restore can do", () => {
  const lines = panel.rowTooltipText(DRIFTED_ROW).split("\n");
  assert.deepStrictEqual(lines, [
    "Obsidian",
    "md.obsidian.Obsidian",
    "eDP-1 · ws 3",
    "→ recorded on DP-2 · ws 7",
    "learn launch"
  ]);
  // LAST, and after the diagnosis: the drift arrow says what is wrong with
  // where the app is, and the hint says what can be done about starting it.
  assert.strictEqual(lines[lines.length - 1], "learn launch");

  // IFF present. A row with no hint says exactly what it said before an earlier change
  // folded the two functions together — not a longer string that happens to
  // render the same, because a trailing blank line is a popup with a hole in it.
  const noHint = Object.assign({}, DRIFTED_ROW, { launchHint: "" });
  assert.strictEqual(panel.rowTooltipText(noHint),
    "Obsidian\nmd.obsidian.Obsidian\neDP-1 · ws 3\n→ recorded on DP-2 · ws 7");
  assert.strictEqual(panel.rowTooltipText(noHint).indexOf("learn launch"), -1);
  assert.strictEqual(panel.rowTooltipText(noHint).slice(-1) === "\n", false);
  // A row that never had the key at all — an unwatched class row builds one
  // without a launchHint — behaves like the empty one, not like "undefined".
  const noKey = Object.assign({}, DRIFTED_ROW);
  delete noKey.launchHint;
  assert.strictEqual(panel.rowTooltipText(noKey), panel.rowTooltipText(noHint));

  // Nothing to say is the empty string, so the caller hides the tooltip rather
  // than popping an empty box — the same contract chipTooltipText has.
  assert.strictEqual(panel.rowTooltipText(null), "");
  assert.strictEqual(panel.rowTooltipText(undefined), "");
  // A hint and nothing else still has no hole at either end.
  const bare = panel.rowTooltipText({ name: "", position: "", launchHint: "no launch cmd" });
  assert.strictEqual(bare, "no launch cmd");
});

test("there is ONE row tooltip function, and the strip calls it", () => {
  // An earlier change shipped `rowHoverText` — rowTooltipText plus the hint — because
  // the strip wave was forbidden tests/panel.test.js, which pins this
  // function's exact lines for a watched terminal row. Both files are
  // editable now, so the fold happened and the wrapper is gone. Two functions where
  // one caller needs one answer is how the two drift apart, so this asserts the
  // wrapper stays gone rather than merely that the fold happened once.
  assert.strictEqual(typeof panel.rowTooltipText, "function");
  assert.strictEqual(panel.rowHoverText, undefined,
    "PanelModel exports rowHoverText again — the strip needs ONE row tooltip,"
    + " and tests/panel.test.js pins that one's lines");
  assert.ok(codeOf(APP_STRIP).indexOf("rowHoverText") === -1,
    "AppStrip.qml still calls rowHoverText");
});

// ---------------------------------------------------------------------------
// The cell, read off the tree
// ---------------------------------------------------------------------------

test("the strip's switch is the bare ToggleSwitch, sized down, and not Ui/Toggle", () => {
  const code = codeOf(APP_STRIP);

  // THE 54. Ui/Toggle.qml:45 is `implicitHeight: Math.max(54,
  // content.implicitHeight + Style.spacing.huge)` — a literal with no property
  // in front of it, so a list built out of Toggle is 54 px a row whatever it
  // contains and no binding out here can reach past it.
  assert.ok(!/(^|[^A-Za-z0-9_])Toggle\s*\{/.test(code),
    "AppStrip.qml instantiates Ui/Toggle again — its 54 px implicitHeight is a"
    + " literal, and the whole point of this file is the compact cell");
  assert.ok(/ToggleSwitch\s*\{/.test(code), "the cell has no switch at all");

  // The override the file exists for, and the two settings that make the switch
  // presentation-only so the CELL owns the click.
  assert.match(code, /trackHeight:\s*Math\.round\(Style\.font\.caption\s*\*\s*1\.4\)/,
    "the switch is not sized off the caption beside it");
  assert.match(code, /cursorPad:\s*Style\.space\(3\)/);
  assert.match(code, /interactive:\s*false/,
    "the switch would take the click the cell is supposed to own");

  // A cell is a popup row, not a form row.
  assert.match(code, /cellHeight:\s*Style\.spacing\.popupRowHeight/,
    "the cell height is no longer a popup row's");
  assert.match(code, /minCellWidth:\s*Style\.space\(140\)/);
  assert.match(code, /rowSpacing:\s*Style\.space\(2\)/);
});

// The `Style.space(n)` a named token of the strip is spelled as. Read from the
// QML rather than restated here, so AppStrip.qml stays the one normative site
// for the geometry and this file only does arithmetic on it.
function spaceToken(name) {
  const found = codeOf(APP_STRIP).match(
    new RegExp("readonly property int " + name + ":\\s*Style\\.space\\((\\d+)\\)"));
  assert.ok(found,
    "AppStrip.qml no longer states `" + name + "` as a Style.space() token, so the"
    + " arithmetic below has nothing to read");
  return Number(found[1]);
}

test("a switch is nearer its own name than the next cell's icon (VM finding S1)", () => {
  // WHAT THE FIRST LOOK FOUND. With the switch anchored to the cell's RIGHT
  // edge and an 8-px column gap, a short name left ~45 px between "Dr Panel"
  // and its switch while the next cell's icon began ~16 px past it — so the eye
  // filed every switch under the app to its right and the line read as one
  // run-on control. The fix is two numbers, and this is the relation between
  // them that must hold however a theme scales them (Style.space multiplies
  // both sides, so the ratio is what matters).
  const gap = spaceToken("cellGap");
  const padding = spaceToken("cellPaddingX");
  const nameGap = spaceToken("nameGap");

  // Worst case for the separation: a name long enough to elide, so the switch
  // ends one padding short of its own cell's right edge and the next cell's
  // icon starts one padding past the gap.
  const toNextCell = padding + gap + padding;
  assert.ok(toNextCell >= 3 * nameGap,
    `a switch is ${nameGap} px from its own name and, at worst, ${toNextCell} px`
    + " from the next cell's icon — too close to tell apart. That is finding S1"
    + " coming back: widen cellGap or tighten nameGap.");
  assert.match(codeOf(APP_STRIP), /cellGap:\s*Style\.space\(20\)/,
    "the column gap is no longer the shell's own multi-column spacing"
    + " (plugins/panels/network/Panel.qml:1227)");
});

test("four columns still fit the panel card, at the gap the look asked for", () => {
  // The card is Math.min(Style.space(660), 94 % of the screen) wide, and its
  // content is that less two borders and two popup paddings — 628 px at the
  // acceptance VM's 1280×800 on the stock theme, which is where the pictures
  // that found S1 were taken. Widening the gap costs cell width, and the floor
  // is that the grid must not lose a column for it.
  const CARD_CONTENT = 628;
  const packed = panel.stripLayout(9, CARD_CONTENT, spaceToken("minCellWidth"),
    spaceToken("cellGap"));
  assert.strictEqual(packed.columns, 4,
    "the panel card now packs " + packed.columns + " columns instead of four;"
    + " the DoD's floor is two, but dropping one is a change to say out loud");
  // And a cell still has room for an icon, a switch and a name worth reading.
  const content = spaceToken("cellPaddingX") * 2 + 18 + spaceToken("iconGap")
    + spaceToken("nameGap") + 27;
  assert.ok(packed.cellWidth - content >= 70,
    "a cell leaves the name only " + (packed.cellWidth - content) + " px");
});

test("the cell is fixed-width, its switch sits with its name, and the name elides", () => {
  const code = codeOf(APP_STRIP);

  // Checklist item 5, as structure. The width comes from the pure function and
  // from nothing else; the name gives way rather than the cell growing.
  assert.match(code, /width:\s*appStrip\.packing\.cellWidth/,
    "a cell no longer takes its width from stripLayout, so it can size itself"
    + " off its own content — which is the right edge moving on every tick");
  assert.match(code, /PanelModel\.stripLayout\(/, "the packing is not the pure function's");
  assert.match(code, /elide:\s*Text\.ElideRight/, "the name no longer elides");

  // PACKED LEFT (finding S1): the switch follows the name at `nameGap`, and
  // every pixel of slack in a cell falls after it, where the column gap is.
  const switchBlock = blockAround(code, /ToggleSwitch\s*\{/);
  assert.match(switchBlock, /anchors\.left:\s*cellLearn\.right/,
    "the switch no longer follows the name and the learn mark:\n" + switchBlock);
  assert.match(switchBlock, /anchors\.leftMargin:\s*appStrip\.nameGap/, switchBlock);
  assert.ok(!/anchors\.right:\s*parent\.right/.test(switchBlock),
    "the switch is back on the cell's right edge, which is what paired it with"
    + " the NEXT cell's icon:\n" + switchBlock);

  // AND IT STILL CANNOT LEAVE THE CELL. `nameRoom` reserves the switch, the
  // mark and both paddings before the name gets any of the width, and the name
  // takes the smaller of that and what it wants — one Math.min carrying the
  // whole of "a long name elides, it does not push the switch out".
  assert.match(code, /width:\s*Math\.min\(cellName\.implicitWidth,\s*appCell\.nameRoom\)/,
    "the name is no longer capped by nameRoom, so a long one pushes the switch"
    + " past the cell's right edge and into the app beside it");
  const room = blockAround(code, /readonly property int nameRoom:/);
  for (const term of ["cellPaddingX", "cellIcon.width", "iconGap", "cellLearn",
    "nameGap", "cellSwitch.implicitWidth"]) {
    assert.ok(room.indexOf(term) !== -1,
      "nameRoom does not reserve `" + term + "`, so the name can eat it:\n" + room);
  }

  // One hover language with the map: the same fill a chip lights up with.
  assert.match(code, /Style\.hoverFillFor\(appStrip\.panel\.foreground,\s*Color\.accent\)/,
    "the cell's hover is no longer the map's hover");
  // A ghost is dimmed rather than removed — it sits in the same grid.
  assert.match(code, /opacity:\s*appCell\.modelData\.ghost\s*\?\s*0\.6\s*:\s*1\.0/);
  // And a cell the panel cannot act on offers neither a click nor a hand.
  assert.match(code, /clickable:\s*appCell\.modelData\.clickable\s*!==\s*false/);
  assert.match(code, /cursorShape:\s*appCell\.clickable\s*\?\s*Qt\.PointingHandCursor/,
    "a cell that cannot be acted on still offers a pointing hand");
});

test("the captions are gone: the placement lives in the tooltip and nowhere else", () => {
  const code = codeOf(APP_STRIP);

  // The old row drew `position`, the drift arrow and the verdict beside the
  // switch, in a fixed 45 % column. All of it is hover text now — the map above
  // already says where every window is, which is the whole argument of the
  // redesign. rowTooltipText is the one place that composes it.
  for (const field of ["position", "driftTo", "mismatch", "launchHint"]) {
    assert.ok(code.indexOf("modelData." + field) === -1,
      "AppStrip.qml still draws modelData." + field + " on the cell — those facts"
      + " belong to PanelModel.rowTooltipText and the tooltip now");
  }
  assert.match(code, /PanelModel\.wrapTooltip\(\s*PanelModel\.rowTooltipText\(/,
    "the tooltip is not the wrapped row tooltip text");

  // The two Text elements left are the name and the learn mark. A third is a
  // caption growing back.
  const texts = (code.match(/(^|\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?Text\s*\{/g) || []).length;
  assert.strictEqual(texts, 2,
    "AppStrip.qml declares " + texts + " Text element(s); the strip has exactly"
    + " two — the app's name and the learn-launch mark");

  // "Learn launch" survives as an offer with its OWN click. Pressing it must
  // not also untick the app, and that is structural here rather than an
  // ordering trick: its MouseArea covers the mark alone.
  assert.match(code, /visible:\s*appCell\.modelData\.launchRepairable\s*===\s*true/);
  assert.match(code, /onClicked:\s*appStrip\.panel\.learnLaunchFor\(/);
  const learnClick = blockAround(code, /anchors\.fill:\s*cellLearn/);
  assert.ok(learnClick.indexOf("toggleChip") === -1,
    "the learn-launch click can also untick the app:\n" + learnClick);
});

// ---------------------------------------------------------------------------
// The report site
// ---------------------------------------------------------------------------


test("hoverText is reported only while the cell is lit, and never as a caption key", () => {
  const code = codeOf(APP_STRIP);
  const report = blockAround(code, /function reportRender\(\)/);

  // PRESENT ONLY WHILE `linked`, ABSENT otherwise — the absent-vs-null contract,
  // normative in tests/acceptance/README.md. A key assigned in the literal would
  // be present on every row in the payload, which is a different sentence.
  assert.ok(/\bhoverText\b/.test(report), "the report no longer carries hoverText at all");
  assert.match(report, /if\s*\(\s*appCell\.linked\s*\)\s*report\.hoverText\s*=/,
    "hoverText is not gated on `linked` at the report site:\n" + report);
  assert.ok(!/hoverText\s*:/.test(report),
    "hoverText is assigned inside the report literal, so it is present on every"
    + " row whether or not the cell is lit:\n" + report);

  // The seven fields that were there before this change are still there.
  for (const field of ["name", "watched", "ghost", "iconSource", "iconResolved",
    "linkKey", "linked"]) {
    assert.ok(new RegExp("\\b" + field + ":").test(report),
      "the report dropped `" + field + "`, which the acceptance suite keys on");
  }

  // And none of the keys the redesign deleted comes back under a new name.
  for (const banned of ["pictured", "picturable", "where", "placement", "caption"]) {
    assert.ok(!new RegExp("\\b" + banned + "\\b").test(report),
      "the report carries a `" + banned + "` key:\n" + report);
  }
});

test("every property the report captures has a handler that re-runs it", () => {
  // THE REPORT-SITE RULE, and it is in the project notes because this exact
  // shape shipped once: the row reported `iconResolved: false` for a whole
  // session although the icon had resolved, because `reportRender()` re-ran on
  // `iconSource` and nothing told it to re-run when `iconResolved` changed.
  // Enumerated rather than assumed — one handler does not cover a batch.
  const code = codeOf(APP_STRIP);
  const report = blockAround(code, /function reportRender\(\)/);

  const captured = [];
  for (const hit of report.match(/\bappCell\.[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    const name = hit.slice("appCell.".length);
    if (name === "reportRender") continue;
    if (captured.indexOf(name) === -1) captured.push(name);
  }
  assert.ok(captured.length >= 5,
    "the capture scan found only " + captured.length + " propert(ies) in the"
    + " report body — it has most likely stopped matching, which would make this"
    + " whole test vacuous");

  const missing = captured.filter((name) => {
    const handler = "on" + name.charAt(0).toUpperCase() + name.slice(1) + "Changed";
    return !new RegExp("\\b" + handler + "\\s*:").test(code);
  });
  assert.deepStrictEqual(missing, [],
    "these properties are captured in the report but nothing re-reports them when"
    + " they change, so the payload can hold a value the cell has since replaced:\n  "
    + missing.join("\n  "));

  // The first report of all, and the one that catches a cell whose model
  // arrived complete.
  assert.match(code, /Component\.onCompleted:\s*appCell\.reportRender\(\)/);
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

test("panelState reports the strip's drawn shape beside the two heights it is judged against", () => {
  const code = codeOf(PANEL_QML);

  // Always present, and read off the component rather than recomputed here: a
  // second call to stripLayout in this file would be the panel agreeing with
  // itself, and could agree while the strip drew something else.
  assert.match(code, /strip:\s*\{/, "panelState() no longer carries a `strip` key");
  assert.match(code, /columns:\s*appStrip\.drawnColumns\(\)/);
  assert.match(code, /rowHeight:\s*appStrip\.drawnRowHeight\(\)/);
  assert.match(code, /height:\s*Math\.round\(appStrip\.height\)/);
  assert.ok(!/strip:\s*\{[^}]*PanelModel\.stripLayout/.test(code),
    "the payload recomputes the packing instead of reading what was drawn");

  // The comparison the DoD actually asks for — "the panel is not taller than
  // the map needs" — needs the other side of it, from a layout chain that never
  // meets the strip's.
  assert.match(code, /mapHeight:\s*Math\.round\(mapSurface\.height\)/);
  assert.match(code, /panelHeight:\s*Math\.round\(card\.height\)/);

  // Both ids are real, and are the surfaces they claim to be. `qmllint` exits 0
  // on an unknown id, so this is the only gate that says so before the VM does.
  assert.match(code, /id:\s*mapSurface\b/);
  assert.match(code, /id:\s*card\b/);
  assert.match(code, /id:\s*appStrip\b/,
    "Panel.qml no longer names the strip, so the payload's three numbers cannot"
    + " be read off it");

  // And the functions it calls exist on the component.
  assert.match(codeOf(APP_STRIP), /function drawnColumns\(\)/);
  assert.match(codeOf(APP_STRIP), /function drawnRowHeight\(\)/);
});

test("a row's hoverText is gated again where the payload is built", () => {
  // The registry MERGES and is never pruned (see rowReports in Panel.qml), so
  // the text of the last cell hovered outlives the hover. Gating at READ time,
  // on the delegate's own reported `linked`, is what keeps a stale entry out of
  // the payload — the same discipline an earlier change paid for with the overflow menu.
  const code = codeOf(PANEL_QML);
  assert.match(code, /if\s*\(\s*rowLinked\s*===\s*true\s*\)/,
    "panelState() no longer gates hoverText on the row's reported `linked`");
  assert.match(code, /rows\[rows\.length - 1\]\.hoverText\s*=\s*hoverText/,
    "hoverText is not ADDED to the row, so it is present-and-null rather than"
    + " absent when there is nothing to say");
  assert.ok(!/hoverText:\s*root\.reported/.test(code),
    "hoverText is assigned in the row literal, which makes it present on every"
    + " row — the payload's rule is that a key the panel has nothing to say"
    + " about is ABSENT (tests/acceptance/README.md is normative)");
});
