// qml-interface.test.js — every `panel.<member>` an extracted component reads
// is really declared on Panel.qml's root.
//
// WHY THIS EXISTS. This plugin extracts big subtrees out of Panel.qml into
// root-level components — MapWorkspace.qml (tick xk5), AppStrip.qml (tick kex)
// — and the convention both of them state at their own top is that the outer
// scope hands in ONE handle: `panel: root`, plus the facts only the outer scope
// owns. That makes `grep -o 'panel\.[a-zA-Z]*' <file> | sort -u` the component's
// complete interface, and it makes a renamed or deleted member of Panel.qml a
// silent break in a file the rename never touched.
//
// Nothing else catches it. `qmllint -I "$OMARCHY_PATH/shell" *.qml` is
// SYNTAX-ONLY here: measured in 06-bwf it exits 0 with an unknown id injected
// and with a handler for a signal that does not exist, so it cannot be cited as
// evidence that a binding resolves. Node cannot instantiate QML. And the failure
// mode is quiet — an undefined member is not an error in a QML binding, it is
// `undefined`, so a row draws blank, a colour comes out transparent, or a report
// silently stops arriving, and the first thing that notices is the acceptance
// payload or a human looking at the panel.
//
// So it is checked the only way node can check it: by reading the tree. Same
// tactic as tests/qml-plaintext.test.js (which Text elements are guarded),
// tests/state.test.js (who calls writeRefusal) and tests/migration.test.js (the
// bash inside Service.qml) — there is no second copy of the logic here, only the
// question of who declares what.
//
// THE SET COMES FROM A GLOB, not from a list of two file names. That is tick
// md1's lesson, paid for in this repository: a hand-maintained list of files
// rots silently the moment somebody adds the next one, and the guard stays
// green while scanning less than it did. "Every root-level QML file that
// declares a `panel` property" IS the set of extracted components, by
// definition — a third extraction is covered on the day it is written.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const PANEL_QML = path.join(REPO_ROOT, "Panel.qml");

