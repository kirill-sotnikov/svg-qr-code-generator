import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { parseCsv } from "../src/csv.js";
import { decodeQrPng, payloadMatches } from "../src/decode.js";
import { convertAndCombineSvg, rasterizeSvg } from "../src/inkscape.js";
import { runBatch } from "../src/pipeline.js";
import { generateQrSvg } from "../src/qr.js";
import { flattenQrCodeStylingSvg, inspectSvg } from "../src/svg.js";

const macBin = "/opt/homebrew/bin/inkscape";
const inkscapeBin = process.env.INKSCAPE_BIN || (existsSync(macBin) ? macBin : "inkscape");
let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "qrcode-generator-test-"));
});

afterAll(async () => {
  if (root && process.env.KEEP_TEST_OUTPUT) console.log(`Kept test output: ${root}`);
  else if (root) await rm(root, { recursive: true, force: true });
});

describe("Inkscape end-to-end pipeline", () => {
  it("requires an available Inkscape binary", () => {
    const version = execFileSync(inkscapeBin, ["--version"], { encoding: "utf8" });
    expect(version).toContain("Inkscape");
  });

  it("flattens, combines, exports, rasterizes and decodes an exact payload", async () => {
    const outputDirectory = join(root, "batch");
    const sourceUrl = "example.com/catalog/%D1%82%D0%B5%D1%81%D1%82?source=qr";
    const expectedUrl = `http://${sourceUrl}`;
    const records = parseCsv(`id,url\nproduct-001,${sourceUrl}\n`);
    const rows = await runBatch(records, {
      csvPath: join(root, "input.csv"), outputDirectory, concurrency: 1, overwrite: false, diagnostic: true, inkscapeBin, size: 300,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.expectedUrl).toBe(expectedUrl);
    expect(rows[0]?.decodedPayload).toBe(expectedUrl);
    expect(rows[0]?.verificationSize).toBe(300);
    expect(rows[0]?.outputFileName).toBe("product-001.svg");
    expect(rows[0]?.pathCount).toBeGreaterThan(0);
    expect(rows[0]?.containsClipPath).toBe(false);
    expect(rows[0]?.allPathsClosed).toBe(true);

    const raw = await readFile(join(outputDirectory, "raw", "product-001.svg"), "utf8");
    expect(raw).toContain("<clipPath");
    const finalPath = join(outputDirectory, "final", "product-001.svg");
    expect(existsSync(finalPath)).toBe(true);
    const finalSvg = await readFile(finalPath, "utf8");
    expect(finalSvg).not.toMatch(/<clipPath\b|\bclip-path=/);
    expect(finalSvg).not.toMatch(/<rect\b|<circle\b/);
    expect(inspectSvg(finalSvg).allPathsClosed).toBe(true);
    expect((finalSvg.match(/[Mm]/g) || []).length).toBeGreaterThan(3); // finder holes and disconnected islands survived combine

    const tempDirectories = await readdir(join(outputDirectory, "tmp"));
    const preview = join(outputDirectory, "tmp", tempDirectories[0] ?? "", "preview-300.png");
    const previewMetadata = await sharp(preview).metadata();
    expect(previewMetadata.width).toBe(300);
    expect(previewMetadata.height).toBe(300);

    const diagnosticDirs = readFileSync(join(outputDirectory, "report.json"), "utf8");
    expect(diagnosticDirs).toContain('"status": "success"');
  }, 60_000);

  it("preserves rounded modules that touch only at their corners", async () => {
    const work = join(root, "corner-touching-modules");
    await mkdir(work, { recursive: true });
    const prepared = join(work, "prepared.svg");
    const converted = join(work, "converted.svg");
    await writeFile(prepared, flattenQrCodeStylingSvg(await generateQrSvg("http://XTAG.PRO/NWZM-NWCQ", 800)));
    await convertAndCombineSvg(inkscapeBin, prepared, converted);

    const preparedPixels = await sharp(prepared).flatten({ background: "#fff" }).greyscale().raw().toBuffer();
    const convertedPixels = await sharp(converted).flatten({ background: "#fff" }).greyscale().raw().toBuffer();
    let removedBlackPixels = 0;
    for (let index = 0; index < preparedPixels.length; index += 1) {
      if ((preparedPixels[index] ?? 255) < 32 && (convertedPixels[index] ?? 0) > 223) removedBlackPixels += 1;
    }

    expect(removedBlackPixels).toBe(0);
    expect(convertedPixels[176 * 800 + 432]).toBeLessThan(32);
    expect(convertedPixels[208 * 800 + 464]).toBeLessThan(32);
    expect(inspectSvg(await readFile(converted, "utf8")).pathCount).toBe(1);
  }, 30_000);

  it("does not overwrite an existing final SVG", async () => {
    const outputDirectory = join(root, "existing");
    await mkdir(join(outputDirectory, "final"), { recursive: true });
    const sentinel = "<svg>existing</svg>";
    await writeFile(join(outputDirectory, "final", "taken.svg"), sentinel);
    const rows = await runBatch(parseCsv("id,url\ntaken,https://example.com/taken\n"), {
      csvPath: join(root, "existing.csv"), outputDirectory, concurrency: 1, overwrite: false, diagnostic: false, inkscapeBin, size: 300,
    });
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.errorStage).toBe("publish");
    expect(await readFile(join(outputDirectory, "final", "taken.svg"), "utf8")).toBe(sentinel);
    expect(existsSync(join(outputDirectory, "failed", "taken", "error.json"))).toBe(true);
  }, 30_000);

  it("rejects a decoded QR when another URL is expected", async () => {
    const work = join(root, "mismatch");
    await mkdir(work, { recursive: true });
    const encodedUrl = "https://example.com/encoded";
    const expectedUrl = "https://example.com/other";
    const prepared = join(work, "prepared.svg");
    const converted = join(work, "converted.svg");
    const png = join(work, "preview.png");
    await writeFile(prepared, flattenQrCodeStylingSvg(await generateQrSvg(encodedUrl)));
    await convertAndCombineSvg(inkscapeBin, prepared, converted);
    await rasterizeSvg(inkscapeBin, converted, png, 300);
    const decoded = await decodeQrPng(png);
    expect(decoded).toBe(encodedUrl);
    expect(payloadMatches(decoded, expectedUrl)).toBe(false);
    const finalPath = join(work, "final", "mismatch.svg");
    if (payloadMatches(decoded, expectedUrl)) await writeFile(finalPath, await readFile(converted));
    expect(existsSync(finalPath)).toBe(false);
  }, 30_000);
});
