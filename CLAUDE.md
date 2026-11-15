# Working in this repository

This repository **is** the plugin: `omarchy plugin add` clones it and installs
the clone root, so `manifest.json` and the three QML entry points sit at the top
level and everything here ships to a user's `~/.config/omarchy/plugins/`.

Planning, issue tracking, design notes, evidence and benchmark history are kept
outside this repository. Nothing from there belongs here.

## The one architectural rule

`engine.js`, `StateModel.js` and `PanelModel.js` are the brain, and they are
**pure**: ES5 only, dependency-free, clock-free, no I/O. Timestamps and desktop
snapshots are passed in. QML holds only what a pure function cannot — process
launches, file reads, Hyprland dispatch, layout. Anything with a right answer
belongs in a JS module with a test, not in a QML binding.

ES5 because the same files must load in node (`require`) and in Qt QML
(`import "engine.js" as Engine`): no ES module syntax, no `.pragma`, and
`module.exports` stays behind a `typeof module !== "undefined"` guard.

## Gates

The command list is in [README.md](README.md#development) — that is the copy to
keep current. Which ones apply:

- Any change: `node --test 'tests/**/*.test.js'` and `omarchy plugin validate .`
- QML touched: `qmllint`, and a `./scripts/dev-install --restart` before judging
  behaviour — an already-instantiated panel serves stale code after a plain
  hot-reload, and a hot-reloaded **service** runs QML but its `Process` and
  `FileView` never fire.
- Engine or service touched: `./tests/sandbox-dock.sh` — the nested-compositor
  gate. It runs alongside the live session without disturbing it, so it needs
  no permission and no quiet moment. The nested compositor loads Omarchy 4.5's
  own `monitor-workspaces.lua`, so workspace ids follow 4.5's blocks of ten
  (monitor block * 10 + slot); `./tests/sandbox-slots.sh` is the dock/undock/dock
  case on top of it, and `./tests/sandbox-fidelity.sh` is the within-workspace
  gate (tiling tree, tab groups, visible tab, refusals; every case, no argument).
  The plugin targets Omarchy 4.5 and newer. `./tests/sim-dock.sh` is the same cases
  against the real desktop and is **on request only**: ask the human first.
- Before any shell restart: `omarchy-shell lock isLocked` must be `false`. A
  restart kills the lock screen, because `omarchy.lock` runs inside the same
  Quickshell process. If the session looks locked or wedged, stop and report.
- `tests/sim-dock.sh` and anything else that touches the live Hyprland session
  is a shared singleton — never run two of them at once, never from parallel
  worktrees.

## Test fixtures are sanitized

`tests/fixtures/*.json` are real `hyprctl` dumps with the personal data replaced:
window titles, an email address, a Slack workspace and channel id, an Obsidian
vault name, the host name and `/home/<user>` paths. When capturing a fresh dump,
sanitize it the same way **before** committing — grep the diff for an email
address, a hostname, a `T…`/`C…` Slack id and a home directory. The unsanitized
originals are not kept here.

## Refusals are a feature

Where the desktop cannot be read unambiguously — twin identical monitors, a
terminal hosting two candidate children, a tiling tree that differs by more than
one split flip, a workspace in scrolling or floating mode, a special
workspace, a locked session — the plugin refuses out
loud and says why, in the panel. Do not replace a refusal with a guess; if a new
state has no certain answer, add a refusal with its reason and a test that pins
it.
