// App identity matching.
// Source of truth: the identity-contract comment block in engine.js — the one
// above compilePattern / clientMatchesIdentity, which states the two-list rule.
// Its class-matching half goes back to
// docs/thoughts/2026-08-15-inspiration-and-design-sketch.md ("What to record"),
// which predates title matching and never mentions it.

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

  // A list of nothing but broken patterns is still a CONSTRAINT — it is not
  // empty — so it can never be satisfied and the identity never matches, even
  // when the other side would.
  const brokenTitleSide = { id: "andy", patterns: ["^foot$"], titlePatterns: ["([unclosed"] };
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), brokenTitleSide), false);
});

// ---------------------------------------------------------------------------
// The two lists together: AND when both are present
// ---------------------------------------------------------------------------
//
// An EMPTY list means "no constraint on this axis"; a NON-EMPTY one is a
// constraint that has to be satisfied. Four rows, one test each. AND rather
// than OR because `{patterns: ["^foot$"], titlePatterns: ["^herdr$"]}` is what
// a person writes to mean "the foot window titled herdr" — under OR it would
// claim EVERY foot window instead.

test("both lists non-empty: BOTH sides must match", () => {
  const titledFoot = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };

  // Class and title both satisfied — the window the identity was written for.
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), titledFoot));
  assert.strictEqual(engine.matchClient(clientWithTitle("foot", "herdr"), [titledFoot]), "herdr");

  // Class matches, title does not: a plain foot terminal is NOT claimed. This
  // is the whole point of the rule; under OR every terminal would be herdr.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "foot"), titledFoot), false);
  assert.strictEqual(engine.matchClient(clientWithTitle("foot", "foot"), [titledFoot]), null);

  // Title matches, class does not: herdr in some other terminal is not this one.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("Alacritty", "herdr"), titledFoot), false);

  // Neither side.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("Alacritty", "top"), titledFoot), false);

  // The consequence worth stating out loud: no usable initialTitle means the
  // title side fails, so the identity does not match at all — a satisfied class
  // side cannot rescue it.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", ""), titledFoot), false);
  assert.strictEqual(engine.clientMatchesIdentity(clientWithClass("foot"), titledFoot), false);
});

test("patterns non-empty, titlePatterns empty: the class side decides alone", () => {
  const byClass = { id: "terminal", patterns: ["^foot$"], titlePatterns: [] };

  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), byClass));
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "anything at all"), byClass));
  // Including a client with no initialTitle at all: an empty title list is no
  // constraint, so there is nothing to fail.
  assert.ok(engine.clientMatchesIdentity(clientWithClass("foot"), byClass));

  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("Alacritty", "herdr"), byClass), false);

  // An absent key reads exactly like an empty list — every pre-v4 identity.
  assert.ok(engine.clientMatchesIdentity(clientWithClass("foot"), { id: "terminal", patterns: ["^foot$"] }));
});

test("patterns empty, titlePatterns non-empty: the title side decides alone", () => {
  const byTitle = { id: "herdr", patterns: [], titlePatterns: ["^herdr$"] };

  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), byTitle));
  // Any class will do — an empty class list is no constraint.
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("Alacritty", "herdr"), byTitle));
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "foot"), byTitle), false);

  // An absent `patterns` key reads the same way; HERDR above is that shape.
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("Alacritty", "herdr"), HERDR));
});

test("both lists empty: the identity matches nothing, ever", () => {
  const empty = { id: "nothing", patterns: [], titlePatterns: [] };

  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), empty), false);
  assert.strictEqual(engine.clientMatchesIdentity(clientWithClass("foot"), empty), false);
  assert.strictEqual(engine.matchClient(clientWithTitle("foot", "herdr"), [empty]), null);

  // Both keys absent, which is what a half-written identity looks like.
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), { id: "bare" }), false);
});

test("a list that is not a list is no constraint, never a string of characters", () => {
  // normalizeIdentity coerces a bare string into a one-element list, so this
  // shape cannot reach the matcher off the state file — but a hand-built
  // identity can, and iterating a string by CHARACTERS would make `"zzh"` match
  // "herdr" through /h/i. Both lists are guarded the same way.
  const bareStrings = { id: "junk", patterns: "zzf", titlePatterns: "zzh" };
  assert.strictEqual(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), bareStrings), false);

  // And a non-list on ONE axis does not silently become a constraint on it.
  const halfJunk = { id: "half", patterns: ["^foot$"], titlePatterns: { 0: "^herdr$" } };
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "herdr"), halfJunk));
  assert.ok(engine.clientMatchesIdentity(clientWithTitle("foot", "anything"), halfJunk));
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

// ---------------------------------------------------------------------------
// Shadowed identities — an identity that can never win says so (tick 1vq)
// ---------------------------------------------------------------------------
//
// matchClient is first-match-wins across the whole list, and toggleWatchedIdentities
// PREPENDS. So ticking a plain foot terminal after a working `herdr` title identity
// puts `^foot$` in FRONT of it, and every herdr window silently becomes "terminal".
// The ordering is not changed here — the loss of the answer is DETECTED and named.

