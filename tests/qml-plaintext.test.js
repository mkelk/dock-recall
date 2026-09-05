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
// SCOPE: EVERY QML FILE THIS REPOSITORY SHIPS, from a glob (tick md1).
//
// It was a hand-maintained list of three, in a file whose own thesis two
// paragraphs up is that "all of them" is a rule a machine can check and "it
// cannot rot into a stale whitelist". It was exactly that whitelist. Tick xk5
// extracted the map into MapWorkspace.qml carrying `chipLabel` — the one binding
// that renders a window title an application chose for itself — OUTSIDE both
// guards, and tick y4y spent a whole tick retro-fitting them. Coverage was
// complete only because the three files that contained a `Text` happened to be
// the three named; the moment a fourth grew one, the whitelist rotted silently
// and the failure was an HTML-injection hole.
//
// The plugin installs its clone root and its QML entry points sit at the top
// level (see CLAUDE.md), so `*.qml` in the repository root IS the set. Files
// with no Text at all are scanned and pass trivially, which is the point: the
// scan does not have to be told about them.
//
// The shell's own components the panel uses (Ui/PanelToolTip, Ui/Toggle,
// Ui/PanelHero) already declare PlainText on their contentItem, which is why the
// tooltip carrying a raw window title is not a hole; that is asserted below too,
// so a shell that dropped it would be caught here rather than on screen.
//
// AND ONE STRUCTURAL GUARD, at the bottom. This is the repository's source-scan
// file — node cannot instantiate QML, so a claim about which COMPONENT the panel
// used can only be made by reading the tree — and "the header is a PanelHero" is
// exactly that shape of claim. It sits here rather than in a file of its own
// because it is one assertion and it shares this file's whole premise: the scan
// is the assertion.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const PANEL_QML = path.join(REPO_ROOT, "Panel.qml");

// THE SET, from a glob and not from a list. See SCOPE above for why that is the
// whole point of this file rather than a convenience.
const QML_FILE_COUNT = 9;   // BarWidget, CaptureStore, ConsentPrompt,
                            // LiveCaptureStore, MapWorkspace, Motion, Panel,
                            // Service, ToplevelBridge.
                            //
                            // Spelled ONCE. It was spelled three times with two
                            // different numbers, two of them stale, in the file
                            // whose own thesis is that a guard must not rot —
                            // and moving a QML file into a subdirectory was
                            // measured leaving two of the three guards green
                            // while they silently scanned one file fewer.

function qmlFiles() {
  return fs.readdirSync(REPO_ROOT)
    .filter((name) => name.endsWith(".qml"))
    .sort()
    .map((name) => ({ label: name, file: path.join(REPO_ROOT, name) }));
}

