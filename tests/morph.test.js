// The Live -> Recorded morph's pure half: which chips are the same thing on
// both maps, and where each of them sits on either side.
//
// What this file is for: the acceptance VM cannot show that anything moved on
// screen — it can only report that an animation was declared and bound. So the
// morph's real logic lives here, in a pure function, where it can be PROVEN
// rather than merely reported. Every awkward case the map can produce is a test
// below, because the ones that are easy to forget are exactly the ones a user
// with two monitors and a closed app hits first.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const panel = require("../PanelModel.js");
const { loadFixture, IDENTITIES } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const AT = "2026-09-05T08:00:00.000Z";

function resolver(identities) {
  return (client) => engine.matchClient(client, identities) || "";
}

// A map model reduced to the shape mapMorphPairs actually walks. Built by hand
// so a case can be stated in one place instead of reverse-engineered out of a
// fixture — but see the last test, which runs the real builders end to end so
// this shape cannot quietly stop matching the real one.
const RECT = { rx: 0, ry: 0, rw: 0.5, rh: 0.5 };

function mapOf(monitors) {
  return {
    monitors: monitors.map((m) => ({
      name: m.name,
      label: m.label || m.name,
      workspaces: (m.workspaces || []).map((w) => ({
        id: w.id,
        name: String(w.id),
        // A workspace is fallback when ANY ONE of its slots lacks a rect — the
        // others keep theirs and are still drawn stacked. That asymmetry is the
        // whole of blocker 1.
        fallback: w.fallback === true || (w.chips || []).some((c) => c.rect === null),
        slots: (w.slots || (w.chips || []).map((c) => ({ group: false, chips: [c] }))).map((s) => ({
          key: s.chips[0].key || s.chips[0].linkKey,
          group: s.group === true,
          rect: s.chips[0].rect === undefined ? RECT : s.chips[0].rect,
          chips: s.chips.map((c, i) => ({
            linkKey: c.linkKey,
            key: c.key || c.linkKey,
            identityId: c.identityId || c.linkKey.replace(/^id:/, ""),
            occurrence: c.occurrence || 0,
            tabIndex: s.group === true ? i : 0,
            groupSize: s.group === true ? s.chips.length : 1,
            rect: c.rect === undefined ? RECT : c.rect
          }))
        }))
      }))
    }))
  };
}

function chip(linkKey, extra) {
  return Object.assign({ linkKey }, extra || {});
}

// Every chip on either map must land in exactly one of the three answers. This
// is the property that makes the morph safe: a chip that belongs to none of them
// is a chip the animation forgets on screen, and nothing else in the pipeline
// would notice.
//
// MULTISETS, NOT LENGTHS. This compared counts until the foundation review
// proved that useless: a run that DROPS one chip and DUPLICATES another passes
// a length check, because the two numbers still match — which is exactly what
// the `__proto__` bucket key did. Comparing the chips themselves is what makes
// this assertion load-bearing rather than decorative.
function identify(entry) {
  return [entry.monitorName, entry.workspaceId, entry.slotIndex, entry.chipIndex, entry.key]
    .join("|");
}

function assertExhaustive(result, liveMap, recordedMap) {
  const sorted = (list) => list.map(identify).sort();
  assert.deepStrictEqual(
    sorted(result.pairs.map((p) => p.live).concat(result.liveOnly)),
    sorted(panel.morphChipEntries(liveMap)),
    "every live chip appears exactly once, as a pair or as live-only");
  assert.deepStrictEqual(
    sorted(result.pairs.map((p) => p.recorded).concat(result.recordedOnly)),
    sorted(panel.morphChipEntries(recordedMap)),
    "every recorded chip appears exactly once, as a pair or as recorded-only");
}

// ------------------------------------------------------------- the plain case

test("a chip on both maps is one pair, and carries both its ends", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 1);
  assert.strictEqual(result.pairs[0].linkKey, "id:terminal");
  assert.strictEqual(result.pairs[0].live.monitorName, "eDP-1");
  assert.strictEqual(result.pairs[0].recorded.monitorName, "eDP-1");
  assert.strictEqual(result.pairs[0].monitorChanged, false);
  assert.strictEqual(result.pairs[0].workspaceChanged, false);
  assert.strictEqual(result.pairs[0].geometry, true);
  assertExhaustive(result, live, recorded);
});

// ------------------------------------------- the same app, somewhere else

