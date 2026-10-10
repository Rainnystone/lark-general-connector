import { describe, expect, it } from "vitest";
import { FEISHU_SCOPES } from "../src/scopes";
import { NEVER_EXACT, SPEC_SCOPES } from "./spec-scopes";

describe("scope pin", () => {
  it("matches the L14 set and excludes the NEVER list", () => {
    expect(new Set(FEISHU_SCOPES)).toEqual(new Set(SPEC_SCOPES));
    expect(FEISHU_SCOPES).toHaveLength(25);
    for (const banned of NEVER_EXACT) expect(FEISHU_SCOPES).not.toContain(banned);
    for (const scope of FEISHU_SCOPES) {
      expect(scope.startsWith("corehr:")).toBe(false);
      expect(scope.startsWith("hire:")).toBe(false);
      if (scope.startsWith("contact:")) expect(scope.endsWith("readonly") || scope.endsWith(":search")).toBe(true);
    }
  });
});
