import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileNameForId, parseCsv } from "../src/csv.js";
import { payloadMatches } from "../src/decode.js";
import { parseArguments } from "../src/index.js";
import { insertSvgFolder, insertSvgIntoTemplate } from "../src/insert.js";
import { ensureHttpProtocol } from "../src/pipeline.js";
import { generateQrSvg } from "../src/qr.js";
import {
  closeKnownQrPathData,
  findOversizedSquareIds,
  flattenQrCodeStylingSvg,
  inspectSvg,
  pathDataIsClosed,
} from "../src/svg.js";

const clippedSvg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <defs>
    <clipPath id="clip-path-background-color-0"><rect width="100" height="100"/></clipPath>
    <clipPath id="clip-path-dot-color-0">
      <g transform="translate(1 2)"><path d="M0 0h10v10h-10" clip-rule="evenodd"/></g>
      <circle cx="20" cy="20" r="5"/>
    </clipPath>
  </defs>
  <rect width="100" height="100" clip-path="url(#clip-path-background-color-0)" fill="transparent"/>
  <rect width="100" height="100" style="clip-path:url('#clip-path-dot-color-0');fill:#123456;fill-opacity:.8"/>
</svg>`;

describe("CSV and file names", () => {
  it("parses QR size in both supported forms", () => {
    expect(parseArguments(["input.csv", "--size", "420"]).size).toBe(420);
    expect(parseArguments(["input.csv", "--size=512"]).size).toBe(512);
    expect(() => parseArguments(["input.csv", "--size=10"])).toThrow(/64 to 4096/);
  });

  it("reads id and URL columns", () => {
    expect(parseCsv("id,url\nproduct-001,https://example.com/a\n")).toEqual([
      { id: "product-001", url: "https://example.com/a", fileName: "product-001.svg" },
    ]);
  });

  it("rejects an empty ID", () => {
    expect(() => parseCsv("id,url\n,https://example.com\n")).toThrow(/must not be empty/);
  });

  it("rejects duplicate IDs", () => {
    expect(() => parseCsv("id,url\na,https://a.example\na,https://b.example\n")).toThrow(/duplicate ID/);
  });

  it("accepts only safe ID characters", () => {
    expect(fileNameForId("A_1.ok-value")).toBe("A_1.ok-value.svg");
    expect(() => fileNameForId("../unsafe")).toThrow(/Invalid ID/);
    expect(() => fileNameForId("кириллица")).toThrow(/Invalid ID/);
  });

  it("forms the exact {id}.svg name", () => {
    expect(fileNameForId("product-001")).toBe("product-001.svg");
  });

  it("prevents case-insensitive filename collisions", () => {
    expect(() => parseCsv("id,url\nProduct,https://a.example\nproduct,https://b.example\n")).toThrow(/collision/);
  });
});

describe("QR dimensions", () => {
  it("uses size for both SVG width and height", async () => {
    const svg = await generateQrSvg("https://example.com/size", 420);
    expect(svg).toContain('width="420"');
    expect(svg).toContain('height="420"');
    expect(svg).toContain('viewBox="0 0 420 420"');
  });
});

describe("SVG template insertion", () => {
  const template = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><REPLACE/></g></svg>';
  const inserted = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><path d="M0 0h3v3z"/></svg>';

  it("replaces the placeholder with the complete inserted SVG", () => {
    const result = insertSvgIntoTemplate(template, inserted);
    expect(result).not.toContain("REPLACE");
    expect(result).toContain('width="3"');
    expect(result).toContain('d="M0 0h3v3z"');
  });

  it("requires exactly one placeholder", () => {
    expect(() => insertSvgIntoTemplate(template.replace("<REPLACE/>", ""), inserted)).toThrow(/found 0/);
    expect(() => insertSvgIntoTemplate(template.replace("<REPLACE/>", "<REPLACE/><REPLACE/>"), inserted)).toThrow(/found 2/);
  });

  it("processes every SVG in a folder and preserves filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "svg-insert-test-"));
    try {
      const sourceDirectory = join(root, "source");
      await mkdir(sourceDirectory);
      const templatePath = join(root, "template.svg");
      await writeFile(templatePath, template);
      await writeFile(join(sourceDirectory, "one.svg"), inserted);
      await writeFile(join(sourceDirectory, "two.SVG"), inserted.replace('width="3"', 'width="4"'));
      await writeFile(join(sourceDirectory, "ignored.txt"), "not svg");
      const result = await insertSvgFolder(templatePath, sourceDirectory);
      expect(result.fileNames).toEqual(["one.svg", "two.SVG"]);
      expect(result.outputDirectory.startsWith(join(root, "rendered-"))).toBe(true);
      expect(await readFile(join(result.outputDirectory, "one.svg"), "utf8")).not.toContain("REPLACE");
      expect(await readFile(join(result.outputDirectory, "two.SVG"), "utf8")).toContain('width="4"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("specialized qr-code-styling SVG flattening", () => {
  it("extracts clipPath geometry into visible SVG", () => {
    const result = flattenQrCodeStylingSvg(clippedSvg);
    expect(result).toContain("<path");
    expect(result).toContain("<circle");
  });

  it("transfers fill and opacity from the paint carrier", () => {
    const result = flattenQrCodeStylingSvg(clippedSvg);
    expect(result).toContain('fill="#123456"');
    expect(result).toContain('fill-opacity=".8"');
  });

  it("converts clip-rule to fill-rule", () => {
    const result = flattenQrCodeStylingSvg(clippedSvg);
    expect(result).toContain('fill-rule="evenodd"');
    expect(result).not.toContain("clip-rule");
  });

  it("removes clipPath definitions and references, including style references", () => {
    const result = flattenQrCodeStylingSvg(clippedSvg);
    expect(result).not.toMatch(/<clipPath\b/);
    expect(result).not.toMatch(/clip-path\s*[:=]/);
  });

  it("preserves viewBox, width and height", () => {
    const result = flattenQrCodeStylingSvg(clippedSvg);
    expect(result).toContain('viewBox="0 0 100 100"');
    expect(result).toContain('width="100"');
    expect(result).toContain('height="100"');
  });

  it("does not emit the transparent background rectangle", () => {
    const result = flattenQrCodeStylingSvg(clippedSvg);
    expect(result).not.toContain('fill="transparent"');
  });

  it("rejects arbitrary clipping structures", () => {
    const unknown = clippedSvg.replaceAll("clip-path-dot-color-0", "arbitrary-clip");
    expect(() => flattenQrCodeStylingSvg(unknown)).toThrow(/Unknown qr-code-styling/);
  });

  it("closes only explicitly known QR path subpaths", () => {
    expect(closeKnownQrPathData("M0 0h2v2 M4 4h2v2z")).toBe("M0 0h2v2 Z M4 4h2v2z");
  });
});

describe("final SVG and payload validation", () => {
  it("finds service squares larger than a QR module after Clip Release", () => {
    const released = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect id="background" width="300" height="300" fill="transparent"/>
      <rect id="dot-carrier" width="300" height="300" fill="#000000"/>
      <rect id="finder-carrier" width="84" height="84" fill="#000000"/>
      <rect id="module-a" width="12" height="12"/>
      <rect id="module-b" width="12" height="12"/>
    </svg>`;
    expect(findOversizedSquareIds(released)).toEqual({
      ids: ["background", "dot-carrier", "finder-carrier"],
      moduleSize: 12,
    });
  });

  it("adds http only when the URL has no HTTP protocol", () => {
    expect(ensureHttpProtocol("example.com/a")).toBe("http://example.com/a");
    expect(ensureHttpProtocol("http://example.com/a")).toBe("http://example.com/a");
    expect(ensureHttpProtocol("https://example.com/a")).toBe("https://example.com/a");
    expect(ensureHttpProtocol("HTTPS://example.com/a")).toBe("HTTPS://example.com/a");
  });

  it("detects remaining masks", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><defs><mask id="m"/></defs><path d="M0 0L1 0Z"/></svg>';
    expect(inspectSvg(svg).containsMask).toBe(true);
  });

  it("detects open and closed subpaths", () => {
    expect(pathDataIsClosed("M0 0L1 0L1 1Z M2 2L3 3z")).toBe(true);
    expect(pathDataIsClosed("M0 0L1 0L1 1")).toBe(false);
    expect(pathDataIsClosed("M0 0L1 0Z M2 2L3 3")).toBe(false);
  });

  it("requires an exact payload match", () => {
    expect(payloadMatches("https://example.com/a", "https://example.com/a")).toBe(true);
    expect(payloadMatches("https://example.com/a/", "https://example.com/a")).toBe(false);
  });
});
