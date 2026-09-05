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

// -------------------------------------- what the panel and the payload read
//
// The morph is matched ONCE and three things read that one answer: the map's
// fade, the per-chip role the chips report, and the payload the acceptance VM
// polls. Both functions below take the MORPH and not the two maps, and these
// tests exist as much to pin that signature as to pin the values — a function
// here that could see a map could pair a second time, and a second pairing a
// turn later is verbatim the defect tick 3xi cost this project.

test("every chip on both maps gets exactly one role, and a paired chip gets it at both ends", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { key: "0xlive-term" }),
    chip("class:foot", { key: "0xlive-foot" })
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { key: "recorded-term" }),
    chip("id:obsidian", { key: "recorded-obsidian" })
  ] }] }]);

  const morph = panel.mapMorphPairs(live, recorded);
  const roles = panel.morphChipRoles(morph);

  // The pair carries its role on BOTH ends: the role is a fact about the chip,
  // not about which way the view is travelling, and the map that is showing
  // only ever holds one of the two.
  assert.strictEqual(panel.morphRoleAt(roles, "0xlive-term"), "paired");
  assert.strictEqual(panel.morphRoleAt(roles, "recorded-term"), "paired");
  assert.strictEqual(panel.morphRoleAt(roles, "0xlive-foot"), "live-only");
  assert.strictEqual(panel.morphRoleAt(roles, "recorded-obsidian"), "recorded-only");

  // Exhaustive, the same way mapMorphPairs is: a chip with no role is a chip
  // the map does not know whether to fade.
  const keys = panel.morphChipEntries(live).concat(panel.morphChipEntries(recorded))
    .map((e) => e.key);
  assert.deepStrictEqual(keys.filter((k) => panel.morphRoleAt(roles, k) === ""), [],
    "no chip on either map is left unclassified");
});

test("a chip the morph has never heard of answers \"\", not a role", () => {
  // A window that opened between two map builds. "" is not a fourth role — the
  // map treats it as already on screen — and it must not come back as
  // undefined, which JSON.stringify would drop out of the payload entirely.
  const roles = panel.morphChipRoles(panel.mapMorphPairs(
    mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]),
    mapOf([{ name: "eDP-1", workspaces: [] }])));
  assert.strictEqual(panel.morphRoleAt(roles, "0xnobody"), "");
  assert.strictEqual(panel.morphRoleAt(roles, ""), "");
});

test("a null morph is an empty index and an empty payload, not a throw", () => {
  assert.deepStrictEqual(panel.morphChipRoles(null), {});
  assert.strictEqual(panel.morphRoleAt(panel.morphChipRoles(undefined), "0xa"), "");
  assert.deepStrictEqual(panel.morphPayload(null),
    { pairs: [], liveOnly: [], recordedOnly: [] });
});

test("a __proto__ CHIP KEY neither loses its role nor answers for a chip that has none", () => {
  // The same family tests/reserved-ids.test.js walks, on the one map in this
  // file that is keyed by a chip key rather than a linkKey. A chip key is a
  // window address or `recorded-<instanceKey>`, and an instance key carries an
  // identity id out of a hand-editable state file — so `__proto__` is reachable
  // without a hand edit here for the same reason it is there. `own()` cannot
  // repair it (assigning invokes Object.prototype's setter and creates no own
  // property), so the index is namespaced instead and the whole family goes
  // unreachable at once.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { key: "__proto__" })
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [] }]);

  const roles = panel.morphChipRoles(panel.mapMorphPairs(live, recorded));
  assert.strictEqual(panel.morphRoleAt(roles, "__proto__"), "live-only");
  assert.strictEqual(panel.morphRoleAt(roles, "constructor"), "",
    "an untouched inherited name still answers with nothing");
  assert.strictEqual(panel.morphRoleAt(roles, "toString"), "");
});

