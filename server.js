// Bluekazi Profile Merge Service
//
// Two capabilities:
//
// 1) POST /merge — legacy endpoint. Merges given documents (PDFs/images, in order)
//    into one PDF. Unchanged from before.
//
// 2) POST /profile-pdf — NEW. Renders a candidate profile (profile_de / profile_en
//    JSON, produced by n8n/OpenAI) into a formatted PDF page, then appends the
//    candidate's original source documents (rasterized page-by-page, with targeted
//    black-box redactions applied at coordinates n8n already computed), producing
//    ONE final PDF: [profile page(s)] + [document 1 pages] + [document 2 pages] + ...
//
// This service has NO Google Drive or OpenAI credentials of its own. n8n does all
// downloading and all "where are the sensitive numbers" detection (via OpenAI
// Vision) and just sends this service base64 documents + redaction box coordinates.
// This service only renders/rasterizes/draws boxes/merges — it does not "look at"
// or interpret document content.
//
// Redaction box coordinates are FRACTIONS (0..1) of the page's/image's own width
// and height, 1-indexed "page" referring to the position within that single
// document (most source docs are 1 page). Example:
//   { "page": 1, "x": 0.62, "y": 0.81, "width": 0.30, "height": 0.05 }
// means: a box starting at 62% across / 81% down the page, 30% wide, 5% tall.

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const sharp = require("sharp");

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: "80mb" }));

const SHARED_TOKEN = process.env.MERGE_SERVICE_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.PROFILE_RENDERER_BASE_URL || "").replace(/\/+$/, "");
const TEMP_IMAGE_DIR = process.env.TEMP_IMAGE_DIR || path.join("/tmp", "bluekazi-profile-renderer-images");
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 25 * 1024 * 1024);
const RASTER_DPI = Number(process.env.PDF_RASTER_DPI || 150);

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
    throw new Error("Expected base64 data as a string");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Base64 data is empty");
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
    throw new Error("Base64 data contains unsupported characters");
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

// A4 in PDF points
const A4_W = 595.28;
const A4_H = 841.89;
const PAGE_MARGIN = 40;

