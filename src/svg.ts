import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";
import type { SvgInspection } from "./types.js";

const ALLOWED_CLIP_CHILDREN = new Set(["path", "rect", "circle", "g"]);
const TRANSFERRED_PROPERTIES = ["fill", "fill-opacity", "opacity", "fill-rule", "transform"] as const;

function elements(root: XmlDocument | XmlElement, tagName = "*"): XmlElement[] {
  const nodes = root.getElementsByTagName(tagName);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index)).filter(
    (node): node is XmlElement => node !== null,
  );
}

function parseXml(svg: string): XmlDocument {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") errors.push(message);
    },
  }).parseFromString(svg, "image/svg+xml");
  if (errors.length > 0 || document.documentElement?.localName !== "svg") {
    throw new Error(`Invalid SVG XML: ${errors.join("; ") || "root element is not <svg>"}`);
  }
  return document;
}

function styleMap(style: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) result.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
  }
  return result;
}

function urlReference(element: XmlElement, property: "clip-path" | "mask"): string | null {
  const direct = element.getAttribute(property);
  const styled = styleMap(element.getAttribute("style") || "").get(property);
  const value = direct || styled;
  if (!value || value === "none") return null;
  const match = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(value);
  if (!match?.[1]) throw new Error(`Unsupported ${property} value: ${value}`);
  return match[1];
}

function isKnownQrClip(id: string): boolean {
  return /^clip-path-(?:background-color|dot-color|corners-square-color|corners-dot-color)-/.test(id);
}

function isTransparent(element: XmlElement): boolean {
  const fill = element.getAttribute("fill") || styleMap(element.getAttribute("style") || "").get("fill");
  return fill === "transparent" || fill === "none";
}

export function closeKnownQrPathData(d: string): string {
  const parts = d.match(/[Mm][^Mm]*/g);
  if (!parts?.length) throw new Error("Known QR path has no moveto command");
  return parts.map((part) => {
    const trimmed = part.trim();
    return /[Zz]\s*$/.test(trimmed) ? trimmed : `${trimmed} Z`;
  }).join(" ");
}

function normalizeClone(element: XmlElement): void {
  if (element.localName === "path") {
    const d = element.getAttribute("d");
    if (!d) throw new Error("QR clipPath contains a path without d");
    element.setAttribute("d", closeKnownQrPathData(d));
  }
  if (element.hasAttribute("clip-rule")) {
    element.setAttribute("fill-rule", element.getAttribute("clip-rule") || "evenodd");
    element.removeAttribute("clip-rule");
  }
  for (const child of elements(element)) normalizeClone(child);
}

function transferPaint(source: XmlElement, target: XmlElement): void {
  const styles = styleMap(source.getAttribute("style") || "");
  for (const property of TRANSFERRED_PROPERTIES) {
    const value = source.getAttribute(property) || styles.get(property);
    if (value && !target.hasAttribute(property)) target.setAttribute(property, value);
  }
  if (!target.hasAttribute("fill")) target.setAttribute("fill", "#000000");
  target.setAttribute("stroke", "none");
}

function removePresentationReference(element: XmlElement, property: "clip-path" | "mask"): void {
  element.removeAttribute(property);
  const styles = styleMap(element.getAttribute("style") || "");
  if (styles.delete(property)) {
    const serialized = [...styles].map(([key, value]) => `${key}:${value}`).join(";");
    if (serialized) element.setAttribute("style", serialized);
    else element.removeAttribute("style");
  }
}

