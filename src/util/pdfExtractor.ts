import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extracts raw text from a PDF buffer page by page using Mozilla's pdfjs-dist.
 */
export async function extractTextFromPdf(
  pdfBuffer: Buffer | ArrayBuffer | Uint8Array
): Promise<string> {
  let data: Uint8Array;
  if (Buffer.isBuffer(pdfBuffer)) {
    data = new Uint8Array(
      pdfBuffer.buffer.slice(
        pdfBuffer.byteOffset,
        pdfBuffer.byteOffset + pdfBuffer.byteLength
      )
    );
  } else if (pdfBuffer instanceof Uint8Array) {
    data = new Uint8Array(
      pdfBuffer.buffer.slice(
        pdfBuffer.byteOffset,
        pdfBuffer.byteOffset + pdfBuffer.byteLength
      )
    );
  } else {
    data = new Uint8Array(pdfBuffer);
  }

  const loadingTask = pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  });

  const pdf = await loadingTask.promise;
  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => (typeof item.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    fullText += `--- Page ${i} ---\n${pageText}\n\n`;
  }

  return fullText.trim();
}
