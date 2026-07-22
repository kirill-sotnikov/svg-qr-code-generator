import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { decodeQrPng, payloadMatches } from "./decode.js";
import {
  deleteSquaresAndUnionSvg,
  getInkscapeVersion,
  InkscapeError,
  rasterizeSvg,
  releaseQrClipsSvg,
} from "./inkscape.js";
import { generateQrSvg } from "./qr.js";
import { findOversizedSquareIds, inspectSvg } from "./svg.js";
import type { BatchOptions, CsvRecord, ErrorStage, ReportRow, SvgInspection } from "./types.js";

class StageError extends Error {
  constructor(readonly stage: ErrorStage, message: string, readonly causeValue?: unknown) {
    super(message);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export function ensureHttpProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

function log(index: number, total: number, id: string, message: string): void {
  console.log(`[${index}/${total}] ${id}: ${message}`);
}

async function atStage<T>(stage: ErrorStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StageError(stage, message, error);
  }
}

async function saveFailure(
  record: CsvRecord,
  options: BatchOptions,
  paths: Record<string, string>,
  error: StageError,
  decodedPayload: string,
  expectedUrl: string,
): Promise<void> {
  const failedDirectory = join(options.outputDirectory, "failed", record.id);
  await mkdir(failedDirectory, { recursive: true });
  const copies: Array<[string, string]> = [
    [paths.raw ?? "", "source.svg"],
    [paths.released ?? "", "released.svg"],
    [paths.converted ?? "", "converted.svg"],
    [paths.preview ?? "", `preview-${options.size}.png`],
  ];
  for (const [source, name] of copies) {
    if (source && await exists(source)) await copyFile(source, join(failedDirectory, name));
  }
  const inkscape = error.causeValue instanceof InkscapeError ? error.causeValue : undefined;
  await writeFile(join(failedDirectory, "error.json"), `${JSON.stringify({
    id: record.id,
    stage: error.stage,
    message: error.message,
    expectedUrl,
    decodedValue: decodedPayload,
    verificationSize: options.size,
    inkscapeStderr: inkscape?.stderr || "",
    inkscapeExitCode: inkscape?.exitCode ?? null,
    sourceFile: `raw/${record.fileName}`,
    intendedOutputFileName: record.fileName,
  }, null, 2)}\n`);
}

export async function processRecord(
  record: CsvRecord,
  index: number,
  total: number,
  options: BatchOptions,
  inkscapeVersion: string,
): Promise<ReportRow> {
  const started = performance.now();
  const rawPath = join(options.outputDirectory, "raw", record.fileName);
  const finalPath = join(options.outputDirectory, "final", record.fileName);
  const expectedUrl = ensureHttpProtocol(record.url);
  const tempDirectory = await mkdtemp(join(options.outputDirectory, "tmp", `${record.id}-`));
  const paths = {
    raw: rawPath,
    released: join(tempDirectory, "released.svg"),
    converted: join(tempDirectory, "converted.svg"),
    preview: join(tempDirectory, `preview-${options.size}.png`),
  };
  let decodedPayload = "";
  let inspection: SvgInspection = {
    viewBox: "", pathCount: 0, containsClipPath: false, containsMask: false, allPathsClosed: false,
  };

  try {
    if (!options.overwrite && await exists(finalPath)) {
      throw new StageError("publish", `Refusing to overwrite existing ${record.fileName}`);
    }
    log(index, total, record.id, `generating raw/${record.fileName}`);
    const raw = await atStage("generate", () => generateQrSvg(
      expectedUrl,
      options.size,
      options.errorCorrectionLevel,
    ));
    await writeFile(rawPath, raw);
    const rawViewBox = readViewBox(raw);
    log(index, total, record.id, "releasing clip paths with Inkscape");
    await atStage("release", () => releaseQrClipsSvg(options.inkscapeBin, paths.raw, paths.released));
    const released = await atStage("release", () => readFile(paths.released, "utf8"));
    inspectReleasedSvg(released, rawViewBox);
    const oversizedSquares = await atStage("cleanup", async () => findOversizedSquareIds(released));
    log(index, total, record.id, `deleting ${oversizedSquares.ids.length} service squares larger than ${oversizedSquares.moduleSize}px`);
    log(index, total, record.id, "converting objects and applying path union with Inkscape");
    await atStage("convert", () => deleteSquaresAndUnionSvg(
      options.inkscapeBin,
      paths.released,
      paths.converted,
      oversizedSquares.ids,
    ));
    log(index, total, record.id, "validating Plain SVG");
    inspection = await atStage("structure", async () => inspectSvg(await readFile(paths.converted, "utf8"), rawViewBox));
    if (inspection.containsClipPath || inspection.containsMask || !inspection.allPathsClosed) {
      throw new StageError("structure", "Final SVG contains clipping, masking, or open production subpaths");
    }
    log(index, total, record.id, `rasterizing ${options.size}px with Inkscape`);
    await atStage("rasterize", () => rasterizeSvg(options.inkscapeBin, paths.converted, paths.preview, options.size));
    log(index, total, record.id, `decoding ${options.size}px`);
    decodedPayload = await atStage("decode", () => decodeQrPng(paths.preview));
    if (!payloadMatches(decodedPayload, expectedUrl)) {
      throw new StageError("compare", "Decoded QR payload does not exactly match the expected URL");
    }
    log(index, total, record.id, `writing final/${record.fileName}`);
    await atStage("publish", async () => {
      await rename(paths.converted, finalPath);
    });
    if (!options.diagnostic) await rm(tempDirectory, { recursive: true, force: true });
    log(index, total, record.id, "OK");
    return makeRow(record, expectedUrl, inkscapeVersion, started, inspection, decodedPayload, options.size, "success");
  } catch (caught) {
    const error = caught instanceof StageError
      ? caught
      : new StageError("input", caught instanceof Error ? caught.message : String(caught), caught);
    await saveFailure(record, options, paths, error, decodedPayload, expectedUrl);
    if (!options.diagnostic) await rm(tempDirectory, { recursive: true, force: true });
    log(index, total, record.id, `FAILED (${error.stage}): ${error.message}`);
    return makeRow(record, expectedUrl, inkscapeVersion, started, inspection, decodedPayload, options.size, "failed", error);
  }
}

function readViewBox(svg: string): string {
  const viewBox = /\bviewBox=["']([^"']+)["']/.exec(svg)?.[1] || "";
  if (!viewBox) throw new Error("SVG has no viewBox");
  return viewBox;
}

function inspectReleasedSvg(svg: string, expectedViewBox: string): void {
  if (/<clipPath\b|<mask\b|\b(?:clip-path|mask)\s*(?:=|:)\s*["']?\s*url\(/.test(svg)) {
    throw new Error("Clip Release output still contains clipping or masking");
  }
  if (readViewBox(svg) !== expectedViewBox) throw new Error("Clip Release changed the SVG viewBox");
}

function makeRow(
  record: CsvRecord,
  expectedUrl: string,
  inkscapeVersion: string,
  started: number,
  inspection: SvgInspection,
  decodedPayload: string,
  verificationSize: number,
  status: "success" | "failed",
  error?: StageError,
): ReportRow {
  return {
    id: record.id,
    expectedUrl,
    decodedPayload,
    verificationSize,
    status,
    sourceFile: `raw/${record.fileName}`,
    outputFile: status === "success" ? `final/${record.fileName}` : "",
    outputFileName: status === "success" ? record.fileName : "",
    pathCount: inspection.pathCount,
    containsClipPath: inspection.containsClipPath,
    containsMask: inspection.containsMask,
    allPathsClosed: inspection.allPathsClosed,
    inkscapeVersion,
    durationMs: Math.round(performance.now() - started),
    errorStage: error?.stage || "",
    errorMessage: error?.message || "",
  };
}

function csvEscape(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeReports(outputDirectory: string, rows: ReportRow[]): Promise<void> {
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(rows, null, 2)}\n`);
  const headers: Array<keyof ReportRow> = [
    "id", "expectedUrl", "decodedPayload", "verificationSize", "status", "sourceFile", "outputFile",
    "outputFileName", "pathCount", "containsClipPath", "containsMask", "allPathsClosed", "inkscapeVersion",
    "durationMs", "errorStage", "errorMessage",
  ];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  await writeFile(join(outputDirectory, "report.csv"), `${lines.join("\n")}\n`);
}

export async function runBatch(records: CsvRecord[], options: BatchOptions): Promise<ReportRow[]> {
  for (const directory of ["raw", "final", "failed", "tmp"]) {
    await mkdir(join(options.outputDirectory, directory), { recursive: true });
  }
  const inkscapeVersion = await getInkscapeVersion(options.inkscapeBin);
  const rows = new Array<ReportRow>(records.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      const record = records[current];
      if (!record) return;
      rows[current] = await processRecord(record, current + 1, records.length, options, inkscapeVersion);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, records.length) }, () => worker()));
  await writeReports(options.outputDirectory, rows);
  return rows;
}

export function defaultOutputDirectory(csvPath: string, now = new Date()): string {
  const stem = basename(csvPath).replace(/\.csv$/i, "");
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return join(dirname(csvPath), `${stem}-${timestamp}`);
}