test("an app on both maps but a DIFFERENT MONITOR still morphs, and says it crosses", () => {
  // The case this whole plugin exists for: recorded on the dock, running on the
  // laptop screen. It is a pair — the same window, in the wrong place — and the
  // animation has to travel further than the map is wide.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:browser")] }] }]);
  const recorded = mapOf([{ name: "DP-3", workspaces: [{ id: 7, chips: [chip("id:browser")] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 1);
  assert.strictEqual(result.pairs[0].monitorChanged, true);
  assert.strictEqual(result.pairs[0].workspaceChanged, true);
  assert.strictEqual(result.pairs[0].live.monitorName, "eDP-1");
  assert.strictEqual(result.pairs[0].recorded.monitorName, "DP-3");
  assertExhaustive(result, live, recorded);
});

test("the same monitor and a different workspace is a workspace change, not a monitor one", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 4, chips: [chip("id:terminal")] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs[0].monitorChanged, false);
  assert.strictEqual(result.pairs[0].workspaceChanged, true);
});

// ------------------------------------------------------ one-sided chips

test("an app recorded but NOT RUNNING is recorded-only, and is not silently dropped", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal"), chip("id:obsidian")
  ] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 1);
  assert.deepStrictEqual(result.recordedOnly.map((e) => e.linkKey), ["id:obsidian"]);
  assert.strictEqual(result.liveOnly.length, 0);
  assertExhaustive(result, live, recorded);
});

test("an app running but NOT RECORDED is live-only", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal"), chip("class:chromium")
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 1);
  assert.deepStrictEqual(result.liveOnly.map((e) => e.linkKey), ["class:chromium"]);
  assert.strictEqual(result.recordedOnly.length, 0);
  assertExhaustive(result, live, recorded);
});

// -------------------------------------------------------- two of one app

test("two instances of one identity are told apart the way the rest of the panel tells them apart", () => {
  // instanceLinkKeyFor folds the occurrence into the key once an identity has
  // more than one instance. The morph does not re-derive that: it matches on the
  // string, so occurrence 0 pairs with occurrence 0 and never with occurrence 1.
  const first = panel.instanceLinkKeyFor("terminal", "", 0, 2);
  const second = panel.instanceLinkKeyFor("terminal", "", 1, 2);
  assert.notStrictEqual(first, second, "the panel's own key distinguishes two instances");

  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip(first, { rect: { rx: 0, ry: 0, rw: 0.4, rh: 0.4 } }),
    chip(second, { rect: { rx: 0.5, ry: 0, rw: 0.4, rh: 0.4 } })
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 2, chips: [
    chip(second, { rect: { rx: 0, ry: 0.5, rw: 0.4, rh: 0.4 } }),
    chip(first, { rect: { rx: 0.5, ry: 0.5, rw: 0.4, rh: 0.4 } })
  ] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 2);
  // Each pair joins the SAME instance on both sides, whatever order the maps
  // happened to draw them in.
  result.pairs.forEach((p) => {
    assert.strictEqual(p.live.linkKey, p.recorded.linkKey);
  });
  const moved = result.pairs.find((p) => p.linkKey === first);
  assert.deepStrictEqual(moved.live.rect, { rx: 0, ry: 0, rw: 0.4, rh: 0.4 });
  assert.deepStrictEqual(moved.recorded.rect, { rx: 0.5, ry: 0.5, rw: 0.4, rh: 0.4 });
  assertExhaustive(result, live, recorded);
});

test("a repeated linkKey degrades to a surplus rather than dropping or double-pairing a chip", () => {
  // A linkKey should be unique within one map. "Should" is not something to
  // build an animation on, so the surplus falls out to the one-sided list and
  // the arithmetic still adds up.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal"), chip("id:terminal")
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 1);
  assert.strictEqual(result.liveOnly.length, 1);
  assertExhaustive(result, live, recorded);
});

// ----------------------------------------------------- workspaces and geometry

test("a workspace that exists on one side only leaves its chips one-sided", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [
    { id: 1, chips: [chip("id:terminal")] },
    { id: 9, chips: [chip("id:obsidian")] }
  ] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.deepStrictEqual(result.liveOnly.map((e) => e.workspaceId), [9]);
  assertExhaustive(result, live, recorded);
});

test("a chip with no rect is still a pair, but one the caller must cross-fade", () => {
  // A v1 recording knows an app was on a desk but not where inside it, so its
  // whole workspace drops to the stacked layout and no chip in it has geometry.
  // That is a real state and the morph has to say so rather than animate to
  // nowhere.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { rect: null })
  ] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 1);
  assert.strictEqual(result.pairs[0].geometry, false,
    "a pair with only one end's geometry cannot be translated");
  assert.strictEqual(result.pairs[0].recorded.rect, null);
});

// ------------------------------------------------------------- empty maps

test("both maps empty is three empty answers, not a throw", () => {
  const result = panel.mapMorphPairs(mapOf([]), mapOf([]));
  assert.deepStrictEqual(result, { pairs: [], liveOnly: [], recordedOnly: [] });
});

