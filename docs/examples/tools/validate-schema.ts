import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../record-line.schema.json";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const files = process.argv.slice(2);
let bad = 0;
for (const file of files) {
  const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
  let ok = 0;
  for (const [i, line] of lines.entries()) {
    const value = JSON.parse(line);
    if (validate(value)) ok += 1;
    else { bad += 1; console.log(file, "line", i + 1, JSON.stringify(validate.errors?.slice(0, 3))); }
  }
  console.log(`${file}: ${ok}/${lines.length} lines valid`);
}
// positive edge checks for private draw payloads (private may be withheld from another seat's stream)
const accepts = [
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "player", drew: 0 },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "player", drew: 1, private: { tile: "c7a" } },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "timeout", drew: 2, private: { tiles: ["c7a", "s8b"] } },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "timeout", drew: 3 },
];
for (const value of accepts) if (!validate(value)) { bad += 1; console.log("should have been accepted:", JSON.stringify(value), validate.errors); }
// negative checks: things the schema must reject
const rejects = [
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "play", reason: "player", board: [["c7a", "c7b", "c7a"]], played: ["c7a"], extra: 1 },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p9", action: "draw", reason: "player", drew: 1 },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "timeout", drew: 4 },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "timeout", drew: 2, private: { tile: "c7a" } },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "timeout", drew: 3, private: { tiles: ["c7a", "s8b"] } },
  { seq: 5, at: 1, type: "turn", n: 1, player: "p1", action: "draw", reason: "player", drew: 0, private: { tile: "c7a" } },
  { id: "x", at: 1, type: "note", by: {}, text: "hi" },
  { id: "x", at: 1, type: "note", by: { name: "Ada" }, text: "hi", marks: ["!!!"] },
  { seq: 2, at: 1, type: "game" },
  { seq: 1, at: 1, type: "turn", n: 1, player: "p1", action: "play", reason: "player", board: [["c14a"]], played: ["c14a"] },
];
for (const value of rejects) if (validate(value)) { bad += 1; console.log("should have been rejected:", JSON.stringify(value)); }
console.log(bad === 0 ? "schema checks passed" : `schema checks FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
