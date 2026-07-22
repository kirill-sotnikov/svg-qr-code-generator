import { JSDOM } from "jsdom";
import type { ErrorCorrectionLevel, FileExtension, Options } from "qr-code-styling";
import QRCodeStyling from "qr-code-styling";

export async function generateQrSvg(
  payload: string,
  size = 300,
  errorCorrectionLevel: ErrorCorrectionLevel = "Q",
): Promise<string> {
  const Constructor = QRCodeStyling as unknown as new (options?: Partial<Options>) => {
    getRawData(extension?: FileExtension): Promise<Blob | Buffer | null>;
  };
  const qr = new Constructor({
    jsdom: JSDOM,
    type: "svg",
    width: size,
    height: size,
    margin: 0,
    data: payload,
    qrOptions: { errorCorrectionLevel },
    dotsOptions: { type: "extra-rounded", color: "#000000" },
    cornersSquareOptions: { type: "extra-rounded", color: "#000000" },
    cornersDotOptions: {  color: "#000000" },
    backgroundOptions: { color: "transparent" },
  });
  const raw = await qr.getRawData("svg");
  if (!raw) throw new Error("qr-code-styling returned no SVG data");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(await raw.arrayBuffer()).toString("utf8");
}
