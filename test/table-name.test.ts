import { describe, expect, test } from "vitest";
import { makeTableName } from "../src/server/table-names";
import {
  formatTableNameInput,
  isTableName,
  normalizeTableName,
} from "../src/shared/table-name";

describe("table names", () => {
  test("generates three lowercase words joined by hyphens", () => {
    for (let index = 0; index < 256; index += 1) {
      expect(makeTableName()).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    }
  });

  test("normalizes pasted names and validates the complete shape", () => {
    expect(normalizeTableName("  Dorky Puppet_SPAM  ")).toBe("dorky-puppet-spam");
    expect(isTableName("dorky-puppet-spam")).toBe(true);
    expect(isTableName("ABC234")).toBe(false);
    expect(isTableName("dorky-puppet")).toBe(false);
  });

  test("keeps join-form input lowercase and limited to three words", () => {
    expect(formatTableNameInput("Dorky Puppet Spam Again!"))
      .toBe("dorky-puppet-spam");
  });
});
