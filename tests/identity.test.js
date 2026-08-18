// App identity matching.
// Source of truth: docs/thoughts/2026-08-15-inspiration-and-design-sketch.md
// ("What to record").

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const { loadFixture, IDENTITIES, identity } = require("./helpers.js");

const clients = loadFixture("clients-laptop.json");

function clientWithClass(cls, initialClass) {
  return {
    address: "0xdeadbeef",
    class: cls,
    initialClass: initialClass === undefined ? cls : initialClass,
    workspace: { id: 1, name: "1" },
    monitor: 0,
    floating: false,
    grouped: []
  };
}

function fixtureClient(cls) {
  const found = clients.find((c) => c.class === cls);
  assert.ok(found, "fixture has no client with class " + cls);
  return found;
}

test("every real fixture class maps to the identity it should", () => {
  const expected = {
    "md.obsidian.Obsidian": "obsidian",
    "org.telegram.desktop": "telegram",
    "chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1": "slack",
    "chrome-web.whatsapp.com__-Profile_1": "whatsapp",
    "chrome-mail.google.com__mail_u_0_-Profile_1": "gmail",
    "chrome-calendar.google.com__calendar_u_0_r-Profile_1": "gcal",
    "chrome-www.rememberthemilk.com__app_-Profile_1": "rtm",
    chromium: "browser",
    code: "editor",
    foot: "terminal"
  };

  for (const cls of Object.keys(expected)) {
    assert.strictEqual(
      engine.matchClient(fixtureClient(cls), IDENTITIES),
      expected[cls],
      cls + " matched the wrong identity"
    );
  }
});

test("one identity covers Obsidian's class rename", () => {
  const obsidian = identity("obsidian");

  // Quattro's spelling (the one in the fixture) and the older bare one.
  assert.ok(engine.clientMatchesIdentity(clientWithClass("md.obsidian.Obsidian"), obsidian));
  assert.ok(engine.clientMatchesIdentity(clientWithClass("obsidian"), obsidian));
  assert.ok(engine.clientMatchesIdentity(clientWithClass("Obsidian"), obsidian));

  // But not a lookalike that merely contains the word.
  assert.ok(!engine.clientMatchesIdentity(clientWithClass("obsidiansomething"), obsidian));
});

test("a prefix pattern matches Chromium webapp synthesized classes", () => {
  const slack = identity("slack");

  // Different profile and channel in the synthesized tail — still Slack.
  assert.ok(
    engine.clientMatchesIdentity(
      clientWithClass("chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1"),
      slack
    )
  );
  assert.ok(
    engine.clientMatchesIdentity(
      clientWithClass("chrome-app.slack.com__client_TZZZZZZZZZ_C99999999-Profile_3"),
      slack
    )
  );
  // And the native desktop app, via the second pattern.
  assert.ok(engine.clientMatchesIdentity(clientWithClass("Slack"), slack));
});

test("matching is case-insensitive", () => {
  assert.strictEqual(engine.matchClient(clientWithClass("CHROMIUM"), IDENTITIES), "browser");
  assert.strictEqual(engine.matchClient(clientWithClass("Code"), IDENTITIES), "editor");
  assert.strictEqual(
    engine.matchClient(clientWithClass("CHROME-APP.SLACK.COM__client-Profile_1"), IDENTITIES),
    "slack"
  );
});

test("both class and initialClass are consulted", () => {
  // Renamed after launch: only initialClass still carries the identity.
  assert.strictEqual(
    engine.matchClient(clientWithClass("something-else", "md.obsidian.Obsidian"), IDENTITIES),
    "obsidian"
  );
  // The other way round: class is current, initialClass is stale.
  assert.strictEqual(
    engine.matchClient(clientWithClass("md.obsidian.Obsidian", "something-else"), IDENTITIES),
    "obsidian"
  );
  // Missing / empty fields are not a crash.
  assert.strictEqual(engine.matchClient(clientWithClass("", ""), IDENTITIES), null);
  assert.strictEqual(engine.matchClient({}, IDENTITIES), null);
  assert.strictEqual(engine.matchClient(null, IDENTITIES), null);
});

test("a client nobody watches matches nothing", () => {
  assert.strictEqual(engine.matchClient(clientWithClass("org.gnome.Nautilus"), IDENTITIES), null);
  assert.strictEqual(engine.matchClient(fixtureClient("chromium"), []), null);
  assert.strictEqual(engine.matchClient(fixtureClient("chromium"), null), null);
});

test("identity order is priority order", () => {
  const webappFirst = [
    { id: "gmail", patterns: ["^chrome-mail\\.google\\.com"] },
    { id: "anything-chrome", patterns: ["^chrome"] }
  ];
  const gmailClient = fixtureClient("chrome-mail.google.com__mail_u_0_-Profile_1");

  assert.strictEqual(engine.matchClient(gmailClient, webappFirst), "gmail");
  assert.strictEqual(engine.matchClient(gmailClient, webappFirst.slice().reverse()), "anything-chrome");
});

test("a broken pattern never matches and never throws", () => {
  const broken = { id: "broken", patterns: ["([unclosed"] };
  assert.strictEqual(engine.clientMatchesIdentity(clientWithClass("anything"), broken), false);

  // A good pattern alongside a broken one still works.
  const mixed = { id: "mixed", patterns: ["([unclosed", "^chromium$"] };
  assert.ok(engine.clientMatchesIdentity(clientWithClass("chromium"), mixed));

  // So do empty / absent pattern lists.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithClass("chromium"), { id: "x" }), false);
  assert.strictEqual(engine.clientMatchesIdentity(clientWithClass("chromium"), null), false);
});

