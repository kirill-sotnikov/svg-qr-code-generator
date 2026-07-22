#!/usr/bin/env node
import { resolve } from "node:path";
import type { ErrorCorrectionLevel } from "qr-code-styling";
import { readCsv } from "./csv.js";
import { defaultOutputDirectory, runBatch } from "./pipeline.js";

interface CliOptions {
  csvPath: string;
  concurrency: number;
  overwrite: boolean;
  diagnostic: boolean;
  size: number;
  errorCorrectionLevel: ErrorCorrectionLevel;
  outputDirectory?: string;
}

export function usage(): string {
  return [
    "Usage: yarn gen <input.csv> [options]",
    "",
    "Options:",
    "  --concurrency <n>  Maximum concurrent QR/Inkscape jobs (default: 2)",
    "  --size <n>         SVG QR width and height in pixels (default: 300)",
    "  --error-correction-level <level>  QR error correction: L, M, Q, or H (default: Q)",
    "  --output-dir <dir>  Use a deterministic output directory instead of <csv>-<timestamp>",
    "  --overwrite         Replace existing final/{id}.svg files",
    "  --diagnostic        Keep per-record temporary files after success",
    "  --help              Show this help",
  ].join("\n");
}

export function parseArguments(args: string[]): CliOptions {
  const positional: string[] = [];
  let concurrency = 2;
  let overwrite = false;
  let diagnostic = false;
  let size = 300;
  let errorCorrectionLevel: ErrorCorrectionLevel = "Q";
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--concurrency") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 32) {
        throw new Error("--concurrency must be an integer from 1 to 32");
      }
      concurrency = value;
    } else if (arg === "--size" || arg?.startsWith("--size=")) {
      const rawValue = arg === "--size" ? args[++index] : arg.slice("--size=".length);
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 64 || value > 4096) {
        throw new Error("--size must be an integer from 64 to 4096");
      }
      size = value;
    } else if (arg === "--output-dir") {
      const value = args[++index];
      if (!value) throw new Error("--output-dir requires a path");
      outputDirectory = resolve(value);
    } else if (arg === "--error-correction-level" || arg?.startsWith("--error-correction-level=")) {
      const rawValue = arg === "--error-correction-level"
        ? args[++index]
        : arg.slice("--error-correction-level=".length);
      if (rawValue !== "L" && rawValue !== "M" && rawValue !== "Q" && rawValue !== "H") {
        throw new Error("--error-correction-level must be one of: L, M, Q, H");
      }
      errorCorrectionLevel = rawValue;
    } else if (arg === "--overwrite") overwrite = true;
    else if (arg === "--diagnostic") diagnostic = true;
    else if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (arg) positional.push(arg);
  }
  if (positional.length !== 1 || !positional[0]) throw new Error(usage());
  return {
    csvPath: resolve(positional[0]), concurrency, overwrite, diagnostic, size, errorCorrectionLevel,
    ...(outputDirectory ? { outputDirectory } : {}),
  };
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(usage());
      return;
    }
    const cli = parseArguments(args);
    const records = await readCsv(cli.csvPath);
    if (!records.length) throw new Error("CSV contains no data rows");
    const outputDirectory = cli.outputDirectory || defaultOutputDirectory(cli.csvPath);
    const rows = await runBatch(records, {
      csvPath: cli.csvPath,
      outputDirectory,
      concurrency: cli.concurrency,
      overwrite: cli.overwrite,
      diagnostic: cli.diagnostic,
      inkscapeBin: process.env.INKSCAPE_BIN || "inkscape",
      size: cli.size,
      errorCorrectionLevel: cli.errorCorrectionLevel,
    });
    const success = rows.filter((row) => row.status === "success").length;
    const failed = rows.length - success;
    console.log(`\nOutput:    ${outputDirectory}`);
    console.log(`Processed: ${String(rows.length).padStart(3)}`);
    console.log(`Success:   ${String(success).padStart(3)}`);
    console.log(`Failed:    ${String(failed).padStart(3)}`);
    if (failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") void main();
