# Nested Hyprland sandbox — what was actually verified

Run: `tests/nested-focus.sh` (config: `tests/nested.lua`). Machine:
omarchy-host, Hyprland 0.56, Omarchy 4 "Quattro", 2026-08-15.

The service's undock focus failover (`Service.qml`, `checkFocusFailover` /
`evaluateFocusFailover`) only ever runs in the REAL session. The nested run
exists to prove the mechanism it relies on, on a compositor instance that can
be wedged without costing anyone their desktop.

## Verified

1. **A nested Hyprland is a usable sandbox for monitor surgery.**
   `Hyprland -c tests/nested.lua` starts as a window inside the running
   session; the new instance is the newest directory under
   `$XDG_RUNTIME_DIR/hypr`, and `HYPRLAND_INSTANCE_SIGNATURE=<that> hyprctl …`
   drives it in complete isolation. `output create headless` / `output remove`
   work there exactly as in the real session.

2. **`hl.dsp.focus({ monitor = "<name>" })` is accepted and moves focus.**
   Dispatch answers `ok`, and `hyprctl monitors -j` then reports
   `focused: true` on the named output. This is the exact dispatch the failover
   performs, and the key spelling (`monitor`, a bare output NAME rather than a
   direction) is now confirmed rather than inferred — first-party Omarchy only
   ever binds the relative forms `{ monitor = "+1" }` / `{ monitor = "l" }`.

3. **Removing the focused output does not, by itself, strip focus.**
   With `nested-b` focused (and a window on it), `hyprctl output remove
   nested-b` left Hyprland reporting `focused: WAYLAND-1` — the compositor
   re-homed focus onto a survivor on its own. The service's check
   ("does any live monitor claim focus?") therefore correctly does nothing in
   this scenario, which is the behaviour you want: no gratuitous focus jump on
   every undock.

## NOT verified — the concern

**The failover branch never fired**, because the nested sandbox would not
reproduce the focus-lost state. The undock-while-LOCKED freeze this failover
targets is precisely the case where the compositor's own re-homing is believed
to fail (the lock surface holds keyboard focus on an output that is
disappearing), and reproducing it needs a lock screen inside the nested
instance plus a way to observe input while locked — impractical here, and
explicitly out of scope for the tick.

So what is proven is: the DETECTION reads the right thing (`hyprctl monitors
-j`, `focused` flag, active outputs only) and the REPAIR dispatch works. What
is unproven is that the repair is reached in the real freeze, and that it is
sufficient to unfreeze a locked session.

**Tick sug is therefore DONE_WITH_CONCERNS.** Closing the gap needs Layer 5:
lock the real session, undock the physical AOC, and read the `[dock-recall]`
log afterwards for either

    [dock-recall] monitor "<name>" removed; focus intact on "<other>"

or

    [dock-recall] monitor "<name>" removed and took focus with it — failing over to "<other>"
    [dock-recall] focus failover ok

## Incidental finding, worth more than the test

A **hyprlang (`.conf`) config leaves the Lua dispatch layer unloaded**: in an
instance started with a plain `.conf`, every `hyprctl dispatch 'hl.dsp.…'`
answers `Invalid dispatcher`, while `hl.*` config-style dispatches work fine in
the Lua-configured real session. The first version of this sandbox used
`tests/nested.conf` and every dispatch failed for that reason alone — nothing
to do with monitors or focus. Any future nested test of Quattro dispatch verbs
must use a Lua config.

---

# 2026-09-02 — Tier B: the plugin itself, in an invisible nested Hyprland

Run: `tests/sandbox-dock.sh` (config: `tests/nested.lua`). Machine: the dev box,
Hyprland 0.56.2, Omarchy 4 "Quattro", Quickshell from `/usr/bin/qs`.

The 2026-08-15 run above proved the sandbox could host *monitor surgery*. This
one answers the question that mattered: can the PLUGIN run in there — service,
state file, dispatches and all — while the user keeps working, and without the
desktop showing a trace of it.

Yes. Every claim below was measured on this machine on the date given.

## The decision: a stripped `shell.qml`, not a second omarchy-shell

The spike question was "full omarchy-shell second instance, or a minimal qs
config that loads the plugin's entry points?". **Minimal config wins, decisively,
and it also gets Panel.qml** — which was the tie-breaker nobody expected.

The whole sandbox shell is:

    import Quickshell
    import "plugin" as Plugin

    ShellRoot {
      Plugin.Service {}
      Plugin.Panel {}
    }

A second omarchy-shell was never attempted past reading what it would cost: it
owns a bar, a lock surface, ~20 first-party services and the same state
directory the plugin writes, and the nested instance would have to be talked out
of all of it. The plugin's entry points are ordinary QML components. They load
on their own.

`shell` and `manifest` — the two properties omarchy-shell injects — are declared
`property var … : null` in both `Service.qml` and `Panel.qml`, and every read of
them is guarded. Nothing in the sandbox needed either.