// Every `<Name> { ... }` block in a QML file, as { line, body }.
//
// Brace-counted rather than regex-matched over the whole block: a QML property
// value can contain a brace (a JS block binding routinely does), so counting is
// what makes "where does this element end" answerable at all. String literals
// and `//` comments are skipped for the same reason — `text: "}"` is legal and
// is not a close, and neither is a brace somebody drew in prose.
//
// The element name is a parameter because there is more than one thing to ask
// about a QML tree (tick md1): the PanelHero guard at the bottom used to walk
// braces with its own eight-line loop that skipped neither strings nor comments
// and found its element with `indexOf("PanelHero {")` — exactly one space, where
// the regex beside it allowed any. `PanelHero{` made all three of its assertions
// pass VACUOUSLY. One hardened scanner, asked twice.
function elementBlocks(source, name) {
  const lines = source.split("\n");
  // `<Name> {`, and the forms it appears in as a property value:
  // `delegate: Text {`, `contentItem: Text {`.
  //
  // The brace may be pressed against the name (`Text{`) or spaced off it
  // (`Text  {`), and anything may follow it on the line — a `// note`, or the
  // whole body of a one-line element. All of those are valid QML, and an
  // opener that demanded exactly one space with the brace last read them as
  // ordinary lines and never scanned them at all. The only form still outside
  // this pattern is a brace on the FOLLOWING line, and declarationsOf below
  // is what turns that from a silent skip into a failure.
  const opens = new RegExp(
    "^(\\s*(?:[A-Za-z_][A-Za-z0-9_]*:\\s*)?" + name + "\\s*\\{)(.*)$");
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

function textBlocks(source) {
  return elementBlocks(source, "Text");
}

// Every place the file DECLARES an element of this name, counted without
// parsing one. Deliberately a different question from elementBlocks': it
// tolerates every spacing, a trailing comment and a brace on the next line, so
// the two agreeing is evidence the scanner reached all of them.
function declarationsOf(source, name) {
  return (source.match(new RegExp("\\b" + name + "\\s*\\{", "g")) || []).length;
}

// The vacuity guard, and it is an EQUALITY rather than a floor.
//
// It used to be `blocks.length > 20` against 26 real blocks, so up to six
// elements could fall out of the scan — written in a form the opener did not
// match — without a word. A skipped Text is exactly what this file exists to
// prevent, so the arithmetic has to be exact: every declaration the file makes
// is a block the scanner parsed, or the suite FAILS and says which count moved.
//
// It is also what carries the extra files the glob now brings in: a file with no
// Text at all declares none and parses none, and passes by arithmetic rather
// than by being left off a list.
function assertScannedEvery(label, name, source, blocks) {
  const declared = declarationsOf(source, name);
  assert.strictEqual(blocks.length, declared,
    `${label}: the scanner parsed ${blocks.length} ${name} element(s) but the file` +
    ` declares ${declared}. A form the scanner cannot parse is a ${name} nobody` +
    " checked, which is the whole hole this file closes — widen elementBlocks()" +
    ` (or, if the extra count is the words \`${name} {\` inside a comment or a` +
    " string, reword it).");
}

function assertScannedEveryText(label, source, blocks) {
  assertScannedEvery(label, "Text", source, blocks);
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

test("the element scanner cannot be dodged by writing the brace without a space (tick md1)", () => {
  // The PanelHero guard at the bottom used to find its element with
  // `indexOf("PanelHero {")` — exactly one space — while the regex beside it
  // allowed any. Written like this, the slice started at -1, the walk produced
  // an empty string, and all three of its assertions passed over nothing.
  const source = [
    'PanelHero{',
    '  title: hero.title // a brace { in prose, and a "}" in a string',
    '  trailingControl: pauseSwitch',
    '}'
  ].join("\n");

  const heroes = elementBlocks(source, "PanelHero");
  assert.strictEqual(heroes.length, 1);
  assert.match(heroes[0].body, /title: hero\.title/);
  assert.match(heroes[0].body, /trailingControl:/);
  // And the same oracle the Text scan uses agrees, so the guard is an oracle
  // rather than a restatement here too.
  assertScannedEvery("forms", "PanelHero", source, heroes);
});

// ONE TEST OVER THE GLOB, not one per named file. A per-file test needs a
// per-file name, and a per-file name is a list — the thing this tick removed.
// The failure message names the file and the line anyway, which is what a
// per-file test was ever for.
test("every Text in every QML file this plugin ships declares textFormat: Text.PlainText", () => {
  const files = qmlFiles();

  // THE GLOB ITSELF IS THE FIRST THING THAT CAN GO WRONG. A rename, a move into
  // a subdirectory, a readdir that answers nothing: every one of those turns
  // this whole test green by scanning nothing at all. The plugin's entry points
  // are its QML files, and QML_FILE_COUNT above is how many — spelled once.
  assert.strictEqual(files.length, QML_FILE_COUNT,
    "the QML glob found " + files.length + " file(s) (" + files.map((f) => f.label).join(", ")
    + "). The plugin ships its QML at the repository root — if a file moved into a"
    + " subdirectory, this scan is no longer looking at it.");

  const unguarded = [];
  let scanned = 0;

  for (const target of files) {
    const source = fs.readFileSync(target.file, "utf8");
    const blocks = textBlocks(source);

    // Every Text the file declares is a Text this scan parsed. The trap a
    // source-scanning test falls into is that nothing checked is nothing
    // failed, and this equality is what catches it PER FILE — including for the
    // files that have no Text at all, which pass by arithmetic rather than by
    // being left off a list.
    assertScannedEveryText(target.label, source, blocks);
    scanned += blocks.length;

    for (const block of blocks) {
      if (!/^\s*textFormat:\s*Text\.PlainText\s*$/m.test(block.body)) {
        unguarded.push(`${target.label}:${block.line}`);
      }
    }
  }

  // The floor is now over the whole set rather than per file, because the set is
  // no longer a list of files known to contain Text. It is the same claim it
  // always was: the scanner has not silently stopped matching.
  assert.ok(scanned > 20,
    "the scan found only " + scanned + " Text element(s) across " + files.length
    + " QML file(s) — the block scanner has most likely stopped matching");

  assert.deepStrictEqual(unguarded, [],
    "these Text elements do not declare textFormat: Text.PlainText, so Qt will" +
    " render markup an application put in its own window title:\n  " + unguarded.join("\n  "));
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

// ---------------------------------------------------------------------------
// THE HEADER IS A PanelHero (tick 05q)
// ---------------------------------------------------------------------------
//
// The payload proves the header reports the right strings — `headerTitle` and
// `headerMeta` — and nothing more. A hand-rolled `Item` with a title Text, a
// meta Text and the same two `reportHeader` calls would pass every acceptance
// assertion identically, which means the DoD's "the header is a `PanelHero`"
// had nothing pinning it at all.
//
// It matters because the reason for using the shell's component is structural
// rather than cosmetic: `PanelHero` RESERVES the trailing control's width
// itself, and the hand-rolled version it replaced chained four anchors
// right-to-left so that every addition to the row was another link in that
// chain. A drift back to a hand-rolled header would not show up in any string.
//
// Node cannot instantiate QML, so this reads the tree. That is the same tactic
// tests/state.test.js uses for the writeRefusal call sites and
// tests/migration.test.js for the bash snippet inside Service.qml: there is no
// second copy of the logic, only the question of who does what.
test("the panel's header is the shell's PanelHero, and it is what reports the header", () => {
  const source = fs.readFileSync(PANEL_QML, "utf8");

  // The component is the shell's, so the import that brings it in has to be
  // there — a file that lost `qs.Ui` would not compile, but a file that grew a
  // local `PanelHero.qml` would, and would be a different component under the
  // same name.
  assert.match(source, /^import qs\.Ui$/m, "Panel.qml no longer imports the shell's Ui module");
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, "PanelHero.qml")),
    "a local PanelHero.qml would shadow the shell's component of the same name");

  // THE SAME HARDENED SCANNER the Text guard uses (tick md1). This walked
  // braces with a loop of its own that skipped neither strings nor comments, and
  // found its element with `indexOf("PanelHero {")` — exactly one space, where
  // the regex on the line above allowed any. Written `PanelHero{`, the slice
  // started at -1, the walk produced an empty string, and all three assertions
  // below passed VACUOUSLY. The equality guard is the same oracle the Text scan
  // uses: every declaration is a block the scanner parsed.
  const heroes = elementBlocks(source, "PanelHero");
  assertScannedEvery("Panel.qml", "PanelHero", source, heroes);
  assert.strictEqual(heroes.length, 1,
    "expected exactly one PanelHero element in Panel.qml, found " + heroes.length);

  // And it is THE header: the block that reports `headerTitle` and `headerMeta`
  // into the payload is inside the PanelHero, bound to the hero's own `title`
  // and `meta`. That is the join a hand-rolled Item would break — it could still
  // report the same two strings, but not off a PanelHero's properties.
  const hero = heroes[0].body;
  assert.ok(hero.length > 0, "the PanelHero element parsed as an empty block");

  assert.match(hero, /root\.reportHeader\(\{\s*title:\s*hero\.title,\s*meta:\s*hero\.meta\s*\}\)/,
    "the payload's headerTitle/headerMeta no longer come from the PanelHero's own properties");
  // The two things the shell's component owns and the hand-rolled one did not:
  // the icon slot and the reserved trailing control. Both are handed components,
  // and dropping either is the drift this test exists to catch.
  assert.match(hero, /iconComponent:/, "the hero no longer carries the monitor glyph");
  assert.match(hero, /trailingControl:/, "the hero no longer reserves the pause switch's width");
});

// ---------------------------------------------------------------------------
// Motion: one statement of how long things take (tick oas)
// ---------------------------------------------------------------------------
//
// Omarchy's theme has colour, spacing and radius tokens and NO animation tokens,
// so a plugin that animates either copies the shell's numbers or invents its
// own — and either way the number ends up spelled in every file that moves.
// This project has already paid for a value living in two places four times in
// two increments (the test count drifted three times; the payload contract's
// rationale was written out in four files), and the fix each time was to
// nominate ONE normative site. Motion.qml is that site, and this is the guard
// that keeps it one.
//
// Same glob discipline as everything above it, and for the reason tick md1
// established: a hand-written list of files rots silently the moment somebody
// adds a fifth.

test("no QML file spells an animation duration or curve of its own", () => {
  const files = qmlFiles();
  assert.strictEqual(files.length, QML_FILE_COUNT, "the glob found the repository's QML files");

  const offenders = [];
  let scanned = 0;
  for (const { label, file } of files) {
    // Motion.qml is the one place the numbers are allowed to be literals. That
    // is what it is FOR.
    if (label === "Motion.qml") continue;
    scanned += 1;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // A literal number after `duration:`, or a literal Easing curve. A
      // binding — `duration: root.motion.duration` — is exactly what this rule
      // asks for and must pass.
      // `easing.type: Easing.X` AND the grouped form, `easing { type: Easing.X }`,
      // whose inner line carries no `easing.` prefix at all. The second is
      // idiomatic QML and slipped straight through: a probe with a bound
      // duration and a grouped curve passed all nine of these tests.
      if (/\bduration\s*:\s*-?\d/.test(line)
        || /\beasing\.type\s*:\s*Easing\./.test(line)
        || /\btype\s*:\s*Easing\./.test(line)) {
        offenders.push(label + ":" + (i + 1) + "  " + line.trim());
      }
    });
  }

  assert.ok(scanned >= 6, "more than Motion.qml itself was scanned");
  assert.deepStrictEqual(offenders, [],
    "these animations spell their own timing instead of reading Motion.qml:\n  "
    + offenders.join("\n  "));
});

