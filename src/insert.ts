#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";

function parseSvg(source: string, fileName: string): XmlDocument {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") errors.push(message);
    },
  }).parseFromString(source, "image/svg+xml");
  if (errors.length || document.documentElement?.localName !== "svg") {
    throw new Error(`Invalid SVG ${fileName}: ${errors.join("; ") || "root element is not <svg>"}`);
  }
  return document;
}

function findReplaceElements(document: XmlDocument): XmlElement[] {
  const nodes = document.getElementsByTagName("*");
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index)).filter(
    (node): node is XmlElement => node?.localName === "REPLACE",
  );
}

export function insertSvgIntoTemplate(
  templateSource: string,
  insertedSource: string,
  templateName = "template.svg",
  insertedName = "insert.svg",
): string {
  const template = parseSvg(templateSource, templateName);
  const inserted = parseSvg(insertedSource, insertedName);
  const placeholders = findReplaceElements(template);
  if (placeholders.length !== 1) {
    throw new Error(`Template ${templateName} must contain exactly one <REPLACE/> element; found ${placeholders.length}`);
  }
  const placeholder = placeholders[0];
  const insertedRoot = inserted.documentElement;
  if (!placeholder?.parentNode || !insertedRoot) throw new Error("Unable to replace <REPLACE/> element");
  placeholder.parentNode.replaceChild(template.importNode(insertedRoot, true), placeholder);
  return new XMLSerializer().serializeToString(template);
}

export function resultDirectoryName(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `rendered-${timestamp}`;
}

export async function insertSvgFolder(
  templatePath: string,
  sourceDirectory: string,
  outputRoot?: string,
): Promise<{ outputDirectory: string; fileNames: string[] }> {
  const resolvedTemplate = resolve(templatePath);
  const resolvedSourceDirectory = resolve(sourceDirectory);
  const templateSource = await readFile(resolvedTemplate, "utf8");
  // Validate the template before creating an output directory.
  const templateDocument = parseSvg(templateSource, resolvedTemplate);
  const placeholderCount = findReplaceElements(templateDocument).length;
  if (placeholderCount !== 1) {
    throw new Error(`Template ${resolvedTemplate} must contain exactly one <REPLACE/> element; found ${placeholderCount}`);
  }

  const entries = await readdir(resolvedSourceDirectory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".svg"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!fileNames.length) throw new Error(`No SVG files found in ${resolvedSourceDirectory}`);

  const collisionKeys = new Set<string>();
  for (const fileName of fileNames) {
    const key = fileName.toLocaleLowerCase("en-US");
    if (collisionKeys.has(key)) throw new Error(`Case-insensitive output filename collision: ${fileName}`);
    collisionKeys.add(key);
  }

  const outputDirectory = resolve(outputRoot ?? dirname(resolvedSourceDirectory), resultDirectoryName());
  await mkdir(outputDirectory);
  for (const fileName of fileNames) {
    const insertedPath = join(resolvedSourceDirectory, fileName);
    const insertedSource = await readFile(insertedPath, "utf8");
    const result = insertSvgIntoTemplate(templateSource, insertedSource, resolvedTemplate, insertedPath);
    await writeFile(join(outputDirectory, basename(fileName)), `${result}\n`, { flag: "wx" });
    console.log(`${fileName}: OK`);
  }
  return { outputDirectory, fileNames };
}

function usage(): string {
  return "Usage: yarn tsx src/insert <template.svg> <insert-svg-folder>";
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || !args[0] || !args[1]) throw new Error(usage());
    const result = await insertSvgFolder(args[0], args[1]);
    console.log(`\nProcessed: ${result.fileNames.length}`);
    console.log(`Output:    ${result.outputDirectory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath) {
  const resolvedEntry = resolve(entryPath);
  const entryUrls = [pathToFileURL(resolvedEntry).href, pathToFileURL(`${resolvedEntry}.ts`).href];
  if (entryUrls.includes(import.meta.url)) void main();
}