test("an identity whose every live match is claimed earlier is reported, with its shadower", () => {
  const terminal = { id: "terminal", patterns: ["^foot$"] };
  const herdr = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };
  const clients = [
    clientWithTitle("foot", "herdr"),
    clientWithTitle("foot", "foot")
  ];

  // The hazard order: the catch-all was prepended in front of the title identity.
  // `strict` because a class-only rule constrains strictly fewer axes than a
  // class+title one — wider by construction, which is what makes "move it up,
  // or untick the other one" provably safe advice (tick ytt).
  const report = engine.shadowedIdentities(clients, [terminal, herdr]);
  assert.deepStrictEqual(report,
    [{ id: "herdr", windows: 1, claimed: 1, claimedBy: ["terminal"], strict: true }]);

  // The order the panel writes when it prepends the SPECIFIC identity: nothing is
  // shadowed, because herdr wins its own window and terminal still wins the other.
  assert.deepStrictEqual(engine.shadowedIdentities(clients, [herdr, terminal]), []);
});

test("an identity that wins even one live window is not shadowed", () => {
  const browser = { id: "browser", patterns: ["^chromium$"] };
  const slack = { id: "slack", patterns: ["^chrome-app\\.slack\\.com", "^chromium$"] };
  const clients = [
    clientWithClass("chromium"),
    clientWithClass("chrome-app.slack.com__client-Profile_1")
  ];

  // `browser` takes the plain chromium window first, but slack still owns the
  // webapp window — a partial loss is not a shadow, and saying it was would be
  // a false alarm about a rule that works.
  assert.deepStrictEqual(engine.shadowedIdentities(clients, [browser, slack]), []);
});

test("an identity with no live window at all is never called shadowed", () => {
  // The app is simply not running. There is no evidence either way, and a
  // refusal without evidence is a guess.
  const terminal = { id: "terminal", patterns: ["^foot$"] };
  const herdr = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };
  assert.deepStrictEqual(engine.shadowedIdentities([clientWithTitle("foot", "foot")], [terminal, herdr]), []);
  assert.deepStrictEqual(engine.shadowedIdentities([], [terminal, herdr]), []);

  // Neither is the FIRST identity, ever: nothing sits in front of it.
  assert.deepStrictEqual(engine.shadowedIdentities([clientWithTitle("foot", "herdr")], [herdr]), []);
});

test("a shadow report names every earlier identity that took a window, in list order", () => {
  const editor = { id: "editor", patterns: ["^code$"] };
  const terminal = { id: "terminal", patterns: ["^foot$"] };
  const both = { id: "workbench", patterns: ["^code$", "^foot$"] };
  const clients = [clientWithClass("foot"), clientWithClass("code")];

  // Two one-pattern identities shadow a two-pattern one BETWEEN THEM, which is
  // why the coverage test below asks about the claimants as a union rather than
  // one at a time. Not `strict`: all three constrain the same axis, so the
  // panel observes rather than instructs (tick ytt).
  assert.deepStrictEqual(engine.shadowedIdentities(clients, [editor, terminal, both]), [
    { id: "workbench", windows: 2, claimed: 2, claimedBy: ["editor", "terminal"], strict: false }
  ]);

  // LIST order, not hyprctl order: the same desktop read with the windows the
  // other way round produces the same report.
  assert.deepStrictEqual(engine.shadowedIdentities(clients.slice().reverse(), [editor, terminal, both]), [
    { id: "workbench", windows: 2, claimed: 2, claimedBy: ["editor", "terminal"], strict: false }
  ]);
});

// -------------------------------------------------- and when it must NOT fire
//
// Tick ytt. The axes-subset rule fixed the wolf-cry across axes and could not
// see breadth WITHIN one, so the same false alarm came back class-against-class
// — on the exact configuration StateModel's schema comment mandates.

test("a webapp identity behind a catch-all is not shadowed while only the catch-all's window is open", () => {
  const browser = { id: "browser", patterns: ["^chromium$"] };
  const slack = { id: "slack", patterns: ["^chrome-app\\.slack\\.com", "^chromium$"] };

  // ONLY the plain chromium window. slack matches it (its list carries
  // `^chromium$` too), browser takes it first, and slack wins nothing.
  const report = engine.shadowedIdentities([clientWithClass("chromium")], [browser, slack]);
  assert.deepStrictEqual(report, [],
    "slack still claims every chrome-app.slack.com window browser can never see");

  // Open the webapp and slack wins fine — which is the proof that the report
  // above would have been advice to break a working desk.
  assert.strictEqual(
    engine.matchClient(clientWithClass("chrome-app.slack.com__client-Profile_1"), [browser, slack]),
    "slack");

  // The claimants have to reach everywhere the shadowed identity does. Compared
  // as pattern STRINGS: a claimant with no patterns at all constrains nothing
  // on that axis and covers everything.
  assert.strictEqual(engine.claimantsCover([browser], slack), false);
  assert.strictEqual(engine.claimantsCover([browser], { patterns: ["^chromium$"] }), true);
  assert.strictEqual(engine.claimantsCover([browser], { patterns: ["^CHROMIUM$"] }), true,
    "compilePattern compiles case-insensitively, so the strings compare that way");
  assert.strictEqual(
    engine.claimantsCover([browser], { patterns: ["^chromium$"], titlePatterns: ["^slack$"] }), true,
    "an axis the claimant leaves free is an axis it covers entirely");
  assert.strictEqual(
    engine.claimantsCover([{ id: "titled", patterns: [], titlePatterns: ["^x$"] }],
      { patterns: ["^chromium$"] }), true);
});