async function imageBufferToPdfBytes(pngBuffer) {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(pngBuffer);
  const { width, height } = png;
  const maxW = A4_W - PAGE_MARGIN * 2;
  const maxH = A4_H - PAGE_MARGIN * 2;
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

// ---------------------------------------------------------------------------
// PDF -> page images, via poppler's pdftoppm (system binary, no native Node
// build deps — see nixpacks.toml which installs poppler-utils).
// ---------------------------------------------------------------------------
async function rasterizePdfToPngBuffers(pdfBuffer, requestId) {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bluekazi-raster-"));
  const inputPath = path.join(workDir, "input.pdf");
  const outputPrefix = path.join(workDir, "page");
  try {
    await fs.promises.writeFile(inputPath, pdfBuffer);
    await execFileAsync("pdftoppm", ["-png", "-r", String(RASTER_DPI), inputPath, outputPrefix], {
      maxBuffer: 1024 * 1024 * 200,
    });
    const files = (await fs.promises.readdir(workDir))
      .filter((name) => name.startsWith("page") && name.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!files.length) {
      throw new Error("pdftoppm produced no page images");
    }
    const buffers = [];
    for (const file of files) {
      buffers.push(await fs.promises.readFile(path.join(workDir, file)));
    }
    logWithRequestId(requestId, `Rasterized PDF into ${buffers.length} page image(s)`);
    return buffers;
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Apply black-box redactions to a single page image. Boxes are fractions
// (0..1) of that image's own width/height.
// ---------------------------------------------------------------------------
async function applyRedactionBoxes(pngBuffer, boxes) {
  if (!Array.isArray(boxes) || !boxes.length) return pngBuffer;
  const image = sharp(pngBuffer);
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) return pngBuffer;

  const overlays = [];
  for (const box of boxes) {
    const bx = Math.max(0, Math.min(1, Number(box?.x) || 0));
    const by = Math.max(0, Math.min(1, Number(box?.y) || 0));
    const bw = Math.max(0, Math.min(1 - bx, Number(box?.width) || 0));
    const bh = Math.max(0, Math.min(1 - by, Number(box?.height) || 0));
    if (bw <= 0 || bh <= 0) continue;
    const pxW = Math.max(1, Math.round(bw * width));
    const pxH = Math.max(1, Math.round(bh * height));
    const pxX = Math.round(bx * width);
    const pxY = Math.round(by * height);
    const rect = await sharp({
      create: { width: pxW, height: pxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    overlays.push({ input: rect, left: pxX, top: pxY });
  }
  if (!overlays.length) return pngBuffer;
  return image.composite(overlays).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Redact + convert one source document (PDF or image) into an array of
// finished PDF page byte-blobs (each single-page), respecting per-page
// redaction boxes. "page" in redactionBoxes is 1-indexed; boxes without an
// explicit page apply to page 1.
// ---------------------------------------------------------------------------
async function documentToRedactedPdfPages(doc, requestId) {
  const buffer = Buffer.from(doc.data, "base64");
  const redactionBoxes = Array.isArray(doc.redactionBoxes) ? doc.redactionBoxes : [];
  const boxesByPage = new Map();
  for (const box of redactionBoxes) {
    const pageNum = Number.isInteger(box?.page) && box.page > 0 ? box.page : 1;
    if (!boxesByPage.has(pageNum)) boxesByPage.set(pageNum, []);
    boxesByPage.get(pageNum).push(box);
  }

  let pageImages;
  if (isPdfMime(doc.mimeType)) {
    pageImages = await rasterizePdfToPngBuffers(buffer, requestId);
  } else if (isImageMime(doc.mimeType)) {
    pageImages = [await normalizeImageToPngBuffer(buffer)];
  } else {
    logWithRequestId(requestId, `Skipping unsupported mimeType "${doc.mimeType}" for "${doc.fileName || doc.name}"`);
    return [];
  }

  const pdfPageBytesList = [];
  for (let i = 0; i < pageImages.length; i += 1) {
    const pageNum = i + 1;
    const boxes = boxesByPage.get(pageNum) || [];
    const redacted = await applyRedactionBoxes(pageImages[i], boxes);
    pdfPageBytesList.push(await imageBufferToPdfBytes(redacted));
  }
  return pdfPageBytesList;
}

// ---------------------------------------------------------------------------
// Profile JSON -> formatted PDF page(s), via pdf-lib text layout.
// ---------------------------------------------------------------------------
function wrapTextLines(text, font, fontSize, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function renderProfilePdf(profile) {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const maxWidth = A4_W - PAGE_MARGIN * 2;
  const colorDark = rgb(0.13, 0.13, 0.15);
  const colorMuted = rgb(0.38, 0.38, 0.4);
  const colorAccent = rgb(0.02, 0.29, 0.55);

  let page = doc.addPage([A4_W, A4_H]);
  let y = A4_H - PAGE_MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < PAGE_MARGIN) {
      page = doc.addPage([A4_W, A4_H]);
      y = A4_H - PAGE_MARGIN;
    }
  };

  const drawParagraph = (text, { size = 10.5, font = fontRegular, color = colorDark, gap = 6, lineHeight = 1.35 } = {}) => {
    const lines = wrapTextLines(text, font, size, maxWidth);
    for (const line of lines) {
      ensureSpace(size * lineHeight);
      page.drawText(line, { x: PAGE_MARGIN, y, size, font, color });
      y -= size * lineHeight;
    }
    y -= gap;
  };

  const drawBullet = (text, { size = 10, font = fontRegular, color = colorDark } = {}) => {
    const bulletIndent = 14;
    const lines = wrapTextLines(text, font, size, maxWidth - bulletIndent);
    lines.forEach((line, index) => {
      ensureSpace(size * 1.35);
      const prefix = index === 0 ? "\u2022 " : "  ";
      page.drawText(prefix + line, { x: PAGE_MARGIN + (index === 0 ? 0 : bulletIndent), y, size, font, color });
      y -= size * 1.35;
    });
  };

  const drawHeading = (text, { size = 13, gapBefore = 14, gapAfter = 6 } = {}) => {
    ensureSpace(size + gapBefore);
    y -= gapBefore;
    page.drawText(text, { x: PAGE_MARGIN, y, size, font: fontBold, color: colorAccent });
    y -= size + gapAfter;
  };

  // --- Header ---
  ensureSpace(30);
  page.drawText(profile.display_name || "", { x: PAGE_MARGIN, y, size: 20, font: fontBold, color: colorDark });
  y -= 26;
  if (profile.headline) {
    drawParagraph(profile.headline, { size: 12, font: fontRegular, color: colorMuted, gap: 10 });
  }

  // --- Candidate facts ---
  const c = profile.candidate || {};
  const factLine = [c.target_role, c.nationality, c.country_of_residence].filter(Boolean).join("  \u2022  ");
  if (factLine) drawParagraph(factLine, { size: 10.5, color: colorMuted, gap: 4 });
  if (c.driving_license) drawParagraph(`Driving license: ${c.driving_license}`, { size: 10.5, color: colorMuted, gap: 10 });

  // --- Top facts ---
  const topFacts = (profile.top_facts || []).filter((f) => f?.public_visible !== false || f?.logged_in_visible !== false);
  if (topFacts.length) {
    drawHeading("Highlights");
    for (const fact of topFacts) {
      drawBullet(`${fact.label}: ${fact.value}`);
    }
    y -= 4;
  }

  // --- Sections (summary, languages, etc.) ---
  for (const section of profile.sections || []) {
    drawHeading(section.title || "");
    for (const para of section.paragraphs || []) {
      drawParagraph(para);
    }
    for (const bullet of section.bullets || []) {
      drawBullet(bullet);
    }
  }

  // --- Professional experience ---
  if ((profile.professional_experience || []).length) {
    drawHeading("Professional Experience");
    for (const role of profile.professional_experience) {
      ensureSpace(14);
      const titleLine = [role.role, role.organization].filter(Boolean).join(" \u2014 ");
      page.drawText(titleLine, { x: PAGE_MARGIN, y, size: 11, font: fontBold, color: colorDark });
      y -= 14;
      const subLine = [role.location, role.period].filter(Boolean).join("  \u2022  ");
      if (subLine) {
        drawParagraph(subLine, { size: 9.5, color: colorMuted, gap: 4 });
      }
      for (const bullet of role.bullets || []) {
        drawBullet(bullet, { size: 9.5 });
      }
      y -= 6;
    }
  }

  // --- Education ---
  if ((profile.education || []).length) {
    drawHeading("Education");
    for (const edu of profile.education) {
      ensureSpace(14);
      const titleLine = [edu.title, edu.institution].filter(Boolean).join(" \u2014 ");
      page.drawText(titleLine, { x: PAGE_MARGIN, y, size: 11, font: fontBold, color: colorDark });
      y -= 14;
      if (edu.period) drawParagraph(edu.period, { size: 9.5, color: colorMuted, gap: 4 });
      for (const detail of edu.details || []) {
        drawBullet(detail, { size: 9.5 });
      }
      y -= 6;
    }
  }

  // --- Documents on file (metadata only, actual scans follow as pages) ---
  if ((profile.documents || []).length) {
    drawHeading("Documents on File");
    for (const d of profile.documents) {
      drawBullet(`${d.document_type || d.document_kind || "Document"} \u2014 ${d.status || "available"}`, { size: 9.5 });
    }
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Merge N sets of single-page PDF bytes (each element of pdfByteArrays is a
// full PDFDocument's .save() output) into one PDFDocument, in order.
// ---------------------------------------------------------------------------
async function mergePdfByteArrays(pdfByteArrays) {
  const finalDoc = await PDFDocument.create();
  for (const bytes of pdfByteArrays) {
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await finalDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach((p) => finalDoc.addPage(p));
  }
  return finalDoc.save();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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
        sourcePdfBytes = await imageBufferToPdfBytes(await normalizeImageToPngBuffer(buffer));
      } else {
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

app.post("/profile-pdf", async (req, res) => {
  const requestId = (req.body?.request_id && String(req.body.request_id)) || createRequestId();
  try {
    if (!ensureAuthorized(req)) {
      return res.status(401).json({ error: "Invalid or missing token" });
    }

    const pdfLanguage = (req.body?.profile?.pdfLanguage || "en").toLowerCase();
    const profile = pdfLanguage === "de" ? req.body?.profile?.profile_de : req.body?.profile?.profile_en;
    if (!profile) {
      return res.status(400).json({ error: `profile.profile_${pdfLanguage} is required` });
    }

    const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];

    logWithRequestId(requestId, "Rendering profile page", {
      displayName: profile.display_name,
      pdfLanguage,
      documentCount: documents.length,
    });

    const profilePdfBytes = await renderProfilePdf(profile);
    const pdfByteArrays = [profilePdfBytes];

    for (const doc of documents) {
      if (!doc?.data) continue;
      try {
        const pages = await documentToRedactedPdfPages(doc, requestId);
        pdfByteArrays.push(...pages);
      } catch (docErr) {
        logWithRequestId(requestId, `Failed to process document "${doc.fileName || doc.name}", skipping`, String(docErr?.message || docErr));
      }
    }

    const mergedBytes = await mergePdfByteArrays(pdfByteArrays);
    logWithRequestId(requestId, `Final profile PDF built: ${pdfByteArrays.length} source blob(s) merged`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.body?.output?.fileName || "profile.pdf"}"`);
    res.send(Buffer.from(mergedBytes));
  } catch (err) {
    console.error(`[${requestId}]`, err);
    res.status(500).json({ error: "Profile PDF generation failed", details: String(err?.message || err) });
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