export function flattenQrCodeStylingSvg(svg: string): string {
  const document = parseXml(svg);
  const root = document.documentElement;
  if (!root) throw new Error("Invalid SVG XML: missing root element");
  const originalViewBox = root.getAttribute("viewBox");
  const clipById = new Map<string, XmlElement>();
  for (const clip of elements(document, "clipPath")) {
    const id = clip.getAttribute("id");
    if (id) clipById.set(id, clip);
  }

  const carriers = elements(document).filter((element) => urlReference(element, "clip-path") !== null);
  if (carriers.length === 0) throw new Error("Unknown qr-code-styling SVG: no clip-path paint carriers found");

  for (const carrier of carriers) {
    const clipId = urlReference(carrier, "clip-path");
    if (!clipId || !isKnownQrClip(clipId)) {
      throw new Error(`Unknown qr-code-styling clip-path structure: ${clipId || "missing ID"}`);
    }
    const clip = clipById.get(clipId);
    if (!clip) throw new Error(`Referenced clipPath #${clipId} was not found`);
    if (carrier.localName !== "rect") {
      throw new Error(`Unknown qr-code-styling paint carrier <${carrier.localName}> for #${clipId}`);
    }
    const isBackground = clipId.startsWith("clip-path-background-color-");
    if (!isBackground && !isTransparent(carrier)) {
      const directChildren = Array.from({ length: clip.childNodes.length }, (_, index) => clip.childNodes.item(index))
        .filter((node): node is XmlElement => node?.nodeType === 1);
      if (!directChildren.length) throw new Error(`clipPath #${clipId} has no geometry`);
      for (const child of directChildren) {
        if (!ALLOWED_CLIP_CHILDREN.has(child.localName || child.tagName)) {
          throw new Error(`Unsupported <${child.localName}> inside qr-code-styling clipPath #${clipId}`);
        }
        const clone = child.cloneNode(true) as XmlElement;
        normalizeClone(clone);
        transferPaint(carrier, clone);
        carrier.parentNode?.insertBefore(clone, carrier);
      }
    }
    carrier.parentNode?.removeChild(carrier);
  }

  for (const element of elements(document)) {
    removePresentationReference(element, "clip-path");
    removePresentationReference(element, "mask");
  }
  for (const tag of ["clipPath", "mask"]) {
    for (const element of elements(document, tag)) element.parentNode?.removeChild(element);
  }
  for (const defs of elements(document, "defs")) {
    if (!elements(defs).length && !defs.textContent?.trim()) defs.parentNode?.removeChild(defs);
  }
  if (root.getAttribute("viewBox") !== originalViewBox) throw new Error("SVG viewBox changed while flattening");
  return new XMLSerializer().serializeToString(document);
}

export function pathDataIsClosed(d: string): boolean {
  const commands = [...d.matchAll(/[MmZz]/g)];
  const moves = commands.filter((match) => /[Mm]/.test(match[0]));
  if (!moves.length) return false;
  for (let index = 0; index < moves.length; index += 1) {
    const start = moves[index]?.index ?? 0;
    const end = moves[index + 1]?.index ?? d.length;
    if (!/[Zz]\s*$/.test(d.slice(start, end).trim())) return false;
  }
  return true;
}

export function inspectSvg(svg: string, expectedViewBox?: string): SvgInspection {
  const document = parseXml(svg);
  const root = document.documentElement;
  if (!root) throw new Error("Invalid SVG XML: missing root element");
  const paths = elements(document, "path");
  const containsClipPath = elements(document, "clipPath").length > 0
    || elements(document).some((element) => urlReference(element, "clip-path") !== null);
  const containsMask = elements(document, "mask").length > 0
    || elements(document).some((element) => urlReference(element, "mask") !== null);
  const forbiddenTags = ["filter", "image", "use"].filter((tag) => elements(document, tag).length > 0);
  if (forbiddenTags.length) throw new Error(`Final SVG contains forbidden elements: ${forbiddenTags.join(", ")}`);
  if (elements(document, "rect").length || elements(document, "circle").length || elements(document, "ellipse").length) {
    throw new Error("Final SVG still contains shapes that were not converted to paths");
  }
  if (!paths.length) throw new Error("Final SVG contains no paths");
  if (expectedViewBox !== undefined && root.getAttribute("viewBox") !== expectedViewBox) {
    throw new Error(`Final SVG viewBox changed: expected \"${expectedViewBox}\", got \"${root.getAttribute("viewBox")}\"`);
  }
  for (const path of paths) {
    const stroke = path.getAttribute("stroke");
    const style = styleMap(path.getAttribute("style") || "");
    if ((stroke && stroke !== "none") || (style.get("stroke") && style.get("stroke") !== "none")) {
      throw new Error("Final SVG contains a stroked production path");
    }
  }
  return {
    viewBox: root.getAttribute("viewBox") || "",
    pathCount: paths.length,
    containsClipPath,
    containsMask,
    allPathsClosed: paths.every((path) => pathDataIsClosed(path.getAttribute("d") || "")),
  };
}
