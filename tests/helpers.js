// Shared test helpers. Not a test file itself — `node --test tests/` only
// picks up `*.test.js`, so this is safe to sit alongside them.

const fs = require("node:fs");
const path = require("node:path");

const engine = require("../engine.js");

const FIXTURE_DIR = path.join(__dirname, "fixtures");

const FIXTURE_NAMES = [
  "clients-laptop.json",
  "monitors-laptop.json",
  "clients-laptop+headless.json",
  "monitors-laptop+headless.json"
];

function fixturePath(name) {
  return path.join(FIXTURE_DIR, name);
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(fixturePath(name), "utf8"));
}

// A realistic watched-app list for tests, ported from the RE_* regexes in
// ~/.config/omarchy/scripts/session-layout (the script this project replaces).
// Order is priority order: the Chromium webapp identities come before the
// plain `chromium` browser identity.
const IDENTITIES = [
  { id: "obsidian", patterns: ["(^|\\.)obsidian(\\.|$)"] },
  { id: "telegram", patterns: ["telegram"] },
  { id: "slack", patterns: ["^chrome-app\\.slack\\.com", "(^|[^a-z])slack"] },
  { id: "whatsapp", patterns: ["^chrome-web\\.whatsapp\\.com", "(^|[^a-z])whatsapp"] },
  { id: "gmail", patterns: ["^chrome-mail\\.google\\.com"] },
  { id: "gcal", patterns: ["^chrome-calendar\\.google\\.com"] },
  { id: "rtm", patterns: ["rememberthemilk"] },
  { id: "browser", patterns: ["^chromium$"] },
  { id: "editor", patterns: ["^code$"] },
  { id: "terminal", patterns: ["^foot$"] }
];

function identity(id) {
  const found = IDENTITIES.find((i) => i.id === id);
  if (!found) throw new Error("no test identity " + id);
  return found;
}

// A client shaped like the ones hyprctl emits. Used to synthesize the shapes
// the live desktop did not happen to have when the fixtures were captured —
// the captured JSON itself is never edited.
function makeClient(overrides) {
  const base = {
    address: "0x0",
    class: "unknown",
    initialClass: null,
    title: "",
    workspace: { id: 1, name: "1" },
    monitor: 0,
    at: [0, 0],
    size: [100, 100],
    floating: false,
    fullscreen: 0,
    grouped: [],
    pid: 1000
  };
  const client = Object.assign(base, overrides || {});
  if (client.initialClass === null) client.initialClass = client.class;
  if (typeof client.workspace === "number") {
    client.workspace = { id: client.workspace, name: String(client.workspace) };
  }
  return client;
}

// A synthesized scenario with a two-window tab group: `foot` and `chromium`
// grouped on workspace 2, plus an ungrouped `code` on workspace 3.
//
// Two deliberate traps: the tab order (foot, then chromium) is the reverse of
// the order hyprctl lists the clients in, and also the reverse of the priority
// order in IDENTITIES — so anything that reads the wrong order shows up.
function twoWindowGroupClients() {
  const tabOrder = ["0xaaa", "0xbbb"];
  const foot = makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: tabOrder });
  const chromium = makeClient({ address: "0xbbb", class: "chromium", workspace: 2, grouped: tabOrder });
  const code = makeClient({ address: "0xccc", class: "code", workspace: 3 });
  return [chromium, foot, code];
}

// The user's fourth gate-test desktop, reduced to what broke it: the SLACK
// identity matches TWO windows. A lone Slack window sits on workspace 9, and a
// second Slack window is tabbed into the messenger group on workspace 10 with
// Telegram and WhatsApp.
//
// The trap is the listing order — hyprctl lists the workspace 9 window FIRST,
// so "first matching window wins" chooses the one that is NOT in the group,
// while the group's own membership is read off the workspace 10 window. That
// produced the recorded group with indexes 0 and 2 and a slack entry claiming
// group: null.
const SLACK_CLASS = "chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1";
const WHATSAPP_CLASS = "chrome-web.whatsapp.com__-Profile_1";

function duplicateWindowGroupClients() {
  const tabs = ["0xtele", "0xslackgrouped", "0xwhats"];
  return [
    makeClient({ address: "0xslackalone", class: SLACK_CLASS, workspace: 9 }),
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xslackgrouped", class: SLACK_CLASS, workspace: 10, grouped: tabs }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10, grouped: tabs })
  ];
}

// Give every grouped client its own view of the tab ring, starting at itself —
// the shape hyprctl would report if `grouped` were rotated per member rather
// than shared. Live evidence says it is NOT (every member of a real group
// reports the same array), and this exists so the code that must not care can
// be shown not to.
function rotateGroupedPerMember(clients) {
  return clients.map((c) => {
    const at = (c.grouped || []).indexOf(c.address);
    if (at <= 0) return c;
    return Object.assign({}, c, {
      grouped: c.grouped.slice(at).concat(c.grouped.slice(0, at))
    });
  });
}

// The contract from the schema block in engine.js, in its schema-v3 form: for
// every recorded group, the indexes are 0..n-1 with no holes, and every
// (identityId, occurrence) TUPLE the groupId names carries that same groupId in
// its own entry.
//
// The tuple is what changed. A group holding two windows of one identity names
// it twice — "group:telegram+slack+slack#1" — so an entry is keyed by its
// member key, not by its identity id, and keying by the identity would silently
// let the second window overwrite the first and the check pass on half a group.
function assertGroupInvariant(assert, layout, what) {
  const label = what ? what + ": " : "";
  const byKey = {};
  for (const app of layout.apps) byKey[engine.memberKeyFor(app.identityId, app.occurrence)] = app;

  const seen = {};
  for (const app of layout.apps) {
    if (!app.group) continue;
    const groupId = app.group.groupId;
    if (!seen[groupId]) seen[groupId] = [];
    seen[groupId].push(app);
  }

  for (const groupId of Object.keys(seen)) {
    const named = groupId.replace(/^group:/, "").split("+");
    const indexes = seen[groupId].map((a) => a.group.index).sort((a, b) => a - b);

    assert.deepStrictEqual(
      indexes,
      named.map((_, i) => i),
      label + groupId + " must have indexes 0..n-1 with no holes"
    );
    assert.strictEqual(seen[groupId].length, named.length, label + groupId + " must record every member it names");

    named.forEach((memberKey, index) => {
      const entry = byKey[memberKey];
      assert.ok(entry, label + groupId + " names " + memberKey + ", which has no entry");
      assert.ok(entry.group, label + memberKey + " is named by " + groupId + " but recorded ungrouped");
      assert.strictEqual(entry.group.groupId, groupId, label + memberKey + " belongs to a different group");
      assert.strictEqual(entry.group.index, index, label + memberKey + " is recorded at the wrong index");
    });
  }
}

module.exports = {
  FIXTURE_DIR: FIXTURE_DIR,
  makeClient: makeClient,
  twoWindowGroupClients: twoWindowGroupClients,
  duplicateWindowGroupClients: duplicateWindowGroupClients,
  rotateGroupedPerMember: rotateGroupedPerMember,
  assertGroupInvariant: assertGroupInvariant,
  SLACK_CLASS: SLACK_CLASS,
  WHATSAPP_CLASS: WHATSAPP_CLASS,
  FIXTURE_NAMES: FIXTURE_NAMES,
  IDENTITIES: IDENTITIES,
  fixturePath: fixturePath,
  loadFixture: loadFixture,
  identity: identity
};