// A line that is nothing but prose. Every scan below skips these, because this
// repository comments heavily and its comments quote the very identifiers they
// discuss — MapWorkspace.qml's own header spells `panel.motion` in a sentence,
// and a comment ending "rather than in the panel." would otherwise be read as a
// reference to a member with an empty name.
function isComment(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function codeLines(source) {
  return source.split("\n").filter((line) => !isComment(line));
}

// Every distinct `panel.<name>` a component references, in first-seen order.
// The name must start with a letter or underscore, which is what keeps the
// prose form out even when a comment slips past the filter above.
function panelMembersOf(source) {
  const seen = [];
  for (const line of codeLines(source)) {
    const matches = line.match(/\bpanel\.[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const hit of matches) {
      const name = hit.slice("panel.".length);
      if (seen.indexOf(name) === -1) seen.push(name);
    }
  }
  return seen;
}

// Everything Panel.qml's root offers a child: `property <type> <name>`, the
// `readonly` and `required` forms of it, `function <name>(`, and `signal
// <name>(`. Signals are in because a child calling `panel.somethingHappened()`
// is a legal shape of the same interface; nothing does today, and the day one
// does this test must not fail for the wrong reason.
function declaredMembersOf(source) {
  const declared = new Set();
  for (const line of codeLines(source)) {
    const property = line.match(
      /^\s*(?:readonly\s+)?(?:required\s+)?property\s+[\w.<>]+\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (property) declared.add(property[1]);
    const callable = line.match(/^\s*(?:function|signal)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (callable) declared.add(callable[1]);
  }
  return declared;
}

// Whether a file declares the handle at all: `required property var panel` (the
// form both components use) or a plain `property var panel`.
function declaresPanel(source) {
  return codeLines(source).some(
    (line) => /^\s*(?:readonly\s+)?(?:required\s+)?property\s+\S+\s+panel\b/.test(line));
}

// THE SET: every root-level QML file except Panel.qml itself that takes a
// handle on the panel. See the header for why this is a glob and not a list.
function componentFiles() {
  return fs.readdirSync(REPO_ROOT)
    .filter((name) => name.endsWith(".qml") && name !== "Panel.qml")
    .sort()
    .map((name) => ({ label: name, file: path.join(REPO_ROOT, name) }))
    .map((entry) => Object.assign(entry, { source: fs.readFileSync(entry.file, "utf8") }))
    .filter((entry) => declaresPanel(entry.source));
}

// `<Name> {` and the form it appears in as a property value, `delegate: <Name>
// {`. The brace may be pressed against the name or spaced off it, and anything
// may follow it on the line: tick md1 measured an opener that demanded exactly
// one space reading `PanelHero{` as an ordinary line and passing three
// assertions VACUOUSLY over an empty string.
function instantiationLines(source, name) {
  const opens = new RegExp(
    "^\\s*(?:[A-Za-z_][A-Za-z0-9_]*:\\s*)?" + name + "\\s*\\{");
  const lines = source.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    if (!isComment(line) && opens.test(line)) found.push(i);
  });
  return found;
}

test("the scanners find what they claim to, and reject what they should", () => {
  // The scan IS the assertion here, so its blind spots are the suite's. A
  // permissive declaration regex would resolve every name and turn the whole
  // file green while checking nothing at all — this is the negative control
  // that says it cannot.
  const declared = declaredMembersOf(fs.readFileSync(PANEL_QML, "utf8"));
  assert.ok(declared.size >= 40,
    "the declaration scan found only " + declared.size + " member(s) on Panel.qml's"
    + " root — it has most likely stopped matching, which would make every"
    + " assertion below vacuous");
  assert.ok(!declared.has("notARealPanelMember"),
    "the declaration scan resolves a name Panel.qml does not declare");
  // The three shapes the plugin actually uses, named so a regex change that
  // dropped one is a failure here rather than a false green below.
  assert.ok(declared.has("foreground"), "a `readonly property color` is not being read");
  assert.ok(declared.has("hoveredLinkKey"), "a plain `property string` is not being read");
  assert.ok(declared.has("toggleChip"), "a `function` is not being read");

  const probe = [
    'Column {',
    '  // prose that mentions panel.motion, and ends in the panel.',
    '  required property var panel',
    '  color: panel.foreground',
    '  onClicked: panel.toggleChip(row)',
    '  width: panel.foreground.length',
    '}'
  ].join("\n");
  assert.deepStrictEqual(panelMembersOf(probe), ["foreground", "toggleChip"],
    "the member scan reads prose, misses a call, or repeats a name");
  assert.ok(declaresPanel(probe), "the `panel` handle scan misses `required property var panel`");
  assert.ok(declaresPanel("Item {\n  property var panel: null\n}"),
    "the `panel` handle scan insists on `required`");
  assert.ok(!declaresPanel("Item {\n  color: panel.foreground\n}"),
    "the `panel` handle scan accepts a file that only READS the handle");
});

// ONE TEST OVER THE GLOB. The failure message names the file and every
// unresolved member, which is what a per-file test was ever for — and a
// per-file test needs a per-file name, which is the list this file refuses to
// keep.
test("every panel.<member> an extracted component reads is declared on Panel.qml's root", () => {
  const panelSource = fs.readFileSync(PANEL_QML, "utf8");
  const declared = declaredMembersOf(panelSource);
  const components = componentFiles();

  // THE GLOB ITSELF IS THE FIRST THING THAT CAN GO WRONG: a rename, a move into
  // a subdirectory, a readdir that answers nothing — every one of those turns
  // this test green by scanning nothing at all.
  assert.ok(components.length >= 2,
    "expected at least two extracted components taking a `panel` handle, found "
    + components.length + " (" + components.map((c) => c.label).join(", ")
    + "). MapWorkspace.qml and AppStrip.qml are both supposed to be here.");

  const unresolved = [];
  for (const component of components) {
    const members = panelMembersOf(component.source);
    // A component in this set declares the handle, so it reads at least one
    // member through it. None means the member scan has stopped matching.
    assert.ok(members.length > 0,
      component.label + " takes a `panel` handle and reads nothing through it —"
      + " the member scan has most likely stopped matching");
    for (const name of members) {
      if (!declared.has(name)) unresolved.push(component.label + " reads panel." + name);
    }
  }

  assert.deepStrictEqual(unresolved, [],
    "these members are read through the `panel` handle but are not declared on"
    + " Panel.qml's root as a property, a function or a signal. An undefined"
    + " member is not an error in a QML binding — it is `undefined`, so the"
    + " binding silently draws nothing and qmllint exits 0 on it:\n  "
    + unresolved.join("\n  "));
});

test("Panel.qml hands each extracted component the handle it requires", () => {
  const panelSource = fs.readFileSync(PANEL_QML, "utf8");

  for (const component of componentFiles()) {
    const name = component.label.replace(/\.qml$/, "");
    const at = instantiationLines(panelSource, name);
    assert.ok(at.length > 0,
      name + " declares a `panel` handle but Panel.qml never instantiates it —"
      + " an extracted component nothing draws is a file, not a component");
    // `panel: root` is what makes the handle the panel and not something else.
    // The `required` keyword is the real enforcement — Qt refuses to create the
    // component without it, which is a load error and not a blank list — so
    // this is the readable half of that guarantee rather than the load-bearing
    // one.
    for (const line of at) {
      const window = panelSource.split("\n").slice(line, line + 12).join("\n");
      assert.match(window, /\bpanel:\s*root\b/,
        "Panel.qml:" + (line + 1) + " instantiates " + name
        + " without handing it `panel: root`");
    }
  }
});

// AppStrip.qml is named here, and only here, because "the flat list is ONE
// component" is a claim about Panel.qml's structure rather than about the glob:
// a second AppStrip would be a second list drawing the same rows and reporting
// the same keys over the same IPC, and the payload would show one of them
// winning at random. The map's box is a Repeater delegate and is instantiated
// many times by design, which is why the count is asserted for this one only.
test("the flat list is exactly one AppStrip, and it declares the handle", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "AppStrip.qml"), "utf8");
  assert.ok(declaresPanel(source),
    "AppStrip.qml no longer declares a `panel` property — its whole interface"
    + " is that one handle (see the file's own header)");

  const panelSource = fs.readFileSync(PANEL_QML, "utf8");
  const at = instantiationLines(panelSource, "AppStrip");
  assert.strictEqual(at.length, 1,
    "expected exactly one AppStrip element in Panel.qml, found " + at.length
    + (at.length ? " (line(s) " + at.map((i) => i + 1).join(", ") + ")" : ""));
});