## Four mechanics, each of which had to be found

1. **Quickshell blackholes imports that resolve outside the config folder.**
   `qs -p <worktree>/tests/sandbox` with `import "../.."` fails with
   `Module path "…" is outside of the config folder` → `Type Plugin.Service
   unavailable`. The fix is a **symlink inside the config folder**: the config
   root is a mktemp dir containing `plugin -> <worktree>`. Quickshell accepts it,
   and the gate reads the worktree's live files rather than a copy that drifts.

2. **`Panel.qml` loads too**, which node tests can never reach — findings A7–A10
   are QML-side bugs. It imports `qs.Commons` and `qs.Ui`; the `qs.` prefix is
   rooted at the config folder, so `Commons -> $OMARCHY_PATH/shell/Commons` and
   `Ui -> …/Ui` symlinked next to `plugin` resolve them. Loaded clean, no
   warnings, no errors.

3. **The state redirect is `HOME`, not `XDG_STATE_HOME`.** `Service.qml:48-52`
   builds its state dir as `Quickshell.env("HOME") + "/.local/state/omarchy"`.
   Setting only `XDG_STATE_HOME` would have written the user's real file. The
   sandbox launches qs under `env -i` with `HOME` in a mktemp dir (and the
   `XDG_*` vars alongside it so nothing falls back), which also gives the
   isolation footer something exact to assert: after a full run the live
   `~/.local/state/omarchy/dock-recall.json` is byte-identical.

4. **Env goes on the exec, and only there** (learnings § Plugin dev loop). Every
   compositor call the plugin makes is a `hyprctl` subprocess, so
   `HYPRLAND_INSTANCE_SIGNATURE` + `WAYLAND_DISPLAY` on the qs process is the
   entire steering mechanism — no plugin change, no test hook. The nested
   instance signature is the newest directory under `$XDG_RUNTIME_DIR/hypr`
   (as in 2026-08-15); the nested `WAYLAND_DISPLAY` is the `wayland-N` socket
   that appears in `$XDG_RUNTIME_DIR` alongside it.

## Invisibility, and the one thing that leaked

The nested compositor is launched **through the live one**, so the exec can
carry a window rule:

    hyprctl dispatch 'hl.dsp.exec_cmd([[ [workspace special:dr-sandbox silent] … ]])'

A special workspace is not shown unless something toggles it open, and `silent`
keeps the launch from taking focus. Measured during a run: the nested
compositor's window is a live client of class `aquamarine` sitting on
`special:dr-sandbox`, no monitor reports that workspace in `specialWorkspace`,
and `hyprctl activewindow` is the same address before and after. The exec
dispatch is the ONLY thing the run asks of the live instance — no output is
created there, no window is moved.

`hyprctl dispatch exec` reports no pid, so the dispatch runs a two-line wrapper
that writes `$$` and `exec`s Hyprland; that pid is what the trap kills.

**A window on a hidden workspace still gets no frame callbacks, and it did not
matter**: the nested compositor's IPC, its headless outputs and its window
mapping all run off its own event loop. Windows opened inside it map, move and
report normally while nothing is ever drawn.

**What did leak, once:** the cycle-completion toast. `notify-send` finds the
real session bus through `$XDG_RUNTIME_DIR/bus` even under `env -i`, and the
spike put *"Dock Recall — WAYLAND-1 + sbx-test — 1/1 arranged"* on the user's
screen (notification id 5, 18:44). The gate now puts a `notify-send` stub first
on `PATH`; it records the call and delivers nothing. Anything else that talks to
a session-bus daemon needs the same treatment.

`DR_TEST_LOCKED=false` is set for the same reason: `Service.qml`'s lock probe
shells out to `omarchy-shell lock isLocked`, which would be the sandbox's one
question to the live session. The override answers it in-process.

## The one behavioural difference from a real desk, and its fix

A bare nested Hyprland creates workspaces on demand. A used desktop has them
already, so `hl.dsp.workspace.move({ workspace = "9", monitor = "sbx-test" })`
— planned in the same iteration that launches the window — answered
`Workspace not found`, the service logged a `VERB-ERROR`, hit its no-progress
guard, and wrote a forensics dump. It still converged on settle pass 2 (the
workspace existed by then, because the launched window was on it), which is a
decent unplanned proof that the convergence loop does its job. But it is
sandbox-only noise.

The gate now pre-creates workspaces 1–10 in the nested instance:

    hyprctl eval 'hl.workspace_rule({ workspace = "9", persistent = true })'

`hyprctl keyword` is rejected by the Lua parser (learnings), `hl.workspace` does
not exist, and `hl.workspace_rule` is the spelling Omarchy itself writes into
`~/.local/state/omarchy/workspace-layouts/*.lua`. With the workspaces present,
the same run converges on pass 1 with no VERB-ERROR and no forensics dump.

