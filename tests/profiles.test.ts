import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSteroidsConfig } from "../src/config-store.ts";
import {
  applyProfile,
  deleteProfile,
  describeProfile,
  isValidCustomProfileName,
  listProfileNames,
  nextCustomProfileName,
  saveProfile,
} from "../src/profiles.ts";
import { DEFAULT_STEROIDS_CONFIG } from "../src/types.ts";

const base = () => normalizeSteroidsConfig({});

test("defaults are the hidden profile", () => {
  assert.equal(DEFAULT_STEROIDS_CONFIG.profile, "hidden");
  assert.equal(describeProfile(base()), "hidden");
});

test("built-in profiles change display settings but not features or ownership", () => {
  const start = { ...base(), backgroundTasks: true, btwSideChat: true };
  const verbose = applyProfile(start, "verbose");
  assert.equal(verbose.profile, "verbose");
  assert.equal(verbose.readOutputMode, "preview");
  assert.equal(verbose.previewLines, 12);
  assert.equal(verbose.groupToolCalls, false);
  assert.equal(verbose.backgroundTasks, true);
  assert.equal(verbose.btwSideChat, true);

  const hidden = applyProfile(verbose, "hidden");
  assert.equal(hidden.groupToolCalls, true);
  assert.equal(hidden.hideAssistantCommentary, true);
  assert.equal(applyProfile(start, "nope"), start);
});

test("editing a profile marks it modified until saved", () => {
  const edited = { ...applyProfile(base(), "balanced"), previewLines: 3 };
  assert.equal(describeProfile(edited), "balanced (modified)");
  const saved = saveProfile(edited, "custom-A");
  assert.equal(describeProfile(saved), "custom-A");
  assert.equal(saved.customProfiles["custom-A"].previewLines, 3);
  assert.equal(saved.customProfiles["custom-A"].readOutputMode, "summary");
});

test("custom profiles apply, list, and never touch non-display settings", () => {
  const saved = saveProfile({ ...base(), previewLines: 5, backgroundTasks: true }, "custom-A");
  const other = applyProfile({ ...saved, backgroundTasks: false }, "verbose");
  const back = applyProfile(other, "custom-A");
  assert.equal(back.previewLines, 5);
  assert.equal(back.backgroundTasks, false);
  assert.deepEqual(listProfileNames(back), ["hidden", "balanced", "verbose", "custom-A"]);
  assert.equal("backgroundTasks" in back.customProfiles["custom-A"], false);
});

test("names are validated and auto-generated in order", () => {
  assert.equal(isValidCustomProfileName("custom-A"), true);
  for (const bad of ["", "has space", "Hidden", "verbose", "-x", "x".repeat(33)]) {
    assert.equal(isValidCustomProfileName(bad), false, bad);
  }
  assert.throws(() => saveProfile(base(), "balanced"), /reserved/);

  let config = base();
  assert.equal(nextCustomProfileName(config), "custom-A");
  config = saveProfile(config, "custom-A");
  config = saveProfile(config, "custom-B");
  assert.equal(nextCustomProfileName(config), "custom-C");
});

test("deleting the active custom profile falls back to hidden and keeps current settings", () => {
  const saved = saveProfile({ ...base(), previewLines: 6 }, "custom-A");
  const deleted = deleteProfile(saved, "custom-A");
  assert.deepEqual(deleted.customProfiles, {});
  assert.equal(deleted.profile, "hidden");
  assert.equal(deleted.previewLines, 6);
  assert.equal(describeProfile(deleted), "hidden (modified)");
  assert.equal(deleteProfile(deleted, "custom-A"), deleted);
});

test("config normalization sanitizes stored custom profiles", () => {
  const config = normalizeSteroidsConfig({
    profile: "  custom-A ",
    customProfiles: {
      "custom-A": { previewLines: 9999, readOutputMode: "bogus", backgroundTasks: true },
      verbose: { previewLines: 1 },
      "bad name": {},
    },
  });
  assert.equal(config.profile, "custom-A");
  assert.deepEqual(Object.keys(config.customProfiles), ["custom-A"]);
  assert.equal(config.customProfiles["custom-A"].previewLines, 80);
  assert.equal(config.customProfiles["custom-A"].readOutputMode, "hidden");
  assert.equal("backgroundTasks" in config.customProfiles["custom-A"], false);
  assert.deepEqual(normalizeSteroidsConfig(config), config);
});

test("profile lookups ignore inherited object properties", () => {
  const config = base();
  assert.equal(applyProfile(config, "constructor"), config);
  assert.equal(applyProfile(config, "toString"), config);
  assert.equal(deleteProfile(config, "constructor"), config);
  assert.equal(nextCustomProfileName(config), "custom-A");
});