// ---------------------------------------------------------------------------
// Service.qml threads the planning context (epic 9i2, tick ubt).
//
// Every Engine.driftOf / Engine.planRestore call hands the engine the same
// context ({ workspaces, built }), because a call that forgets it silently
// plans as if every workspace mode were unknown. Read as text: node cannot
// instantiate QML.
test("Service.qml passes planContext() to every driftOf and planRestore call", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "Service.qml"), "utf8");
  const calls = codeLines(source).filter((l) => /Engine\.(driftOf|planRestore)\(/.test(l));
  assert.ok(calls.length >= 4, "expected at least four planner calls, found " + calls.length);
  for (const line of calls) {
    assert.match(line, /,\s*root\.planContext\(\)\)/, "missing planContext(): " + line.trim());
  }
});

test("Service.qml reads hyprctl workspaces in snapshot and clears builtWorkspaces", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "Service.qml"), "utf8");
  assert.match(source, /command: \["hyprctl", "workspaces", "-j"\]/);
  assert.match(source, /READ-FAILED hyprctl workspaces/);
  assert.match(source, /function planContext\(\) \{\s*return \{ workspaces: root\.liveWorkspaces, built: root\.builtWorkspaces \}/);
  const clears = source.match(/root\.builtWorkspaces = \(\{\}\)/g) || [];
  assert.ok(clears.length >= 2, "builtWorkspaces must be cleared at cycle start and with shapeAbandoned");
});
