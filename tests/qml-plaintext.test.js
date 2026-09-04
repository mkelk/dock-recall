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
// SCOPE. Panel.qml and MapWorkspace.qml — between them, every file that draws
// untrusted strings. A later tick extracted the map's ~900 lines out of
// Panel.qml into MapWorkspace.qml, and the Text elements this file cares about
// most went with it: chipLabel, which renders a window title an application
// chose for itself, plus tagLabel and workspaceBadgeText. The scan follows
// them there rather than stopping at the file's old boundary — each file gets
// its own exact block-count check, so a Text added to either one without
// `textFormat` still fails, naming the right file and line. The shell's own
// components the panel uses (Ui/PanelToolTip, Ui/Toggle, Ui/PanelHero) already
// declare PlainText on their contentItem, which is why the tooltip carrying a
// raw window title is not a hole; that is asserted below too, so a shell that
// dropped it would be caught here rather than on screen.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const PANEL_QML = path.join(REPO_ROOT, "Panel.qml");
const MAP_WORKSPACE_QML = path.join(REPO_ROOT, "MapWorkspace.qml");
const CONSENT_PROMPT_QML = path.join(REPO_ROOT, "ConsentPrompt.qml");

// Every `Text { ... }` block in a QML file, as { line, body }.
//
// Brace-counted rather than regex-matched over the whole block: a QML property
// value can contain a brace (a JS block binding routinely does), so counting is
// what makes "where does this element end" answerable at all. String literals
// and `//` comments are skipped for the same reason — `text: "}"` is legal and
// is not a close, and neither is a brace somebody drew in prose.
function textBlocks(source) {
  const lines = source.split("\n");
  // `Text {`, and the forms it appears in as a property value:
  // `delegate: Text {`, `contentItem: Text {`.
  //
  // The brace may be pressed against the name (`Text{`) or spaced off it
  // (`Text  {`), and anything may follow it on the line — a `// note`, or the
  // whole body of a one-line element. All of those are valid QML, and an
  // opener that demanded exactly one space with the brace last read them as
  // ordinary lines and never scanned them at all. The only form still outside
  // this pattern is a brace on the FOLLOWING line, and TEXT_DECLARATION below
  // is what turns that from a silent skip into a failure.
  const opens = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?Text\s*\{)(.*)$/;
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const opened = opens.exec(lines[i]);
    if (!opened) continue;
    let depth = 1;
    const body = [];
    // From the opening line's TAIL, not from the next line: everything after
    // that first brace is body, and a one-line element has all of its body
    // there.
    for (let j = i; j < lines.length && depth > 0; j++) {
      const line = j === i ? opened[2] : lines[j];
      let inString = false;
      let quote = "";
      let closeAt = -1;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (inString) {
          if (ch === "\\") c++;
          else if (ch === quote) inString = false;
          continue;
        }
        if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
        // A `//` comment runs to the end of the line, and a brace inside one is
        // prose. Tracking this is not pedantry: an unbalanced `{` in a comment
        // used to swallow the rest of the file into a single block, and that
        // block would contain SOME `textFormat: Text.PlainText` line and pass —
        // one unlucky sentence turning the whole scan green.
        if (ch === "/" && line[c + 1] === "/") break;
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) { closeAt = c; break; }
      }
      // Whatever of the line belonged to this element, closing brace excluded —
      // which on a one-line `Text { textFormat: Text.PlainText }` is the body.
      body.push(closeAt < 0 ? line : line.slice(0, closeAt));
    }
    blocks.push({ line: i + 1, body: body.join("\n") });
  }

  return blocks;
}