test("Motion.qml states the tokens the rest of the plugin reads", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "Motion.qml"), "utf8");
  // The three the plugin actually consumes. Named individually rather than
  // counted, because "some tokens exist" is not what any caller needs.
  assert.match(source, /readonly property int duration:\s*\d+/,
    "Motion.qml no longer states a transition duration");
  assert.match(source, /readonly property int easingType:\s*Easing\.\w+/,
    "Motion.qml no longer states a curve");
  assert.match(source, /readonly property int sweepDuration:\s*\d+/,
    "Motion.qml no longer states the bar sweep's duration");
  assert.match(source, /readonly property int breatheDuration:\s*\d+/,
    "Motion.qml no longer states the drift breathe's half-period");
});

// ---------------------------------------------------------------------------
// A Behavior cannot animate a readonly property (tick w7x)
// ---------------------------------------------------------------------------
//
// WHAT THIS COST. `Behavior on edgeColor` was written against a property
// declared `readonly property color edgeColor`. A Behavior is an INTERCEPTOR ON
// WRITES, and Qt refuses to install one on a readonly property — so the whole
// component became unavailable:
//
//   MapWorkspace.qml[371:9]: Invalid property assignment:
//                            "edgeColor" is a read-only property
//   Panel.qml[4470:39]: Type MapWorkspace unavailable
//
// The panel then never mapped a surface at all, which failed THREE acceptance
// tests — and it shipped through three ticks because `qmllint` exits 0 on it,
// the node suite cannot instantiate QML, and no gate ran in between. The
// filtered service log looked perfectly healthy: the service and the bar widget
// both said their piece, because the fault was in a file neither of them loads.
//
// So it is caught here, where a source scan can see it, in the file whose whole
// job is claims that can only be made by reading the tree.

test("no Behavior animates a property its own file declares readonly", () => {
  const files = qmlFiles();
  assert.strictEqual(files.length, QML_FILE_COUNT, "the glob found the repository's QML files");

  const offenders = [];
  for (const { label, file } of files) {
    const source = fs.readFileSync(file, "utf8");

    // Every `readonly property <type> <name>` this file declares. Comment lines
    // are skipped: the comment above the fix quotes the very line it removed.
    const readonly = new Set();
    for (const line of source.split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      const m = line.match(/^\s*readonly\s+property\s+\S+\s+(\w+)\s*:/);
      if (m) readonly.add(m[1]);
    }

    source.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const m = line.match(/^\s*Behavior\s+on\s+(\w+)\b/);
      if (m && readonly.has(m[1])) {
        offenders.push(label + ":" + (i + 1) + "  Behavior on " + m[1]
          + " — declared readonly in the same file");
      }
    });
  }

  assert.deepStrictEqual(offenders, [],
    "a Behavior on a readonly property makes the whole component unavailable "
    + "at load, and qmllint will not tell you:\n  " + offenders.join("\n  "));
});