test("one map empty puts every chip on the other side, and nothing pairs", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal"), chip("id:obsidian")
  ] }] }]);
  const empty = mapOf([]);

  const forward = panel.mapMorphPairs(live, empty);
  assert.strictEqual(forward.pairs.length, 0);
  assert.strictEqual(forward.liveOnly.length, 2);
  assertExhaustive(forward, live, empty);

  const backward = panel.mapMorphPairs(empty, live);
  assert.strictEqual(backward.pairs.length, 0);
  assert.strictEqual(backward.recordedOnly.length, 2);
  assertExhaustive(backward, empty, live);
});

test("a null or malformed map is empty, not a crash", () => {
  assert.deepStrictEqual(panel.mapMorphPairs(null, null),
    { pairs: [], liveOnly: [], recordedOnly: [] });
  assert.deepStrictEqual(panel.morphChipEntries({}), []);
  assert.deepStrictEqual(panel.morphChipEntries({ monitors: [{ name: "eDP-1" }] }), []);
});

// ------------------------------------------- against the REAL map builders
//
// Everything above states its case in a hand-built shape, which is clear but
// proves only that the function walks the shape THIS FILE believes in. This one
// runs liveMapModel and recordedMapModel for real, so the day either builder
// changes the shape of a chip, a slot or a workspace, this fails here rather
// than on somebody's screen.

test("the real live and recorded maps of one desk pair up chip for chip", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const recordedIds = layout.apps.map((a) => a.identityId);
  assert.ok(recordedIds.length >= 2, "the fixture records more than one app");

  // THE INSTANCE INDEX IS BUILT ONCE AND SHARED, because that is what
  // production does: Panel.qml builds it and hands it to all three models
  // precisely so a row, a live chip and a recorded chip cannot spell one
  // instance's key differently. Letting each builder make its own here would
  // pin a different property than the one that ships — a shared
  // recorded-or-running index can raise `instances`, which turns a bare
  // `id:<app>` into an occurrence-qualified key on the live side.
  const instances = panel.instanceIndex(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, layout);
  const live = panel.liveMapModel(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 480, 240, null, instances);
  const recorded = panel.recordedMapModel(
    layout, monitorsLaptop, recordedIds, 480, 240, instances);

  const result = panel.mapMorphPairs(live, recorded);

  // The recording was taken from this very desk, so every recorded chip has a
  // live counterpart. That is the strongest statement this fixture can make and
  // it is exactly the one that breaks if the two maps ever stop agreeing on
  // linkKey — the failure this test exists to catch. It cannot pass vacuously:
  // the pair count below forbids the "recorded map came out empty" escape.
  assert.strictEqual(result.recordedOnly.length, 0,
    "a layout recorded from this desk left a recorded chip unmatched: "
    + result.recordedOnly.map((e) => e.linkKey).join(", "));
  assert.ok(result.pairs.length >= 2, "at least the recorded apps paired up");
  result.pairs.forEach((p) => {
    assert.ok(p.linkKey, "every pair is keyed");
    assert.ok(p.live.key && p.recorded.key, "and every end has its unique handle");
  });
  assertExhaustive(result, live, recorded);

  // `monitorChanged` is deliberately NOT asserted here: this fixture has one
  // monitor and both maps iterate the same mapGeometry boxes, so false is
  // structurally guaranteed and would be an assertion that cannot fail. The
  // cross-monitor case is pinned above, on a map built to have two.

  // THE TAB GROUP, which only the real builders produce. The fixture has a
  // group on one workspace, and it is the case finding 3 was about: every
  // member shares the slot's rectangle, so the segment index is the only thing
  // that can tell them apart on screen.
  // Asserted unconditionally, not behind an `if`: this fixture HAS a group, and
  // a guarded assertion is one that goes quiet the day the fixture changes —
  // which is precisely when somebody needs to be told.
  const grouped = result.pairs.filter((p) => p.live.group);
  assert.ok(grouped.length > 1, "the fixture's tab group reached the morph as a group");
  const sizes = grouped.map((p) => p.live.groupSize);
  assert.ok(sizes.every((n) => n === grouped.length),
    "every member reports the group's real size");
  assert.deepStrictEqual(grouped.map((p) => p.live.tabIndex).sort(),
    grouped.map((_, i) => i),
    "and the members occupy consecutive segments of the one pill");
  const groupRects = grouped.map((p) => JSON.stringify(p.live.rect));
  assert.strictEqual(new Set(groupRects).size, 1,
    "a tab group is one window's worth of screen, so its members share a rectangle");

  // Live-only is allowed and expected — an unwatched window is on the live map
  // and in no recording. What matters is that it is ACCOUNTED for, which
  // assertExhaustive just checked.
});

