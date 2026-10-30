import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSteroidsConfig } from "../src/config-store.ts";
import { registerSteroidsCommand, runSteroidsCommand, type SteroidsController } from "../src/steroids-command.ts";
import type { SteroidsConfig } from "../src/types.ts";

function harness(hasUI = true) {
  let config: SteroidsConfig = normalizeSteroidsConfig({});
  const notes: string[] = [];
  const ctx = {
    hasUI,
    ui: {
      notify: (message: string) => notes.push(message),
    },
  };
  const controller: SteroidsController = {
    getConfig: () => config,
    setConfig: (next) => { config = normalizeSteroidsConfig(next); },
  };
  const run = (args: string) => runSteroidsCommand(args, ctx as never, controller);
  return { run, notes, get config() { return config; } };
}

test("subcommands switch, save, list and delete profiles", async () => {
  const h = harness();
  await h.run("profile verbose");
  assert.equal(h.config.profile, "verbose");
  await h.run("save");
  assert.equal(h.config.profile, "custom-A");
  await h.run("save mine");
  assert.deepEqual(Object.keys(h.config.customProfiles).sort(), ["custom-A", "mine"]);
  await h.run("list");
  assert.match(h.notes.at(-1)!, /hidden, balanced, verbose, custom-A, mine \(active: mine\)/);
  await h.run("delete custom-A");
  assert.deepEqual(Object.keys(h.config.customProfiles), ["mine"]);
  await h.run("reset");
  assert.equal(h.config.profile, "hidden");
});

test("invalid input is reported without changing config", async () => {
  const h = harness();
  const before = h.config;
  await h.run("profile nope");
  await h.run("delete verbose");
  await h.run("save balanced");
  await h.run("wat");
  assert.equal(h.config, before);
  assert.equal(h.notes.length, 4);
  assert.match(h.notes[0], /Unknown profile "nope"/);
  assert.match(h.notes[3], /^Usage:/);
});

test("show summarizes profile and features; settings window needs the TUI", async () => {
  const h = harness(false);
  await h.run("show");
  assert.equal(h.notes[0], "steroids: display profile: hidden; Background tasks: off, Side chat (/btw): off, Goal mode (/goal): off, Compaction history: off");
  await h.run("");
  assert.match(h.notes[1], /needs the TUI/);
});

test("registers the steroids command", () => {
  const commands: string[] = [];
  registerSteroidsCommand({ registerCommand: (name: string) => commands.push(name) } as never, {} as never);
  assert.deepEqual(commands, ["steroids"]);
});