// Every place the file DECLARES a Text element, counted without parsing one.
// Deliberately a different question from textBlocks': it tolerates every
// spacing, a trailing comment and a brace on the next line, so the two agreeing
// is evidence the scanner reached all of them.
const TEXT_DECLARATION = /\bText\s*\{/g;

// The vacuity guard, and it is an EQUALITY rather than a floor.
//
// It used to be `blocks.length > 20` against 26 real blocks, so up to six
// elements could fall out of the scan — written in a form the opener did not
// match — without a word. A skipped Text is exactly what this file exists to
// prevent, so the arithmetic has to be exact: every declaration the file makes
// is a block the scanner parsed, or the suite FAILS and says which count moved.
function assertScannedEveryText(label, source, blocks) {
  const declared = (source.match(TEXT_DECLARATION) || []).length;
  assert.strictEqual(blocks.length, declared,
    `${label}: the scanner parsed ${blocks.length} Text element(s) but the file` +
    ` declares ${declared}. A form the scanner cannot parse is a Text nobody` +
    " checked, which is the whole hole this file closes — widen textBlocks()" +
    " (or, if the extra count is the words `Text {` inside a comment or a" +
    " string, reword it).");
}

test("the scanner reads the forms a QML author actually writes", () => {
  // The scanner IS the assertion, so its blind spots are the suite's. Each of
  // these is valid QML that the old opener — exactly one space, brace last on
  // the line — read as an ordinary line and never scanned.
  const source = [
    'Text {',
    '  textFormat: Text.PlainText',
    '}',
    'Text{',
    '  textFormat: Text.PlainText',
    '}',
    'Text  {',
    '  textFormat: Text.PlainText',
    '}',
    'Text { // the same thing with a note after it',
    '  textFormat: Text.PlainText',
    '}',
    'contentItem: Text { textFormat: Text.PlainText }'
  ].join("\n");

  const blocks = textBlocks(source);
  assert.strictEqual(blocks.length, 5);
  assert.deepStrictEqual(blocks.map((b) => b.line), [1, 4, 7, 10, 13]);
  for (const block of blocks) assert.match(block.body, /textFormat: Text\.PlainText/);
  // And the count the guard compares against agrees, which is what makes the
  // guard an oracle rather than a restatement.
  assertScannedEveryText("forms", source, blocks);
});

test("a brace inside a comment does not swallow the rest of the file", () => {
  // The failure this shape used to produce was silent AND green: the unbalanced
  // `{` in prose ran the first block on to the end of the file, so the second
  // element vanished into the first one's body — where the first one's own
  // PlainText line satisfied the check for both.
  const source = [
    'Text {',
    '  // an opening brace { in prose, and a lone } in more prose',
    '  textFormat: Text.PlainText',
    '}',
    'Text {',
    '  text: "a literal } and a { too"',
    '}'
  ].join("\n");

  const blocks = textBlocks(source);
  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks.map((b) => b.line), [1, 5]);
  // The second really is unguarded, and is now reported as such rather than
  // hidden inside the first.
  assert.ok(!/textFormat/.test(blocks[1].body));
});

// One scan target per file this suite guards, each with its own exact
// block-count check (assertScannedEveryText) and its own floor — a *minimum*
// sanity check that the scanner still matched something, distinct from the
// exact count. Panel.qml's stays high because the file is still full of
// static chrome; MapWorkspace.qml's is low because the map only has the three
// Text elements the extraction carried over (chipLabel, tagLabel,
// workspaceBadgeText) — a floor of 20 there would never trip even if the
// scanner stopped matching two of the three.
// ConsentPrompt.qml joins them for the same reason MapWorkspace.qml did: it
// draws a string an application chose for itself. Its thumbnail strip labels
// each picture with the app's own name, resolved off the same app row the list
// draws — so a window title that looks like markup reaches a Text here exactly
// as it reaches chipLabel there. Its floor is low because the prompt has three
// Text elements (the title, the body, and the name under each thumbnail), and a
// floor of 20 would never trip even if the scanner stopped matching two of them.
const SCAN_TARGETS = [
  { label: "Panel.qml", file: PANEL_QML, minBlocks: 20 },
  { label: "MapWorkspace.qml", file: MAP_WORKSPACE_QML, minBlocks: 2 },
  { label: "ConsentPrompt.qml", file: CONSENT_PROMPT_QML, minBlocks: 2 },
];

for (const target of SCAN_TARGETS) {
  test(`every Text in ${target.label} declares textFormat: Text.PlainText`, () => {
    const source = fs.readFileSync(target.file, "utf8");
    const blocks = textBlocks(source);

    // Every Text the file declares is a Text this scan parsed. The trap a
    // source-scanning test falls into is that nothing checked is nothing
    // failed, and a floor only catches the version of it where NOTHING
    // matched.
    assertScannedEveryText(target.label, source, blocks);
    assert.ok(blocks.length > target.minBlocks,
      `expected ${target.label} to contain Text elements, found ${blocks.length}` +
      " — the block scanner has most likely stopped matching");

    const unguarded = blocks
      .filter((b) => !/^\s*textFormat:\s*Text\.PlainText\s*$/m.test(b.body))
      .map((b) => `${target.label}:${b.line}`);

    assert.deepStrictEqual(unguarded, [],
      `these Text elements in ${target.label} do not declare` +
      " textFormat: Text.PlainText, so Qt will render markup an application" +
      " put in its own window title:\n  " + unguarded.join("\n  "));
  });
}

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
    const shellSource = fs.readFileSync(file, "utf8");
    const blocks = textBlocks(shellSource);
    // The same exactness as Panel.qml, and for the same reason: a Text the
    // scanner walked past here is a hole in the one binding Panel.qml cannot
    // guard itself. We do not own this file's formatting, so the failure means
    // "widen the scanner", not "fix the shell" — the message says so.
    assertScannedEveryText(relative, shellSource, blocks);
    assert.ok(blocks.length > 0, `${relative} has no Text element — has it been rewritten?`);
    for (const block of blocks) {
      assert.match(block.body, /^\s*textFormat:\s*Text\.PlainText\s*$/m,
        `${relative}:${block.line} no longer declares textFormat: Text.PlainText`);
    }
  }
});
