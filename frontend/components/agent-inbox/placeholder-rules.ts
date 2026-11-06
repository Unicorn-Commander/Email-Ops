/**
 * Placeholder rules for the standing-approval form.
 *
 * The backend (agent-send-kit.ts `sortedRules` / `templateFragment`) accepts an
 * object of placeholder name → Unicode regular-expression source. It does not
 * have a separate enum. These presets are that source, including the two
 * built-in defaults (`first_name`, `token`). A name with no source fails the
 * guard as "No rule exists for placeholder <name>".
 */

export const REQUIRED_NAME_RULE = String.raw`[\p{L}][\p{L}' .-]{0,39}`;
export const TOKEN_RULE = "[0-9a-f]{16}";
export const REQUIRED_TEXT_RULE = String.raw`[^\n\r]{1,120}`;

export const PLACEHOLDER_PRESETS = [
  { id: "name", label: "Required non-empty name", rule: REQUIRED_NAME_RULE },
  { id: "token", label: "16-character lowercase hex token", rule: TOKEN_RULE },
  { id: "text", label: "Required non-empty text", rule: REQUIRED_TEXT_RULE },
] as const;

export type PlaceholderPresetId = (typeof PLACEHOLDER_PRESETS)[number]["id"] | "custom";

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `{name}` tokens in source order, matching the backend placeholder grammar. */
export function detectPlaceholders(template: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Sensible source for a newly detected name. Known defaults stay exact. */
export function defaultRuleFor(name: string): string {
  if (name === "token") return TOKEN_RULE;
  if (name === "first_name") return REQUIRED_NAME_RULE;
  return REQUIRED_TEXT_RULE;
}

export function syncPlaceholderRules(
  current: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const name of names) {
    next[name] = Object.prototype.hasOwnProperty.call(current, name)
      ? current[name]
      : defaultRuleFor(name);
  }
  return next;
}

export function presetIdFor(rule: string): PlaceholderPresetId {
  return PLACEHOLDER_PRESETS.find((preset) => preset.rule === rule)?.id ?? "custom";
}

export function isValidPlaceholderRule(rule: string): boolean {
  if (!rule.trim()) return false;
  try {
    new RegExp(rule, "u");
    return true;
  } catch {
    return false;
  }
}

/** Same sentence the backend throws from templateFragment. */
export function missingPlaceholderMessage(name: string): string {
  return `No rule exists for placeholder ${name}.`;
}