// ------------------------------------- what the foundation review found (jpu)
//
// Three separate things made `geometry: true` a promise the contract could not
// keep, and each of them is a case a Motion consumer meets on its first day.

test("a FALLBACK workspace cannot be translated, even for the chips that do have rects", () => {
  // The trap: a workspace is fallback if ANY ONE of its slots lacks a rect, and
  // MapWorkspace then draws EVERY chip in it as a stacked row — rect ignored,
  // including the perfectly good rects the other chips still carry. Before this
  // clause the morph flew half a workspace in from rectangles nothing was ever
  // drawn at while the other half cross-faded correctly.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal"),                 // a good rect
    chip("id:obsidian", { rect: null })  // the one that drops the whole workspace
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal"), chip("id:obsidian")
  ] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  const terminal = result.pairs.find((p) => p.linkKey === "id:terminal");
  assert.ok(terminal.live.rect, "the chip does still carry a rect");
  assert.strictEqual(terminal.live.fallback, true, "but its workspace draws stacked");
  assert.strictEqual(terminal.geometry, false,
    "a chip on a stacked workspace must cross-fade, whatever rect it carries");
  assertExhaustive(result, live, recorded);
});

test("a tab group's members are told apart, and know they share one rectangle", () => {
  // slotsForClients' own rule: a tab group is ONE window's worth of screen
  // however many tabs are in it. Every member therefore carries the SAME slot
  // rect and is drawn as a segment of it, so without tabIndex and groupSize a
  // consumer collapses the whole group onto one rectangle.
  const group = {
    group: true,
    chips: [chip("id:obsidian"), chip("id:telegram"), chip("id:slack")]
  };
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, slots: [group] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, slots: [group] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 3);
  result.pairs.forEach((p) => {
    assert.strictEqual(p.live.group, true, "each member knows it is a tab");
    assert.strictEqual(p.live.groupSize, 3, "and how many segments the pill has");
  });
  assert.deepStrictEqual(result.pairs.map((p) => p.live.tabIndex).sort(), [0, 1, 2],
    "each member knows WHICH segment it is");
  // All three share the slot's rectangle, which is exactly why the index above
  // is the only thing that can tell them apart on screen.
  const rects = result.pairs.map((p) => JSON.stringify(p.live.rect));
  assert.strictEqual(new Set(rects).size, 1, "one rectangle, divided");
  assertExhaustive(result, live, recorded);
});

test("every entry carries its address in the map, so nobody walks it twice", () => {
  // `rect` is the WINDOW's fraction, not the drawn chip: chipRectsForCanvas
  // applies a 16x10 floor and anti-superimposition barriers over the whole
  // workspace before anything reaches the screen. A consumer therefore has to
  // resolve the drawn rectangle through that function, which needs the slot
  // index — and re-deriving it by searching the map is the class of defect
  // tick 3xi already cost this project.
  const live = mapOf([{ name: "eDP-1", workspaces: [
    { id: 1, chips: [chip("id:terminal")] },
    { id: 2, chips: [chip("id:obsidian")] }
  ] }]);
  const entries = panel.morphChipEntries(live);
  assert.deepStrictEqual(
    entries.map((e) => [e.monitorIndex, e.workspaceIndex, e.slotIndex, e.chipIndex]),
    [[0, 0, 0, 0], [0, 1, 0, 0]]);
});

test("a __proto__ linkKey neither drops a chip nor duplicates one", () => {
  // own() repairs constructor, toString, valueOf and hasOwnProperty; __proto__
  // is the one member of the family it cannot, because assigning to it invokes
  // Object.prototype's setter and creates no own property at all. Unreachable
  // through the real builders today — every production linkKey is prefixed —
  // but morphChipEntries reads whatever map it is handed, and the standing rule
  // in tests/reserved-ids.test.js is that a new identity-keyed map belongs in
  // that suite. The bucket key is namespaced, which makes the whole family
  // unreachable rather than repairing one name.
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("__proto__", { key: "proto-a" }), chip("__proto__", { key: "proto-b" })
  ] }] }]);
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.deepStrictEqual(result.recordedOnly.map((e) => e.key).sort(), ["proto-a", "proto-b"],
    "both chips survive, and neither is duplicated");
  assertExhaustive(result, live, recorded);
});

test("the rect handed out is a copy, not the one the panel is drawing from", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);
  const source = live.monitors[0].workspaces[0].slots[0].chips[0].rect;
  const entry = panel.morphChipEntries(live)[0];

  assert.notStrictEqual(entry.rect, source, "a consumer must not be able to reach the map");
  entry.rect.rx = 999;
  assert.strictEqual(source.rx, 0, "and writing to it cannot corrupt what is on screen");
});
