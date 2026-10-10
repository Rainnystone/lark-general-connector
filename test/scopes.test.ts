import { describe, expect, it } from "vitest";
import { FEISHU_SCOPES } from "../src/scopes";
import scopesImport from "../scopes.import.json" with { type: "json" };
import { NEVER_EXACT, SPEC_SCOPES } from "./spec-scopes";

describe("scope pin", () => {
  it("matches the pinned set and excludes the NEVER list", () => {
    expect(new Set(FEISHU_SCOPES)).toEqual(new Set(SPEC_SCOPES));
    expect(FEISHU_SCOPES).toHaveLength(48);
    expect([...FEISHU_SCOPES]).toEqual([...SPEC_SCOPES]);
    for (const banned of NEVER_EXACT) expect(FEISHU_SCOPES).not.toContain(banned);
    for (const scope of FEISHU_SCOPES) {
      expect(scope.startsWith("corehr:")).toBe(false);
      expect(scope.startsWith("hire:")).toBe(false);
      if (scope.startsWith("contact:")) expect(scope.endsWith("readonly") || scope.endsWith(":search")).toBe(true);
    }
  });

  it("pins scopes.import.json user list to FEISHU_SCOPES and keeps tenant empty", () => {
    expect(scopesImport.scopes.tenant).toEqual([]);
    expect(scopesImport.scopes.user).toEqual([...FEISHU_SCOPES]);
  });
});
