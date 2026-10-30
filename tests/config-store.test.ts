import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadSteroidsConfig,
  normalizeSteroidsConfig,
  saveSteroidsConfig,
} from "../src/config-store.ts";
import { DEFAULT_STEROIDS_CONFIG } from "../src/types.ts";

function withTempDir(name: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config normalization clamps invalid values and migrates legacy read override", () => {
  const config = normalizeSteroidsConfig({
    registerReadToolOverride: false,
    readOutputMode: "invalid",
    searchOutputMode: "count",
    previewLines: 999,
    expandedPreviewMaxLines: -1,
    bashCollapsedLines: 999,
    diffViewMode: "stacked",
    diffSplitMinWidth: 1,
    diffCollapsedLines: 999,
    diffWordWrap: false,
  });

  assert.equal(config.readOutputMode, DEFAULT_STEROIDS_CONFIG.readOutputMode);
  assert.equal(config.searchOutputMode, "count");
  assert.equal(config.previewLines, 80);
  assert.equal(config.expandedPreviewMaxLines, 0);
  assert.equal(config.bashCollapsedLines, 80);
  assert.equal(config.diffViewMode, "unified");
  assert.equal(config.diffSplitMinWidth, 70);
  assert.equal(config.diffCollapsedLines, 240);
  assert.equal(config.diffWordWrap, false);
});

test("config load reports parse errors and falls back to defaults", () => {
  withTempDir("pi-on-steroids-config-load-", (dir) => {
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "{not-json", "utf8");

    const result = loadSteroidsConfig(configFile);

    assert.deepEqual(result.config, DEFAULT_STEROIDS_CONFIG);
    assert.match(result.error ?? "", /Failed to parse/);
    assert.match(result.error ?? "", /config\.json/);
  });
});

test("config save writes normalized JSON and cleans temporary file on failure", () => {
  withTempDir("pi-on-steroids-config-save-", (dir) => {
    const configFile = join(dir, "config.json");
    const saved = saveSteroidsConfig(
      { ...DEFAULT_STEROIDS_CONFIG, previewLines: 999 },
      configFile,
    );

    assert.equal(saved.success, true);
    const persisted = JSON.parse(readFileSync(configFile, "utf8")) as { previewLines?: number };
    assert.equal(persisted.previewLines, 80);

    const parentFile = join(dir, "not-a-directory");
    writeFileSync(parentFile, "blocks mkdir", "utf8");
    const blockedConfigFile = join(parentFile, "config.json");
    const failed = saveSteroidsConfig(DEFAULT_STEROIDS_CONFIG, blockedConfigFile);

    assert.equal(failed.success, false);
    assert.match(failed.error ?? "", /Failed to save/);
    assert.equal(existsSync(`${blockedConfigFile}.tmp`), false);
  });
});

test("config.example.json matches the normalized defaults exactly", () => {
  const example = JSON.parse(readFileSync(new URL("../config/config.example.json", import.meta.url), "utf-8"));
  assert.deepEqual(example, DEFAULT_STEROIDS_CONFIG);
  assert.deepEqual(normalizeSteroidsConfig(example), DEFAULT_STEROIDS_CONFIG);
});
