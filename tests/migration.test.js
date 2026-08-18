// The monitor-watch → dock-recall rename migration (v0.2.0).
//
// The migration is a bash snippet inside Service.qml's ensureStateDirProc —
// QML, so node cannot run the Process. What node CAN do is run the exact
// snippet the service ships: this file extracts the `bash -c` string out of
// Service.qml verbatim (concatenated QML string literals and all) and
// exercises it against a temp directory. If the snippet in Service.qml
// changes, these tests run the changed snippet — there is no second copy of
// the logic to fall out of sync.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------- extraction

function migrationSnippet() {
  const qml = fs.readFileSync(path.join(__dirname, "..", "Service.qml"), "utf8");
  // Anchor on the Process id (other Processes in the file also run bash -c),
  // then capture everything between the "-c" argument and the "--" separator:
  // a series of QML string literals joined with `+`.
  const m = qml.match(
    /id:\s*ensureStateDirProc[\s\S]*?command:\s*\[\s*"bash",\s*"-c",([\s\S]*?)"--",\s*root\.stateDir,\s*root\.triggerPath\s*\]/
  );
  assert.ok(m, "ensureStateDirProc bash command not found in Service.qml");
  const literals = m[1].match(/"(?:[^"\\]|\\.)*"/g);
  assert.ok(literals && literals.length > 0, "no string literals in the bash command");
  // Each literal is valid JSON (QML escapes match), so JSON.parse unescapes it.
  return literals.map((l) => JSON.parse(l)).join("");
}

function runSnippet(stateDir, triggerPath) {
  return execFileSync("bash", ["-c", migrationSnippet(), "--", stateDir, triggerPath], {
    encoding: "utf8",
  });
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dock-recall-migration-"));
}

const OLD_STATE = '{"version":3,"identities":{},"layouts":{"k":{}}}';
const OLD_STATUS = '{"topologyKey":"k"}';

function plantOldFiles(dir) {
  fs.writeFileSync(path.join(dir, "monitor-watch.json"), OLD_STATE);
  fs.writeFileSync(path.join(dir, "monitor-watch.status.json"), OLD_STATUS);
  fs.mkdirSync(path.join(dir, "monitor-watch-forensics"));
  fs.writeFileSync(path.join(dir, "monitor-watch-forensics", "a.json"), "{}");
}

// --------------------------------------------------------------------- tests

test("old files present, new absent: everything moves, bytes untouched", () => {
  const dir = freshDir();
  plantOldFiles(dir);
  const out = runSnippet(dir, path.join(dir, "dock-recall.trigger"));

  assert.match(out, /migrated/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "dock-recall.json"), "utf8"), OLD_STATE);
  assert.strictEqual(fs.readFileSync(path.join(dir, "dock-recall.status.json"), "utf8"), OLD_STATUS);
  assert.ok(fs.existsSync(path.join(dir, "dock-recall-forensics", "a.json")));
  assert.ok(!fs.existsSync(path.join(dir, "monitor-watch.json")));
  assert.ok(!fs.existsSync(path.join(dir, "monitor-watch.status.json")));
  assert.ok(!fs.existsSync(path.join(dir, "monitor-watch-forensics")));
  assert.ok(fs.existsSync(path.join(dir, "dock-recall.trigger")), "trigger is touched");
});

test("new file already exists: old files are never clobbered or removed", () => {
  const dir = freshDir();
  plantOldFiles(dir);
  fs.writeFileSync(path.join(dir, "dock-recall.json"), '{"version":3,"new":true}');
  const out = runSnippet(dir, path.join(dir, "dock-recall.trigger"));

  assert.doesNotMatch(out, /migrated/);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, "dock-recall.json"), "utf8"),
    '{"version":3,"new":true}'
  );
  assert.strictEqual(fs.readFileSync(path.join(dir, "monitor-watch.json"), "utf8"), OLD_STATE);
});

test("state only, no status and no forensics: still migrates", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "monitor-watch.json"), OLD_STATE);
  const out = runSnippet(dir, path.join(dir, "dock-recall.trigger"));

  assert.match(out, /migrated/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "dock-recall.json"), "utf8"), OLD_STATE);
  assert.ok(!fs.existsSync(path.join(dir, "dock-recall.status.json")));
});

test("fresh install (nothing at all): creates dir + trigger, prints nothing", () => {
  const base = freshDir();
  const dir = path.join(base, "not-yet", "omarchy");
  const out = runSnippet(dir, path.join(dir, "dock-recall.trigger"));

  assert.doesNotMatch(out, /migrated/);
  assert.ok(fs.existsSync(path.join(dir, "dock-recall.trigger")));
  assert.ok(!fs.existsSync(path.join(dir, "dock-recall.json")), "no state invented");
});

test("idempotent: a second run is a silent no-op", () => {
  const dir = freshDir();
  plantOldFiles(dir);
  runSnippet(dir, path.join(dir, "dock-recall.trigger"));
  const again = runSnippet(dir, path.join(dir, "dock-recall.trigger"));

  assert.doesNotMatch(again, /migrated/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "dock-recall.json"), "utf8"), OLD_STATE);
});