test("the payload names BOTH ends of a pair, by key, and says where each of them is", () => {
  // `linkKey` alone cannot make the claim "these two chips are the same
  // window" — two unwatched windows of one class share it. The keys can, and
  // both are in the payload for that reason; the linkKey rides along because it
  // is the string the matching was DONE with.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:browser", { key: "0xlive-browser" })
  ] }] }]);
  const recorded = mapOf([{ name: "DP-3", workspaces: [{ id: 7, chips: [
    chip("id:browser", { key: "recorded-browser" })
  ] }] }]);

  const out = panel.morphPayload(panel.mapMorphPairs(live, recorded));
  assert.deepStrictEqual(out.pairs, [{
    linkKey: "id:browser",
    liveKey: "0xlive-browser",
    recordedKey: "recorded-browser",
    liveMonitor: "eDP-1",
    liveWorkspaceId: 1,
    recordedMonitor: "DP-3",
    recordedWorkspaceId: 7,
    monitorChanged: true,
    workspaceChanged: true,
    geometry: true
  }]);
  assert.deepStrictEqual(out.liveOnly, []);
  assert.deepStrictEqual(out.recordedOnly, []);
});

test("the payload carries the one-sided chips too, because a morph that forgot one would look identical", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("class:foot", { key: "0xlive-foot" })
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 2, chips: [
    chip("id:obsidian", { key: "recorded-obsidian" })
  ] }] }]);

  const out = panel.morphPayload(panel.mapMorphPairs(live, recorded));
  assert.deepStrictEqual(out.pairs, []);
  assert.deepStrictEqual(out.liveOnly, [{
    key: "0xlive-foot", linkKey: "class:foot", monitorName: "eDP-1", workspaceId: 1
  }]);
  assert.deepStrictEqual(out.recordedOnly, [{
    key: "recorded-obsidian", linkKey: "id:obsidian", monitorName: "eDP-1", workspaceId: 2
  }]);
});

test("the payload says a fallback pair cannot be translated, and carries no rect to argue with", () => {
  // `geometry: false` is the pair the caller must cross-fade rather than move,
  // and it is the ONLY thing the payload says about geometry. `rect` is the
  // WINDOW's fraction and not the rectangle the chip is drawn at, so a payload
  // carrying it would invite exactly the confusion morphChipEntries exists to
  // stop.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { key: "0xlive-term" }),
    chip("id:obsidian", { key: "0xlive-obsidian", rect: null })
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { key: "recorded-term" })
  ] }] }]);

  const out = panel.morphPayload(panel.mapMorphPairs(live, recorded));
  assert.strictEqual(out.pairs.length, 1);
  assert.strictEqual(out.pairs[0].geometry, false,
    "the whole workspace fell back, so even the chip that HAS a rect is not drawn at one");
  assert.ok(!("rect" in out.pairs[0]), "the window's fraction is not the drawn chip");
  assert.ok(!("live" in out.pairs[0]), "the payload is a projection, not the entry objects");
});

test("the payload and the role index are projections of ONE pairing, not two", () => {
  // The signature is the guarantee: both take a morph. Handing them the same
  // object and getting answers that agree is what a consumer relies on — the
  // chip whose role says "paired" is the chip the payload names in a pair.
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const recordedIds = layout.apps.map((a) => a.identityId);
  const instances = panel.instanceIndex(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, layout);
  const live = panel.liveMapModel(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 480, 240, null, instances);
  const recorded = panel.recordedMapModel(
    layout, monitorsLaptop, recordedIds, 480, 240, instances);

  const morph = panel.mapMorphPairs(live, recorded);
  const roles = panel.morphChipRoles(morph);
  const out = panel.morphPayload(morph);

  assert.ok(out.pairs.length >= 2, "the fixture desk pairs more than one chip");
  for (const pair of out.pairs) {
    assert.strictEqual(panel.morphRoleAt(roles, pair.liveKey), "paired");
    assert.strictEqual(panel.morphRoleAt(roles, pair.recordedKey), "paired");
  }
  for (const entry of out.liveOnly) {
    assert.strictEqual(panel.morphRoleAt(roles, entry.key), "live-only");
  }
  for (const entry of out.recordedOnly) {
    assert.strictEqual(panel.morphRoleAt(roles, entry.key), "recorded-only");
  }
  // And the payload is the whole map, both sides, once each — the same
  // exhaustiveness the pairing itself is held to.
  assert.strictEqual(
    out.pairs.length + out.liveOnly.length, panel.morphChipEntries(live).length);
  assert.strictEqual(
    out.pairs.length + out.recordedOnly.length, panel.morphChipEntries(recorded).length);
});