test("firstClientFor returns the first matching window in hyprctl order", () => {
  // Two foot windows are open in the fixture; the first one wins.
  const feet = clients.filter((c) => c.class === "foot");
  assert.strictEqual(feet.length, 2);
  assert.strictEqual(engine.firstClientFor(clients, identity("terminal")).address, feet[0].address);

  // Same for the two Gmail windows.
  const mails = clients.filter((c) => c.class.startsWith("chrome-mail.google.com"));
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(engine.firstClientFor(clients, identity("gmail")).address, mails[0].address);
});

test("firstClientFor returns null when the app is not running", () => {
  const notRunning = { id: "spotify", patterns: ["^spotify$"] };
  assert.strictEqual(engine.firstClientFor(clients, notRunning), null);
  assert.strictEqual(engine.firstClientFor([], identity("browser")), null);
  assert.strictEqual(engine.firstClientFor(null, identity("browser")), null);
});

// ---------------------------------------------------------------------------
// Title identity: matching on initialTitle
// ---------------------------------------------------------------------------
//
// A TUI app in a plain terminal has the terminal's class (`foot`), like every
// other terminal, so class patterns cannot tell them apart. `foot --title=herdr`
// fixes `initialTitle` at map time while `class` stays `foot`. These identities
// are built here rather than in tests/helpers.js on purpose: IDENTITIES is
// shared by a dozen test files and already contains a `^foot$` terminal.

function clientWithTitle(cls, initialTitle, title) {
  return {
    address: "0xdeadbeef",
    class: cls,
    initialClass: cls,
    initialTitle: initialTitle,
    title: title === undefined ? initialTitle : title,
    workspace: { id: 1, name: "1" },
    monitor: 0,
    floating: false,
    grouped: []
  };
}

const HERDR = { id: "herdr", titlePatterns: ["^herdr$"] };

test("titlePatterns match a client's initialTitle", () => {
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), HERDR));
  assert.strictEqual(engine.matchClient(clientWithTitle("foot", "herdr"), [HERDR]), "herdr");

  // A plain terminal of the same class is not herdr.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "foot"), HERDR), false);
  assert.strictEqual(engine.matchClient(clientWithTitle("foot", "foot"), [HERDR]), null);

  // Missing / empty initialTitle is not a crash and not a match.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", ""), HERDR), false);
  assert.strictEqual(engine.clientMatchesIdentity(clientWithClass("foot"), HERDR), false);
});

test("the live title never decides which identity a client matches", () => {
  // Same window, two live titles: an app that renames itself moves only `title`.
  const asMapped = clientWithTitle("foot", "herdr", "herdr");
  const renamed = clientWithTitle("foot", "herdr", "herdr — some file — 3 panes");

  assert.strictEqual(engine.matchClient(asMapped, [HERDR]), "herdr");
  assert.strictEqual(engine.matchClient(renamed, [HERDR]), "herdr");

  // And a live title that merely looks like the identity is not enough.
  const pretender = clientWithTitle("foot", "foot", "herdr");
  assert.strictEqual(engine.matchClient(pretender, [HERDR]), null);
});

test("titlePatterns are never matched against class or initialClass", () => {
  const byTitle = { id: "footish", titlePatterns: ["^foot$"] };
  // class and initialClass are both "foot", but initialTitle is not.
  assert.strictEqual(
    engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), byTitle),
    false
  );
});

test("a class-pattern identity never claims a window by its title", () => {
  // The regression guard: adding initialTitle to the existing `patterns` fields
  // would let every current class pattern start claiming windows by title.
  const terminalNamedObsidian = clientWithTitle("foot", "obsidian", "obsidian");

  assert.strictEqual(
    engine.clientMatchesIdentity(terminalNamedObsidian, identity("obsidian")),
    false
  );
  assert.strictEqual(engine.matchClient(terminalNamedObsidian, IDENTITIES), "terminal");
});

test("a broken titlePattern never matches and never throws", () => {
  const broken = { id: "broken", titlePatterns: ["([unclosed"] };
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), broken), false);

  const mixed = { id: "mixed", titlePatterns: ["([unclosed", "^herdr$"] };
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), mixed));
});

test("an identity may carry both patterns and titlePatterns", () => {
  const both = { id: "either", patterns: ["^md\\.obsidian\\."], titlePatterns: ["^herdr$"] };
  assert.ok(engine.clientMatchesIdentity(clientWithClass("md.obsidian.Obsidian"), both));
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), both));
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "foot"), both), false);
});

test("identity order decides between a class identity and a title identity", () => {
  // A `foot --title=herdr` window satisfies BOTH: class ^foot$ and title ^herdr$.
  const herdrWindow = clientWithTitle("foot", "herdr");
  const terminal = { id: "terminal", patterns: ["^foot$"] };

  // Title identity first: it wins, which is the ordering the record needs —
  // specific title identities must sit BEFORE the catch-all terminal identity.
  assert.strictEqual(engine.matchClient(herdrWindow, [HERDR, terminal]), "herdr");
  // Terminal first: the terminal swallows it. matchClient is first-match-wins.
  assert.strictEqual(engine.matchClient(herdrWindow, [terminal, HERDR]), "terminal");
});
