// PanelModel — the panel's view-model, and the record round trip it drives.
// Source of truth: docs/thoughts/2026-08-15-ux-sketch.md (panel anatomy,
// interaction rules) and the schema blocks in StateModel.js.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const slots = require("../Slots.js");
const panel = require("../PanelModel.js");
const { loadFixture, makeClient, IDENTITIES } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const LAPTOP_KEY = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

// QML source with its comments removed, for the source audits below that assert
// an expression is ABSENT. Those files explain themselves at length, and a
// comment warning "never write `store._queue[0] === entry` again" would fail the
// very assertion it is documenting (tick 070). Line comments only — neither QML
// file here uses a block comment, and neither has a `//` inside a string.
function qmlCode(source) {
  return String(source).split("\n").map(function (line) {
    var at = line.indexOf("//");
    return at === -1 ? line : line.slice(0, at);
  }).join("\n");
}

// The panel always resolves a client through the ONE matcher the engine owns.
// engine.matchClient answers with the identity ID (or null), which is exactly
// what PanelModel's `resolve` callback is specified to return.
function resolver(identities) {
  return (client) => engine.matchClient(client, identities) || "";
}

// -------------------------------------------------------- naming the topology

test("the laptop panel is called Laptop, not its part number", () => {
  assert.strictEqual(panel.humanizeTopology(LAPTOP_KEY, monitorsLaptop), "Laptop");
});

test("without the live monitors the part number survives, correct but unfriendly", () => {
  // A recorded topology you are not plugged into has no monitors to ask.
  assert.strictEqual(panel.humanizeTopology(LAPTOP_KEY), "Samsung ATNA60HR07-0");
});

test("a docked topology reads as a sum of short names", () => {
  const monitors = [
    { name: "eDP-1", description: "Samsung Display Corp. ATNA60HR07-0" },
    { name: "DP-2", description: "AOC Inc. U34G2G 0x00001234" }
  ];
  const key = "AOC Inc. U34G2G 0x00001234 | Samsung Display Corp. ATNA60HR07-0";
  assert.strictEqual(panel.humanizeTopology(key, monitors), "AOC U34G2G + Laptop");
});

test("an empty topology says so rather than rendering a blank header", () => {
  assert.strictEqual(panel.humanizeTopology("", monitorsLaptop), "No monitors");
  assert.strictEqual(panel.humanizeTopology(null), "No monitors");
});

// ------------------------------------------------------- pattern derivation

test("an ordinary class becomes an exact anchored pattern", () => {
  assert.strictEqual(panel.derivePattern("foot"), "^foot$");
  assert.strictEqual(panel.derivePattern("chromium"), "^chromium$");
});

test("dots in a class are escaped, not left as wildcards", () => {
  assert.strictEqual(panel.derivePattern("md.obsidian.Obsidian"), "^md\\.obsidian\\.Obsidian$");
  // The regression this guards: an unescaped dot silently widens what the
  // user thought they ticked.
  assert.ok(!new RegExp(panel.derivePattern("md.obsidian.Obsidian"), "i").test("mdxobsidianxObsidian"));
});

test("a chromium webapp becomes a stable PREFIX pattern", () => {
  const live = "chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1";
  const pattern = panel.derivePattern(live);
  assert.strictEqual(pattern, "^chrome-app\\.slack\\.com");
  // The tail varies by profile, workspace and URL; the pattern has to survive
  // all three or the identity breaks on the next re-login.
  const other = "chrome-app.slack.com__client_T09XXXXXX_C0111111-Profile_2";
  assert.ok(new RegExp(pattern, "i").test(live));
  assert.ok(new RegExp(pattern, "i").test(other));
});

test("a chromium class with no profile tail still yields a prefix", () => {
  assert.strictEqual(panel.derivePattern("chrome-mail.google.com"), "^chrome-mail\\.google\\.com");
});

test("the derived pattern is case-insensitive in practice", () => {
  // engine.compilePattern always compiles with "i", so no flag is stored.
  assert.ok(new RegExp(panel.derivePattern("Foot"), "i").test("foot"));
});

test("the generated pattern is what the engine matches with", () => {
  // Not a terminal class: ticking one of those refuses rather than proposing
  // the class (tick gpq, and the terminal section far below).
  const identity = panel.suggestIdentity("chromium", []);
  const client = makeClient({ class: "chromium" });
  assert.strictEqual(engine.clientMatchesIdentity(client, identity), true);
});

// -------------------------------------------------------------- identity ids

test("identity ids are the app's own name, not its packaging", () => {
  assert.strictEqual(panel.deriveIdentityId("foot"), "foot");
  assert.strictEqual(panel.deriveIdentityId("md.obsidian.Obsidian"), "obsidian");
  assert.strictEqual(panel.deriveIdentityId("org.telegram.desktop"), "telegram");
  assert.strictEqual(panel.deriveIdentityId("com.mitchellh.ghostty"), "ghostty");
});

test("webapp ids keep enough of the subdomain to stay distinct", () => {
  assert.strictEqual(panel.deriveIdentityId("chrome-app.slack.com__client_X-Profile_1"), "slack");
  assert.strictEqual(panel.deriveIdentityId("chrome-web.whatsapp.com__x-Profile_1"), "whatsapp");
  // Gmail and Calendar live on the same second-level domain. Collapsing them
  // to "google" would give two identities one id — and StateModel drops the
  // duplicate, silently losing one of the user's apps.
  assert.strictEqual(panel.deriveIdentityId("chrome-mail.google.com__x"), "mail-google");
  assert.strictEqual(panel.deriveIdentityId("chrome-calendar.google.com__x"), "calendar-google");
  assert.notStrictEqual(
    panel.deriveIdentityId("chrome-mail.google.com__x"),
    panel.deriveIdentityId("chrome-calendar.google.com__x"));
  // …but "www" names nothing at all. (Live class from the real desktop.)
  assert.strictEqual(
    panel.deriveIdentityId("chrome-www.rememberthemilk.com__app_-Profile_1"), "rememberthemilk");
});

test("every class on the real desktop derives a sane id", () => {
  // Captured live, and the reason two of these rules exist at all.
  const live = {
    "md.obsidian.Obsidian": "obsidian",
    "org.telegram.desktop": "telegram",
    "chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1": "slack",
    "chrome-web.whatsapp.com__-Profile_1": "whatsapp",
    "chrome-mail.google.com__mail_u_0_-Profile_1": "mail-google",
    "chrome-calendar.google.com__calendar_u_0_r-Profile_1": "calendar-google",
    "chrome-www.rememberthemilk.com__app_-Profile_1": "rememberthemilk",
    "chromium": "chromium",
    "code": "code",
    "foot": "foot"
  };
  const ids = [];
  for (const className of Object.keys(live)) {
    assert.strictEqual(panel.deriveIdentityId(className), live[className], className);
    ids.push(live[className]);
  }
  assert.strictEqual(new Set(ids).size, ids.length, "no two apps on this desktop may share an id");
});

test("a colliding id gets a suffix rather than merging two apps", () => {
  const existing = [{ id: "slack", patterns: ["^something-else$"], launch: "" }];
  const added = panel.suggestIdentity("chrome-app.slack.com__x", existing);
  assert.strictEqual(added.id, "slack-2");
  assert.deepStrictEqual(added.patterns, ["^chrome-app\\.slack\\.com"]);
});

test("a new identity never invents a launch command", () => {
  // suggestIdentity is pure and synchronous, and a truthful launch command can
  // only be READ (off /proc or a desktop file). It leaves the field empty for
  // the derivation pass to fill — see the launch-derivation tests below, and
  // the user-found gap they close.
  assert.strictEqual(panel.suggestIdentity("chromium", []).launch, "");
});

test("ticking something already watched is a no-op, not a duplicate", () => {
  const existing = [{ id: "terminal", patterns: ["^foot$"], launch: "foot" }];
  // A refusal rather than null since tick v5c: "nothing to add" is a fact the
  // panel has to be able to SAY, or the click reports a success it did not have.
  assert.deepStrictEqual(panel.suggestIdentity("foot", existing), { refusal: "already-watched" });
});

// ------------------------------------------------------------ toggle watched

test("ticking an unwatched class prepends an identity for it", () => {
  const before = [{ id: "browser", patterns: ["^chromium$"], launch: "" }];
  const after = panel.toggleWatchedIdentities(before, "code", "", null, engine.couldShadow);
  assert.strictEqual(after.length, 2);
  // Front, not back: the list is priority order and matchClient takes the
  // first match, so the specific thing just ticked must not sit behind a
  // catch-all added earlier. The one exception — an addition that would shadow
  // something already on the list — is pinned in the insert-position test.
  assert.strictEqual(after[0].id, "code");
  assert.deepStrictEqual(after[0].patterns, ["^code$"]);
  assert.strictEqual(after[1].id, "browser");
});

test("unticking removes the identity the chip was showing", () => {
  const before = [
    { id: "terminal", patterns: ["^foot$"], launch: "foot" },
    { id: "browser", patterns: ["^chromium$"], launch: "" }
  ];
  const after = panel.toggleWatchedIdentities(before, "foot", "terminal");
  assert.deepStrictEqual(after.map((i) => i.id), ["browser"]);
});

test("a toggle round trip returns the list to where it started", () => {
  const before = [{ id: "browser", patterns: ["^chromium$"], launch: "" }];
  const ticked = panel.toggleWatchedIdentities(before, "code", "");
  assert.strictEqual(ticked.length, 2, "something was actually added to untick again");
  const unticked = panel.toggleWatchedIdentities(ticked, "code", "code");
  assert.deepStrictEqual(unticked, before);
});

test("toggling never mutates the list it was handed", () => {
  const before = [{ id: "browser", patterns: ["^chromium$"], launch: "" }];
  const snapshot = JSON.stringify(before);
  panel.toggleWatchedIdentities(before, "foot", "");
  panel.toggleWatchedIdentities(before, "chromium", "browser");
  assert.strictEqual(JSON.stringify(before), snapshot,
    "QML bindings only notice a reassignment; an in-place edit would also skip the write");
});

test("what a toggle produces survives StateModel's normalizer intact", () => {
  const before = state.defaultState();
  const identities = panel.toggleWatchedIdentities(state.identities(before), "md.obsidian.Obsidian", "");
  const next = state.setIdentities(before, identities);
  const round = state.parseState(state.serializeState(next));
  // A panel-created identity says nothing about titles, and the schema
  // materializes the empty list rather than leaving the key absent. Four fields
  // is the whole of an identity since v7 removed the per-app picture flag.
  assert.deepStrictEqual(round.state.identities, [
    { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], titlePatterns: [],
      launch: "" }
  ]);
});

// ------------------------------------------------------- launch derivation
//
// The user-found gap: every panel-created identity got `launch: ""`, which
// means NEVER LAUNCH, so Restore could never bring back a watched app that was
// closed — three Chromium webapps recorded on ws 8/9 and a Restore that
// visibly did nothing. These are the two places a true command can be read
// from, and the rules that keep the derived string safe all the way into
// `hl.dsp.exec_cmd([[…]])`.

// Captured verbatim from this machine, 2026-08-15:
//   ~/.local/share/applications/gmail.desktop
// It is the exact file the fallback has to answer from, double quotes and
// URL fragment included.
const GMAIL_DESKTOP = [
  "[Desktop Entry]",
  "Name=Gmail",
  "Comment=Google Mail",
  'Exec=omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"',
  "Icon=mail-client",
  "Type=Application",
  "Categories=Network;Email;",
  "StartupWMClass=mail.google.com",
  ""
].join("\n");

// Captured verbatim from /usr/share/applications/foot.desktop plus the local
// override — note the [Desktop Action New] group with its OWN Name and Exec.
const FOOT_DESKTOP = [
  "[Desktop Entry]",
  "Type=Application",
  "TryExec=foot",
  "Exec=foot",
  "Name=Foot",
  "StartupWMClass=foot",
  "Actions=New;",
  "",
  "[Desktop Action New]",
  "Name=New Terminal",
  "Exec=foot",
  ""
].join("\n");

// Captured from /usr/share/applications/chromium.desktop on this machine — the
// answer a plain `chromium` window has to be derived from. Note the two traps
// it carries: a %U field code, and a StartupWMClass the packager never
// substituted, so only the FILENAME can match a `^chromium$` identity.
const CHROMIUM_DESKTOP = [
  "[Desktop Entry]",
  "Version=1.0",
  "Name=Chromium",
  "Exec=/usr/bin/chromium %U",
  "StartupWMClass=@@startup_wm_class",
  "Type=Application",
  "",
  "[Desktop Action new-window]",
  "Name=New Window",
  "Exec=/usr/bin/chromium",
  ""
].join("\n");

// Copied VERBATIM from ~/.local/share/applications/WhatsApp.desktop on this
// machine (2026-08-15) — the file the user's fifth gate test caught. Note what
// it does NOT have: no StartupWMClass at all, while its window arrives as
// `chrome-web.whatsapp.com__-Profile_1`. Only the host in the Exec line links
// the two.
const WHATSAPP_DESKTOP = [
  "[Desktop Entry]",
  "Version=1.0",
  "Name=WhatsApp",
  "Exec=omarchy-launch-webapp https://web.whatsapp.com/",
  "Terminal=false",
  "Type=Application",
  "Icon=whatsapp",
  "StartupNotify=true",
  ""
].join("\n");

// Copied VERBATIM from /usr/share/applications/obsidian.desktop on this machine
// (2026-08-15). The trap is one word: the packager declares `md.Obsidian` while
// the window reports `md.obsidian.Obsidian`, so exact matching misses.
const OBSIDIAN_DESKTOP = [
  "[Desktop Entry]",
  "Name=Obsidian",
  "Exec=/usr/bin/obsidian %U",
  "Terminal=false",
  "Type=Application",
  "Icon=obsidian",
  "StartupWMClass=md.Obsidian",
  "Comment=Obsidian",
  "MimeType=x-scheme-handler/obsidian;",
  "Categories=Office;",
  ""
].join("\n");

const DESKTOP_FILES = [
  { path: "/home/u/.local/share/applications/gmail.desktop", text: GMAIL_DESKTOP },
  { path: "/usr/share/applications/foot.desktop", text: FOOT_DESKTOP },
  { path: "/usr/share/applications/chromium.desktop", text: CHROMIUM_DESKTOP }
];

// The same set as the panel really scrapes: the user's own directory first, the
// system one after it.
const REAL_DESKTOP_FILES = [
  { path: "/home/user/.local/share/applications/WhatsApp.desktop", text: WHATSAPP_DESKTOP },
  ...DESKTOP_FILES,
  { path: "/usr/share/applications/obsidian.desktop", text: OBSIDIAN_DESKTOP }
];

// The window classes those two files really produce, from
// tests/fixtures/clients-laptop.json.
const WHATSAPP_CLASS = "chrome-web.whatsapp.com__-Profile_1";
const OBSIDIAN_CLASS = "md.obsidian.Obsidian";

// The launch command the user's state file really carried for obsidian before
// this tick — a whole command line quoted as ONE shell word, from before the
// quoting fix. It can never exec; the symptom is "no new window appeared".
const BROKEN_OBSIDIAN_LAUNCH =
  "'/usr/lib/electron43/electron -disable-gpu --enable-wayland-ime /usr/lib/obsidian/app.asar'";

// Where that string KEEPS coming from, found on the hardware checklist: what
// `tr '\0' '\n' < /proc/<obsidian pid>/cmdline` really prints on this machine.
// Electron rewrites its own cmdline to set the process title and separates the
// arguments with SPACES, so there are no NULs left to split on and the whole
// command line arrives as one line.
const OBSIDIAN_NUL_LESS_CMDLINE =
  "/usr/lib/electron43/electron -disable-gpu --enable-wayland-ime /usr/lib/obsidian/app.asar\n";

// ---- quoting ----

test("an ordinary argv word needs no quoting at all", () => {
  assert.strictEqual(panel.shellQuoteArg("foot"), "foot");
  assert.strictEqual(panel.shellQuoteArg("--app=https://mail.google.com/x"), "--app=https://mail.google.com/x");
  assert.strictEqual(panel.shellQuoteArg("/usr/lib/electron/electron"), "/usr/lib/electron/electron");
});

test("a word with a space, a quote or a shell metacharacter is single-quoted", () => {
  assert.strictEqual(panel.shellQuoteArg("My Notes"), "'My Notes'");
  assert.strictEqual(panel.shellQuoteArg('say "hi"'), "'say \"hi\"'");
  // The one character single quotes cannot contain: close, escape, reopen.
  assert.strictEqual(panel.shellQuoteArg("it's"), "'it'\\''s'");
  // The whole point — none of this may reach a shell alive.
  assert.strictEqual(panel.shellQuoteArg("$(rm -rf ~)"), "'$(rm -rf ~)'");
  assert.strictEqual(panel.shellQuoteArg("a`b`"), "'a`b`'");
  assert.strictEqual(panel.shellQuoteArg(""), "''");
});

test("a command containing ]] is refused outright, because Lua has no escape for it", () => {
  // Service.qml already refuses to DISPATCH such a command; this refuses to
  // write it, so the state file never carries one.
  assert.strictEqual(panel.dispatchableCommand("foo ]] os.execute('x')"), "");
  assert.strictEqual(panel.dispatchableCommand("foo ] ] bar"), "foo ] ] bar");
});

test("a command containing a control character is refused", () => {
  assert.strictEqual(panel.dispatchableCommand("foo\nbar"), "");
  assert.strictEqual(panel.dispatchableCommand("foo\x00bar"), "");
});

// ---- the running process ----

test("a cmdline read through tr splits back into argv", () => {
  // `tr '\\0' '\\n' < /proc/PID/cmdline` — the trailing NUL leaves a blank line.
  assert.deepStrictEqual(panel.parseProcCmdline("foot\n--title\nMy Notes\n"), ["foot", "--title", "My Notes"]);
  assert.deepStrictEqual(panel.parseProcCmdline(""), []);
});

test("a plain binary's argv becomes the command that started it", () => {
  assert.strictEqual(panel.launchCommandFromArgv(["foot"], "foot"), "foot");
  assert.strictEqual(
    panel.launchCommandFromArgv(["foot", "--title", "My Notes"], "foot"),
    "foot --title 'My Notes'");
});

test("an argv element with quotes or spaces survives the round trip as ONE word", () => {
  const argv = ["obsidian", "--vault", "/home/u/My Vault", "--title", "it's mine"];
  assert.strictEqual(
    panel.launchCommandFromArgv(argv, "obsidian"),
    "obsidian --vault '/home/u/My Vault' --title 'it'\\''s mine'");
});

test("the browser-family predicate covers the browsers and nothing else", () => {
  // A small data list, so this is its table. Browser's own window classes and
  // the webapp classes Chromium synthesizes from them.
  for (const className of [
    "chromium", "Chromium", "chromium-browser",
    "chrome", "Google-chrome", "google-chrome-beta",
    "chrome-mail.google.com__mail-Profile_1", "chrome-app.slack.com__client",
    "brave", "brave-browser", "Brave-browser",
    "edge", "microsoft-edge", "microsoft-edge-dev",
    "vivaldi", "vivaldi-stable"
  ]) {
    assert.strictEqual(panel.isBrowserFamilyClass(className), true, className);
  }
  // Everything else is an ordinary app whose argv is its own.
  for (const className of [
    "foot", "Alacritty", "md.obsidian.Obsidian", "org.telegram.desktop",
    "firefox", "mpv", "", "   "
  ]) {
    assert.strictEqual(panel.isBrowserFamilyClass(className), false, className);
  }
});

test("no browser-family window derives from /proc — not even one carrying --app=", () => {
  // The user-found bug, in its exact shape: the plain browser window's pid
  // belongs to the SHARED chromium process, which a webapp relaunch created,
  // so its cmdline ends in somebody else's --app=. Learning it made
  // "launch chromium" open Gmail, which never matches ^chromium$ — the launch
  // wait timed out and restore stopped without converging.
  const sharedArgv = ["/usr/lib/chromium/chromium", "--app=https://mail.google.com/mail/u/0/#inbox"];
  assert.strictEqual(panel.launchCommandFromArgv(sharedArgv, "chromium"), "");
  // And the same argv read from a webapp window: still not evidence, because
  // the --app= may belong to any sibling window of the one process.
  assert.strictEqual(
    panel.launchCommandFromArgv(sharedArgv, "chrome-mail.google.com__mail-Profile_1"), "");
  // The browser's plain argv, from either kind of window: also nothing.
  const plainArgv = ["chromium", "--enable-features=WaylandWindowDecorations"];
  assert.strictEqual(panel.launchCommandFromArgv(plainArgv, "chromium"), "");
  assert.strictEqual(panel.launchCommandFromArgv(plainArgv, "chrome-mail.google.com__mail-Profile_1"), "");
});

// ---- the structural guard: a pid with more than one window ----

test("windowCountByPid tallies the live client list and ignores pid-less rows", () => {
  const clients = [
    { address: "0x1", class: "chromium", pid: 4242 },
    { address: "0x2", class: "chrome-mail.google.com__mail-Profile_1", pid: 4242 },
    { address: "0x3", class: "foot", pid: 99 },
    { address: "0x4", class: "ghost" },
    { address: "0x5", class: "ghost2", pid: 0 }
  ];
  assert.deepStrictEqual(panel.windowCountByPid(clients), { "4242": 2, "99": 1 });
  assert.deepStrictEqual(panel.windowCountByPid(null), {});
});

test("a pid owning several windows is a host process, whatever it is called", () => {
  const counts = { "4242": 2, "99": 1 };
  assert.strictEqual(panel.isSharedProcessPid("4242", counts), true);
  assert.strictEqual(panel.isSharedProcessPid(4242, counts), true);   // number too
  assert.strictEqual(panel.isSharedProcessPid("99", counts), false);
  // Nothing running, or no tally available: not a reason to distrust anything.
  assert.strictEqual(panel.isSharedProcessPid("", counts), false);
  assert.strictEqual(panel.isSharedProcessPid("99", null), false);
});

test("an empty or nameless argv derives nothing rather than an empty command", () => {
  assert.strictEqual(panel.launchCommandFromArgv([], "foot"), "");
  assert.strictEqual(panel.launchCommandFromArgv(["", "-x"], "foot"), "");
  assert.strictEqual(panel.launchCommandFromArgv(null, "foot"), "");
});

test("an argv carrying ]] cannot become a launch command", () => {
  assert.strictEqual(panel.launchCommandFromArgv(["foo", "a]]b"], "foo"), "");
});

// ---- the shape guard: a cmdline rewritten without its NUL separators ----

test("an Electron cmdline arrives as ONE element, because it has no NULs left", () => {
  // Not a parser bug — the file really does contain one run of text. The
  // splitter reports what it read; the trust question is asked separately.
  assert.deepStrictEqual(panel.parseProcCmdline(OBSIDIAN_NUL_LESS_CMDLINE), [
    "/usr/lib/electron43/electron -disable-gpu --enable-wayland-ime /usr/lib/obsidian/app.asar"
  ]);
});

test("one argv element with internal whitespace means the separators were lost", () => {
  assert.strictEqual(
    panel.argvLooksNulLess(panel.parseProcCmdline(OBSIDIAN_NUL_LESS_CMDLINE)), true);
  // A real argv, separators intact: several elements, whitespace or not.
  assert.strictEqual(panel.argvLooksNulLess(["foot", "--working-directory", "/home/u/My Notes"]), false);
  assert.strictEqual(panel.argvLooksNulLess(["foot", "--server"]), false);
  // One element and no whitespace is what a one-word command line looks like.
  assert.strictEqual(panel.argvLooksNulLess(["herdr"]), false);
  assert.strictEqual(panel.argvLooksNulLess(["foot"]), false);
  // A trailing scrap of whitespace is not an argument list.
  assert.strictEqual(panel.argvLooksNulLess(["herdr "]), false);
  // Nothing to judge.
  assert.strictEqual(panel.argvLooksNulLess([]), false);
  assert.strictEqual(panel.argvLooksNulLess(null), false);
});

test("the NUL-less obsidian cmdline derives NOTHING from /proc", () => {
  const argv = panel.parseProcCmdline(OBSIDIAN_NUL_LESS_CMDLINE);
  // What the old code wrote, byte for byte: quoting one element quotes a
  // filename, and this is the exact string that has been sitting in the user's
  // state file being unrunnable.
  assert.strictEqual(panel.shellQuoteArg(argv[0]), BROKEN_OBSIDIAN_LAUNCH);
  assert.strictEqual(panel.launchLooksBroken(BROKEN_OBSIDIAN_LAUNCH), true);
  // So it is not written at all. Neither older guard would have stopped it:
  // obsidian is not browser-family, and it owns exactly one window.
  assert.strictEqual(panel.isBrowserFamilyClass(OBSIDIAN_CLASS), false);
  assert.strictEqual(panel.launchCommandFromArgv(argv, OBSIDIAN_CLASS), "");
  // And never by splitting on spaces — a path may contain one, so every split
  // is a guess, and a wrong guess launches the wrong program.
  assert.strictEqual(panel.launchCommandFromArgv(argv, ""), "");
});

test("a properly NUL-separated cmdline is still learned verbatim", () => {
  // The regression this guard must not cause: real argv, separators intact,
  // flags and a path with a space in it — learned exactly as it was started.
  const argv = panel.parseProcCmdline("foot\n--working-directory\n/home/u/My Notes\n");
  assert.deepStrictEqual(argv, ["foot", "--working-directory", "/home/u/My Notes"]);
  assert.strictEqual(
    panel.launchCommandFromArgv(argv, "foot"),
    "foot --working-directory '/home/u/My Notes'");

  // And a genuine one-word command line, which is one element with no space.
  assert.strictEqual(panel.launchCommandFromArgv(panel.parseProcCmdline("herdr\n"), "herdr"), "herdr");
  assert.strictEqual(panel.launchCommandFromArgv(panel.parseProcCmdline("foot\n"), "foot"), "foot");
});

// ---- the desktop file ----

test("a real Exec line keeps its quoting and loses only the field codes", () => {
  assert.strictEqual(
    panel.desktopExecCommand('omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"'),
    'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"');
  // %U/%F and friends stand for files this plugin never passes.
  assert.strictEqual(panel.desktopExecCommand("firefox %u"), "firefox");
  assert.strictEqual(panel.desktopExecCommand("mpv --profile=x %U --idle"), "mpv --profile=x --idle");
  // %% is a literal percent, not a code.
  assert.strictEqual(panel.desktopExecCommand("thing --pct=100%% %f"), "thing --pct=100%");
});

test("only the [Desktop Entry] group is read, never a [Desktop Action]", () => {
  const entry = panel.parseDesktopEntry(FOOT_DESKTOP);
  assert.strictEqual(entry.name, "Foot");            // not "New Terminal"
  assert.strictEqual(entry.exec, "foot");
  assert.strictEqual(entry.startupWMClass, "foot");
  assert.strictEqual(entry.type, "Application");
});

test("parseDesktopEntry keeps Icon=, defaulting to empty and ignoring locale-suffixed keys", () => {
  // FOOT_DESKTOP is real and declares no Icon= at all.
  assert.strictEqual(panel.parseDesktopEntry(FOOT_DESKTOP).icon, "");
  // WHATSAPP_DESKTOP and OBSIDIAN_DESKTOP are copied verbatim from files that
  // do declare one.
  assert.strictEqual(panel.parseDesktopEntry(WHATSAPP_DESKTOP).icon, "whatsapp");
  assert.strictEqual(panel.parseDesktopEntry(OBSIDIAN_DESKTOP).icon, "obsidian");

  // Icon[de] names the same field in another language; the plain key is the
  // one this file wants — exactly the convention Name[de] already follows.
  const localized = [
    "[Desktop Entry]",
    "Type=Application",
    "Exec=thing",
    "Icon[de]=ding",
    "Icon=thing-icon",
    ""
  ].join("\n");
  assert.strictEqual(panel.parseDesktopEntry(localized).icon, "thing-icon");

  // The five fields this function already returned are untouched by the addition.
  const entry = panel.parseDesktopEntry(FOOT_DESKTOP);
  assert.strictEqual(entry.name, "Foot");
  assert.strictEqual(entry.exec, "foot");
  assert.strictEqual(entry.startupWMClass, "foot");
  assert.strictEqual(entry.type, "Application");
  assert.strictEqual(entry.hidden, false);
});

// ------------------------------------------------------------------- icons
//
// Which desktop entry describes an app, and what NAME it gives its icon. The
// other half — turning a name into a drawable file — is the shell's
// appLibrary.iconSource, which knows the icon theme and keeps the contextual
// index that stops "zoom" resolving to an action icon. Nothing here
// reimplements it; where the shell will not lend it (Omarchy 4.5 gives a
// non-menu plugin no appLibrary), iconRequest only picks which lookup the
// panel makes.

test("an icon name is found through the same four passes as a launch command", () => {
  const parsed = panel.parsedDesktopEntries(REAL_DESKTOP_FILES, false);

  // Pass 1, the declared class exactly — and its chrome- variant, which is the
  // whole reason a webapp entry recording the bare host finds the window
  // Chromium named with a prefix and a profile tail.
  assert.strictEqual(
    panel.iconNameFromDesktopFiles(["^chrome-web\\.whatsapp\\.com"], parsed), "whatsapp");
  // Pass 3, the fuzzy class: the packager wrote md.Obsidian, the window says
  // md.obsidian.Obsidian.
  assert.strictEqual(
    panel.iconNameFromDesktopFiles(["^md\\.obsidian\\.Obsidian$"], parsed), "obsidian");
  // foot.desktop is real and declares no Icon= at all. "" is the honest answer,
  // and the panel draws the generic executable icon for it.
  assert.strictEqual(panel.iconNameFromDesktopFiles(["^foot$"], parsed), "");
  // Nothing claims this class.
  assert.strictEqual(panel.iconNameFromDesktopFiles(["^nothing-here$"], parsed), "");
});

test("an entry with no Icon= does not swallow the match from a weaker entry that has one", () => {
  // The strong claim (StartupWMClass, pass 1) carries no icon; the weak one
  // (the filename, pass 4) does. Without the accept predicate the first would
  // win the match and answer "", leaving the app iconless while a file on disk
  // named its icon.
  const iconless = [
    "[Desktop Entry]", "Type=Application", "Exec=thing", "Name=Thing",
    "StartupWMClass=thing", ""
  ].join("\n");
  const iconful = [
    "[Desktop Entry]", "Type=Application", "Exec=thing --other", "Name=Thing Alt",
    "Icon=thing-icon", ""
  ].join("\n");
  const files = [
    { path: "/usr/share/applications/zzz-thing-alias.desktop", text: iconless },
    { path: "/usr/share/applications/thing.desktop", text: iconful }
  ];

  assert.strictEqual(
    panel.iconNameFromDesktopFiles(["^thing$"], panel.parsedDesktopEntries(files, false)),
    "thing-icon");
  // And the launch command is untouched by that preference: launch resolution
  // has no accept predicate, so the strongest claim still wins it.
  assert.strictEqual(panel.launchFromDesktopFiles(["^thing$"], files), "thing");
});

test("an entry with no runnable Exec can name an icon but can never win a launch", () => {
  // requireCommand is what keeps launch resolution what it was: an Exec-less
  // file is dropped BEFORE the passes there, so it cannot shadow a file that
  // actually launches something. The icon lookup keeps it — "which entry is
  // this app" is a question a file with no Exec can still answer.
  const execless = [
    "[Desktop Entry]", "Type=Application", "Name=Linky",
    "StartupWMClass=linky", "Icon=linky-icon", ""
  ].join("\n");
  const files = [{ path: "/usr/share/applications/linky.desktop", text: execless }];

  assert.strictEqual(panel.parsedDesktopEntries(files, true).length, 0);
  assert.strictEqual(panel.parsedDesktopEntries(files, false).length, 1);
  assert.strictEqual(panel.launchFromDesktopFiles(["^linky$"], files), "");
  assert.strictEqual(
    panel.iconNameFromDesktopFiles(["^linky$"], panel.parsedDesktopEntries(files, false)),
    "linky-icon");
});

test("the icon index answers for watched identities and for bare window classes", () => {
  const identities = [
    { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"] },
    { id: "whatsapp", patterns: ["^chrome-web\\.whatsapp\\.com"] },
    // A watched identity whose app has no Icon= — a real case; foot is one.
    { id: "terminal", patterns: ["^foot$"] }
  ];
  const clients = [
    { class: "foot", address: "0x1" },
    { class: OBSIDIAN_CLASS, address: "0x2" },
    // Nothing on disk claims this one.
    { class: "some-unpackaged-thing", address: "0x3" }
  ];

  const index = panel.iconNameIndex(identities, clients, REAL_DESKTOP_FILES);

  assert.strictEqual(index["id:obsidian"], "obsidian");
  assert.strictEqual(index["id:whatsapp"], "whatsapp");
  assert.strictEqual(index["id:terminal"], "");
  assert.strictEqual(index["class:foot"], "");
  assert.strictEqual(index[`class:${OBSIDIAN_CLASS}`], "obsidian");
  assert.strictEqual(index["class:some-unpackaged-thing"], "");

  // The two keyspaces are kept apart by their prefixes, the way appRows keys
  // its rows: an identity called `foot` and a window class called `foot` are
  // different questions with possibly different answers.
  assert.ok(Object.keys(index).every((k) => k.indexOf("id:") === 0 || k.indexOf("class:") === 0));
});

test("the icon index's inputs are the CLASSES, and a retitled window is not one", () => {
  // What the panel binds on instead of the client list itself. liveClients is
  // reassigned whenever the text of `hyprctl clients -j` differs, and that JSON
  // carries window TITLES — so on a busy desk it is a new array on most 2 s
  // ticks, carrying the same classes. This is the question whose answer decides
  // whether the index has to be rebuilt at all.
  const before = [
    { class: "foot", title: "vim PanelModel.js", address: "0x1" },
    { class: OBSIDIAN_CLASS, title: "Notes", address: "0x2" }
  ];
  const retitled = [
    { class: "foot", title: "vim Panel.qml", address: "0x1" },
    { class: OBSIDIAN_CLASS, title: "Notes — edited", address: "0x2" }
  ];
  assert.strictEqual(panel.clientClassKey(before), panel.clientClassKey(retitled));

  // A SET, not a list: order is Hyprland's business, and a second window of an
  // app the panel already knows about needs no rebuild either.
  assert.strictEqual(panel.clientClassKey(before),
    panel.clientClassKey([before[1], before[0], { class: "foot", address: "0x3" }]));

  // A window of a class the panel has NOT seen does change it, which is the
  // whole point — that app has an icon nobody has looked up yet.
  assert.notStrictEqual(panel.clientClassKey(before),
    panel.clientClassKey(before.concat([{ class: "org.gnome.Nautilus", address: "0x4" }])));

  // The same expression iconNameIndex uses: class, else initialClass, and a
  // client with neither contributes nothing rather than an empty entry.
  assert.strictEqual(panel.clientClassKey([{ initialClass: "foot" }]), "foot");
  assert.strictEqual(panel.clientClassKey([{ class: "  " }, {}, null]), "");
  assert.strictEqual(panel.clientClassKey(null), "");
  // A window may call itself anything, `__proto__` included, and the de-dup map
  // must not find Object.prototype's member instead of an absent one.
  assert.strictEqual(panel.clientClassKey(
    [{ class: "__proto__" }, { class: "__proto__" }, { class: "constructor" }]),
    "__proto__\nconstructor");
});

test("the desktop-file parse is done once per scan, not once per lookup", () => {
  // The memo, and the invariant it rests on: `files` is REPLACED, never edited
  // in place, so reference equality is a sound answer to "same scan".
  const files = [
    { path: "/usr/share/applications/thing.desktop",
      text: "[Desktop Entry]\nType=Application\nExec=thing\nStartupWMClass=thing\nIcon=thing-icon\n" }
  ];

  const first = panel.parsedDesktopEntries(files, false);
  assert.strictEqual(panel.parsedDesktopEntries(files, false), first,
    "the same file list parses to the same array, not an equal one");

  // The two callers disagree about requireCommand — launch resolution wants
  // entries that can run, the icon lookup wants all of them — and one slot
  // apiece is what stops them evicting each other on every alternate call.
  const withCommand = panel.parsedDesktopEntries(files, true);
  assert.notStrictEqual(withCommand, first);
  assert.strictEqual(panel.parsedDesktopEntries(files, true), withCommand);
  assert.strictEqual(panel.parsedDesktopEntries(files, false), first);

  // A NEW scan is a new array, and it is parsed afresh — a cache that answered
  // for it would be serving a desktop that has changed under it.
  const rescanned = [{ path: files[0].path, text: files[0].text }];
  const second = panel.parsedDesktopEntries(rescanned, false);
  assert.notStrictEqual(second, first);
  assert.deepStrictEqual(second, first);

  // And the answers are the answers, memo or not.
  assert.strictEqual(panel.iconNameFromDesktopFiles(["^thing$"], second), "thing-icon");
  assert.strictEqual(panel.launchFromDesktopFiles(["^thing$"], rescanned), "thing");
});

test("a chip asks by identity first and by class second", () => {
  const index = {
    "id:obsidian": "obsidian",
    "id:terminal": "",
    "class:foot": "foot-icon",
    "class:md.obsidian.Obsidian": "obsidian"
  };

  // A watched chip: its identity is the more specific claim.
  assert.strictEqual(panel.iconNameFor(index, "obsidian", "md.obsidian.Obsidian"), "obsidian");
  // An unwatched chip has no identity, so the class answers.
  assert.strictEqual(panel.iconNameFor(index, "", "foot"), "foot-icon");
  // A watched identity that resolved to nothing still falls through to its
  // window's class — the identity's patterns may be narrower than the class is.
  assert.strictEqual(panel.iconNameFor(index, "terminal", "foot"), "foot-icon");
  // A recorded ghost has no window and so no class at all. Its identity is the
  // only handle it has, and when that names nothing the panel draws the
  // generic icon.
  assert.strictEqual(panel.iconNameFor(index, "terminal", ""), "");
  assert.strictEqual(panel.iconNameFor(index, "", ""), "");
  assert.strictEqual(panel.iconNameFor(null, "obsidian", "foot"), "");
});

test("with no app library, an icon name is routed the way AppLibrary.iconSource routes it", () => {
  // Omarchy 4.5's scoped facade lends appLibrary only to `menu` plugins, so the
  // panel resolves names itself (tick 0i5). The branch is pure; the two
  // lookups it names are Quickshell.iconPath and Util.fileUrl, in Panel.qml.
  // An empty name is the generic executable icon — never an empty source.
  assert.deepStrictEqual(panel.iconRequest(""), { kind: "generic" });
  assert.deepStrictEqual(panel.iconRequest("   "), { kind: "generic" });
  assert.deepStrictEqual(panel.iconRequest(null), { kind: "generic" });
  assert.deepStrictEqual(panel.iconRequest(undefined), { kind: "generic" });
  // Already a URL: passed through untouched.
  assert.deepStrictEqual(panel.iconRequest("file:///usr/share/pixmaps/foot.png"),
    { kind: "url", value: "file:///usr/share/pixmaps/foot.png" });
  assert.deepStrictEqual(panel.iconRequest("image://icon/foot"),
    { kind: "url", value: "image://icon/foot" });
  // An absolute Icon= path — the acceptance panel test's own preview.png case.
  assert.deepStrictEqual(
    panel.iconRequest("/home/u/.config/omarchy/plugins/mkelk.dock-recall/preview.png"),
    { kind: "path", value: "/home/u/.config/omarchy/plugins/mkelk.dock-recall/preview.png" });
  // A theme name, trimmed the way desktop-entry values are.
  assert.deepStrictEqual(panel.iconRequest(" obsidian "), { kind: "themed", value: "obsidian" });
  // And the index's answer feeds it directly: a ghost with no entry asks for
  // the generic icon, a watched app for its own name.
  const index = { "id:obsidian": "obsidian" };
  assert.deepStrictEqual(panel.iconRequest(panel.iconNameFor(index, "ghost", "")), { kind: "generic" });
  assert.deepStrictEqual(panel.iconRequest(panel.iconNameFor(index, "obsidian", "")),
    { kind: "themed", value: "obsidian" });
});

test("Panel.qml resolves icon names itself when the shell lends no app library", () => {
  // BY PATH: the wiring half of the test above. Node cannot run the QML, so
  // this pins the shape that made the 4.5 VM gate's chips and rows report
  // iconSource "" (tick 0i5): a null appLibrary answered "" instead of falling
  // through to a lookup of our own.
  const qml = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "Panel.qml"), "utf8");
  const body = (name) => {
    const start = qml.indexOf("function " + name + "(");
    assert.ok(start >= 0, "Panel.qml declares " + name);
    const open = qml.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < qml.length; i++) {
      if (qml[i] === "{") depth++;
      else if (qml[i] === "}" && --depth === 0) return qml.slice(open, i + 1);
    }
    throw new Error("unbalanced " + name);
  };
  const resolve = body("iconSourceForName");
  assert.match(resolve, /if \(root\.appLibrary\) return/);
  assert.match(resolve, /PanelModel\.iconRequest\(name\)/);
  assert.match(resolve, /Util\.fileUrl\(request\.value\)/);
  assert.match(resolve, /Quickshell\.iconPath\(request\.value, true\)/);
  assert.match(resolve, /Quickshell\.iconPath\("application-x-executable", true\)/);
  // Every chip, row and the generic comparison go through it — none asks the
  // library directly, which is where a null one turned into "".
  assert.match(body("iconSourceOf"), /root\.iconSourceForName\(/);
  assert.match(qml, /readonly property string genericIconSource: root\.iconSourceForName\(""\)/);
  assert.strictEqual((qml.match(/appLibrary\.iconSource\(/g) || []).length, 1,
    "appLibrary.iconSource is asked in exactly one place, iconSourceForName");
});

test("a webapp identity finds its desktop file through StartupWMClass", () => {
  // The two halves of one fact: the entry records the bare host, Chromium
  // synthesizes the class with its own prefix and a per-profile tail.
  assert.strictEqual(
    panel.launchFromDesktopFiles(["^chrome-mail\\.google\\.com"], DESKTOP_FILES),
    'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"');
});

test("an ordinary identity finds its desktop file through StartupWMClass too", () => {
  assert.strictEqual(panel.launchFromDesktopFiles(["^foot$"], DESKTOP_FILES), "foot");
  assert.strictEqual(panel.launchFromDesktopFilesForClass("foot", DESKTOP_FILES), "foot");
});

test("StartupWMClass outranks the filename", () => {
  // gmail.desktop would match a `^gmail$` pattern by name, but an identity for
  // the real window class must not be answered by whichever file happens to be
  // named after it.
  const decoy = [
    { path: "/usr/share/applications/mail.google.com.desktop", text: "[Desktop Entry]\nType=Application\nExec=wrong-thing\n" },
    ...DESKTOP_FILES
  ];
  assert.strictEqual(
    panel.launchFromDesktopFiles(["^chrome-mail\\.google\\.com"], decoy),
    'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"');
});

test("a hidden entry, a non-Application entry and an Exec-less entry are all skipped", () => {
  const files = [
    { path: "/a/foot.desktop", text: "[Desktop Entry]\nType=Application\nExec=hidden-one\nStartupWMClass=foot\nHidden=true\n" },
    { path: "/b/foot.desktop", text: "[Desktop Entry]\nType=Link\nExec=link-one\nStartupWMClass=foot\n" },
    { path: "/c/foot.desktop", text: "[Desktop Entry]\nType=Application\nStartupWMClass=foot\n" },
    ...DESKTOP_FILES
  ];
  assert.strictEqual(panel.launchFromDesktopFiles(["^foot$"], files), "foot");
});

test("nothing matching means no command — never a guess", () => {
  assert.strictEqual(panel.launchFromDesktopFiles(["^nothing-like-this$"], DESKTOP_FILES), "");
  assert.strictEqual(panel.launchFromDesktopFiles([], DESKTOP_FILES), "");
  // A malformed stored pattern must not throw; it simply never matches.
  assert.strictEqual(panel.launchFromDesktopFiles(["^(unclosed"], DESKTOP_FILES), "");
});

// ---- gap 1: a webapp entry with no StartupWMClass at all ----

test("the host of a webapp Exec line is read, and only from a webapp Exec line", () => {
  assert.strictEqual(
    panel.desktopWebappHost({ exec: "omarchy-launch-webapp https://web.whatsapp.com/" }),
    "web.whatsapp.com");
  // Quoted, with a path, and Chromium's own flag: the same fact in four dresses.
  assert.strictEqual(
    panel.desktopWebappHost({ exec: 'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"' }),
    "mail.google.com");
  assert.strictEqual(
    panel.desktopWebappHost({ exec: "/usr/share/omarchy/bin/omarchy-launch-webapp https://app.slack.com/client/X" }),
    "app.slack.com");
  assert.strictEqual(
    panel.desktopWebappHost({ exec: "chromium --app=https://calendar.google.com/calendar/u/0/r %U" }),
    "calendar.google.com");
  // An entry that merely PASSES a URL is not a webapp: matching one would hand
  // a webapp class the wrong launcher.
  assert.strictEqual(panel.desktopWebappHost({ exec: "firefox https://docs.example.com/manual" }), "");
  assert.strictEqual(panel.desktopWebappHost({ exec: "/usr/bin/obsidian %U" }), "");
  assert.strictEqual(panel.desktopWebappHost({ exec: "" }), "");
});

test("a URL host survives credentials, a port and a path", () => {
  assert.strictEqual(panel.urlHost("https://Web.WhatsApp.com/"), "web.whatsapp.com");
  assert.strictEqual(panel.urlHost("http://user:pw@intranet.example:8080/x?y#z"), "intranet.example");
  assert.strictEqual(panel.urlHost("not-a-url"), "");
});

test("WhatsApp.desktop finds its window through the Exec URL — the fifth gate finding", () => {
  // The real file has NO StartupWMClass, so both older strategies miss and the
  // identity's launch stayed empty through record, restore and repair alike.
  const entry = panel.parseDesktopEntry(WHATSAPP_DESKTOP);
  assert.strictEqual(entry.startupWMClass, "");
  assert.strictEqual(panel.desktopWebappClassCandidate(entry), "chrome-web.whatsapp.com");

  // End to end, from the live window class the user's session really reports.
  assert.strictEqual(panel.derivePattern(WHATSAPP_CLASS), "^chrome-web\\.whatsapp\\.com");
  assert.strictEqual(
    panel.launchFromDesktopFilesForClass(WHATSAPP_CLASS, REAL_DESKTOP_FILES),
    "omarchy-launch-webapp https://web.whatsapp.com/");
  assert.strictEqual(
    panel.launchFromDesktopFiles(["^chrome-web\\.whatsapp\\.com"], REAL_DESKTOP_FILES),
    "omarchy-launch-webapp https://web.whatsapp.com/");
});

test("a declared StartupWMClass still outranks an Exec URL", () => {
  // Two files claim the same webapp: one says so in the field that exists for
  // it, the other only implies it. The declaration wins wherever it sits in the
  // scan, because passes run whole-list before the next one starts.
  const files = [
    { path: "/home/u/.local/share/applications/decoy.desktop",
      text: "[Desktop Entry]\nType=Application\nExec=omarchy-launch-webapp https://mail.google.com/mail\n" },
    { path: "/home/u/.local/share/applications/gmail.desktop", text: GMAIL_DESKTOP }
  ];
  assert.strictEqual(
    panel.launchFromDesktopFiles(["^chrome-mail\\.google\\.com"], files),
    'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"');
});

// ---- gap 2: a StartupWMClass the packager wrote one token short ----

test("a dot-token subset with the same last token is the same app", () => {
  // The literal pair from this machine.
  assert.strictEqual(panel.wmClassFuzzyMatches("md.Obsidian", "md.obsidian.Obsidian"), true);
  // Case is packaging noise on both sides.
  assert.strictEqual(panel.wmClassFuzzyMatches("MD.OBSIDIAN", "md.obsidian.Obsidian"), true);
  assert.strictEqual(panel.wmClassFuzzyMatches("Obsidian", "md.obsidian.Obsidian"), true);
});

test("the fuzzy match refuses everything it has no business matching", () => {
  // The negative case that keeps this from being a wildcard: a different app's
  // desktop file must not answer for obsidian.
  assert.strictEqual(panel.wmClassFuzzyMatches("code", "md.obsidian.Obsidian"), false);
  assert.strictEqual(panel.wmClassFuzzyMatches("org.telegram.desktop", "md.obsidian.Obsidian"), false);
  // A token the window class does not have at all.
  assert.strictEqual(panel.wmClassFuzzyMatches("md.obsidian.Beta", "md.obsidian.Obsidian"), false);
  // Agreement on a packaging word is not agreement on an app.
  assert.strictEqual(panel.wmClassFuzzyMatches("desktop", "org.telegram.desktop"), false);
  assert.strictEqual(panel.wmClassFuzzyMatches("", "md.obsidian.Obsidian"), false);
  assert.strictEqual(panel.wmClassFuzzyMatches("md.Obsidian", ""), false);
});

test("fuzzy matching only runs against a pattern that is a plain class name", () => {
  assert.strictEqual(panel.patternLiteral("^md\\.obsidian\\.Obsidian$"), "md.obsidian.Obsidian");
  assert.strictEqual(panel.patternLiteral("^chrome-web\\.whatsapp\\.com"), "chrome-web.whatsapp.com");
  // A hand-written regex is a regex, not a name — the exact strategies keep it.
  assert.strictEqual(panel.patternLiteral("^(foo|bar)$"), "");
  assert.strictEqual(panel.patternLiteral("md\\.Obsidian"), "");
  assert.strictEqual(panel.patternLiteral(""), "");
});

test("obsidian.desktop is found despite declaring md.Obsidian — the fifth gate finding", () => {
  assert.strictEqual(panel.parseDesktopEntry(OBSIDIAN_DESKTOP).startupWMClass, "md.Obsidian");
  assert.strictEqual(panel.derivePattern(OBSIDIAN_CLASS), "^md\\.obsidian\\.Obsidian$");
  assert.strictEqual(
    panel.launchFromDesktopFiles(["^md\\.obsidian\\.Obsidian$"], REAL_DESKTOP_FILES),
    "/usr/bin/obsidian");
  assert.strictEqual(
    panel.launchFromDesktopFilesForClass(OBSIDIAN_CLASS, REAL_DESKTOP_FILES),
    "/usr/bin/obsidian");
  // And a class no file on this machine describes still derives nothing.
  assert.strictEqual(panel.launchFromDesktopFilesForClass("md.nothing.Nothing", REAL_DESKTOP_FILES), "");
});

test("an exact StartupWMClass anywhere in the set beats a fuzzy one", () => {
  const files = [
    { path: "/usr/share/applications/obsidian.desktop", text: OBSIDIAN_DESKTOP },
    { path: "/home/u/.local/share/applications/obsidian-exact.desktop",
      text: "[Desktop Entry]\nType=Application\nExec=exact-obsidian\nStartupWMClass=md.obsidian.Obsidian\n" }
  ];
  assert.strictEqual(panel.launchFromDesktopFiles(["^md\\.obsidian\\.Obsidian$"], files), "exact-obsidian");
});

// ---- gap 3: a stored launch that cannot run ----

test("a command splits into shell words, and says so when it cannot", () => {
  assert.deepStrictEqual(panel.shellWords("foot --title 'My Notes'"), ["foot", "--title", "My Notes"]);
  assert.deepStrictEqual(
    panel.shellWords('omarchy-launch-webapp "https://web.whatsapp.com/"'),
    ["omarchy-launch-webapp", "https://web.whatsapp.com/"]);
  assert.deepStrictEqual(panel.shellWords(BROKEN_OBSIDIAN_LAUNCH),
    ["/usr/lib/electron43/electron -disable-gpu --enable-wayland-ime /usr/lib/obsidian/app.asar"]);
  // No shell can parse these at all.
  assert.strictEqual(panel.shellWords("'unterminated"), null);
  assert.strictEqual(panel.shellWords("trailing\\"), null);
});

test("the stale pre-quoting-fix launch is recognised as broken", () => {
  // The literal string out of the user's state file: one shell word asking for
  // a program whose filename contains flags. Launch fails with "no new window
  // appeared at all", and nothing used to say why.
  assert.strictEqual(panel.launchLooksBroken(BROKEN_OBSIDIAN_LAUNCH), true);
  // Quoting that does not close, and a command the dispatch could never carry.
  assert.strictEqual(panel.launchLooksBroken("'unterminated"), true);
  assert.strictEqual(panel.launchLooksBroken("foo ]] os.execute('x')"), true);
});

test("a runnable command is never called broken", () => {
  assert.strictEqual(panel.launchLooksBroken("/usr/bin/obsidian"), false);
  assert.strictEqual(panel.launchLooksBroken('omarchy-launch-webapp "https://web.whatsapp.com/"'), false);
  assert.strictEqual(panel.launchLooksBroken("foot --title 'My Notes'"), false);
  assert.strictEqual(panel.launchLooksBroken("/usr/bin/foot --title=herdr herdr"), false);
  // ONE word with a space in it can be an honest path, and this one is: no
  // fragment after the space looks like a flag or a second path.
  assert.strictEqual(panel.launchLooksBroken("'/opt/My App/bin/app'"), false);
  // Empty is "never launch this one", a user choice — not a fault.
  assert.strictEqual(panel.launchLooksBroken(""), false);
  assert.strictEqual(panel.launchLooksBroken("   "), false);
});

test("a broken launch joins the repairable set and is re-derived on a press", () => {
  const identities = [
    { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], launch: BROKEN_OBSIDIAN_LAUNCH },
    { id: "whatsapp", patterns: ["^chrome-web\\.whatsapp\\.com"], launch: "" },
    { id: "terminal", patterns: ["^foot$"], launch: "foot --hand-tuned" }
  ];
  // Both of the user's stuck apps ask for a derivation; the healthy one does not.
  assert.deepStrictEqual(panel.identitiesNeedingLaunch(identities), ["obsidian", "whatsapp"]);

  const requests = identities.map((i) => (
    { identityId: i.id, patterns: i.patterns, className: "", pid: "", argv: null }));
  // `.commands` is the half these cases are about; `.refusals` has its own
  // tests below.
  const derived = panel.launchDerivation(requests, REAL_DESKTOP_FILES, {}).commands;
  assert.deepStrictEqual(derived, {
    obsidian: "/usr/bin/obsidian",
    whatsapp: "omarchy-launch-webapp https://web.whatsapp.com/",
    terminal: "foot"
  });

  // The repair rule: the broken one and the empty one, never the hand-tuned one.
  assert.deepStrictEqual(panel.launchRepairIndex(identities, derived), {
    obsidian: "/usr/bin/obsidian",
    whatsapp: "omarchy-launch-webapp https://web.whatsapp.com/"
  });
  assert.strictEqual(panel.learnableCount(identities, derived), 2);

  const after = panel.backfillLaunchCommands(identities, derived);
  assert.strictEqual(after[0].launch, "/usr/bin/obsidian");
  assert.strictEqual(after[1].launch, "omarchy-launch-webapp https://web.whatsapp.com/");
  assert.strictEqual(after[2].launch, "foot --hand-tuned");
  assert.deepStrictEqual(after[0].patterns, ["^md\\.obsidian\\.Obsidian$"]);
});

test("a broken launch with nothing to replace it is flagged, never blanked", () => {
  const identities = [{ id: "obsidian", patterns: ["^nothing$"], launch: BROKEN_OBSIDIAN_LAUNCH }];
  assert.deepStrictEqual(panel.launchRepairIndex(identities, {}), {});
  assert.strictEqual(panel.learnableCount(identities, {}), 0);
  // Untouched: a diagnosis is not permission to edit the user's field.
  assert.strictEqual(panel.backfillLaunchCommands(identities, {})[0].launch, BROKEN_OBSIDIAN_LAUNCH);
  // But the row still says what is wrong.
  assert.deepStrictEqual(panel.launchStateIndex(identities, {}), { obsidian: "broken" });
  assert.strictEqual(panel.launchHintFor("broken"), "launch cmd looks broken");
});

test("a re-derivation identical to the stored broken command is not a repair", () => {
  // Nothing to write means nothing offered — the button must not count a press
  // that would change no byte of the file.
  const identities = [{ id: "x", patterns: ["^x$"], launch: BROKEN_OBSIDIAN_LAUNCH }];
  assert.deepStrictEqual(panel.launchRepairIndex(identities, { x: BROKEN_OBSIDIAN_LAUNCH }), {});
});

test("the row carries whether its hint is also an offer", () => {
  const identities = [
    { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], launch: BROKEN_OBSIDIAN_LAUNCH },
    { id: "stuck", patterns: ["^nothing$"], launch: BROKEN_OBSIDIAN_LAUNCH }
  ];
  const layout = {
    topologyKey: LAPTOP_KEY,
    apps: [
      { identityId: "obsidian", monitorDescription: LAPTOP_KEY, workspaceId: 10 },
      { identityId: "stuck", monitorDescription: LAPTOP_KEY, workspaceId: 10 }
    ]
  };
  const rows = panel.appRows([], monitorsLaptop, () => "", null, layout, identities,
    { obsidian: "/usr/bin/obsidian" });
  const byId = {};
  for (const row of rows) byId[row.identityId] = row;

  assert.strictEqual(byId.obsidian.launchState, "broken");
  assert.strictEqual(byId.obsidian.launchHint, "launch cmd looks broken");
  assert.strictEqual(byId.obsidian.launchRepairable, true);
  // Same warning, no offer: nothing was derived for this one.
  assert.strictEqual(byId.stuck.launchState, "broken");
  assert.strictEqual(byId.stuck.launchRepairable, false);
});

// ---- putting it together ----

test("the running window wins, and the desktop file catches everything else", () => {
  const requests = [
    // Running, alone in its process, with its own argv: the argv is what
    // actually started it here, flags and all.
    {
      identityId: "terminal", patterns: ["^foot$"], className: "foot",
      pid: "99", argv: ["foot", "--title", "My Notes"]
    },
    // Not running at all — the case Restore exists for.
    { identityId: "mail-google", patterns: ["^chrome-mail\\.google\\.com"], className: "", pid: "", argv: null },
    // Running inside the shared browser process: falls through to the file.
    {
      identityId: "mail-2", patterns: ["^chrome-mail\\.google\\.com"],
      className: "chrome-mail.google.com__mail-Profile_1", pid: "4242", argv: ["chromium", "--x"]
    },
    // Nothing running and nothing packaged.
    { identityId: "ghost", patterns: ["^nothing-like-this$"], className: "", pid: "", argv: null }
  ];
  const windowsByPid = { "99": 1, "4242": 2 };

  assert.deepStrictEqual(panel.launchDerivation(requests, DESKTOP_FILES, windowsByPid).commands, {
    terminal: "foot --title 'My Notes'",
    "mail-google": 'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"',
    "mail-2": 'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"'
  });
});

test("the plain browser window learns its OWN desktop file, never the process argv", () => {
  // The third gate-test finding, end to end. One chromium process, two
  // windows: the plain browser and a Gmail webapp. The process was created by
  // the webapp relaunch, so /proc/4242/cmdline carries --app=…gmail.
  const clients = [
    { address: "0x1", class: "chromium", pid: 4242 },
    { address: "0x2", class: "chrome-mail.google.com__mail-Profile_1", pid: 4242 }
  ];
  const sharedArgv = ["/usr/lib/chromium/chromium", "--app=https://mail.google.com/mail/u/0/#inbox"];
  const requests = [
    { identityId: "chromium", patterns: ["^chromium$"], className: "chromium", pid: "4242", argv: sharedArgv },
    {
      identityId: "mail-google", patterns: ["^chrome-mail\\.google\\.com"],
      className: "chrome-mail.google.com__mail-Profile_1", pid: "4242", argv: sharedArgv
    }
  ];

  // chromium.desktop, %U stripped — a command that really does open a window
  // of class `chromium`, which is what the launch wait is watching for.
  assert.deepStrictEqual(
    panel.launchDerivation(requests, DESKTOP_FILES, panel.windowCountByPid(clients)).commands,
    {
      chromium: "/usr/bin/chromium",
      "mail-google": 'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"'
    });
});

test("a shared pid stops argv derivation for a NON-browser host process too", () => {
  // foot --server: every footclient window belongs to the one server process,
  // whose cmdline is `foot --server` — a daemon that opens no window at all.
  // Learning it would write a launch command that can never produce a window.
  // The structural test sees this without knowing what foot is.
  const clients = [
    { address: "0xa", class: "foot", pid: 700 },
    { address: "0xb", class: "TUI.tile", pid: 700 }
  ];
  const requests = [
    {
      identityId: "terminal", patterns: ["^foot$"], className: "foot",
      pid: "700", argv: ["foot", "--server"]
    }
  ];

  // Falls through to foot.desktop, which launches a real terminal.
  assert.deepStrictEqual(
    panel.launchDerivation(requests, DESKTOP_FILES, panel.windowCountByPid(clients)).commands,
    { terminal: "foot" });

  // And the single-window case is untouched: one pid, one window, so the
  // hand-tuned flags the user actually started it with are still learned.
  const alone = [{ address: "0xa", class: "foot", pid: 700 }];
  const flags = [{
    identityId: "terminal", patterns: ["^foot$"], className: "foot",
    pid: "700", argv: ["foot", "--working-directory", "/home/u/My Notes"]
  }];
  assert.deepStrictEqual(
    panel.launchDerivation(flags, DESKTOP_FILES, panel.windowCountByPid(alone)).commands,
    { terminal: "foot --working-directory '/home/u/My Notes'" });
});

test("a running Electron app learns its desktop file, never its rewritten cmdline", () => {
  // The hardware-checklist finding end to end, starting from the bytes the
  // panel's one Process really prints. Obsidian is alone in its process and is
  // not browser-family, so the only thing that saves it is the cmdline shape.
  const dump = [
    "@@mw@@ 8123",
    OBSIDIAN_NUL_LESS_CMDLINE,          // one line, no NULs, spaces instead
    "@@mw@@ 700",
    "foot", "--working-directory", "/home/u/My Notes", ""
  ].join("\n");
  const argvByPid = panel.argvByPidFromDump(dump);
  assert.strictEqual(argvByPid["8123"].length, 1);    // the rewritten one
  assert.strictEqual(argvByPid["700"].length, 3);     // an honest argv

  const clients = [
    { address: "0x1", class: OBSIDIAN_CLASS, pid: 8123 },
    { address: "0x2", class: "foot", pid: 700 }
  ];
  const requests = [
    {
      identityId: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"],
      className: OBSIDIAN_CLASS, pid: "8123", argv: argvByPid["8123"]
    },
    {
      identityId: "terminal", patterns: ["^foot$"],
      className: "foot", pid: "700", argv: argvByPid["700"]
    }
  ];

  const derived = panel.launchDerivation(requests, REAL_DESKTOP_FILES, panel.windowCountByPid(clients)).commands;
  assert.deepStrictEqual(derived, {
    // obsidian.desktop, found through the fuzzy StartupWMClass — a command that
    // really does start Obsidian.
    obsidian: "/usr/bin/obsidian",
    // Untouched by the new guard: its separators were where they belong.
    terminal: "foot --working-directory '/home/u/My Notes'"
  });

  // And the user's stale broken field is repaired by the same press, rather
  // than being rewritten to the identical broken string as before.
  const identities = [
    { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], launch: BROKEN_OBSIDIAN_LAUNCH },
    { id: "terminal", patterns: ["^foot$"], launch: "" }
  ];
  assert.strictEqual(panel.learnableCount(identities, derived), 2);
  const after = panel.backfillLaunchCommands(identities, derived);
  assert.strictEqual(after[0].launch, "/usr/bin/obsidian");
  assert.strictEqual(panel.launchLooksBroken(after[0].launch), false);
});

test("identitiesNeedingLaunch lists exactly the empty ones", () => {
  const identities = [
    { id: "terminal", patterns: ["^foot$"], launch: "foot" },
    { id: "mail-google", patterns: ["^chrome-mail\\.google\\.com"], launch: "" },
    { id: "rtm", patterns: ["^chrome-www\\.rememberthemilk\\.com"], launch: "   " }
  ];
  assert.deepStrictEqual(panel.identitiesNeedingLaunch(identities), ["mail-google", "rtm"]);
});

test("backfill fills empty launches and NEVER overwrites one that is set", () => {
  const identities = [
    { id: "terminal", patterns: ["^foot$"], launch: "foot --hand-tuned" },
    { id: "mail-google", patterns: ["^chrome-mail\\.google\\.com"], launch: "" },
    { id: "ghost", patterns: ["^nothing$"], launch: "" }
  ];
  const map = {
    terminal: "foot",                       // a different, "better" answer
    "mail-google": 'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"'
  };

  const after = panel.backfillLaunchCommands(identities, map);
  // The user's own command is left exactly as they typed it.
  assert.strictEqual(after[0].launch, "foot --hand-tuned");
  assert.strictEqual(after[1].launch, 'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"');
  // Nothing derived means nothing written — still restorable only by hand.
  assert.strictEqual(after[2].launch, "");
  // Patterns and order are untouched: this is a repair, not a rewrite.
  assert.deepStrictEqual(after.map((i) => i.id), ["terminal", "mail-google", "ghost"]);
  assert.deepStrictEqual(after[1].patterns, ["^chrome-mail\\.google\\.com"]);
});

test("a repaired identity keeps every field it had — titlePatterns included", () => {
  // The defect (tick h5i): the backfill rebuilt the repaired identity from a
  // FIXED field list, so schema v4's `titlePatterns` fell on the floor.
  // Pressing "Learn launch" on a title-matched app silently destroyed its
  // title matching, and the loss only surfaced later, when the window stopped
  // being recognized. The fix is a COPY, not a longer list — a list has to be
  // edited every time the schema grows, and forgetting to is this exact bug.
  const identities = [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }
  ];
  const map = { herdr: "foot --title herdr" };

  assert.deepStrictEqual(panel.backfillLaunchCommands(identities, map), [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "foot --title herdr" }
  ]);
  // The autofill is the same repair without a press, applied through the same
  // function, so it must not lose the field either.
  assert.deepStrictEqual(panel.autofillLaunchCommands(identities, map), [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "foot --title herdr" }
  ]);
  // And the list handed in is not edited in place: QML bindings only notice a
  // reassignment, so an in-place repair would also skip the write.
  assert.deepStrictEqual(identities, [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }
  ]);
});

test("a launch repair round-trips through the file with its titles intact", () => {
  // The epic's acceptance driven through the whole panel write path: repair,
  // setIdentities, serialize, parse.
  const before = state.setIdentities(state.defaultState(), [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }
  ]);
  const repaired = panel.backfillLaunchCommands(
    state.identities(before), { herdr: "foot --title herdr" });
  const round = state.parseState(state.serializeState(state.setIdentities(before, repaired)));
  assert.deepStrictEqual(round.state.identities, [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
      launch: "foot --title herdr" }
  ]);
});

test("a derived command carrying ]] is dropped at the backfill too", () => {
  const identities = [{ id: "x", patterns: ["^x$"], launch: "" }];
  assert.strictEqual(panel.backfillLaunchCommands(identities, { x: "evil ]] here" })[0].launch, "");
});

test("the repair button counts only what it can actually repair", () => {
  const identities = [
    { id: "terminal", patterns: ["^foot$"], launch: "foot" },
    { id: "mail-google", patterns: [], launch: "" },
    { id: "ghost", patterns: [], launch: "" }
  ];
  assert.strictEqual(panel.learnableCount(identities, { "mail-google": "gmail-cmd" }), 1);
  assert.strictEqual(panel.learnLaunchLabel(1), "Learn launch (1)");
  assert.strictEqual(panel.learnableCount(identities, {}), 0);
  assert.strictEqual(panel.learnLaunchLabel(0), "");
});

test("the row hint separates 'can be repaired' from 'genuinely cannot'", () => {
  const identities = [
    { id: "terminal", patterns: ["^foot$"], launch: "foot" },
    { id: "mail-google", patterns: [], launch: "" },
    { id: "ghost", patterns: [], launch: "" }
  ];
  const index = panel.launchStateIndex(identities, { "mail-google": "gmail-cmd" });
  assert.deepStrictEqual(index, { "mail-google": "derivable", ghost: "missing" });
  assert.strictEqual(panel.launchHintFor(index["mail-google"]), "learn launch");
  assert.strictEqual(panel.launchHintFor(index.ghost), "no launch cmd");
  // An identity that HAS a launch says nothing at all.
  assert.strictEqual(panel.launchHintFor(index.terminal), "");
});

// ---- the sectioned dump the panel's one Process produces ----

test("a sectioned dump splits back into its files", () => {
  const dump = [
    "@@mw@@ /home/u/.local/share/applications/gmail.desktop",
    "[Desktop Entry]",
    'Exec=omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"',
    "StartupWMClass=mail.google.com",
    "@@mw@@ /usr/share/applications/foot.desktop",
    "[Desktop Entry]",
    "Exec=foot",
    "StartupWMClass=foot",
    ""
  ].join("\n");

  const files = panel.desktopFilesFromDump(dump);
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].path, "/home/u/.local/share/applications/gmail.desktop");
  assert.strictEqual(
    panel.launchFromDesktopFiles(["^chrome-mail\\.google\\.com"], files),
    'omarchy-launch-webapp "https://mail.google.com/mail/u/0/#inbox"');
  assert.strictEqual(panel.launchFromDesktopFiles(["^foot$"], files), "foot");
});

test("a cmdline dump splits back into argv per pid", () => {
  const dump = ["@@mw@@ 1234", "foot", "--title", "My Notes", "", "@@mw@@ 5678", "chromium", "--app=https://x/", ""].join("\n");
  assert.deepStrictEqual(panel.argvByPidFromDump(dump), {
    1234: ["foot", "--title", "My Notes"],
    5678: ["chromium", "--app=https://x/"]
  });
});

test("output before the first marker, and a pid that could not be read, are ignored", () => {
  // /proc/<pid>/cmdline is empty for a kernel thread and gone for a process
  // that exited between the read and the dump.
  const dump = ["some stray warning", "@@mw@@ 1", "", "@@mw@@ 2", "foot", ""].join("\n");
  assert.deepStrictEqual(panel.argvByPidFromDump(dump), { 2: ["foot"] });
  assert.deepStrictEqual(panel.desktopFilesFromDump(""), []);
});

// ------------------------------------------------------------- map geometry

test("monitors are placed to scale in their real arrangement", () => {
  const monitors = [
    { id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 2880, height: 1800, scale: 2 },
    { id: 1, name: "DP-2", description: "Ultrawide", x: 1440, y: 0, width: 3440, height: 1440, scale: 1 }
  ];
  const map = panel.mapGeometry(monitors, 480, 240);

  // Logical sizes: the laptop is 1440x900 at scale 2, not 2880x1800. Drawing
  // the pixel mode would give a HiDPI laptop twice its real estate and put
  // every neighbour in the wrong place.
  const laptop = map.monitors[0];
  const wide = map.monitors[1];
  assert.strictEqual(laptop.name, "eDP-1");
  assert.strictEqual(laptop.sizeLabel, "1440×900");
  assert.strictEqual(wide.sizeLabel, "3440×1440");

  // One shared scale, so the proportions on screen are the proportions on the
  // desk.
  assert.ok(Math.abs(wide.width / laptop.width - 3440 / 1440) < 0.05);
  assert.ok(Math.abs(wide.height / laptop.height - 1440 / 900) < 0.05);

  // And the arrangement: the ultrawide sits to the right of the laptop.
  assert.strictEqual(laptop.x, 0);
  assert.ok(wide.x > laptop.x);
  assert.ok(map.width <= 480 && map.height <= 240);
});

test("the map is ordered for the eye, not by hyprctl's connection order", () => {
  const monitors = [
    { id: 5, name: "DP-2", x: 1440, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 0, name: "eDP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 }
  ];
  const map = panel.mapGeometry(monitors, 400, 200);
  assert.deepStrictEqual(map.monitors.map((m) => m.name), ["eDP-1", "DP-2"]);
});

test("the laptop's section comes first, then the external screens left to right (tick yn6)", () => {
  // THE HUMAN'S ANSWER TO HIS OWN GATE: "I want two separated sections
  // vertically, one section for laptop and one (or more) for each external
  // monitor". A stack is read top to bottom, so the first section is the screen
  // he is always sitting in front of — whatever its place on the desk.
  //
  // The laptop PHYSICALLY ON THE RIGHT is the case the old left-to-right rule
  // got wrong and the only one that tells the two rules apart.
  const rightHandLaptop = panel.mapGeometry([
    { id: 1, name: "DP-1", x: 0, y: 0, width: 2150, height: 900, scale: 1 },
    { id: 2, name: "HDMI-A-1", x: 2150, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 0, name: "eDP-1", x: 4070, y: 0, width: 1440, height: 900, scale: 1 }
  ], 400, 200);
  assert.deepStrictEqual(rightHandLaptop.monitors.map((m) => m.name),
    ["eDP-1", "DP-1", "HDMI-A-1"],
    "the built-in panel leads, and the externals keep their own left-to-right order");

  // The other connector names Hyprland gives a built-in panel, and the same
  // test shortMonitorLabel uses to call one "Laptop" — so the two cannot
  // disagree about which screen is the laptop.
  for (const name of ["LVDS-1", "DSI-1", "edp-2"]) {
    const map = panel.mapGeometry([
      { id: 1, name: "DP-1", x: 0, y: 0, width: 2560, height: 1440, scale: 1 },
      { id: 0, name, x: 2560, y: 0, width: 1440, height: 900, scale: 1 }
    ], 400, 200);
    assert.strictEqual(map.monitors[0].name, name, `${name} is a built-in panel`);
  }

  // With no internal panel the first clause never fires and the rule is exactly
  // what it always was: left to right, then top to bottom.
  const allExternal = panel.mapGeometry([
    { id: 2, name: "HDMI-A-1", x: 1920, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 1, name: "DP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 3, name: "DP-2", x: 0, y: 1080, width: 1920, height: 1080, scale: 1 }
  ], 400, 400);
  assert.deepStrictEqual(allExternal.monitors.map((m) => m.name),
    ["DP-1", "DP-2", "HDMI-A-1"]);
});

test("inside a section the workspaces run 1..10, not 1, 10, 2 (tick yn6)", () => {
  // The human's addendum, in his words: "in each section, order by workspace
  // number". It is what the map already drew — both map builders sort their
  // workspace ids with `a - b` — and it is pinned here so it cannot regress
  // into string order, where "10" sorts before "9" and the map reads 1 10 2 3.
  const monitors = [
    { id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  // Deliberately handed in the order that would come out wrong if anything
  // sorted these as strings.
  const clients = [1, 10, 2, 9, 3, 8].map((ws, i) => makeClient({
    address: "0xw" + ws, class: "foot", workspace: ws, title: "w" + i
  }));

  const live = panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 480, 240);
  assert.deepStrictEqual(live.monitors[0].workspaces.map((w) => w.id),
    [1, 2, 3, 8, 9, 10],
    "the live map lists a monitor's workspaces in ascending NUMERIC order");

  // And the recorded map, which builds its own list from the stored layout and
  // could sort it differently without anything else noticing.
  const layout = {
    apps: [1, 10, 2, 9, 3, 8].map((ws) => ({
      identityId: "foot", monitorDescription: "eDP-1", workspaceId: ws,
      at: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }
    }))
  };
  const recorded = panel.recordedMapModel(layout, monitors, [], 480, 240);
  assert.deepStrictEqual(recorded.monitors[0].workspaces.map((w) => Number(w.id)),
    [1, 2, 3, 8, 9, 10],
    "the recorded map lists a monitor's workspaces in ascending NUMERIC order");
});

test("negative coordinates are normalized rather than drawn off-canvas", () => {
  const monitors = [
    { id: 0, name: "eDP-1", x: -1920, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 1, name: "DP-2", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  const map = panel.mapGeometry(monitors, 400, 200);
  assert.strictEqual(map.monitors[0].x, 0);
  assert.ok(map.monitors[1].x > 0);
});

test("a disabled monitor is not drawn on top of the real ones", () => {
  // Hyprland parks disabled outputs at 0,0. They still count towards the
  // topology key; they just have no place on a map of the arrangement.
  const monitors = [
    { id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1, disabled: true },
    { id: 1, name: "DP-2", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  const map = panel.mapGeometry(monitors, 400, 200);
  assert.deepStrictEqual(map.monitors.map((m) => m.name), ["DP-2"]);
});

test("a monitor on its side is drawn on its side", () => {
  // hyprctl reports the UNTRANSFORMED mode: a portrait screen is still
  // "2560x1440" with transform 1, and taking that at face value drew a portrait
  // monitor as a landscape one — the single thing a picture of a desk cannot be
  // allowed to get wrong.
  const portrait = { id: 1, name: "DP-3", description: "Dell Portrait", x: 1920, y: 0, width: 2560, height: 1440, scale: 1, transform: 1 };
  assert.deepStrictEqual(panel.logicalSize(portrait), { width: 1440, height: 2560 });

  // Scale still applies, and applies after the swap.
  assert.deepStrictEqual(
    panel.logicalSize({ width: 2880, height: 1800, scale: 2, transform: 3 }),
    { width: 900, height: 1440 });

  // The even transforms are upright (0), upside down (2) and their flipped
  // twins (4, 6): the picture changes, the axes do not.
  [0, 2, 4, 6].forEach((transform) => {
    assert.deepStrictEqual(
      panel.logicalSize({ width: 1920, height: 1080, scale: 1, transform: transform }),
      { width: 1920, height: 1080 }, "transform " + transform + " must not swap the axes");
  });
  [1, 3, 5, 7].forEach((transform) => {
    assert.deepStrictEqual(
      panel.logicalSize({ width: 1920, height: 1080, scale: 1, transform: transform }),
      { width: 1080, height: 1920 }, "transform " + transform + " is a quarter turn");
  });

  // A monitor list without the field at all (an old fixture, a mock) is
  // upright, not undefined-shaped.
  assert.deepStrictEqual(
    panel.logicalSize({ width: 1920, height: 1080, scale: 1 }), { width: 1920, height: 1080 });
});

test("the map places a portrait monitor by its rotated span", () => {
  const monitors = [
    { id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    // Rotated: 1080 wide and 1920 tall on the desk, sitting to the right.
    { id: 1, name: "DP-3", x: 1920, y: 0, width: 1920, height: 1080, scale: 1, transform: 3 }
  ];
  const map = panel.mapGeometry(monitors, 600, 600);
  const laptop = map.monitors[0];
  const portrait = map.monitors[1];

  assert.strictEqual(portrait.sizeLabel, "1080×1920");
  assert.ok(portrait.height > portrait.width, "a portrait monitor is taller than it is wide");
  // One shared scale: the rotated screen is 1080/1920 as wide as the landscape
  // one and 1920/1080 as tall.
  assert.ok(Math.abs(portrait.width / laptop.width - 1080 / 1920) < 0.05);
  assert.ok(Math.abs(portrait.height / laptop.height - 1920 / 1080) < 0.05);
  // The span the whole map is fitted into follows the rotation too — the
  // portrait screen, not the laptop, decides how tall the desk is.
  assert.ok(map.height > laptop.height);
});

test("no monitors at all is an empty map, not a crash", () => {
  assert.deepStrictEqual(panel.mapGeometry([], 400, 200), { scale: 1, width: 0, height: 0, monitors: [] });
  assert.strictEqual(panel.mapGeometry(null, 400, 200).monitors.length, 0);
});

// ------------------------------------- packing the map (the m9u layout repair)
//
// The defect these cover, measured live on a 1440×900 laptop with 7 occupied
// workspaces (docs/evidence/increment-03/m9u): the map was bound by a FIXED
// height, so 70 % of its width sat empty and each workspace came out ~42×86 —
// portrait, for a 16:10 screen — and every chip hit a 24-unit floor, so a 98 %
// window and a 49 % one were drawn identically and two side-by-side tiles were
// drawn on top of each other. Everything below is that story, as arithmetic.

const LAPTOP_ASPECT = 1440 / 900;

test("seven workspaces pack into readable landscape boxes at the monitor's shape", () => {
  const grid = panel.workspaceGridLayout(7, LAPTOP_ASPECT, 600);

  assert.ok(grid.boxW >= 96, `a box is at least readable-width, got ${grid.boxW}`);
  assert.ok(grid.boxW > grid.boxH, "a 16:10 monitor draws a LANDSCAPE workspace box");
  assert.ok(Math.abs(grid.boxW / grid.boxH - LAPTOP_ASPECT) < 0.05,
    "and it is the monitor's shape, not some other rectangle");
  assert.ok(grid.cols * grid.rows >= 7, "every workspace has somewhere to go");
  // The row genuinely fits: this is the clause the old fixed-height layout
  // could not state, because its boxes were sized by the height it had left.
  assert.ok(grid.cols * grid.boxW + (grid.cols - 1) * 6 <= 600);
});

test("the columns are balanced, not greedy", () => {
  // 7 boxes into a strip that holds 5 is two rows either way; 4+3 makes both of
  // them bigger than 5+2 does, and rectangular instead of a staircase.
  const grid = panel.workspaceGridLayout(7, LAPTOP_ASPECT, 600);
  assert.strictEqual(grid.rows, 2);
  assert.strictEqual(grid.cols, 4);
});

test("a narrow section keeps the box readable and spends rows instead", () => {
  const grid = panel.workspaceGridLayout(7, LAPTOP_ASPECT, 300);
  assert.ok(grid.boxW >= 96, `got ${grid.boxW}`);
  assert.ok(grid.rows > 2, "the height grows; the box does not shrink below readable");
});

test("one workspace on a wide panel is a map, not a poster", () => {
  const grid = panel.workspaceGridLayout(1, LAPTOP_ASPECT, 900);
  assert.strictEqual(grid.cols, 1);
  assert.ok(grid.boxW <= 220, `capped, got ${grid.boxW}`);
});

test("no workspaces is an empty grid, and a nonsense aspect falls back to 16:9", () => {
  assert.deepStrictEqual(panel.workspaceGridLayout(0, 1.6, 600), { boxW: 0, boxH: 0, cols: 0, rows: 0 });
  const grid = panel.workspaceGridLayout(2, 0, 600);
  assert.ok(Math.abs(grid.boxW / grid.boxH - 16 / 9) < 0.05);
});

test("monitor sections split the width proportionally and add up to it", () => {
  const widths = panel.monitorSectionWidths([3440, 1440], 600, 6, 112);
  assert.strictEqual(widths.length, 2);
  assert.strictEqual(widths[0] + widths[1] + 6, 600, "the row fills the panel exactly");
  assert.ok(widths[0] > widths[1], "the ultrawide gets the bigger half");
  assert.ok(Math.abs(widths[0] / widths[1] - 3440 / 1440) < 0.15);
});

test("a small monitor next to a huge one still gets a section it can draw in", () => {
  const widths = panel.monitorSectionWidths([5120, 800], 600, 6, 112);
  assert.ok(widths[1] >= 112, `floored, got ${widths[1]}`);
  assert.strictEqual(widths[0] + widths[1] + 6, 600);
});

test("more monitors than the floor allows share equally rather than vanishing", () => {
  const widths = panel.monitorSectionWidths([3440, 1440, 1920], 300, 6, 112);
  assert.strictEqual(widths.length, 3);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, "equal shares");
});

test("pinning one monitor at the floor can push the next one under it too", () => {
  // Pinning is a WHILE loop, not a single pass, because taking a pinned
  // section's width out of the pool shrinks the pool the rest are splitting —
  // which can put a monitor that was fine a moment ago under the floor too.
  // An ultrawide (3440), a monitor (700) and a small screen (250) splitting a
  // 700 px row: round 1 pins the smallest at the floor; recomputed without it,
  // the middle one's proportional share drops under the floor as well and
  // round 2 pins that one too — the ultrawide alone stays proportional.
  const widths = panel.monitorSectionWidths([3440, 700, 250], 700, 6, 112);
  assert.strictEqual(widths.length, 3);
  assert.strictEqual(widths[0] + widths[1] + widths[2] + 6 * 2, 700,
    "sections plus their gaps still fill the row exactly");

  const floor = 112;
  const equalShares = Math.max(...widths) - Math.min(...widths) <= 1;
  widths.forEach((w) => {
    assert.ok(w >= floor || equalShares,
      `a section under the floor is only honest if EVERYONE is (equal shares): ${JSON.stringify(widths)}`);
  });
  // This scenario lands in the pin path, not equal-shares: two of the three
  // sections are pinned at the floor and the ultrawide keeps its lead.
  assert.strictEqual(widths[1], floor);
  assert.strictEqual(widths[2], floor);
  assert.ok(widths[0] > floor, "the section that never got pinned keeps more than the floor");
});

// -------------------------------------- the map's shape: stacked, one scale

// THE THREE THINGS THE HUMAN FOUND ON HIS OWN DESK (gate yxa, 2026-09-11):
// eDP-1 at logical 1440x900 beside DP-1 at logical 2150x900, ten apps watched,
// workspaces 5/6/9 on the laptop and 1/2/3/8/10 on the ultrawide.
//
//   1. "the sizes are uneven" — the laptop's tiles came out 190x120 and the
//      ultrawide's 185x80: the same WIDTH at two different scales, so two
//      monitors of identical logical height drew tiles of different heights.
//   2. "sorting is not 1-10" — the map read 5 6 9 1 2 3 8 10.
//      ANSWERED: the sections stack vertically, one per monitor, laptop first.
//   3. "not really separated" — nothing between the two runs of tiles.
//
// The cause of 1 is the composition, not either function: monitorSectionWidths
// split a row in proportion to logical width, then workspaceGridLayout filled
// each section with as many columns as THAT section could hold — a scale per
// monitor, never compared. mapSectionLayout replaces the split (the sections
// are the full width now) and solves for the one scale every section can draw
// at.
//
// The desk, as the panel sees it: the panel is ~1035 px wide and the map canvas
// ~959 after the card's and the surface's padding.
const DESK_WIDTH = 959;
const DESK = [
  { logicalWidth: 1440, logicalHeight: 900, workspaceCount: 3 },   // eDP-1: ws 5, 6, 9
  { logicalWidth: 2150, logicalHeight: 900, workspaceCount: 5 }    // DP-1: ws 1, 2, 3, 8, 10
];
// The theme's numbers, as the panel hands them in. `sectionPadding: 0` is a map
// with no frame around a section; the frame's own fixtures set it.
const OPTS = {
  tileGap: 6, sectionGap: 12,
  tileMinWidth: 96, tileMaxWidth: 220, tilePadding: 8, sectionPadding: 0
};
// And the same map with a frame around each section (tick 0qd).
const FRAMED = Object.assign({}, OPTS, { sectionPadding: 12 });

test("the sections stack: every one of them is the whole width of the map", () => {
  // "I want two separated sections vertically, one section for laptop and one
  // (or more) for each external monitor" — the human, answering the gate. There
  // is no width to share between sections any more, which is what makes the one
  // scale a minimum over monitors rather than a division over a sum.
  const layout = panel.mapSectionLayout(DESK, DESK_WIDTH, OPTS);
  assert.strictEqual(layout.sections.length, 2);
  for (const s of layout.sections) {
    assert.strictEqual(s.width, DESK_WIDTH, "a section is not the full map width");
  }
});

test("two monitors of the same logical height draw tiles of the same height", () => {
  const layout = panel.mapSectionLayout(DESK, DESK_WIDTH, OPTS);
  const [laptop, ultrawide] = layout.sections;

  // THE ASSERTION THE HUMAN MADE WITH A RED BOX. 900 = 900, so the tiles are
  // the same height — whatever else the arithmetic decides.
  assert.strictEqual(laptop.canvasHeight, ultrawide.canvasHeight,
    `equal logical heights must draw equal tile heights, got ${laptop.canvasHeight}`
    + ` and ${ultrawide.canvasHeight}`);

  // And the widths are NOT equal any more: they are the monitors' own, in
  // proportion. This is the pair that used to be the wrong way round.
  assert.ok(ultrawide.tileWidth > laptop.tileWidth,
    `the ultrawide's tile must be the wider one, got ${laptop.tileWidth}`
    + ` and ${ultrawide.tileWidth}`);
  const drawnRatio = (ultrawide.tileWidth - OPTS.tilePadding)
    / (laptop.tileWidth - OPTS.tilePadding);
  assert.ok(Math.abs(drawnRatio - 2150 / 1440) < 0.02,
    `and wider by exactly the monitors' own ratio, got ${drawnRatio.toFixed(3)}`
    + ` against ${(2150 / 1440).toFixed(3)}`);
});

test("one scale means every tile is its own monitor at that scale", () => {
  const layout = panel.mapSectionLayout(DESK, DESK_WIDTH, OPTS);
  // Asked of the DRAWN numbers rather than of `layout.scale` alone: a scale
  // nobody drew at would agree with itself.
  layout.sections.forEach((s, i) => {
    const drawn = (s.tileWidth - OPTS.tilePadding) / DESK[i].logicalWidth;
    assert.ok(Math.abs(drawn - layout.scale) < 0.005,
      `a tile drawn at ${drawn.toFixed(4)} on a map whose scale is`
      + ` ${layout.scale.toFixed(4)}`);
  });
});

test("no section's row of tiles is wider than the section it is in", () => {
  // The one outcome this function exists to prevent. Checked on both shapes,
  // because the frame takes width away from exactly the row that has to fit.
  for (const opts of [OPTS, FRAMED]) {
    const layout = panel.mapSectionLayout(DESK, DESK_WIDTH, opts);
    for (const s of layout.sections) {
      const row = s.cols * s.tileWidth + opts.tileGap * (s.cols - 1);
      assert.ok(row <= s.width - opts.sectionPadding,
        `a row of ${row} px inside a ${s.width} px section with`
        + ` ${opts.sectionPadding} px of frame: ${JSON.stringify(s)}`);
    }
  }
});

test("the section that sets the scale fills its width; a narrower monitor does not", () => {
  // The honest consequence of one scale on a stack: the busiest, widest monitor
  // uses the whole row and the laptop's three workspaces take the width three
  // laptop-shaped tiles need. The empty width to the right is not a gap to be
  // closed — it is what "this screen has fewer, narrower workspaces" looks
  // like, and the frame is what says the empty width is still its own.
  const layout = panel.mapSectionLayout(DESK, DESK_WIDTH, OPTS);
  const [laptop, ultrawide] = layout.sections;

  const wideRow = ultrawide.cols * ultrawide.tileWidth
    + OPTS.tileGap * (ultrawide.cols - 1);
  assert.ok(wideRow >= DESK_WIDTH - 12,
    `the scale-setting section leaves ${DESK_WIDTH - wideRow} px unused`);

  const laptopRow = laptop.cols * laptop.tileWidth + OPTS.tileGap * (laptop.cols - 1);
  assert.ok(laptopRow < wideRow, "the laptop's three workspaces fill the row too");
});

test("a taller monitor draws proportionally taller tiles — true proportions, between monitors", () => {
  // 1920x1080 above 1440x900: not the same height, and that is the point. The
  // heights must be in the monitors' own ratio, which is what "one scale" means
  // when the logical heights differ.
  const layout = panel.mapSectionLayout([
    { logicalWidth: 1920, logicalHeight: 1080, workspaceCount: 4 },
    { logicalWidth: 1440, logicalHeight: 900, workspaceCount: 4 }
  ], DESK_WIDTH, OPTS);

  const [big, small] = layout.sections;
  assert.ok(big.canvasHeight > small.canvasHeight, "1080 draws taller than 900");
  const heightRatio = big.canvasHeight / small.canvasHeight;
  assert.ok(Math.abs(heightRatio - 1080 / 900) < 0.03,
    `taller by the monitors' own ratio, got ${heightRatio.toFixed(3)}`);
  const widthRatio = (big.tileWidth - OPTS.tilePadding) / (small.tileWidth - OPTS.tilePadding);
  assert.ok(Math.abs(widthRatio - 1920 / 1440) < 0.03,
    `and wider by it too, got ${widthRatio.toFixed(3)}`);
});

test("a shared scale spends a ROW before it draws a tile nobody can read", () => {
  // THE COST OF ONE SCALE, and the clause that keeps it from trading one
  // complaint for another. The scale is set by the BUSIEST section, so a laptop
  // beside a much wider screen full of workspaces draws its own tiles at the
  // ratio of the two monitors' widths — which can be well under the 96 px floor
  // whose whole definition is "narrower than this cannot show two windows side
  // by side". So a section gives a column back and spends a row instead, which
  // is exactly the trade workspaceGridLayout already makes inside one section.
  const layout = panel.mapSectionLayout([
    { logicalWidth: 1440, logicalHeight: 900, workspaceCount: 3 },
    { logicalWidth: 3440, logicalHeight: 1440, workspaceCount: 5 }
  ], DESK_WIDTH, OPTS);

  for (const s of layout.sections) {
    assert.ok(s.tileWidth >= OPTS.tileMinWidth,
      `a tile at ${s.tileWidth} px is under the readable floor:`
      + ` ${JSON.stringify(layout.sections)}`);
  }
  assert.ok(layout.sections[1].cols * layout.sections[1].rows >= 5,
    "every workspace still has somewhere to go");
});

test("a row that buys no scale is not spent — a ten-workspace monitor is not ten rows", () => {
  // The guard that stops the clause above running away. Once the map is pinned
  // at the tile-width CEILING, giving a column back raises nothing: the scale
  // is already as large as a tile is allowed to be. Without this the loop would
  // spend every column it had, one row at a time, for no gain at all.
  const layout = panel.mapSectionLayout([
    { logicalWidth: 800, logicalHeight: 600, workspaceCount: 1 },
    { logicalWidth: 5120, logicalHeight: 2160, workspaceCount: 10 }
  ], DESK_WIDTH, OPTS);

  const busy = layout.sections[1];
  assert.ok(busy.rows <= 4,
    `the busy monitor was reshaped into ${busy.rows} rows of ${busy.cols}`);
  assert.ok(busy.cols >= 2, "and it kept more than one column");
  // The small screen's tile IS under the floor here, and that is the honest
  // answer: it is a sixth of the other monitor's width, and the alternative is
  // the uneven scales the human complained about.
  assert.ok(layout.sections[0].tileWidth >= 1);
});

test("one monitor is what it has always been, to the pixel", () => {
  // With a single monitor there is nothing to share a scale WITH and no section
  // to frame, so the rules are vacuous and the only thing worth guaranteeing is
  // that the acceptance VM's pictures and assertions do not move. The expected
  // side is computed the way the panel computed it before these ticks —
  // workspaceGridLayout, then the delegate's own height from its own width —
  // rather than written as a literal, because a literal in declaration order is
  // a restatement and not an oracle (.tick/learnings.md, tick j18).
  for (const [lw, lh, count, width] of [
    [1440, 900, 7, 600], [1440, 900, 3, 959], [3440, 1440, 10, 700],
    [1920, 1080, 1, 900], [1440, 900, 5, 300]
  ]) {
    const mons = [{ logicalWidth: lw, logicalHeight: lh, workspaceCount: count }];
    const before = panel.workspaceGridLayout(count, lw / lh, width, 6, 96, 220);

    // And it must be unable to notice the frame or the section gap either —
    // both are charged only where they are drawn.
    for (const opts of [OPTS, FRAMED]) {
      const layout = panel.mapSectionLayout(mons, width, opts);
      assert.strictEqual(layout.sections.length, 1);
      const only = layout.sections[0];
      assert.strictEqual(only.tileWidth, before.boxW,
        `${lw}x${lh} x${count} in ${width}: the tile's width moved`);
      assert.strictEqual(only.cols, before.cols, `${lw}x${lh} x${count}: the columns moved`);
      assert.strictEqual(only.rows, before.rows, `${lw}x${lh} x${count}: the rows moved`);
      // The delegate's old binding, restated: the canvas is the tile inside its
      // padding, at the monitor's shape.
      assert.strictEqual(only.canvasHeight,
        Math.max(1, Math.round(Math.max(1, before.boxW - 8) / (lw / lh))),
        `${lw}x${lh} x${count} in ${width}: the tile's canvas height moved`);
      assert.strictEqual(only.width, width, "a lone section is the whole map");
    }
  }
});

test("the frame is paid for out of the scale, not out of the canvas", () => {
  // HUMAN GATE FINDING 3: each section is framed on a multi-monitor desk (tick
  // 0qd), and the frame costs width — which is why the layout is TOLD about it
  // rather than having it drawn on afterwards. A frame added after the scale
  // was solved is a row that overflows the section it is in.
  const framed = panel.mapSectionLayout(DESK, DESK_WIDTH, FRAMED);
  const bare = panel.mapSectionLayout(DESK, DESK_WIDTH, OPTS);

  assert.ok(framed.scale < bare.scale,
    `a framed map draws smaller tiles, got ${framed.scale} against ${bare.scale}`);
  assert.strictEqual(framed.sections[0].canvasHeight, framed.sections[1].canvasHeight,
    "framing must not reintroduce the defect the shared scale fixed");
  for (const s of framed.sections) {
    assert.strictEqual(s.width, DESK_WIDTH, "a framed section is still the full width");
  }
});

test("no monitors, junk monitors and a monitor with no workspaces are answers, not throws", () => {
  assert.deepStrictEqual(panel.mapSectionLayout([], 600, OPTS), { scale: 0, sections: [] });
  assert.deepStrictEqual(panel.mapSectionLayout(null, 600, OPTS), { scale: 0, sections: [] });
  // No options at all: the file's own defaults, not a throw.
  assert.strictEqual(panel.mapSectionLayout(DESK, 600).sections.length, 2);

  // A logical size the read came back without: the fallback aspect, not a
  // division by zero.
  const junk = panel.mapSectionLayout([
    { logicalWidth: 0, logicalHeight: 0, workspaceCount: 2 },
    { logicalWidth: 1440, logicalHeight: 900, workspaceCount: 2 }
  ], 600, OPTS);
  assert.strictEqual(junk.sections.length, 2);
  for (const s of junk.sections) {
    assert.ok(isFinite(s.tileWidth) && isFinite(s.canvasHeight), JSON.stringify(s));
  }

  // A monitor with nothing on it draws no tiles rather than a tile of nothing —
  // and it is still IN the list, because the sections are indexed by the
  // monitor's place in the stack.
  const empty = panel.mapSectionLayout([
    { logicalWidth: 1440, logicalHeight: 900, workspaceCount: 0 },
    { logicalWidth: 2150, logicalHeight: 900, workspaceCount: 4 }
  ], 600, OPTS);
  assert.strictEqual(empty.sections.length, 2);
  assert.strictEqual(empty.sections[0].cols, 0);
  assert.ok(empty.sections[1].tileWidth > 0, "the monitor that HAS workspaces still draws");
});

// --------------------------------------------- the chip floor, and its barrier

// A workspace box at the size the packing above produces on the laptop desk.
const BOX_W = 145;
const BOX_H = 91;

test("a full-screen window fills its workspace box", () => {
  const [full] = panel.chipRectsForCanvas([{ rx: 0, ry: 0, rw: 1, rh: 1 }], BOX_W, BOX_H);
  assert.strictEqual(full.x, 0);
  assert.strictEqual(full.y, 0);
  assert.strictEqual(full.width, BOX_W);
  assert.strictEqual(full.height, BOX_H);
});

test("a half-width window reads as half the box", () => {
  const [half] = panel.chipRectsForCanvas([{ rx: 0, ry: 0, rw: 0.5, rh: 1 }], BOX_W, BOX_H);
  assert.ok(Math.abs(half.width / BOX_W - 0.5) < 0.02,
    `half a screen is half a box, got ${half.width} of ${BOX_W}`);
  // The point of the whole repair: the two are visibly different sizes. Under
  // the old floor both were drawn at the full width of the workspace.
  const [full] = panel.chipRectsForCanvas([{ rx: 0, ry: 0, rw: 0.98, rh: 1 }], BOX_W, BOX_H);
  assert.ok(full.width > half.width * 1.7, "and a 98 % window is nearly twice it");
});

test("two side-by-side tiles are drawn side by side, not on top of each other", () => {
  // The real pair off the live round: ws 8's Remember The Milk (x 12, w 543) and
  // Calendar (x 569, w 859) on a 1440-wide screen.
  const rects = panel.chipRectsForCanvas([
    { rx: 12 / 1440, ry: 0, rw: 543 / 1440, rh: 0.95 },
    { rx: 569 / 1440, ry: 0, rw: 859 / 1440, rh: 0.95 }
  ], BOX_W, BOX_H);

  const [left, right] = rects;
  assert.ok(left.x + left.width <= right.x,
    `the left tile must end before the right one begins: ${JSON.stringify(rects)}`);
  assert.ok(Math.abs(left.width / BOX_W - 543 / 1440) < 0.03, "and each keeps its own proportion");
  assert.ok(Math.abs(right.width / BOX_W - 859 / 1440) < 0.03);
});

test("the floor makes a sliver clickable without swallowing its neighbour", () => {
  // Two 2 %-wide windows a hair apart: both want the 16 px floor, and 16 px is
  // wider than the gap between them. Each may grow to the midpoint, no further.
  const rects = panel.chipRectsForCanvas([
    { rx: 0, ry: 0, rw: 0.02, rh: 0.02 },
    { rx: 0.03, ry: 0, rw: 0.02, rh: 0.02 }
  ], BOX_W, BOX_H);

  assert.ok(rects[0].x + rects[0].width <= rects[1].x, "no superimposing");
  assert.ok(rects[0].height >= 10 && rects[1].height >= 10,
    "the axis they are NOT separated on still gets the floor");
});

test("a chain of three slivers still resolves non-overlapping when they compete for the same gaps", () => {
  // Not a single pair sharing one gap — three tiles in a row, where the middle
  // one's barrier with its LEFT neighbour and its barrier with its RIGHT
  // neighbour both have to hold at once. On a 24×10 canvas with three
  // near-zero-width slivers at x = 0, 7 and 8 (the last two nearly touching),
  // the floor (16 px, CHIP_MIN_WIDTH) is simply not there to give: the first
  // two are squeezed to 4 px apiece and only the third — with an open gap to
  // the canvas edge — reaches the floor whole. The min-size floor is a wish,
  // not a guarantee; crowding always wins.
  const rects = panel.chipRectsForCanvas([
    { rx: 0 / 24, ry: 0, rw: 0.3 / 24, rh: 1 },
    { rx: 7 / 24, ry: 0, rw: 0.3 / 24, rh: 1 },
    { rx: 8 / 24, ry: 0, rw: 0.3 / 24, rh: 1 }
  ], 24, 10);

  assert.strictEqual(rects.length, 3);
  // Pairwise non-overlap, left to right.
  assert.ok(rects[0].x + rects[0].width <= rects[1].x, `0 vs 1 overlap: ${JSON.stringify(rects)}`);
  assert.ok(rects[1].x + rects[1].width <= rects[2].x, `1 vs 2 overlap: ${JSON.stringify(rects)}`);
  assert.ok(rects[0].x + rects[0].width <= rects[2].x, `0 vs 2 overlap: ${JSON.stringify(rects)}`);
  // No rect ever grows past the floor it asked for (16 px) — the barrier can
  // only take width away, never hand out more than was wanted.
  rects.forEach((r) => assert.ok(r.width <= 16, `width past the floor: ${JSON.stringify(r)}`));
  // The crowded pair never reaches the floor; the one with room to itself does.
  assert.strictEqual(rects[0].width, 4);
  assert.strictEqual(rects[1].width, 4);
  assert.strictEqual(rects[2].width, 16);
});

test("a lone sliver is drawn at the floor, which is what makes it clickable", () => {
  const [tiny] = panel.chipRectsForCanvas([{ rx: 0.4, ry: 0.4, rw: 0.01, rh: 0.01 }], BOX_W, BOX_H);
  assert.strictEqual(tiny.width, 16);
  assert.strictEqual(tiny.height, 10);
});

test("windows that really overlap on the screen still overlap on the map", () => {
  // A float over a tile. The map is a picture of the desktop, and this is what
  // the desktop looks like — the barrier is for windows that are APART.
  const rects = panel.chipRectsForCanvas([
    { rx: 0, ry: 0, rw: 1, rh: 1 },
    { rx: 0.25, ry: 0.25, rw: 0.5, rh: 0.5 }
  ], BOX_W, BOX_H);
  assert.ok(rects[1].x > rects[0].x && rects[1].x < rects[0].x + rects[0].width);
});

test("chip rects answer index for index, with null where there was no geometry", () => {
  const rects = panel.chipRectsForCanvas([{ rx: 0, ry: 0, rw: 0.5, rh: 1 }, null], BOX_W, BOX_H);
  assert.strictEqual(rects.length, 2);
  assert.strictEqual(rects[1], null);
  assert.deepStrictEqual(panel.chipRectsForCanvas(null, BOX_W, BOX_H), []);
});

test("chip rects take the map model's slots as they come", () => {
  // The panel hands this function the workspace's slots, not a list it had to
  // unpack first — a slot carries its rect, and a group slot carries its lead
  // tab's rect.
  const map = panel.liveMapModel(clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 600, 360);
  const workspace = map.monitors[0].workspaces.find((w) => w.fallback !== true);
  assert.ok(workspace, "the laptop fixture has geometry");
  const rects = panel.chipRectsForCanvas(workspace.slots, BOX_W, BOX_H);
  assert.strictEqual(rects.length, workspace.slots.length);
  rects.forEach((r) => {
    assert.ok(r.width >= 1 && r.x >= 0 && r.x + r.width <= BOX_W);
    assert.ok(r.height >= 1 && r.y >= 0 && r.y + r.height <= BOX_H);
  });
});

// ------------------------------------------------- clamping at canvas edges
//
// The three cases above (floor, barrier, real overlap) all sit well inside the
// canvas. These three sit AT its edges, where chipRectsForCanvas's own defensive
// clamp (never mind the barrier math) is what keeps a chip on-screen.

test("a malformed off-canvas rect is clamped onto the canvas, never drawn negative", () => {
  // rx/ry below 0 and rw/rh that would spill further past — a stale or buggy
  // fraction rect must still land ON the canvas, at the floor, not at a
  // negative x/y no delegate can draw.
  const [r] = panel.chipRectsForCanvas([{ rx: -0.5, ry: -0.4, rw: 0.66, rh: 0.6 }], 100, 50);
  assert.strictEqual(r.x, 0);
  assert.strictEqual(r.y, 0);
  assert.strictEqual(r.width, panel.CHIP_MIN_WIDTH);
  assert.strictEqual(r.height, panel.CHIP_MIN_HEIGHT);
});

test("a chip against the true right/bottom edge grows toward the floor without spilling past the canvas", () => {
  // A lone sliver a hair from the far corner: there is no neighbour to barrier
  // against, only the canvas edge itself, so the floor must grow BACKWARDS
  // (left, up) rather than push x + width past what the canvas can draw.
  const [r] = panel.chipRectsForCanvas([{ rx: 0.99, ry: 0.98, rw: 0.005, rh: 0.02 }], 100, 50);
  assert.strictEqual(r.x + r.width, 100, "the floor grows left here, never past the right edge");
  assert.strictEqual(r.y + r.height, 50, "and up, never past the bottom edge");
  assert.strictEqual(r.width, panel.CHIP_MIN_WIDTH);
  assert.strictEqual(r.height, panel.CHIP_MIN_HEIGHT);
});

test("a fraction rect that claims past the canvas edge is cropped, not drawn oversize", () => {
  // rx 0.5 + rw 0.7 claims out to 120% of the canvas — the real window is not
  // that big, the fraction is stale, and the chip must still end exactly at
  // the edge with no floor involved (the cropped size is already above it).
  const [r] = panel.chipRectsForCanvas([{ rx: 0.5, ry: 0.3, rw: 0.7, rh: 0.5 }], 100, 50);
  assert.strictEqual(r.x, 50);
  assert.strictEqual(r.width, 50);
  assert.strictEqual(r.y, 15);
  assert.strictEqual(r.height, 25);
});

test("the label threshold is the ladder's top tier and nothing else", () => {
  // chipLabelVisible is GONE. It decided the label on width alone, which is a
  // second threshold to disagree with the one the ladder already applies, and
  // the panel now draws a name exactly when chipTreatment says "pill".
  assert.strictEqual(panel.chipLabelVisible, undefined);
  assert.strictEqual(panel.CHIP_LABEL_MIN_WIDTH, undefined);

  // The cases that test asked about, answered by the ladder instead. A chip too
  // narrow for a name is not a pill, so it has none — and it keeps its hover,
  // its click and its tooltip, where the whole story already was.
  assert.notStrictEqual(panel.chipTreatment(20, 60), "pill");
  // A fused tab group divides its pill: three tabs in a 90 px slot get 30 each,
  // and 30 px is not a pill however tall the slot is.
  assert.notStrictEqual(panel.chipTreatment(90 / 3, 60), "pill");
  // Width alone was never enough: the old threshold called 140 px a label at
  // any height, and a 140x20 chip has nowhere to put one.
  assert.notStrictEqual(panel.chipTreatment(140, 20), "pill");
  assert.strictEqual(panel.chipTreatment(140, 56), "pill");
});

// -------------------------------------------------- chip treatment (drawn size)

test("chipTreatment picks a tier from the chip's DRAWN size, checking both axes independently", () => {
  // Both dimensions must clear a tier's cutoffs — a wide-but-short chip is not
  // a pill just because it is wide, and a tall-but-narrow one is not a badge
  // just because it is tall.
  assert.strictEqual(panel.chipTreatment(140, 56), "pill");
  assert.strictEqual(panel.chipTreatment(139, 56), "badge", "one px under the pill WIDTH cutoff");
  assert.strictEqual(panel.chipTreatment(140, 55), "badge", "one px under the pill HEIGHT cutoff");
  assert.strictEqual(panel.chipTreatment(300, 55), "badge", "wide but short: no pill");
  assert.strictEqual(panel.chipTreatment(139, 200), "badge", "tall but narrow: no pill either");

  assert.strictEqual(panel.chipTreatment(56, 40), "badge");
  assert.strictEqual(panel.chipTreatment(55, 40), "veiled", "one px under the badge WIDTH cutoff");
  assert.strictEqual(panel.chipTreatment(56, 39), "veiled", "one px under the badge HEIGHT cutoff");

  assert.strictEqual(panel.chipTreatment(24, 16), "veiled");
  assert.strictEqual(panel.chipTreatment(23, 16), "field", "one px under the veiled WIDTH cutoff");
  assert.strictEqual(panel.chipTreatment(24, 15), "field", "one px under the veiled HEIGHT cutoff");
});

test("the strip tier introduces no number of its own — it is two ratified ones", () => {
  // The point of the whole design. The four cutoffs were ratified by a human
  // against rendered chips; a fifth pair invented to rescue the stacked rows
  // would be a guess sitting beside four measurements. So "room for a word
  // across" is the width at which a name was ratified to fit beside an icon, and
  // "room for one line down" is the ladder's own floor for there being anything
  // to see. If either moves, the strip moves with it, and this line says so.
  assert.strictEqual(panel.CHIP_STRIP_MIN_WIDTH, panel.CHIP_PILL_MIN_WIDTH);
  assert.strictEqual(panel.CHIP_STRIP_MIN_HEIGHT, panel.CHIP_VEILED_MIN_HEIGHT);
});

test("a wide chip only one line tall is a strip, and draws its name", () => {
  // THE FALLBACK STACK'S OWN SHAPE. A stacked row is canvas-wide and a fixed
  // 17 px tall (Panel.qml stackRowHeight), so it can never clear the badge's
  // 40 px however wide the map gets. Under a ladder that demands both axes it
  // was `veiled` — a nameless icon under a 55% veil — for every app on the
  // Recorded tab, which is strictly less than the width-only threshold it
  // replaced said. This is the tier that gives it its name back.
  assert.strictEqual(panel.chipTreatment(210, 17), "strip");

  // The two edges of the tier, one pixel apart on each axis.
  assert.strictEqual(panel.chipTreatment(140, 16), "strip");
  assert.strictEqual(panel.chipTreatment(139, 16), "veiled", "one px under the strip WIDTH cutoff");
  assert.strictEqual(panel.chipTreatment(140, 15), "field", "one px under the strip HEIGHT cutoff");
  // ...and `field` rather than `veiled` there because 15 is under the veiled
  // height too. The strip's floor IS the veiled floor, so nothing falls between.

  // The tier is asked LAST of the drawing tiers, and that is its safety: a size
  // that already earns a badge keeps its badge, however wide it is. A ratified
  // both-axes answer is never overturned by the rescue.
  assert.strictEqual(panel.chipTreatment(300, 55), "badge", "still the ratified answer");
  assert.strictEqual(panel.chipTreatment(300, 40), "badge");
  assert.strictEqual(panel.chipTreatment(300, 39), "strip", "one px below the badge, and now wide-and-short");

  // So every strip is wider than a pill and shorter than a badge, by
  // construction — the short-and-wide corner and nothing else.
  for (const [w, h] of [[140, 16], [210, 17], [1000, 39], [300, 20]]) {
    assert.strictEqual(panel.chipTreatment(w, h), "strip");
    assert.ok(w >= panel.CHIP_PILL_MIN_WIDTH && h < panel.CHIP_BADGE_MIN_HEIGHT);
  }
});

test("the strip changes nothing a positioned chip was already answered", () => {
  // The evidence, rather than the argument. The old ladder is restated here —
  // deliberately, the way the acceptance test restates the cutoffs in jq, so
  // this compares against the ratified answer and not against the code under
  // test — and every size on a fine grid must still get it, EXCEPT in the
  // corner the strip was added for.
  const before = (w, h) => {
    if (w >= 140 && h >= 56) return "pill";
    if (w >= 56 && h >= 40) return "badge";
    if (w >= 24 && h >= 16) return "veiled";
    return "field";
  };
  let changed = 0;
  for (let w = 0; w <= 400; w++) {
    for (let h = 0; h <= 200; h++) {
      const now = panel.chipTreatment(w, h);
      const was = before(w, h);
      if (now === was) continue;
      changed++;
      // Only ever veiled -> strip, only ever in the corner, and only ever a
      // chip GAINING its name. Nothing is demoted and no tier is redrawn.
      assert.strictEqual(was, "veiled", `${w}x${h} was ${was}`);
      assert.strictEqual(now, "strip", `${w}x${h} is now ${now}`);
      assert.ok(w >= 140 && h >= 16 && h < 40, `${w}x${h} is outside the wide-and-short corner`);
    }
  }
  // And the corner is not empty, so the loop above is not vacuously green.
  assert.strictEqual(changed, (400 - 140 + 1) * (40 - 16));
});

test("a chip at the chipRectsForCanvas floor earns the field treatment", () => {
  // The floor is a real state, not a degenerate one: chipRectsForCanvas grows
  // every resolved rect to at least CHIP_MIN_WIDTH x CHIP_MIN_HEIGHT, so a
  // terminal occupying 8% of an ultrawide really is drawn at exactly this size.
  // It is a clickable rectangle with a tooltip and nothing else on it — no
  // room for an icon, let alone a name — and the ladder has to say so.
  assert.strictEqual(
    panel.chipTreatment(panel.CHIP_MIN_WIDTH, panel.CHIP_MIN_HEIGHT), "field");
  // Which is only true because the floor sits BELOW the veiled cutoff. If a
  // future floor were raised past it, the tier at the floor changes with it and
  // this line is where that shows up.
  assert.ok(panel.CHIP_MIN_WIDTH < panel.CHIP_VEILED_MIN_WIDTH
    || panel.CHIP_MIN_HEIGHT < panel.CHIP_VEILED_MIN_HEIGHT);
});

test("chipTreatment never throws on a degenerate size — it answers field", () => {
  assert.strictEqual(panel.chipTreatment(0, 0), "field");
  assert.strictEqual(panel.chipTreatment(-10, -10), "field");
  assert.strictEqual(panel.chipTreatment(200, -5), "field");
  assert.strictEqual(panel.chipTreatment("wide", 100), "field");
  assert.strictEqual(panel.chipTreatment(undefined, undefined), "field");
  assert.strictEqual(panel.chipTreatment(NaN, 100), "field");
});

// ------------------------------------------------- the focused workspace badge

test("only the focused monitor's active workspace is the focused one", () => {
  const monitors = [
    { name: "eDP-1", focused: false, activeWorkspace: { id: 1, name: "1" } },
    { name: "DP-2", focused: true, activeWorkspace: { id: 7, name: "7" } }
  ];
  // Every monitor has an active workspace; only one of them is in front of the
  // user, and filling all three badges would say "you are here" three times.
  assert.strictEqual(panel.focusedWorkspaceKey(monitors), "DP-2/7");
  // Monitor-qualified, because a stale recording can name one workspace id
  // under two monitors and only one of them is the one being looked at.
  assert.notStrictEqual(panel.focusedWorkspaceKey(monitors), panel.workspaceKey("eDP-1", 7));
  assert.strictEqual(panel.workspaceKey("DP-2", 7), "DP-2/7");
});

test("no focus is a real answer, and it fills no badge", () => {
  // A headless output set is the live case, and it is legitimate: nothing is
  // filled, which is honest rather than arbitrary.
  assert.strictEqual(panel.focusedWorkspaceKey([
    { name: "eDP-1", focused: false, activeWorkspace: { id: 1 } }
  ]), "");
  // Focused, but the read came back without the field.
  assert.strictEqual(panel.focusedWorkspaceKey([{ name: "eDP-1", focused: true }]), "");
  assert.strictEqual(panel.focusedWorkspaceKey([
    { name: "eDP-1", focused: true, activeWorkspace: { name: "7" } }
  ]), "");
  // A disabled monitor cannot be the one in front of anybody.
  assert.strictEqual(panel.focusedWorkspaceKey([
    { name: "eDP-1", focused: true, disabled: true, activeWorkspace: { id: 3 } }
  ]), "");
  assert.strictEqual(panel.focusedWorkspaceKey([]), "");
  assert.strictEqual(panel.focusedWorkspaceKey(null), "");
});

test("the real laptop fixture maps to one monitor with its workspaces", () => {
  const map = panel.liveMapModel(clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 480, 240);
  assert.strictEqual(map.monitors.length, 1);
  assert.strictEqual(map.monitors[0].shortLabel, "Laptop");
  assert.ok(map.monitors[0].workspaces.length > 0, "the fixture has windows open");
});

// --------------------------------------------------------------------- chips

test("a watched window is a named chip, an unwatched one is grey", () => {
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1 })];
  const monitors = [{ id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];

  const watched = panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 400, 200);
  const watchedChip = watched.monitors[0].workspaces[0].slots[0].chips[0];
  assert.strictEqual(watchedChip.watched, true);
  assert.strictEqual(watchedChip.identityId, "terminal");

  const none = panel.liveMapModel(clients, monitors, resolver([]), null, 400, 200);
  const greyChip = none.monitors[0].workspaces[0].slots[0].chips[0];
  assert.strictEqual(greyChip.watched, false);
  assert.strictEqual(greyChip.identityId, "");
  // It still has to say what it is — an unnamed grey box is not clickable UI.
  assert.strictEqual(greyChip.name, "Foot");
});

test("a tab group renders as ONE fused slot, in tab order", () => {
  const order = ["0xaaa", "0xbbb"];
  const clients = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2, grouped: order }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: order })
  ];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const map = panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 400, 200);
  const slots = map.monitors[0].workspaces[0].slots;

  assert.strictEqual(slots.length, 1, "two grouped windows are one slot, not two chips side by side");
  assert.strictEqual(slots[0].group, true);
  // Tab order is client.grouped's order, which here is deliberately the
  // reverse of the order hyprctl lists the clients in.
  assert.deepStrictEqual(slots[0].chips.map((c) => c.identityId), ["terminal", "browser"]);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.tabIndex), [0, 1]);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.groupSize), [2, 2]);
});

test("a group of one is a plain chip — there is nothing to fuse it with", () => {
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, grouped: ["0xaaa"] })];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const map = panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 400, 200);
  assert.strictEqual(map.monitors[0].workspaces[0].slots[0].group, false);
});

test("special workspaces and classless windows stay off the map", () => {
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: { id: -99, name: "special:magic" } }),
    makeClient({ address: "0xbbb", class: "", workspace: 1 }),
    makeClient({ address: "0xccc", class: "foot", workspace: 1 })
  ];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const map = panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 400, 200);
  const chips = map.monitors[0].workspaces.reduce(
    (all, ws) => all.concat(ws.slots.reduce((s, slot) => s.concat(slot.chips), [])), []);
  assert.deepStrictEqual(chips.map((c) => c.address), ["0xccc"]);
});

test("a drifted chip says where the recording wants it", () => {
  const monitors = [
    { id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 1, name: "DP-2", description: "Ultrawide", x: 1920, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  const recorded = [makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 1 })];
  const layout = engine.buildLayout(recorded, monitors, IDENTITIES, AT);
  // Same app, now on the laptop's workspace 1.
  const live = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, monitor: 0 })];
  const drift = engine.driftOf(live, monitors, layout, IDENTITIES);

  const map = panel.liveMapModel(live, monitors, resolver(IDENTITIES), drift, 400, 200);
  const chip = map.monitors[0].workspaces[0].slots[0].chips[0];
  assert.strictEqual(chip.drifted, true);
  assert.strictEqual(chip.driftTo, "DP-2 · ws 2");
});

// ------------------------------------------------------------- recorded view

test("the recorded view renders closed apps as ghosts", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const recordedIds = layout.apps.map((a) => a.identityId);
  assert.ok(recordedIds.length >= 2, "the fixture records more than one app");

  // Only the first one is still running.
  const map = panel.recordedMapModel(layout, monitorsLaptop, [recordedIds[0]], 480, 240);
  const chips = map.monitors[0].workspaces.reduce(
    (all, ws) => all.concat(ws.slots.reduce((s, slot) => s.concat(slot.chips), [])), []);

  const byId = {};
  chips.forEach((c) => { byId[c.identityId] = c; });
  assert.strictEqual(byId[recordedIds[0]].ghost, false);
  assert.strictEqual(byId[recordedIds[1]].ghost, true,
    "a recorded layout that hid its own closed apps would look like it had forgotten them");
});

test("a recorded group keeps its tab order in the recorded view", () => {
  const order = ["0xaaa", "0xbbb"];
  const clients = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2, grouped: order }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: order })
  ];
  const monitors = [{ id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const layout = engine.buildLayout(clients, monitors, IDENTITIES, AT);
  const map = panel.recordedMapModel(layout, monitors, ["terminal", "browser"], 400, 200);
  const slots = map.monitors[0].workspaces[0].slots;

  assert.strictEqual(slots.length, 1);
  assert.strictEqual(slots[0].group, true);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.identityId), ["terminal", "browser"]);
});

// ------------------------------------------------ true-proportion window rects

// One landscape monitor at the origin, and a second one beside it. Both are
// scale 1 so the numbers in the tests are the numbers on the desk.
const LEFT = { id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
const RIGHT = { id: 1, name: "DP-2", description: "Ultrawide", x: 1920, y: 0, width: 1920, height: 1080, scale: 1 };

function onlyWorkspace(map, monitorIndex) {
  return map.monitors[monitorIndex === undefined ? 0 : monitorIndex].workspaces[0];
}

test("a window half the monitor wide gets half the workspace box", () => {
  // The whole promise of the map: the picture is to scale, so a half-width
  // window is a half-width chip and the user can recognise their own desktop
  // in it rather than reading a list of equal boxes.
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] })];
  const map = panel.liveMapModel(clients, [LEFT], resolver(IDENTITIES), null, 400, 200);
  const workspace = onlyWorkspace(map);

  assert.strictEqual(workspace.fallback, false, "the window has geometry, so nothing falls back");
  assert.deepStrictEqual(workspace.slots[0].rect, { rx: 0, ry: 0, rw: 0.5, rh: 1 });
  assert.deepStrictEqual(workspace.slots[0].chips[0].rect, workspace.slots[0].rect);
  // And the box it is drawn in is the monitor's own shape.
  assert.ok(Math.abs(workspace.aspect - 1920 / 1080) < 1e-9);
});

test("a window on the second monitor is placed inside THAT monitor", () => {
  // client.at is GLOBAL layout space. Without subtracting the monitor's origin
  // every window on every screen but the leftmost lands outside its own box —
  // the failure that does not look like a rounding error.
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 5, monitor: 1, at: [2400, 540], size: [960, 540] })
  ];
  const map = panel.liveMapModel(clients, [LEFT, RIGHT], resolver(IDENTITIES), null, 400, 200);
  // mapGeometry orders left to right, so the second box is the right monitor.
  const workspace = onlyWorkspace(map, 1);
  assert.deepStrictEqual(workspace.slots[0].rect, { rx: 0.25, ry: 0.5, rw: 0.5, rh: 0.5 });
});

test("a rotated monitor measures its windows against its rotated span", () => {
  // hyprctl reports the UNTRANSFORMED mode, so a portrait screen is still
  // "2560x1440" with transform 1. Measuring a window against that would put a
  // window covering the bottom half of the screen at 89% down a box that is not
  // even the right shape.
  const portrait = { id: 0, name: "DP-3", description: "Portrait", x: 0, y: 0, width: 2560, height: 1440, scale: 1, transform: 1 };
  assert.deepStrictEqual(panel.logicalRect(portrait), { x: 0, y: 0, width: 1440, height: 2560 });

  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 1280], size: [1440, 1280] })];
  const map = panel.liveMapModel(clients, [portrait], resolver(IDENTITIES), null, 400, 400);
  const workspace = onlyWorkspace(map);
  assert.deepStrictEqual(workspace.slots[0].rect, { rx: 0, ry: 0.5, rw: 1, rh: 0.5 });
  assert.ok(workspace.aspect < 1, "a portrait workspace box is taller than it is wide");
});

test("a HiDPI monitor measures in logical pixels, like the layout does", () => {
  // The laptop fixture is 2880x1800 at scale 2 — 1440x900 of layout space, and
  // client.at/size are in that space. Dividing by the pixel mode would draw
  // every window at half size.
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [720, 0], size: [720, 900] })];
  const map = panel.liveMapModel(clients, monitorsLaptop, resolver(IDENTITIES), null, 400, 200);
  assert.deepStrictEqual(onlyWorkspace(map).slots[0].rect, { rx: 0.5, ry: 0, rw: 0.5, rh: 1 });
});

test("a window with no geometry drops its whole workspace to the equal slots", () => {
  // A hyprctl read without at/size, or a field that came back as something
  // other than a finite pair. Mixing one unplaceable window in with positioned
  // ones would draw it on top of whatever happens to be under it, so the
  // workspace says so and the panel keeps its old column for that box.
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 1, at: null, size: [960, 1080] }),
    makeClient({ address: "0xccc", class: "chromium", workspace: 2, at: [0, 0], size: [1920, 1080] })
  ];
  const map = panel.liveMapModel(clients, [LEFT], resolver(IDENTITIES), null, 400, 200);
  const [first, second] = map.monitors[0].workspaces;

  assert.strictEqual(first.id, 1);
  assert.strictEqual(first.fallback, true, "one window without geometry, one fallback workspace");
  assert.strictEqual(first.slots.find((s) => s.chips[0].address === "0xbbb").rect, null);
  // The one that DOES have geometry keeps it — the flag is the branch, not a
  // reason to throw the numbers away.
  assert.deepStrictEqual(first.slots.find((s) => s.chips[0].address === "0xaaa").rect,
    { rx: 0, ry: 0, rw: 0.5, rh: 1 });

  // The other workspace is untouched: fallback is per workspace, not per map.
  assert.strictEqual(second.fallback, false);
  assert.deepStrictEqual(second.slots[0].rect, { rx: 0, ry: 0, rw: 1, rh: 1 });
});

test("a fused tab group is ONE rect, and still knows its tabs", () => {
  const order = ["0xaaa", "0xbbb"];
  const clients = [
    // Listed in the reverse of the tab order, as hyprctl would.
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2, grouped: order, at: [960, 0], size: [960, 1080] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: order, at: [960, 0], size: [960, 1080] })
  ];
  const map = panel.liveMapModel(clients, [LEFT], resolver(IDENTITIES), null, 400, 200);
  const slots = onlyWorkspace(map).slots;

  assert.strictEqual(slots.length, 1, "a tab group is one window's worth of screen");
  assert.deepStrictEqual(slots[0].rect, { rx: 0.5, ry: 0, rw: 0.5, rh: 1 });
  // The lead tab's rect, and the tab strip is untouched by any of this.
  assert.deepStrictEqual(slots[0].rect, slots[0].chips[0].rect);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.identityId), ["terminal", "browser"]);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.tabIndex), [0, 1]);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.groupSize), [2, 2]);
});

test("a window hanging off the edge is cropped, not dropped", () => {
  // A floating window dragged half off the left of the screen. It is still on
  // this screen, and the map is a picture of where things are.
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, floating: true, at: [-480, 0], size: [960, 1080] })
  ];
  const map = panel.liveMapModel(clients, [LEFT], resolver(IDENTITIES), null, 400, 200);
  assert.deepStrictEqual(onlyWorkspace(map).slots[0].rect, { rx: 0, ry: 0, rw: 0.25, rh: 1 });

  // Entirely off the screen there is nothing left to draw, and it joins the
  // null-geometry windows rather than being drawn as a sliver at the edge.
  const gone = panel.liveMapModel(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [-2000, 0], size: [500, 500] })],
    [LEFT], resolver(IDENTITIES), null, 400, 200);
  assert.strictEqual(onlyWorkspace(gone).slots[0].rect, null);
  assert.strictEqual(onlyWorkspace(gone).fallback, true);
});

test("the recorded map draws its ghosts where the recording put them", () => {
  const recordedClients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 4, at: [0, 0], size: [640, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 4, at: [640, 0], size: [1280, 1080] })
  ];
  const layout = engine.buildLayout(recordedClients, [LEFT], IDENTITIES, AT);
  // Only the terminal is running, so the editor is a ghost — and a ghost still
  // has a place, which is the whole reason the recorded view exists.
  const map = panel.recordedMapModel(layout, [LEFT], ["terminal"], 400, 200);
  const workspace = onlyWorkspace(map);

  assert.strictEqual(workspace.fallback, false);
  const byId = {};
  workspace.slots.forEach((slot) => { byId[slot.chips[0].identityId] = slot; });
  assert.deepStrictEqual(byId.terminal.rect, { rx: 0, ry: 0, rw: 1 / 3, rh: 1 });
  assert.strictEqual(byId.editor.chips[0].ghost, true);
  assert.deepStrictEqual(byId.editor.rect, { rx: 1 / 3, ry: 0, rw: 2 / 3, rh: 1 });
});

test("a v1 recording has no geometry, and says so instead of guessing", () => {
  // Everything recorded before schema v2 has at/size null. There is no honest
  // rectangle to draw for it, so the workspace falls back to equal slots — the
  // layout the panel drew before rects existed.
  const layout = {
    topologyKey: LAPTOP_KEY,
    recordedAt: AT,
    apps: [
      { identityId: "terminal", monitorDescription: "Laptop", workspaceId: 1, floating: false, group: null },
      { identityId: "editor", monitorDescription: "Laptop", workspaceId: 1, floating: false, group: null, at: null, size: null }
    ]
  };
  const map = panel.recordedMapModel(layout, [LEFT], [], 400, 200);
  const workspace = onlyWorkspace(map);
  assert.strictEqual(workspace.fallback, true);
  assert.ok(workspace.slots.every((s) => s.rect === null));
  // The aspect is a fact about the monitor, so it survives the fallback and the
  // box is still drawn the right shape.
  assert.ok(Math.abs(workspace.aspect - 1920 / 1080) < 1e-9);
});

test("a recorded group is one rect, taken from the LEAD tab", () => {
  const order = ["0xaaa", "0xbbb"];
  const clients = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2, grouped: order, at: [0, 540], size: [1920, 540] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: order, at: [0, 540], size: [1920, 540] })
  ];
  const layout = engine.buildLayout(clients, [LEFT], IDENTITIES, AT);
  const map = panel.recordedMapModel(layout, [LEFT], ["terminal", "browser"], 400, 200);
  const slots = onlyWorkspace(map).slots;

  assert.strictEqual(slots.length, 1);
  assert.deepStrictEqual(slots[0].chips.map((c) => c.identityId), ["terminal", "browser"]);
  assert.deepStrictEqual(slots[0].rect, slots[0].chips[0].rect);
  assert.deepStrictEqual(slots[0].rect, { rx: 0, ry: 0.5, rw: 1, rh: 0.5 });
});

test("windowRect refuses anything that is not a finite pair", () => {
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.strictEqual(panel.windowRect(null, [10, 10], rect), null);
  assert.strictEqual(panel.windowRect([0, 0], null, rect), null);
  assert.strictEqual(panel.windowRect([0, 0, 0], [10, 10], rect), null);
  assert.strictEqual(panel.windowRect([0, NaN], [10, 10], rect), null);
  assert.strictEqual(panel.windowRect([0, 0], [0, 500], rect), null, "a zero-width window has nothing to draw");
  assert.strictEqual(panel.windowRect([0, 0], [10, 10], { x: 0, y: 0, width: 0, height: 1080 }), null);
  // Strings, as hyprctl has been known to emit — coerced, exactly as the
  // engine's record side coerces them.
  assert.deepStrictEqual(panel.windowRect(["0", "0"], ["960", "1080"], rect), { rx: 0, ry: 0, rw: 0.5, rh: 1 });
});

test("the real laptop fixture places every one of its windows to scale", () => {
  const map = panel.liveMapModel(clientsLaptop, monitorsLaptop, resolver(IDENTITIES), null, 480, 240);
  const workspaces = map.monitors[0].workspaces;
  assert.ok(workspaces.length > 0);
  workspaces.forEach((workspace) => {
    assert.strictEqual(workspace.fallback, false, "ws " + workspace.id + " came off a v2 read");
    workspace.slots.forEach((slot) => {
      assert.ok(slot.rect, "every slot on ws " + workspace.id + " has a rect");
      assert.ok(slot.rect.rx >= 0 && slot.rect.rx + slot.rect.rw <= 1 + 1e-9, "inside its own box horizontally");
      assert.ok(slot.rect.ry >= 0 && slot.rect.ry + slot.rect.rh <= 1 + 1e-9, "and vertically");
    });
  });
});

// ----------------------------------------------------------------- app rows

test("the flat list mirrors the map, in the map's reading order", () => {
  // Watch only half of the desktop, so the sort has two kinds of row and can be
  // caught segregating them: the list is a MIRROR of the map, and a mirror that
  // floats the ticked apps to the top matches nothing above it.
  const halfWatched = IDENTITIES.filter((i) => i.id === "terminal" || i.id === "editor");
  const rows = panel.appRows(clientsLaptop, monitorsLaptop, resolver(halfWatched), null, null, halfWatched);

  // One monitor in this fixture, so the whole list is workspace order — and
  // within a workspace, position order.
  const workspaces = rows.map((r) => Number(/ws (\d+)/.exec(r.position)[1]));
  assert.deepStrictEqual(workspaces, workspaces.slice().sort((a, b) => a - b),
    "workspaces climb, they do not jump about: " + JSON.stringify(rows.map((r) => r.position)));
  // Within workspace 8 the left window (RTM at x=12) comes before the right one
  // (Calendar at x=618).
  const ws8 = rows.filter((r) => r.position.indexOf("ws 8") !== -1).map((r) => r.className);
  assert.deepStrictEqual(ws8, [
    "chrome-www.rememberthemilk.com__app_-Profile_1",
    "chrome-calendar.google.com__calendar_u_0_r-Profile_1"
  ]);

  // And the watched rows are where their windows are, not at the top.
  assert.ok(rows.some((r) => r.watched) && rows.some((r) => !r.watched));
  const firstUnwatched = rows.findIndex((r) => !r.watched);
  assert.ok(rows.slice(firstUnwatched).some((r) => r.watched),
    "a watched app on workspace 3 belongs below an unwatched one on workspace 2");

  rows.forEach((row) => assert.ok(row.position, "every row says where its app is"));
});

test("the list crosses the monitors left to right", () => {
  const clients = [
    // Listed right-monitor-first, which is exactly what the sort must ignore.
    makeClient({ address: "0xbbb", class: "code", workspace: 5, monitor: 1, at: [1920, 0], size: [960, 1080] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, monitor: 0, at: [0, 0], size: [960, 1080] })
  ];
  const rows = panel.appRows(clients, [LEFT, RIGHT], resolver(IDENTITIES), null, null, IDENTITIES);
  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "editor"]);

  // The monitor's place on the DESK decides, not its hyprctl index: swap the
  // ids and the answer must not move.
  const swapped = [
    Object.assign({}, LEFT, { id: 1 }),
    Object.assign({}, RIGHT, { id: 0 })
  ];
  const reIndexed = [
    makeClient({ address: "0xbbb", class: "code", workspace: 5, monitor: 0, at: [1920, 0], size: [960, 1080] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, monitor: 1, at: [0, 0], size: [960, 1080] })
  ];
  assert.deepStrictEqual(
    panel.appRows(reIndexed, swapped, resolver(IDENTITIES), null, null, IDENTITIES).map((r) => r.identityId),
    ["terminal", "editor"]);
});

test("within one monitor the list climbs the workspaces, and crosses each one", () => {
  const clients = [
    makeClient({ address: "0xddd", class: "chromium", workspace: 3, at: [0, 0], size: [1920, 1080] }),
    // Two on workspace 1: the RIGHT one listed first.
    makeClient({ address: "0xbbb", class: "code", workspace: 1, at: [960, 0], size: [960, 1080] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] })
  ];
  const rows = panel.appRows(clients, [LEFT], resolver(IDENTITIES), null, null, IDENTITIES);
  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "editor", "browser"]);
});

test("two windows stacked in a column read top to bottom", () => {
  const clients = [
    makeClient({ address: "0xbbb", class: "code", workspace: 1, at: [960, 540], size: [960, 540] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [960, 0], size: [960, 540] })
  ];
  const rows = panel.appRows(clients, [LEFT], resolver(IDENTITIES), null, null, IDENTITIES);
  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "editor"]);
});

test("grouped rows follow the tab order, not the listing order", () => {
  // Every member of a tab group is the same rectangle, so geometry cannot
  // separate them — the group's own order is what is left, and it is the order
  // the user sees on the tab strip.
  const order = ["0xaaa", "0xbbb", "0xccc"];
  const clients = [
    makeClient({ address: "0xccc", class: "chromium", workspace: 2, grouped: order, at: [0, 0], size: [1920, 1080] }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: order, at: [0, 0], size: [1920, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 2, grouped: order, at: [0, 0], size: [1920, 1080] })
  ];
  const rows = panel.appRows(clients, [LEFT], resolver(IDENTITIES), null, null, IDENTITIES);
  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "editor", "browser"]);
});

test("a recorded ghost sits where the recording put it, not at one end", () => {
  // Slack is closed. Its row belongs between the two live windows it was
  // recorded between — that is where the recorded map draws it, and the list is
  // the same picture in one column.
  const recordedClients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [640, 1080] }),
    makeClient({ address: "0xsla", class: "chrome-app.slack.com__x-Profile_1", workspace: 1, at: [640, 0], size: [640, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 1, at: [1280, 0], size: [640, 1080] })
  ];
  const watched = [
    { id: "terminal", patterns: ["^foot$"] },
    { id: "slack", patterns: ["^chrome-app\\.slack\\.com"] },
    { id: "editor", patterns: ["^code$"] }
  ];
  const layout = engine.buildLayout(recordedClients, [LEFT], watched, AT);
  const live = [recordedClients[0], recordedClients[2]];
  const rows = panel.appRows(live, [LEFT], resolver(watched), null, layout, watched);

  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "slack", "editor"]);
  assert.strictEqual(rows[1].ghost, true, "the closed app is the middle row, and it is a ghost");
});

test("a row whose monitor is not here sorts last, with the other strays", () => {
  // A layout recorded on the docked desk, opened on the bare laptop: the
  // ultrawide's apps have nowhere on this map to point at. They go to the end,
  // alphabetically, rather than being scattered through a list they cannot be
  // read against.
  const layout = {
    topologyKey: "Laptop | Ultrawide",
    recordedAt: AT,
    apps: [
      { identityId: "slack", monitorDescription: "Ultrawide", workspaceId: 2, floating: false, group: null, at: [1920, 0], size: [960, 1080] },
      { identityId: "browser", monitorDescription: "Ultrawide", workspaceId: 1, floating: false, group: null, at: [1920, 0], size: [960, 1080] },
      { identityId: "editor", monitorDescription: "Laptop", workspaceId: 9, floating: false, group: null, at: [0, 0], size: [1920, 1080] }
    ]
  };
  const live = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [1920, 1080] })];
  const watched = IDENTITIES.filter((i) => ["terminal", "editor", "browser", "slack"].indexOf(i.id) !== -1);
  const rows = panel.appRows(live, [LEFT], resolver(watched), null, layout, watched);

  // Terminal (live, ws 1) and Editor (recorded on THIS monitor, ws 9) are
  // placeable; the two strays follow, in name order.
  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "editor", "browser", "slack"]);
});

test("the list does not depend on the order hyprctl listed the windows in", () => {
  // hyprctl's client order follows focus history and renumbers freely. Two
  // reads of one unchanged desktop must produce the same list, or the row a
  // user is reaching for moves under the cursor.
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [640, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 1, at: [640, 0], size: [640, 1080] }),
    makeClient({ address: "0xccc", class: "chromium", workspace: 3, at: [0, 0], size: [1920, 1080] }),
    makeClient({ address: "0xddd", class: "md.obsidian.Obsidian", workspace: 2, monitor: 1, at: [1920, 0], size: [1920, 1080] }),
    // A second terminal window, further along. Since schema v3 it earns a row of
    // its own — and WHERE each of the two rows lands must not be a matter of
    // listing order.
    makeClient({ address: "0xeee", class: "foot", workspace: 4, monitor: 1, at: [2880, 540], size: [960, 540] })
  ];
  const expected = panel.appRows(clients, [LEFT, RIGHT], resolver(IDENTITIES), null, null, IDENTITIES);
  assert.deepStrictEqual(expected.map((r) => r.identityId),
    ["terminal", "editor", "browser", "obsidian", "terminal"]);
  assert.deepStrictEqual(expected.map((r) => r.name),
    ["Terminal (1)", "Editor", "Browser", "Obsidian", "Terminal (2)"]);
  assert.deepStrictEqual(expected.map((r) => r.key),
    ["terminal#0", "editor", "browser", "obsidian", "terminal#1"]);
  assert.strictEqual(expected[0].position, "eDP-1 · ws 1",
    "the first terminal row is the first one you would meet reading the map");

  // Every rotation of the input; the answer never moves.
  for (let shift = 1; shift < clients.length; shift++) {
    const shuffled = clients.slice(shift).concat(clients.slice(0, shift));
    const rows = panel.appRows(shuffled, [LEFT, RIGHT], resolver(IDENTITIES), null, null, IDENTITIES);
    assert.deepStrictEqual(rows.map((r) => r.key), expected.map((r) => r.key), "rotation by " + shift);
    assert.deepStrictEqual(rows.map((r) => r.position), expected.map((r) => r.position), "rotation by " + shift);
  }
});

test("the three row states survive the reordering", () => {
  // The sort is the only thing tick ph0 changes: a row still knows whether it is
  // watched, unwatched, or recorded-but-orphaned.
  const monitors = [LEFT];
  const recordedClients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 2, at: [0, 0], size: [960, 1080] })
  ];
  const layout = engine.buildLayout(recordedClients, monitors, IDENTITIES, AT);
  const stillWatched = IDENTITIES.filter((i) => i.id !== "editor");
  const live = [
    recordedClients[0],
    makeClient({ address: "0xccc", class: "chromium", workspace: 3, at: [0, 0], size: [1920, 1080] })
  ];
  const rows = panel.appRows(live, monitors, resolver(stillWatched), null, layout, stillWatched, {});

  const byId = {};
  rows.forEach((r) => { byId[r.identityId || r.className] = r; });
  assert.strictEqual(byId.terminal.watched, true);
  assert.strictEqual(byId.browser.watched, true);
  assert.strictEqual(byId.editor.recordedUnwatched, true);
  assert.strictEqual(byId.editor.clickable, false);
  // ws 1 (terminal), ws 2 (the orphaned recording), ws 3 (browser).
  assert.deepStrictEqual(rows.map((r) => r.identityId), ["terminal", "editor", "browser"]);
});

test("two windows of the same UNWATCHED app are still one row", () => {
  // Found on the real desktop: two Gmail windows produced two identical
  // unwatched rows. The map shows both windows — two windows really are two
  // chips — but the list is per app.
  const clients = [
    makeClient({ address: "0xaaa", class: "chrome-mail.google.com__mail_u_0_-Profile_1", workspace: 9 }),
    makeClient({ address: "0xbbb", class: "chrome-mail.google.com__mail_u_0_-Profile_1", workspace: 9 })
  ];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  assert.strictEqual(panel.appRows(clients, monitors, resolver([]), null, null).length, 1);
  const map = panel.liveMapModel(clients, monitors, resolver([]), null, 400, 200);
  assert.strictEqual(panel.flattenChips(map).length, 2);
});

test("one row per INSTANCE of a watched identity, one tick for the app", () => {
  // Schema v3 (tick wzg) replaced "one row per app". Three terminals are three
  // rows — the user has to be able to see which of them is out of place — and
  // still ONE tick, because a pattern matches a class and there is no such
  // thing as watching one window of an app. The toggle test below pins that.
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1 }),
    makeClient({ address: "0xbbb", class: "foot", workspace: 2 }),
    makeClient({ address: "0xccc", class: "foot", workspace: 3 })
  ];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const rows = panel.appRows(clients, monitors, resolver(IDENTITIES), null, null);

  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map((r) => r.key), ["terminal#0", "terminal#1", "terminal#2"]);
  assert.deepStrictEqual(rows.map((r) => r.linkKey),
    ["id:terminal#0", "id:terminal#1", "id:terminal#2"]);
  assert.deepStrictEqual(rows.map((r) => r.name), ["Terminal (1)", "Terminal (2)", "Terminal (3)"]);
  assert.deepStrictEqual(rows.map((r) => r.position), ["eDP-1 · ws 1", "eDP-1 · ws 2", "eDP-1 · ws 3"]);
  assert.ok(rows.every((r) => r.identityId === "terminal" && r.watched && r.clickable));
});

test("a single-window identity keeps EXACTLY the row it always had — no #0 anywhere", () => {
  // The compatibility pin for the panel half of the epic.
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1 })];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const rows = panel.appRows(clients, monitors, resolver(IDENTITIES), null, null);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key, "terminal");
  assert.strictEqual(rows[0].linkKey, "id:terminal");
  assert.strictEqual(rows[0].name, "Terminal");
  assert.strictEqual(rows[0].instances, 1);
  assert.strictEqual(JSON.stringify(rows).indexOf("#"), -1, "no instance suffix reaches the user");

  const map = panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 400, 200);
  const chips = panel.flattenChips(map);
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(chips[0].linkKey, "id:terminal");
  assert.strictEqual(chips[0].name, "Terminal");
  assert.strictEqual(JSON.stringify(chips).indexOf("#"), -1);
});

test("clicking ANY instance row toggles the whole identity", () => {
  // Watched-ness is identity-level and stays that way: both rows carry the same
  // identityId, and that is the only thing the toggle looks at.
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1 }),
    makeClient({ address: "0xbbb", class: "foot", workspace: 2 })
  ];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const watched = [{ id: "terminal", patterns: ["^foot$"], launch: "foot" }];
  const rows = panel.appRows(clients, monitors, resolver(watched), null, null, watched);

  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((r) => r.identityId === "terminal"));
  for (const row of rows) {
    const after = panel.toggleWatchedIdentities(watched, row.className, row.identityId);
    assert.deepStrictEqual(after, [], "unticking either instance row unwatches the app");
  }

  // And back the other way: ticking either one watches the app once, not twice.
  // The class here is a terminal, so the tick carries the derivation that names
  // the app inside it — without one it refuses (tick gpq).
  const unwatchedRows = panel.appRows(clients, monitors, resolver([]), null, null, []);
  const retickd = panel.toggleWatchedIdentities([], unwatchedRows[0].className,
    unwatchedRows[0].identityId, { command: "foot --title=herdr herdr", title: "herdr", reason: "" });
  assert.strictEqual(retickd.length, 1);
});

test("a recorded app that is not running still gets a row", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const rows = panel.appRows([], monitorsLaptop, resolver(IDENTITIES), null, layout);
  // One ghost row per recorded WINDOW: a user with two recorded terminals and
  // none running is told that BOTH are missing.
  assert.strictEqual(rows.length, layout.apps.length);
  assert.ok(rows.every((r) => r.ghost), "nothing is running, so every row is a ghost");
  assert.ok(rows.every((r) => r.position.indexOf("not running") !== -1));
});

// ---- the three row states ----

test("a recorded app that is no longer watched says so, unticked and inert", () => {
  // The review finding: un-tick an app whose placement is still in the
  // recording and its row came back TICKED (because it was in the layout),
  // while clicking it did nothing at all — toggleWatchedIdentities was being
  // asked to remove an id that was not on the list.
  const monitors = [{ id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const recordedClients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1 }),
    makeClient({ address: "0xbbb", class: "code", workspace: 2 })
  ];
  const layout = engine.buildLayout(recordedClients, monitors, IDENTITIES, AT);
  assert.deepStrictEqual(layout.apps.map((a) => a.identityId).sort(), ["editor", "terminal"]);

  // "editor" has since been unticked, and its app is closed.
  const stillWatched = IDENTITIES.filter((i) => i.id !== "editor");
  const rows = panel.appRows([recordedClients[0]], monitors,
    resolver(stillWatched), null, layout, stillWatched, {});

  const orphan = rows.find((r) => r.identityId === "editor");
  assert.ok(orphan, "the recording still refers to it, so it still gets a row");
  assert.strictEqual(orphan.watched, false, "an unticked identity must not render ticked");
  assert.strictEqual(orphan.recordedUnwatched, true);
  assert.strictEqual(orphan.clickable, false, "a click that cannot do anything is not offered");
  assert.ok(orphan.position.indexOf("recorded · no longer watched") !== -1, orphan.position);
  // No launch offer on a row nothing can be launched for.
  assert.strictEqual(orphan.launchHint, "");

  // The one still watched is untouched: ticked, clickable, ordinary.
  const kept = rows.find((r) => r.identityId === "terminal");
  assert.strictEqual(kept.watched, true);
  assert.strictEqual(kept.clickable, true);
  assert.strictEqual(kept.recordedUnwatched, false);
});

test("an orphaned recording annotates the live window rather than doubling it", () => {
  // Un-tick an app that is RUNNING. Its window already has an unwatched row —
  // the one a click can re-watch — so the recording's orphan belongs on that
  // row, not on a second line with the same name.
  const monitors = [{ id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const className = "chrome-app.slack.com__client-Profile_1";
  const clients = [makeClient({ address: "0xaaa", class: className, workspace: 3 })];
  const watched = [{ id: "slack", patterns: [panel.derivePattern(className)], launch: "" }];
  const layout = engine.buildLayout(clients, monitors, watched, AT);
  assert.deepStrictEqual(layout.apps.map((a) => a.identityId), ["slack"]);

  const rows = panel.appRows(clients, monitors, resolver([]), null, layout, [], {});
  assert.strictEqual(rows.length, 1, "one app, one row — the recording is not a second Slack");
  assert.strictEqual(rows[0].watched, false);
  assert.strictEqual(rows[0].recordedUnwatched, true);
  // Still clickable: this row HAS a class, so a click re-derives the pattern
  // and watches the app again.
  assert.strictEqual(rows[0].clickable, true);
  assert.strictEqual(rows[0].className, className);
  assert.ok(rows[0].position.indexOf("ws 3") !== -1, rows[0].position);
  assert.ok(rows[0].position.indexOf("recorded · no longer watched") !== -1, rows[0].position);
});

test("two orphaned recordings annotate the live row once, with a count", () => {
  // The same fold as above, but the recording holds TWO windows of the dropped
  // identity. The clause is one fact about that row and is said once —
  // appending it per occurrence produced "· recorded · no longer watched ·
  // recorded · no longer watched".
  const monitors = [{ id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  const className = "chrome-app.slack.com__client-Profile_1";
  const recorded = [
    makeClient({ address: "0xaaa", class: className, workspace: 3 }),
    makeClient({ address: "0xbbb", class: className, workspace: 4 })
  ];
  const watched = [{ id: "slack", patterns: [panel.derivePattern(className)], launch: "" }];
  const layout = engine.buildLayout(recorded, monitors, watched, AT);
  assert.strictEqual(layout.apps.length, 2);

  const rows = panel.appRows([recorded[0]], monitors, resolver([]), null, layout, [], {});
  assert.strictEqual(rows.length, 1, "one live window, one row");
  assert.strictEqual(rows[0].recordedUnwatched, true);
  assert.ok(rows[0].position.indexOf("recorded ×2 · no longer watched") !== -1, rows[0].position);
  assert.strictEqual(
    rows[0].position.split("no longer watched").length - 1, 1,
    "said once, not once per recorded occurrence: " + rows[0].position);

  // One recorded occurrence keeps the bare wording it always had.
  const single = engine.buildLayout([recorded[0]], monitors, watched, AT);
  const soloRows = panel.appRows([recorded[0]], monitors, resolver([]), null, single, [], {});
  assert.ok(soloRows[0].position.indexOf("recorded · no longer watched") !== -1, soloRows[0].position);
});

test("without an identity list the recorded rows keep the old meaning", () => {
  // Callers that pass no identities cannot be told watched from orphaned, so
  // nothing changes for them: a recorded app is a ghost row, ticked.
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const rows = panel.appRows([], monitorsLaptop, resolver(IDENTITIES), null, layout);
  assert.ok(rows.every((r) => r.watched && r.ghost && !r.recordedUnwatched));
  // An EMPTY list is a different statement — nothing is watched — and every
  // recorded row is then an orphan.
  const orphans = panel.appRows([], monitorsLaptop, resolver([]), null, layout, []);
  assert.ok(orphans.length === layout.apps.length);
  assert.ok(orphans.every((r) => !r.watched && r.recordedUnwatched && !r.clickable));
});

test("a drifted row carries the arrow the map shows", () => {
  const monitors = [
    { id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 1, name: "DP-2", description: "Ultrawide", x: 1920, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  const layout = engine.buildLayout(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 1 })], monitors, IDENTITIES, AT);
  const live = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, monitor: 0 })];
  const rows = panel.appRows(live, monitors, resolver(IDENTITIES), engine.driftOf(live, monitors, layout, IDENTITIES), layout);
  const row = rows.find((r) => r.identityId === "terminal");
  assert.strictEqual(row.drifted, true);
  assert.strictEqual(row.driftTo, "DP-2 · ws 2");
  assert.strictEqual(row.position, "eDP-1 · ws 1");
});

// ------------------------------------------------- hover linking + tooltips

// One watched terminal and two windows of an unwatched webapp, on one monitor.
// Enough to link both kinds of row and to prove that one row can be several
// chips.
function linkScenario(identities) {
  const clients = [
    makeClient({
      address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080],
      title: "~/git/monitor-watch — foot"
    }),
    makeClient({
      address: "0xbbb", class: "chrome-mail.google.com__mail_u_0_-Profile_1", workspace: 2,
      at: [0, 0], size: [960, 1080], title: "Inbox (3) - Gmail"
    }),
    makeClient({
      address: "0xccc", class: "chrome-mail.google.com__mail_u_0_-Profile_1", workspace: 2,
      at: [960, 0], size: [960, 1080], title: "Sent - Gmail"
    })
  ];
  const watched = identities || IDENTITIES.filter((i) => i.id === "terminal");
  return {
    clients: clients,
    watched: watched,
    map: panel.liveMapModel(clients, [LEFT], resolver(watched), null, 400, 200),
    rows: panel.appRows(clients, [LEFT], resolver(watched), null, null, watched)
  };
}

test("a watched row and its chip agree on what to call the app", () => {
  const scene = linkScenario();
  const chips = panel.flattenChips(scene.map);
  const chip = chips.find((c) => c.address === "0xaaa");
  const row = scene.rows.find((r) => r.identityId === "terminal");

  assert.ok(chip.linkKey, "a chip that links to nothing cannot highlight anything");
  assert.strictEqual(panel.chipLinkKey(chip), panel.rowLinkKey(row));
  assert.strictEqual(chip.linkKey, row.linkKey, "the field and the function are the same answer");
  // A watched row's own key is the bare identityId; its linkKey carries the
  // "id:" prefix, so the two differ (that prefix is what keeps an identity
  // called "foot" from colliding with the class "foot").
  assert.notStrictEqual(row.linkKey, row.key, "a watched row's key and linkKey are not the same string");
});

test("an unwatched class row links every window of that class", () => {
  const scene = linkScenario();
  const chips = panel.flattenChips(scene.map).filter((c) => c.className.indexOf("mail.google") !== -1);
  assert.strictEqual(chips.length, 2, "two windows really are two chips");
  const row = scene.rows.find((r) => r.className.indexOf("mail.google") !== -1);

  // One row, two chips, one key: linking is by equality, never a 1:1 pairing.
  assert.strictEqual(chips[0].linkKey, chips[1].linkKey);
  assert.strictEqual(chips[0].linkKey, panel.rowLinkKey(row));
  // …and it IS the row's own key: an unwatched row has no identityId, so
  // both `key` and `linkKey` fall back to the same "class:"+className string.
  assert.strictEqual(row.linkKey, row.key, "a class row's key and linkKey are the same string");
});

test("an identity and a class of the same name do not collide", () => {
  assert.notStrictEqual(panel.linkKeyFor("foot", ""), panel.linkKeyFor("", "foot"));
  assert.strictEqual(panel.linkKeyFor("", ""), "", "nothing to link is not a link key");
  assert.strictEqual(panel.chipLinkKey(null), "");
  assert.strictEqual(panel.rowLinkKey(null), "");
});

test("a recorded ghost chip links the row of the app that is missing", () => {
  const recordedClients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] }),
    makeClient({ address: "0xbbb", class: "code", workspace: 2, at: [0, 0], size: [960, 1080] })
  ];
  const layout = engine.buildLayout(recordedClients, [LEFT], IDENTITIES, AT);
  // The editor is closed: a ghost on the recorded map, a ghost row in the list.
  const live = [recordedClients[0]];
  const map = panel.recordedMapModel(layout, [LEFT], ["terminal"], 400, 200);
  const rows = panel.appRows(live, [LEFT], resolver(IDENTITIES), null, layout, IDENTITIES);

  const ghostChip = panel.flattenChips(map).find((c) => c.identityId === "editor");
  const ghostRow = rows.find((r) => r.identityId === "editor");
  assert.strictEqual(ghostChip.ghost, true);
  assert.strictEqual(ghostRow.ghost, true);
  assert.strictEqual(panel.chipLinkKey(ghostChip), panel.rowLinkKey(ghostRow));
});

test("a chip tooltip is the window's title, what it is, and where it is", () => {
  const scene = linkScenario();
  const chip = panel.flattenChips(scene.map).find((c) => c.address === "0xbbb");
  const text = panel.chipTooltipText(chip);
  const lines = text.split("\n");

  assert.deepStrictEqual(lines, [
    "Inbox (3) - Gmail",
    "chrome-mail.google.com__mail_u_0_-Profile_1",
    "eDP-1 · ws 2"
  ]);
  // A chip with nothing wrong says nothing about drift or mismatches — the
  // tooltip has to stay worth reading on the nine chips out of nine that are
  // fine.
  assert.strictEqual(text.indexOf("→"), -1);
  assert.strictEqual(text.indexOf("recorded on"), -1);
});

test("a drifted chip's tooltip carries the arrow and the diagnosis", () => {
  const monitors = [LEFT, RIGHT];
  const layout = engine.buildLayout(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 1, at: [1920, 0], size: [960, 1080] })],
    monitors, IDENTITIES, AT);
  const live = [makeClient({
    address: "0xaaa", class: "foot", workspace: 1, monitor: 0, at: [0, 0], size: [960, 1080],
    title: "~/ — foot"
  })];
  const report = engine.driftOf(live, monitors, layout, IDENTITIES);
  const verdicts = engine.verdictsFor(report, []);
  const map = panel.liveMapModel(live, monitors, resolver(IDENTITIES), report, 400, 200, verdicts);
  const chip = panel.flattenChips(map)[0];

  const text = panel.chipTooltipText(chip);
  assert.ok(text.indexOf("→ recorded on DP-2 · ws 2") !== -1, text);
  assert.ok(text.indexOf("~/ — foot") !== -1, text);
  assert.ok(text.indexOf("eDP-1 · ws 1") !== -1, text);
  assert.ok(chip.mismatch !== "" && text.indexOf(chip.mismatch) !== -1,
    "the sentence saying WHAT is wrong is in there too: " + text);
});

test("a row tooltip leads with the app, not with a window it does not have", () => {
  const scene = linkScenario();
  const row = scene.rows.find((r) => r.identityId === "terminal");
  const lines = panel.rowTooltipText(row).split("\n");
  // The app, its class, where it is — and LAST what Restore can do for it.
  // That fourth line arrived with tick pct: the strip has no captions left to
  // print the launch hint on, so the tooltip is the only place it can be said,
  // and every WATCHED row appRows builds has one (this identity has no launch
  // command recorded, which is exactly "no launch cmd").
  assert.deepStrictEqual(lines, ["Terminal", "foot", "eDP-1 · ws 1", "no launch cmd"]);

  // An unwatched class row has no launchHint at all — nothing was ever recorded
  // to launch — and gets no line rather than an empty one.
  const unwatched = scene.rows.find((r) => r.identityId === "");
  assert.strictEqual(unwatched.launchHint, "", "an unwatched row has no launch hint to give");
  assert.strictEqual(panel.rowTooltipText(unwatched).split("\n").length, 3);

  // A ghost row has no class at all, and simply says less rather than leaving a
  // hole where the class line would be.
  const ghost = {
    key: "slack", identityId: "slack", className: "", linkKey: "id:slack", name: "Slack",
    position: "DP-2 · ws 4 · not running", drifted: false, driftTo: "", mismatch: "",
    launchHint: "no launch cmd"
  };
  assert.deepStrictEqual(panel.rowTooltipText(ghost),
    "Slack\nDP-2 · ws 4 · not running\nno launch cmd");
});

test("a tooltip never contains a blank line, and empty means empty", () => {
  const scene = linkScenario();
  const everything = panel.flattenChips(scene.map).map(panel.chipTooltipText)
    .concat(scene.rows.map(panel.rowTooltipText));
  everything.forEach((text) => {
    assert.ok(text.length > 0, "every chip and row on a real desktop has something to say");
    assert.strictEqual(text.indexOf("\n\n"), -1, "no hole in the middle: " + JSON.stringify(text));
    assert.strictEqual(text[0] === "\n" || text[text.length - 1] === "\n", false,
      "no hole at either end: " + JSON.stringify(text));
  });

  // Nothing to say is the empty string, so the caller can hide the tooltip
  // rather than popping an empty box.
  assert.strictEqual(panel.chipTooltipText(null), "");
  assert.strictEqual(panel.rowTooltipText(null), "");
  assert.strictEqual(panel.chipTooltipText({ title: "", className: "", placement: "", mismatch: "" }), "");
});

test("a chip carries a title even when the window has none", () => {
  // hyprctl can report an empty title for a window that has not drawn yet. The
  // tooltip drops the line rather than opening with a blank one.
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] })];
  const map = panel.liveMapModel(clients, [LEFT], resolver(IDENTITIES), null, 400, 200);
  const chip = panel.flattenChips(map)[0];
  assert.strictEqual(chip.title, "");
  assert.strictEqual(panel.chipTooltipText(chip), "foot\neDP-1 · ws 1");
});

// ------------------------------------------------------------ keyboard cursor

function chipMap() {
  const order = ["0xaaa", "0xbbb"];
  const clients = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2, grouped: order }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, grouped: order }),
    makeClient({ address: "0xccc", class: "code", workspace: 3 })
  ];
  const monitors = [{ id: 0, name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
  return panel.liveMapModel(clients, monitors, resolver(IDENTITIES), null, 400, 200);
}

test("the arrow keys walk the map in reading order", () => {
  const chips = panel.flattenChips(chipMap());
  // Monitor, then workspace, then slot, then tab — and inside the group, the
  // group's own tab order rather than hyprctl's listing.
  assert.deepStrictEqual(chips.map((c) => c.address), ["0xaaa", "0xbbb", "0xccc"]);
});

test("the cursor moves one chip at a time and stops at the ends", () => {
  const chips = panel.flattenChips(chipMap());
  assert.strictEqual(panel.nextCursorKey(chips, "0xaaa", 1), "0xbbb");
  assert.strictEqual(panel.nextCursorKey(chips, "0xbbb", 1), "0xccc");
  // Clamped, not wrapped: the map is a picture of a desk, and running off the
  // right edge back to the left is not how a desk behaves.
  assert.strictEqual(panel.nextCursorKey(chips, "0xccc", 1), "0xccc");
  assert.strictEqual(panel.nextCursorKey(chips, "0xaaa", -1), "0xaaa");
});

test("the first arrow press lands on an end, not in the middle", () => {
  const chips = panel.flattenChips(chipMap());
  assert.strictEqual(panel.nextCursorKey(chips, "", 1), "0xaaa");
  assert.strictEqual(panel.nextCursorKey(chips, "", -1), "0xccc");
});

test("a cursor whose window closed recovers instead of getting stuck", () => {
  // The panel rebuilds the map every couple of seconds; the chip the cursor
  // was on may simply not be there any more.
  const chips = panel.flattenChips(chipMap());
  assert.strictEqual(panel.nextCursorKey(chips, "0xdead", 1), "0xaaa");
  assert.strictEqual(panel.nextCursorKey([], "0xaaa", 1), "");
});

test("Tab loops through the three focus sections both ways", () => {
  const order = ["chips", "restore", "record"];
  assert.strictEqual(panel.nextSection(order, "chips", 1), "restore");
  assert.strictEqual(panel.nextSection(order, "restore", 1), "record");
  assert.strictEqual(panel.nextSection(order, "record", 1), "chips");
  assert.strictEqual(panel.nextSection(order, "chips", -1), "record");
  // An unknown section is a bug elsewhere; land somewhere usable rather than
  // leaving the panel with no cursor at all.
  assert.strictEqual(panel.nextSection(order, "nonsense", 1), "restore");
});

// ------------------------------------------------- the Tab chain (tick wgj)

test("the failed-restore section joins the Tab chain, between the map and the footer", () => {
  // F4 from the live round: the Retry buttons were pointer-only, which made
  // them the one control in the panel a keyboard could not press.
  const withFailures = panel.panelFocusOrder({ learnable: 0, failed: 2, canUndo: false });
  assert.deepStrictEqual(withFailures,
    ["chips", "failed", "restore", "record", "pause", "overflow"]);
  // It sits where it is DRAWN: after the map, before every footer button.
  assert.ok(withFailures.indexOf("failed") > withFailures.indexOf("chips"));
  assert.ok(withFailures.indexOf("failed") < withFailures.indexOf("restore"));
});

test("with nothing failed the Tab chain is exactly what it always was", () => {
  assert.deepStrictEqual(
    panel.panelFocusOrder({ learnable: 0, failed: 0, canUndo: false }),
    ["chips", "restore", "record", "pause", "overflow"]);
  assert.deepStrictEqual(
    panel.panelFocusOrder({ learnable: 3, failed: 0, canUndo: true }),
    ["chips", "learn", "restore", "record", "undo", "pause", "overflow"]);
});

test("every conditional stop appears only while the thing it acts on is drawn", () => {
  assert.deepStrictEqual(
    panel.panelFocusOrder({ learnable: 1, failed: 1, canUndo: true }),
    ["chips", "failed", "learn", "restore", "record", "undo", "pause", "overflow"]);
  // Missing or garbage input must not conjure a stop onto a button nobody drew
  // — a dead Tab is how "everything here is keyboard-reachable" stops being
  // true in the other direction.
  assert.deepStrictEqual(panel.panelFocusOrder(),
    ["chips", "restore", "record", "pause", "overflow"]);
  assert.deepStrictEqual(
    panel.panelFocusOrder({ learnable: undefined, failed: null, canUndo: 0 }),
    ["chips", "restore", "record", "pause", "overflow"]);
});

test("the failed rows carry the keys the section's cursor is held by", () => {
  // The cursor is a row KEY, and it walks the rows with the same clamped
  // stepper the chips use — so the two cursors cannot behave differently.
  const rows = panel.failedRestoreRows([
    { identityId: "alpha", blockedBy: { kind: "launch", reason: "no window" } },
    { identityId: "beta", blockedBy: { kind: "move", reason: "refused" } }
  ], []);
  // The key is occurrence-scoped, so two windows of one app get one row each.
  const [alpha, beta] = rows.map((r) => r.key);
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(alpha, beta);
  assert.ok(alpha.indexOf("failed:alpha") === 0 && beta.indexOf("failed:beta") === 0);
  assert.strictEqual(panel.nextCursorKey(rows, "", 1), alpha);
  assert.strictEqual(panel.nextCursorKey(rows, alpha, 1), beta);
  // Clamped, not wrapped: the last row is the end of the section, and Tab is
  // what leaves it.
  assert.strictEqual(panel.nextCursorKey(rows, beta, 1), beta);
  // A row that cleared while the cursor was on it starts again from the end it
  // was moving towards, rather than teleporting.
  assert.strictEqual(panel.nextCursorKey(rows, "failed:gone", 1), alpha);
});

test("flattenChips is defensive about a half-built map", () => {
  assert.deepStrictEqual(panel.flattenChips(null), []);
  assert.deepStrictEqual(panel.flattenChips({}), []);
  assert.deepStrictEqual(panel.flattenChips({ monitors: [{}] }), []);
});

// ------------------------------------------------------------ header + footer

test("the badge follows the glyph state, so bar and panel cannot disagree", () => {
  const status = (patch) => state.mergeStatus(state.defaultStatus(), patch);
  const badge = (patch) => {
    const current = status(patch);
    return panel.badgeFor(state.glyphState(current), current);
  };

  assert.deepStrictEqual(badge({}), { text: "Not recorded", tone: "muted" });
  assert.deepStrictEqual(badge({ recorded: true }), { text: "In sync", tone: "ok" });
  assert.deepStrictEqual(badge({ recorded: true, driftCount: 3 }), { text: "Drifted (3)", tone: "accent" });
  assert.deepStrictEqual(
    badge({ recorded: true, lastResult: { ok: false, summary: "x", at: AT } }),
    { text: "Restore failed", tone: "urgent" });
  assert.strictEqual(badge({ recorded: true, restoring: true }).text, "Restoring…");
  assert.deepStrictEqual(badge({ recorded: true, paused: true }), { text: "Paused", tone: "muted" });
});

// ------------------------------------------------------- control tooltips

// Every control's tooltip is built from the same status the control itself is,
// so a badge and its explanation cannot describe different desktops.
function statusOf(patch) {
  return state.mergeStatus(state.defaultStatus(), patch);
}

function badgeTipFor(patch) {
  const current = statusOf(patch);
  return panel.badgeTooltip(state.glyphState(current), current);
}

test("the badge explains what its one word means, per status", () => {
  assert.ok(badgeTipFor({}).indexOf("No layout recorded") !== -1, badgeTipFor({}));
  assert.ok(badgeTipFor({ recorded: true }).indexOf("where the recording puts it") !== -1);

  const drifted = badgeTipFor({ recorded: true, driftCount: 3 });
  assert.ok(drifted.indexOf("3 apps are") !== -1, drifted);
  // Both exits from drift, which is the whole of what the badge is telling the
  // user to decide between.
  assert.ok(drifted.indexOf("Restore now") !== -1 && drifted.indexOf("Record layout") !== -1, drifted);
  assert.ok(badgeTipFor({ recorded: true, driftCount: 1 }).indexOf("1 app is") !== -1);

  const failed = badgeTipFor({ recorded: true, lastResult: { ok: false, summary: "2 of 6 refused", at: AT } });
  assert.ok(failed.indexOf("did not finish") !== -1 && failed.indexOf("2 of 6 refused") !== -1, failed);
  // A failure with nothing to say about itself does not leave empty brackets.
  const bare = badgeTipFor({ recorded: true, lastResult: { ok: false, summary: "", at: AT } });
  assert.strictEqual(bare.indexOf("()"), -1, bare);

  assert.ok(badgeTipFor({ recorded: true, restoring: true }).indexOf("Putting the watched apps back") !== -1);
  // Paused outranks drift here exactly as it does on the badge itself.
  const paused = badgeTipFor({ recorded: true, driftCount: 7, paused: true });
  assert.ok(paused.indexOf("Paused") !== -1 && paused.indexOf("Restore now still works") !== -1, paused);

  // Every status says SOMETHING: a control with an empty tooltip is a control
  // that looks broken.
  ["", "filled", "hollow", "drifted", "failed", "restoring", "paused"].forEach((glyph) => {
    assert.ok(panel.badgeTooltip(glyph, statusOf({ recorded: true })).length > 0, "glyph " + glyph);
  });
});

test("the two footer buttons say which direction they move things in", () => {
  const restore = panel.restoreTooltip(true, "Laptop + AOC U34");
  assert.ok(restore.indexOf("Laptop + AOC U34") !== -1, restore);
  assert.ok(restore.indexOf("Safe to press twice") !== -1, "restore is idempotent, and says so");

  // Nothing recorded: the button is dim, and this is why.
  assert.ok(panel.restoreTooltip(false, "Laptop").indexOf("no layout to put back") !== -1);
  assert.ok(panel.restoreTooltip(false, "").indexOf("this setup") !== -1, "an unnamed desk is still a desk");
  // Callers actually pass humanizeTopology's output, which is never "" — an
  // empty topology comes back as EMPTY_TOPOLOGY ("No monitors"). That must
  // fall back the same way "" does, or a degenerate desk reads "for No
  // monitors" instead of "this setup".
  const noMonitors = panel.humanizeTopology("", []);
  assert.ok(panel.restoreTooltip(false, noMonitors).indexOf("this setup") !== -1,
    "EMPTY_TOPOLOGY reads as unnamed, not as a desk called \"No monitors\"");
  assert.strictEqual(panel.restoreTooltip(false, noMonitors).indexOf("No monitors"), -1);
  assert.strictEqual(panel.restoreTooltip(true, noMonitors).indexOf("No monitors"), -1);

  const record = panel.recordTooltip(6, "Laptop + AOC U34", false);
  assert.ok(record.indexOf("6 watched apps") !== -1, record);
  assert.ok(record.indexOf("Laptop + AOC U34") !== -1, record);
  // The sketch trades a confirmation dialog for a label that leaves no room for
  // surprise, and the tooltip is where "this overwrites" is said in full.
  assert.ok(record.indexOf("replaces the previous recording") !== -1, record);
  assert.ok(panel.recordTooltip(1, "Laptop", false).indexOf("1 watched app is") !== -1);
  assert.ok(panel.recordTooltip(0, "Laptop", false).indexOf("Nothing is watched yet") !== -1);
  // Same EMPTY_TOPOLOGY fallback as restoreTooltip.
  assert.ok(panel.recordTooltip(6, noMonitors, false).indexOf("this setup") !== -1);
  assert.strictEqual(panel.recordTooltip(6, noMonitors, false).indexOf("No monitors"), -1);

  // Dimmed during a restore: the tooltip is the same sentence the hint line
  // under the map shows, so the two cannot drift apart.
  assert.strictEqual(panel.recordTooltip(6, "Laptop", true), panel.recordBlockedHint(true));
  assert.ok(panel.recordTooltip(6, "Laptop", true).indexOf("Record is disabled") !== -1);
});

test("the switch, the repair and the view toggle all say what they do", () => {
  assert.ok(panel.pauseTooltip(false).indexOf("Ignore monitor changes") !== -1);
  assert.ok(panel.pauseTooltip(true).indexOf("Act on monitor changes again") !== -1);

  const learn = panel.learnLaunchTooltip(3);
  assert.ok(learn.indexOf("3 watched apps have") !== -1, learn);
  assert.ok(learn.indexOf("never reopen them") !== -1, "the tooltip says what the gap COSTS: " + learn);
  assert.ok(panel.learnLaunchTooltip(1).indexOf("1 watched app has") !== -1);
  // The button does not exist when there is nothing to repair, and neither does
  // its tooltip.
  assert.strictEqual(panel.learnLaunchTooltip(0), "");

  assert.ok(panel.viewToggleTooltip(false, true).indexOf("on screen right now") !== -1);
  assert.ok(panel.viewToggleTooltip(true, true).indexOf("dashed ghosts") !== -1);
  assert.ok(panel.viewToggleTooltip(true, false).indexOf("Nothing recorded") !== -1);

  // The overflow affordance opens the menu now (tick gwa), and its sentence
  // names what is behind it rather than apologising for being a stub.
  assert.ok(panel.overflowTooltip().length > 0);
  assert.ok(panel.overflowTooltip().indexOf("Not wired up yet") === -1);
});

test("a long tooltip wraps inside the panel instead of floating over the desktop", () => {
  // Live: the Record tooltip was one unwrapped line that started inside the
  // panel and ended ~380 device px past its right edge (evidence Finding 2).
  // The shell's tooltip Text has no wrapMode and no maximum width, and the
  // footer buttons build theirs inside Ui/Button.qml where the panel cannot
  // reach — so the wrap has to be in the string.
  const raw = panel.recordTooltip(10, "Laptop", false);
  const wrapped = panel.wrapTooltip(raw);

  assert.ok(wrapped.indexOf("\n") !== -1, "it wrapped");
  wrapped.split("\n").forEach((line) => {
    assert.ok(line.length <= 56, `line too long: ${line}`);
  });
  // Same sentence, only differently broken: nothing added, nothing lost.
  assert.strictEqual(wrapped.split(/\s+/).join(" "), raw);
});

test("wrapping keeps the lines a tooltip already had", () => {
  // A chip tooltip is several lines by design (title, class, placement…) and
  // wrapping must not run them together.
  const wrapped = panel.wrapTooltip("first line\nsecond line", 40);
  assert.strictEqual(wrapped, "first line\nsecond line");
});

test("wrapping hard-breaks a word longer than the column budget, and says nothing about nothing", () => {
  // Was: left alone rather than cut. A chip tooltip's class string has no
  // spaces to break on at all (evidence Finding 7), so "left alone" meant
  // "floats off the panel" — the fix is to cut it into limit-sized chunks
  // instead, same characters, none dropped.
  const long = "https://example.test/a-very-long-path-that-cannot-be-broken-anywhere";
  const wrapped = panel.wrapTooltip(long);
  assert.notStrictEqual(wrapped, long);
  wrapped.split("\n").forEach((line) => {
    assert.ok(line.length <= 56, `line too long: ${line}`);
  });
  // Nothing added, nothing lost — just cut.
  assert.strictEqual(wrapped.split("\n").join(""), long);

  assert.strictEqual(panel.wrapTooltip(""), "");
  assert.strictEqual(panel.wrapTooltip(null), "");
});

test("a single word longer than the column budget wraps into limit-sized segments", () => {
  // The exact string from evidence Finding 7: a 46-char, space-less chip
  // class name that pushed the tooltip popup ~100 logical px past the
  // panel's left edge at the chip/row tooltip's ~40-column budget.
  const word = "chrome-www.rememberthemilk.com__app_-Profile_1";
  assert.strictEqual(word.length, 46);
  const wrapped = panel.wrapTooltip(word, 40);
  const lines = wrapped.split("\n");
  assert.ok(lines.length > 1, "it broke");
  lines.forEach((line) => {
    assert.ok(line.length <= 40, `segment too long: ${line}`);
  });
  // Cut, not dropped.
  assert.strictEqual(lines.join(""), word);
});

test("mixed text with one overlong word wraps the normal words and hard-breaks only the long one", () => {
  const word = "chrome-www.rememberthemilk.com__app_-Profile_1";
  const text = "Remember The Milk " + word + " is a watched app";
  const wrapped = panel.wrapTooltip(text, 40);
  const lines = wrapped.split("\n");
  lines.forEach((line) => {
    assert.ok(line.length <= 40, `line too long: ${line}`);
  });
  // The long word's characters all survive, unbroken by anything but the
  // limit itself — every wrap and hard-break point replaces or falls on
  // whitespace, so stripping all whitespace from both sides recovers the
  // same character stream either way.
  assert.strictEqual(wrapped.replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("a newline ahead of an overlong word is still preserved through a hard break", () => {
  const word = "chrome-www.rememberthemilk.com__app_-Profile_1";
  const wrapped = panel.wrapTooltip("first line\n" + word, 40);
  const lines = wrapped.split("\n");
  assert.strictEqual(lines[0], "first line");
  // Everything after the preserved newline is the hard-broken word, still
  // limit-sized and still lossless.
  lines.slice(1).forEach((line) => {
    assert.ok(line.length <= 40, `segment too long: ${line}`);
  });
  assert.strictEqual(lines.slice(1).join(""), word);
});

test("the bar glyph names the desk and says what it thinks of it", () => {
  const name = "Laptop + AOC U34";
  const tip = (patch) => {
    const current = statusOf(patch);
    return panel.barGlyphTooltip(state.glyphState(current), current, name);
  };

  assert.strictEqual(tip({ recorded: true }), name + " — in sync");
  assert.strictEqual(tip({ recorded: true, driftCount: 2 }), name + " — drifted (2)");
  assert.strictEqual(tip({}), name + " — no layout recorded");
  assert.strictEqual(tip({ recorded: true, restoring: true }), name + " — restoring…");
  assert.strictEqual(
    tip({ recorded: true, lastResult: { ok: false, summary: "2 apps refused", at: AT } }),
    name + " — restore failed (2 apps refused)");
  assert.strictEqual(
    tip({ recorded: true, lastResult: { ok: false, summary: "", at: AT } }),
    name + " — restore failed");
  assert.ok(tip({ recorded: true, paused: true }).indexOf(name + " — paused") === 0,
    "paused outranks everything else on the glyph, and the tooltip follows it");

  // The bar reads the topology KEY out of the status file and humanizes it with
  // no live monitor list — the same route BarWidget.qml takes.
  const fromKey = panel.humanizeTopology("Samsung Display Corp. ATNA60HR07-0 | AOC Inc. U34G2G", []);
  assert.strictEqual(
    panel.barGlyphTooltip("filled", statusOf({ recorded: true }), fromKey),
    "Samsung ATNA60HR07-0 + AOC U34G2G — in sync");

  // No topology at all — a status file written before any monitor was read.
  // "No monitors — in sync" would be describing a desk that is not there.
  assert.strictEqual(panel.barGlyphTooltip("filled", statusOf({ recorded: true }), ""),
    "Dock Recall — in sync");
  assert.strictEqual(
    panel.barGlyphTooltip("filled", statusOf({ recorded: true }), panel.humanizeTopology("", [])),
    "Dock Recall — in sync");
});

test("the bar tooltip says when the joins are waiting for an unlock", () => {
  // The glyph has no picture for this (state.glyphState is untouched — the desk
  // IS drifted), so the tooltip is the only place the deferral can be said. A
  // bare "drifted (2)" reads as "the restore could not manage it"; the truth is
  // that the tool deliberately did not try, because `into_group` needs a focus
  // a locked session has none of.
  const name = "Laptop + AOC U34";
  const tip = (patch) => {
    const current = statusOf(patch);
    return panel.barGlyphTooltip(state.glyphState(current), current, name);
  };

  assert.strictEqual(tip({ recorded: true, driftCount: 2, deferredLocked: true }),
    name + " — drifted (2) — joins deferred until unlock");
  // A desk that is otherwise in sync still says it: the joins are outstanding
  // work whatever the count is doing.
  assert.strictEqual(tip({ recorded: true, deferredLocked: true }),
    name + " — in sync — joins deferred until unlock");
  assert.strictEqual(
    tip({ recorded: true, deferredLocked: true, lastResult: { ok: false, summary: "1 failed", at: AT } }),
    name + " — restore failed (1 failed) — joins deferred until unlock");

  // Not while a cycle is in flight, and not while paused: both of those are
  // statements about right now, and the joins are about what happens next.
  assert.strictEqual(tip({ recorded: true, restoring: true, deferredLocked: true }),
    name + " — restoring…");
  assert.ok(tip({ recorded: true, paused: true, deferredLocked: true }).indexOf(" — joins deferred") === -1);

  // Off by default and off for anything that is not literally true.
  assert.strictEqual(tip({ recorded: true }), name + " — in sync");
  assert.strictEqual(panel.deferredLockedSuffix({ deferredLocked: "true" }), "");
  assert.strictEqual(panel.deferredLockedSuffix(null), "");
});

test("the paused badge outranks drift and failure, exactly as the bar glyph does", () => {
  // The panel composes its badge the way Panel.qml does — its own fresher drift
  // laid over the service's status, plus the paused flag read from the STATE
  // file. Whatever the drift says, a switched-off tool leads with the switch.
  const status = (patch) => state.mergeStatus(state.defaultStatus(), patch);
  const badge = (patch) => {
    const current = status(patch);
    return panel.badgeFor(state.glyphState(current), current);
  };

  assert.strictEqual(badge({ recorded: true, driftCount: 7, paused: true }).text, "Paused");
  assert.strictEqual(
    badge({ recorded: true, paused: true, lastResult: { ok: false, summary: "x", at: AT } }).text,
    "Paused");
  // …but a manual restore is still a restore, and the badge follows it.
  assert.strictEqual(badge({ recorded: true, paused: true, restoring: true }).text, "Restoring…");
});

test("an open panel's badge prefers its own fresher drift, and only that", () => {
  // The panel composes its badge exactly the way Panel.qml does: the service's
  // published status, patched with a drift count computed from the read the
  // panel took at most two seconds ago. Without it the header said "In sync"
  // over a map full of amber chips for as long as the service's debounce ran —
  // two of our own surfaces contradicting each other about the same moment.
  const monitors = [
    { id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 1, name: "DP-2", description: "Ultrawide", x: 1920, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  const key = engine.topologyKey(monitors);
  const layout = engine.buildLayout(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 1 })], monitors, IDENTITIES, AT);
  const live = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, monitor: 0 })];
  const drift = engine.driftOf(live, monitors, layout, IDENTITIES);

  // What the service published a moment ago: recorded, and not yet aware.
  const published = state.mergeStatus(state.defaultStatus(),
    { topologyKey: key, recorded: true, driftCount: 0 });
  assert.strictEqual(panel.badgeFor(state.glyphState(published), published).text, "In sync");

  const fresh = state.mergeStatus(published, state.statusPatchFor(key, layout, drift));
  assert.deepStrictEqual(panel.badgeFor(state.glyphState(fresh), fresh),
    { text: "Drifted (1)", tone: "accent" });

  // The two fields the panel knows nothing about stay the service's: a restore
  // in flight and the verdict of the last one still win, exactly as they do on
  // the bar.
  const restoring = state.mergeStatus(
    state.mergeStatus(published, { restoring: true }), state.statusPatchFor(key, layout, drift));
  assert.strictEqual(panel.badgeFor(state.glyphState(restoring), restoring).text, "Restoring…");

  const failed = state.mergeStatus(
    state.mergeStatus(published, { lastResult: { ok: false, summary: "1 failed", at: AT } }),
    state.statusPatchFor(key, layout, drift));
  assert.strictEqual(panel.badgeFor(state.glyphState(failed), failed).text, "Restore failed");

  // And a read that resolves to no topology patches NOTHING — the panel falls
  // back to the published status rather than publishing an empty one.
  assert.strictEqual(state.statusPatchFor("", layout, drift), null);
});

// ------------------------------------------------------------ the PanelHero

test("every badge state keeps its own tone, and the four tones are four", () => {
  // ENUMERATED, not spot-checked. The badge moved into the header beside a
  // PanelHero whose own `detail` pill has ONE fixed border colour, and the
  // reason it did not move INTO that pill is this table: four tones over six
  // states, and the tone is the only channel a glance uses. A regression that
  // flattened them would still produce six correct strings.
  const cases = [
    ["restoring", {}, "Restoring…", "accent"],
    ["paused", {}, "Paused", "muted"],
    ["hollow", {}, "Not recorded", "muted"],
    ["failed", {}, "Restore failed", "urgent"],
    ["drifted", { driftCount: 4 }, "Drifted (4)", "accent"],
    ["ok", {}, "In sync", "ok"]
  ];
  for (const [glyphState, status, text, tone] of cases) {
    assert.deepStrictEqual(panel.badgeFor(glyphState, status), { text, tone },
      `badge for glyph state ${glyphState}`);
  }
  const tones = new Set(cases.map(([, , , tone]) => tone));
  assert.deepStrictEqual([...tones].sort(), ["accent", "muted", "ok", "urgent"]);
  // An unknown glyph state from a newer service reads as the quiet default
  // rather than as nothing at all.
  assert.deepStrictEqual(panel.badgeFor("something-new", {}), { text: "In sync", tone: "ok" });
});

test("the hero meta line carries the state AND the count", () => {
  assert.strictEqual(panel.headerMeta("In sync", 3), "In sync · 3 apps watched");
  assert.strictEqual(panel.headerMeta("Drifted (1)", 1), "Drifted (1) · 1 app watched");
  // The case the count exists for: "In sync" over an empty watched list is a
  // true statement about nothing.
  assert.strictEqual(panel.headerMeta("In sync", 0), "In sync · 0 apps watched");
  // No badge yet (a panel that has read no status) still says the half it knows.
  assert.strictEqual(panel.headerMeta("", 2), "2 apps watched");
  assert.strictEqual(panel.headerMeta(null, null), "0 apps watched");
  assert.strictEqual(panel.headerMeta("In sync", -4), "In sync · 0 apps watched");
  // The Recorded tab's age is one more clause on the same line, and only there.
  assert.strictEqual(panel.headerMeta("In sync", 3, "recorded 3 days ago"),
    "In sync · 3 apps watched · recorded 3 days ago");
  assert.strictEqual(panel.headerMeta("In sync", 3, ""), "In sync · 3 apps watched");
  assert.strictEqual(panel.headerMeta("In sync", 3, null), "In sync · 3 apps watched");
});

// -------------------------------------------- when the layout was recorded

test("the recorded age is read in the recording's own units", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const ago = (ms) => panel.recordedAgeLabel(new Date(now - ms).toISOString(), now);

  assert.strictEqual(ago(0), "recorded just now");
  assert.strictEqual(ago(59 * 1000), "recorded just now");
  assert.strictEqual(ago(60 * 1000), "recorded 1 minute ago");
  assert.strictEqual(ago(45 * 60 * 1000), "recorded 45 minutes ago");
  assert.strictEqual(ago(60 * 60 * 1000), "recorded 1 hour ago");
  assert.strictEqual(ago(23 * 60 * 60 * 1000), "recorded 23 hours ago");
  assert.strictEqual(ago(24 * 60 * 60 * 1000), "recorded 1 day ago");
  assert.strictEqual(ago(3 * 24 * 60 * 60 * 1000), "recorded 3 days ago");
  assert.strictEqual(ago(29 * 24 * 60 * 60 * 1000), "recorded 29 days ago");
  assert.strictEqual(ago(30 * 24 * 60 * 60 * 1000), "recorded 1 month ago");
  assert.strictEqual(ago(200 * 24 * 60 * 60 * 1000), "recorded 6 months ago");
  assert.strictEqual(ago(400 * 24 * 60 * 60 * 1000), "recorded 1 year ago");
});

test("the last five days of the year do not read as twelve months", () => {
  // The cosmetic bug epic c7f's retro caught (tick 05q): `days < 365` with
  // `floor(days / 30)` made 360 to 364 days say "12 months ago" — a unit nobody
  // uses out loud, and one the very next day replaces with "1 year ago".
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const days = (n) =>
    panel.recordedAgeLabel(new Date(now - n * 24 * 60 * 60 * 1000).toISOString(), now);

  assert.strictEqual(days(359), "recorded 11 months ago");
  for (const n of [360, 361, 362, 363, 364]) {
    assert.strictEqual(days(n), "recorded 11 months ago", n + " days");
  }
  assert.strictEqual(days(365), "recorded 1 year ago", "and the year still starts where it did");

  // CLAMPED, not rounded up into a 360-day year: every bucket on this ladder
  // FLOORS, so a label may understate an age and never overstate it. 29 days is
  // "29 days ago" rather than "1 month ago" for exactly the same reason.
  assert.strictEqual(days(29), "recorded 29 days ago");
  assert.strictEqual(days(30), "recorded 1 month ago");

  // And the whole ladder is monotone — no label names a smaller age than the one
  // a day earlier, which is the thing a clamp can get wrong.
  const rank = ["day", "month", "year"];
  let previous = "";
  let lastRank = -1;
  let lastCount = -1;
  // From day 1, because day 0 is "recorded just now" — the one rung of the
  // ladder that names no unit at all.
  for (let n = 1; n <= 800; n++) {
    const label = days(n);
    const parts = /^recorded (\d+) (day|month|year)s? ago$/.exec(label);
    assert.ok(parts, n + " days produced an unparseable label: " + label);
    const unit = rank.indexOf(parts[2]);
    const count = Number(parts[1]);
    if (unit === lastRank) {
      assert.ok(count >= lastCount, "went backwards at " + n + " days: " + previous + " -> " + label);
    } else {
      assert.ok(unit > lastRank, "changed to a smaller unit at " + n + " days: " + previous + " -> " + label);
    }
    lastRank = unit;
    lastCount = count;
    previous = label;
  }
});

test("a recording with no timestamp says nothing rather than guessing", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  // null is what StateModel.normalizeLayout writes for a layout that carries no
  // recordedAt, and it is a DIFFERENT thing from having no recording at all —
  // the payload keeps those apart (present-and-null vs the key being absent)
  // even though the header has nothing to say in either case.
  assert.strictEqual(panel.recordedAgeLabel(null, now), "");
  assert.strictEqual(panel.recordedAgeLabel("", now), "");
  assert.strictEqual(panel.recordedAgeLabel("   ", now), "");
  assert.strictEqual(panel.recordedAgeLabel("not a date", now), "");
  assert.strictEqual(panel.recordedAgeLabel(undefined, now), "");
  // A number is not the schema's shape for this field, whatever Date.parse
  // would make of it.
  assert.strictEqual(panel.recordedAgeLabel(now, now), "");
  // And no clock is no answer.
  assert.strictEqual(panel.recordedAgeLabel("2026-09-01T00:00:00.000Z", NaN), "");
  assert.strictEqual(panel.recordedAgeLabel("2026-09-01T00:00:00.000Z", undefined), "");
});

test("a stamp from the future names its day rather than reading as fresh", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  // A layout recorded on another machine, or before a clock correction. Clamping
  // it to "just now" would make the one recording whose age cannot be known read
  // as the freshest thing in the panel.
  assert.strictEqual(panel.recordedAgeLabel("2026-12-25T09:00:00.000Z", now),
    "recorded 2026-12-25");
  // A minute of skew is a clock being a clock, not a recording from the future.
  assert.strictEqual(panel.recordedAgeLabel("2026-09-03T12:00:30.000Z", now),
    "recorded just now");
});

test("the pause switch is ON when the tool is working", () => {
  // The only polarity a switch with no label can carry: `paused` is the flag,
  // and a switch that was on while the tool was off would be the control lying
  // about itself.
  assert.strictEqual(panel.pauseSwitchChecked(false), true);
  assert.strictEqual(panel.pauseSwitchChecked(true), false);
});

test("Record says why it is unavailable while a restore is in flight", () => {
  assert.strictEqual(panel.recordBlockedHint(false), "");
  const hint = panel.recordBlockedHint(true);
  assert.ok(hint.indexOf("Record") !== -1 && hint.length > 0, hint);
});

test("Record also says why it is out while the last recording's pictures are still being taken (tick ilg)", () => {
  // The second blocked reason, and the one the button gained when `busy` became
  // load-bearing: a control that dims with no explanation reads as broken.
  const capturing = panel.recordBlockedHint(false, true);
  assert.ok(capturing.indexOf("Record is disabled") !== -1, capturing);
  assert.ok(capturing.indexOf("picture") !== -1, capturing);
  assert.notStrictEqual(capturing, panel.recordBlockedHint(true, false));

  // Restoring wins when both hold — two sentences in a one-line hint is a hint
  // nobody reads, and restoring is the one that stops the other half of the
  // panel too.
  assert.strictEqual(panel.recordBlockedHint(true, true), panel.recordBlockedHint(true, false));

  // The old one-argument callers are unchanged: no capture round, no sentence.
  assert.strictEqual(panel.recordBlockedHint(false), "");
  assert.strictEqual(panel.recordBlockedHint(false, false), "");

  // And the tooltip is the same sentence, so the two cannot drift apart.
  assert.strictEqual(panel.recordTooltip(6, "Laptop", false, true), capturing);
});

test("the record button says what it will do", () => {
  assert.strictEqual(panel.recordLabel(6, "Laptop + AOC U34"), "Record 6 apps for Laptop + AOC U34");
  assert.strictEqual(panel.recordLabel(1, "Laptop"), "Record 1 app for Laptop");
  assert.strictEqual(panel.recordLabel(0, "Laptop"), "Record layout");
});

test("the empty state has exactly one hint, and only when it is empty", () => {
  assert.ok(panel.emptyStateHint(0).length > 0);
  assert.strictEqual(panel.emptyStateHint(3), "");
});

// ------------------------------------------------------- the record round trip
//
// What the footer's primary button does end to end: read -> buildLayout ->
// upsertLayout -> serialize -> the service reads it back. Recording is the one
// action that overwrites, so the round trip is worth pinning down.

// The class-only terminal identity a hand-written state file may carry and the
// panel refuses to create (tick gpq — it claims every terminal on the desk).
// Written as a literal because these tests are about the record round trip, not
// about what a tick proposes.
const FOOT_CLASS_IDENTITY = { id: "foot", patterns: ["^foot$"], launch: "" };

test("record writes a layout the service reads back unchanged", () => {
  const identities = panel.toggleWatchedIdentities([], "chromium", "").concat([FOOT_CLASS_IDENTITY]);
  const before = state.setIdentities(state.defaultState(), identities);

  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, state.identities(before), AT);
  const after = state.upsertLayout(before, layout);
  const round = state.parseState(state.serializeState(after));

  const stored = state.layoutFor(round.state, LAPTOP_KEY);
  assert.ok(stored, "filed under the topology it was recorded on");
  assert.strictEqual(stored.recordedAt, AT);
  // Two foot windows are open, and schema v3 records both.
  assert.deepStrictEqual(stored.apps.map((a) => a.identityId).sort(), ["chromium", "foot", "foot"]);
  // And it converges: restoring onto the desktop it was recorded from is a
  // no-op, which is what makes the badge flip to "In sync" straight after. The
  // file holds slots (v8), so resolve them to live ids first, as the service does.
  const table = slots.parseBlocks("0\teDP-1\t" + LAPTOP_KEY + "\n");
  const resolved = slots.toLive(stored, table, monitorsLaptop);
  assert.ok(resolved.apps.every((a) => a.unplaceable === null), "every recorded slot resolves");
  assert.strictEqual(
    engine.planRestore(clientsLaptop, monitorsLaptop, resolved, state.identities(round.state)).length, 0);
});

test("recording again overwrites this topology and leaves the others alone", () => {
  const identities = [FOOT_CLASS_IDENTITY];
  const seeded = state.upsertLayout(
    state.setIdentities(state.defaultState(), identities),
    { topologyKey: "Some other setup", recordedAt: AT, apps: [] });

  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, identities, AT);
  const after = state.upsertLayout(seeded, layout);

  assert.deepStrictEqual(state.topologyKeys(after).sort(), ["Some other setup", LAPTOP_KEY].sort());
  assert.strictEqual(state.layoutFor(after, LAPTOP_KEY).apps.length, layout.apps.length);
});

// ---- instance rows and occurrence-aware chips (tick wzg) -------------------

const ONE_MONITOR = [{ id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }];
const TWO_TERMINALS = [
  makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] }),
  makeClient({ address: "0xbbb", class: "foot", workspace: 2, at: [0, 0], size: [960, 1080] })
];
const TERMINAL_ONLY = [{ id: "terminal", patterns: ["^foot$"], launch: "foot" }];

function instanceFrame(clients, layout, verdicts) {
  const resolve = resolver(TERMINAL_ONLY);
  const report = layout ? engine.driftOf(clients, ONE_MONITOR, layout, TERMINAL_ONLY) : null;
  const index = panel.instanceIndex(clients, ONE_MONITOR, resolve, report, layout);
  return {
    report: report,
    index: index,
    rows: panel.appRows(clients, ONE_MONITOR, resolve, report, layout, TERMINAL_ONLY, null,
      verdicts || (report ? engine.verdictsFor(report, []) : null), index),
    chips: panel.flattenChips(panel.liveMapModel(clients, ONE_MONITOR, resolve, report, 400, 200,
      verdicts || (report ? engine.verdictsFor(report, []) : null), index))
  };
}

test("every instance chip pairs with its own instance row, by linkKey", () => {
  const layout = engine.buildLayout(TWO_TERMINALS, ONE_MONITOR, TERMINAL_ONLY, AT);
  const frame = instanceFrame(TWO_TERMINALS, layout);

  assert.deepStrictEqual(frame.chips.map((c) => c.linkKey), ["id:terminal#0", "id:terminal#1"]);
  assert.deepStrictEqual(frame.chips.map((c) => c.occurrence), [0, 1]);
  assert.deepStrictEqual(frame.chips.map((c) => c.name), ["Terminal (1)", "Terminal (2)"]);

  // Every row has exactly one chip, and every chip exactly one row.
  const rowKeys = frame.rows.map((r) => r.linkKey).sort();
  const chipKeys = frame.chips.map((c) => c.linkKey).sort();
  assert.deepStrictEqual(rowKeys, chipKeys);
  assert.deepStrictEqual(rowKeys, ["id:terminal#0", "id:terminal#1"]);
});

test("the recorded map's chips carry the same instance keys the rows do", () => {
  const layout = engine.buildLayout(TWO_TERMINALS, ONE_MONITOR, TERMINAL_ONLY, AT);
  const frame = instanceFrame(TWO_TERMINALS, layout);
  const recorded = panel.flattenChips(
    panel.recordedMapModel(layout, ONE_MONITOR, ["terminal"], 400, 200, frame.index));

  assert.deepStrictEqual(recorded.map((c) => c.linkKey), ["id:terminal#0", "id:terminal#1"]);
  assert.deepStrictEqual(recorded.map((c) => c.name), ["Terminal (1)", "Terminal (2)"]);
  assert.deepStrictEqual(
    recorded.map((c) => c.linkKey).sort(),
    frame.rows.map((r) => r.linkKey).sort());
});

test("a missing instance gets its own ghost row, saying 'not running' once each", () => {
  const layout = engine.buildLayout(TWO_TERMINALS, ONE_MONITOR, TERMINAL_ONLY, AT);

  // Both closed: two ghosts, not one.
  const none = instanceFrame([], layout);
  assert.strictEqual(none.rows.length, 2);
  assert.ok(none.rows.every((r) => r.ghost && r.position.indexOf("not running") !== -1));
  assert.deepStrictEqual(none.rows.map((r) => r.key), ["terminal#0", "terminal#1"]);

  // One running: one live row and one ghost, and the ghost is the one whose
  // recorded workspace has nothing on it.
  const half = instanceFrame([TWO_TERMINALS[0]], layout);
  assert.strictEqual(half.rows.length, 2);
  assert.deepStrictEqual(half.rows.map((r) => r.ghost), [false, true]);
  assert.strictEqual(half.rows[0].position, "eDP-1 · ws 1");
  assert.ok(half.rows[1].position.indexOf("ws 2") !== -1);
  assert.ok(half.rows[1].position.indexOf("not running") !== -1);
});

test("drift, position and mismatch are per instance, not per app", () => {
  const layout = engine.buildLayout(TWO_TERMINALS, ONE_MONITOR, TERMINAL_ONLY, AT);
  // The ws-2 window has wandered to ws 7; the ws-1 one has not moved.
  const live = [
    TWO_TERMINALS[0],
    makeClient({ address: "0xbbb", class: "foot", workspace: 7, at: [0, 0], size: [960, 1080] })
  ];
  const frame = instanceFrame(live, layout);

  assert.deepStrictEqual(frame.rows.map((r) => r.drifted), [false, true]);
  assert.deepStrictEqual(frame.rows.map((r) => r.position), ["eDP-1 · ws 1", "eDP-1 · ws 7"]);
  assert.strictEqual(frame.rows[0].mismatch, "", "the window that did not move says nothing");
  assert.strictEqual(frame.rows[1].mismatch, "on the wrong workspace (window 2 of 2)");
  assert.strictEqual(frame.rows[1].driftTo, "eDP-1 · ws 2");

  // The chip for that window says the same thing, and only that chip.
  const byKey = {};
  frame.chips.forEach((c) => { byKey[c.linkKey] = c; });
  assert.strictEqual(byKey["id:terminal#0"].mismatch, "");
  assert.strictEqual(byKey["id:terminal#1"].mismatch, "on the wrong workspace (window 2 of 2)");
  assert.strictEqual(byKey["id:terminal#1"].drifted, true);
  assert.strictEqual(byKey["id:terminal#0"].drifted, false);
});

test("a window the recording never saw drops the 'window N of M' marker", () => {
  // The two counts come from different populations: the verdict's `instances`
  // counts DRIFT-REPORT rows (2 recorded windows), while the row's counts the
  // recorded-or-running union (3, because a third terminal is open that the
  // recording has never heard of). Saying "window 2 of 2" on a row the panel
  // itself titles "Terminal (2)" out of three is a mislabel, so the marker goes
  // and the sentence stays identity-level.
  const layout = engine.buildLayout(TWO_TERMINALS, ONE_MONITOR, TERMINAL_ONLY, AT);
  const live = [
    TWO_TERMINALS[0],
    makeClient({ address: "0xbbb", class: "foot", workspace: 7, at: [0, 0], size: [960, 1080] }),
    makeClient({ address: "0xccc", class: "foot", workspace: 5, at: [0, 0], size: [960, 1080] })
  ];
  const frame = instanceFrame(live, layout);

  assert.strictEqual(frame.rows.length, 3, "the unrecorded window gets a row of its own");
  assert.strictEqual(frame.index.byIdentity.terminal.instances, 3);
  // The drift report — and so every verdict — still knows only two.
  assert.ok(engine.verdictsFor(frame.report, []).every((v) => v.instances === 2));

  // The complaint survives; only the marker that could point at the wrong
  // window is gone.
  assert.strictEqual(frame.rows[1].mismatch, "on the wrong workspace");
  const byKey = {};
  frame.chips.forEach((c) => { byKey[c.linkKey] = c; });
  assert.strictEqual(byKey["id:terminal#1"].mismatch, "on the wrong workspace");

  // And when the counts DO agree the marker is untouched — same desktop
  // without the stranger.
  const agreed = instanceFrame([TWO_TERMINALS[0], live[1]], layout);
  assert.strictEqual(agreed.rows[1].mismatch, "on the wrong workspace (window 2 of 2)");
});

test("launchState and launchHint stay identity-level on every instance row", () => {
  const layout = engine.buildLayout(TWO_TERMINALS, ONE_MONITOR, TERMINAL_ONLY, AT);
  const broken = [{ id: "terminal", patterns: ["^foot$"], launch: "" }];
  const resolve = resolver(broken);
  const report = engine.driftOf([], ONE_MONITOR, layout, broken);
  const index = panel.instanceIndex([], ONE_MONITOR, resolve, report, layout);
  const rows = panel.appRows([], ONE_MONITOR, resolve, report, layout, broken, {}, null, index);

  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].launchState, "the identity has a launch problem");
  assert.strictEqual(rows[0].launchState, rows[1].launchState, "and both its windows say so");
  assert.strictEqual(rows[0].launchHint, rows[1].launchHint);
  assert.strictEqual(rows[0].launchRepairable, rows[1].launchRepairable);
});

test("the panel's occurrence coercion is the engine's and the file's", () => {
  // Three independent ES5 files that may not import each other.
  for (const value of [0, 1, 7, "2", " 2 ", -1, 1.5, "1.5", "x", "", null, undefined, NaN,
    Infinity, {}, [2], true]) {
    assert.strictEqual(panel.occurrenceOf(value), engine.occurrenceOf(value), String(value));
    assert.strictEqual(panel.occurrenceOf(value), state.normalizeOccurrence(value), String(value));
  }
});

// ---- terminal-hosted apps: deriving from the CHILD process (tick dwv) -------
//
// The other side of the README's terminal-title rule. `herdr` typed into `foot`
// owns no window: the window is class `foot` and its cmdline is `foot`. The app
// is the terminal's child process, and reading it turns that into the very
// command the README asks the user to bind by hand.
//
// The command names a TITLE, not a private window class (tick hqa, measured
// 2026-08-18): `foot --title=herdr herdr` fixes `initialTitle` at `herdr` while
// the window keeps `class: foot`, so every Omarchy class-matched rule still
// applies; an app that renames itself on start moves `title` only; and
// Hyprland full-matches an unanchored window-rule regex, so a compound class
// like `foot.herdr` could never have been matched alongside plain `foot`.

// The bytes the panel's one Process really prints, for a terminal whose child
// tree is `pids` — [{ pid, argv, children: [...] }].
function procDump(roots) {
  const lines = [];
  const walk = (node, path) => {
    lines.push("@@mw@@ " + path);
    for (const word of node.argv || []) lines.push(word);
    for (const child of node.children || []) walk(child, path + "/" + child.pid);
  };
  for (const node of roots) walk(node, String(node.pid));
  return lines.join("\n") + "\n";
}

const FOOT_REQUEST = {
  identityId: "terminal", patterns: ["^foot$"], className: "foot",
  pid: "900", argv: ["foot"]
};
const ONE_FOOT_WINDOW = [{ address: "0xa", class: "foot", pid: 900 }];

function footDerivation(children) {
  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot"], children: children }
  ]));
  return panel.launchDerivation([FOOT_REQUEST], DESKTOP_FILES,
    panel.windowCountByPid(ONE_FOOT_WINDOW), tree);
}

test("the proc dump rebuilds the child tree the header path describes", () => {
  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot"], children: [
      { pid: 901, argv: ["/bin/bash"], children: [{ pid: 902, argv: ["herdr"] }] }
    ] }
  ]));

  assert.deepStrictEqual(tree["900"].argv, ["foot"]);
  assert.deepStrictEqual(Object.keys(tree["900"].children), ["901"]);
  assert.deepStrictEqual(tree["900"].children["901"].argv, ["/bin/bash"]);
  assert.deepStrictEqual(tree["900"].children["901"].children["902"].argv, ["herdr"]);

  // And the window-pid reader ignores the child sections entirely, so the two
  // questions the one dump answers cannot contaminate each other.
  assert.deepStrictEqual(
    Object.keys(panel.argvByPidFromDump(procDump([
      { pid: 900, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }] }
    ]))),
    ["900"]);
});

test("one unambiguous child derives the --title command the README asks for", () => {
  const derived = footDerivation([{ pid: 901, argv: ["herdr"] }]);
  assert.deepStrictEqual(derived.commands, { terminal: "foot --title=herdr herdr" });
  assert.deepStrictEqual(derived.refusals, {});

  // The child's own arguments travel with it, quoted.
  assert.deepStrictEqual(
    footDerivation([{ pid: 901, argv: ["/usr/bin/herdr", "--watch", "/home/u/My Notes"] }]).commands,
    { terminal: "foot --title=herdr /usr/bin/herdr --watch '/home/u/My Notes'" });
});

test("a bare shell between the terminal and the app is looked THROUGH", () => {
  const derived = footDerivation([
    { pid: 901, argv: ["-bash"], children: [{ pid: 902, argv: ["herdr"] }] }
  ]);
  assert.deepStrictEqual(derived.commands, { terminal: "foot --title=herdr herdr" });
  assert.deepStrictEqual(derived.refusals, {});

  // Every shell spelling, login form included.
  for (const shell of ["sh", "/bin/bash", "zsh", "-zsh", "/usr/bin/fish"]) {
    assert.deepStrictEqual(
      footDerivation([{ pid: 901, argv: [shell], children: [{ pid: 902, argv: ["btop"] }] }]).commands,
      { terminal: "foot --title=btop btop" }, shell);
  }

  // A shell WITH a command of its own is not a bare wrapper: it names what to
  // run, and deriving through it would throw that away.
  assert.deepStrictEqual(
    footDerivation([{ pid: 901, argv: ["bash", "-c", "herdr --watch"] }]).commands,
    { terminal: "foot --title=bash bash -c 'herdr --watch'" });
});

test("two children REFUSE loudly rather than guessing which app is meant", () => {
  const two = footDerivation([{ pid: 901, argv: ["herdr"] }, { pid: 902, argv: ["btop"] }]);
  assert.deepStrictEqual(two.commands, {}, "and no desktop-file fallback either");
  assert.deepStrictEqual(two.refusals, { terminal: "several-children" });

  // A shell with two descendants is the same refusal one level down.
  const busyShell = footDerivation([
    { pid: 901, argv: ["bash"], children: [{ pid: 902, argv: ["herdr"] }, { pid: 903, argv: ["less"] }] }
  ]);
  assert.deepStrictEqual(busyShell.refusals, { terminal: "several-children" });

  // No children at all — a terminal sitting at nothing — is also a refusal:
  // there is no app here to derive.
  assert.deepStrictEqual(footDerivation([]).refusals, { terminal: "no-child" });
  assert.deepStrictEqual(
    footDerivation([{ pid: 901, argv: ["bash"] }]).refusals, { terminal: "no-child" },
    "a shell at a prompt hosts nothing");
  assert.deepStrictEqual(
    footDerivation([{ pid: 901, argv: ["bash"], children: [{ pid: 902, argv: ["zsh"] }] }]).refusals,
    { terminal: "shell-chain" });
});

test("a refusal says 'ambiguous' and points at the --title convention", () => {
  const identities = [{ id: "terminal", patterns: ["^foot$"], launch: "" }];
  const refused = footDerivation([{ pid: 901, argv: ["herdr"] }, { pid: 902, argv: ["btop"] }]);

  const states = panel.launchStateIndex(identities, refused.commands, refused.refusals);
  assert.strictEqual(states.terminal, "ambiguous");
  assert.strictEqual(panel.launchHintFor("ambiguous"),
    "runs in a terminal — give it its own --title");

  // It reaches the row, through the plumbing the other launch states use.
  const rows = panel.appRows(ONE_FOOT_WINDOW.map((c) => makeClient({ address: c.address, class: c.class, workspace: 1 })),
    ONE_MONITOR, resolver(identities), null, null, identities, refused.commands, null, null, refused.refusals);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].launchState, "ambiguous");
  assert.strictEqual(rows[0].launchHint, "runs in a terminal — give it its own --title");
  assert.strictEqual(rows[0].launchRepairable, false, "there is nothing to learn, so nothing is offered");

  // And nothing is watched by any of this: derivation only feeds the hint.
  assert.deepStrictEqual(identities, [{ id: "terminal", patterns: ["^foot$"], launch: "" }]);

  // Without a refusals map, every answer is exactly the pre-tick one.
  assert.strictEqual(panel.launchStateIndex(identities, refused.commands).terminal, "missing");
});

test("the browser-family and shared-pid guards still win over the child read", () => {
  // A shared process: two windows on one pid. Even if that pid has exactly one
  // child, its argv describes no single window and the guard comes first.
  const shared = [{ address: "0xa", class: "foot", pid: 900 }, { address: "0xb", class: "foot", pid: 900 }];
  const sharedTree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  const sharedDerived = panel.launchDerivation([FOOT_REQUEST], DESKTOP_FILES,
    panel.windowCountByPid(shared), sharedTree);
  assert.deepStrictEqual(sharedDerived.commands, { terminal: "foot" }, "foot.desktop, as before");
  assert.deepStrictEqual(sharedDerived.refusals, {});

  // A browser is not a terminal, so the child read never runs for it — its own
  // guard answers first and the desktop file has the last word.
  const browserClients = [{ address: "0x1", class: "chromium", pid: 4242 }];
  const browserTree = panel.procTreeFromDump(procDump([
    { pid: 4242, argv: ["chromium"], children: [{ pid: 4243, argv: ["chromium", "--type=renderer"] }] }
  ]));
  const browser = panel.launchDerivation([{
    identityId: "chromium", patterns: ["^chromium$"], className: "chromium",
    pid: "4242", argv: ["chromium"]
  }], DESKTOP_FILES, panel.windowCountByPid(browserClients), browserTree);
  assert.deepStrictEqual(browser.commands, { chromium: "/usr/bin/chromium" });
  assert.deepStrictEqual(browser.refusals, {});
});

test("a terminal that already carries its own command is left alone", () => {
  // `foot --title=herdr herdr` derives the ordinary way — the cmdline IS the
  // answer — and the child read must not second-guess it. The window this
  // cmdline produces is the one in clients-titled-terminal.json.
  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot", "--title=herdr", "herdr"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  const derived = panel.launchDerivation([{
    identityId: "herdr", patterns: ["^foot$"], className: "foot",
    pid: "900", argv: ["foot", "--title=herdr", "herdr"]
  }], DESKTOP_FILES, { "900": 1 }, tree);
  assert.deepStrictEqual(derived.commands, { herdr: "foot --title=herdr herdr" });
  assert.deepStrictEqual(derived.refusals, {});
});

// The window a derived `--title` command actually produces, as hyprctl reports
// it. No captured fixture had one — every foot client in clients-laptop.json
// carries `initialTitle: "foot"` — so this synthesized one closes the loop
// between the command this file derives and the window an identity matches.
test("the titled-terminal fixture is a foot window whose initialTitle is NOT foot", () => {
  const clients = loadFixture("clients-titled-terminal.json");
  const titled = clients.find((c) => c.initialTitle === "herdr");
  assert.ok(titled, "the fixture must carry the titled foot window");

  // The whole point of the convention: the CLASS is untouched, so every
  // class-matched Omarchy window rule still applies to it.
  assert.strictEqual(titled.class, "foot");
  assert.strictEqual(titled.initialClass, "foot");

  // And the app renamed itself the instant it started — `title` moved,
  // `initialTitle` did not. That is why matching reads initialTitle only.
  assert.notStrictEqual(titled.title, titled.initialTitle);

  // A plain `foot` window sits beside it with the same class, so title is the
  // only thing that can tell the two apart.
  const plain = clients.find((c) => c.initialTitle === "foot");
  assert.ok(plain && plain.class === "foot");

  const identities = [
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"] },
    { id: "terminal", patterns: ["^foot$"] }
  ];
  assert.strictEqual(engine.matchClient(titled, identities), "herdr");
  assert.strictEqual(engine.matchClient(plain, identities), "terminal");
});

// -------------------------------------------- a tick that proposes a TITLE
//
// Tick 1uz. Ticking a plain `foot` window running `herdr` used to propose
// `^foot$` — an identity that claims EVERY terminal on the desktop, which is
// worse than useless: the next terminal the user opens would be "herdr" too.
// When the child process names the app unambiguously the proposal is the PAIR
// instead, and under the v4 AND semantics that pair claims one window.

// The raw derivation answer, rather than the launch map footDerivation returns.
function footChildDerivation(children, ownArgv) {
  const argv = ownArgv || ["foot"];
  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: argv, children: children }
  ]));
  return panel.terminalChildDerivation("foot", argv, tree["900"]);
}

test("the derivation says the title as well as the command", () => {
  // Two callers want two halves of one answer — the launch map wants the
  // command, suggestIdentity wants the title — so it is derived once.
  const derived = footChildDerivation([{ pid: 901, argv: ["herdr"] }]);
  assert.strictEqual(derived.command, "foot --title=herdr herdr");
  assert.strictEqual(derived.title, "herdr");
  assert.strictEqual(derived.reason, "");

  // A refusal names no title — there is nothing here it could honestly name.
  const refused = footChildDerivation([{ pid: 901, argv: ["herdr"] }, { pid: 902, argv: ["btop"] }]);
  assert.strictEqual(refused.title, "");
  assert.strictEqual(refused.reason, "several-children");

  // And a question that was never a terminal question at all.
  assert.deepStrictEqual(panel.terminalChildDerivation("chromium", ["chromium"], null),
    { command: "", title: "", reason: "" });
});

test("a title becomes an anchored title pattern and an id of its own", () => {
  assert.strictEqual(panel.deriveTitlePattern("herdr"), "^herdr$");
  // Both ends, always: a title is a whole word the --title convention put
  // there, not a class with a varying packaging tail. derivePattern would have
  // made this one an open-ended prefix.
  assert.strictEqual(panel.derivePattern("chrome-thing"), "^chrome-thing");
  assert.strictEqual(panel.deriveTitlePattern("chrome-thing"), "^chrome-thing$");
  assert.strictEqual(panel.deriveTitlePattern(""), "");

  assert.strictEqual(panel.identityIdFromTitle("herdr"), "herdr");
  // deriveIdentityId answers "11" here — it reads a reverse-DNS CLASS, so it
  // splits on dots and keeps the last token. A title is already one word.
  assert.strictEqual(panel.deriveIdentityId("python3.11"), "11");
  assert.strictEqual(panel.identityIdFromTitle("python3.11"), "python3-11");
});

test("ticking a terminal that hosts one app proposes the app, not the terminal", () => {
  const added = panel.suggestIdentity("foot", [], footChildDerivation([{ pid: 901, argv: ["herdr"] }]));
  assert.deepStrictEqual(added, {
    id: "herdr",
    patterns: ["^foot$"],
    titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr"
  });

  // And that pair claims exactly one of the two foot windows on the desktop.
  const clients = loadFixture("clients-titled-terminal.json");
  assert.strictEqual(
    engine.clientMatchesIdentity(clients.find((c) => c.initialTitle === "herdr"), added), true);
  assert.strictEqual(
    engine.clientMatchesIdentity(clients.find((c) => c.initialTitle === "foot"), added), false);
});

test("a refusal proposes nothing at all, and says why", () => {
  // It USED to propose the pre-1uz class identity here — `^foot$` with an empty
  // launch — which claims every terminal on the desktop and, once the autofill
  // pass had stamped one app's command onto it, launched whichever one the
  // click happened to catch. Tick gpq made it a refusal the panel says out loud.
  const ambiguous = footChildDerivation([{ pid: 901, argv: ["herdr"] }, { pid: 902, argv: ["btop"] }]);
  assert.deepStrictEqual(panel.suggestIdentity("foot", [], ambiguous),
    { refusal: "several-children" });

  // Same for a terminal whose cmdline has not come back yet, and for a caller
  // that passes no derivation at all.
  assert.strictEqual(
    panel.suggestIdentity("foot", [], panel.terminalTickDerivation("foot", null, null, "foot")).refusal,
    "not-read");
  assert.strictEqual(panel.suggestIdentity("foot", []).refusal, "not-read");
});

test("the duplicate guard compares BOTH axes, not patterns alone", () => {
  const herdr = footChildDerivation([{ pid: 901, argv: ["herdr"] }]);
  const btop = footChildDerivation([{ pid: 901, argv: ["btop"] }]);

  // The case the whole tick turns on: plain foot is already watched, so the
  // class pattern collides. Comparing `patterns` alone would call this a
  // duplicate and propose nothing — but "every foot window" and "the foot
  // window titled herdr" are different rules over different windows.
  const watchedFoot = [{ id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" }];
  assert.deepStrictEqual(panel.suggestIdentity("foot", watchedFoot, herdr), {
    id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr"
  });

  // The same PAIR already on the list is the same rule, so nothing is added —
  // and since tick v5c that is said out loud rather than answered with null.
  const watchedHerdr = [{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }];
  assert.deepStrictEqual(panel.suggestIdentity("foot", watchedHerdr, herdr), { refusal: "already-watched" });

  // A different title on the same class is a different rule.
  assert.strictEqual(panel.suggestIdentity("foot", watchedHerdr, btop).id, "btop");

  // The other direction: watching one titled foot window does not make a
  // class-only proposal a DUPLICATE — an empty title list is no constraint,
  // which makes it a wider rule rather than the same one. It is refused for the
  // other reason, that a terminal's class names no app (tick gpq).
  assert.strictEqual(panel.suggestIdentity("foot", watchedHerdr).refusal, "not-read");

  // The class-only guard still answers the same FACT, now with a reason.
  assert.deepStrictEqual(panel.suggestIdentity("foot",
    [{ id: "terminal", patterns: ["^foot$"], launch: "" }]), { refusal: "already-watched" });

  // An id collision is still suffixed rather than merged.
  const takenId = [{ id: "herdr", patterns: ["^something-else$"], launch: "" }];
  assert.strictEqual(panel.suggestIdentity("foot", takenId, herdr).id, "herdr-2");
});

test("a ticked title identity is prepended, so first-match reaches it first", () => {
  const before = [{ id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" }];
  const after = panel.toggleWatchedIdentities(before, "foot", "",
    footChildDerivation([{ pid: 901, argv: ["herdr"] }]));
  assert.deepStrictEqual(after.map((i) => i.id), ["herdr", "terminal"]);

  // matchClient is first-match-wins across the whole list and title carries no
  // priority of its own — the ORDER is what makes this work.
  const clients = loadFixture("clients-titled-terminal.json");
  const titled = clients.find((c) => c.initialTitle === "herdr");
  assert.strictEqual(engine.matchClient(titled, after), "herdr");
  assert.strictEqual(engine.matchClient(clients.find((c) => c.initialTitle === "foot"), after), "terminal");
  // Behind the catch-all it would never be reached at all, which is why the
  // prepending in toggleWatchedIdentities is load-bearing here.
  assert.strictEqual(engine.matchClient(titled, after.slice().reverse()), "terminal");

  // Untick removes it by id, exactly as for any other identity.
  assert.deepStrictEqual(panel.toggleWatchedIdentities(after, "foot", "herdr"), before);
});

test("a proposed title identity survives StateModel's normalizer intact", () => {
  // The field whitelist has to carry both lists AND the launch through a write
  // — an identity that loses `titlePatterns` on the way in stops matching its
  // window and nothing says why.
  const identities = panel.toggleWatchedIdentities([], "foot", "",
    footChildDerivation([{ pid: 901, argv: ["herdr"] }]));
  const round = state.parseState(state.serializeState(state.setIdentities(state.defaultState(), identities)));
  assert.deepStrictEqual(round.state.identities, [{
    id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr"
  }]);
});

// ------------------------------------ the tick, from the best evidence (gpq)
//
// The blocker: the README told the user to launch `foot --title=herdr herdr`,
// and ticking exactly that window wrote `{id:"foot", patterns:["^foot$"]}` —
// the catch-all the README itself calls useless — because the derivation only
// ever looked at the child process and a three-word cmdline is "not a terminal
// question" to it. The title was on the window the whole time.

const TITLED_TERMINALS = loadFixture("clients-titled-terminal.json");
const TITLED_WINDOW = TITLED_TERMINALS.find((c) => c.initialTitle === "herdr");
const BARE_WINDOW = TITLED_TERMINALS.find((c) => c.initialTitle === "foot");

test("a window already launched with --title proposes that title", () => {
  const argv = ["foot", "--title=herdr", "herdr"];
  const derived = panel.terminalTickDerivation("foot", argv, null, TITLED_WINDOW.initialTitle);
  assert.deepStrictEqual(derived,
    { command: "foot --title=herdr herdr", title: "herdr", reason: "" });

  // And the identity it proposes matches the window that was ticked — which is
  // the whole difference from the catch-all, which matched every terminal.
  const added = panel.suggestIdentity("foot", [], derived);
  assert.deepStrictEqual(added, {
    id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr"
  });
  assert.strictEqual(engine.clientMatchesIdentity(TITLED_WINDOW, added), true);
  assert.strictEqual(engine.clientMatchesIdentity(BARE_WINDOW, added), false);

  // No child process is needed for any of it: the flag IS the answer, and it
  // is read before the tree is even looked at.
  assert.strictEqual(panel.titleFromOwnArgv(argv), "herdr");
  // The separated spelling is as ordinary on a command line as the joined one.
  assert.strictEqual(panel.titleFromOwnArgv(["foot", "--title", "herdr", "herdr"]), "herdr");
  assert.strictEqual(panel.titleFromOwnArgv(["foot"]), "");
  // Short forms are deliberately not read — they mean different things to
  // different terminals, and a wrong one writes a pattern that matches nothing.
  assert.strictEqual(panel.titleFromOwnArgv(["foot", "-T", "herdr"]), "");
});

test("a --title belonging to the HOSTED command is never read as the terminal's", () => {
  // Tick qkz. The scan ran to the end of argv, so the flag of the program the
  // terminal is RUNNING was read as the terminal's own. `watch --title x` is an
  // ordinary command line, and the identity it produced promised a window
  // titled `x` that alacritty never sets — a permanent awaiting-title ghost,
  // with the log affirming the tick.
  assert.strictEqual(panel.titleFromOwnArgv(["alacritty", "-e", "watch", "--title", "x"]), "",
    "-e is where the terminal's own argv ends");
  assert.deepStrictEqual(
    panel.terminalTickDerivation("alacritty", ["alacritty", "-e", "watch", "--title", "x"], null, "Alacritty"),
    { command: "", title: "", reason: "no-title" });

  // foot and kitty take a BARE trailing command (TERMINAL_FAMILY exec ""), so
  // their boundary is the first word that is not a flag.
  assert.strictEqual(panel.titleFromOwnArgv(["foot", "watch", "--title", "x"]), "");
  assert.strictEqual(panel.titleFromOwnArgv(["kitty", "--hold", "watch", "--title=x"]), "");
  assert.strictEqual(panel.titleFromOwnArgv(["foot", "--", "watch", "--title=x"]), "");

  // The terminal's OWN --title still reads, before and after other flags of its
  // own, in both spellings — that is the flow the README documents.
  assert.strictEqual(panel.titleFromOwnArgv(["foot", "--title=herdr", "herdr"]), "herdr");
  assert.strictEqual(panel.titleFromOwnArgv(["alacritty", "--title", "herdr", "-e", "herdr"]), "herdr");
  assert.strictEqual(
    panel.titleFromOwnArgv(["foot", "--working-directory=/x", "--title=herdr", "herdr"]), "herdr");
});

test("a terminal launched with a command of its own is named by its window title", () => {
  // `foot -e btop` sets no --title, but foot titled the window from the command
  // and initialTitle is fixed at map time. That IS evidence about this window.
  const derived = panel.terminalTickDerivation("foot", ["foot", "-e", "btop"], null, "btop");
  assert.deepStrictEqual(derived, { command: "foot -e btop", title: "btop", reason: "" });

  // A title that is only the class again says nothing.
  assert.strictEqual(
    panel.terminalTickDerivation("foot", ["foot", "-e", "btop"], null, "foot").reason, "no-title");

  // A BARE terminal never takes its title from the window: an interactive shell
  // retitles it to a working directory before it is mapped, and
  // `^user@host:~/git/dock-recall$` is junk that happens to match once. The
  // child process is the evidence there — see the case below.
  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  assert.strictEqual(
    panel.terminalTickDerivation("foot", ["foot"], tree["900"], "user@host:~/git").title, "herdr");
});

test("a shell or flag-only argv never trusts a shell-retitled window title", () => {
  // Tick q58. `argv.length > 1` was a proxy for "the terminal was launched with
  // a command of its own", and it is not one: a terminal carrying only its own
  // flags, or one whose command is a bare SHELL, is exactly the case the
  // comment above the branch says must never be trusted — an interactive shell
  // retitles the window to its working directory before it is mapped. What came
  // out was a titlePattern matching only in that directory, on an identity
  // whose launch reopens a bare shell.
  assert.deepStrictEqual(
    panel.terminalTickDerivation("foot", ["foot", "--working-directory=/x"], null, "~/proj"),
    { command: "", title: "", reason: "no-title" });
  assert.deepStrictEqual(
    panel.terminalTickDerivation("foot", ["foot", "fish"], null, "~/proj"),
    { command: "", title: "", reason: "no-title" });
  assert.deepStrictEqual(
    panel.terminalTickDerivation("alacritty", ["alacritty", "-e", "/usr/bin/bash"], null, "~/proj"),
    { command: "", title: "", reason: "no-title" });

  // And the refusal reaches the panel rather than a junk identity reaching the
  // file: no titlePatterns, no `^~/proj$`.
  for (const argv of [["foot", "--working-directory=/x"], ["foot", "fish"]]) {
    assert.deepStrictEqual(
      panel.suggestIdentity("foot", [], panel.terminalTickDerivation("foot", argv, null, "~/proj")),
      { refusal: "no-title" });
  }

  // A REAL hosted command is still trusted — that is the case the branch exists
  // for, in both the exec-flag and the bare-trailing-command shapes.
  assert.deepStrictEqual(panel.terminalTickDerivation("foot", ["foot", "-e", "btop"], null, "btop"),
    { command: "foot -e btop", title: "btop", reason: "" });
  assert.deepStrictEqual(panel.terminalTickDerivation("foot", ["foot", "btop"], null, "btop"),
    { command: "foot btop", title: "btop", reason: "" });
});

test("a flag's SPACE-separated value is never a hosted command", () => {
  // Tick 3bp. The two spellings of one flag answered differently. `foot
  // --working-directory=/x` refused (the test above pins it); `foot
  // --working-directory /x` produced `{command: "foot --working-directory /x",
  // title: "~/proj"}` — the same junk identity, from the same launch, because
  // hostedArgvOf stopped its scan at the unknown flag and handed the flag's
  // VALUE (`/x`) to the case-2 gate as a hosted command. The gate reads a
  // hosted command as "the terminal set this window's title", and the title it
  // then trusted was one an interactive shell had written: `^~/proj$` matches
  // only while that shell sits in that directory, and the launch reopens a bare
  // shell.
  assert.deepStrictEqual(
    panel.terminalTickDerivation("foot", ["foot", "--working-directory", "/x"], null, "~/proj"),
    { command: "", title: "", reason: "no-title" },
    "the space spelling refuses exactly as the = spelling does");

  // The two spellings now agree, which is the whole point of the repair.
  assert.deepStrictEqual(
    panel.terminalTickDerivation("foot", ["foot", "--working-directory", "/x"], null, "~/proj"),
    panel.terminalTickDerivation("foot", ["foot", "--working-directory=/x"], null, "~/proj"));

  // And the refusal reaches the panel instead of the identity reaching the file.
  assert.deepStrictEqual(
    panel.suggestIdentity("foot", [],
      panel.terminalTickDerivation("foot", ["foot", "--working-directory", "/x"], null, "~/proj")),
    { refusal: "no-title" });

  // A flag with a separate value does not hide a REAL hosted command sitting
  // behind it: the value is consumed, the command after it is still found.
  assert.deepStrictEqual(
    panel.terminalTickDerivation("foot", ["foot", "--working-directory", "/x", "btop"], null, "btop"),
    { command: "foot --working-directory /x btop", title: "btop", reason: "" });

  // Nor does it disturb the terminal's OWN --title in its separate-value
  // spelling, which case 1 reads before this question is ever asked.
  assert.deepStrictEqual(
    panel.terminalTickDerivation("foot", ["foot", "--title", "herdr", "herdr"], null, "~/proj"),
    { command: "foot --title herdr herdr", title: "herdr", reason: "" });
});

test("no title travels with a command the panel refuses to run", () => {
  // Tick cjs. The invariant terminalChildDerivation states in as many words —
  // "the title travels only with a command that survived dispatchableCommand"
  // — was not held by the two cases that read the terminal's OWN argv. A
  // refused command left `command: ""` and handed the title over anyway, and
  // `launch: ""` is the schema's NEVER-LAUNCH marker: the tick wrote a
  // titlePatterns identity that can never be started, as a silent success, and
  // the restore that discovered it was months away.
  const flagged = ["foot", "--title=herdr", "herdr", "]]"];
  assert.strictEqual(panel.launchCommandFromArgv(flagged, "foot"), "",
    "dispatchableCommand refuses this argv");
  assert.deepStrictEqual(panel.terminalTickDerivation("foot", flagged, null, "herdr"),
    { command: "", title: "", reason: "unrunnable-command" });

  // Case 2 reads the same argv for its command, so it fails the same way.
  const shown = ["foot", "-e", "herdr", "]]"];
  assert.deepStrictEqual(panel.terminalTickDerivation("foot", shown, null, "herdr"),
    { command: "", title: "", reason: "unrunnable-command" });

  // And it is LOUD: the refusal reaches the panel as a sentence, instead of a
  // tick mark over an identity that will never come back.
  for (const argv of [flagged, shown]) {
    const derived = panel.terminalTickDerivation("foot", argv, null, "herdr");
    assert.deepStrictEqual(panel.suggestIdentity("foot", [], derived),
      { refusal: "unrunnable-command" });
    assert.strictEqual(panel.tickRefusalReason("foot", [], derived), "unrunnable-command");
    const hint = panel.tickRefusalHint("foot", "unrunnable-command");
    assert.ok(hint.indexOf("cannot be turned into a command that runs") !== -1, hint);
  }

  // A runnable argv is untouched by any of it.
  assert.deepStrictEqual(panel.terminalTickDerivation("foot", ["foot", "--title=herdr", "herdr"], null, "herdr"),
    { command: "foot --title=herdr herdr", title: "herdr", reason: "" });
});

test("a terminal tick that cannot name its app refuses, and never writes the catch-all", () => {
  // THE OTHER HALF OF THE BLOCKER. Every one of these used to answer
  // {id:"foot", patterns:["^foot$"]}: an identity claiming every terminal on
  // the desk, whose one learned launch command starts one of them.
  const twoChildren = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }, { pid: 902, argv: ["btop"] }] }
  ]))["900"];

  // The /proc read has not come back yet — the race the panel admits to.
  assert.deepStrictEqual(panel.suggestIdentity("foot", []),
    { refusal: "not-read" });
  assert.deepStrictEqual(panel.suggestIdentity("foot", [], panel.terminalTickDerivation("foot", null, null, "foot")),
    { refusal: "not-read" });
  // Two children: naming one of them would be a guess.
  assert.strictEqual(
    panel.suggestIdentity("foot", [], panel.terminalTickDerivation("foot", ["foot"], twoChildren, "foot")).refusal,
    "several-children");
  // A bare prompt.
  assert.strictEqual(panel.tickRefusalReason("foot", [],
    panel.terminalTickDerivation("foot", ["foot"], null, "foot")), "no-child");

  // The list is untouched, so nothing was written.
  assert.deepStrictEqual(panel.toggleWatchedIdentities([], "foot", ""), []);

  // A class that is not a terminal is unaffected: a class IS the whole truth
  // about a browser window, and there is nothing to refuse.
  assert.strictEqual(panel.tickRefusalReason("chromium", []), "");
  assert.deepStrictEqual(panel.suggestIdentity("chromium", []),
    { id: "chromium", patterns: ["^chromium$"], launch: "" });

  // Already watched is a no-op — and since tick v5c a no-op the panel can SAY,
  // because a silent one logged a success line for a click that changed nothing.
  assert.deepStrictEqual(panel.suggestIdentity("foot",
    [{ id: "terminal", patterns: ["^foot$"], launch: "foot" }]), { refusal: "already-watched" });

  // And the panel has a sentence for it, naming the way out.
  const said = panel.tickRefusalHint("foot", "several-children");
  assert.ok(said.indexOf("--title") !== -1, said);
  assert.ok(said.indexOf("more than one thing") !== -1, said);
  // "Press again in a moment" is only honest for the read that has not landed.
  assert.ok(panel.tickRefusalHint("foot", "not-read").indexOf("again in a moment") !== -1);
  assert.strictEqual(panel.tickRefusalHint("foot", ""), "");
  assert.strictEqual(panel.tickRefusalHint("", "no-child"), "");
});

test("a new identity is never inserted in front of one it would shadow", () => {
  // The panel used to MANUFACTURE the state engine.shadowedIdentities reports:
  // prepending a `^foot$` in front of a working `{^foot$ + ^herdr$}` makes every
  // herdr window answer "terminal", and even unticking then removes the wrong
  // identity. Human decision (2026-08-19): keep prepend, except behind the
  // identities the addition would shadow.
  const herdr = { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "foot" };
  const wide = { id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" };
  const browser = { id: "browser", patterns: ["^chromium$"], titlePatterns: [], launch: "chromium" };

  // The hazard, direct: the catch-all lands BEHIND the title identity.
  assert.deepStrictEqual(panel.insertionIndexFor(wide, [herdr], engine.couldShadow), 1);
  assert.deepStrictEqual(
    engine.shadowedIdentities(TITLED_TERMINALS, [herdr, wide]), [],
    "and that order shadows nothing");

  // The other direction is untouched: a title identity still goes in FRONT of
  // the catch-all, which is the order that makes it reachable at all.
  assert.strictEqual(panel.insertionIndexFor(herdr, [wide], engine.couldShadow), 0);

  // Identities that share no class pattern claim from different pools of
  // windows, so the front is still where a new one goes. couldShadow alone says
  // "yes" to any two class-only identities — it is an axis test, blind to what
  // the patterns say — and following it there would sink every new identity to
  // the back of the list for no reason.
  assert.strictEqual(panel.insertionIndexFor(wide, [browser], engine.couldShadow), 0);
  assert.strictEqual(panel.sharesClassPattern(wide, browser), false);
  assert.strictEqual(panel.sharesClassPattern(wide, herdr), true);
  // Case-insensitively, because engine.compilePattern compiles that way.
  assert.strictEqual(panel.sharesClassPattern({ patterns: ["^Foot$"] }, wide), true);

  // AFTER THE LAST one it would shadow, not before the first.
  assert.strictEqual(
    panel.insertionIndexFor(wide, [herdr, browser, { id: "btop", patterns: ["^foot$"], titlePatterns: ["^btop$"] }],
      engine.couldShadow), 3);

  // End to end, through the toggle: the webapp-before-catch-all shape from
  // StateModel's own schema comment. A freshly ticked plain browser must not
  // land in front of the webapp identity that also claims `^chromium$`.
  const slack = { id: "slack", patterns: ["^chromium$"], titlePatterns: ["^slack$"], launch: "" };
  const after = panel.toggleWatchedIdentities([slack], "chromium", "", null, engine.couldShadow);
  assert.deepStrictEqual(after.map((i) => i.id), ["slack", "chromium"]);
  assert.deepStrictEqual(
    engine.shadowedIdentities([makeClient({ class: "chromium", initialTitle: "slack" })], after), [],
    "and the webapp still wins its own window");

  // Without the rule — every caller that predates it — the insert prepends.
  assert.deepStrictEqual(
    panel.toggleWatchedIdentities([slack], "chromium", "").map((i) => i.id), ["chromium", "slack"]);
});

test("the panel names the exact relaunch command until a matching window exists", () => {
  // Human decision (2026-08-19): ticking a BARE terminal still creates the
  // identity — the derivation is right about what the app is — but the window
  // in front of the user has initialTitle "foot" and matches nothing. Saying
  // nothing would be the silent wrong answer; refusing would throw away a
  // correct derivation. So: create it, and say what is missing.
  const argvByPid = { "268861": ["foot"] };
  const procTree = panel.procTreeFromDump(procDump([
    { pid: 268861, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  const identities = panel.toggleWatchedIdentities([], "foot", "",
    panel.terminalTickDerivation("foot", ["foot"], procTree["268861"], "foot"),
    engine.couldShadow);
  assert.deepStrictEqual(identities, [{
    id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr"
  }]);

  // The bare window alone: nothing matches, and the panel says so with the
  // command that fixes it.
  const said = panel.awaitingTitleHint([BARE_WINDOW], identities,
    resolver(identities), argvByPid, procTree);
  assert.ok(said.indexOf('"herdr" is watched') === 0, said);
  assert.ok(said.indexOf("Relaunch it as: foot --title=herdr herdr") !== -1, said);

  // It CLEARS the moment a window matches — which is exactly what relaunching
  // with --title does.
  assert.strictEqual(panel.awaitingTitleHint([BARE_WINDOW, TITLED_WINDOW], identities,
    resolver(identities), argvByPid, procTree), "");
  // No evidence, no sentence: an app that is simply not running says nothing,
  // and neither does a terminal whose child names something else.
  assert.strictEqual(panel.awaitingTitleHint([], identities, resolver(identities), {}, {}), "");
  assert.strictEqual(panel.awaitingTitleHint([BARE_WINDOW], identities,
    resolver(identities), argvByPid, panel.procTreeFromDump(procDump([
      { pid: 268861, argv: ["foot"], children: [{ pid: 901, argv: ["btop"] }] }
    ]))), "");
  // A class-only identity is not this problem and never gets the line.
  assert.strictEqual(panel.awaitingTitleHint([BARE_WINDOW],
    [{ id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" }],
    resolver([{ id: "terminal", patterns: ["^foot$"], titlePatterns: [] }]), argvByPid, procTree), "");
});

test("a title identity with no window yet still gets a row, and the row unticks it", () => {
  // The gap tick 1m4 closes. Ticking a bare terminal creates a correct identity
  // that matches nothing yet, so it produced no chip and no row — and pressing
  // the chip again re-ticked idempotently rather than unticking, because there
  // was no ticked chip to clear. A mis-tick could only be undone by editing the
  // state file by hand.
  const procTree = panel.procTreeFromDump(procDump([
    { pid: 268861, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  const identities = panel.toggleWatchedIdentities([], "foot", "",
    panel.terminalTickDerivation("foot", ["foot"], procTree["268861"], "foot"),
    engine.couldShadow);
  assert.deepStrictEqual(identities.map((i) => i.id), ["herdr"]);
  assert.ok(!engine.matchClient(BARE_WINDOW, identities),
    "the ticked window still matches nothing — that is the whole problem");

  const rows = panel.appRows([BARE_WINDOW], monitorsLaptop, resolver(identities),
    null, null, identities, {});
  const herdr = rows.filter((r) => r.identityId === "herdr");
  assert.strictEqual(herdr.length, 1, "the identity has a row of its own");
  assert.strictEqual(herdr[0].watched, true, "it IS watched, so it renders ticked");
  assert.strictEqual(herdr[0].awaitingTitle, true);
  assert.strictEqual(herdr[0].clickable, true, "and a click can take it back off");
  // WHY it is not running, which is what tells it apart from a closed app.
  assert.strictEqual(herdr[0].position,
    "not running · will match once relaunched with --title");
  assert.strictEqual(herdr[0].ghost, true);
  // The untick, end to end: the row carries no class, so it is removed by id —
  // and the identity is gone without a hand edit anywhere.
  assert.deepStrictEqual(
    panel.toggleWatchedIdentities(identities, herdr[0].className, herdr[0].identityId,
      null, engine.couldShadow), []);

  // It becomes an ORDINARY row the moment a matching window exists — one row,
  // not two, and no longer a ghost.
  const relaunched = panel.appRows([TITLED_WINDOW], monitorsLaptop, resolver(identities),
    null, null, identities, {});
  const matched = relaunched.filter((r) => r.identityId === "herdr");
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].awaitingTitle, false);
  assert.strictEqual(matched[0].ghost, false);

  // Evidence, not a prediction, exactly like the hint: no terminal of that class
  // on screen, no row.
  assert.deepStrictEqual(panel.awaitingTitleIndex([], identities, resolver(identities)), {});
  assert.deepStrictEqual(panel.appRows([], monitorsLaptop, resolver(identities),
    null, null, identities, {}), []);
  assert.deepStrictEqual(panel.awaitingTitleIndex([BARE_WINDOW], identities, resolver(identities)),
    { herdr: "foot" });
  assert.deepStrictEqual(panel.awaitingTitleIndex([BARE_WINDOW, TITLED_WINDOW], identities,
    resolver(identities)), {}, "and it clears the moment a window matches");

  // A webapp identity whose window is simply CLOSED is an ordinary closed app,
  // and nothing here says a word about it — the condition still requires a live
  // window of the identity's own class.
  const slack = [{ id: "slack", patterns: ["^chrome-app.slack.com__x$"], titlePatterns: ["^Slack$"], launch: "" }];
  assert.deepStrictEqual(panel.awaitingTitleIndex(
    [makeClient({ class: "chromium", initialTitle: "News" })], slack, resolver(slack)), {});

  // But a HAND-AUTHORED non-terminal title identity whose class IS on screen and
  // still matches nothing is the same recoverable mis-tick a terminal's is, and
  // since tick s7l it gets the same row. What it does not get is the `--title`
  // advice, which is not true about a chromium window — see the s7l tests below.
  const gmail = [{ id: "gmail", patterns: ["^chromium$"], titlePatterns: ["^Gmail$"], launch: "" }];
  assert.deepStrictEqual(panel.awaitingTitleIndex(
    [makeClient({ class: "chromium", initialTitle: "News" })], gmail, resolver(gmail)),
    { gmail: "chromium" });
  // A class-only identity is not this problem either — it matches its terminal
  // already.
  const wide = [{ id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" }];
  assert.deepStrictEqual(panel.awaitingTitleIndex([BARE_WINDOW], wide, resolver(wide)), {});

  // A recorded placement already gives the identity a clickable "not running"
  // row; this pass must not add a second one for the same tick.
  const layout = {
    apps: [{ identityId: "herdr", monitorDescription: "Samsung Display Corp. ATNA60HR07-0",
      workspaceId: 3, occurrence: 0 }]
  };
  const recorded = panel.appRows([BARE_WINDOW], monitorsLaptop, resolver(identities),
    null, layout, identities, {}).filter((r) => r.identityId === "herdr");
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].awaitingTitle, false);
  assert.ok(recorded[0].position.indexOf("not running") !== -1, recorded[0].position);
  assert.strictEqual(recorded[0].clickable, true);
});

test("the panel knows which pids to read and which window a tick is about", () => {
  const clients = loadFixture("clients-titled-terminal.json");
  // Terminals get their cmdline read whether or not they are watched: the
  // proposal is built synchronously at the click, so the answer has to be
  // there already.
  assert.deepStrictEqual(panel.terminalPids(clients), ["268861", "8439"]);
  assert.deepStrictEqual(panel.terminalPids(clientsLaptop.filter((c) => c.class !== "foot")), []);

  // The address is the exact answer, and for two windows of one terminal class
  // it is the only thing that tells them apart.
  assert.strictEqual(panel.clientForTick(clients, "0x55c6f73e6d80", "foot").initialTitle, "herdr");
  assert.strictEqual(panel.clientForTick(clients, "0x55c6f81a2500", "foot").initialTitle, "foot");
  // A stale address falls back to the class rather than dropping the tick.
  assert.strictEqual(panel.clientForTick(clients, "0xgone", "foot").initialTitle, "foot");
  assert.strictEqual(panel.clientForTick(clients, "", "nothing-here"), null);
});

test("the awaiting-title row and hint read patterns the way the MATCHER reads them", () => {
  // Tick 7qe. Both asked `patternListHas(identity.patterns,
  // derivePattern(className))` — exact string equality against a freshly
  // regenerated pattern — while the matcher compiles the pattern
  // case-insensitively (engine.js compilePattern). A hand-edited pattern is
  // invited by the README, and every one of these keeps matching, recording and
  // restoring; only the row and the hint fell silent, which is precisely when
  // the user has no way back from a mis-tick.
  const argvByPid = { "268861": ["foot"] };
  const procTree = panel.procTreeFromDump(procDump([
    { pid: 268861, argv: ["foot"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));

  for (const pattern of ["^Foot$", "^(foot|footclient)$", "^foot$"]) {
    const identities = [{ id: "herdr", patterns: [pattern], titlePatterns: ["^herdr$"],
      launch: "foot --title=herdr herdr" }];
    // The matcher is happy with all three — that is the whole point.
    assert.strictEqual(engine.clientMatchesIdentity(TITLED_WINDOW, identities[0]), true, pattern);

    assert.deepStrictEqual(panel.awaitingTitleIndex([BARE_WINDOW], identities, resolver(identities)),
      { herdr: "foot" }, pattern);
    assert.ok(panel.awaitingTitleHint([BARE_WINDOW], identities,
      resolver(identities), argvByPid, procTree).indexOf('"herdr" is watched') === 0, pattern);
  }

  // A hand-edited TITLE pattern is read the same way, by the half of the hint
  // that asks whether the identity claims the title the child process names.
  const cased = [{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^HERDR$"],
    launch: "foot --title=herdr herdr" }];
  assert.ok(panel.awaitingTitleHint([BARE_WINDOW], cased,
    resolver(cased), argvByPid, procTree).indexOf('"herdr" is watched') === 0);

  // And the two must AGREE. They had drifted ~20 lines apart: the hint took any
  // live client, the row took only an isMappable one, so a terminal on a
  // special workspace — a scratchpad, the shape the README's --title advice is
  // most often used for — got the sentence and no row to undo the tick with.
  const scratch = Object.assign({}, BARE_WINDOW, { workspace: { id: -99, name: "special:scratch" } });
  const identities = [{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr" }];
  const hinted = panel.awaitingTitleHint([scratch], identities,
    resolver(identities), argvByPid, procTree) !== "";
  const rowed = Object.keys(panel.awaitingTitleIndex([scratch], identities, resolver(identities))).length > 0;
  assert.strictEqual(hinted, true, "a scratchpad terminal is evidence");
  assert.strictEqual(rowed, hinted, "and the row says what the hint says");
});

test("an unwatched row carries the address of the window it was built from", () => {
  // A row is one line per class but a tick is about one window: two foot
  // windows can host two different apps, so a row click and a chip click have
  // to agree about which window is being ticked.
  const rows = panel.appRows(loadFixture("clients-titled-terminal.json"),
    monitorsLaptop, resolver([]), null, null, []);
  const foot = rows.filter((r) => r.className === "foot");
  assert.strictEqual(foot.length, 1, "one unwatched class row for foot");
  assert.strictEqual(foot[0].identityId, "");
  assert.ok(/^0x/.test(foot[0].address), "the row names a live window");
});

test("every terminal spells the title the same way, and only the exec word differs", () => {
  // The flag column that used to live in TERMINAL_FAMILY is gone: it existed
  // only because terminals disagree about `--app-id` vs `--class`, and they all
  // agree about `--title`. What still differs is who needs `-e` before the
  // hosted command.
  assert.strictEqual(panel.terminalExecFlag("foot"), "");
  assert.strictEqual(panel.terminalExecFlag("footclient"), "");
  assert.strictEqual(panel.terminalExecFlag("kitty"), "");
  assert.strictEqual(panel.terminalExecFlag("Alacritty"), "-e");
  assert.strictEqual(panel.terminalExecFlag("com.mitchellh.ghostty"), "-e");

  assert.ok(panel.isTerminalClass("foot"));
  assert.ok(panel.isTerminalClass("Alacritty"));
  assert.ok(panel.isTerminalClass("kitty"));
  assert.ok(panel.isTerminalClass("ghostty"));
  assert.ok(!panel.isTerminalClass("chromium"));
  assert.ok(!panel.isTerminalClass("herdr"));
  assert.ok(!panel.isTerminalClass(""));

  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["kitty"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  assert.deepStrictEqual(
    panel.launchDerivation([{
      identityId: "terminal", patterns: ["^kitty$"], className: "kitty", pid: "900", argv: ["kitty"]
    }], DESKTOP_FILES, { "900": 1 }, tree).commands,
    { terminal: "kitty --title=herdr herdr" });
});

test("every terminal derives a command shaped the way that terminal can run", () => {
  // The blocker this test exists for: the derived command is written into
  // state and re-run, unread, at the next restore. `alacritty --app-id=top top`
  // was not merely the wrong flag — Alacritty has no such flag AND rejects a
  // bare trailing command, so the line could never have started anything.
  //
  // One exact string per terminal, with a sample child argv that carries an
  // argument of its own so the tail placement is visible.
  const shapes = [
    ["foot", "foot", "foot --title=top top -d 2"],
    ["footclient", "footclient", "footclient --title=top top -d 2"],
    ["kitty", "kitty", "kitty --title=top top -d 2"],
    // Verified locally against Alacritty 0.17.0.
    ["Alacritty", "alacritty", "alacritty --title=top -e top -d 2"],
    // Per upstream docs; unverified locally.
    ["com.mitchellh.ghostty", "ghostty", "ghostty --title=top -e top -d 2"]
  ];

  for (const [className, binary, expected] of shapes) {
    const tree = panel.procTreeFromDump(procDump([
      { pid: 900, argv: [binary], children: [{ pid: 901, argv: ["top", "-d", "2"] }] }
    ]));
    const derived = panel.launchDerivation([{
      identityId: "terminal", patterns: ["^" + className + "$"], className: className,
      pid: "900", argv: [binary]
    }], DESKTOP_FILES, { "900": 1 }, tree);
    assert.deepStrictEqual(derived.commands, { terminal: expected }, className);
    assert.deepStrictEqual(derived.refusals, {}, className);
  }
});

test("a child whose cmdline lost its separators is refused, not quoted into nonsense", () => {
  // The argvLooksNulLess trust question, one level down: an Electron-style
  // child that rewrote its own cmdline into one spaced string.
  const derived = footDerivation([{ pid: 901, argv: ["/opt/thing/thing --flag x"] }]);
  assert.deepStrictEqual(derived.commands, {});
  assert.deepStrictEqual(derived.refusals, { terminal: "unreadable-child" });
});

// ------------------------------------------- chip tags: drift and refusal (rjq)
//
// The map had ONE inline signal — an amber edge and an arrow glued to the name —
// and it said the same wordless thing about two different situations: a window a
// restore is about to move, and a workspace a restore has DECLINED to reshape.
// Two tags now, two tones, and a full sentence behind each in the tooltip.

test("the drift tag says WHERE, in the shortest form that still points", () => {
  assert.strictEqual(panel.driftTagFor("DP-2 · ws 10"), "→ DP-2 ws 10");
  // The case the tag is longest: a recording that points at a monitor which is
  // not in this topology keeps its full EDID description, because placementLabel
  // could not resolve it to a live name. shortMonitorLabel is what makes that
  // fit — vendor noise out, two words kept.
  assert.strictEqual(panel.driftTagFor("Samsung Display Corp. ATNA60HR07-0 · ws 3"),
    "→ Samsung ATNA60HR07-0 ws 3");
  // A recording with no monitor at all still points at a workspace.
  assert.strictEqual(panel.driftTagFor("ws 4"), "→ ws 4");
  assert.strictEqual(panel.driftTagFor(""), "");
  assert.strictEqual(panel.driftTagFor(null), "");
});

test("every refusal code the engine can produce has a tag AND a sentence", () => {
  // The agreement between the two files is over the CODES, not the words: the
  // engine writes for a terminal table and a service log, the panel writes for a
  // tooltip beside a picture. A code added to one side and not the other is
  // exactly what this catches.
  const codes = [
    engine.TILING_REFUSAL_NOT_A_TREE,
    engine.TILING_REFUSAL_AMBIGUOUS,
    engine.TILING_REFUSAL_DIFFERENT_SHAPE
  ];
  for (const code of codes) {
    const tag = panel.refusalTagFor(code);
    assert.ok(tag && tag !== code, code + " has no short tag of its own: " + tag);
    assert.ok(tag.length <= 16, code + "'s tag is too long for a chip: " + tag);
    const sentence = panel.refusalSentenceFor(code);
    assert.ok(sentence.length > tag.length, code + " has no sentence behind its tag");
    assert.ok(sentence.indexOf(code) === -1,
      code + "'s sentence leaks the code word at the user: " + sentence);
  }
  assert.strictEqual(panel.refusalTagFor("different-shape"), "shape differs");
  assert.ok(panel.refusalSentenceFor("different-shape")
    .indexOf("live split shape differs from the recording") === 0,
    panel.refusalSentenceFor("different-shape"));
  assert.ok(panel.refusalSentenceFor("different-shape").indexOf("single flip") !== -1,
    "the sentence has to say what the auto-fix can and cannot reach");

  // Nothing is nothing.
  assert.strictEqual(panel.refusalTagFor(""), "");
  assert.strictEqual(panel.refusalTagFor(null), "");
  assert.strictEqual(panel.refusalSentenceFor(""), "");

  // A code from a NEWER engine is shown rather than swallowed: an unreadable
  // word beats a silent chip.
  assert.strictEqual(panel.refusalTagFor("brand-new-reason"), "brand-new-reason");
  assert.ok(panel.refusalSentenceFor("brand-new-reason").indexOf("brand-new-reason") !== -1);
});

test("refusalOfVerdict survives every layer a verdict can arrive missing", () => {
  assert.strictEqual(panel.refusalOfVerdict(null), "");
  assert.strictEqual(panel.refusalOfVerdict({}), "");
  assert.strictEqual(panel.refusalOfVerdict({ geometryDetail: null }), "");
  assert.strictEqual(panel.refusalOfVerdict({ geometryDetail: {} }), "");
  assert.strictEqual(panel.refusalOfVerdict({ geometryDetail: { refinement: null } }), "");
  assert.strictEqual(
    panel.refusalOfVerdict({ geometryDetail: { refinement: "ambiguous-tree" } }), "ambiguous-tree");
});

// A workspace whose live split tree is TWO flips from the recording — the shape
// that is still refused now that one flip is repaired (tick uk5).
function refusedShapeScene() {
  const monitors = [LEFT];
  const recorded = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] }),
    makeClient({ address: "0xbbb", class: "chromium", workspace: 1, at: [960, 0], size: [960, 540] }),
    makeClient({ address: "0xccc", class: "code", workspace: 1, at: [960, 540], size: [960, 540] })
  ];
  const layout = engine.buildLayout(recorded, monitors, IDENTITIES, AT);
  const live = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [1920, 540] }),
    makeClient({ address: "0xbbb", class: "chromium", workspace: 1, at: [0, 540], size: [960, 540] }),
    makeClient({ address: "0xccc", class: "code", workspace: 1, at: [960, 540], size: [960, 540] })
  ];
  const report = engine.driftOf(live, monitors, layout, IDENTITIES);
  const verdicts = engine.verdictsFor(report, []);
  return {
    monitors, layout, live, report, verdicts,
    map: panel.liveMapModel(live, monitors, resolver(IDENTITIES), report, 400, 200, verdicts)
  };
}

test("a chip on a refused workspace carries the refusal, tag and sentence", () => {
  const scene = refusedShapeScene();
  assert.deepStrictEqual(scene.report.tilingRefusals.map((r) => r.reason), ["different-shape"],
    "the scene is the one it claims to be");

  const chips = panel.flattenChips(scene.map);
  assert.strictEqual(chips.length, 3);
  for (const chip of chips) {
    assert.strictEqual(chip.refusal, "different-shape", chip.name);
    assert.strictEqual(chip.refusalTag, "shape differs", chip.name);
    const text = panel.chipTooltipText(chip);
    assert.ok(text.indexOf("live split shape differs from the recording") !== -1, text);
    assert.ok(text.indexOf("single flip") !== -1, text);
    // A refusal is a fact about the workspace, not a complaint about this
    // window: it is the LAST line, never where the diagnosis goes.
    const lines = text.split("\n");
    assert.strictEqual(lines[lines.length - 1], panel.refusalSentenceFor("different-shape"));
  }

  // NOT DRIFT. The badge is unmoved and so is every verdict: a refusal explains
  // a number, it does not grade a desktop down.
  for (const chip of chips) {
    assert.strictEqual(chip.drifted, false, chip.name);
    assert.strictEqual(chip.driftTag, "");
  }
  assert.strictEqual(scene.report.summary.drifted, 0, "a refusal is not drift");
  for (const verdict of scene.verdicts) assert.strictEqual(verdict.ok, true);
});

test("a drifted chip carries the tag the amber edge is short for", () => {
  const monitors = [LEFT, RIGHT];
  const layout = engine.buildLayout(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 1, at: [1920, 0], size: [960, 1080] })],
    monitors, IDENTITIES, AT);
  const live = [makeClient({
    address: "0xaaa", class: "foot", workspace: 1, monitor: 0, at: [0, 0], size: [960, 1080]
  })];
  const report = engine.driftOf(live, monitors, layout, IDENTITIES);
  const map = panel.liveMapModel(live, monitors, resolver(IDENTITIES), report, 400, 200,
    engine.verdictsFor(report, []));
  const chip = panel.flattenChips(map)[0];

  assert.strictEqual(chip.drifted, true);
  assert.strictEqual(chip.driftTo, "DP-2 · ws 2");
  assert.strictEqual(chip.driftTag, "→ DP-2 ws 2");
  // …and no refusal: the tool is going to MOVE this window, which is the
  // opposite of the sentence a refusal makes.
  assert.strictEqual(chip.refusalTag, "");
});

test("a clean chip and a recorded ghost carry neither tag", () => {
  const clients = [makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0], size: [960, 1080] })];
  const layout = engine.buildLayout(clients, [LEFT], IDENTITIES, AT);
  const report = engine.driftOf(clients, [LEFT], layout, IDENTITIES);
  const live = panel.flattenChips(
    panel.liveMapModel(clients, [LEFT], resolver(IDENTITIES), report, 400, 200,
      engine.verdictsFor(report, [])))[0];
  assert.strictEqual(live.driftTag, "");
  assert.strictEqual(live.refusalTag, "");
  assert.strictEqual(panel.chipTooltipText(live).indexOf("left as it is"), -1);

  // The recorded map is a picture of the RECORDING, and a recording's own shape
  // is not something the refinement can refuse.
  const ghost = panel.flattenChips(panel.recordedMapModel(layout, [LEFT], ["terminal"], 400, 200))[0];
  assert.strictEqual(ghost.driftTag, "");
  assert.strictEqual(ghost.refusalTag, "");
  assert.strictEqual(ghost.refusal, "");
});

test("an UNWATCHED window never carries a refusal, whatever its workspace is doing", () => {
  const scene = refusedShapeScene();
  const stranger = scene.live.concat([
    makeClient({ address: "0xddd", class: "nobody-watches-this", workspace: 1, floating: true })
  ]);
  const report = engine.driftOf(stranger, scene.monitors, scene.layout, IDENTITIES);
  const chips = panel.flattenChips(panel.liveMapModel(
    stranger, scene.monitors, resolver(IDENTITIES), report, 400, 200,
    engine.verdictsFor(report, [])));
  const unwatched = chips.find((c) => c.className === "nobody-watches-this");
  assert.strictEqual(unwatched.watched, false);
  assert.strictEqual(unwatched.refusal, "", "a refusal is a fact about a RECORDED workspace");
  assert.strictEqual(unwatched.refusalTag, "");
});

// ------------------------------------------ the failed-restore list (tick jzx)
//
// The sketch: "failures: red dot on the glyph; the panel lists which apps
// failed, each with a retry". The badge and the per-app rows existed; the LIST
// did not, so a user whose toast said "restore failed" had to read nine rows to
// find the two that were red.

// The identity ids the PANEL actually creates: deriveIdentityId's answer for the
// class, which is why "chromium" survives the trip to a ghost row that has no
// class of its own. (tests/helpers.js calls that identity "browser", which is a
// fixture name and not a name this panel would ever mint.)
const FAILED_IDS = [
  { id: "chromium", patterns: ["^chromium$"] },
  { id: "terminal", patterns: ["^foot$"] }
];

function failedScene() {
  const monitors = [LEFT];
  const recorded = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1 }),
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2 })
  ];
  const layout = engine.buildLayout(recorded, monitors, FAILED_IDS, AT);
  // The browser has been closed since — which is what makes its failure a
  // LAUNCH failure and its row a ghost with no class at all.
  const live = [makeClient({ address: "0xaaa", class: "foot", workspace: 3 })];
  const report = engine.driftOf(live, monitors, layout, FAILED_IDS);
  const outcomes = [
    { kind: "move", subject: "0xaaa", identityIds: ["terminal"], ok: false,
      reason: "compositor refused move: window not found" },
    { kind: "launch", subject: "chromium", identityIds: ["chromium"], ok: false,
      reason: "no window of \"chromium\" appeared within 10s" }
  ];
  const verdicts = engine.verdictsFor(report, outcomes);
  const rows = panel.appRows(live, monitors, resolver(FAILED_IDS), report, layout, FAILED_IDS);
  return { monitors, layout, live, report, verdicts, rows };
}

test("the failed list is exactly the apps the last cycle could not finish", () => {
  const scene = failedScene();
  const failed = panel.failedRestoreRows(scene.verdicts, scene.rows);

  assert.deepStrictEqual(failed.map((f) => f.identityId).sort(), ["chromium", "terminal"]);
  // Every word comes from blockedBy, so the section and the app's own row can
  // never say different things about one failure.
  const terminal = failed.find((f) => f.identityId === "terminal");
  assert.strictEqual(terminal.reason, "compositor refused move: window not found");
  assert.strictEqual(terminal.name, scene.rows.find((r) => r.identityId === "terminal").name);
  assert.strictEqual(terminal.kind, "move");
  assert.strictEqual(terminal.caveat, "", "a move has nothing to warn about");

  // A verdict that is fine contributes nothing, and neither does an empty table.
  assert.deepStrictEqual(panel.failedRestoreRows([], scene.rows), []);
  assert.deepStrictEqual(panel.failedRestoreRows(null, null), []);
  assert.deepStrictEqual(
    panel.failedRestoreRows(engine.verdictsFor(scene.report, []), scene.rows), [],
    "no ledger, no blockedBy, no section — a drifted desk is not a failed one");
});

test("a blocked LAUNCH of a browser carries the caveat retrying cannot fix", () => {
  const scene = failedScene();
  const browser = panel.failedRestoreRows(scene.verdicts, scene.rows)
    .find((f) => f.identityId === "chromium");

  assert.strictEqual(browser.kind, "launch");
  assert.strictEqual(browser.caveat, panel.BROWSER_LAUNCH_CAVEAT);
  assert.ok(browser.caveat.indexOf("open a tab instead of a new window") !== -1, browser.caveat);
  assert.ok(browser.caveat.indexOf("open one manually and Restore") !== -1, browser.caveat);
  // The class is the honest input and a not-running app has none — its row is a
  // ghost. The identity id is the fallback, and it works because it is DERIVED
  // from the class.
  assert.strictEqual(browser.className, "", "the failing app is not running, so it has no class");
  assert.strictEqual(panel.deriveIdentityId("chromium"), "chromium");
  assert.strictEqual(
    panel.failedRestoreRows([{
      identityId: "chromium", occurrence: 0, ok: false, text: "not running",
      blockedBy: { kind: "launch", reason: "no window appeared" }
    }], [])[0].caveat, panel.BROWSER_LAUNCH_CAVEAT);
});

test("the caveat is about LAUNCHING a browser, not about browsers in general", () => {
  const base = { identityId: "chromium", occurrence: 0, ok: false, text: "on the wrong workspace" };
  const moved = panel.failedRestoreRows(
    [Object.assign({}, base, { blockedBy: { kind: "move", reason: "refused" } })], [])[0];
  assert.strictEqual(moved.caveat, "", "a browser window that would not MOVE opens no tabs");

  const editor = panel.failedRestoreRows([{
    identityId: "editor", occurrence: 0, ok: false, text: "not running",
    blockedBy: { kind: "launch", reason: "no window appeared" }
  }], [])[0];
  assert.strictEqual(editor.caveat, "", "an editor opens the window it is asked for");
});

test("a failed row loses its instance marker when the row counts disagree", () => {
  // The same rule verdictLine follows: the verdict counts RECORDED windows and
  // the row counts the recorded-or-running union, so "window 2 of 2" under a row
  // titled "Terminal (2)" of three is worse than no marker at all.
  const verdict = {
    identityId: "terminal", occurrence: 1, instance: 2, instances: 2, ok: false,
    text: "on the wrong workspace", blockedBy: { kind: "move", reason: "refused" }
  };
  assert.strictEqual(
    panel.failedRestoreRows([verdict], [])[0].instanceLabel, "window 2 of 2");
  assert.strictEqual(
    panel.failedRestoreRows([verdict], [
      { identityId: "terminal", occurrence: 1, instances: 3, name: "Terminal (2)", className: "foot" }
    ])[0].instanceLabel, "");
});

test("a blocked verdict with no reason still produces a line, never a blank one", () => {
  const rows = panel.failedRestoreRows([{
    identityId: "terminal", occurrence: 0, ok: false, text: "on the wrong workspace",
    blockedBy: { kind: "move", reason: "" }
  }], []);
  assert.strictEqual(rows[0].reason, "on the wrong workspace");
  const bare = panel.failedRestoreRows([{
    identityId: "terminal", occurrence: 0, ok: false, text: "", blockedBy: { kind: "", reason: "" }
  }], []);
  assert.ok(bare[0].reason.length > 0, "a blank line under a red header reads as a broken panel");
});

test("the section is headed by lastResult, and CLEARS when lastResult does", () => {
  assert.strictEqual(panel.failedRestoreTitle(null), "");
  assert.strictEqual(panel.failedRestoreTitle({ ok: true, summary: "9/9 arranged" }), "");
  assert.strictEqual(
    panel.failedRestoreTitle({ ok: false, summary: "7/9 arranged — 2 blocked" }),
    "Restore failed — 7/9 arranged — 2 blocked");
  // A failure the service could not summarise still gets a header, because the
  // section under it is the summary.
  assert.strictEqual(panel.failedRestoreTitle({ ok: false, summary: "" }), "Restore failed");

  // The clearing rule, end to end through the state file: the moment a cycle
  // succeeds the header is empty, and the panel drops the whole section.
  const status = state.normalizeStatus({
    topologyKey: "k", recorded: true,
    lastResult: { ok: false, summary: "7/9 arranged", at: AT }
  });
  assert.notStrictEqual(panel.failedRestoreTitle(status.lastResult), "");
  const cleared = state.normalizeStatus({
    topologyKey: "k", recorded: true,
    lastResult: { ok: true, summary: "9/9 arranged", at: AT }
  });
  assert.strictEqual(panel.failedRestoreTitle(cleared.lastResult), "");
});

test("Retry says out loud that it runs the whole restore", () => {
  const scene = failedScene();
  const browser = panel.failedRestoreRows(scene.verdicts, scene.rows)
    .find((f) => f.identityId === "chromium");

  const tip = panel.retryTooltip(browser, false);
  assert.ok(tip.indexOf(browser.name) !== -1, tip);
  assert.ok(tip.indexOf("everything else it covers") !== -1,
    "a button that quietly does more than its label says is how trust goes: " + tip);
  assert.ok(tip.indexOf("Restoring twice is safe") !== -1, tip);
  assert.ok(tip.indexOf(panel.BROWSER_LAUNCH_CAVEAT) !== -1,
    "the caveat travels with the button too: " + tip);

  // While a restore is running the button is not an offer, it is a status.
  assert.ok(panel.retryTooltip(browser, true).indexOf("A restore is running") === 0);
  assert.ok(panel.retryTooltip(null, false).length > 0);
});

// ------------------------------------- may the manual restore fire at all (66x)
//
// The blocker: an INERT state file (a schema from the future — StateModel.
// restoreRefusal) left Restore now and Retry LIT. Pressing either wrote the
// trigger and dismissed the panel; the service then refused the cycle into its
// log, where a user never looks. A refusal is a feature only if it is visible,
// so the refusal has to reach the affordance itself — and the condition all
// three entry points (both buttons and the keyboard's Enter) share is here,
// once, rather than copied into three QML bindings.
test("an inert state file refuses the manual restore, and every button says so", () => {
  const future = state.parseState(JSON.stringify({
    version: state.STATE_VERSION + 1, identities: [], layouts: {}
  })).state;
  const inert = state.restoreRefusal(future);
  assert.ok(inert, "the fixture is only a fixture if a future version really refuses");

  // The two ways to answer no are different in kind, and both answer no.
  assert.strictEqual(panel.mayManualRestore(true, ""), true, "the ordinary desk");
  assert.strictEqual(panel.mayManualRestore(false, ""), false, "nothing recorded: nothing to put back");
  assert.strictEqual(panel.mayManualRestore(true, inert), false,
    "a layout the build may not act on is not a layout the button may offer");
  assert.strictEqual(panel.mayManualRestore(false, inert), false);
  // Whitespace is not a reason; a missing argument is not a refusal.
  assert.strictEqual(panel.mayManualRestore(true, "   "), true);
  assert.strictEqual(panel.mayManualRestore(true, undefined), true);
  assert.strictEqual(panel.mayManualRestore(true, null), true);

  // ...and the dim buttons carry the reason, so a pointer user gets it on
  // demand and not only from the panel's persistent Inert line.
  const restore = panel.restoreTooltip(true, "Laptop", inert);
  assert.ok(restore.indexOf("Nothing will be restored") === 0, restore);
  assert.ok(restore.indexOf(inert) !== -1, "the tooltip quotes the refusal itself");
  assert.strictEqual(restore.indexOf("Safe to press twice"), -1,
    "an inert file must not be offered as something safe to press twice");

  // The inert reason outranks the empty-layout sentence: saying "nothing
  // recorded yet" about a file full of recordings would be wrong twice over.
  assert.strictEqual(panel.restoreTooltip(false, "Laptop", inert).indexOf("no layout to put back"), -1);

  const scene = failedScene();
  const browser = panel.failedRestoreRows(scene.verdicts, scene.rows)
    .find((f) => f.identityId === "chromium");
  const retry = panel.retryTooltip(browser, false, inert);
  assert.ok(retry.indexOf("Nothing will be restored") === 0, retry);
  assert.ok(retry.indexOf(inert) !== -1);
  // Retry IS the whole restore, so it cannot claim to be running one either.
  assert.strictEqual(panel.retryTooltip(browser, true, inert).indexOf("A restore is running"), -1);

  // And the ordinary desk is untouched by the new argument.
  assert.strictEqual(panel.restoreTooltip(true, "Laptop", ""), panel.restoreTooltip(true, "Laptop"));
  assert.strictEqual(panel.retryTooltip(browser, false, ""), panel.retryTooltip(browser, false));
});

// ------------------------------------------------ one undo after Record (7ow)
//
// The sketch, twice: "Recording OVERWRITES this topology's layout — the previous
// one is gone (single undo kept in memory until next record)", and "the panel
// never blocks: no modals, no confirmation dialogs… undo instead of 'are you
// sure'". Record stays one click that does the thing; the net goes behind it.

function stashFor(previous) {
  return { topologyKey: LAPTOP_KEY, previousLayout: previous || null };
}

test("an undo is only offered for the topology it was armed on", () => {
  const stash = stashFor({ topologyKey: LAPTOP_KEY, recordedAt: AT, apps: [] });
  assert.strictEqual(panel.recordUndoValid(stash, LAPTOP_KEY), true);
  // A dock or an undock retires it: the layout it holds belongs to a monitor
  // arrangement that is no longer on the desk.
  assert.strictEqual(panel.recordUndoValid(stash, "Some Other Screen"), false);
  assert.strictEqual(panel.recordUndoValid(stash, ""), false);
  // Nothing recorded this session, or the last undo used the stash up.
  assert.strictEqual(panel.recordUndoValid(null, LAPTOP_KEY), false);
  assert.strictEqual(panel.recordUndoValid({}, LAPTOP_KEY), false);
  assert.strictEqual(panel.recordUndoValid({ topologyKey: "" }, LAPTOP_KEY), false);

  // A FIRST recording arms an undo too — it just undoes to nothing.
  assert.strictEqual(panel.recordUndoValid(stashFor(null), LAPTOP_KEY), true);
});

test("undoing a first recording FORGETS, and says so before it is pressed", () => {
  const first = stashFor(null);
  assert.strictEqual(panel.recordUndoRestores(first), false);
  assert.strictEqual(panel.undoRecordLabel(first), "Undo — forget this recording");
  const tip = panel.undoRecordTooltip(first, "Laptop");
  assert.ok(tip.indexOf("Forget the recording just made for Laptop") === 0, tip);
  assert.ok(tip.indexOf("no layout for this setup before it") !== -1, tip);
  assert.ok(tip.indexOf("Put back") === -1, "the two acts must not share a sentence: " + tip);
});

test("undoing an overwrite names the recording it puts back", () => {
  const previous = {
    topologyKey: LAPTOP_KEY, recordedAt: "2026-08-14T09:00:00Z",
    apps: [{ identityId: "terminal" }, { identityId: "editor" }]
  };
  const stash = stashFor(previous);
  assert.strictEqual(panel.recordUndoRestores(stash), true);
  assert.strictEqual(panel.undoRecordLabel(stash), "Undo record");
  const tip = panel.undoRecordTooltip(stash, "Laptop");
  assert.ok(tip.indexOf("Put back the layout recorded for Laptop") === 0, tip);
  assert.ok(tip.indexOf("2026-08-14T09:00:00Z") !== -1, "it names WHICH recording: " + tip);
  assert.ok(tip.indexOf("(2 apps)") !== -1, tip);
  assert.ok(tip.indexOf("discarded") !== -1, "and what it costs: " + tip);

  // Singular is singular.
  assert.ok(panel.undoRecordTooltip(
    stashFor({ topologyKey: LAPTOP_KEY, recordedAt: AT, apps: [{ identityId: "terminal" }] }), "Laptop")
    .indexOf("(1 app)") !== -1);
  // A topology with no human name still gets a sentence.
  assert.ok(panel.undoRecordTooltip(stash, "").indexOf("this setup") !== -1);
  assert.strictEqual(panel.undoRecordTooltip(null, "Laptop"), "");
});

test("the undo round trip is the state model's own, both ways", () => {
  // What Panel.undoRecord does, in the two branches, against the real writer —
  // so the button cannot be wired to a pair of calls that do not compose.
  const previous = engine.buildLayout(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 1 })],
    monitorsLaptop, IDENTITIES, "2026-08-14T09:00:00Z");
  const overwritten = engine.buildLayout(
    [makeClient({ address: "0xbbb", class: "code", workspace: 4 })],
    monitorsLaptop, IDENTITIES, AT);
  assert.strictEqual(previous.topologyKey, overwritten.topologyKey);

  const before = state.upsertLayout(state.defaultState(), previous);
  const recorded = state.upsertLayout(before, overwritten);
  assert.deepStrictEqual(
    state.layoutFor(recorded, previous.topologyKey).apps.map((a) => a.identityId), ["editor"]);

  // Undo of an overwrite: the previous layout, byte for byte through the file.
  const undone = state.parseState(state.serializeState(
    state.upsertLayout(recorded, previous))).state;
  assert.deepStrictEqual(
    state.layoutFor(undone, previous.topologyKey).apps.map((a) => a.identityId), ["terminal"]);
  assert.strictEqual(state.layoutFor(undone, previous.topologyKey).recordedAt, "2026-08-14T09:00:00Z");

  // Undo of a FIRST record: the topology has no layout again, and nothing else
  // in the file moved.
  const onlyOne = state.upsertLayout(state.defaultState(), overwritten);
  const forgotten = state.removeLayout(onlyOne, overwritten.topologyKey);
  assert.strictEqual(state.layoutFor(forgotten, overwritten.topologyKey), null);
  assert.strictEqual(state.hasLayoutFor(forgotten, overwritten.topologyKey), false);
});

// ------------------------------------------- the header overflow menu (gwa)
//
// UX sketch, panel anatomy: "Overflow menu: list of recorded topologies (with
// mini monitor glyphs), forget this layout, re-record." The list is a memory;
// the two actions are about the desk in front of you, and neither asks twice.

const DOCKED_KEY = "AOC Inc. U34G2G 0x00001234 | Samsung Display Corp. ATNA60HR07-0";
const TRIPLE_KEY = "AOC Inc. U34G2G | Dell U2412M | Samsung Display Corp. ATNA60HR07-0";

function layoutRow(key, appCount, recordedAt) {
  const apps = [];
  for (let i = 0; i < appCount; i++) apps.push({ identityId: "app-" + i });
  return { topologyKey: key, recordedAt: recordedAt || AT, apps: apps };
}

test("a topology key counts its monitors, because an absent desk has none to ask", () => {
  assert.strictEqual(panel.topologyMonitorCount(LAPTOP_KEY), 1);
  assert.strictEqual(panel.topologyMonitorCount(DOCKED_KEY), 2);
  assert.strictEqual(panel.topologyMonitorCount(TRIPLE_KEY), 3);
  assert.strictEqual(panel.topologyMonitorCount(""), 0);
  assert.strictEqual(panel.topologyMonitorCount(null), 0);
});

test("the menu lists every recorded layout, current one first and marked", () => {
  const rows = panel.overflowMenuRows(
    [layoutRow(DOCKED_KEY, 6), layoutRow(LAPTOP_KEY, 2)], LAPTOP_KEY, monitorsLaptop);

  assert.strictEqual(rows.length, 2);
  // Hoisted: the actions below the list act on this one, and a mark three rows
  // down leaves "Forget this layout" pointing at a line the eye never reached.
  assert.strictEqual(rows[0].topologyKey, LAPTOP_KEY);
  assert.strictEqual(rows[0].current, true);
  assert.strictEqual(rows[0].note, "this setup");
  assert.strictEqual(rows[0].name, "Laptop");
  assert.strictEqual(rows[0].appLabel, "2 apps");

  assert.strictEqual(rows[1].current, false);
  assert.strictEqual(rows[1].note, "");
  // A desk that is not plugged in is still named. The laptop panel INSIDE it is
  // recognised because that monitor is here; the screen that is not on the desk
  // keeps the part number from the key, which is correct, just less friendly.
  assert.strictEqual(rows[1].name, "AOC U34G2G + Laptop");
  assert.strictEqual(panel.overflowMenuRows(
    [layoutRow(DOCKED_KEY, 6)], LAPTOP_KEY, [])[0].name, "AOC U34G2G + Samsung ATNA60HR07-0");
  assert.strictEqual(rows[1].appLabel, "6 apps");
});

test("two desks can share a menu row's NAME, so the row carries a key that is its own", () => {
  // The hazard behind keying the overflow render registry on topologyKey rather
  // than on the name Panel.qml draws. humanizeTopology keeps a make and a model
  // and drops the rest, so two desks whose EDID serials differ — genuinely two
  // recordings, two rows, one of them possibly `current` — arrive at one string.
  const twinA = "AOC Inc. U34G2G 0x00001234 | Samsung Display Corp. ATNA60HR07-0";
  const twinB = "AOC Inc. U34G2G 0x0000ABCD | Samsung Display Corp. ATNA60HR07-0";
  const rows = panel.overflowMenuRows(
    [layoutRow(twinA, 3), layoutRow(twinB, 5)], twinB, monitorsLaptop);

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, rows[1].name, "the display name really does collide");
  // And exactly one of them is the desk you are sitting at, which is the field
  // a shared registry slot would have handed to both.
  assert.deepStrictEqual(rows.map((r) => r.current), [true, false]);
  // The key does not collide, is on the row, and is what the delegate reports
  // under.
  assert.notStrictEqual(rows[0].topologyKey, rows[1].topologyKey);
  assert.strictEqual(new Set(rows.map((r) => r.topologyKey)).size, 2);
});

test("the mini glyph draws one box per monitor, and stops at three", () => {
  const rows = panel.overflowMenuRows(
    [layoutRow(LAPTOP_KEY, 1), layoutRow(DOCKED_KEY, 0), layoutRow(TRIPLE_KEY, 4),
     layoutRow(TRIPLE_KEY + " | HDMI-A-1", 4)], "", []);

  assert.deepStrictEqual(rows.map((r) => r.glyphs), [1, 2, 3, 3]);
  assert.deepStrictEqual(rows.map((r) => r.moreMonitors), [false, false, false, true]);
  assert.deepStrictEqual(rows.map((r) => r.monitors), [1, 2, 3, 4]);
  // Singular is singular, and a recorded-but-empty layout still says a number.
  assert.strictEqual(rows[0].appLabel, "1 app");
  assert.strictEqual(rows[1].appLabel, "0 apps");
});

test("nothing recorded, or nothing recorded HERE, is said rather than left blank", () => {
  const empty = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, true, "Laptop");
  assert.deepStrictEqual(empty.rows, []);
  assert.strictEqual(empty.currentRecorded, false);
  assert.ok(empty.hint.indexOf("No layouts recorded yet") === 0, empty.hint);

  const elsewhere = panel.overflowMenuModel(
    [layoutRow(DOCKED_KEY, 3)], LAPTOP_KEY, monitorsLaptop, true, "Laptop");
  assert.strictEqual(elsewhere.rows.length, 1);
  assert.strictEqual(elsewhere.currentRecorded, false);
  assert.strictEqual(elsewhere.hint, "This setup is not recorded yet.");

  const here = panel.overflowMenuModel(
    [layoutRow(LAPTOP_KEY, 3)], LAPTOP_KEY, monitorsLaptop, true, "Laptop");
  assert.strictEqual(here.currentRecorded, true);
  assert.strictEqual(here.hint, "");
});

test("two acts about THIS desk plus the pictures switch, each saying why", () => {
  const model = panel.overflowMenuModel(
    [layoutRow(LAPTOP_KEY, 3)], LAPTOP_KEY, monitorsLaptop, true, "Laptop", true);
  assert.deepStrictEqual(panel.menuActionIds(model.actions),
    ["forget", "rerecord", "pictures"]);

  const forget = panel.menuAction(model.actions, "forget");
  assert.strictEqual(forget.label, "Forget this layout");
  assert.strictEqual(forget.enabled, true);
  assert.ok(forget.tooltip.indexOf("Laptop") !== -1, forget.tooltip);
  // No "are you sure": the panel never blocks, so the tooltip promises the undo.
  assert.ok(forget.tooltip.indexOf("undo") !== -1, forget.tooltip);
  assert.ok(panel.menuAction(model.actions, "rerecord").enabled);

  // Nothing recorded here: Forget stays visible and explains itself.
  const cold = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, false, "Laptop", true);
  assert.strictEqual(panel.menuAction(cold.actions, "forget").enabled, false);
  assert.ok(panel.menuAction(cold.actions, "forget").tooltip.indexOf("nothing to forget") !== -1);
  assert.strictEqual(panel.menuAction(cold.actions, "rerecord").enabled, false);

  // A topology with no name at all still gets sentences about "this setup".
  const nameless = panel.overflowMenuModel([], "", [], false, "", true);
  assert.ok(panel.menuAction(nameless.actions, "forget").tooltip.indexOf("this setup") !== -1);
  assert.strictEqual(panel.menuAction(nameless.actions, "nope"), null);
});

test("THE PICTURES ENTRY: the label flips, the tooltip says the cost, never disabled", () => {
  // The whole affordance for schema v7's one switch, and the reason it is here
  // rather than on eleven rows: it has to be FINDABLE. The label names the act
  // the press performs, like the other two entries, so the menu is its own
  // receipt — press it and the words say the other thing.
  const on = panel.menuAction(panel.overflowMenuModel(
    [], LAPTOP_KEY, monitorsLaptop, true, "Laptop", true).actions, "pictures");
  const off = panel.menuAction(panel.overflowMenuModel(
    [], LAPTOP_KEY, monitorsLaptop, true, "Laptop", false).actions, "pictures");

  assert.strictEqual(on.label, "Turn pictures off");
  assert.strictEqual(off.label, "Turn pictures on");

  // NEVER DISABLED, in either position. A dimmed privacy control is worse than
  // none: both directions always mean something.
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(off.enabled, true);

  // The tooltip is where the cost is said, BEFORE the press — this panel never
  // blocks, so there is no confirmation dialog to say it in afterwards.
  assert.ok(on.tooltip.indexOf("Delete every stored picture") !== -1, on.tooltip);
  assert.ok(on.tooltip.indexOf("every desk") !== -1, on.tooltip);
  assert.ok(on.tooltip.indexOf("stop photographing") !== -1, on.tooltip);
  // And the other direction says what comes back, and when.
  assert.ok(off.tooltip.indexOf("Photograph every watched window") !== -1, off.tooltip);
  assert.ok(off.tooltip.indexOf("Record") !== -1, off.tooltip);

  // `!== false`, StateModel.picturesOn's rule: only the literal false is off.
  for (const junk of [undefined, "false", 0, null, {}]) {
    assert.strictEqual(panel.menuAction(panel.overflowMenuModel(
      [], LAPTOP_KEY, monitorsLaptop, true, "Laptop", junk).actions, "pictures").label,
      "Turn pictures off", JSON.stringify(junk) + " read as off");
  }
});

test("the keyboard cursor lands on something pressable, and walks the actions", () => {
  const warm = panel.overflowMenuModel(
    [layoutRow(LAPTOP_KEY, 3)], LAPTOP_KEY, monitorsLaptop, true, "Laptop", true);
  assert.strictEqual(panel.firstEnabledActionId(warm.actions), "forget");

  // Nothing to forget: the cursor skips to the action that can be pressed.
  const noLayout = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, true, "Laptop", true);
  assert.strictEqual(panel.firstEnabledActionId(noLayout.actions), "rerecord");

  // Nothing recorded and nothing to record: the pictures switch is always
  // pressable, so the cursor lands on it rather than on a dimmed row.
  const frozen = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, false, "Laptop", true);
  assert.strictEqual(panel.firstEnabledActionId(frozen.actions), "pictures");
  assert.strictEqual(panel.firstEnabledActionId([]), "");

  // Arrows walk the same wrap-around walker the panel sections use.
  const ids = panel.menuActionIds(warm.actions);
  assert.strictEqual(panel.nextSection(ids, "forget", 1), "rerecord");
  assert.strictEqual(panel.nextSection(ids, "rerecord", 1), "pictures");
  assert.strictEqual(panel.nextSection(ids, "pictures", 1), "forget");
  assert.strictEqual(panel.nextSection(ids, "forget", -1), "pictures");
});

test("forgetting arms the SAME one-shot undo a record arms", () => {
  const layout = layoutRow(LAPTOP_KEY, 2, "2026-08-14T09:00:00Z");
  const stash = panel.forgetUndoStash(LAPTOP_KEY, layout);

  assert.strictEqual(stash.topologyKey, LAPTOP_KEY);
  assert.strictEqual(stash.previousLayout, layout);
  assert.strictEqual(panel.undoStashAction(stash), "forget");
  // It is the same slot, so the same validity rule applies: a dock retires it.
  assert.strictEqual(panel.recordUndoValid(stash, LAPTOP_KEY), true);
  assert.strictEqual(panel.recordUndoValid(stash, DOCKED_KEY), false);
  assert.strictEqual(panel.recordUndoRestores(stash), true);

  // Nothing recorded here — Forget writes nothing and arms nothing.
  assert.strictEqual(panel.forgetUndoStash(LAPTOP_KEY, null), null);
  assert.strictEqual(panel.forgetUndoStash("", layout), null);
  assert.strictEqual(panel.forgetUndoStash(LAPTOP_KEY, { apps: [] }), null);
});

test("the undo button names the act it is undoing, forget or record", () => {
  const forgotten = panel.forgetUndoStash(LAPTOP_KEY, layoutRow(LAPTOP_KEY, 2, "2026-08-14T09:00:00Z"));
  assert.strictEqual(panel.undoRecordLabel(forgotten), "Undo — put the layout back");
  const tip = panel.undoRecordTooltip(forgotten, "Laptop");
  assert.ok(tip.indexOf("Put back the layout you just forgot for Laptop") === 0, tip);
  assert.ok(tip.indexOf("2026-08-14T09:00:00Z") !== -1, tip);
  assert.ok(tip.indexOf("(2 apps)") !== -1, tip);
  // The record wording is untouched, and a stash with no action is a record.
  const recorded = { topologyKey: LAPTOP_KEY, previousLayout: layoutRow(LAPTOP_KEY, 1) };
  assert.strictEqual(panel.undoStashAction(recorded), "record");
  assert.strictEqual(panel.undoRecordLabel(recorded), "Undo record");
  assert.strictEqual(panel.undoRecordLabel(null), "Undo — forget this recording");
});

test("forget and its undo compose against the real state writer", () => {
  const laptop = engine.buildLayout(
    [makeClient({ address: "0xaaa", class: "foot", workspace: 1 })],
    monitorsLaptop, IDENTITIES, AT);
  const other = layoutRow(DOCKED_KEY, 3);

  const before = state.upsertLayout(state.upsertLayout(state.defaultState(), other), laptop);
  const stash = panel.forgetUndoStash(laptop.topologyKey, state.layoutFor(before, laptop.topologyKey));

  const forgotten = state.parseState(state.serializeState(
    state.removeLayout(before, laptop.topologyKey))).state;
  assert.strictEqual(state.hasLayoutFor(forgotten, laptop.topologyKey), false);
  // The OTHER desk's recording is untouched — forget is one topology's act.
  assert.strictEqual(state.hasLayoutFor(forgotten, DOCKED_KEY), true);

  const back = state.upsertLayout(forgotten, stash.previousLayout);
  assert.deepStrictEqual(
    state.layoutFor(back, laptop.topologyKey).apps.map((a) => a.identityId), ["terminal"]);
  assert.strictEqual(state.hasLayoutFor(back, DOCKED_KEY), true);
});

test("the overflow tooltip stops claiming it does nothing", () => {
  assert.ok(panel.overflowTooltip().indexOf("Not wired up") === -1);
  assert.ok(panel.overflowTooltip().indexOf("recorded layout") !== -1);
});

// ------------------------------------- launch fixes: fill it, don't lose it (i07)
//
// The bug, in one sentence: ticking an app writes `launch: ""` INSTANTLY — and
// "" means never start this one — while the scan that could have filled it
// finishes a moment later, with nothing bringing the two together. Two halves
// close it: a scan may fill an EMPTY launch on its own, and a toggle that can
// already answer writes the launch in the same write.

const AUTOFILL_IDENTITIES = [
  { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], launch: "" },
  { id: "editor", patterns: ["^code$"], launch: "code --new-window" },
  { id: "browser", patterns: ["^chromium$"], launch: BROKEN_OBSIDIAN_LAUNCH }
];

test("a scan may fill an EMPTY launch, and nothing else", () => {
  const map = {
    obsidian: "/usr/bin/obsidian",
    editor: "code",              // a perfectly good stored command, differing
    browser: "/usr/bin/chromium" // a stored command that cannot RUN
  };

  assert.deepStrictEqual(panel.launchAutofillIndex(AUTOFILL_IDENTITIES, map),
    { obsidian: "/usr/bin/obsidian" });

  // The BROKEN one is deliberately left out: launchRepairIndex would replace it,
  // and that repair stays user-pressed because the value may have been typed by
  // hand and rewriting it unasked is a silent edit of the user's file.
  assert.strictEqual(panel.launchRepairIndex(AUTOFILL_IDENTITIES, map).browser, "/usr/bin/chromium");
  assert.strictEqual(panel.learnableCount(AUTOFILL_IDENTITIES, map), 2);

  const filled = panel.autofillLaunchCommands(AUTOFILL_IDENTITIES, map);
  assert.deepStrictEqual(filled.map((i) => i.launch),
    ["/usr/bin/obsidian", "code --new-window", BROKEN_OBSIDIAN_LAUNCH]);
  // No identity is ever invented on this path.
  assert.deepStrictEqual(filled.map((i) => i.id), ["obsidian", "editor", "browser"]);
});

test("an unchanged map writes nothing — the guard against a scan-driven write loop", () => {
  const done = panel.autofillLaunchCommands(AUTOFILL_IDENTITIES, {});
  // The SAME list back, which is the caller's no-op test.
  assert.strictEqual(done, AUTOFILL_IDENTITIES);
  assert.deepStrictEqual(panel.launchAutofillIndex(AUTOFILL_IDENTITIES, {}), {});
  assert.strictEqual(panel.autofillLaunchLog({}, "desktop-file scan"), "");

  // And once filled, a second scan with the same answer has nothing left to do.
  const filled = panel.autofillLaunchCommands(AUTOFILL_IDENTITIES, { obsidian: "/usr/bin/obsidian" });
  assert.notStrictEqual(filled, AUTOFILL_IDENTITIES);
  assert.strictEqual(
    panel.autofillLaunchCommands(filled, { obsidian: "/usr/bin/obsidian" }), filled);
});

test("the auto-fill logs one line, with the count and what it wrote", () => {
  const line = panel.autofillLaunchLog(
    { obsidian: "/usr/bin/obsidian", slack: "slack" }, "desktop-file scan");
  assert.strictEqual(line,
    "auto-filled 2 launch commands after the desktop-file scan: obsidian -> /usr/bin/obsidian; slack -> slack");
  assert.strictEqual(line.indexOf("\n"), -1, "one line: " + line);
  assert.strictEqual(panel.autofillLaunchLog({ obsidian: "/usr/bin/obsidian" }, "cmdline read"),
    "auto-filled 1 launch command after the cmdline read: obsidian -> /usr/bin/obsidian");
  assert.strictEqual(panel.autofillLaunchLog(null, "cmdline read"), "");
});

test("a toggle knows which identity it just created, and only then", () => {
  const before = [];
  const ticked = panel.toggleWatchedIdentities(before, OBSIDIAN_CLASS, "");
  const added = panel.addedIdentity(before, ticked);
  assert.strictEqual(added.id, "obsidian");
  assert.strictEqual(added.launch, "", "suggestIdentity still writes the empty launch");

  // Unticking removes one; there is nothing to derive for.
  assert.strictEqual(panel.addedIdentity(ticked, panel.toggleWatchedIdentities(ticked, "", "obsidian")), null);
  assert.strictEqual(panel.addedIdentity(ticked, ticked), null);
  assert.strictEqual(panel.addedIdentity(null, null), null);
});

test("a WARM derivation lands in the same write as the tick", () => {
  const client = makeClient({ address: "0xddd", class: OBSIDIAN_CLASS, pid: 4242 });
  const before = [];
  const ticked = panel.toggleWatchedIdentities(before, OBSIDIAN_CLASS, "");
  const added = panel.addedIdentity(before, ticked);

  // The request the panel builds for the identity it has just created — the same
  // shape its standing binding builds for the identities that already exist.
  const request = panel.launchRequestFor(added, client, {});
  assert.deepStrictEqual(request, {
    identityId: "obsidian",
    patterns: ["^md\\.obsidian\\.Obsidian$"],
    className: OBSIDIAN_CLASS,
    pid: "4242",
    argv: null
  });

  // The desktop-file scan is already in memory (the panel scans once per
  // opening), so the answer exists at the instant of the click.
  const derived = panel.launchDerivation([request], REAL_DESKTOP_FILES,
    panel.windowCountByPid([client]), {}).commands;
  const fills = panel.launchAutofillIndex(ticked, derived);
  assert.strictEqual(fills.obsidian, "/usr/bin/obsidian");

  const written = panel.autofillLaunchCommands(ticked, fills);
  assert.strictEqual(written[0].launch, "/usr/bin/obsidian",
    "the identity is persisted WITH its launch, not with an empty one");
  // Through the file, because that is where the bug lived.
  const persisted = state.parseState(state.serializeState(
    state.setIdentities(state.defaultState(), written))).state;
  assert.strictEqual(state.launchCommandFor(persisted, "obsidian"), "/usr/bin/obsidian");
});

test("a COLD map still ticks instantly, and the scan fills it in afterwards", () => {
  const client = makeClient({ address: "0xddd", class: OBSIDIAN_CLASS, pid: 4242 });
  const before = [];
  const ticked = panel.toggleWatchedIdentities(before, OBSIDIAN_CLASS, "");
  const added = panel.addedIdentity(before, ticked);
  const request = panel.launchRequestFor(added, client, {});

  // Nothing scanned yet: no desktop files, no argv for the pid.
  const cold = panel.launchDerivation([request], [], panel.windowCountByPid([client]), {}).commands;
  assert.deepStrictEqual(cold, {});
  const instant = panel.autofillLaunchCommands(ticked, panel.launchAutofillIndex(ticked, cold));
  assert.strictEqual(instant, ticked, "the tick is not delayed by a derivation that has no answer");
  assert.strictEqual(instant[0].launch, "");

  // The scan finishes. THIS is the write the bug was missing.
  const warm = panel.launchDerivation([request], REAL_DESKTOP_FILES,
    panel.windowCountByPid([client]), {}).commands;
  const fills = panel.launchAutofillIndex(instant, warm);
  assert.deepStrictEqual(fills, { obsidian: "/usr/bin/obsidian" });
  assert.strictEqual(
    panel.autofillLaunchCommands(instant, fills)[0].launch, "/usr/bin/obsidian");
  assert.ok(panel.autofillLaunchLog(fills, "desktop-file scan").indexOf("auto-filled 1") === 0);
});

test("a request with no window at all is still a request the derivation can read", () => {
  // The case the desktop-file half exists for: the app is watched and closed.
  const identity = { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], launch: "" };
  assert.deepStrictEqual(panel.launchRequestFor(identity, null, null), {
    identityId: "obsidian",
    patterns: ["^md\\.obsidian\\.Obsidian$"],
    className: "",
    pid: "",
    argv: null
  });
  // The argv travels with the pid, from the map the cmdline read fills.
  assert.deepStrictEqual(
    panel.launchRequestFor(identity, makeClient({ class: "x", pid: 7 }), { 7: ["obsidian"] }).argv,
    ["obsidian"]);
  assert.strictEqual(panel.launchRequestFor(null, null, null), null);
});

// ------------------------------------------- an identity that can never win
//
// engine.shadowedIdentities finds them (tests/identity.test.js pins the
// detection itself); this is the sentence the panel puts on screen. It has to
// NAME the identity that is losing and the one taking its windows, because the
// only fix is to reorder or untick one of them and the user cannot do either
// without both names.

test("the shadow notice names the losing identity, its shadower and the fix", () => {
  // `strict` is the engine's answer to "is the claimant wider BY CONSTRUCTION"
  // — a class-only rule in front of a class+title one is. Only then is the
  // instruction provably safe advice (tick ytt).
  const line = panel.shadowNoticeFor({ id: "herdr", windows: 1, claimed: 1, claimedBy: ["terminal"], strict: true });

  assert.ok(line.indexOf('"herdr"') >= 0, line);
  assert.ok(line.indexOf('"terminal"') >= 0, line);
  assert.ok(line.indexOf("earlier in the list") >= 0, line);
  assert.ok(line.indexOf("untick") >= 0, line);
  assert.strictEqual(line.indexOf("undefined"), -1, line);
});

test("without a strict-subset relation the notice observes rather than instructs", () => {
  // Two class-only identities: the one in front is not a wider RULE, it is
  // simply first, and "put it above or untick it" is advice about what happens
  // to be open. The observation is the whole of what the evidence supports.
  const soft = panel.shadowNoticeFor({ id: "allfoot", windows: 2, claimed: 1,
    claimedBy: ["term2"], strict: false });
  assert.ok(soft.indexOf('No open window currently reaches "allfoot"') === 0, soft);
  assert.strictEqual(soft.indexOf("untick"), -1, soft);
  assert.strictEqual(soft.indexOf("above"), -1, soft);

  // THE MISCOUNT (tick ytt): term2 claims ONE of the two windows allfoot
  // matches — the other was taken by an identity that is not a claimant — and
  // the sentence used to say it claimed all of them.
  assert.ok(soft.indexOf("claims 1 of the 2 windows it matches") >= 0, soft);

  // An entry that does not say the relation is strict has not earned an
  // instruction, so a missing field reads as the weak case.
  assert.ok(panel.shadowNoticeFor({ id: "herdr", windows: 1, claimed: 1, claimedBy: ["terminal"] })
    .indexOf("No open window currently reaches") === 0);
});

test("the shadow notice counts the windows, and says two shadowers as two", () => {
  const one = panel.shadowNoticeFor({ id: "herdr", windows: 1, claimed: 1, claimedBy: ["terminal"], strict: true });
  assert.ok(one.indexOf("the only window it matches") >= 0, one);
  assert.ok(one.indexOf(" is earlier") >= 0, one);

  const many = panel.shadowNoticeFor({ id: "workbench", windows: 3, claimed: 3,
    claimedBy: ["editor", "terminal"], strict: true });
  assert.ok(many.indexOf("all 3 windows it matches") >= 0, many);
  assert.ok(many.indexOf('"editor" and "terminal"') >= 0, many);
  assert.ok(many.indexOf(" are earlier") >= 0, many);
});

test("a junk shadow entry produces no sentence at all", () => {
  assert.strictEqual(panel.shadowNoticeFor(null), "");
  assert.strictEqual(panel.shadowNoticeFor({}), "");
  assert.strictEqual(panel.shadowNoticeFor({ id: "herdr", windows: 1, claimedBy: [] }), "");
});

test("the panel hint is empty on a healthy list and one line per shadowed identity", () => {
  assert.strictEqual(panel.shadowedIdentityHint([]), "");
  assert.strictEqual(panel.shadowedIdentityHint(null), "");

  const hint = panel.shadowedIdentityHint([
    { id: "herdr", windows: 1, claimedBy: ["terminal"] },
    { id: "gmail", windows: 2, claimedBy: ["browser"] }
  ]);
  assert.strictEqual(hint.split("\n").length, 2);
  assert.ok(hint.indexOf('"herdr"') >= 0, hint);
  assert.ok(hint.indexOf('"gmail"') >= 0, hint);
});

test("the whole path: a catch-all in front is detected and explained", () => {
  // This USED to be the reachable sequence from the tick: a working herdr title
  // identity, then the user ticks a plain foot terminal, `^foot$` is prepended
  // in front of it, and every herdr window silently becomes "terminal". Tick
  // gpq closed both doors — the tick refuses to write a class-only terminal
  // identity at all, and an addition is inserted behind whatever it would
  // shadow — so the list below can now only be reached by hand. The detector
  // still has to catch it, which is what this pins.
  const herdrWindow = makeClient({ class: "foot", initialClass: "foot", initialTitle: "herdr", title: "herdr" });
  const plainTerminal = makeClient({ class: "foot", initialClass: "foot", initialTitle: "foot", title: "foot" });
  const clients = [herdrWindow, plainTerminal];

  const before = [{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }];
  assert.strictEqual(engine.matchClient(herdrWindow, before), "herdr");
  assert.strictEqual(panel.shadowedIdentityHint(engine.shadowedIdentities(clients, before)), "");

  // The tick no longer produces it: hand-edited, the catch-all goes in front.
  const byHand = [{ id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" }].concat(before);
  assert.strictEqual(engine.matchClient(herdrWindow, byHand), "terminal");

  const hint = panel.shadowedIdentityHint(engine.shadowedIdentities(clients, byHand));
  assert.ok(hint.indexOf('"herdr"') >= 0, hint);
  assert.ok(hint.indexOf('"terminal"') >= 0, hint);

  // And the same identity ticked through the panel lands BEHIND herdr, where
  // it shadows nothing.
  const ticked = panel.toggleWatchedIdentities(before, "foot", "",
    { command: "foot", title: "", reason: "no-child" }, engine.couldShadow);
  assert.deepStrictEqual(ticked, before, "refused: a class-only terminal identity is not written");
});

// ------------------------------------------ what a row's Learn button may write
//
// Tick tnm / finding A9. `learnLaunchFor(identityId)` read
// `root.derivedLaunch[identityId]` with a bare bracket lookup on a bare object,
// and the derivation map is keyed by identity id. For the id `constructor` on a
// KEY MISS — an app with no derivable launch, which is precisely when the row's
// repair offer is on screen — that lookup does not answer undefined. It answers
// `Object`, the constructor function, which is truthy; the guard fell through,
// and `String(Object)` went into the state file as the app's launch command:
//
//     "launch": "function Object() { [native code] }"
//
// The row is reachable in that state because `launchRepairable` is a paint-time
// snapshot: the row can be stale by the time it is clicked.
//
// Two rules, and both belong here rather than in the QML that fires them: the
// lookup is own-guarded, and the VALUE is checked before it is written. The
// second is what makes the first a rule rather than a patch — a launch command
// is a string that survives the dispatch, and anything else is the shape of a
// bug, whatever produced it.

test("learnableLaunch refuses everything that is not a runnable command string", () => {
  // The value the bug actually produced, and its whole family.
  assert.strictEqual(panel.learnableLaunch(Object), "");
  assert.strictEqual(panel.learnableLaunch(Object.prototype.toString), "");
  assert.strictEqual(panel.learnableLaunch(Object.prototype.hasOwnProperty), "");
  assert.strictEqual(panel.learnableLaunch(String(Object)), "",
    "the same value as a string is still not a command");
  assert.strictEqual(panel.learnableLaunch("function Object() { [native code] }"), "");

  // Nothing, and things that are not strings.
  for (const value of [undefined, null, "", "   ", 0, 7, true, {}, [], Object.prototype]) {
    assert.strictEqual(panel.learnableLaunch(value), "", JSON.stringify(value) + " was accepted");
  }

  // The Lua-dispatch rule still applies, unchanged: this is the same gate every
  // other producer of a launch command returns through.
  assert.strictEqual(panel.learnableLaunch("foot --title=x]]"), "");
  assert.strictEqual(panel.learnableLaunch("foot\nbtop"), "");

  // And a real command comes back trimmed and intact.
  assert.strictEqual(panel.learnableLaunch("  foot --app-id=herdr herdr  "), "foot --app-id=herdr herdr");
  assert.strictEqual(panel.learnableLaunch("omarchy-launch-browser"), "omarchy-launch-browser");
});

test("singleLaunchRepair answers nothing for a reserved id the derivation never mentioned", () => {
  // THE BUG, at its own altitude: the map is empty, so there is nothing to
  // learn — and the answer must say so rather than hand back Object.
  assert.strictEqual(panel.singleLaunchRepair({}, "constructor"), null);
  assert.strictEqual(panel.singleLaunchRepair({}, "toString"), null);
  assert.strictEqual(panel.singleLaunchRepair({}, "hasOwnProperty"), null);
  assert.strictEqual(panel.singleLaunchRepair({}, "valueOf"), null);
  assert.strictEqual(panel.singleLaunchRepair({}, "__proto__"), null);

  // A map that DOES mention it answers with a one-entry map, ready for the
  // backfill — the reserved id is not the problem, the missing key was.
  assert.deepStrictEqual(panel.singleLaunchRepair({ constructor: "foot --app-id=Constructor" }, "constructor"),
    { constructor: "foot --app-id=Constructor" });

  // Ordinary ids, ordinary answers.
  assert.deepStrictEqual(panel.singleLaunchRepair({ herdr: "foot herdr", other: "x" }, "herdr"),
    { herdr: "foot herdr" });
  assert.strictEqual(panel.singleLaunchRepair({ herdr: "foot herdr" }, "other"), null);
  assert.strictEqual(panel.singleLaunchRepair(null, "herdr"), null);
  assert.strictEqual(panel.singleLaunchRepair({ herdr: "foot herdr" }, ""), null);
  assert.strictEqual(panel.singleLaunchRepair({ herdr: "foot herdr" }, null), null);

  // A stored value that is junk is refused at the write, not merely at the
  // lookup: the map is user-adjacent (it is built from /proc and .desktop
  // files), so "the key existed" is not the same as "the value may be written".
  assert.strictEqual(panel.singleLaunchRepair({ herdr: "foot ]] herdr" }, "herdr"), null);
  assert.strictEqual(panel.singleLaunchRepair({ herdr: "   " }, "herdr"), null);
});

test("the one-entry repair is exactly what the backfill accepts", () => {
  const identities = [
    { id: "constructor", patterns: ["^Constructor$"], titlePatterns: [], launch: "" },
    { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }
  ];
  const one = panel.singleLaunchRepair({ constructor: "foot --app-id=Constructor" }, "constructor");
  assert.strictEqual(panel.learnableCount(identities, one), 1);

  const after = panel.backfillLaunchCommands(identities, one);
  assert.strictEqual(after[0].launch, "foot --app-id=Constructor");
  assert.strictEqual(after[1].launch, "", "the other identity is untouched by a one-row repair");
});

test("Panel.qml reads the derivation through the guarded lookup and nowhere else", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // The shape the bug had. Any bare bracket lookup on the derivation map is a
  // reopening of it, whatever the key expression. Comment lines are skipped —
  // the fix's own comment quotes the line it removed, and it should.
  for (const line of source.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    assert.ok(!/root\.derivedLaunch\s*\[/.test(line),
      "Panel.qml still reads root.derivedLaunch with a bare bracket lookup: " + line.trim());
  }
  assert.ok(/PanelModel\.singleLaunchRepair\(/.test(source),
    "Panel.qml no longer routes a row's Learn through the guarded repair");
});

// ------------------------------------------- a duplicate tick is a VISIBLE no-op
//
// Tick v5c / finding A7. Click a chip whose window matches nothing, on an app an
// identity on the list ALREADY claims — the ordinary way to get there is a
// terminal running `herdr` that was started without `--title`, while
// `{^foot$ + ^herdr$}` is watched — and every gate said yes to a click that
// changed nothing:
//
//   suggestIdentity      returned null (the duplicate guard, before the
//                        terminal refusal, deliberately)
//   tickRefusalReason    therefore returned "" — no refusal to report
//   toggleWatchedIdentities returned the unchanged list
//   writeState           returned TRUE, because the bytes were identical and a
//                        byte-identical write is a successful write
//   the log              said: watching "foot" — 3 identities
//
// with `createdId` falling back to the CLASS because nothing had been added.
// The user is told they are now watching foot; they are not, the window still
// matches nothing, and the one thing that would have helped — relaunch it under
// the title the identity looks for — was never said.
//
// null was the wrong answer. "Nothing to add" and "nothing to say" are not the
// same fact, and the panel had no way to tell them apart.

const WATCHED_HERDR = [
  { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "foot --title=herdr herdr" }
];

test("suggestIdentity says already-watched instead of answering null", () => {
  const herdr = { command: "foot --title=herdr herdr", title: "herdr", reason: "" };

  const answer = panel.suggestIdentity("foot", WATCHED_HERDR, herdr);
  assert.deepStrictEqual(answer, { refusal: "already-watched" },
    "a duplicate proposal must be a refusal with a reason, not a silent null");

  // The class-only duplicate answers the same way — the fact is the same one.
  assert.deepStrictEqual(
    panel.suggestIdentity("chromium", [{ id: "browser", patterns: ["^chromium$"], launch: "" }]),
    { refusal: "already-watched" });

  // And it is the DUPLICATE that wins over the terminal refusal, as it always
  // did: the more specific truth about the click is that it changes nothing.
  assert.deepStrictEqual(panel.suggestIdentity("foot", WATCHED_HERDR, herdr).refusal, "already-watched");
});

test("the list is still left exactly as it was", () => {
  const herdr = { command: "foot --title=herdr herdr", title: "herdr", reason: "" };
  const after = panel.toggleWatchedIdentities(WATCHED_HERDR, "foot", "", herdr, engine.couldShadow);
  assert.deepStrictEqual(after, WATCHED_HERDR, "a refusal must never change the list");
  assert.notStrictEqual(after, WATCHED_HERDR, "and must still hand back a copy");
  assert.strictEqual(panel.addedIdentity(WATCHED_HERDR, after), null);
});

test("tickRefusalReason and its hint carry already-watched to the panel", () => {
  const herdr = { command: "foot --title=herdr herdr", title: "herdr", reason: "" };
  assert.strictEqual(panel.tickRefusalReason("foot", WATCHED_HERDR, herdr), "already-watched");

  const hint = panel.tickRefusalHint("foot", "already-watched");
  assert.ok(hint, "already-watched has no sentence, so the panel would say nothing");
  assert.ok(/already/i.test(hint), hint);
  // The one thing it must NOT say is the thing every other terminal refusal
  // says — that nothing names the app inside it. Something did: it is on the
  // list already.
  assert.strictEqual(hint.indexOf("nothing about it names the app"), -1, hint);
  // A terminal still gets the relaunch advice, because that IS the fix here.
  assert.ok(hint.indexOf("--title=") !== -1, hint);

  // A non-terminal class gets the same fact without the terminal-only advice.
  const browserHint = panel.tickRefusalHint("chromium", "already-watched");
  assert.ok(browserHint, browserHint);
  assert.strictEqual(browserHint.indexOf("--title="), -1,
    "a chromium window has no --title convention to relaunch under");
});

test("Panel.qml reserves the success line for a list that actually changed", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // The fallback that produced the lie: `added ? added.id : chip.className`.
  assert.strictEqual(source.indexOf("added ? added.id : chip.className"), -1,
    "Panel.qml still names the clicked CLASS when nothing was added");
  // And there is a branch that says so out loud instead.
  assert.ok(/no change/.test(source),
    "Panel.qml has no honest no-op line for a click that changed nothing");
});

// ------------------------------------------- a refusal dies with its window
//
// Tick 8rw / finding A10. `refusedTick` is `{ className, address }` — the
// QUESTION a refused tick asked, kept so the hint can re-ask it against the live
// desktop every frame and clear itself the moment the answer changes. That
// self-clearing is the design, and it had one hole: nothing ever asked whether
// the WINDOW was still there.
//
// The re-ask goes through clientForTick, which falls back to the first window of
// the same CLASS when the address is gone. That fallback is right for a tick —
// a list row can predate a refresh and the class is all that is left. It is
// wrong for a refusal, and wrong in two different ways:
//
//   - the refused terminal closes and another foot window is open: the hint
//     re-derives against a DIFFERENT window and tells the user about a terminal
//     they never clicked;
//   - the refused terminal closes and no foot window is left: clientForTick
//     answers null, the derivation is null, the reason stays "not-read", and the
//     panel says "still reading… press it again in a moment" forever, about a
//     window that is gone.
//
// So the question is asked separately, and it is a question about identity, not
// about derivation: is this refusal still about a window that exists?

const REFUSED_FOOT = { className: "foot", address: "0xf1" };

test("refusalStillLive is false the moment the refused window closes", () => {
  const refused = makeClient({ address: "0xf1", class: "foot" });
  const other = makeClient({ address: "0xf2", class: "foot" });
  const unrelated = makeClient({ address: "0xc1", class: "chromium" });

  assert.strictEqual(panel.refusalStillLive([refused, unrelated], REFUSED_FOOT), true);

  // THE CLASS-FALLBACK CASE. Another window of the same class is on screen and
  // is emphatically not the one that was refused.
  assert.strictEqual(panel.refusalStillLive([other, unrelated], REFUSED_FOOT), false,
    "a sibling window of the same class kept the refusal alive");

  // THE ADDRESS-GONE CASE. Nothing of that class is left at all.
  assert.strictEqual(panel.refusalStillLive([unrelated], REFUSED_FOOT), false);
  assert.strictEqual(panel.refusalStillLive([], REFUSED_FOOT), false);

  // An address that came back with a different class is a reused address, not
  // the window that was clicked.
  const reused = makeClient({ address: "0xf1", class: "chromium" });
  assert.strictEqual(panel.refusalStillLive([reused], REFUSED_FOOT), false);

  // initialClass counts, the way it does everywhere a class is compared.
  const byInitial = makeClient({ address: "0xf1", class: "", initialClass: "foot" });
  assert.strictEqual(panel.refusalStillLive([byInitial], REFUSED_FOOT), true);
});

test("a refusal with no address is about the class, and lives while the class does", () => {
  // A chip can carry no address (chip.address || ""). Then the class IS the
  // whole question, and there is no sibling to confuse it with.
  const classOnly = { className: "foot", address: "" };
  assert.strictEqual(panel.refusalStillLive([makeClient({ address: "0xf9", class: "foot" })], classOnly), true);
  assert.strictEqual(panel.refusalStillLive([makeClient({ address: "0xc1", class: "chromium" })], classOnly), false);
});

test("nothing at all is not a live refusal", () => {
  const clients = [makeClient({ address: "0xf1", class: "foot" })];
  for (const value of [null, undefined, {}, { className: "" }, { className: "   " }, "foot", 7]) {
    assert.strictEqual(panel.refusalStillLive(clients, value), false, JSON.stringify(value));
  }
  assert.strictEqual(panel.refusalStillLive(null, REFUSED_FOOT), false);
});

test("Panel.qml clears refusedTick when the clients list says the window is gone", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  assert.ok(/PanelModel\.refusalStillLive\(/.test(source),
    "Panel.qml never asks whether the refusal is still about a live window");
  // The natural signal: the refusal is re-checked whenever the client list is
  // reassigned, which is the one moment a window can have gone away.
  assert.ok(/onLiveClientsChanged/.test(source),
    "Panel.qml has no hook on the client list, so a dead refusal is never noticed");
});

// ------------------------ the awaiting-title surface is not terminals-only
//
// Tick s7l / finding A12. The tick-1m4 gap re-opened outside the terminal case.
//
// awaitingTitleCandidates — the one place that decides which identities are
// waiting on a title — filtered its windows through isTerminalClass. The
// comment defending that filter was about the ADVICE ("telling that user to
// relaunch with --title would be advice about the wrong thing"), and it is
// right about the advice; it was applied to the wrong thing. What the filter
// actually removed was the RECOVERY ROW.
//
// So a hand-authored `^chromium$` + `^Gmail$` — the README invites the hand
// edit — matched no window while an ordinary chromium window sat on screen, and
// had no chip, no row, and no way back except editing the state file. Exactly
// the state 1m4 exists to make recoverable, one class of app further out.
//
// The filter moves rather than disappears: every candidate says whether its
// window is a terminal, and the two places that give ADVICE branch on it. A
// terminal is told how to relaunch; anything else is told the true thing —
// its title patterns match no window of its class.

const CHROMIUM_UNMATCHED = makeClient({
  address: "0xb1", class: "chromium", initialClass: "chromium",
  title: "News", initialTitle: "News", workspace: 2, pid: 4242
});
const CHROMIUM_GMAIL = makeClient({
  address: "0xb2", class: "chromium", initialClass: "chromium",
  title: "Gmail", initialTitle: "Gmail", workspace: 2, pid: 4243
});
const GMAIL_IDENTITY = [
  { id: "gmail", patterns: ["^chromium$"], titlePatterns: ["^Gmail$"], launch: "omarchy-launch-browser" }
];

test("a non-terminal title identity is an awaiting-title candidate too", () => {
  const candidates = panel.awaitingTitleCandidates([CHROMIUM_UNMATCHED],
    GMAIL_IDENTITY, resolver(GMAIL_IDENTITY));
  assert.strictEqual(candidates.length, 1, JSON.stringify(candidates));
  assert.strictEqual(candidates[0].identity.id, "gmail");
  assert.strictEqual(candidates[0].windows.length, 1);
  assert.strictEqual(candidates[0].windows[0].className, "chromium");
  assert.strictEqual(candidates[0].windows[0].isTerminal, false,
    "the terminal question is answered on the candidate, not used to drop it");

  // And it clears the instant a window matches, exactly as the terminal case does.
  assert.deepStrictEqual(panel.awaitingTitleCandidates([CHROMIUM_UNMATCHED, CHROMIUM_GMAIL],
    GMAIL_IDENTITY, resolver(GMAIL_IDENTITY)), []);
  // No window of its class on screen is an ordinary not-running app, and stays
  // one: the row is about a class that IS there and still matches nothing.
  assert.deepStrictEqual(panel.awaitingTitleCandidates([], GMAIL_IDENTITY, resolver(GMAIL_IDENTITY)), []);

  // The terminal candidate still says what it is.
  const footIdentity = [{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }];
  const footCandidates = panel.awaitingTitleCandidates([BARE_WINDOW], footIdentity, resolver(footIdentity));
  assert.strictEqual(footCandidates.length, 1);
  assert.strictEqual(footCandidates[0].windows[0].isTerminal, true);
});

test("the index and the recovery row reach a non-terminal identity", () => {
  assert.deepStrictEqual(
    panel.awaitingTitleIndex([CHROMIUM_UNMATCHED], GMAIL_IDENTITY, resolver(GMAIL_IDENTITY)),
    { gmail: "chromium" });

  const rows = panel.appRows([CHROMIUM_UNMATCHED], monitorsLaptop, resolver(GMAIL_IDENTITY),
    null, null, GMAIL_IDENTITY, {});
  const row = rows.find((r) => r.identityId === "gmail");
  assert.ok(row, "no recovery row for the hand-authored title identity: " + JSON.stringify(rows));
  assert.strictEqual(row.awaitingTitle, true);
  assert.strictEqual(row.watched, true);
  assert.strictEqual(row.clickable, true, "the row must untick, which is the whole point of it");

  // THE HONEST SENTENCE. A chromium window has no --title convention, and a row
  // that claimed one would send the user off to do something that cannot work.
  assert.strictEqual(row.position.indexOf("--title"), -1, row.position);
  assert.ok(/title pattern/i.test(row.position), row.position);

  // The terminal row keeps the advice that IS true for it.
  const footIdentity = [{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }];
  const footRows = panel.appRows([BARE_WINDOW], monitorsLaptop, resolver(footIdentity),
    null, null, footIdentity, {});
  const footRow = footRows.find((r) => r.identityId === "herdr");
  assert.ok(footRow, JSON.stringify(footRows));
  assert.ok(footRow.position.indexOf("--title") !== -1, footRow.position);
});

test("the hint tells a non-terminal the truth, without the relaunch claim", () => {
  const said = panel.awaitingTitleHint([CHROMIUM_UNMATCHED], GMAIL_IDENTITY,
    resolver(GMAIL_IDENTITY), {}, {});
  assert.ok(said, "the non-terminal candidate says nothing at all");
  assert.ok(said.indexOf('"gmail"') === 0 || said.indexOf('"gmail" is watched') !== -1, said);
  assert.strictEqual(said.indexOf("--title"), -1,
    "the --title advice is terminal-specific and cannot be given about a chromium window");
  // It names what the user can actually check: the pattern, and the class it
  // is being compared against.
  assert.ok(said.indexOf("^Gmail$") !== -1, said);
  assert.ok(said.indexOf("chromium") !== -1, said);

  // And it clears when a window matches.
  assert.strictEqual(panel.awaitingTitleHint([CHROMIUM_UNMATCHED, CHROMIUM_GMAIL],
    GMAIL_IDENTITY, resolver(GMAIL_IDENTITY), {}, {}), "");
});

test("Panel.qml supplies the same inputs to the renamed hint", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // The learnings rule: a pure fix with no QML supplier does nothing. The
  // inputs did not change here — the same client list, identity list and
  // matcher — so what has to be checked is that the panel calls the function
  // that now answers for both kinds of app.
  assert.ok(/PanelModel\.awaitingTitleHint\(/.test(source),
    "Panel.qml still calls the terminals-only hint");
  assert.strictEqual(source.indexOf("untitledTerminalHint"), -1,
    "the old name is still in Panel.qml, so one of the two is dead code");
  const binding = source.slice(source.indexOf("PanelModel.awaitingTitleHint("));
  assert.ok(binding.slice(0, 300).indexOf("root.liveClients") !== -1, binding.slice(0, 300));
  assert.ok(binding.slice(0, 300).indexOf("Engine.matchClient") !== -1, binding.slice(0, 300));
});

// ------------------------------------------- one question, asked once (zkb)
//
// Cleanup B. A single chip click asked suggestIdentity TWICE — once through
// tickRefusalReason to find out whether to refuse, and again inside
// toggleWatchedIdentities to build the list — and then diffed the two lists with
// addedIdentity to recover the identity the second call had just built and
// thrown away. Three passes over the same question, and three places for the
// answers to disagree if any of them ever grew a condition the others lacked.
//
// tickOutcome is that question asked once: what does this click DO?

test("tickOutcome answers the whole click in one pass", () => {
  const derivation = { command: "foot --title=herdr herdr", title: "herdr", reason: "" };

  // A tick that adds.
  const add = panel.tickOutcome([], "foot", "", derivation, engine.couldShadow);
  assert.strictEqual(add.refusal, "");
  assert.deepStrictEqual(add.added, {
    id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
    launch: "foot --title=herdr herdr"
  });
  assert.deepStrictEqual(add.identities, [add.added]);

  // An UNTICK names no addition and needs no proposal at all.
  const off = panel.tickOutcome(add.identities, "foot", "herdr", derivation, engine.couldShadow);
  assert.strictEqual(off.refusal, "");
  assert.strictEqual(off.added, null);
  assert.deepStrictEqual(off.identities, []);

  // A refusal: the list is untouched and the reason travels.
  const refused = panel.tickOutcome([], "foot", "", null, engine.couldShadow);
  assert.strictEqual(refused.refusal, "not-read");
  assert.strictEqual(refused.added, null);
  assert.deepStrictEqual(refused.identities, []);

  // The duplicate from tick v5c arrives the same way.
  const dup = panel.tickOutcome(add.identities, "foot", "", derivation, engine.couldShadow);
  assert.strictEqual(dup.refusal, "already-watched");
  assert.strictEqual(dup.added, null);
  assert.deepStrictEqual(dup.identities, add.identities);

  // A class that derives no pattern at all: nothing to add, nothing to say.
  const nothing = panel.tickOutcome([], "", "", null, engine.couldShadow);
  assert.strictEqual(nothing.refusal, "");
  assert.strictEqual(nothing.added, null);
  assert.deepStrictEqual(nothing.identities, []);
});

test("toggleWatchedIdentities is tickOutcome's list, so the two cannot disagree", () => {
  const derivation = { command: "foot --title=herdr herdr", title: "herdr", reason: "" };
  const cases = [
    [[], "foot", "", derivation],
    [[], "chromium", "", null],
    [[{ id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"], launch: "" }], "foot", "herdr", null],
    [[{ id: "browser", patterns: ["^chromium$"], launch: "" }], "chromium", "", null]
  ];
  for (const [identities, className, identityId, derived] of cases) {
    assert.deepStrictEqual(
      panel.toggleWatchedIdentities(identities, className, identityId, derived, engine.couldShadow),
      panel.tickOutcome(identities, className, identityId, derived, engine.couldShadow).identities,
      className + "/" + identityId);
  }
});

test("the panel asks each of these questions exactly once", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const panelSource = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const serviceSource = fs.readFileSync(path.join(__dirname, "..", "Service.qml"), "utf8");

  function bodyOf(source, header, what) {
    const start = source.indexOf(header);
    assert.ok(start !== -1, what + " has no " + header);
    let depth = 0;
    for (let i = start + header.length - 1; i < source.length; i++) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    assert.fail(what + ": unbalanced braces after " + header);
  }
  const count = (text, needle) => text.split(needle).length - 1;

  // One click, one proposal. toggleWatchedIdentities and addedIdentity were the
  // second and third passes over it.
  const toggle = bodyOf(panelSource, "function toggleChip(chip) {", "Panel.qml");
  assert.strictEqual(count(toggle, "PanelModel.tickOutcome("), 1, toggle);
  assert.strictEqual(count(toggle, "PanelModel.tickRefusalReason("), 0,
    "toggleChip still asks the refusal question separately from the toggle");
  assert.strictEqual(count(toggle, "PanelModel.toggleWatchedIdentities("), 0, toggle);
  assert.strictEqual(count(toggle, "PanelModel.addedIdentity("), 0,
    "toggleChip still recovers the added identity by diffing two lists");

  // One state read, one refusal question. loadState asked writeRefusal twice
  // about the same object.
  const load = bodyOf(serviceSource, "function loadState(raw, exists) {", "Service.qml");
  assert.strictEqual(count(load, "StateModel.writeRefusal("), 1, load);
});

test("the /proc maps are reassigned only when they changed", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // Every ~4 s the cmdline read landed and reassigned both maps whatever it
  // found, and every binding downstream of them — the whole launch derivation
  // chain, the hints, the rows — re-evaluated for nothing. The read still
  // happens; only a CHANGED answer is published.
  // The publish of each merged map has to sit inside the comparison against
  // its own serialized shadow, and there must be exactly one of each.
  const guards = [
    ["argvByPid", "if (mergedText !== root.argvByPidText) {", "root.argvByPid = merged"],
    ["procTree", "if (mergedTreeText !== root.procTreeText) {", "root.procTree = mergedTree"]
  ];
  for (const [map, guard, publish] of guards) {
    const at = source.indexOf(guard);
    assert.ok(at !== -1, map + " is published without comparing against its last published value");
    const published = source.indexOf(publish, at);
    assert.ok(published !== -1 && published - at < 120,
      map + " is published somewhere other than inside its guard");
    assert.strictEqual(source.split(publish).length - 1, 1,
      map + " is published more than once, so one of them is unguarded");
  }
  // And the shadows are dropped with the maps when the panel forgets its reads,
  // or the next read would compare against a picture the panel no longer holds.
  const forget = source.slice(source.indexOf("function forgetProcReads()"));
  assert.ok(forget.slice(0, 500).indexOf("argvByPidText") !== -1, forget.slice(0, 500));
  assert.ok(forget.slice(0, 500).indexOf("procTreeText") !== -1, forget.slice(0, 500));
});

// ---------------------------------------------------------------------------
// The capture cache (tick sz6)
// ---------------------------------------------------------------------------
//
// Pictures are keyed on (identityId, occurrence, topologyKey) and stored under
// ~/.cache/omarchy/dock-recall/ — a CACHE, deliberately, so a cleaner wiping it
// degrades the map to icons rather than breaking anything, and so the state file
// stays the one file this plugin writes.

// Two windows of one identity plus a second identity, on the laptop monitor set,
// so a plan can be asked about occurrence 0 AND occurrence 1.
function captureDesk() {
  const identities = [
    { id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" },
    { id: "browser", patterns: ["^chromium$"], titlePatterns: [], launch: "chromium" }
  ];
  const clients = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 1, at: [0, 0] }),
    makeClient({ address: "0xbbb", class: "foot", workspace: 1, at: [900, 0] }),
    makeClient({ address: "0xccc", class: "chromium", workspace: 2 })
  ];
  const layout = engine.buildLayout(clients, monitorsLaptop, identities, AT);
  return { identities, clients, layout, chosen: engine.chosenWindows(clients, identities, monitorsLaptop) };
}

test("a capture file names all three parts of its key, and changes when any of them does", () => {
  const a = panel.captureFileName("terminal", 0, "Laptop");
  const b = panel.captureFileName("terminal", 1, "Laptop");
  const c = panel.captureFileName("browser", 0, "Laptop");
  const d = panel.captureFileName("terminal", 0, "Laptop | Dell");

  assert.strictEqual(a, panel.captureFileName("terminal", 0, "Laptop"), "and it is stable");
  assert.strictEqual(new Set([a, b, c, d]).size, 4, "identity, occurrence and topology all move it");
  for (const name of [a, b, c, d]) {
    assert.match(name, /^[0-9a-f]{8}-[A-Za-z0-9._-]+-[0-9a-f]{8}-\d+\.jpg$/, name);
  }
  // Readable enough to debug from a directory listing.
  assert.ok(a.indexOf("terminal") !== -1, a);
  // An occurrence a hand-edited file put junk in still lands on a real number,
  // because occurrenceOf is the same coercion every other consumer applies.
  assert.strictEqual(panel.captureFileName("terminal", -1, "Laptop"), a);
  assert.strictEqual(panel.captureFileName("terminal", "0", "Laptop"), a);
  // And an entry with no identity names nothing at all, rather than naming the
  // bare topology prefix.
  assert.strictEqual(panel.captureFileName("", 0, "Laptop"), "");
});

test("a hostile identity id becomes a filename, never a path", () => {
  // An identity id is hand-editable in the state file, so this is user input on
  // its way into a name that is later handed to `find` and to saveToFile.
  const nasty = panel.captureFileName("../../../etc/passwd", 0, "Laptop");
  // THE INVARIANT IS "one path segment", not "no dots". A dot inside a name is
  // ordinary — `md.obsidian.Obsidian` is a real identity id — and only three
  // shapes are dangerous: a separator, a name that IS "." or "..", and a
  // leading "-" or "." (a flag, or a hidden file). The topology prefix and the
  // ".jpg" suffix mean the whole name can never be "." or ".." either.
  assert.ok(nasty.indexOf("/") === -1, nasty);
  assert.match(nasty, /^[0-9a-f]{8}-[A-Za-z0-9._-]+-[0-9a-f]{8}-\d+\.jpg$/);
  assert.ok(nasty !== "." && nasty !== "..");

  // Two ids that sanitize to the SAME characters still get different files —
  // that is what the id's own hash is for.
  assert.notStrictEqual(panel.captureFileName("a/b", 0, "L"), panel.captureFileName("a:b", 0, "L"));

  // A leading dash would read as a flag, a leading dot would hide the file and,
  // as "..", would name the parent directory.
  assert.strictEqual(panel.captureSafeSegment("-rf", 8).charAt(0), "_");
  assert.strictEqual(panel.captureSafeSegment("..", 8).charAt(0), "_");
  assert.strictEqual(panel.captureSafeSegment("", 8), "_");
  // Capped, so no id can push the name past a filesystem's limit.
  assert.strictEqual(panel.captureSafeSegment("x".repeat(500), 40).length, 40);
});

test("every picture of one recording shares the topology prefix, which is what evicts them", () => {
  const prefix = panel.captureTopologyPrefix("Laptop | Dell");
  assert.match(prefix, /^[0-9a-f]{8}-$/);
  for (const occurrence of [0, 1, 2]) {
    assert.ok(panel.captureFileName("terminal", occurrence, "Laptop | Dell").indexOf(prefix) === 0);
  }
  // A different desk is a different prefix, so forgetting one layout cannot
  // take another desk's pictures with it.
  assert.notStrictEqual(prefix, panel.captureTopologyPrefix("Laptop"));
});

test("a capture plan takes one picture per WATCHED window, and every one of them", () => {
  const desk = captureDesk();
  const plan = panel.capturePlan(desk.layout, desk.identities, desk.chosen, true);

  assert.strictEqual(plan.topologyKey, desk.layout.topologyKey);
  assert.strictEqual(plan.prefix, panel.captureTopologyPrefix(desk.layout.topologyKey));

  // Two terminals are two pictures, at two occurrences, of two DIFFERENT
  // windows — captures are the only thing that can tell duplicates apart, and a
  // plan that photographed one window twice would defeat the point.
  const terminals = plan.captures.filter((c) => c.identityId === "terminal");
  assert.deepStrictEqual(terminals.map((c) => c.occurrence), [0, 1]);
  assert.strictEqual(new Set(plan.captures.map((c) => c.address)).size, 3);
  assert.strictEqual(new Set(plan.captures.map((c) => c.file)).size, 3);

  // The window each entry names is the one buildLayout numbered that
  // occurrence, taken from the same chosenWindows index — not a second match.
  for (const capture of plan.captures) {
    assert.strictEqual(capture.address,
      desk.chosen.byId[capture.identityId][capture.occurrence].address);
    assert.strictEqual(capture.file,
      panel.captureFileName(capture.identityId, capture.occurrence, plan.topologyKey));
  }

  // THE BROWSER IS PHOTOGRAPHED TOO (schema v7). It is watched and it has a
  // window, and that is now the whole of the question — the per-app camera it
  // used to be skipped by is gone, and with pictures on nothing in a healthy
  // plan is skipped at all.
  assert.deepStrictEqual(plan.captures.map((c) => c.identityId).sort(),
    ["browser", "terminal", "terminal"]);
  assert.deepStrictEqual(plan.skipped, []);
});

test("with the pictures off the plan is empty, and every app says why", () => {
  const desk = captureDesk();
  const plan = panel.capturePlan(desk.layout, desk.identities, desk.chosen, false);
  assert.deepStrictEqual(plan.captures, []);
  assert.strictEqual(plan.skipped.length, desk.layout.apps.length,
    "every app in the layout is accounted for, not silently absent");
  assert.ok(plan.skipped.every((s) => s.reason === "pictures-off"),
    JSON.stringify(plan.skipped));
  // The prefix is still named, because the round still EVICTS: a re-record with
  // the pictures switched off has to drop the ones the last one took.
  assert.strictEqual(plan.prefix, panel.captureTopologyPrefix(desk.layout.topologyKey));

  // Only the literal false is off — StateModel.picturesOn's rule, applied at
  // the one other place the switch is read.
  for (const junk of [true, undefined, "false", 0, null, {}]) {
    assert.strictEqual(panel.capturePlan(desk.layout, desk.identities, desk.chosen, junk)
      .captures.length, 3, JSON.stringify(junk) + " read as off");
  }
});

test("a layout entry whose identity has gone is not photographed", () => {
  // A watched app IS pictured, so "watched" is the only per-app question left —
  // and a recorded ghost, whose identity the file no longer carries, is not.
  const desk = captureDesk();
  const fewer = desk.identities.filter((i) => i.id !== "browser");
  const plan = panel.capturePlan(desk.layout, fewer, desk.chosen, true);
  assert.deepStrictEqual(plan.captures.map((c) => c.identityId), ["terminal", "terminal"]);
  assert.deepStrictEqual(plan.skipped,
    [{ identityId: "browser", occurrence: 0, reason: "not-watched" }]);
});

test("a recorded app whose window has gone is skipped, not guessed at", () => {
  const desk = captureDesk();
  // The layout still names both terminals; the desk no longer has the second.
  const fewer = desk.clients.filter((c) => c.address !== "0xbbb");
  const chosen = engine.chosenWindows(fewer, desk.identities, monitorsLaptop);
  const plan = panel.capturePlan(desk.layout, desk.identities, chosen, true);

  assert.deepStrictEqual(
    plan.captures.filter((c) => c.identityId === "terminal").map((c) => c.occurrence), [0]);
  assert.ok(plan.skipped.some((s) => s.identityId === "terminal" && s.reason === "no-window"));
});

test("a layout with no topology plans nothing, because a picture with no prefix cannot be evicted", () => {
  const desk = captureDesk();
  const plan = panel.capturePlan({ topologyKey: "", apps: desk.layout.apps },
    desk.identities, desk.chosen, true);
  assert.deepStrictEqual(plan, { topologyKey: "", prefix: "", captures: [], skipped: [] });
  assert.deepStrictEqual(panel.capturePlan(null, desk.identities, desk.chosen, true).captures, []);
});

test("the capture log line reads as best-effort, and says all four numbers", () => {
  const plan = {
    skipped: [
      { identityId: "browser", occurrence: 0, reason: "pictures-off" },
      { identityId: "slack", occurrence: 0, reason: "no-window" }
    ]
  };
  const line = panel.captureLogLine(plan, [
    { ok: true }, { ok: false, reason: "no-frame" }
  ]);
  assert.strictEqual(line,
    "1 picture(s) stored, 1 could not be captured (no-frame), 1 not pictured, 1 no longer open");

  // A failure names its reason, and each distinct one once — the reasons are
  // the whole diagnostic value of the line, and "no-frame" in particular is the
  // one real failure mode this feature has (a monitor that is not rendering).
  assert.strictEqual(
    panel.captureLogLine(null, [{ ok: false, reason: "no-frame" },
                                { ok: false, reason: "no-frame" },
                                { ok: false, reason: "no-handle" },
                                { ok: false }]),
    "0 picture(s) stored, 4 could not be captured (no-frame, no-handle, unknown)");

  // A clean round says one thing and does not enumerate zeroes.
  assert.strictEqual(panel.captureLogLine({ skipped: [] }, [{ ok: true }, { ok: true }]),
    "2 picture(s) stored");
  // And a round that stored nothing still leads with the count rather than
  // reading as a failure: the recording is fine either way.
  assert.strictEqual(panel.captureLogLine(null, []), "0 picture(s) stored");
});

test("a listing of the cache is a set of basenames, and a missing directory is an empty one", () => {
  assert.deepStrictEqual(panel.captureFileIndex("a.jpg\nb.jpg\n"), { "a.jpg": true, "b.jpg": true });
  // A wiped cache is the normal, correct answer — not an error.
  assert.deepStrictEqual(panel.captureFileIndex(""), {});
  assert.deepStrictEqual(panel.captureFileIndex(null), {});
  assert.deepStrictEqual(panel.captureFileIndex("  \n\n a.jpg \n"), { "a.jpg": true });
});

test("A SCREENSHOT CANNOT FAIL A RECORD: the capture is last, gated, and off the stack", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  const record = source.slice(source.indexOf("function recordLayout()"));
  const body = record.slice(0, record.indexOf("\n  }\n"));

  // 1. THE WRITE GATES IT. The capture kickoff has to come after the guarded
  //    upsertLayout, so every refusal path returns before it.
  const write = body.indexOf("if (!root.writeState(StateModel.upsertLayout(base, recorded))) return false");
  const capture = body.indexOf("captureAfterRecord");
  assert.ok(write !== -1, "recordLayout no longer gates on writeState's boolean");
  assert.ok(capture !== -1, "recordLayout no longer starts a capture at all");
  assert.ok(capture > write, "the capture is reachable without the layout having been written");

  // 2. IT IS OFF THE RECORDING'S STACK. Qt.callLater puts it in a later
  //    event-loop turn, so recordLayout has already returned before any capture
  //    code runs and nothing it does can unwind through the record.
  assert.ok(body.indexOf("Qt.callLater(function () { root.captureAfterRecord(layout, chosen) })") !== -1,
    "the capture is called synchronously from recordLayout");

  // 3. NOTHING IN THE CAPTURE PATH WRITES THE STATE FILE. The one function it
  //    reaches, and the whole store, must never call writeState.
  const after = source.slice(source.indexOf("function captureAfterRecord(layout, chosen)"));
  const afterBody = after.slice(0, after.indexOf("\n  }\n"));
  assert.strictEqual(afterBody.indexOf("writeState"), -1, afterBody);
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");
  assert.strictEqual(store.indexOf("writeState"), -1, "the capture store writes the state file");
  assert.strictEqual(store.indexOf("StateModel"), -1, "the capture store reaches the state model");
});

test("the pictures are evicted at all three points a recording can end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // Forget deletes, undo drops what the undone record took, and a re-record
  // replaces — the third one through captureAfterRecord/capture, which evicts
  // the topology's prefix before it writes the new set.
  for (const [name, fn] of [["undoRecord", "function undoRecord()"],
                            ["forgetLayout", "function forgetLayout()"]]) {
    const at = source.indexOf(fn);
    assert.ok(at !== -1, name + " is gone");
    const body = source.slice(at, source.indexOf("\n  }\n", at));
    assert.ok(body.indexOf("captureStore.evict(PanelModel.captureTopologyPrefix(") !== -1,
      name + " no longer evicts this topology's pictures");
  }

  const after = source.slice(source.indexOf("function captureAfterRecord(layout, chosen)"));
  const afterBody = after.slice(0, after.indexOf("\n  }\n"));
  assert.ok(afterBody.indexOf("captureStore.evict(plan.prefix") !== -1,
    "a re-record with the pictures since switched off leaves the old ones behind");

  // And the eviction of the REPLACED set is a step of the capture sequence, not
  // a second call the caller has to remember: `find -delete` racing a save is
  // exactly what ordering them separately would buy.
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");
  const capture = store.slice(store.indexOf("function capture(plan, done)"));
  assert.ok(capture.slice(0, 2000).indexOf("_resolveThenWalk") !== -1);
  assert.ok(store.indexOf("store.evict(store._plan ? store._plan.prefix : \"\", \"re-recorded\",") !== -1,
    "the capture sequence no longer evicts before it writes");
  // And the walk is chained onto THAT eviction's own completion, not onto
  // whichever eviction happens to finish next (tick ilg).
  assert.ok(store.indexOf("function () { store._runEvictThen() })") !== -1,
    "the round's continuation is no longer attached to the round's own eviction job");
});

test("_finish() tears down every piece of round state, and every early-return path between the guard and completion reaches it (tick gox)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  // THE BUG: _finish() used to clear only `_done` and `_active`, leaving
  // `_queue` populated after an early abort (a failed mkdir, say). The next
  // captureAll() then hit `if (store._active || store._queue.length > 0)`,
  // read it as "a round is already running", and refused — silently, for the
  // rest of the panel's life. `_finish()` must reset everything a round
  // writes into, not just the two fields `busy` reads.
  const finishAt = store.indexOf("function _finish()");
  assert.ok(finishAt !== -1, "_finish() is gone");
  const finishBody = store.slice(finishAt, store.indexOf("\n  }\n", finishAt));

  for (const field of ["_done", "_active", "_queue", "_handles", "_evictThen", "_plan", "_results"]) {
    assert.ok(new RegExp("store\\." + field + "\\s*=").test(finishBody),
      "_finish() no longer resets " + field + " — a round left with this set latches the guard");
  }

  // The callback must still get the results it was going to get: `results` is
  // read out of store._results BEFORE _finish() resets that property.
  const resultsReadAt = finishBody.indexOf("var results = store._results");
  const resultsResetAt = finishBody.indexOf("store._results = []");
  const callbackAt = finishBody.indexOf("done(results)");
  assert.ok(resultsReadAt !== -1 && resultsResetAt !== -1 && callbackAt !== -1,
    "_finish()'s shape changed under this test");
  assert.ok(resultsReadAt < resultsResetAt,
    "_finish() resets _results before reading it into a local — the callback would get []");

  // THE AUDIT: every early-return path AFTER capture()'s guards and before a
  // normal completion must reach _finish(). Each slice below is exactly one
  // such path, isolated the same way the QML itself separates them, and each
  // must contain a call to store._finish().
  //
  // capture()'s OWN two refusals are the exception, and tick ilg is why: they
  // run before a single field of round state is written, so there is nothing to
  // tear down — and calling _finish() there tore down the round that was
  // actually running. They are pinned by their own test below.
  const mkdirAt = store.indexOf("id: mkdirProc");
  const mkdirBody = store.slice(mkdirAt, store.indexOf("\n  }\n", mkdirAt));
  const mkdirFail = mkdirBody.slice(mkdirBody.indexOf("if (exitCode !== 0)"),
    mkdirBody.indexOf("store.evict("));
  assert.ok(mkdirFail.indexOf("store._finish()") !== -1,
    "mkdirProc's failure path no longer reaches _finish() — this is the exact path tick gox found broken");

  const walkAt = store.indexOf("function _resolveThenWalk()");
  const walkBody = store.slice(walkAt, store.indexOf("\n  }\n", walkAt));
  const walkEmpty = walkBody.slice(0, walkBody.indexOf("var addresses"));
  assert.ok(walkEmpty.indexOf("store._finish()") !== -1,
    "_resolveThenWalk()'s empty-queue path no longer reaches _finish()");

  const nextAt = store.indexOf("function _next()");
  const nextBody = store.slice(nextAt, store.indexOf("\n  }\n", nextAt));
  const nextEmpty = nextBody.slice(nextBody.indexOf("if (store._queue.length === 0)"),
    nextBody.indexOf("var entry = store._queue[0]"));
  assert.ok(nextEmpty.indexOf("store._finish()") !== -1,
    "_next()'s normal-completion path (empty queue) no longer reaches _finish()");

  // The whole-queue deadline reaches _finish() through the shared loud-abandon
  // path (tick 070), which is also the guard's impossible-state exit — one
  // implementation of "a round that cannot proceed fails loudly", not one per
  // caller. Both halves are pinned: the deadline delegates, and the delegate
  // both warns and tears the round down.
  const totalAt = store.indexOf("id: total");
  const totalBody = store.slice(totalAt, store.indexOf("\n  }\n", totalAt));
  assert.ok(totalBody.indexOf("store._abandonRound(") !== -1,
    "the whole-queue deadline no longer ends the round through _abandonRound():\n" + totalBody);
  const abandonAt = store.indexOf("function _abandonRound(sentence, reason)");
  assert.ok(abandonAt !== -1, "_abandonRound is gone");
  const abandonBody = store.slice(abandonAt, store.indexOf("\n  }\n", abandonAt));
  assert.ok(abandonBody.indexOf("store._finish()") !== -1,
    "_abandonRound() no longer reaches _finish(), so an abandoned round latches `busy` forever");
  assert.ok(abandonBody.indexOf("store.warn(sentence)") !== -1,
    "_abandonRound() no longer says anything — a round that gives up in silence is tick 070 again");
  assert.ok(abandonBody.indexOf("guard.stop()") !== -1 && abandonBody.indexOf("total.stop()") !== -1,
    "_abandonRound() leaves a timer armed over a round that is over:\n" + abandonBody);
  assert.ok(abandonBody.indexOf("store._results = results") !== -1,
    "_abandonRound() drops the windows it abandoned instead of reporting them");

  // The remaining exits — _settle()'s callers (no-handle, view-create-failed,
  // empty-source, grab-null, save-failed, grab-refused) and the per-window
  // guard timer (no-frame) — never return out of the round at all: each
  // records one entry's result and loops back to _next() via Qt.callLater,
  // which drains to the empty-queue path pinned above. Pinned here by
  // confirming _settle() itself never tears the round down early.
  const settleAt = store.indexOf("function _settle(step, ok, reason)");
  const settleBody = store.slice(settleAt, store.indexOf("\n  }\n", settleAt));
  assert.strictEqual(settleBody.indexOf("_finish"), -1,
    "_settle() now short-circuits the round instead of always looping back to _next()");
  assert.ok(settleBody.indexOf("Qt.callLater(function () { store._next() })") !== -1,
    "_settle() no longer loops back to _next(), so its callers would no longer reach the audited path");
});

// ---------------------------------------------------------------------------
// A capture round cannot be destroyed by the Record that was refused (tick ilg)
// ---------------------------------------------------------------------------

test("A REFUSED RECORD TOUCHES NOTHING: capture()'s guards come before any round state (tick ilg)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  const at = store.indexOf("function capture(plan, done) {");
  assert.ok(at !== -1, "capture() is gone");
  const body = store.slice(at, store.indexOf("\n  }\n", at));

  // 1. THE GUARD IS FIRST. `_plan`, `_done` and `_results` used to be assigned
  //    above it, so a second Record during a live round overwrote the FIRST
  //    round's fields with the refused one's — and then called _finish(), which
  //    since tick gox correctly resets everything, tearing down the round that
  //    was actually running: its `done` lost (so its log line never appeared),
  //    its view left alive with a pending grab, and `busy` false so the NEXT
  //    Record was not blocked either.
  const guard = body.indexOf("if (store.busy)");
  assert.ok(guard !== -1, "capture() no longer refuses a second round on `busy`");
  for (const field of ["_plan", "_done", "_results", "_queue", "_handles", "_evictThen"]) {
    const write = body.indexOf("store." + field + " =");
    assert.ok(write !== -1, "capture() no longer sets " + field);
    assert.ok(write > guard,
      "capture() writes " + field + " before the one-round-at-a-time guard — a refused Record "
      + "would alter the round that is actually running");
  }

  // 2. NEITHER REFUSAL CALLS _finish(). The round it would tear down belongs to
  //    somebody else. This is the assertion that must not be relaxed back: the
  //    pre-gox latch (a half-reset round leaving `_queue` populated) is NOT the
  //    way to stop the interleave, and nothing here reintroduces it.
  const refusals = body.slice(guard, body.indexOf("var captures ="));
  assert.strictEqual(refusals.indexOf("_finish"), -1,
    "capture()'s refusal paths call _finish() again — the exact bug tick ilg closed:\n" + refusals);

  // 3. The caller is still answered, with the empty round it always got: it
  //    logs "0 picture(s) stored".
  assert.strictEqual((refusals.match(/callback\(\[\]\)/g) || []).length, 2,
    "capture()'s two refusals no longer both answer the caller with an empty round:\n" + refusals);
});

test("`busy` is load-bearing: a live capture round dims Record, and says why (tick ilg)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");
  const panelSrc = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // It covers the WHOLE round, mkdir and eviction included: between capture()
  // and _resolveThenWalk the queue can be non-empty but `_active` is still
  // false, and that window is a process spawn and a `find` wide.
  const busyAt = store.indexOf("readonly property bool busy:");
  assert.ok(busyAt !== -1, "captureStore.busy is gone");
  const busyLine = store.slice(busyAt, store.indexOf("\n", busyAt));
  for (const field of ["_queue", "_active", "_plan"]) {
    assert.ok(busyLine.indexOf(field) !== -1,
      "busy no longer covers " + field + ", so part of a round reads as idle: " + busyLine);
  }

  // AND SOMETHING READS IT. It was read nowhere at all — verified by grep at
  // review time — which is how a second Record ever reached the store's refusal.
  const canAt = panelSrc.indexOf("readonly property bool canRecord:");
  assert.ok(canAt !== -1, "canRecord is gone");
  assert.ok(panelSrc.slice(canAt, canAt + 260).indexOf("!captureStore.busy") !== -1,
    "canRecord does not consult captureStore.busy, so Record is live during a capture round");

  // Both doors onto the act go through canRecord: the button binds it, the
  // keyboard and the overflow's Re-record call recordLayout(), and the IPC verb
  // answers "cannot-record" before it ever gets there.
  const ipc = panelSrc.slice(panelSrc.indexOf("function record(): string {"), panelSrc.length);
  assert.ok(ipc.slice(0, 200).indexOf("if (!root.canRecord) return \"cannot-record\"") !== -1,
    "the IPC record verb no longer gates on canRecord");
  const rec = panelSrc.slice(panelSrc.indexOf("function recordLayout() {"));
  assert.ok(rec.slice(0, 120).indexOf("if (!root.canRecord) return false") !== -1,
    "recordLayout no longer gates on canRecord");

  // And the hint under the map says which of the two reasons it is.
  const hintAt = panelSrc.indexOf("readonly property string recordHint:");
  assert.ok(panelSrc.slice(hintAt, hintAt + 180).indexOf("captureStore.busy") !== -1,
    "recordHint never mentions the capture round, so Record dims with no explanation");
});

test("a late grab cannot write a picture for a capture already reported failed (tick ilg)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  // "The step in flight" is the head of the queue, and every path that answers
  // for a step shifts it off. Asked as a NUMBER since tick 070 — see the
  // regression test below for why an object could never answer it.
  const isAt = store.indexOf("function _isCurrentStep(step)");
  assert.ok(isAt !== -1, "_isCurrentStep is gone");
  const isBody = store.slice(isAt, store.indexOf("\n  }\n", isAt));
  assert.ok(isBody.indexOf("step === store._step") !== -1
    && isBody.indexOf("store._queue.length > 0") !== -1,
    "_isCurrentStep no longer means 'this step, and the queue still has a head':\n" + isBody);

  // 1. THE PER-WINDOW GUARD CANNOT OUTLIVE ITS STEP. It measures exactly one
  //    thing — does this window ever deliver a frame — and stops the moment one
  //    does. It used to be stopped only at the top of _next(), a LATER turn, so
  //    it could fire against a grab still on the render thread.
  const contentAt = store.indexOf("function _onContent(view)");
  const contentBody = store.slice(contentAt, store.indexOf("\n  }\n", contentAt));
  const stop = contentBody.indexOf("guard.stop()");
  assert.ok(stop !== -1, "the per-window guard is no longer stopped when the frame arrives");
  assert.ok(stop < contentBody.indexOf("view.grabToImage("),
    "the guard is stopped after the grab is queued, which is the race itself");

  // 2. THE SAVE IS GATED, not just the result. A file written after the step
  //    ended is a picture no listing knows about, that no eviction can reach,
  //    and that can land after the switch-off has already emptied the cache.
  const grab = contentBody.slice(contentBody.indexOf("view.grabToImage(function (result)"));
  const gate = grab.indexOf("if (!store._isCurrentStep(step)) return");
  const save = grab.indexOf("saveToFile");
  assert.ok(gate !== -1, "the grab callback never checks whether its step is still in flight:\n" + grab);
  assert.ok(save !== -1 && gate < save,
    "the grab callback saves before it checks its step is still in flight:\n" + grab);

  // 3. _settle IS IDEMPOTENT PER ENTRY. A second answer for one step used to
  //    push a duplicate result AND shift the queue again — one window silently
  //    dropped, unphotographed and unreported, and therefore missing from the
  //    round's results and from the log line built out of them.
  const settleAt = store.indexOf("function _settle(step, ok, reason)");
  const settleBody = store.slice(settleAt, store.indexOf("\n  }\n", settleAt));
  const settleGate = settleBody.indexOf("if (!store._isCurrentStep(step)) return");
  assert.ok(settleGate !== -1, "_settle() is answerable twice for one step:\n" + settleBody);
  assert.ok(settleGate < settleBody.indexOf("store._results = results"),
    "_settle() records the result before checking the step is still in flight");

  //    AND THE TOKEN IS BURNT (tick 070). Shifting the queue was enough while
  //    the subject was the entry object — the shifted-off entry could never be
  //    the head again. A number survives the shift, so answering a step has to
  //    END it, or the second answer for step N lands on the entry that has just
  //    become the head: this same dropped window, one layer down.
  assert.ok(settleBody.indexOf("store._step = store._step + 1") !== -1,
    "_settle() no longer ends the step it answered, so a second answer for it "
    + "would be accepted against the NEXT window:\n" + settleBody);
  assert.ok(settleBody.indexOf("store._step = store._step + 1")
    < settleBody.indexOf("store._queue = store._queue.slice(1)"),
    "_settle() shifts the queue before it ends the step:\n" + settleBody);

  // 4. And the guard timer no longer settles blind: with _settle a no-op for a
  //    stale step, a guard firing against one would advance nothing at all.
  const guardAt = store.indexOf("id: guard");
  const guardBody = store.slice(guardAt, store.indexOf("\n  }\n", guardAt));
  assert.ok(guardBody.indexOf("if (!store._isCurrentStep(step))") !== -1,
    "the per-window guard settles a step without checking it is the one in flight:\n" + guardBody);
  // NOT _next() (tick 070): _next() rebuilds a view for the SAME queue head, so
  // a mismatch that does not correct itself is an invisible loop — a fresh
  // compositor capture session every stepMs, no result and no log line.
  //
  // Read against the CODE and not the file text: the comment beside this branch
  // has to be able to name the call it is warning about.
  const guardCode = qmlCode(guardBody);
  assert.strictEqual(guardCode.indexOf("store._next()"), -1,
    "the per-window guard retries the step by calling _next() again — the silent "
    + "respawn loop tick 070 closed:\n" + guardBody);
  assert.ok(guardBody.indexOf("store._abandonRound(") !== -1,
    "the per-window guard's impossible state is silent again:\n" + guardBody);
});

// ---------------------------------------------------------------------------
// The step in flight is a NUMBER, because an object cannot cross into a view
// (tick 070)
// ---------------------------------------------------------------------------

test("no answer for a capture step is carried in a QML property as a JS object (tick 070)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  // THE BUG, measured in the nested sandbox 2026-09-04 and reproduced from the
  // acceptance VM's symptom: the round went silent after its own eviction and
  // stored nothing.
  //
  // `Component.createObject(parent, { entry: entry })` passes its properties
  // through a QVariantMap, so the queue entry arrived in the view as a DEEP
  // COPY. Every path that answered for a step then asked
  // `store._queue[0] === entry` against that copy and got `false` — for ever.
  // The instrumented run:
  //
  //   entry===head false   head===head2 true   entry.address===head.address true
  //
  // so the grab callback returned before saving, `_settle` returned before
  // recording, and the guard fell into its "not the step in flight" branch and
  // called `_next()` — which built another view for the SAME head, every 6 s,
  // with no result and no log line, until the whole-queue deadline ended the
  // round 45 s later.
  //
  // The repair is that the step's identity is an integer, which the property
  // boundary cannot copy into something else.

  // 1. THE VIEW CARRIES A NUMBER. Not an object, and not "any property called
  //    entry" — the whole failure was that an object survives the crossing as
  //    data while losing the only thing being asked about it.
  const componentAt = store.indexOf("id: viewComponent");
  const componentBody = qmlCode(store.slice(componentAt, store.indexOf("\n  }\n", componentAt)));
  assert.ok(/property\s+int\s+step\s*:/.test(componentBody),
    "the capture view no longer carries an integer step:\n" + componentBody);
  assert.strictEqual(/property\s+var\s+entry\s*:/.test(componentBody), false,
    "the capture view carries the queue entry in a `property var` again — it "
    + "arrives there as a copy, and every answer about it is discarded:\n" + componentBody);

  // 2. AND THAT IS WHAT createObject IS HANDED. A properties map carrying the
  //    entry is the crossing itself.
  const nextAt = store.indexOf("function _next()");
  const nextBody = store.slice(nextAt, store.indexOf("\n  }\n", nextAt));
  assert.ok(nextBody.indexOf("createObject(stage, { captureSource: handle, step: step })") !== -1,
    "the view is created with something other than the step number:\n" + nextBody);
  assert.ok(nextBody.indexOf("store._step = store._step + 1") !== -1,
    "_next() no longer claims a step number for the window it is about to start");

  // 3. NOTHING COMPARES JS OBJECT IDENTITY ANYWHERE IN THIS FILE. `===` between
  //    two objects that crossed a QML property is the whole defect, and the
  //    exact expression that was there must not come back.
  const code = qmlCode(store);
  assert.strictEqual(code.indexOf("store._queue[0] === entry"), -1,
    "the round identifies its step by object identity again");
  assert.strictEqual(code.indexOf("_isCurrentEntry"), -1,
    "_isCurrentEntry is back — it can only ever answer false");

  // 4. EVERY ANSWER GOES THROUGH THE NUMBER. The three that can answer for a
  //    step — the frame handler, the grab callback and the per-window guard —
  //    plus _settle itself.
  for (const [name, needle] of [
    ["_onContent", "function _onContent(view)"],
    ["_settle", "function _settle(step, ok, reason)"],
  ]) {
    const at = store.indexOf(needle);
    assert.ok(at !== -1, name + " is gone");
    assert.ok(store.slice(at, store.indexOf("\n  }\n", at)).indexOf("store._isCurrentStep(") !== -1,
      name + " no longer asks whether its step is the one in flight");
  }
  const guardAt = store.indexOf("id: guard");
  const guardBody = store.slice(guardAt, store.indexOf("\n  }\n", guardAt));
  assert.ok(guardBody.indexOf("store._current ? store._current.step : 0") !== -1,
    "the per-window guard no longer reads the step off the view it armed for:\n" + guardBody);

  // 5. A ROUND THAT CANNOT PROCEED FAILS LOUDLY. Both exits that end a round
  //    without draining it go through the same warn-and-tear-down, and the
  //    whole-queue deadline is the outer bound on all of it.
  const abandonAt = store.indexOf("function _abandonRound(sentence, reason)");
  assert.ok(abandonAt !== -1, "_abandonRound is gone");
  const abandonBody = store.slice(abandonAt, store.indexOf("\n  }\n", abandonAt));
  assert.ok(abandonBody.indexOf("store.warn(sentence)") !== -1
    && abandonBody.indexOf("store._finish()") !== -1,
    "a round that gives up no longer both says so and tears itself down:\n" + abandonBody);
  const totalBody = store.slice(store.indexOf("id: total"),
    store.indexOf("\n  }\n", store.indexOf("id: total")));
  assert.ok(totalBody.indexOf("store._abandonRound(") !== -1
    && guardBody.indexOf("store._abandonRound(") !== -1,
    "the deadline and the guard no longer share the one loud exit");
});

test("two evictions cannot cross, and a `find` that failed is not silent (tick ilg)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  // ONE Process, five callers. The pattern, the reason and the continuation
  // lived in properties beside it, so a second eviction SIGTERMed the first and
  // then ran the first's onExited against the SECOND's pattern: the wrong
  // sentence logged, and the capture round's "now start walking" continuation
  // fired on a `find` that had been killed — breaking the stated invariant that
  // the eviction completes before the first save.
  assert.ok(store.indexOf("function _enqueueEvict(names, sentence, reason, then)") !== -1,
    "evictions are no longer queued as jobs");
  const startAt = store.indexOf("function _startEvict()");
  assert.ok(startAt !== -1, "_startEvict is gone");
  const startBody = store.slice(startAt, store.indexOf("\n  }\n", startAt));
  assert.ok(startBody.indexOf("if (store._evictJob || store._evictQueue.length === 0) return") !== -1,
    "_startEvict no longer refuses to start a second find over a running one");

  // NOTHING CAN KILL A RUNNING FIND. The `running = false; running = true`
  // restart is what SIGTERMed the previous eviction, and it now exists in
  // exactly ONE place — behind the guard above, where no job is in flight.
  assert.strictEqual((store.match(/evictProc\.running = false/g) || []).length, 1,
    "the shared Process is restarted from more than one place again");
  assert.ok(startBody.indexOf("evictProc.running = false") !== -1,
    "the one restart is no longer the guarded one inside _startEvict:\n" + startBody);
  // And the property the old code crossed is gone entirely.
  assert.strictEqual(store.indexOf("_evictReason"), -1,
    "the eviction's reason still lives in a property a later caller can overwrite");

  const block = store.slice(store.indexOf("id: evictProc"), store.indexOf("property var _evictThen"));
  assert.ok(block.indexOf("var job = store._evictJob") !== -1,
    "onExited no longer reads the job that actually finished:\n" + block);
  assert.ok(block.indexOf("job.names") !== -1 && block.indexOf("job.reason") !== -1
    && block.indexOf("job.sentence") !== -1,
    "the log line is still built from shared properties rather than the finished job");
  assert.ok(block.indexOf("job.then()") !== -1,
    "the continuation is no longer the finished job's own");
  assert.ok(block.indexOf("store._startEvict()") !== -1,
    "nothing starts the next queued eviction, so the queue stalls after one job");

  // A DELETE THAT FAILED IS SAID OUT LOUD. `find`'s exit code was ignored and
  // its stderr went to a collector nothing read, so an undeletable picture left
  // a log line claiming the pictures were dropped.
  assert.ok(block.indexOf("if (exitCode !== 0 && store._cacheDirPresent)") !== -1,
    "a failed eviction is still silent:\n" + block);
  assert.ok(block.indexOf("store.warn(") !== -1, block);
  assert.ok(block.indexOf("evictErr.text") !== -1,
    "the eviction's stderr still goes to a collector nothing reads");
  // ...but the MISSING cache directory is not a failure — it is the state the
  // plugin ships in, and the listing swallows it for exactly the same reason.
  const listing = store.slice(store.indexOf("id: listProc"), store.indexOf("property bool _cacheDirPresent"));
  assert.ok(listing.indexOf("store._cacheDirPresent = (exitCode === 0)") !== -1, listing);
});

// ---------------------------------------------------------------------------
// Unwatching an app deletes its pictures, on every desk (tick sp7)
// ---------------------------------------------------------------------------

// `find -name` is fnmatch, so the pattern is testable against real file names
// rather than only against itself. Everything but the two wildcards this
// codebase puts in is escaped, so a metacharacter that leaked out of an
// identity id would show up as a MISS here and not as a silently wider match.
function globToRegExp(glob) {
  return new RegExp("^" + String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\?/g, ".")
    .replace(/\*/g, ".*") + "$");
}

test("an unwatched app names EVERY picture of itself, on every desk (tick sp7)", () => {
  const mine = "obsidian";
  const theirs = "slack";
  const pattern = panel.captureIdentityPattern(mine);
  const re = globToRegExp(pattern);

  // The topology segment is wildcarded and the occurrence is left open, so one
  // pattern names this app's pictures wherever and however often they were
  // taken. This is the whole repair: being watched is a fact about an APP, and
  // an eviction keyed on the desk you happen to be plugged into left every
  // other desk's copies with nobody who would ever come back for them.
  for (const key of ["Laptop", "Laptop + AOC U34", "", "eDP-1|DP-3|HDMI-A-1"]) {
    for (const occurrence of [0, 1, 7, 23]) {
      const name = panel.captureFileName(mine, occurrence, key);
      assert.ok(re.test(name), pattern + " does not name " + name);
      assert.ok(!re.test(panel.captureFileName(theirs, occurrence, key)),
        pattern + " also names another app's picture: " + panel.captureFileName(theirs, occurrence, key));
    }
  }

  // And it names nothing else in the directory.
  assert.ok(!re.test("readme.txt"));
  assert.ok(!re.test(panel.captureFileName(mine, 0, "Laptop").replace(/\.jpg$/, ".png")));
});

test("the identity pattern carries no glob metacharacter of its own (tick sp7)", () => {
  // captureSafeSegment maps everything outside [A-Za-z0-9._-] to "_", so the
  // only "?" and "*" in a pattern are the ones captureIdentityPattern puts
  // there: eight for the topology hash, one for the occurrence. An id that could
  // contribute its own would be a user-editable string widening a delete.
  for (const id of ["a?b", "a*b", "../../etc/passwd", "[a-z]", "**", "?", "-rf", ".hidden"]) {
    const pattern = panel.captureIdentityPattern(id);
    assert.strictEqual((pattern.match(/\?/g) || []).length, 8, id + " -> " + pattern);
    assert.strictEqual((pattern.match(/\*/g) || []).length, 1, id + " -> " + pattern);
    assert.strictEqual(pattern.indexOf("["), -1, id + " -> " + pattern);
  }

  // Two ids that SANITIZE the same are still told apart, by the hash that
  // captureFileName uses for exactly the same reason.
  const a = panel.captureIdentityPattern("a/b");
  const b = panel.captureIdentityPattern("a?b");
  assert.notStrictEqual(a, b);
  assert.ok(!globToRegExp(a).test(panel.captureFileName("a?b", 0, "Laptop")));
  assert.ok(globToRegExp(a).test(panel.captureFileName("a/b", 0, "Laptop")));

  // An empty id names NOTHING, for the reason captureFileName returns "" for
  // one: a caller must not be able to build a pattern that matches every file.
  assert.strictEqual(panel.captureIdentityPattern(""), "");
  assert.strictEqual(panel.captureIdentityPattern("   "), "");
  assert.strictEqual(panel.captureIdentityPattern(null), "");
  assert.deepStrictEqual(panel.captureIdentityPatterns(["", null, "  "]), []);

  // The list form is de-duplicated: one act, one name per app.
  assert.deepStrictEqual(panel.captureIdentityPatterns(["obsidian", "obsidian", "slack"]),
    [panel.captureIdentityPattern("obsidian"), panel.captureIdentityPattern("slack")]);
  assert.deepStrictEqual(panel.captureIdentityPatterns(null), []);
});

test("EVERY WAY OF DROPPING A PICTURE DELETES IT, on every desk (tick sp7)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  const bodyOf = (marker) => {
    const at = source.indexOf(marker);
    assert.ok(at !== -1, marker + " is gone");
    return source.slice(at, source.indexOf("\n  }\n", at));
  };

  // 1. THE SWITCH, which is now the whole of the global half: off deletes every
  //    stored picture on every desk and empties the live store as well, and both
  //    happen only once the write is known to have landed.
  const switched = bodyOf("function setPictures(on) {");
  assert.ok(switched.indexOf("captureStore.evictAll(\"switched off\")") !== -1,
    "switching the pictures off no longer deletes the stored ones:\n" + switched);
  assert.ok(switched.indexOf("liveCaptures.clear()") !== -1,
    "switching the pictures off leaves the live ones in memory:\n" + switched);
  assert.ok(switched.indexOf("if (!root.writeState(StateModel.setPictures(fresh, want))) return")
    < switched.indexOf("captureStore.evictAll"),
    "the pictures go before the write that switches them off is known to have landed");
  assert.strictEqual(switched.indexOf("captureTopologyPrefix"), -1,
    "the switch evicts one desk's prefix — the other desks would keep their pictures forever");

  // 2. UNWATCHING, which is what makes the README's promise true: it took the
  //    identity, never the files.
  const toggle = bodyOf("function toggleChip(chip) {");
  assert.ok(toggle.indexOf("captureStore.evictIdentities([chip.identityId], \"unwatched\")") !== -1,
    "unticking an app still leaves its photographs on disk:\n" + toggle);
  assert.ok(toggle.indexOf("if (root.writeState(StateModel.setIdentities")
    < toggle.indexOf("evictIdentities"), "the pictures go before the unwatch is written");
  // And the LIVE half of the same act, handed the set that is LEFT rather than
  // the id that went — the shape LiveCaptureStore.retain documents.
  assert.ok(toggle.indexOf("liveCaptures.retain(remaining)") !== -1,
    "unticking an app leaves its live picture on the map:\n" + toggle);

  // 3. THE STORE'S SIDE: one process for the whole list, built from the pure
  //    function, and an empty list deletes nothing — exactly as an empty prefix
  //    does.
  const evictIds = store.slice(store.indexOf("function evictIdentities(identityIds, reason)"));
  const evictBody = evictIds.slice(0, evictIds.indexOf("\n  }\n"));
  assert.ok(evictBody.indexOf("PanelModel.captureIdentityPatterns(identityIds)") !== -1, evictBody);
  assert.ok(evictBody.indexOf("if (!names.length) return") !== -1,
    "an empty identity list no longer refuses — it would name every file:\n" + evictBody);
  // Several names go into ONE find, as an -o group.
  const match = store.slice(store.indexOf("function _matchArgs(names)"));
  const matchBody = match.slice(0, match.indexOf("\n  }\n"));
  assert.ok(matchBody.indexOf("\"-o\"") !== -1 && matchBody.indexOf("\"(\"") !== -1, matchBody);
});

// ---------------------------------------------------------------------------
// ONE SWITCH, AND NO SECOND ANSWER ANYWHERE (epic wau)
// ---------------------------------------------------------------------------
//
// Increment 06 shipped two consents: a camera on every row and a three-answer
// dialogue on the first Record. The human used them, could not find the camera,
// and was talked out of his own pictures by the dialogue. Both are gone, and
// these are the pins that keep them gone — an absence needs a test more than a
// presence does, because nothing else fails when one comes back.

test("the consent prompt does not exist, in any file", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");

  assert.strictEqual(fs.existsSync(path.join(root, "ConsentPrompt.qml")), false,
    "ConsentPrompt.qml is back");

  const source = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");
  for (const word of ["consentOpen", "ConsentPrompt", "answerConsent", "pictureConsent",
    "consentChoices", "consentCaptures", "picturedOf(", "picturableOf(", "setPicturedFor"]) {
    assert.strictEqual(source.indexOf(word), -1,
      "Panel.qml still names " + word + " — the prompt or the per-app camera is back");
  }

  // The map's chips lost their per-app grant too: the switch is the panel's and
  // there is no second derivation of it anywhere a chip can reach.
  const map = fs.readFileSync(path.join(root, "MapWorkspace.qml"), "utf8");
  assert.strictEqual(map.indexOf("pictured"), -1, "MapWorkspace still reports a per-app grant");

  // And the pure model: the prompt's vocabulary went with it.
  const model = fs.readFileSync(path.join(root, "PanelModel.js"), "utf8");
  for (const fn of ["function consentChoices", "function isConsentChoice",
    "function consentPromptDue", "function picturedIdentityIds"]) {
    assert.strictEqual(model.indexOf(fn), -1, "PanelModel still defines " + fn);
  }
  assert.strictEqual(panel.consentChoices, undefined, "consentChoices is still exported");
  assert.strictEqual(panel.picturedIdentityIds, undefined,
    "picturedIdentityIds is still exported");
});

test("the payload states the switch and none of the consent keys", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const state = source.slice(source.indexOf("function panelState()"));

  // ALWAYS PRESENT and always a boolean: whether this tool may photograph is a
  // fact the panel has, not a draw-time value it waits for. A key that vanished
  // when the answer was "off" would make "the pictures are off" and "this build
  // has no switch" the same payload.
  assert.ok(state.indexOf("pictures: root.picturesOn") !== -1,
    "the payload no longer carries the switch");

  // ABSENT, never null — tests/acceptance/README.md is normative about the
  // difference, and the acceptance suite asserts these with has().
  for (const key of ["pictureConsent:", "consentOpen:", "consentChoices:", "consentCaptures:",
    "pictured:", "picturable:"]) {
    assert.strictEqual(state.indexOf(key), -1,
      "the payload still carries " + key + " — it must be absent, not null");
  }
});

test("the IPC verb is setPictures, and setPictured is not a verb", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // One switch, so no key: `setPictured(key, value)` is not renamed, it is gone.
  assert.ok(source.indexOf("function setPictures(value: string): string") !== -1,
    "the setPictures verb is missing");
  assert.strictEqual(source.indexOf("function setPictured("), -1,
    "the per-row setPictured verb is back");
  assert.strictEqual(source.indexOf("function answerConsent("), -1,
    "the answerConsent verb is back");

  const at = source.indexOf("function setPictures(value: string): string");
  const body = source.slice(at, source.indexOf("\n    }\n", at));
  // The two words it takes, the two it answers, and the one refusal that comes
  // before the file has been read — the shape setPaused established.
  assert.ok(body.indexOf('if (want !== "on" && want !== "off") return "unknown"') !== -1, body);
  assert.ok(body.indexOf('if (!root.stateLoaded) return "no-state"') !== -1, body);
  assert.ok(body.indexOf('return root.picturesOn ? "on" : "off"') !== -1,
    "the verb answers what it was asked for rather than the resulting state:\n" + body);
  // Through the panel's own setter, which owns the fresh read, the eviction and
  // the log — an IPC path that wrote the flag itself would switch nothing off.
  assert.ok(body.indexOf("root.setPictures(want === \"on\")") !== -1, body);
});

test("setPictures cannot be switched OFF by a garbled argument", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const at = source.indexOf("function setPictures(on) {");
  const body = source.slice(at, source.indexOf("\n  }\n", at));

  // `!== false` and never `=== true`, at the layer that actually calls evictAll
  // and clear(). OFF is the destructive direction — it deletes every stored
  // picture on every desk — and the reading rule StateModel.picturesOn owns
  // exists precisely so that nothing but the literal `false` can select it. A
  // `=== true` here would make every non-boolean argument a wholesale delete.
  assert.ok(body.indexOf("var want = on !== false") !== -1,
    "Panel.setPictures coerces its argument to OFF, which is the destructive "
    + "direction — only the literal false may select it:\n" + body);
  assert.strictEqual(body.indexOf("on === true"), -1, body);

  // And the pure half, where it can be executed rather than grepped.
  const st = require("../StateModel.js");
  const on = st.defaultState();
  const off = st.setPictures(on, false);
  assert.strictEqual(st.picturesOn(off), false, "the literal false is off");
  for (const junk of [undefined, null, 0, "", "false", "off", {}]) {
    assert.strictEqual(st.picturesOn(st.setPictures(on, junk)), true,
      JSON.stringify(junk) + " must not switch the pictures off");
    assert.strictEqual(st.picturesOn(st.setPictures(off, junk)), true,
      JSON.stringify(junk) + " on an already-off state is not a second switch-off");
  }
});

test("the overflow menu's Pictures entry actually throws the switch", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const at = source.indexOf("function activateOverflow() {");
  assert.ok(at !== -1, "Panel.qml has no activateOverflow");
  const body = source.slice(at, source.indexOf("\n  }\n", at));

  // THE PRESS PATH, which nothing else in this repository reaches. The menu
  // MODEL is pure and is tested above; the payload carries no menu actions at
  // all, so the acceptance VM cannot see one either — which means a build whose
  // "pictures" entry did nothing would satisfy every other assertion about the
  // switch, in node and in the VM alike, and the user would press it and watch
  // nothing happen.
  const branch = body.indexOf("action.id === \"pictures\"");
  assert.ok(branch !== -1,
    "activateOverflow has no branch for the pictures entry, so pressing it does nothing:\n"
    + body);
  const call = body.indexOf("root.setPictures(!root.picturesOn)", branch);
  assert.ok(call !== -1,
    "the pictures branch does not throw the switch through the panel's own setter — "
    + "which owns the fresh read, the eviction and the log:\n" + body);

  // AND THE MENU STAYS OPEN, which is what the entry's own comment promises and
  // what makes the press legible: the label flips under the cursor, so the menu
  // is its own receipt. Forget and Re-record both close it; this one must not.
  assert.strictEqual(body.indexOf("closeOverflow", call), -1,
    "the pictures branch closes the menu, so the flipped label — the only "
    + "feedback the press has — is never seen:\n" + body);
});

test("switching the pictures off is the ONLY thing that empties the whole cache", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // THE OTHER HALF OF THE DoD's SECOND CLAUSE: "a v6 file's stored pictures
  // SURVIVE on disk when `pictures` resolves true". The VM can watch a migration
  // and can watch the cache, but it seeds no v6 file — so survival is asserted
  // here, as a property of the code: there is exactly one call to `evictAll` in
  // the whole panel, and it is inside `setPictures`. Nothing on the read path,
  // nothing on the migration path, and nothing a panel open touches can empty
  // the cache; only the user throwing the switch can.
  //
  // A COUNT, deliberately, and it is the assertion that would catch the
  // regression this is written against — a second `evictAll` added to a
  // load-time or migrate-time branch would leave every other test in this
  // repository green while quietly deleting the user's pictures the first time
  // they opened the panel after an upgrade.
  const calls = source.split("evictAll(").length - 1;
  assert.strictEqual(calls, 1,
    "Panel.qml calls evictAll " + calls + " times; exactly one call, inside setPictures, "
    + "is what makes \"a migrated file's pictures survive\" a property of the code");

  const at = source.indexOf("function setPictures(on) {");
  assert.ok(at !== -1, "Panel.qml has no setPictures");
  const body = source.slice(at, source.indexOf("\n  }\n", at));
  assert.ok(body.indexOf("evictAll(") !== -1,
    "the one evictAll is not in setPictures — something else empties the cache:\n" + body);

  // And it is on the OFF branch only: switching the pictures ON must not delete
  // the pictures a migrated file arrived with.
  const off = body.indexOf("if (!want) {");
  assert.ok(off !== -1 && off < body.indexOf("evictAll("),
    "evictAll is not inside the off branch, so switching the pictures ON would "
    + "delete them:\n" + body);
});

test("switching the pictures back ON restarts the live round under an open panel", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const at = source.indexOf("function setPictures(on) {");
  const body = source.slice(at, source.indexOf("\n  }\n", at));

  // A live round is ONCE PER PANEL SESSION (the latch), so switching the
  // pictures on with the panel already open would otherwise draw nothing until
  // the user closed and reopened it. The latch is dropped and the round re-run;
  // startLiveRound's own guards hold it back when the panel is shut.
  const latch = body.indexOf("root.liveRoundStarted = false");
  const start = body.indexOf("root.startLiveRound()");
  assert.ok(latch !== -1 && start !== -1,
    "switching the pictures on does not restart the live round:\n" + body);
  assert.ok(latch < start, "the round is restarted before the latch is dropped:\n" + body);

  // BOTH LOG LINES GATED ON THE WRITE (the writeState-returns-boolean rule): a
  // refused write must not claim in the log that anything happened.
  const write = body.indexOf("if (!root.writeState(StateModel.setPictures(fresh, want))) return");
  assert.ok(write !== -1, body);
  assert.ok(write < body.indexOf("pictures switched off"), body);
  assert.ok(write < body.indexOf("pictures switched on"), body);
  // And the off line says what it just destroyed, because nothing else will.
  assert.ok(body.indexOf("every stored picture deleted") !== -1, body);
});

// ---------------------------------------------------------------------------
// The picture is of the window it claims (tick 3xi)
// ---------------------------------------------------------------------------

// Two windows of one identity, far enough apart that the placement comparator
// has an opinion about which is occurrence 0.
function twoTerminals(leftAt, rightAt) {
  return [
    makeClient({ address: "0xLEFT", class: "foot", title: "left", at: leftAt, size: [800, 600],
                 workspace: { id: 1, name: "1" }, monitor: 0 }),
    makeClient({ address: "0xRIGHT", class: "foot", title: "right", at: rightAt, size: [400, 300],
                 workspace: { id: 1, name: "1" }, monitor: 0 })
  ];
}

test("a SECOND window index is a second opinion, and it can photograph the wrong window (tick 3xi)", () => {
  // This test exists to show the failure is real rather than theoretical, and to
  // make it impossible to reintroduce quietly. Both halves use the SAME layout;
  // the only difference is which index the plan is built from.
  const identities = [{ id: "terminal", patterns: ["^foot$"] }];
  const atRecord = twoTerminals([100, 100], [900, 100]);
  const layout = engine.buildLayout(atRecord, monitorsLaptop, identities, AT);

  // The desk read a moment later, with the two windows swapped left to right —
  // a drag, a tiling flip, anything. Nothing about the layout changed; it is
  // already written.
  const afterwards = twoTerminals([900, 100], [100, 100]);

  const honest = engine.chosenWindows(atRecord, identities, monitorsLaptop);
  const second = engine.chosenWindows(afterwards, identities, monitorsLaptop);

  // The occurrence order really did move. Without this the rest proves nothing.
  assert.notStrictEqual(honest.byId.terminal[0].address, second.byId.terminal[0].address,
    "the two reads agree, so this fixture cannot demonstrate anything");

  const fromRecord = panel.capturePlan(layout, identities, honest);
  const fromSecondOpinion = panel.capturePlan(layout, identities, second);

  // BOTH PLANS ARE FILED UNDER THE SAME NAMES. That is the whole danger: the
  // key is (identity, occurrence, topology), it is right either way, and no map
  // and no assertion about the key can tell these two apart.
  assert.deepStrictEqual(fromRecord.captures.map((c) => c.file),
    fromSecondOpinion.captures.map((c) => c.file));

  // And they photograph DIFFERENT WINDOWS.
  assert.notDeepStrictEqual(fromRecord.captures.map((c) => c.address),
    fromSecondOpinion.captures.map((c) => c.address),
    "the second opinion happened to agree — the fixture no longer demonstrates the bug");

  // The honest plan's window is the one the layout entry actually describes:
  // same address, and therefore the geometry the record filed.
  const byAddress = {};
  for (const client of atRecord) byAddress[client.address] = client;
  for (const capture of fromRecord.captures) {
    const entry = layout.apps.find((a) => a.identityId === capture.identityId
      && a.occurrence === capture.occurrence);
    assert.ok(entry, "no layout entry for " + capture.file);
    const client = byAddress[capture.address];
    assert.ok(client, "the capture names an address the record never saw: " + capture.address);
    assert.deepStrictEqual(entry.at, client.at,
      "the picture's window is not the window this entry describes");
    assert.deepStrictEqual(entry.size, client.size);
  }
});

test("ONE INDEX, TWO USES: buildLayout takes the index the capture will be handed (tick 3xi)", () => {
  const identities = [{ id: "terminal", patterns: ["^foot$"] }];
  const clients = twoTerminals([100, 100], [900, 100]);
  const chosen = engine.chosenWindows(clients, identities, monitorsLaptop);

  // Handing in the index the function would have built itself changes nothing —
  // so the panel's single computation is not a different recording.
  assert.deepStrictEqual(
    engine.buildLayout(clients, monitorsLaptop, identities, AT, chosen),
    engine.buildLayout(clients, monitorsLaptop, identities, AT));

  // And the parameter is LOAD-BEARING rather than politely ignored: an index
  // over a different read produces a different record. If this ever comes out
  // equal, buildLayout has gone back to computing its own and the panel's two
  // uses are two computations again.
  const other = engine.chosenWindows(twoTerminals([900, 100], [100, 100]), identities, monitorsLaptop);
  assert.notDeepStrictEqual(
    engine.buildLayout(clients, monitorsLaptop, identities, AT, other),
    engine.buildLayout(clients, monitorsLaptop, identities, AT));

  // Omitted, it is what it always was — scripts/record-current, and every test
  // that only wants a record.
  assert.deepStrictEqual(
    engine.buildLayout(clients, monitorsLaptop, identities, AT, null),
    engine.buildLayout(clients, monitorsLaptop, identities, AT));
});

test("the panel builds the window index ONCE, and the comment says what the code does (tick 3xi)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // EXACTLY ONE call in the whole panel. Two is the bug: the second ran a
  // Qt.callLater turn later, over the LIVE client list, with nothing making the
  // two agree.
  assert.strictEqual((source.match(/Engine\.chosenWindows\(/g) || []).length, 1,
    "Panel.qml computes the window index more than once — a capture can be filed under a "
    + "correct key and be a photograph of a different window");

  const recAt = source.indexOf("function recordLayout() {");
  const recBody = source.slice(recAt, source.indexOf("\n  }\n", recAt));
  assert.ok(recBody.indexOf("var chosen = Engine.chosenWindows(") !== -1,
    "recordLayout no longer builds the index:\n" + recBody);
  // The same variable reaches both: the record and the pictures.
  assert.ok(recBody.indexOf("new Date().toISOString(), chosen,") !== -1,
    "the layout is no longer built from the index the capture will be handed:\n" + recBody);
  assert.ok(recBody.indexOf("Qt.callLater(function () { root.captureAfterRecord(layout, chosen) })") !== -1,
    "the capture is no longer handed the index the layout was built from:\n" + recBody);

  // And the capture NEVER builds one. A refusal, not a recomputation — building
  // one there is precisely the second opinion.
  const capAt = source.indexOf("function captureAfterRecord(layout, chosen) {");
  assert.ok(capAt !== -1, "captureAfterRecord no longer takes the index");
  const capBody = source.slice(capAt, source.indexOf("\n  }\n", capAt));
  assert.strictEqual(capBody.indexOf("chosenWindows"), -1,
    "captureAfterRecord computes the index again:\n" + capBody);
  assert.ok(capBody.indexOf("if (!chosen)") !== -1,
    "a recording with no index silently gets a guessed one:\n" + capBody);

  // THE COMMENT IS PART OF THE CONTRACT. The old one asserted the two
  // computations were "the same index buildLayout numbered the occurrences
  // with, computed from the same clients and monitors", which was false — and
  // this codebase treats a false comment as a defect in itself.
  const comment = source.slice(source.indexOf("// Take the pictures the layout just committed"), capAt);
  assert.strictEqual(comment.indexOf("would be a second opinion"), -1,
    "the comment still claims a second match here would merely be a second opinion");
  assert.ok(comment.indexOf("HANDED IN") !== -1, comment);
});

test("the map stops drawing a picture the switch has turned off (tick sp7)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const map = fs.readFileSync(path.join(__dirname, "..", "MapWorkspace.qml"), "utf8");

  // A `find` is a process and the listing that follows it is another, so
  // `captureStore.has()` goes on answering yes for the frames in between. The
  // gate is the SWITCH, which is written synchronously — so the photograph stops
  // being drawn in the same instant it goes off, and the delete is what makes
  // that true on disk as well.
  const at = source.indexOf("function captureFileFor(identityId, occurrence) {");
  const body = source.slice(at, source.indexOf("\n  }\n", at));
  const gate = body.indexOf("if (!root.picturesOn) return \"\"");
  assert.ok(gate !== -1,
    "the chip's capture is not gated on the switch, so a picture keeps rendering after"
    + " the pictures are turned off:\n" + body);
  assert.ok(gate < body.indexOf("captureStore.hasIn("),
    "the listing is consulted before the switch is:\n" + body);

  // ONE gate, in the funnel both readers go through — the chip's Image and the
  // panelState payload. A second copy in MapWorkspace's Image would let
  // `captureSource` (which the payload reports as BOUND) name a picture the
  // chip is not drawing.
  //
  // Since tick 2zi the Image binds `pictureSource`, which is the UNION of the
  // recorded source and the live one — declared in the delegate, from the two
  // reported properties themselves, so it still cannot be a second derivation of
  // either gate. The assertion that matters is unchanged: no picture question is
  // asked inside the Image.
  const image = map.slice(map.indexOf("Image {\n                id: chipCapture"),
    map.indexOf("// THE VEIL"));
  assert.ok(image.indexOf("source: chipTab.pictureSource") !== -1, image);
  assert.strictEqual(image.indexOf("picturesOn"), -1,
    "the Image reads the switch a second time, so the reported source and the drawn one can differ");

  // And `pictureSource` is exactly the two reported properties and nothing else.
  const union = map.slice(map.indexOf("readonly property string pictureSource:"));
  const unionBody = union.slice(0, union.indexOf("\n\n"));
  assert.ok(unionBody.indexOf("chipTab.captureSource") !== -1
    && unionBody.indexOf("chipTab.liveSource") !== -1, unionBody);
  assert.strictEqual(unionBody.indexOf("panel."), -1,
    "the drawn source reaches past the two reported properties to ask the panel again:\n" + unionBody);
});

// ---------------------------------------------------------------------------
// The Recorded map draws its captures (tick vbh)
// ---------------------------------------------------------------------------
//
// The rendering itself cannot be proven here — no scene graph, no pixels. What
// CAN be proven, and is exactly what would break silently, is the STRUCTURE the
// rendering depends on: where the capture sits relative to the veil and the
// content, that it is not a member of the Column that lays the name out, and
// that it draws nothing until it is ready. The VM's IpcHandler assertions carry
// the rest.

test("the capture is the chip's GROUND: before the veil, before the content", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "MapWorkspace.qml"), "utf8");

  const capture = source.indexOf("id: chipCapture");
  const veil = source.indexOf("visible: chipTab.treatment === \"veiled\"");
  const content = source.indexOf("id: chipContent");
  assert.ok(capture !== -1, "the capture Image is gone");
  assert.ok(veil !== -1 && content !== -1);

  // QML paints siblings in document order, so this IS the layer order: the
  // picture underneath, the veil quietening it, the icon and the name on top.
  // Reordering these three is a visual change with no other symptom.
  assert.ok(capture < veil, "the veil is painted under the capture, so it quietens nothing");
  assert.ok(veil < content, "the veil is painted over the icon and the name");
});

test("A CAPTURE CANNOT PUSH THE NAME OUT: it is a sibling of the content, not a member", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "MapWorkspace.qml"), "utf8");

  // The Recorded map is entirely the FALLBACK path — 210x17 stacked rows —
  // which is where names came back in tick ajp after a size ladder silently
  // took every one of them away. A capture inside `chipContent` would take a
  // share of the Column's width and could do it again.
  const contentAt = source.indexOf("id: chipContent");
  const captureAt = source.indexOf("id: chipCapture");
  assert.ok(captureAt < contentAt, "the capture is declared inside the content Column");

  // It fills the CHIP, not a slot in a layout.
  const block = source.slice(captureAt, contentAt);
  assert.ok(block.indexOf("anchors.fill: parent") !== -1, block);

  // And the label is still gated on the tiers that carry a name, with nothing
  // about a capture in that condition — the ladder decides the treatment and
  // the capture fills in underneath it.
  const label = source.slice(source.indexOf("id: chipLabel"));
  const visible = label.slice(label.indexOf("visible:"), label.indexOf("visible:") + 60);
  assert.ok(visible.indexOf("chipPill.hasLabel") !== -1, visible);
  assert.strictEqual(visible.indexOf("captureSource"), -1,
    "the label's visibility now depends on whether there is a capture");
});

test("no empty-image flash, and a deleted capture is not an error", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "MapWorkspace.qml"), "utf8");
  const block = source.slice(source.indexOf("id: chipCapture"), source.indexOf("id: chipContent"));

  // Ready and nothing else: a source that is loading, that failed, or that was
  // never set all draw nothing at all, and the chip is what it was before this
  // tick. That one binding is the whole of "falls back to its icon with nothing
  // erroring".
  assert.ok(block.indexOf("visible: chipCapture.status === Image.Ready") !== -1, block);
  // The path does not change when the picture does — a re-record writes a new
  // file at the same name — so the image cache must not answer for it.
  assert.ok(block.indexOf("cache: false") !== -1, block);
});

test("the ladder's cutoffs are exactly what epic c7f ratified — captures did not move them", () => {
  // Restated here rather than imported, for the reason the VM test restates
  // them in jq: a test that asked chipTreatment what chipTreatment thinks would
  // agree with a wrong answer. This is the guard that a tick which fills a
  // picture in UNDER the ladder did not quietly retune it.
  assert.strictEqual(panel.chipTreatment(140, 56), "pill");
  assert.strictEqual(panel.chipTreatment(139, 56), "badge");
  assert.strictEqual(panel.chipTreatment(56, 40), "badge");
  assert.strictEqual(panel.chipTreatment(55, 40), "veiled");
  assert.strictEqual(panel.chipTreatment(210, 17), "strip");
  assert.strictEqual(panel.chipTreatment(24, 16), "veiled");
  assert.strictEqual(panel.chipTreatment(23, 16), "field");
  assert.strictEqual(panel.chipTreatment(24, 15), "field");
});

test("the capture source is a fact about the RECORDED map, and a file URL", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const fn = source.slice(source.indexOf("function captureSourceOf(identityId, occurrence)"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));

  // The Live tab draws the windows that are on screen; a photograph of one laid
  // over the window itself is a staler picture of the same thing.
  assert.ok(body.indexOf("if (!root.showRecorded) return \"\"") !== -1, body);
  // Util.fileUrl, not a hand-built "file://" + path: it percent-encodes each
  // segment, and a home directory with a space in it is the ordinary case that
  // breaks the hand-built one.
  assert.ok(body.indexOf("Util.fileUrl(path)") !== -1, body);

  // And the payload adds both keys only when they have something to say.
  const state = source.slice(source.indexOf("function panelState()"));
  assert.ok(state.indexOf("if (capturePath) chips[chips.length - 1].capturePath = capturePath") !== -1);
  assert.ok(state.indexOf("if (drawnCapture) chips[chips.length - 1].captureSource = drawnCapture") !== -1);
});

// ---------------------------------------------------------------------------
// LIVE PICTURES (tick 2zi) — the Live map draws the windows as they are NOW
// ---------------------------------------------------------------------------
//
// The human's ratified choice, in full (epic tsp): live pictures are held in
// MEMORY ONLY. Photographed when the panel opens, drawn from memory, NEVER
// written to disk, discarded when the panel closes. The parts with a right
// answer are pure and live here; the machinery is QML and is pinned at the
// source, the way every other QML gate in this file is.

// One live desk, as the instance index has it: three watched apps over four
// windows (one of them twice, at two occurrences), plus — by its absence — the
// unwatched window, which has no identity and so is not in the index to plan.
function liveDesk() {
  return {
    instances: {
      byAddress: {
        "0xaa": { identityId: "terminal", occurrence: 0, index: 0, instances: 2 },
        "0xbb": { identityId: "terminal", occurrence: 1, index: 1, instances: 2 },
        "0xcc": { identityId: "browser", occurrence: 0, index: 0, instances: 1 },
        "0xdd": { identityId: "editor", occurrence: 0, index: 0, instances: 1 }
      }
    },
    identities: [
      { id: "terminal" },
      { id: "browser" },
      { id: "editor" }
    ]
  };
}

test("a live plan photographs one window per WATCHED live window, and names no file", () => {
  const desk = liveDesk();
  const plan = panel.liveCapturePlan(desk.instances, desk.identities, true);

  // Ordered by identity, then occurrence: an object's key order is an accident
  // of insertion, and a round that walked two identical desks in two different
  // orders would be a round nothing could pin.
  assert.deepStrictEqual(plan.captures,
    [{ address: "0xcc", identityId: "browser", occurrence: 0 },
     { address: "0xdd", identityId: "editor", occurrence: 0 },
     { address: "0xaa", identityId: "terminal", occurrence: 0 },
     { address: "0xbb", identityId: "terminal", occurrence: 1 }]);

  // NO FILE NAME AND NO PREFIX ANYWHERE IN THE PLAN. This is the whole of
  // "memory only" said in the one place a future author would reach for when
  // adding a cache back: a plan with no name for a picture cannot file one.
  for (const entry of plan.captures) {
    assert.strictEqual(entry.file, undefined,
      "a live capture names a file — the picture is on its way to a disk");
  }
  assert.strictEqual(plan.prefix, undefined);
  assert.strictEqual(plan.topologyKey, undefined);

  // With the pictures on and every window watched, nothing is skipped.
  assert.deepStrictEqual(plan.skipped, []);
});

test("the live plan obeys the same switch Record obeys, by the same rule", () => {
  const desk = liveDesk();

  // OFF: nothing planned, and every window REPORTED so the log can say what the
  // round did not do rather than only what it did.
  const off = panel.liveCapturePlan(desk.instances, desk.identities, false);
  assert.deepStrictEqual(off.captures, []);
  assert.strictEqual(off.skipped.length, 4);
  assert.ok(off.skipped.every((s) => s.reason === "pictures-off"), JSON.stringify(off.skipped));

  // Only the literal false is off — StateModel.picturesOn's rule again.
  for (const junk of [true, undefined, "false", 0, null, {}]) {
    assert.strictEqual(panel.liveCapturePlan(desk.instances, desk.identities, junk)
      .captures.length, 4, JSON.stringify(junk) + " read as off");
  }

  // A window whose identity the file no longer carries is not photographed, and
  // says so — the live half of "a WATCHED app is pictured".
  const fewer = desk.identities.filter((i) => i.id !== "browser");
  const some = panel.liveCapturePlan(desk.instances, fewer, true);
  assert.deepStrictEqual(some.captures.map((c) => c.identityId),
    ["editor", "terminal", "terminal"]);
  assert.deepStrictEqual(some.skipped,
    [{ address: "0xcc", identityId: "browser", occurrence: 0, reason: "not-watched" }]);

  // An app nobody watches is not in the index to be asked at all: the index is
  // built from resolved identities only.
  assert.strictEqual(
    panel.liveCapturePlan(desk.instances, desk.identities, true).captures
      .filter((c) => c.address === "0xee").length, 0);

  // Nothing at all is not a failure — it is a desk with no windows on it.
  assert.deepStrictEqual(panel.liveCapturePlan(null, null, true), { captures: [], skipped: [] });
  assert.deepStrictEqual(
    panel.liveCapturePlan({ byAddress: {} }, desk.identities, true).captures, []);
});

test("the live round's log line says the pictures were never written", () => {
  const desk = liveDesk();
  // The browser unwatched, so the line has a skip to report as well as takes.
  const plan = panel.liveCapturePlan(desk.instances,
    desk.identities.filter((i) => i.id !== "browser"), true);

  const all = plan.captures.map((c) => ({ ok: true, reason: "" }));
  const line = panel.liveCaptureLogLine(plan, all);
  // The one word that matters. A line saying "stored" about these is the first
  // place the memory-only promise starts to blur.
  assert.ok(line.indexOf("held in memory, never written to disk") !== -1, line);
  assert.ok(line.indexOf("3 live picture(s)") === 0, line);
  assert.ok(line.indexOf("1 not pictured") !== -1, line);

  // A FAILURE SAYS WHY — the reasons are the whole diagnostic value of the line.
  const mixed = panel.liveCaptureLogLine(plan,
    [{ ok: true, reason: "" }, { ok: false, reason: "no-frame" },
     { ok: false, reason: "withdrawn" }]);
  assert.ok(mixed.indexOf("2 could not be taken (no-frame, withdrawn)") !== -1, mixed);

  // A round that was abandoned reports the windows it never reached, rather than
  // leaving them out of the arithmetic entirely.
  const short = panel.liveCaptureLogLine(plan, [{ ok: true, reason: "" }]);
  assert.ok(short.indexOf("2 not reached") !== -1, short);
});

test("NOTHING ON THE LIVE PATH CAN WRITE A FILE", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "LiveCaptureStore.qml"), "utf8");

  // THE CONSTRAINT THE WHOLE TICK HANGS ON, and the human chose it over an
  // on-disk cache after being shown both (epic tsp). A picture that never
  // persists has no withdrawal surface, and that absence IS the design — so it
  // is guarded here rather than left to a reviewer noticing a new `saveToFile`.
  const code = store.split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  assert.strictEqual(code.indexOf("saveToFile"), -1,
    "the live store saves a grab to a file — live pictures are memory only");
  assert.strictEqual(code.indexOf("cacheDir"), -1,
    "the live store has a cache directory, which is the first half of a store to evict");
  assert.strictEqual(code.indexOf("Process"), -1,
    "the live store spawns a process — there is nothing on this path for one to do");
  assert.strictEqual(code.indexOf("FileView"), -1, "the live store reads or writes a file");

  // And the URL it publishes is the grab result's own, held alive by a reference
  // — which is the mechanism that makes drawing without writing possible at all.
  assert.ok(code.indexOf("result.url") !== -1, code);
  assert.ok(code.indexOf("result: result") !== -1,
    "nothing holds the grab result, so its url is dangling the moment the callback returns");
});

test("RECORD STAYS AVAILABLE: the dependency between the two rounds runs one way", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "..", "LiveCaptureStore.qml"), "utf8");

  // `captureStore.busy` dims Record (tick ilg) so two rounds cannot interleave.
  // A live round on every panel open sharing that flag would make Record refuse
  // for a moment EVERY time the panel appeared — a new defect, and worse than
  // the one ilg fixed. So `canRecord` must never learn about the live store.
  const at = source.indexOf("readonly property bool canRecord:");
  const canRecord = source.slice(at, source.indexOf("\n\n", at));
  assert.ok(canRecord.indexOf("!captureStore.busy") !== -1, canRecord);
  assert.strictEqual(canRecord.indexOf("liveCaptures"), -1,
    "Record now waits for a live round, which dims it every time the panel opens:\n" + canRecord);

  // The other direction is the whole answer: the live round parks while a
  // recorded one is in flight, so the compositor never holds two capture
  // sessions either.
  assert.ok(source.indexOf("yielding: captureStore.busy") !== -1,
    "the live round does not stand aside for Record");

  // Parking BURNS THE TOKEN. The view being destroyed may already have a
  // grabToImage on the render thread, and its callback must answer for nothing
  // when it lands (tick 070's currency, tick ilg's hazard).
  const park = store.slice(store.indexOf("function _park()"),
    store.indexOf("function _resume()"));
  assert.ok(park.indexOf("liveStore._step = liveStore._step + 1") !== -1, park);
  assert.ok(park.indexOf("destroy()") !== -1, park);
  assert.strictEqual(park.indexOf("_next()"), -1,
    "parking walks the queue on, so a Record and a live grab overlap anyway:\n" + park);

  // And the queue is NOT thrown away, so the window that was standing aside is
  // photographed when the round walks on.
  assert.strictEqual(park.indexOf("_queue = []"), -1, park);
});

test("a chip is never blank: the icon is the fallback, and there is only one of it", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const map = fs.readFileSync(path.join(__dirname, "..", "MapWorkspace.qml"), "utf8");

  // The picture — either kind — draws only when the Image says Ready.
  const image = map.slice(map.indexOf("Image {\n                id: chipCapture"),
    map.indexOf("// THE VEIL"));
  assert.ok(image.indexOf("visible: chipCapture.status === Image.Ready") !== -1, image);

  // AND THE ICON STEPS ASIDE FOR A PICTURE THIS CHIP IS HOLDING, which since
  // tick nlg is `pictureHeld` and not `captureDrawn`. The two differ in exactly
  // one case — a picture being RELOADED — and that case is the blink this is
  // now pinned against: on the recorded map a reload is asynchronous and
  // happens on every re-layout (sourceSize is the chip's drawn size), so
  // `!captureDrawn` brought the icon back on every chip at once for no reason
  // the user could see.
  const icon = map.slice(map.indexOf("id: chipIcon"), map.indexOf("id: chipLabel"));
  assert.ok(icon.indexOf("visible: chipTab.iconSource !== \"\" && !chipTab.pictureHeld") !== -1,
    "the icon no longer steps aside for a picture, or no longer comes back without one:\n" + icon);

  // THE LATCH IS A LATCH, and all three of its edges are here — the whole of
  // "a chip is never blank" now rests on the falling ones. A latch that only
  // ever rises is a chip with no picture and no icon, which is the one state
  // this test's name forbids.
  const tab = map.slice(map.indexOf("readonly property bool captureDrawn:"),
    map.indexOf("Image {\n                id: chipCapture"));
  assert.ok(/property bool pictureHeld:\s*false/.test(tab),
    "the icon's latch is gone, or is no longer a writable property that starts down:\n" + tab);
  assert.ok(/if \(chipTab\.captureDrawn\) chipTab\.pictureHeld = true/.test(tab),
    "nothing raises the latch, so a chip that has drawn a picture still draws its icon over it");
  assert.ok(/if \(chipTab\.pictureSource === ""\) chipTab\.pictureHeld = false/.test(tab),
    "the latch does not come down when the chip has no picture to draw — the"
    + " pictures switched off, an untick, a grab that never landed:\n" + tab);
  assert.ok(image.indexOf("if (chipCapture.status === Image.Error) chipTab.pictureHeld = false") !== -1,
    "the latch does not come down on Image.Error, so a capture deleted under a"
    + " live panel leaves a chip with no picture AND no icon:\n" + image);

  // AND THE PAYLOAD DID NOT MOVE WITH THE ICON. `captureDrawn` is still the
  // Image's own instant, and it is still what gates the two source keys — so
  // `captureSource`/`liveSource` still mean "this chip is DRAWING it"
  // (tests/acceptance/README.md is normative). ONE mechanism for both kinds of
  // picture: it knows nothing about which source it drew.
  const drawn = map.slice(map.indexOf("readonly property bool captureDrawn:"));
  assert.ok(drawn.slice(0, 120).indexOf("chipCapture.status === Image.Ready") !== -1,
    drawn.slice(0, 120));
  assert.ok(map.indexOf("captureSource: chipTab.captureDrawn ? chipTab.captureSource : \"\"") !== -1,
    "the payload's capture source is no longer gated on the chip's own Ready");
  assert.ok(map.indexOf("liveSource: chipTab.captureDrawn ? chipTab.liveSource : \"\"") !== -1,
    "the payload's live source is no longer gated on the chip's own Ready");
  assert.strictEqual(map.indexOf("pictureHeld ? chipTab."), -1,
    "the icon's latch has reached the payload: a reported source would then mean"
    + " \"this chip drew one once\", which is a different sentence");
});

test("the live source is a fact about the LIVE map, keyed by the window address", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const fn = source.slice(source.indexOf("function liveSourceOf(identityId, address)"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));

  // The mirror of captureSourceOf's rule: a picture out of the CACHE is a fact
  // about a recorded layout, and a picture of the window as it is now is a fact
  // about the live one.
  assert.ok(body.indexOf("if (root.showRecorded) return \"\"") !== -1, body);
  // THE SWITCH, in the one funnel both readers go through — the chip's Image
  // and the payload — so a picture stops being drawn in the same frame the flag
  // is written, with no panel reopen and nothing to wait for.
  assert.ok(body.indexOf("if (!root.picturesOn) return \"\"") !== -1, body);
  // The map is PASSED IN, so the binding's dependency is visible at the call
  // site and cannot be tidied away (tick md1).
  assert.ok(body.indexOf("liveCaptures.urlIn(liveCaptures.pictures, address)") !== -1, body);

  // And the pixels go too, at both of the two sites that can drop a live
  // picture: the switch (all of them at once) and an unwatch (one app's).
  const off = source.slice(source.indexOf("function setPictures(on) {"));
  assert.ok(off.slice(0, off.indexOf("\n  }\n")).indexOf("liveCaptures.clear()") !== -1,
    "switching the pictures off leaves the live ones in memory");
  const tick = source.slice(source.indexOf("function toggleChip(chip) {"));
  assert.ok(tick.slice(0, tick.indexOf("\n  }\n")).indexOf("liveCaptures.retain(remaining)") !== -1,
    "unticking an app leaves its live picture in memory");

  // And the payload's two halves: a boolean the panel always states, and the URL
  // the chip reports only once it has drawn it.
  const state = source.slice(source.indexOf("function panelState()"));
  assert.ok(state.indexOf("liveCapture: liveCapture") !== -1, "the payload lost its live claim");
  assert.ok(state.indexOf("if (drawnLive) chips[chips.length - 1].liveSource = drawnLive") !== -1,
    "the live source is reported as \"\" rather than left absent");
});

test("ONE ROUND PER PANEL SESSION, started by the first client list and discarded on close", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  const fn = source.slice(source.indexOf("function startLiveRound()"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  // The latch, and both of its conditions: a panel that is not open has nothing
  // to draw, and a client list arrives a whole process spawn after the panel
  // does — so `opened` alone is too early to plan from.
  assert.ok(body.indexOf("if (!root.opened || !root.haveLiveData) return") !== -1, body);
  assert.ok(body.indexOf("if (root.liveRoundStarted) return") !== -1, body);
  assert.ok(body.indexOf("PanelModel.liveCapturePlan(") !== -1
    && body.indexOf("root.instanceIndex, root.identities, root.picturesOn") !== -1,
    "the plan is derived a second time instead of coming from the index the map is built from,"
    + " or it no longer consults the switch:\n" + body);

  // Both triggers, and QML allows one handler per signal per object — so they
  // are inside the handlers that already exist rather than beside them.
  const opened = source.slice(source.indexOf("onOpenedChanged: {"));
  assert.ok(opened.slice(0, 400).indexOf("root.startLiveRound()") !== -1, opened.slice(0, 400));
  assert.ok(opened.slice(0, 400).indexOf("liveCaptures.clear()") !== -1,
    "the pictures are not discarded when the panel closes");
  assert.ok(opened.slice(0, 400).indexOf("root.liveRoundStarted = false") !== -1,
    "the latch survives a close, so a re-opened panel would draw the previous session's pictures");
  const clients = source.slice(source.indexOf("onLiveClientsChanged: {"));
  assert.ok(clients.slice(0, 900).indexOf("root.startLiveRound()") !== -1, clients.slice(0, 900));
});

test("THE LAST PRECONDITION TO ARRIVE IS A TRIGGER — the one an acceptance VM caught", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // WHAT THIS COST: one acceptance VM cycle, and it left no line in the log to
  // go on. `startLiveRound` is guarded on `opened && haveLiveData` and was
  // triggered by `onOpenedChanged` and `onLiveClientsChanged` — two of its three
  // preconditions. The third is set LAST inside the very handler that fires the
  // second, so on a fresh panel the trigger ran at the one moment the guard
  // could not pass; the latch stayed down, and the panel's own dedupe on the raw
  // client text meant an idle desk never fired it again.
  //
  // This pins the FACT and the REPAIR together, because either alone rots. The
  // fact: the flag is committed after the clients, deliberately — publishing "we
  // have data" before the data is the half-snapshot that pairing exists to
  // prevent. The repair: the flag therefore has to be a trigger too.
  const at = source.indexOf("id: monitorsProc");
  const commit = source.slice(at, source.indexOf("\n  }\n", at));
  const clientsAt = commit.indexOf("root.liveClients = root.pendingClients");
  const flagAt = commit.indexOf("root.haveLiveData = true");
  assert.ok(clientsAt !== -1 && flagAt !== -1, commit);
  assert.ok(clientsAt < flagAt,
    "the snapshot commit order changed; re-read why startLiveRound has three triggers:\n" + commit);

  assert.ok(source.indexOf("onHaveLiveDataChanged: root.startLiveRound()") !== -1,
    "the precondition that lands LAST does not trigger the round it gates");
});

test("A LIVE ROUND IS A BRACKET: it says when it opens and when it closes", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const store = fs.readFileSync(path.join(__dirname, "..", "LiveCaptureStore.qml"), "utf8");

  // THE DIAGNOSIS THAT COULD NOT BE MADE. The first VM run of this feature
  // failed with no line from this file anywhere in a 400-line log, and three
  // different faults produce exactly that silence: a round never started, a
  // round started with an empty plan, and a round that started and stalled. An
  // unclosed bracket is now a stall and a bracket around zero is a desk with
  // nothing to photograph — tick 070's lesson, applied one VM cycle earlier
  // than last time.
  const start = store.slice(store.indexOf("function start(plan) {"),
    store.indexOf("function clear()"));
  assert.ok(start.indexOf("liveStore.log(\"live picture round: \"") !== -1,
    "a live round no longer says it is starting:\n" + start);
  // BEFORE the empty-plan return, or an empty round is silent again — which is
  // the state this repair exists to end.
  assert.ok(start.indexOf("liveStore.log(\"live picture round: \"")
    < start.indexOf("if (liveStore._queue.length === 0)"), start);
  // And a refused round is loud too, though no user pressed anything.
  assert.ok(start.indexOf("liveStore.warn(") !== -1 && start.indexOf("already running") !== -1,
    "a round refused because another is running says nothing:\n" + start);

  // The closing line is UNCONDITIONAL once a round has opened one. Gating it on
  // there being something to report is exactly how an empty round became
  // indistinguishable from a round that never ran.
  const finish = store.slice(store.indexOf("function _finish() {"));
  const body = finish.slice(0, finish.indexOf("\n  }\n"));
  assert.ok(body.indexOf("if (plan) {") !== -1,
    "the round's end line is conditional on more than the round having started:\n" + body);
  assert.ok(body.indexOf("liveCaptureLogLine(plan, results)") !== -1, body);
});

test("the chip's report carries an onXChanged for EVERY property it captures (tick sm1)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const map = fs.readFileSync(path.join(__dirname, "..", "MapWorkspace.qml"), "utf8");

  // THE RULE, MECHANISED. A report site that captures a property with no handler
  // for it reports whatever that property was when some OTHER handler last
  // fired, for ever — the sm1 family of defects, which this increment has paid
  // for twice (`iconResolved` for a whole session; `captureDrawn`, which lands
  // after the source it belongs to). Arguing the exception per property is how
  // the rule stops being checkable, so it is checked.
  // The CHIP's report site, anchored on the call rather than on the function
  // name: `reportRender` is the name of the workspace's site too, and the first
  // match in the file is that one.
  const at = map.indexOf("panel.reportChipRender(");
  const body = map.slice(at, map.indexOf("\n                })", at));

  const captured = new Set();
  for (const m of body.matchAll(/\b(chipTab|chipSlot)\.(\w+)/g)) {
    captured.add(m[1] + "." + m[2]);
  }
  // Not nothing, and not one: a regex that stopped matching would pass silently.
  assert.ok(captured.size > 15, "the report captures " + captured.size + " properties");

  // chipTab's own handlers are `onXChanged:` in the delegate; the slot's reach
  // the chip through the Connections block, as `function onXChanged()`.
  const delegateHandlers = new Set(
    [...map.matchAll(/^\s*on([A-Z]\w*)Changed:/gm)].map((m) => m[1]));
  const connectionsHandlers = new Set(
    [...map.matchAll(/function on([A-Z]\w*)Changed\(\)/g)].map((m) => m[1]));

  const missing = [];
  for (const key of captured) {
    const [owner, property] = key.split(".");
    const handler = property.charAt(0).toUpperCase() + property.slice(1);
    const have = owner === "chipSlot"
      ? connectionsHandlers.has(handler)
      : delegateHandlers.has(handler);
    if (!have) missing.push(key + " (no on" + handler + "Changed)");
  }
  assert.deepStrictEqual(missing.sort(), [],
    "these reported properties have no change handler, so the payload will carry a stale value "
    + "for the whole session:\n  " + missing.join("\n  "));
});

// ---------------------------------------------------------------------------
// The guards stop being whitelists, and the small correctness items (tick md1)
// ---------------------------------------------------------------------------

test("the chip's picture depends on the LISTING, in the call rather than in a dead branch (tick md1)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  // `if (captureStore.generation < 0) return ""` was a branch that can never be
  // true whose only job was to register a binding dependency, and nothing
  // pinned it: a future tidy-up deleting an obviously-dead line would silently
  // stop every chip's picture refreshing after an evict, with no test failure
  // and no visible error.
  const at = source.indexOf("function captureFileFor(identityId, occurrence) {");
  const body = source.slice(at, source.indexOf("\n  }\n", at));
  assert.strictEqual(body.indexOf("generation"), -1,
    "the dead generation branch is back:\n" + body);
  assert.ok(body.indexOf("captureStore.hasIn(captureStore.files, name)") !== -1,
    "the listing is no longer passed in, so the dependency is invisible at the call site:\n" + body);

  // And it cannot be tidied away, because without it there is no listing to
  // look in: `hasIn` takes the set as its first argument.
  assert.ok(store.indexOf("function hasIn(files, name)") !== -1,
    "CaptureStore no longer offers a lookup that takes the listing");
  const hasAt = store.indexOf("function has(name)");
  assert.ok(hasAt !== -1);
  assert.ok(store.slice(hasAt, store.indexOf("\n  }\n", hasAt)).indexOf("store.hasIn(store.files, name)") !== -1,
    "has() is a second lookup rule rather than the same one with the store's own listing");

  // The counter is gone entirely — an unread property is the next thing to be
  // read for the wrong reason.
  assert.strictEqual(store.indexOf("property int generation"), -1,
    "the generation counter is still there, read by nobody");
});

test("the five copies of plugin_state in the acceptance suite are one function (tick md1)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "acceptance");

  // The captures test had drifted into an UNANCHORED regex over the whole line,
  // inferring the state from a substring — and PLUGIN_ID contains a `.`, so the
  // pattern matched more than it meant to. A format change that moved the word
  // "enabled" would have reported `disabled` for an enabled plugin, and the
  // enable step that follows would have chased a phantom.
  const bodies = new Map();
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith("-test.sh")).sort()) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const at = source.indexOf("plugin_state()");
    if (at === -1) continue;
    bodies.set(name, source.slice(at, source.indexOf("\n}\n", at)).replace(/\s+/g, " ").trim());
  }

  assert.ok(bodies.size >= 5,
    "expected at least five acceptance scripts to define plugin_state, found " + bodies.size);
  const spellings = new Set(bodies.values());
  assert.strictEqual(spellings.size, 1,
    "plugin_state is spelled " + spellings.size + " different ways:\n"
    + [...bodies].map(([f, b]) => "  " + f + ": " + b).join("\n"));
  // And the one spelling reads the FIELD, keyed on the whole id.
  assert.match([...spellings][0], /\$1 == id \{ print \$2 \}/,
    "plugin_state no longer reads the state field with an exact id match");
});

test("the state file's writes block, so a record is on disk when it says it is", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

  // The defect this pins (tick m4s) was invisible in every cheaper tier: the
  // acceptance VM recorded a layout, the IPC answered "recorded", and a jq in
  // the very next process found no layout in the file. `setText` schedules an
  // asynchronous job unless the view is told otherwise, and five whole-file
  // rewriters re-read this path SYNCHRONOUSLY through freshState() — one of
  // them, Undo, is by design the next thing that happens after a Record. A
  // write still in flight is a lost recording, silently.
  const view = source.match(/FileView\s*\{[^}]*?id:\s*stateFile[^}]*?\}/s);
  assert.ok(view, "Panel.qml no longer has a FileView with id: stateFile");
  assert.match(view[0], /^\s*blockWrites:\s*true\s*$/m,
    "the state file's FileView does not declare blockWrites: true, so writeState "
    + "can return true before the bytes are on disk");

  // The synchronous re-read is the other half of the pair, and the reason the
  // asynchronous write was dangerous rather than merely untidy. If this ever
  // stops being blocking the hazard changes shape, so it is pinned beside it.
  const reader = source.match(/FileView\s*\{[^}]*?id:\s*stateReader[^}]*?\}/s);
  assert.ok(reader, "Panel.qml no longer has a FileView with id: stateReader");
  assert.match(reader[0], /^\s*blockAllReads:\s*true\s*$/m,
    "freshState's view no longer reads the file synchronously");
});

test("a capture is not written once the pictures have been switched off mid-round", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "CaptureStore.qml"), "utf8");

  // The defect this pins (tick zxg), from the acceptance log verbatim:
  //
  //   recorded 2 apps for topology "… | dr-cap-dock"
  //   unwatched "dr-two" — its stored pictures are deleted, on every desk
  //   dropped every stored picture of 1 app(s), on every desk (unwatched)
  //   1 picture(s) stored, 1 not pictured        <- the round's save, AFTER
  //
  // The pictures deleted, and then an in-flight round wrote one back.
  // `_isCurrentStep` did not catch it and could not: the step WAS still
  // current — the round was healthy, and it was the answer underneath it that
  // had changed. So the save asks again, and it must ask BEFORE it writes.
  const grab = source.match(/grabToImage\(function \(result\) \{[\s\S]*?\n    \}/);
  assert.ok(grab, "CaptureStore.qml no longer has the grab callback");

  const gate = grab[0].indexOf("_stillOwed");
  const write = grab[0].indexOf("saveToFile");
  assert.ok(gate > -1,
    "the grab callback no longer re-asks whether this picture is still owed");
  assert.ok(write > -1, "the grab callback no longer saves");
  assert.ok(gate < write,
    "the question is re-asked AFTER the file is written, which is too late — "
    + "the whole point is that no picture nobody is owed reaches the disk");

  // And the panel must actually supply the predicate, or the store's own
  // default ("no predicate means yes") silently reopens the hole. BOTH stores
  // get one, and each is read as a BODY rather than through a character budget:
  // a `[\s\S]{0,N}` window is a test that fails the day somebody writes a
  // longer comment, which is not a defect, and passes the day somebody moves
  // the guard out of the function, which is.
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
  const predicateBody = (signature) => {
    const at = panel.indexOf(signature);
    assert.ok(at !== -1, "Panel.qml has no " + signature);
    let depth = 0;
    for (let i = panel.indexOf("{", at); i < panel.length; i++) {
      if (panel[i] === "{") depth += 1;
      else if (panel[i] === "}") {
        depth -= 1;
        if (depth === 0) return panel.slice(at, i + 1);
      }
    }
    assert.fail(signature + " is unbalanced");
  };
  const recorded = predicateBody("stillOwed: function (identityId, topologyKey)");
  const live = predicateBody("stillOwed: function (identityId)");

  // THE SWITCH, in both.
  assert.ok(recorded.indexOf("root.picturesOn") !== -1,
    "the recorded store's predicate no longer reads the pictures switch:\n" + recorded);
  assert.ok(live.indexOf("root.picturesOn") !== -1,
    "the live store's predicate no longer reads the pictures switch:\n" + live);
  assert.strictEqual(panel.indexOf("picturedOf("), -1,
    "the per-app camera predicate is back; there is one switch and it is picturesOn");

  // AND WHETHER THE APP IS STILL WATCHED, in both — the question the switch
  // cannot ask, and the one this gate lost when the per-app consent collapsed
  // into a global boolean.
  //
  // WHAT THAT COST, and why it is pinned here rather than argued: the predicate
  // this replaced was built on `StateModel.isPictured`, which answers false for
  // an identity the file no longer carries — so unticking an app mid-round
  // settled the step "withdrawn" as a side effect of how consent was stored.
  // Reading only the switch handed that back: `toggleChip` evicts the app's
  // pictures and a grab already on the render thread writes one after the
  // delete, for an app nobody watches. Consent went global; WATCHING did not.
  assert.ok(recorded.indexOf("StateModel.identityById(root.stateModel, identityId)") !== -1,
    "the recorded store's predicate no longer asks whether the app is still watched, "
    + "so an untick mid-round can still land a picture after the eviction:\n" + recorded);
  assert.ok(live.indexOf("StateModel.identityById(root.stateModel, identityId)") !== -1,
    "the live store's predicate no longer asks whether the app is still watched:\n" + live);

  // AND THE THIRD QUESTION, learned from the gate: a Forget switches nothing
  // off and unticks nobody, so neither question above says no for a layout that
  // no longer exists. The recorded predicate must also ask whether the
  // recording this picture belongs to is still there, and the store must pass
  // it the round's topology key to ask with. (The live one has no third half: a
  // live picture belongs to no recording — and asserting its ABSENCE is what
  // stops the two predicates being quietly conflated.)
  assert.ok(recorded.indexOf("layoutFor(") !== -1,
    "the recorded predicate no longer checks the layout still exists:\n" + recorded);
  assert.strictEqual(live.indexOf("layoutFor("), -1,
    "the live predicate asks about a recording; a live picture belongs to none:\n" + live);
  assert.match(source, /stillOwed\(entry\.identityId,\s*key\)/,
    "CaptureStore no longer passes the round's topology key to the predicate");

  // THE DRAW-TIME HALF OF THE SAME GUARANTEE. The eviction an untick starts is a
  // `find`, and a hand edit that drops an identity starts none at all — so both
  // source functions refuse an identity the file no longer carries, and the
  // recorded map draws no picture for a ghost chip.
  const sourceFn = (name) => {
    const at = panel.indexOf("function " + name);
    assert.ok(at !== -1, "Panel.qml has no " + name);
    return panel.slice(at, panel.indexOf("\n  }\n", at));
  };
  for (const name of ["captureFileFor(identityId, occurrence)", "liveSourceOf(identityId, address)"]) {
    const body = sourceFn(name);
    assert.ok(body.indexOf("root.picturesOn") !== -1, name + " no longer reads the switch:\n" + body);
    assert.ok(body.indexOf("StateModel.identityById(root.stateModel, identityId)") !== -1,
      name + " draws a picture for an app the file no longer carries:\n" + body);
  }

  // AND THE PREDICATE ITSELF ANSWERS, which a grep for a name cannot show. It
  // routes to StateModel.picturesOn, which is pure and testable here.
  const st = require("../StateModel.js");
  const on = st.parseState(JSON.stringify({
    version: 7, pictures: true,
    identities: [{ id: "seen", patterns: ["^foot$"] }], layouts: {}
  })).state;
  const off = st.setPictures(on, false);

  assert.strictEqual(st.picturesOn(on), true, "with the switch on, the picture is owed");
  assert.strictEqual(st.picturesOn(off), false,
    "and the instant it is off nothing is — which is the case this gate exists for");
});

// ---------------------------------------------------------------- tick fe3
// The workspace context: a manual record stores layoutMode and group.active,
// which only happens when the panel hands Engine.buildLayout / driftOf the
// `hyprctl workspaces -j` read. A failed read nulls the context, nothing else.
test("the panel reads hyprctl workspaces and passes the context to record and drift (tick fe3)", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "Panel.qml"), "utf8");
  assert.ok(src.indexOf('command: ["hyprctl", "workspaces", "-j"]') !== -1, "no workspaces read");
  const ctx = "{ workspaces: root.liveWorkspaces, built: null }";
  const recAt = src.indexOf("function recordLayout() {");
  const recBody = src.slice(recAt, src.indexOf("\n  }\n", recAt));
  assert.ok(recBody.indexOf("Engine.buildLayout(") !== -1 && recBody.indexOf(ctx) !== -1,
    "recordLayout does not pass the workspace context");
  const driftAt = src.indexOf("Engine.driftOf(");
  assert.ok(src.slice(driftAt, driftAt + 250).indexOf(ctx) !== -1,
    "driftReport does not pass the workspace context");
  // A failed workspaces read must not become a desktop read failure.
  const procAt = src.indexOf("id: workspacesProc");
  const procBody = src.slice(procAt, src.indexOf("\n  }\n", procAt));
  assert.ok(procBody.indexOf("noteReadFailure") === -1, "a workspaces failure must only null the context");
  assert.ok(procBody.indexOf("root.liveWorkspaces = null") !== -1, "a failed read must null the context");
});

test("the engine records layoutMode when the context carries the workspaces (tick fe3)", () => {
  const clients = [{ address: "0x1", class: "kitty", workspace: { id: 1 }, monitor: 0,
    at: [0, 0], size: [100, 100], floating: false, mapped: true, hidden: false, pid: 1 }];
  const monitors = [{ id: 0, name: "A", description: "A", x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    activeWorkspace: { id: 1 } }];
  const ids = [{ id: "k", name: "k", match: { class: "kitty" } }];
  const withWs = engine.buildLayout(clients, monitors, ids, AT, undefined,
    { workspaces: [{ id: 1, tiledLayout: "scrolling" }], built: null });
  const without = engine.buildLayout(clients, monitors, ids, AT, undefined, { workspaces: null, built: null });
  if (withWs.apps.length) {
    assert.strictEqual(withWs.apps[0].layoutMode, "scrolling");
    assert.strictEqual(without.apps[0].layoutMode, null);
  }
});

test("the three layout-mode refusal words have a tag and a sentence of the panel's own", () => {
  for (const code of [
    engine.TILING_REFUSAL_LAYOUT_SCROLLING,
    engine.TILING_REFUSAL_LAYOUT_FLOATING,
    engine.TILING_REFUSAL_LAYOUT_MODE_DIFFERS
  ]) {
    const tag = panel.refusalTagFor(code);
    assert.ok(tag && tag !== code && tag.length <= 16, code + " tag: " + tag);
    const sentence = panel.refusalSentenceFor(code);
    assert.ok(sentence.length > tag.length && sentence.indexOf(code) === -1, code + ": " + sentence);
    assert.notStrictEqual(sentence, engine.tilingRefusalPhrase(code), code + " borrows the engine's voice");
  }
});

test("shapeLinesFor: one line per unmet shape, and nothing when there are none", () => {
  const empty = { lines: [], summary: "" };
  assert.deepStrictEqual(panel.shapeLinesFor(null), empty);
  assert.deepStrictEqual(panel.shapeLinesFor({}), empty);
  assert.deepStrictEqual(panel.shapeLinesFor({ shapeCount: 0, shapes: [] }), empty);

  const out = panel.shapeLinesFor({ shapeCount: 2, shapes: [
    { workspaceId: 3, monitorDescription: "Samsung Display Corp. ATNA60HR07-0", meanIou: 0.55, reason: "ambiguous-tree" },
    { workspaceId: 12, monitorDescription: "", meanIou: 0.9, reason: null }
  ] });
  assert.strictEqual(out.lines.length, 2);
  assert.ok(out.lines[0].indexOf("workspace 3 on ") === 0, out.lines[0]);
  assert.ok(out.lines[0].indexOf(": 0.55 of its recorded shape - ") !== -1, out.lines[0]);
  assert.ok(out.lines[0].endsWith(panel.refusalSentenceFor("ambiguous-tree")), out.lines[0]);
  assert.strictEqual(out.lines[1], "workspace 12: 0.90 of its recorded shape - not yet in that shape");
  assert.ok(out.summary.indexOf("2 workspaces") !== -1 && out.summary.indexOf("3 (shape unclear)") !== -1, out.summary);
  assert.strictEqual(out.summary.indexOf("\n"), -1);
});

test("the bar tooltip and badge tooltip carry the shape summary only when there is one", () => {
  const withShape = statusOf({ recorded: true, shapeCount: 1,
    shapes: [{ workspaceId: 3, monitorDescription: "M", meanIou: 0.5, reason: "layout-floating" }] });
  assert.strictEqual(state.glyphState(withShape), "drifted");
  const tip = panel.barGlyphTooltip("drifted", withShape, "Desk");
  assert.ok(tip.indexOf("\n") !== -1 && tip.indexOf("3 (floating layout)") !== -1, tip);
  assert.ok(panel.badgeTooltip("drifted", withShape).indexOf("tile shape") !== -1);
  // today's wording, untouched, with no shapes
  assert.strictEqual(panel.barGlyphTooltip("drifted", statusOf({ recorded: true, driftCount: 2 }), "Desk"),
    "Desk — drifted (2)");
});

test("shapeLinesFor: a null reason never promises a restore will fix it", () => {
  const out = panel.shapeLinesFor({ shapeCount: 1, shapes: [
    { workspaceId: 12, monitorDescription: "", meanIou: 0.9, reason: null }
  ] });
  assert.ok(out.lines[0].indexOf("restore") === -1, out.lines[0]);
  assert.ok(out.summary.indexOf("restore") === -1, out.summary);
  assert.ok(out.summary.indexOf("12 (shape differs)") !== -1, out.summary);
});

test("v2p: the badge tooltip says the shapes too when apps have drifted as well", () => {
  const both = statusOf({ recorded: true, driftCount: 2, shapeCount: 1,
    shapes: [{ workspaceId: 3, monitorDescription: "M", meanIou: 0.5, reason: null }] });
  assert.strictEqual(state.glyphState(both), "drifted");
  const tip = panel.badgeTooltip("drifted", both);
  assert.ok(tip.indexOf("2 apps are") === 0, tip);
  assert.ok(tip.indexOf("tile shape") !== -1, "the shapes are not hidden behind the count: " + tip);
  // Drift alone keeps today's sentence, word for word.
  assert.strictEqual(panel.badgeTooltip("drifted", statusOf({ recorded: true, driftCount: 1 })),
    "1 app is not where the recording puts them. Restore now moves them back; Record layout files where they are instead.");
});
