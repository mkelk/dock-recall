// PanelModel — the panel's view-model, and the record round trip it drives.
// Source of truth: docs/thoughts/2026-08-15-ux-sketch.md (panel anatomy,
// interaction rules) and the schema blocks in StateModel.js.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const panel = require("../PanelModel.js");
const { loadFixture, makeClient, IDENTITIES } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const LAPTOP_KEY = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

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
  const identity = panel.suggestIdentity("foot", []);
  const client = makeClient({ class: "foot" });
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
  assert.strictEqual(panel.suggestIdentity("foot", []).launch, "");
});

test("ticking something already watched is a no-op, not a duplicate", () => {
  const existing = [{ id: "terminal", patterns: ["^foot$"], launch: "foot" }];
  assert.strictEqual(panel.suggestIdentity("foot", existing), null);
});

// ------------------------------------------------------------ toggle watched

test("ticking an unwatched class prepends an identity for it", () => {
  const before = [{ id: "browser", patterns: ["^chromium$"], launch: "" }];
  const after = panel.toggleWatchedIdentities(before, "foot", "");
  assert.strictEqual(after.length, 2);
  // Front, not back: the list is priority order and matchClient takes the
  // first match, so the specific thing just ticked must not sit behind a
  // catch-all added earlier.
  assert.strictEqual(after[0].id, "foot");
  assert.deepStrictEqual(after[0].patterns, ["^foot$"]);
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
  const ticked = panel.toggleWatchedIdentities(before, "foot", "");
  const unticked = panel.toggleWatchedIdentities(ticked, "foot", "foot");
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
  assert.deepStrictEqual(round.state.identities, [
    { id: "obsidian", patterns: ["^md\\.obsidian\\.Obsidian$"], launch: "" }
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
  assert.strictEqual(panel.launchLooksBroken("/usr/bin/foot --app-id=herdr herdr"), false);
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
  const derived = panel.deriveLaunchMap(requests, REAL_DESKTOP_FILES, {});
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

  assert.deepStrictEqual(panel.deriveLaunchMap(requests, DESKTOP_FILES, windowsByPid), {
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
    panel.deriveLaunchMap(requests, DESKTOP_FILES, panel.windowCountByPid(clients)),
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
    panel.deriveLaunchMap(requests, DESKTOP_FILES, panel.windowCountByPid(clients)),
    { terminal: "foot" });

  // And the single-window case is untouched: one pid, one window, so the
  // hand-tuned flags the user actually started it with are still learned.
  const alone = [{ address: "0xa", class: "foot", pid: 700 }];
  const flags = [{
    identityId: "terminal", patterns: ["^foot$"], className: "foot",
    pid: "700", argv: ["foot", "--working-directory", "/home/u/My Notes"]
  }];
  assert.deepStrictEqual(
    panel.deriveLaunchMap(flags, DESKTOP_FILES, panel.windowCountByPid(alone)),
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

  const derived = panel.deriveLaunchMap(requests, REAL_DESKTOP_FILES, panel.windowCountByPid(clients));
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

test("the map is ordered left to right, not by hyprctl's connection order", () => {
  const monitors = [
    { id: 5, name: "DP-2", x: 1440, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 0, name: "eDP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 }
  ];
  const map = panel.mapGeometry(monitors, 400, 200);
  assert.deepStrictEqual(map.monitors.map((m) => m.name), ["eDP-1", "DP-2"]);
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

test("a chip too narrow for a label loses the label, not the tooltip", () => {
  assert.strictEqual(panel.chipLabelVisible(20), false);
  assert.strictEqual(panel.chipLabelVisible(40), true);
  assert.strictEqual(panel.chipLabelVisible(NaN), false);
  // A fused tab group divides its pill: three tabs in a 90 px slot get 30 each.
  assert.strictEqual(panel.chipLabelVisible(90 / 3), false);
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
  const unwatchedRows = panel.appRows(clients, monitors, resolver([]), null, null, []);
  const retickd = panel.toggleWatchedIdentities([], unwatchedRows[0].className, unwatchedRows[0].identityId);
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
  assert.deepStrictEqual(lines, ["Terminal", "foot", "eDP-1 · ws 1"]);

  // A ghost row has no class at all, and simply says less rather than leaving a
  // hole where the class line would be.
  const ghost = {
    key: "slack", identityId: "slack", className: "", linkKey: "id:slack", name: "Slack",
    position: "DP-2 · ws 4 · not running", drifted: false, driftTo: "", mismatch: ""
  };
  assert.deepStrictEqual(panel.rowTooltipText(ghost), "Slack\nDP-2 · ws 4 · not running");
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

test("Record says why it is unavailable while a restore is in flight", () => {
  assert.strictEqual(panel.recordBlockedHint(false), "");
  const hint = panel.recordBlockedHint(true);
  assert.ok(hint.indexOf("Record") !== -1 && hint.length > 0, hint);
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

test("record writes a layout the service reads back unchanged", () => {
  const identities = panel.toggleWatchedIdentities(
    panel.toggleWatchedIdentities([], "chromium", ""), "foot", "");
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
  // no-op, which is what makes the badge flip to "In sync" straight after.
  assert.strictEqual(
    engine.planRestore(clientsLaptop, monitorsLaptop, stored, state.identities(round.state)).length, 0);
});

test("recording again overwrites this topology and leaves the others alone", () => {
  const identities = panel.toggleWatchedIdentities([], "foot", "");
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
// The other side of the README's app-id rule. `herdr` typed into `foot` owns no
// window: the window is class `foot` and its cmdline is `foot`. The app is the
// terminal's child process, and reading it turns that into the very command the
// README asks the user to bind by hand.

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

test("one unambiguous child derives the app-id command the README asks for", () => {
  const derived = footDerivation([{ pid: 901, argv: ["herdr"] }]);
  assert.deepStrictEqual(derived.commands, { terminal: "foot --app-id=herdr herdr" });
  assert.deepStrictEqual(derived.refusals, {});

  // The child's own arguments travel with it, quoted.
  assert.deepStrictEqual(
    footDerivation([{ pid: 901, argv: ["/usr/bin/herdr", "--watch", "/home/u/My Notes"] }]).commands,
    { terminal: "foot --app-id=herdr /usr/bin/herdr --watch '/home/u/My Notes'" });
});

test("a bare shell between the terminal and the app is looked THROUGH", () => {
  const derived = footDerivation([
    { pid: 901, argv: ["-bash"], children: [{ pid: 902, argv: ["herdr"] }] }
  ]);
  assert.deepStrictEqual(derived.commands, { terminal: "foot --app-id=herdr herdr" });
  assert.deepStrictEqual(derived.refusals, {});

  // Every shell spelling, login form included.
  for (const shell of ["sh", "/bin/bash", "zsh", "-zsh", "/usr/bin/fish"]) {
    assert.deepStrictEqual(
      footDerivation([{ pid: 901, argv: [shell], children: [{ pid: 902, argv: ["btop"] }] }]).commands,
      { terminal: "foot --app-id=btop btop" }, shell);
  }

  // A shell WITH a command of its own is not a bare wrapper: it names what to
  // run, and deriving through it would throw that away.
  assert.deepStrictEqual(
    footDerivation([{ pid: 901, argv: ["bash", "-c", "herdr --watch"] }]).commands,
    { terminal: "foot --app-id=bash bash -c 'herdr --watch'" });
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

test("a refusal says 'ambiguous' and points at the app-id convention", () => {
  const identities = [{ id: "terminal", patterns: ["^foot$"], launch: "" }];
  const refused = footDerivation([{ pid: 901, argv: ["herdr"] }, { pid: 902, argv: ["btop"] }]);

  const states = panel.launchStateIndex(identities, refused.commands, refused.refusals);
  assert.strictEqual(states.terminal, "ambiguous");
  assert.strictEqual(panel.launchHintFor("ambiguous"),
    "runs in a terminal — give it its own --app-id");

  // It reaches the row, through the plumbing the other launch states use.
  const rows = panel.appRows(ONE_FOOT_WINDOW.map((c) => makeClient({ address: c.address, class: c.class, workspace: 1 })),
    ONE_MONITOR, resolver(identities), null, null, identities, refused.commands, null, null, refused.refusals);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].launchState, "ambiguous");
  assert.strictEqual(rows[0].launchHint, "runs in a terminal — give it its own --app-id");
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
  // `foot --app-id=herdr herdr` derives the ordinary way — the cmdline IS the
  // answer — and the child read must not second-guess it.
  const tree = panel.procTreeFromDump(procDump([
    { pid: 900, argv: ["foot", "--app-id=herdr", "herdr"], children: [{ pid: 901, argv: ["herdr"] }] }
  ]));
  const derived = panel.launchDerivation([{
    identityId: "herdr", patterns: ["^herdr$"], className: "herdr",
    pid: "900", argv: ["foot", "--app-id=herdr", "herdr"]
  }], DESKTOP_FILES, { "900": 1 }, tree);
  assert.deepStrictEqual(derived.commands, { herdr: "foot --app-id=herdr herdr" });
  assert.deepStrictEqual(derived.refusals, {});
});

test("each terminal derives with the flag it actually understands", () => {
  assert.strictEqual(panel.terminalClassFlag("foot"), "--app-id");
  assert.strictEqual(panel.terminalClassFlag("footclient"), "--app-id");
  // Alacritty has NO --app-id. Verified against Alacritty 0.17.0: the flag is
  // --class, and this pin used to claim the opposite.
  assert.strictEqual(panel.terminalClassFlag("Alacritty"), "--class");
  assert.strictEqual(panel.terminalClassFlag("kitty"), "--class");
  assert.strictEqual(panel.terminalClassFlag("com.mitchellh.ghostty"), "--class");

  // The other half of the shape: who needs `-e` before the hosted command.
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
    { terminal: "kitty --class=herdr herdr" });
});

test("every terminal derives a command shaped the way that terminal can run", () => {
  // The blocker this test exists for: the derived command is written into
  // state and re-run, unread, at the next restore. `alacritty --app-id=top top`
  // is not merely the wrong flag — Alacritty has no such flag AND rejects a
  // bare trailing command, so the line could never have started anything.
  //
  // One exact string per terminal, with a sample child argv that carries an
  // argument of its own so the tail placement is visible.
  const shapes = [
    ["foot", "foot", "foot --app-id=top top -d 2"],
    ["footclient", "footclient", "footclient --app-id=top top -d 2"],
    ["kitty", "kitty", "kitty --class=top top -d 2"],
    // Verified locally against Alacritty 0.17.0.
    ["Alacritty", "alacritty", "alacritty --class=top -e top -d 2"],
    // Per upstream docs; unverified locally.
    ["com.mitchellh.ghostty", "ghostty", "ghostty --class=top -e top -d 2"]
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

test("the two actions are about THIS desk, and say why they are unavailable", () => {
  const model = panel.overflowMenuModel(
    [layoutRow(LAPTOP_KEY, 3)], LAPTOP_KEY, monitorsLaptop, true, "Laptop");
  assert.deepStrictEqual(panel.menuActionIds(model.actions), ["forget", "rerecord"]);

  const forget = panel.menuAction(model.actions, "forget");
  assert.strictEqual(forget.label, "Forget this layout");
  assert.strictEqual(forget.enabled, true);
  assert.ok(forget.tooltip.indexOf("Laptop") !== -1, forget.tooltip);
  // No "are you sure": the panel never blocks, so the tooltip promises the undo.
  assert.ok(forget.tooltip.indexOf("undo") !== -1, forget.tooltip);
  assert.ok(panel.menuAction(model.actions, "rerecord").enabled);

  // Nothing recorded here: Forget stays visible and explains itself.
  const cold = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, false, "Laptop");
  assert.strictEqual(panel.menuAction(cold.actions, "forget").enabled, false);
  assert.ok(panel.menuAction(cold.actions, "forget").tooltip.indexOf("nothing to forget") !== -1);
  assert.strictEqual(panel.menuAction(cold.actions, "rerecord").enabled, false);

  // A topology with no name at all still gets sentences about "this setup".
  const nameless = panel.overflowMenuModel([], "", [], false, "");
  assert.ok(panel.menuAction(nameless.actions, "forget").tooltip.indexOf("this setup") !== -1);
  assert.strictEqual(panel.menuAction(nameless.actions, "nope"), null);
});

test("the keyboard cursor lands on something pressable, and walks the actions", () => {
  const warm = panel.overflowMenuModel(
    [layoutRow(LAPTOP_KEY, 3)], LAPTOP_KEY, monitorsLaptop, true, "Laptop");
  assert.strictEqual(panel.firstEnabledActionId(warm.actions), "forget");

  // Nothing to forget: the cursor skips to the action that can be pressed.
  const noLayout = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, true, "Laptop");
  assert.strictEqual(panel.firstEnabledActionId(noLayout.actions), "rerecord");

  // Everything disabled: the cursor still has to be somewhere.
  const frozen = panel.overflowMenuModel([], LAPTOP_KEY, monitorsLaptop, false, "Laptop");
  assert.strictEqual(panel.firstEnabledActionId(frozen.actions), "forget");
  assert.strictEqual(panel.firstEnabledActionId([]), "");

  // Arrows walk the same wrap-around walker the panel sections use.
  const ids = panel.menuActionIds(warm.actions);
  assert.strictEqual(panel.nextSection(ids, "forget", 1), "rerecord");
  assert.strictEqual(panel.nextSection(ids, "rerecord", 1), "forget");
  assert.strictEqual(panel.nextSection(ids, "forget", -1), "rerecord");
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
