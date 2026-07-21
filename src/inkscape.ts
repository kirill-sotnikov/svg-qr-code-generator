import { spawn } from "node:child_process";

export class InkscapeError extends Error {
  constructor(message: string, readonly stderr: string, readonly exitCode: number | null) {
    super(message);
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new InkscapeError(error.message, stderr, null)));
    child.on("close", (code) => {
      if (code !== 0) reject(new InkscapeError(`Inkscape exited with code ${String(code)}`, stderr, code));
      else resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export async function getInkscapeVersion(bin: string): Promise<string> {
  const result = await run(bin, ["--version"]);
  const version = (result.stdout || result.stderr).trim();
  if (!version) throw new InkscapeError("Inkscape --version produced no output", result.stderr, result.exitCode);
  return version;
}

export async function releaseQrClipsSvg(bin: string, input: string, output: string): Promise<void> {
  await run(bin, [
    input,
    `--export-filename=${output}`,
    "--export-plain-svg",
    "--actions=select-all:all;object-release-clip;export-do",
  ]);
}

export async function deleteSquaresAndUnionSvg(
  bin: string,
  input: string,
  output: string,
  squareIds: string[],
): Promise<void> {
  if (!squareIds.length) throw new Error("No oversized service squares were selected for deletion");
  await run(bin, [
    input,
    `--export-filename=${output}`,
    "--export-plain-svg",
    `--actions=select-by-id:${squareIds.join(",")};delete-selection;select-all:all;path-union;export-do`,
  ]);
}

export async function rasterizeSvg(bin: string, input: string, output: string, size: number): Promise<void> {
  await run(bin, [
    input,
    "--export-type=png",
    `--export-filename=${output}`,
    `--export-width=${size}`,
    `--export-height=${size}`,
    "--export-area-page",
    "--export-background=#ffffff",
    "--export-background-opacity=255",
  ]);
}
