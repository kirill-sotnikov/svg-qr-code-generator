export interface CsvRecord {
  id: string;
  url: string;
  fileName: string;
}

export type ErrorStage =
  | "input"
  | "generate"
  | "flatten"
  | "convert"
  | "structure"
  | "rasterize"
  | "decode"
  | "compare"
  | "publish";

export interface ReportRow {
  id: string;
  expectedUrl: string;
  decodedPayload: string;
  verificationSize: number;
  status: "success" | "failed";
  sourceFile: string;
  outputFile: string;
  outputFileName: string;
  pathCount: number;
  containsClipPath: boolean;
  containsMask: boolean;
  allPathsClosed: boolean;
  inkscapeVersion: string;
  durationMs: number;
  errorStage: string;
  errorMessage: string;
}

export interface SvgInspection {
  viewBox: string;
  pathCount: number;
  containsClipPath: boolean;
  containsMask: boolean;
  allPathsClosed: boolean;
}

export interface BatchOptions {
  csvPath: string;
  outputDirectory: string;
  concurrency: number;
  overwrite: boolean;
  diagnostic: boolean;
  inkscapeBin: string;
  size: number;
}
