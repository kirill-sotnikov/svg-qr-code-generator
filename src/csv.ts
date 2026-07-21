import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { CsvRecord } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function fileNameForId(id: string): string {
  if (!id) throw new Error("ID must not be empty");
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(
      `Invalid ID \"${id}\": use 1-128 ASCII letters, digits, dots, underscores or hyphens; the first character must be alphanumeric`,
    );
  }
  return `${id}.svg`;
}

export function parseCsv(content: string): CsvRecord[] {
  const rows = parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, unknown>>;
  const seenIds = new Set<string>();
  const seenFileNames = new Set<string>();

  return rows.map((row, index) => {
    const line = index + 2;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!id) throw new Error(`CSV line ${line}: ID must not be empty`);
    if (!url) throw new Error(`CSV line ${line}: URL must not be empty`);
    if (seenIds.has(id)) throw new Error(`CSV line ${line}: duplicate ID \"${id}\"`);
    const fileName = fileNameForId(id);
    const collisionKey = fileName.toLocaleLowerCase("en-US");
    if (seenFileNames.has(collisionKey)) {
      throw new Error(`CSV line ${line}: file name collision for \"${fileName}\"`);
    }
    seenIds.add(id);
    seenFileNames.add(collisionKey);
    return { id, url, fileName };
  });
}

export async function readCsv(csvPath: string): Promise<CsvRecord[]> {
  return parseCsv(await readFile(csvPath, "utf8"));
}
