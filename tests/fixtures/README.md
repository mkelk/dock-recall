# Layer 1 fixtures

Real `hyprctl` JSON captured on **omarchy-host** (Omarchy 4.0.0.alpha "Quattro",
Hyprland 0.56.2) on 2026-08-15, byte-for-byte as the QML service will read it
(`hyprctl clients -j`, `hyprctl monitors all -j`). They are the input side of
every engine test.

Fixtures are captured, never hand-edited. Where a test needs a shape the live
desktop did not have (drift, a two-window group in isolation), it **derives** a
variant from a fixture in the test file itself, so the real capture stays
authoritative.

## Scenarios

### A. Laptop only — `clients-laptop.json`, `monitors-laptop.json`

The undocked baseline: the built-in panel and nothing else. 1 monitor,
12 clients across workspaces 1, 2, 3, 8, 9, 10.

### B. Laptop + headless — `clients-laptop+headless.json`, `monitors-laptop+headless.json`

The same desktop with a virtual second output up
(`hyprctl output create headless hw-test`, 2 s settle, then
`hyprctl output remove hw-test`). This is the Layer 3 primitive standing in for
a dock event. 2 monitors, the same 12 clients at the same addresses.

Capturing it perturbs the live desktop, so it is done once, briefly, and the
output is removed under a shell `trap` even if capture fails.

### C. The non-adjacent group join — `forensics-nonadjacent-join.json`

Not a raw hyprctl capture but the service's OWN forensics dump
(`~/.local/state/omarchy/monitor-watch-forensics/2026-08-16T06:34:51.393Z.json`,
copied verbatim) of the tick-z0l defect: after a real dock transition, slack
would not join whatsapp's group in any `into_group` direction across three
passes. It carries the raw `clients`/`monitors` reads, the recording, the
identities, the per-op outcomes and the verdicts of the failing cycle — one
self-describing object, so the tests can replay the measurement layer against
exactly what the service saw. The load-bearing traps inside: whatsapp's
`grouped: [itself]` solo-group residue, and the tiling geometry (a full
obsidian column between slack and whatsapp) that live replay proved is what
gates `into_group`.

### D. A schema-v1 state file — `state-v1.json`

Not a hyprctl capture and not the user's data: the SHAPE of the real
`~/.local/state/omarchy/monitor-watch.json` as it stood before schema v2
(9 identities with launch commands, two topologies — one single-monitor, one
two-monitor key joined with `" | "` — a four-app group on one and a three-app
group on the other, and one app recorded on the *other* monitor of the docked
pair), with every name, URL and serial replaced by an invented one. The point
is the shape, so the migration test exercises a realistic file rather than a
two-line toy; the user's actual recordings never enter the repo.

Deliberate v1 traps inside: no `at`/`size` anywhere (that IS v1), no `paused`
key, a floating app, and an identity with `launch: ""` (the "never launch this
one" contract). Do not add geometry to this file — its whole job is to be the
older schema.

### E. A titled terminal beside a plain one — `clients-titled-terminal.json`

The window a `--title` launch actually produces, next to the window a bare
terminal produces. Two `foot` clients on one workspace:

| | `class` | `initialTitle` | `title` | what it is |
|---|---|---|---|---|
| `0x55c6f81a2500` | `foot` | `foot` | `user@host:~/git/dock-recall` | a plain terminal at a prompt |
| `0x55c6f73e6d80` | `foot` | `herdr` | `herdr — 3 lists, 41 items` | `foot --title=herdr herdr` |

Synthesized rather than captured (tick hqa) — every `foot` client in
`clients-laptop.json` carries `initialTitle: "foot"`, so no real capture had
the shape — but synthesized from the fields hyprctl really reports, and it is
the ONLY fixture where the class cannot tell two windows apart.

The traps it exists for:

- **The class is untouched.** Both windows are `class: "foot"`,
  `initialClass: "foot"`. That is the whole `--title` convention: every
  class-matched Omarchy window rule still applies to the titled window.
- **`title` drifts, `initialTitle` does not.** The titled window renamed itself
  the instant it started, so `title` and `initialTitle` disagree. Matching reads
  `initialTitle` only — a live title would make a window's identity
  time-varying.
- **Title is the only discriminator.** `{"patterns":["^foot$"],
  "titlePatterns":["^herdr$"]}` claims one of these two and a bare
  `{"patterns":["^foot$"]}` claims both, which is what the AND rule and the
  first-match ordering are for.

**Not in `helpers.js` `FIXTURE_NAMES`, on purpose.** That list is the four
captured layer-1 files, read as clients/monitors PAIRS by `fixtures.test.js`
("all four fixtures") and by the topology tests. This file is synthesized, has
no monitor half, and answers one question; `panel.test.js` loads it by name.
Adding it to the shared list would claim it is a captured desktop and would put
a foot window with a drifted title into twelve tests that never asked for one.

## Traps these fixtures exercise

| Trap | Where it lives | Why it matters |
|---|---|---|
| **Empty `serial` on eDP-1** | both monitor fixtures — `"serial": ""` | A topology key built from serials collides immediately. The key must not read `serial` at all. |
| **Empty `description` on `hw-test`** | `monitors-laptop+headless.json` | Discovered during capture: the headless output has *no* description either. Proves the `description` → `name` fallback is load-bearing, not theoretical. |
| **Monitor is an index, not a name** | every client, `"monitor": 0` | Indices renumber across hotplug. Records must store the monitor *description*, resolved through the monitors JSON. |
| **Obsidian's Quattro class rename** | `class: "md.obsidian.Obsidian"` | The literal `obsidian` no longer matches; one identity has to carry both spellings as patterns. |
| **Chromium webapp synthesized classes** | `chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1`, `chrome-web.whatsapp.com__-Profile_1`, `chrome-mail.google.com__mail_u_0_-Profile_1`, `chrome-calendar.google.com__calendar_u_0_r-Profile_1`, `chrome-www.rememberthemilk.com__app_-Profile_1` | Long, per-profile, per-URL classes. Only prefix/substring patterns survive them. |
| **A real 4-window group, with tab order** | the four clients on workspace 10 | Every member's `grouped` array is identical, and its order **is** the tab order: `md.obsidian.Obsidian` → `org.telegram.desktop` → Slack webapp → WhatsApp webapp. Recording a group means preserving that sequence. |
| **Duplicate windows for one identity** | two `foot` clients (ws 1) and two `chrome-mail.google.com__…` clients (ws 9) | A layout stores one entry per window (schema v3), each carrying an `occurrence` index, so the placement order that assigns those indices has to be deterministic. |
| **Plain unqualified classes** | `chromium`, `code`, `foot` | Not everything is a reverse-DNS or webapp class; patterns must handle bare names too. |

## Recapturing

```bash
hyprctl clients -j       > tests/fixtures/clients-laptop.json
hyprctl monitors all -j  > tests/fixtures/monitors-laptop.json

hyprctl output create headless hw-test   # ALWAYS remove it again, trap-protected
sleep 2
hyprctl clients -j       > tests/fixtures/clients-laptop+headless.json
hyprctl monitors all -j  > tests/fixtures/monitors-laptop+headless.json
hyprctl output remove hw-test
```

Recapturing on a different machine will change classes, addresses and the
topology key, and the assertions in `tests/*.test.js` that name them will need
to follow. Prefer adding a new fixture over rewriting these.
