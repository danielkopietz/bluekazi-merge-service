// Bluekazi Profile Merge Service
// Merges a generated profile PDF with the candidate's original source documents
// (PDFs and images, in a given order) into one final multi-page PDF.
//
// It has NO Google Drive credentials of its own — n8n downloads all files
// (using the existing "Google Drive Bluekazi" credential) and sends them here
// as base64. This keeps all Google auth inside n8n, where it already lives.
//
// POST /merge
// Body: {
//   "token": "shared-secret-from-env",
//   "documents": [
//     { "name": "profile.pdf", "mimeType": "application/pdf", "data": "<base64>" },
//     { "name": "passport.jpg", "mimeType": "image/jpeg", "data": "<base64>" },
//     { "name": "diploma.pdf", "mimeType": "application/pdf", "data": "<base64>" }
//   ]
// }
// Order of the "documents" array = order of pages in the final PDF.
// Response: application/pdf (binary)

const express = require("express");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");

const app = express();
app.use(express.json({ limit: "80mb" }));

const SHARED_TOKEN = process.env.MERGE_SERVICE_TOKEN || "";

function isImageMime(mimeType) {
  return /^image\/(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(mimeType || "");
}

function isPdfMime(mimeType) {
  return mimeType === "application/pdf";
}

async function imageBufferToPdfBytes(buffer) {
  // Normalize any input image format to PNG first via sharp,
  // so pdf-lib (which only embeds PNG/JPG) always gets something it accepts.
  const pngBuffer = await sharp(buffer).rotate().png().toBuffer();
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(pngBuffer);
  const { width, height } = png;

  // Fit onto an A4 page, preserving aspect ratio, centered.
  const A4_W = 595.28;
  const A4_H = 841.89;
  const margin = 24;
  const maxW = A4_W - margin * 2;
  const maxH = A4_H - margin * 2;
  const scale = Math.min(maxW / width, maxH / height, 1);
  const drawW = width * scale;
  const drawH = height * scale;

  const page = doc.addPage([A4_W, A4_H]);
  page.drawImage(png, {
    x: (A4_W - drawW) / 2,
    y: (A4_H - drawH) / 2,
    width: drawW,
    height: drawH,
  });
  return doc.save();
}

app.post("/merge", async (req, res) => {
  try {
    if (SHARED_TOKEN) {
      const provided = req.body?.token || req.headers["x-merge-token"];
      if (provided !== SHARED_TOKEN) {
        return res.status(401).json({ error: "Invalid or missing token" });
      }
    }

    const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];
    if (!documents.length) {
      return res.status(400).json({ error: "documents[] is required" });
    }

    const finalDoc = await PDFDocument.create();

    for (const doc of documents) {
      if (!doc?.data) continue;
      const buffer = Buffer.from(doc.data, "base64");

      let sourcePdfBytes;
      if (isPdfMime(doc.mimeType)) {
        sourcePdfBytes = buffer;
      } else if (isImageMime(doc.mimeType)) {
        sourcePdfBytes = await imageBufferToPdfBytes(buffer);
      } else {
        // Unknown type (e.g. .docx that slipped through) — skip rather than fail the whole merge.
        console.warn(`Skipping unsupported mimeType "${doc.mimeType}" for "${doc.name}"`);
        continue;
      }

      const srcDoc = await PDFDocument.load(sourcePdfBytes, { ignoreEncryption: true });
      const pages = await finalDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach((p) => finalDoc.addPage(p));
    }

    if (finalDoc.getPageCount() === 0) {
      return res.status(422).json({ error: "No mergeable pages produced from input documents" });
    }

    const mergedBytes = await finalDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(mergedBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Merge failed", details: String(err?.message || err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8088;
app.listen(PORT, () => console.log(`Profile merge service listening on :${PORT}`));
