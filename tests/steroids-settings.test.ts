import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSteroidsConfig } from "../src/config-store.ts";
import { SplitPaneInspectorModal } from "../src/settings-inspector-modal.ts";
import { applySettingChange, buildSettingsItems } from "../src/steroids-settings.ts";
import { applyProfile } from "../src/profiles.ts";

const base = () => normalizeSteroidsConfig({});
const ids = (config = base()) => buildSettingsItems(config).map((item) => item.id);
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;

test("items are grouped into Display then Features", () => {
  const items = buildSettingsItems(base());
  assert.deepEqual(items.map((i) => [i.category, i.id]), [
    ["Display", "profile"],
    ["Display", "save-new"],
    ["Features", "backgroundTasks"],
    ["Features", "btwSideChat"],
    ["Features", "goalMode"],
    ["Features", "compactionHistory"],
  ]);
});

test("a custom active profile offers update and save-new", () => {
  const saved = applySettingChange(base(), "save-new", "new");
  assert.equal(saved.profile, "custom-A");
  assert.deepEqual(ids(saved), ["profile", "save-active", "save-new", "backgroundTasks", "btwSideChat", "goalMode", "compactionHistory"]);
  const [, update, fresh] = buildSettingsItems(saved);
  assert.equal(update.label, "Update custom-A");
  assert.equal(fresh.currentValue, "↵ custom-B");
});

test("changes apply profiles, saves and feature toggles", () => {
  let config = applySettingChange(base(), "profile", "verbose");
  assert.equal(config.profile, "verbose");
  config = applySettingChange({ ...config, previewLines: 3 }, "save-new", "new");
  assert.equal(config.customProfiles["custom-A"].previewLines, 3);
  config = applySettingChange({ ...config, previewLines: 9 }, "save-active", "update");
  assert.equal(config.customProfiles["custom-A"].previewLines, 9);
  config = applySettingChange(config, "backgroundTasks", "on");
  assert.equal(config.backgroundTasks, true);
  assert.equal(applySettingChange(config, "unknown", "x"), config);
});

test("modified profiles keep a cyclable value and flag the label", () => {
  const modified = { ...applyProfile(base(), "balanced"), previewLines: 3 };
  const profile = buildSettingsItems(modified)[0];
  assert.equal(profile.label, "Profile (modified)");
  assert.equal(profile.currentValue, "balanced");
  assert.ok(profile.values?.includes(profile.currentValue));
});

test("overlay renders category headers above their items and cycling a profile fires onChange", () => {
  let config = base();
  const changes: [string, string][] = [];
  const modal = new SplitPaneInspectorModal(
    {
      getSettings: () => buildSettingsItems(config),
      onChange: (id, value) => { changes.push([id, value]); config = applySettingChange(config, id, value); },
      onClose: () => {},
    },
    theme,
  );
  const text = modal.render(110).map(strip).join("\n");
  assert.ok(text.indexOf("Display") < text.indexOf("Profile"));
  assert.ok(text.indexOf("Features") > text.indexOf("Save as new profile"));
  assert.ok(text.indexOf("Features") < text.indexOf("Background tasks"));

  modal.handleInput("\r");
  assert.deepEqual(changes, [["profile", "balanced"]]);
  assert.equal(config.profile, "balanced");
});
