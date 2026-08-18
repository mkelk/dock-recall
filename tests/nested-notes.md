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
