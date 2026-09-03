// qml-plaintext.test.js — every Text in Panel.qml renders text, not markup.
//
// WHY THIS EXISTS. Qt's `Text.textFormat` defaults to `Text.AutoText`, which
// means a string that looks like HTML is RENDERED as HTML. The panel draws
// strings it did not write: window classes straight from Hyprland, identity ids
// out of a user-editable state file, monitor descriptions out of an EDID — and,
// through the terminal proposal, names derived from a window's own TITLE, which
// is a string an application picks for itself and can put anything in.
//
// `textFormat` appeared ZERO times in Panel.qml before tick bbu.
//
// WHY EVERY Text AND NOT ONLY THE TITLE-DERIVED ONES. Deciding which bindings
// can reach a title is an argument, and it would have to be re-made correctly
// by every future author adding a Text. "All of them" is a rule a machine can
// check and a reader can follow, it costs one line on a static label, and it
// cannot rot into a stale whitelist. That is what this file enforces: add a
// `Text { }` to Panel.qml without `textFormat: Text.PlainText` and this fails,
// naming the line.
//
// SCOPE. Panel.qml only — it is the file that draws untrusted strings. The
// shell's own components the panel uses (Ui/PanelToolTip, Ui/Toggle,
// Ui/PanelHero) already declare PlainText on their contentItem, which is why
// the tooltip carrying a raw window title is not a hole; that is asserted below
// too, so a shell that dropped it would be caught here rather than on screen.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const PANEL_QML = path.join(REPO_ROOT, "Panel.qml");

// Every `Text { ... }` block in a QML file, as { line, body }.
//
// Brace-counted rather than regex-matched over the whole block: a QML property
// value can contain a brace (a JS block binding routinely does), so counting is
// what makes "where does this element end" answerable at all. String literals
// are skipped for the same reason — `text: "}"` is legal and is not a close.
function textBlocks(source) {
  const lines = source.split("\n");
  // `Text {`, and the forms it appears in as a property value:
  // `delegate: Text {`, `contentItem: Text {`.
  const opens = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?Text \{\s*$/;
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    if (!opens.test(lines[i])) continue;
    let depth = 1;
    const body = [];
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      const line = lines[j];
      let inString = false;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === '"' && line[c - 1] !== "\\") inString = !inString;
        else if (!inString && ch === "{") depth++;
        else if (!inString && ch === "}") depth--;
        if (depth === 0) break;
      }
      if (depth > 0) body.push(line);
    }
    blocks.push({ line: i + 1, body: body.join("\n") });
  }

  return blocks;
}

test("every Text in Panel.qml declares textFormat: Text.PlainText", () => {
  const source = fs.readFileSync(PANEL_QML, "utf8");
  const blocks = textBlocks(source);

  // A count, so a refactor that stopped this scan from finding anything fails
  // loudly instead of passing vacuously. This is the trap a source-scanning
  // test falls into: zero blocks checked is zero failures.
  assert.ok(blocks.length > 20,
    `expected Panel.qml to contain many Text elements, found ${blocks.length}` +
    " — the block scanner has most likely stopped matching");

  const unguarded = blocks
    .filter((b) => !/^\s*textFormat:\s*Text\.PlainText\s*$/m.test(b.body))
    .map((b) => `Panel.qml:${b.line}`);

  assert.deepStrictEqual(unguarded, [],
    "these Text elements do not declare textFormat: Text.PlainText, so Qt will" +
    " render markup an application put in its own window title:\n  " +
    unguarded.join("\n  "));
});

test("the shell components the panel draws untrusted strings through are plain too", () => {
  // The panel hands a raw window TITLE to PanelToolTip and a row name to
  // Toggle, and neither is ours to fix — so this asserts the property rather
  // than assuming it. A shell that dropped PlainText from one of these would
  // reopen the hole through the one binding Panel.qml cannot guard itself.
  const shell = process.env.OMARCHY_PATH || "/usr/share/omarchy";
  const components = ["Ui/PanelToolTip.qml", "Ui/Toggle.qml", "Ui/PanelHero.qml"];

  for (const relative of components) {
    const file = path.join(shell, "shell", relative);
    if (!fs.existsSync(file)) {
      // The node tier runs on machines without the shell installed; a missing
      // component is not this suite's failure to report.
      continue;
    }
    const blocks = textBlocks(fs.readFileSync(file, "utf8"));
    assert.ok(blocks.length > 0, `${relative} has no Text element — has it been rewritten?`);
    for (const block of blocks) {
      assert.match(block.body, /^\s*textFormat:\s*Text\.PlainText\s*$/m,
        `${relative}:${block.line} no longer declares textFormat: Text.PlainText`);
    }
  }
});
