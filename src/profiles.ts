import {
  BUILT_IN_PROFILE_NAMES,
  DEFAULT_STEROIDS_CONFIG,
  DISPLAY_SETTING_KEYS,
  type BuiltInProfileName,
  type DisplaySettings,
  type SteroidsConfig,
} from "./types.js";

export function pickDisplaySettings(config: DisplaySettings): DisplaySettings {
  const picked = {} as Record<string, unknown>;
  for (const key of DISPLAY_SETTING_KEYS) {
    picked[key] = config[key];
  }
  return picked as unknown as DisplaySettings;
}

const HIDDEN = pickDisplaySettings(DEFAULT_STEROIDS_CONFIG);

const BUILT_IN_PROFILES: Record<BuiltInProfileName, DisplaySettings> = {
  hidden: HIDDEN,
  balanced: {
    ...HIDDEN,
    groupToolCalls: false,
    hideAssistantCommentary: false,
    readOutputMode: "summary",
    searchOutputMode: "count",
    bashOutputMode: "summary",
  },
  verbose: {
    ...HIDDEN,
    groupToolCalls: false,
    hideAssistantCommentary: false,
    readOutputMode: "preview",
    searchOutputMode: "preview",
    bashOutputMode: "preview",
    previewLines: 12,
    bashCollapsedLines: 20,
  },
};

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function isBuiltInProfile(name: string): name is BuiltInProfileName {
  return (BUILT_IN_PROFILE_NAMES as readonly string[]).includes(name);
}

/** Valid custom profile names are short, filesystem-ish words that do not shadow a built-in. */
export function isValidCustomProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name) && !isBuiltInProfile(name.toLowerCase());
}

export function listProfileNames(config: SteroidsConfig): string[] {
  return [...BUILT_IN_PROFILE_NAMES, ...Object.keys(config.customProfiles).sort()];
}

export function getProfileSettings(config: SteroidsConfig, name: string): DisplaySettings | undefined {
  if (isBuiltInProfile(name)) return BUILT_IN_PROFILES[name];
  return Object.hasOwn(config.customProfiles, name) ? config.customProfiles[name] : undefined;
}

export function applyProfile(config: SteroidsConfig, name: string): SteroidsConfig {
  const settings = getProfileSettings(config, name);
  return settings ? { ...config, ...settings, profile: name } : config;
}

/** Snapshots the current display settings under `name` and makes it the active profile. */
export function saveProfile(config: SteroidsConfig, name: string): SteroidsConfig {
  if (!isValidCustomProfileName(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use letters, digits, - or _ (max 32 chars); hidden, balanced and verbose are reserved.`,
    );
  }
  return {
    ...config,
    profile: name,
    customProfiles: { ...config.customProfiles, [name]: pickDisplaySettings(config) },
  };
}

/** Removes a custom profile. The current settings stay as they are, now attributed to `hidden`. */
export function deleteProfile(config: SteroidsConfig, name: string): SteroidsConfig {
  if (!Object.hasOwn(config.customProfiles, name)) {
    return config;
  }
  const { [name]: _removed, ...rest } = config.customProfiles;
  return { ...config, customProfiles: rest, profile: config.profile === name ? "hidden" : config.profile };
}

export function nextCustomProfileName(config: SteroidsConfig): string {
  for (let i = 0; ; i += 1) {
    const suffix = i < 26 ? String.fromCharCode(65 + i) : String(i - 25);
    const name = `custom-${suffix}`;
    if (!Object.hasOwn(config.customProfiles, name)) {
      return name;
    }
  }
}

/** Active profile name, flagged when the live display settings have drifted from its snapshot. */
export function describeProfile(config: SteroidsConfig): string {
  const snapshot = getProfileSettings(config, config.profile);
  if (!snapshot) {
    return `${config.profile} (missing)`;
  }
  const current = pickDisplaySettings(config);
  const modified = DISPLAY_SETTING_KEYS.some((key) => current[key] !== snapshot[key]);
  return modified ? `${config.profile} (modified)` : config.profile;
}