## Where the evidence is

Not `qs log`. A manually exec'd Quickshell writes to
`$XDG_RUNTIME_DIR/quickshell/by-id/<id>/log.qslog`, whose id is not known until
it starts — so the gate simply redirects the process's stderr to
`$SBOX/qs.log`, which carries every `[dock-recall]` line (colour-escaped;
strip with `sed 's/\x1b\[[0-9;]*m//g'`). The sandbox directory is deleted on a
clean pass and **kept, with its path printed, on any failure**; `DR_SANDBOX_KEEP=1`
keeps it either way.

## What this retires

`tests/sim-dock.sh`'s shared-singleton constraint. The Tier B gate runs from any
worktree, in parallel, while the user works. The live gate stays for what only a
real session can answer, and needs the human's go-ahead.

## The case set the gate actually runs

Three, sim-dock's own, unchanged in substance:

1. **LAUNCH** — `output create headless sbx-test` in the nested instance; the
   service launches `foot --app-id=dr-sim` onto ws 9 on that output. The foot
   window opens *inside* the nested compositor, because the launch goes out
   through the sandbox plugin's own dispatch.
2. **SCATTER** — the window is dispatched to ws 1 on the nested instance's other
   output, the trigger file is touched, and it has to come back.
3. **IDEMPOTENCY** — one more trigger: `converged, 0 ops` must go up and
   `pass N iteration M` must not move at all.

Each case waits on the log's `restore cycle done` marker before the next begins,
so no case is ever scored against a queued rerun of its predecessor. Nothing
sleeps-then-asserts. A whole run is about a minute.

Two runs back to back, both `ALL PASS`, exit 0, no orphan Hyprland or Quickshell
process and no leftover sandbox directory. The trap was exercised on a forced
mid-run failure as well: both children died, the dead instance's socket
directory was removed, the exit status was preserved, and the sandbox directory
was kept with its path printed.

---

# 2026-09-02 — Layer 5: undock while genuinely LOCKED, in a VM

Run: `tests/acceptance/run.sh` (host half: `tests/acceptance/undock-locked.sh`,
in-guest setup: `dock-recall-undock-locked-prepare-test.sh`). Guest: Omarchy
4.0.1 from the ISO, Hyprland 0.56, headless QEMU driven over QMP.

This closes the gap the 2026-08-15 section left open. It names the two lines to
look for; the run produced the **first** of them:

    [dock-recall] monitor "dr-lock-dock" removed; focus intact on "Virtual-1"

Focus was parked on `dr-lock-dock` before the lock (`focused: true` on it in the
probe below), the session was locked, and that output was then removed. Hyprland
re-homed focus onto the survivor by itself, exactly as it did unlocked in the
nested run — so the service's check correctly did nothing, and the restore cycle
that followed reported `0 ops`.

**So the repair branch STILL has not fired, and now we know more about why.** It
is not that the nested sandbox was too weak: on Hyprland 0.56 the compositor
re-homes focus on the removal of a focused output *even while an
ext-session-lock is up*. The freeze the failover was written against does not
reproduce on this version. What is now proven is the whole detection path under a
real lock, and that the repair is not needed here; what remains unproven is the
repair dispatch in a real freeze, and there is no longer an obvious way to
produce one.

## The lock was real — and the screen is not how you know

The QMP screendump of the guest's virtio-vga head goes on showing the **desktop**
while the session is locked: bar drawn, clock ticking, the first-run dialog still
on screen. A picture of that frame looks unlocked and would be wrong. Nor does
`hyprctl layers` help — the Quattro lock is an `ext-session-lock` surface, not a
layer, so it appears in no namespace list. Probed while locked:

    --- omarchy-shell lock isLocked ---   true
    --- omarchy-hyprland-session-locked --- exit=0
    --- monitors: solitaryBlockedBy ---
    [{"name":"Virtual-1","focused":false,"solitaryBlockedBy":["LOCK","WINDOWED","CANDIDATE"]},
     {"name":"dr-lock-dock","focused":true,"solitaryBlockedBy":["LOCK","WINDOWED","CANDIDATE"]}]
    --- layer namespaces ---
    ["omarchy-background","omarchy-bar","omarchy-notifications"]

`LOCK` on every monitor is the compositor saying it holds a session lock. The
decisive check, though, is the **wrong-password control**: typing
`definitelynotthepassword` over QMP left `isLocked` at `true`, and the real
password then released it. That is what turns "a lock released" into "an
authenticating password prompt read the emulated keyboard" — and it is the only
one of these signals that could not be produced by anything else.

**Rule for future runs:** never treat a VM screendump as evidence that a session
is locked. Use `omarchy-shell lock isLocked` plus the `LOCK` blocker, and prove
the input path with a wrong password before the right one.
