import { describe, expect, test } from "vitest";
import { buildSchemaCatalogResponse, schemaCatalogEntries } from "../src/schema-catalog";
import * as schemaExports from "../src/schemas";
import { app } from "../src/server";
import { validators } from "../src/validation";

function exportedSchemaIds(): string[] {
  return (Object.values(schemaExports) as unknown[])
    .filter((value): value is { $id: string } => (
      typeof value === "object" && value !== null && "$id" in value && typeof value.$id === "string"
    ))
    .map((schema) => schema.$id)
    .sort();
}

describe("schema catalog", () => {
  test("inventories every exported JSON Schema exactly once", () => {
    const catalogIds = schemaCatalogEntries.map((entry) => entry.schema.$id).sort();
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(catalogIds).toEqual(exportedSchemaIds());
  });

  test("returns a valid inventory with first-class business models", () => {
    const response: unknown = buildSchemaCatalogResponse();
    expect(validators.schemaCatalogResponse(response)).toBe(true);
    expect(schemaCatalogEntries.filter((entry) => entry.category === "business").length).toBeGreaterThan(0);
    expect(schemaCatalogEntries.every((entry) => entry.typeName.length > 0)).toBe(true);
  });

  test("strictly rejects coerced and additional request fields", () => {
    expect(validators.createGameInput({ name: "Ada", mode: "realtime", maxPlayers: "2" })).toBe(false);
    expect(validators.createGameInput({ name: "Ada", mode: "realtime", maxPlayers: 2, extra: true })).toBe(false);
    expect(validators.createGameInput({
      name: "Ada",
      mode: "realtime",
      maxPlayers: 2,
      assistPolicy: {
        "no-move-alert": "default-on",
        "auto-draw": "sometimes",
        "rack-set-highlights": "default-off",
      },
    })).toBe(false);
    expect(validators.setAssistInput({ assistId: "auto-draw", enabled: true })).toBe(true);
    expect(validators.setAssistInput({ assistId: "rack-set-highlights", enabled: true })).toBe(true);
    expect(validators.setAssistInput({ assistId: "future-assist", enabled: true })).toBe(false);
  });
});

describe("local schema administration", () => {
  test("serves a valid inventory only on loopback", async () => {
    const local = await app.request("http://127.0.0.1/api/admin/schemas");
    expect(local.status).toBe(200);
    expect(validators.schemaCatalogResponse(await local.json())).toBe(true);

    const remote = await app.request("https://guppycube.example/api/admin/schemas");
    expect(remote.status).toBe(404);
    expect(validators.apiError(await remote.json())).toBe(true);
  });
});