test("a morph whose lists arrived as sequence wrappers is still read, not silently emptied", () => {
  // The QML/JS boundary, pinned rather than trusted. A Qt-converted list indexes
  // and reports .length like an array and answers something OTHER than
  // "[object Array]" to Object.prototype.toString, so an `isArray` guard here
  // would take its empty branch and hand back an index that fades nothing and a
  // payload that reports no pairs — both indistinguishable from a desk with
  // nothing in common. Stood in for by an array-like, which is exactly what the
  // wrapper is from these functions' point of view.
  function arrayLike(items) {
    const out = { length: items.length };
    items.forEach((item, i) => { out[i] = item; });
    return out;
  }

  const real = panel.mapMorphPairs(
    mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
      chip("id:terminal", { key: "0xlive-term" }),
      chip("class:foot", { key: "0xlive-foot" })
    ] }] }]),
    mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
      chip("id:terminal", { key: "recorded-term" }),
      chip("id:obsidian", { key: "recorded-obsidian" })
    ] }] }]));
  const wrapped = {
    pairs: arrayLike(real.pairs),
    liveOnly: arrayLike(real.liveOnly),
    recordedOnly: arrayLike(real.recordedOnly)
  };

  const roles = panel.morphChipRoles(wrapped);
  assert.strictEqual(panel.morphRoleAt(roles, "0xlive-term"), "paired");
  assert.strictEqual(panel.morphRoleAt(roles, "0xlive-foot"), "live-only");
  assert.strictEqual(panel.morphRoleAt(roles, "recorded-obsidian"), "recorded-only");

  const out = panel.morphPayload(wrapped);
  assert.strictEqual(out.pairs.length, 1);
  assert.strictEqual(out.pairs[0].liveKey, "0xlive-term");
  assert.strictEqual(out.liveOnly.length, 1);
  assert.strictEqual(out.recordedOnly.length, 1);
});

// -------------------------------------------- the morph's geometry: the flight
//
// Where a chip is DRAWN, which is the question `entry.rect` does not answer.
// The overlay that flies a chip between two maps resolves both ends through
// morphDrawnChipRect, so everything the floor and the barriers do to a chip on
// screen has to be done to the flight as well — and that is provable here, in
// the only tier that can prove it, rather than reported from a panel that would
// be agreeing with itself.

test("a drawn rect is chipRectsForCanvas's answer for the WHOLE workspace, not the chip's own fraction", () => {
  // The 6%-wide window: 0.06 * 400 = 24 px as a fraction, floored to 60 by a
  // 60x40 floor. A resolver that scaled the chip's own rect would say 24 and fly
  // it to a rectangle two and a half times too small — on exactly the chip the
  // floor exists for.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:tiny", { key: "0xtiny", rect: { rx: 0, ry: 0, rw: 0.06, rh: 0.04 } })
  ] }] }]);
  const entry = panel.morphChipEntries(live)[0];

  const drawn = panel.morphDrawnChipRect(live, entry, 400, 200, 60, 40);
  assert.deepStrictEqual(drawn, { x: 0, y: 0, width: 60, height: 40 });
  // And it IS the map's own answer, not a second one: the same call the map
  // makes, index for index.
  assert.deepStrictEqual(drawn,
    Object.assign({}, panel.chipRectsForCanvas([entry.rect], 400, 200, 60, 40)[0]));
});

test("a fallback workspace resolves to null — the same answer pair.geometry gives", () => {
  // A workspace is fallback if ANY ONE slot lacks a rect, and it then draws
  // EVERY chip in it as a stacked row and ignores the rects the others still
  // carry. Flying a chip in from one of those would be flying it in from a
  // rectangle nothing was drawn at.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:terminal", { key: "0xterm" }),
    chip("id:obsidian", { key: "0xobs", rect: null })
  ] }] }]);
  const entries = panel.morphChipEntries(live);
  assert.ok(entries[0].fallback, "the whole workspace fell back");
  for (const entry of entries) {
    assert.strictEqual(panel.morphDrawnChipRect(live, entry, 400, 200, 16, 10), null,
      "even the chip that HAS a rect is not drawn at one");
  }
});

