import { createRequire } from "node:module";
import type { DecodeHintType as DecodeHintTypeValue } from "@zxing/library";
import sharp from "sharp";

// @zxing/library is CommonJS. Loading it through createRequire works on every
// supported Node.js release instead of relying on version-specific named-export
// detection for CommonJS modules.
const require = createRequire(import.meta.url);
const {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} = require("@zxing/library") as typeof import("@zxing/library");

export async function decodeQrPng(filePath: string): Promise<string> {
  const metadata = await sharp(filePath).metadata();
  const nativeWidth = metadata.width;
  const nativeHeight = metadata.height;
  if (!nativeWidth || !nativeHeight) throw new Error("PNG has no dimensions");
  if (nativeWidth !== nativeHeight) throw new Error("QR preview PNG must be square");
  const targets = [nativeWidth, ...(nativeWidth > 768 ? [768, 512] : [])];
  let lastError: unknown;
  for (const target of targets) {
    try {
      return await decodePixels(filePath, target === nativeWidth ? undefined : target);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("QR code was not detected");
}

async function decodePixels(filePath: string, resizeTo?: number): Promise<string> {
  let image = sharp(filePath).greyscale();
  if (resizeTo !== undefined) {
    image = image.resize(resizeTo, resizeTo, { fit: "fill", kernel: "nearest" });
  }
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const source = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const hints = new Map<DecodeHintTypeValue, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const decoded = new QRCodeReader().decode(bitmap, hints).getText();
  if (!decoded) throw new Error("QR decoder returned an empty payload");
  return decoded;
}

export function payloadMatches(decoded: string, expected: string): boolean {
  return decoded === expected;
}
