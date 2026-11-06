import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REQUIRED_NAME_RULE,
  REQUIRED_TEXT_RULE,
  TOKEN_RULE,
  defaultRuleFor,
  detectPlaceholders,
  isValidPlaceholderRule,
  missingPlaceholderMessage,
  presetIdFor,
  syncPlaceholderRules,
} from "./placeholder-rules";

describe("standing approval placeholder rules", () => {
  it("detects {name} tokens in order and ignores duplicates and non-names", () => {
    const template = "Hello {first_name} in {state_name}.\n{first_name} / {not a name} / {token}";
    assert.deepEqual(detectPlaceholders(template), ["first_name", "state_name", "token"]);
  });

  it("prefills first_name and token from the backend defaults and other names as required text", () => {
    assert.equal(defaultRuleFor("first_name"), REQUIRED_NAME_RULE);
    assert.equal(defaultRuleFor("token"), TOKEN_RULE);
    assert.equal(defaultRuleFor("state_name"), REQUIRED_TEXT_RULE);
    const synced = syncPlaceholderRules({}, ["state_name", "first_name"]);
    assert.equal(synced.state_name, REQUIRED_TEXT_RULE);
    assert.equal(synced.first_name, REQUIRED_NAME_RULE);
  });

  it("keeps an edited rule, including a cleared one, and drops names no longer in the template", () => {
    const synced = syncPlaceholderRules(
      { first_name: "", city_name: TOKEN_RULE, removed: REQUIRED_TEXT_RULE },
      ["first_name", "city_name"],
    );
    assert.deepEqual(synced, { first_name: "", city_name: TOKEN_RULE });
    assert.equal(presetIdFor(TOKEN_RULE), "token");
    assert.equal(presetIdFor("custom-source"), "custom");
  });

  it("names the placeholder that still has no rule and rejects a broken expression", () => {
    assert.equal(missingPlaceholderMessage("state_name"), "No rule exists for placeholder state_name.");
    assert.equal(isValidPlaceholderRule(""), false);
    assert.equal(isValidPlaceholderRule("("), false);
    assert.equal(isValidPlaceholderRule(REQUIRED_TEXT_RULE), true);
  });
});