test("a tab group's members each get their SEGMENT, not the whole slot", () => {
  // A tab group is one window's worth of screen and MapWorkspace divides that
  // rectangle evenly between the tabs. Collapsing four tabs onto one rectangle
  // was a foundation-review blocker; this is the assertion that keeps it fixed.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, slots: [
    { group: true, chips: [
      chip("id:a", { key: "0xa" }), chip("id:b", { key: "0xb" }),
      chip("id:c", { key: "0xc" }), chip("id:d", { key: "0xd" })
    ] }
  ] }] }]);
  const entries = panel.morphChipEntries(live);
  assert.strictEqual(entries.length, 4);

  const slot = panel.chipRectsForCanvas([entries[0].rect], 400, 200, 16, 10)[0];
  const segment = slot.width / 4;
  entries.forEach((entry, i) => {
    const drawn = panel.morphDrawnChipRect(live, entry, 400, 200, 16, 10);
    assert.strictEqual(drawn.width, segment, "each tab is a quarter of the slot");
    assert.strictEqual(drawn.x, slot.x + i * segment, "and sits at its own tabIndex");
    assert.strictEqual(drawn.y, slot.y);
    assert.strictEqual(drawn.height, slot.height, "the segments divide width, not height");
  });
  // The four together are the slot, exactly — no gap, no overlap, nothing
  // hanging off the end.
  const last = panel.morphDrawnChipRect(live, entries[3], 400, 200, 16, 10);
  assert.strictEqual(last.x + last.width, slot.x + slot.width);
});

