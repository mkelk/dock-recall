"use strict";
// The bar widget's host handle after the 2026-09-08 shell upgrade (tick erk).
//
// Before that shell, `bar.shell` was the shell root; since it, a third-party
// widget is handed a SCOPED plugin-shell API with summon/hide/toggle/serviceFor
// and WITHOUT isBarWidgetPanelPlugin or openPanelIds. The widget's guard once
// demanded isBarWidgetPanelPlugin and so refused every click on the new shell
// while the acceptance VM (old shell) stayed green. These scans pin the shape
// that is true on both contracts: the guard needs toggle and summon, treats
// the old recursion question as optional, and reads openness off the service
// flag the panel raises and lowers.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function block(src, startRe, endRe) {
  const start = src.search(startRe);
  assert.notStrictEqual(start, -1, "block start not found: " + startRe);
  const rest = src.slice(start);
  const end = rest.search(endRe);
  return end === -1 ? rest : rest.slice(0, end);
}

test("the bar widget routes when the host handle can toggle and summon", () => {
  const src = read("BarWidget.qml");
  const guard = block(src, /readonly property bool hostCanRoute:/, /\n\n/);
  assert.match(guard, /typeof root\.hostShell\.toggle === "function"/);
  assert.match(guard, /typeof root\.hostShell\.summon === "function"/);
});

test("the old recursion question is optional: asked only where it exists", () => {
  const src = read("BarWidget.qml");
  const routed = block(src, /readonly property bool panelRouted:/, /\n\n/);
  assert.match(routed, /root\.hostCanRoute/);
  assert.match(routed,
    /typeof root\.hostShell\.isBarWidgetPanelPlugin !== "function"\s*\|\|\s*root\.hostShell\.isBarWidgetPanelPlugin\(root\.moduleName\) === false/,
    "panelRouted must accept a handle WITHOUT isBarWidgetPanelPlugin and, where it exists, require it to answer false");
});

test("openness is read off the service flag, with the old map as the fallback", () => {
  const src = read("BarWidget.qml");
  const opened = block(src, /readonly property bool opened:/, /\n\n/);
  assert.match(opened, /root\.pluginService\.panelOpen === true/);
  assert.match(opened, /openPanelIds\[root\.moduleName\] === true/);
  const service = block(src, /readonly property var pluginService:/, /\n\n/);
  assert.match(service, /typeof root\.hostShell\.serviceFor === "function"/);
});

test("the service carries the flag and the panel raises and lowers it", () => {
  assert.match(read("Service.qml"), /^\s*property bool panelOpen: false\s*$/m);
  const panel = read("Panel.qml");
  assert.match(panel, /^\s*onServiceChanged: if \(root\.service\) root\.service\.panelOpen = true\s*$/m,
    "the open edge is the service ASSIGNMENT (the loader sets it after creation)");
  assert.match(panel, /^\s*Component\.onDestruction: if \(root\.service\) root\.service\.panelOpen = false\s*$/m,
    "the close edge is destruction (no keepLoaded: the panel is torn down on hide)");
});

test("a refused click says which half of the guard failed", () => {
  const src = read("BarWidget.qml");
  assert.strictEqual((src.match(/root\.routeRefusal\(\)/g) || []).length, 2, "both click paths log the reason");
  assert.doesNotMatch(src, /panel is not registered with the shell yet/, "the old one-size message hid the break");
});