test("a shadow is called strict only when the claimant is wider by construction", () => {
  const wide = { id: "terminal", patterns: ["^foot$"] };
  const narrow = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };
  assert.strictEqual(engine.strictlyWider(wide, narrow), true);
  assert.strictEqual(engine.strictlyWider(narrow, wide), false);
  // Same axes, whatever the patterns say: first is not the same as wider, and
  // an instruction there would be advice about what happens to be open.
  assert.strictEqual(engine.strictlyWider(wide, { id: "other", patterns: ["^foot$"] }), false);
});

test("the notice counts what the NAMED claimant took, not every window matched", () => {
  // Verified by execution in the vx3 review: with one titled and one plain foot
  // window, `allfoot` matches both — but the titled one went to `herdr`, which
  // is not a claimant (a class+title rule cannot shadow a class-only one). The
  // notice used to read "term2 claims all 2 windows it matches". term2 claims
  // one of them.
  const herdr = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };
  const term2 = { id: "term2", patterns: ["^foot$"] };
  const allfoot = { id: "allfoot", patterns: ["^foot$"] };
  const clients = [clientWithTitle("foot", "herdr"), clientWithTitle("foot", "foot")];

  assert.deepStrictEqual(engine.shadowedIdentities(clients, [herdr, term2, allfoot]), [
    { id: "allfoot", windows: 2, claimed: 1, claimedBy: ["term2"], strict: false }
  ]);
});

test("a NARROWER identity in front is never a shadow, even when it takes every window on screen", () => {
  // The correct desk: the title identity properly ahead of the catch-all, herdr
  // running and no plain terminal open. `terminal` matches that one window and
  // wins nothing — but it is idle, not broken, and it starts working the moment
  // a plain terminal opens. Calling it dead would be the same class of wrong
  // answer this detector exists to remove.
  const herdr = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };
  const terminal = { id: "terminal", patterns: ["^foot$"] };
  assert.deepStrictEqual(engine.shadowedIdentities([clientWithTitle("foot", "herdr")], [herdr, terminal]), []);

  // The same on the other axis: a class-only rule cannot swallow a title-only
  // one, so it is never named as its shadower.
  const editor = { id: "editor", patterns: ["^code$"] };
  const anyTitle = { id: "everything", patterns: [], titlePatterns: ["^main$"] };
  assert.deepStrictEqual(engine.shadowedIdentities([clientWithTitle("code", "main")], [editor, anyTitle]), []);
});

test("shadow detection uses the same matcher as matchClient, AND semantics included", () => {
  // A class-only identity in front of a class+title one shadows it completely;
  // the reverse does not, because the narrower rule claims strictly less.
  const wide = { id: "terminal", patterns: ["^foot$"] };
  const narrow = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] };
  const window = clientWithTitle("foot", "herdr");

  assert.strictEqual(engine.matchClient(window, [wide, narrow]), "terminal");
  assert.strictEqual(engine.shadowedIdentities([window], [wide, narrow]).length, 1);

  assert.strictEqual(engine.matchClient(window, [narrow, wide]), "herdr");
  assert.strictEqual(engine.shadowedIdentities([window], [narrow, wide]).length, 0);
});

test("shadow detection survives junk in the list and never throws", () => {
  const terminal = { id: "terminal", patterns: ["^foot$"] };
  const window = clientWithTitle("foot", "herdr");

  // Nulls, missing ids, an identity that constrains nothing, a broken regex.
  const junk = [terminal, null, { patterns: ["^foot$"] }, { id: "" },
    { id: "nothing", patterns: [], titlePatterns: [] },
    { id: "broken", patterns: ["([unclosed"] }];
  assert.deepStrictEqual(engine.shadowedIdentities([window], junk), []);

  assert.deepStrictEqual(engine.shadowedIdentities(null, null), []);
  assert.deepStrictEqual(engine.shadowedIdentities([window], undefined), []);
});

test("two identities sharing one id do not shadow each other", () => {
  // A duplicate id is StateModel's problem, not a matching one: matchClient still
  // answers with that id, so the second copy has lost nothing a user can see.
  const first = { id: "terminal", patterns: ["^foot$"] };
  const second = { id: "terminal", patterns: ["^foot$"] };
  assert.deepStrictEqual(engine.shadowedIdentities([clientWithClass("foot")], [first, second]), []);
});
