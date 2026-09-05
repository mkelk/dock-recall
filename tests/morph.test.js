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
function mapOf(monitors) {
  return {
    monitors: monitors.map((m) => ({
      name: m.name,
      label: m.label || m.name,
      workspaces: (m.workspaces || []).map((w) => ({
        id: w.id,
        name: String(w.id),
        slots: (w.chips || []).map((c) => ({
          key: c.key || c.linkKey,
          group: false,
          rect: c.rect === undefined ? { x: 0, y: 0, width: 0.5, height: 0.5 } : c.rect,
          chips: [{
            linkKey: c.linkKey,
            key: c.key || c.linkKey,
            identityId: c.identityId || c.linkKey.replace(/^id:/, ""),
            occurrence: c.occurrence || 0,
            rect: c.rect === undefined ? { x: 0, y: 0, width: 0.5, height: 0.5 } : c.rect
          }]
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
function assertExhaustive(result, liveMap, recordedMap) {
  const liveCount = panel.morphChipEntries(liveMap).length;
  const recordedCount = panel.morphChipEntries(recordedMap).length;
  assert.strictEqual(result.pairs.length + result.liveOnly.length, liveCount,
    "every live chip is either paired or live-only");
  assert.strictEqual(result.pairs.length + result.recordedOnly.length, recordedCount,
    "every recorded chip is either paired or recorded-only");
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
    chip(first, { rect: { x: 0, y: 0, width: 0.4, height: 0.4 } }),
    chip(second, { rect: { x: 0.5, y: 0, width: 0.4, height: 0.4 } })
  ] }] }]);
  const recorded = mapOf([{ name: "eDP-1", workspaces: [{ id: 2, chips: [
    chip(second, { rect: { x: 0, y: 0.5, width: 0.4, height: 0.4 } }),
    chip(first, { rect: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 } })
  ] }] }]);

  const result = panel.mapMorphPairs(live, recorded);
  assert.strictEqual(result.pairs.length, 2);
  // Each pair joins the SAME instance on both sides, whatever order the maps
  // happened to draw them in.
  result.pairs.forEach((p) => {
    assert.strictEqual(p.live.linkKey, p.recorded.linkKey);
  });
  const moved = result.pairs.find((p) => p.linkKey === first);
  assert.deepStrictEqual(moved.live.rect, { x: 0, y: 0, width: 0.4, height: 0.4 });
  assert.deepStrictEqual(moved.recorded.rect, { x: 0.5, y: 0.5, width: 0.4, height: 0.4 });
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

  const live = panel.liveMapModel(
    clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 480, 240);
  const recorded = panel.recordedMapModel(layout, monitorsLaptop, recordedIds, 480, 240);

  const result = panel.mapMorphPairs(live, recorded);

  // The recording was taken from this very desk, so every recorded chip has a
  // live counterpart. That is the strongest statement this fixture can make and
  // it is exactly the one that breaks if the two maps ever stop agreeing on
  // linkKey — the failure this test exists to catch.
  assert.strictEqual(result.recordedOnly.length, 0,
    "a layout recorded from this desk left a recorded chip unmatched: "
    + result.recordedOnly.map((e) => e.linkKey).join(", "));
  assert.ok(result.pairs.length >= 2, "at least the recorded apps paired up");
  result.pairs.forEach((p) => {
    assert.ok(p.linkKey, "every pair is keyed");
    assert.strictEqual(p.monitorChanged, false, "nothing moved: one monitor, same desk");
  });
  assertExhaustive(result, live, recorded);

  // Live-only is allowed and expected — an unwatched window is on the live map
  // and in no recording. What matters is that it is ACCOUNTED for, which
  // assertExhaustive just checked.
});