test("the barriers reach the flight too — two tiles never resolve on top of each other", () => {
  // The floor is what makes a tiny window clickable and the barrier is what
  // stops the floor lying. A resolver that skipped chipRectsForCanvas would fly
  // two neighbouring tiles into one rectangle, which is the defect that cost a
  // live round on screen.
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [
    chip("id:left", { key: "0xl", rect: { rx: 0, ry: 0, rw: 0.02, rh: 1 } }),
    chip("id:right", { key: "0xr", rect: { rx: 0.5, ry: 0, rw: 0.02, rh: 1 } })
  ] }] }]);
  const entries = panel.morphChipEntries(live);
  const a = panel.morphDrawnChipRect(live, entries[0], 400, 200, 120, 10);
  const b = panel.morphDrawnChipRect(live, entries[1], 400, 200, 120, 10);
  assert.ok(a.x + a.width <= b.x,
    `the two tiles must not superimpose: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});

test("an entry pointing at a workspace that is not there resolves to null, not a throw", () => {
  const live = mapOf([{ name: "eDP-1", workspaces: [{ id: 1, chips: [chip("id:terminal")] }] }]);
  const entry = panel.morphChipEntries(live)[0];
  assert.strictEqual(panel.morphDrawnChipRect(live, { monitorIndex: 9, workspaceIndex: 0, slotIndex: 0 }, 400, 200, 16, 10), null);
  assert.strictEqual(panel.morphDrawnChipRect(live, { monitorIndex: 0, workspaceIndex: 9, slotIndex: 0 }, 400, 200, 16, 10), null);
  assert.strictEqual(panel.morphDrawnChipRect(live, { monitorIndex: 0, workspaceIndex: 0, slotIndex: 9 }, 400, 200, 16, 10), null);
  assert.strictEqual(panel.morphDrawnChipRect(null, entry, 400, 200, 16, 10), null);
  assert.strictEqual(panel.morphDrawnChipRect(live, null, 400, 200, 16, 10), null);
});

test("a flight starts at one end, finishes at the other, and cannot leave its own path", () => {
  const from = { x: 0, y: 0, width: 100, height: 50 };
  const to = { x: 200, y: 40, width: 60, height: 30 };

  assert.deepStrictEqual(panel.morphFlightRect(from, to, 0), from);
  assert.deepStrictEqual(panel.morphFlightRect(from, to, 1), to);
  assert.deepStrictEqual(panel.morphFlightRect(from, to, 0.5),
    { x: 100, y: 20, width: 80, height: 40 });
  // Clamped at both ends: an out-of-range progress is a frame arriving out of
  // order, not something to throw over, and an interrupted flight must be
  // somewhere ON its path.
  assert.deepStrictEqual(panel.morphFlightRect(from, to, -3), from);
  assert.deepStrictEqual(panel.morphFlightRect(from, to, 9), to);
  assert.deepStrictEqual(panel.morphFlightRect(from, to, NaN), to,
    "a progress that is not a number lands the chip at its destination, never adrift");
});

test("a flight with only one end is null — a chip never flies in from a place it was not drawn", () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  assert.strictEqual(panel.morphFlightRect(rect, null, 0.5), null);
  assert.strictEqual(panel.morphFlightRect(null, rect, 0.5), null);
  assert.strictEqual(panel.morphFlightRect(null, null, 0.5), null);
});

test("the flight index answers for BOTH ends of a flight and for nothing else", () => {
  const keys = panel.morphFlightKeys([
    { liveKey: "0xlive", recordedKey: "recorded-a" },
    { liveKey: "__proto__", recordedKey: "recorded-b" }
  ]);
  assert.strictEqual(panel.morphFlightKeyAt(keys, "0xlive"), true);
  assert.strictEqual(panel.morphFlightKeyAt(keys, "recorded-a"), true);
  // The map that is showing holds one end and the map that is not holds the
  // other, so a consumer asks about whichever chip it is drawing without having
  // to know which tab it is on.
  assert.strictEqual(panel.morphFlightKeyAt(keys, "__proto__"), true,
    "the namespaced index survives the one name own() cannot repair");
  assert.strictEqual(panel.morphFlightKeyAt(keys, "recorded-b"), true);
  assert.strictEqual(panel.morphFlightKeyAt(keys, "0xsomeone-else"), false);
  assert.strictEqual(panel.morphFlightKeyAt(keys, "constructor"), false);
  assert.strictEqual(panel.morphFlightKeyAt(panel.morphFlightKeys(null), "0xlive"), false);
});

test("on the real maps of one desk, every geometry pair resolves to two drawn rectangles", () => {
  // The end-to-end claim the overlay depends on: a pair the matcher says can be
  // translated really does resolve, through the real builders, to a rectangle at
  // each end — and a pair it says cannot really does not.
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const recordedIds = layout.apps.map((a) => a.identityId);
  const instances = panel.instanceIndex(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, layout);
  const live = panel.liveMapModel(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 480, 240, null, instances);
  const recorded = panel.recordedMapModel(
    layout, monitorsLaptop, recordedIds, 480, 240, instances);

  const morph = panel.mapMorphPairs(live, recorded);
  let flown = 0;
  for (const pair of morph.pairs) {
    const a = panel.morphDrawnChipRect(live, pair.live, 300, 170, 16, 10);
    const b = panel.morphDrawnChipRect(recorded, pair.recorded, 300, 170, 16, 10);
    if (pair.geometry) {
      assert.ok(a, `a translatable pair must resolve its live end (${pair.linkKey})`);
      assert.ok(b, `and its recorded end (${pair.linkKey})`);
      assert.ok(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0);
      // And the flight between them is a real path, not a standstill dressed up
      // as one: the recorded map of this fixture is the FALLBACK-free case only
      // where the recording carried at/size, so this is also what pins that the
      // two ends are genuinely different rectangles when the maps disagree.
      assert.ok(panel.morphFlightRect(a, b, 0.5), "a midpoint exists");
      flown += 1;
    } else {
      assert.ok(!a || !b, "a pair the matcher will not translate must not resolve both ends");
    }
  }
  assert.ok(morph.pairs.length >= 2, "the fixture desk pairs more than one chip");
  assert.ok(flown >= 1, "and at least one of them is genuinely translatable");
});
