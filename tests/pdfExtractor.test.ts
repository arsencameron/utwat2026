import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractTextFromPdf } from "../src/util/pdfExtractor.js";

describe("pdfExtractor (Mozilla pdfjs-dist)", () => {
  const samplePdfPath = path.join(process.cwd(), "data", "uploads", "arsen_cameron.pdf");

  test("extracts text from uploaded PDF buffer", async () => {
    if (!fs.existsSync(samplePdfPath)) {
      return; // Skip if file doesn't exist
    }

    const buffer = fs.readFileSync(samplePdfPath);
    const text = await extractTextFromPdf(buffer);

    assert.ok(text.length > 100, "Should extract substantive text");
    assert.ok(text.includes("arsen.cameron@mail.utoronto.ca"), "Should contain candidate email");
    assert.ok(text.includes("Toronto"), "Should contain candidate location / school");
  });
});
