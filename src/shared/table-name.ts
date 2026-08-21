export const TABLE_NAME_SEGMENT_PATTERN = "[a-z]+-[a-z]+-[a-z]+";
export const TABLE_NAME_PATTERN = `^${TABLE_NAME_SEGMENT_PATTERN}$`;
export const TABLE_NAME_MAX_LENGTH = 40;
const tableNameRegex = new RegExp(TABLE_NAME_PATTERN);

export function normalizeTableName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatTableNameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .split("-")
    .slice(0, 3)
    .join("-")
    .slice(0, TABLE_NAME_MAX_LENGTH);
}

export function isTableName(value: string): boolean {
  return tableNameRegex.test(value);
}
