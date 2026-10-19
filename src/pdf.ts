import { PDFDocument } from "@cantoo/pdf-lib";

export class PdfPasswordError extends Error {
  constructor(public reason: "required" | "incorrect") {
    super(
      reason === "required"
        ? "Das PDF ist passwortgeschützt. Bitte das Passwort im Parameter password mitgeben."
        : "Das angegebene PDF-Passwort ist falsch.",
    );
  }
}

const latin1 = new TextDecoder("latin1");

export function isPdf(buf: Uint8Array): boolean {
  return latin1.decode(buf.subarray(0, 1024)).includes("%PDF-");
}

/** Looks for an /Encrypt entry in the trailer regions (start for linearized files, end for the rest). */
export function isEncryptedPdf(buf: Uint8Array): boolean {
  const head = latin1.decode(buf.subarray(0, 4096));
  const tail = latin1.decode(buf.subarray(Math.max(0, buf.length - 65536)));
  return head.includes("/Encrypt") || tail.includes("/Encrypt");
}

/**
 * Returns an unencrypted copy of the PDF. Tries the given password first and then the empty one,
 * which covers files that only carry an owner password (print or copy restrictions).
 */
export async function decryptPdf(buf: Uint8Array, password?: string): Promise<Uint8Array> {
  const candidates = password ? [password, ""] : [""];
  for (const pw of candidates) {
    try {
      const doc = await PDFDocument.load(buf, { password: pw });
      return await doc.save();
    } catch (e) {
      if (!/password/i.test((e as Error).message)) throw e;
    }
  }
  throw new PdfPasswordError(password ? "incorrect" : "required");
}
