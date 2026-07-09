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
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");

const app = express();
app.use(express.json({ limit: "80mb" }));

const SHARED_TOKEN = process.env.MERGE_SERVICE_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.PROFILE_RENDERER_BASE_URL || "").replace(/\/+$/, "");
const TEMP_IMAGE_DIR = process.env.TEMP_IMAGE_DIR || path.join("/tmp", "bluekazi-profile-renderer-images");
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 25 * 1024 * 1024);

fs.mkdirSync(TEMP_IMAGE_DIR, { recursive: true });

function isImageMime(mimeType) {
  return /^image\/(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(mimeType || "");
}

function isPdfMime(mimeType) {
  return mimeType === "application/pdf";
}

function ensureAuthorized(req) {
  if (!SHARED_TOKEN) return true;
  const provided = req.body?.token || req.query?.token || req.headers["x-merge-token"];
  return provided === SHARED_TOKEN;
}

function createRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

function logWithRequestId(requestId, message, extra = undefined) {
  if (extra === undefined) {
    console.log(`[${requestId}] ${message}`);
    return;
  }
  console.log(`[${requestId}] ${message}`, extra);
}

function normalizeBase64String(input) {
  if (typeof input !== "string") {
    throw new Error("Expected base64 image data as a string");
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Base64 image data is empty");
  }

  const dataUriMatch = trimmed.match(/^data:([^;,]+)?(;base64)?,(.*)$/is);
  let mimeTypeFromDataUri = null;
  let payload = trimmed;
  if (dataUriMatch) {
    mimeTypeFromDataUri = (dataUriMatch[1] || "").trim().toLowerCase() || null;
    payload = dataUriMatch[3] || "";
  }

  payload = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const remainder = payload.length % 4;
  if (remainder) {
    payload += "=".repeat(4 - remainder);
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
    throw new Error("Base64 image data contains unsupported characters");
  }

  return { payload, mimeTypeFromDataUri };
}

function decodeBase64ToBuffer(input, label = "payload") {
  const { payload, mimeTypeFromDataUri } = normalizeBase64String(input);
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) {
    throw new Error(`${label} decoded to an empty buffer`);
  }
  return { buffer, mimeTypeFromDataUri, normalizedLength: payload.length };
}

async function normalizeImageToPngBuffer(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) {
    throw new Error("Image buffer is empty");
  }
  if (inputBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image buffer exceeds MAX_IMAGE_BYTES (${MAX_IMAGE_BYTES})`);
  }

  const image = sharp(inputBuffer, { failOnError: true, animated: false });
  const metadata = await image.metadata();
  if (!metadata?.width || !metadata?.height) {
    throw new Error("Image metadata is incomplete");
  }

  return image.rotate().png().toBuffer();
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
}

async function imageBufferToPdfBytes(buffer) {
  // Normalize any input image format to PNG first via sharp,
  // so pdf-lib (which only embeds PNG/JPG) always gets something it accepts.
  const pngBuffer = await normalizeImageToPngBuffer(buffer);
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
    if (!ensureAuthorized(req)) {
      return res.status(401).json({ error: "Invalid or missing token" });
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

app.post("/publish-image", async (req, res) => {
  const requestId = createRequestId();
  try {
    if (!ensureAuthorized(req)) {
      return res.status(401).json({ error: "Invalid or missing token" });
    }

    const role = (req.body?.role || "image").toString();
    const providedMimeType = (req.body?.mimeType || "image/png").toString().toLowerCase();
    const data = req.body?.data;
    if (!data || !isImageMime(providedMimeType)) {
      return res.status(400).json({ error: "A supported image mimeType and base64 data are required" });
    }

    const decoded = decodeBase64ToBuffer(data, "publish-image data");
    const effectiveMimeType = decoded.mimeTypeFromDataUri || providedMimeType;
    if (!isImageMime(effectiveMimeType)) {
      return res.status(400).json({ error: `Unsupported image mimeType "${effectiveMimeType}"` });
    }

    logWithRequestId(requestId, "Publishing temporary image", {
      role,
      fileName: req.body?.fileName || null,
      providedMimeType,
      effectiveMimeType,
      decodedBytes: decoded.buffer.length,
      normalizedBase64Length: decoded.normalizedLength,
    });

    const normalizedBuffer = await normalizeImageToPngBuffer(decoded.buffer);
    const tempImageId = crypto.randomUUID();
    const fileName = `${tempImageId}.png`;
    const filePath = path.join(TEMP_IMAGE_DIR, fileName);
    fs.writeFileSync(filePath, normalizedBuffer);

    const publicBaseUrl = getPublicBaseUrl(req).replace(/\/+$/, "");
    logWithRequestId(requestId, "Temporary image published", {
      tempImageId,
      filePath,
      publicUrl: `${publicBaseUrl}/temp-images/${fileName}`,
      outputBytes: normalizedBuffer.length,
    });
    res.json({
      ok: true,
      role,
      tempImageId,
      mimeType: "image/png",
      publicUrl: `${publicBaseUrl}/temp-images/${fileName}`,
    });
  } catch (err) {
    console.error(`[${requestId}] Image publish failed`, err);
    res.status(500).json({ error: "Image publish failed", details: String(err?.message || err) });
  }
});

app.get("/temp-images/:fileName", (req, res) => {
  const fileName = path.basename(req.params.fileName || "");
  const filePath = path.join(TEMP_IMAGE_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Image not found" });
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(filePath);
});

app.delete("/publish-image/:tempImageId", (req, res) => {
  try {
    if (!ensureAuthorized(req)) {
      return res.status(401).json({ error: "Invalid or missing token" });
    }
    const tempImageId = path.basename(req.params.tempImageId || "");
    if (!tempImageId) {
      return res.status(400).json({ error: "tempImageId is required" });
    }
    const filePath = path.join(TEMP_IMAGE_DIR, `${tempImageId}.png`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true, tempImageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image cleanup failed", details: String(err?.message || err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, tempImageDir: TEMP_IMAGE_DIR }));

const PORT = process.env.PORT || 8088;
app.listen(PORT, () => console.log(`Profile merge service listening on :${PORT}`));
