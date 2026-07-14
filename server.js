// Bluekazi Profile Merge Service
//
// Capabilities:
//
// 1) POST /merge — legacy endpoint. Merges given documents (PDFs/images, in order)
//    into one PDF. Unchanged.
//
// 2) POST /profile-pdf — renders a full branded candidate profile:
//      [branded cover + profile pages] + [document 1 pages] + [document 2 pages] + ...
//    - Cover page: Bluekazi logo, candidate photo (if available), core fields
//    - Profile pages: headline, highlights, experience, education, skills,
//      document status, manual review notes
//    - Source documents: rasterized page-by-page, with targeted black-box
//      redactions applied at coordinates n8n already computed via Vision
//
// This service has NO Google Drive or OpenAI credentials of its own. n8n does all
// downloading and all "where are the sensitive numbers / where is the candidate's
// face" detection (via OpenAI Vision) and just sends this service base64
// documents + box coordinates. This service only renders/rasterizes/crops/draws
// boxes/merges — it does not itself interpret document content.
//
// Box coordinates (redactionBoxes, candidatePhoto.cropBox) are FRACTIONS (0..1)
// of that page's own width/height, "page" is 1-indexed within that document.

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const sharp = require("sharp");
const { BLUEKAZI_LOGO_PNG_BASE64 } = require("./assets/logo");

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
  if (extra === undefined) console.log(`[${requestId}] ${message}`);
  else console.log(`[${requestId}] ${message}`, extra);
}

function normalizeBase64String(input) {
  if (typeof input !== "string") throw new Error("Expected base64 data as a string");
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Base64 data is empty");
  const dataUriMatch = trimmed.match(/^data:([^;,]+)?(;base64)?,(.*)$/is);
  let mimeTypeFromDataUri = null;
  let payload = trimmed;
  if (dataUriMatch) {
    mimeTypeFromDataUri = (dataUriMatch[1] || "").trim().toLowerCase() || null;
    payload = dataUriMatch[3] || "";
  }
  payload = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const remainder = payload.length % 4;
  if (remainder) payload += "=".repeat(4 - remainder);
  if (!/^[A-Za-z0-9+/=]+$/.test(payload)) throw new Error("Base64 data contains unsupported characters");
  return { payload, mimeTypeFromDataUri };
}

function decodeBase64ToBuffer(input, label = "payload") {
  const { payload, mimeTypeFromDataUri } = normalizeBase64String(input);
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new Error(`${label} decoded to an empty buffer`);
  return { buffer, mimeTypeFromDataUri, normalizedLength: payload.length };
}

async function normalizeImageToPngBuffer(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) throw new Error("Image buffer is empty");
  if (inputBuffer.length > MAX_IMAGE_BYTES) throw new Error(`Image buffer exceeds MAX_IMAGE_BYTES (${MAX_IMAGE_BYTES})`);
  const image = sharp(inputBuffer, { failOnError: true, animated: false });
  const metadata = await image.metadata();
  if (!metadata?.width || !metadata?.height) throw new Error("Image metadata is incomplete");
  return image.rotate().png().toBuffer();
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
}

const A4_W = 595.28;
const A4_H = 841.89;
const PAGE_MARGIN = 40;
const BRAND_NAVY = rgb(0.09, 0.2, 0.45);
const BRAND_NAVY_DARK = rgb(0.06, 0.14, 0.32);
const TEXT_DARK = rgb(0.13, 0.13, 0.15);
const TEXT_MUTED = rgb(0.4, 0.4, 0.43);

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
  page.drawImage(png, { x: (A4_W - drawW) / 2, y: (A4_H - drawH) / 2, width: drawW, height: drawH });
  return doc.save();
}

// ---------------------------------------------------------------------------
// PDF -> page images, via poppler's pdftoppm (system binary; see nixpacks.toml)
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
    if (!files.length) throw new Error("pdftoppm produced no page images");
    const buffers = [];
    for (const file of files) buffers.push(await fs.promises.readFile(path.join(workDir, file)));
    logWithRequestId(requestId, `Rasterized PDF into ${buffers.length} page image(s)`);
    return buffers;
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadDocumentPageImages(doc, requestId) {
  const buffer = Buffer.from(doc.data, "base64");
  if (isPdfMime(doc.mimeType)) return rasterizePdfToPngBuffers(buffer, requestId);
  if (isImageMime(doc.mimeType)) return [await normalizeImageToPngBuffer(buffer)];
  return [];
}

// ---------------------------------------------------------------------------
// Black-box redaction. Boxes are fractions (0..1) of the image's own size.
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
    }).png().toBuffer();
    overlays.push({ input: rect, left: pxX, top: pxY });
  }
  if (!overlays.length) return pngBuffer;
  return image.composite(overlays).png().toBuffer();
}

async function documentToRedactedPdfPages(doc, requestId) {
  const redactionBoxes = Array.isArray(doc.redactionBoxes) ? doc.redactionBoxes : [];
  const boxesByPage = new Map();
  for (const box of redactionBoxes) {
    const pageNum = Number.isInteger(box?.page) && box.page > 0 ? box.page : 1;
    if (!boxesByPage.has(pageNum)) boxesByPage.set(pageNum, []);
    boxesByPage.get(pageNum).push(box);
  }

  let pageImages;
  try {
    pageImages = await loadDocumentPageImages(doc, requestId);
  } catch (err) {
    logWithRequestId(requestId, `Could not load "${doc.fileName || doc.name}": ${String(err?.message || err)}`);
    return [];
  }
  if (!pageImages.length) {
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
// Candidate photo resolution: either a standalone provided photo, or a crop
// out of one of the source documents' pages (e.g. a headshot embedded in the
// CV), using the same fraction-coordinate convention as redaction boxes.
// ---------------------------------------------------------------------------
async function resolveCandidatePhotoBuffer(candidatePhoto, documents, requestId) {
  if (!candidatePhoto) return null;
  try {
    if (candidatePhoto.mode === "standalone" && candidatePhoto.data) {
      const { buffer } = decodeBase64ToBuffer(candidatePhoto.data, "candidatePhoto");
      return await normalizeImageToPngBuffer(buffer);
    }
    if (candidatePhoto.mode === "crop" && candidatePhoto.sourceDriveFileId && candidatePhoto.cropBox) {
      const sourceDoc = (documents || []).find((d) => d.driveFileId === candidatePhoto.sourceDriveFileId);
      if (!sourceDoc) {
        logWithRequestId(requestId, `candidatePhoto.sourceDriveFileId "${candidatePhoto.sourceDriveFileId}" not found in documents[]`);
        return null;
      }
      const pageImages = await loadDocumentPageImages(sourceDoc, requestId);
      const pageIndex = Math.max(0, (candidatePhoto.cropBox.page || 1) - 1);
      const pageImage = pageImages[pageIndex];
      if (!pageImage) return null;
      const meta = await sharp(pageImage).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (!w || !h) return null;
      const bx = Math.max(0, Math.min(1, candidatePhoto.cropBox.x || 0));
      const by = Math.max(0, Math.min(1, candidatePhoto.cropBox.y || 0));
      const bw = Math.max(0.01, Math.min(1 - bx, candidatePhoto.cropBox.width || 0));
      const bh = Math.max(0.01, Math.min(1 - by, candidatePhoto.cropBox.height || 0));
      const left = Math.round(bx * w);
      const top = Math.round(by * h);
      const width = Math.max(1, Math.round(bw * w));
      const height = Math.max(1, Math.round(bh * h));
      return await sharp(pageImage).extract({ left, top, width, height }).png().toBuffer();
    }
  } catch (err) {
    logWithRequestId(requestId, "Candidate photo resolution failed, continuing without photo", String(err?.message || err));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profile JSON -> formatted, branded PDF page(s).
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

async function renderProfilePdf(profile, candidatePhotoPngBuffer) {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const logoBytes = Buffer.from(BLUEKAZI_LOGO_PNG_BASE64, "base64");
  const logoImage = await doc.embedPng(logoBytes);
  const logoAspect = logoImage.height / logoImage.width;

  let candidatePhotoImage = null;
  if (candidatePhotoPngBuffer) {
    try {
      candidatePhotoImage = await doc.embedPng(candidatePhotoPngBuffer);
    } catch (e) {
      candidatePhotoImage = null;
    }
  }

  const maxWidth = A4_W - PAGE_MARGIN * 2;
  let page = doc.addPage([A4_W, A4_H]);
  let y = A4_H - PAGE_MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < PAGE_MARGIN) {
      page = doc.addPage([A4_W, A4_H]);
      y = A4_H - PAGE_MARGIN;
    }
  };

  const drawParagraph = (text, { size = 10.5, font = fontRegular, color = TEXT_DARK, gap = 6, lineHeight = 1.35, width = maxWidth, x = PAGE_MARGIN } = {}) => {
    const lines = wrapTextLines(text, font, size, width);
    for (const line of lines) {
      ensureSpace(size * lineHeight);
      page.drawText(line, { x, y, size, font, color });
      y -= size * lineHeight;
    }
    y -= gap;
  };

  const drawBullet = (text, { size = 10, font = fontRegular, color = TEXT_DARK, width = maxWidth } = {}) => {
    const bulletIndent = 14;
    const lines = wrapTextLines(text, font, size, width - bulletIndent);
    lines.forEach((line, index) => {
      ensureSpace(size * 1.35);
      const prefix = index === 0 ? "\u2022 " : "  ";
      page.drawText(prefix + line, { x: PAGE_MARGIN + (index === 0 ? 0 : bulletIndent), y, size, font, color });
      y -= size * 1.35;
    });
  };

  const drawHeading = (text, { size = 13, gapBefore = 16, gapAfter = 8 } = {}) => {
    ensureSpace(size + gapBefore + 6);
    y -= gapBefore;
    page.drawText(text.toUpperCase(), { x: PAGE_MARGIN, y, size, font: fontBold, color: BRAND_NAVY });
    y -= 4;
    page.drawLine({ start: { x: PAGE_MARGIN, y }, end: { x: A4_W - PAGE_MARGIN, y }, thickness: 1.2, color: BRAND_NAVY });
    y -= size + gapAfter - 4;
  };

  // ===================== COVER HEADER (logo + optional photo) =====================
  const logoW = 150;
  const logoH = logoW * logoAspect;
  page.drawImage(logoImage, { x: PAGE_MARGIN, y: y - logoH, width: logoW, height: logoH });

  const photoBoxSize = 92;
  if (candidatePhotoImage) {
    const cw = candidatePhotoImage.width;
    const ch = candidatePhotoImage.height;
    const scale = Math.min(photoBoxSize / cw, photoBoxSize / ch);
    const drawW = cw * scale;
    const drawH = ch * scale;
    const photoX = A4_W - PAGE_MARGIN - photoBoxSize;
    const photoY = y - photoBoxSize;
    page.drawRectangle({ x: photoX, y: photoY, width: photoBoxSize, height: photoBoxSize, borderColor: BRAND_NAVY, borderWidth: 1.5, color: rgb(0.95, 0.96, 0.98) });
    page.drawImage(candidatePhotoImage, {
      x: photoX + (photoBoxSize - drawW) / 2,
      y: photoY + (photoBoxSize - drawH) / 2,
      width: drawW,
      height: drawH,
    });
  }

  y -= Math.max(logoH, candidatePhotoImage ? photoBoxSize : 0) + 18;

  page.drawText("Candidate Profile", { x: PAGE_MARGIN, y, size: 20, font: fontBold, color: TEXT_DARK });
  y -= 30;

  // ===================== CORE FIELD TABLE =====================
  const c = profile.candidate || {};
  const fieldRows = [
    ["Name", profile.display_name || c.full_name || ""],
    ["Date of Birth", c.date_of_birth || ""],
    ["Position", c.target_role || ""],
    ["Nationality", c.nationality || ""],
    ["Country of Residence", c.country_of_residence || ""],
    ["Education", c.education_topline || ""],
  ].filter(([, value]) => value);

  for (const [label, value] of fieldRows) {
    ensureSpace(16);
    page.drawText(`${label}:`, { x: PAGE_MARGIN, y, size: 10.5, font: fontBold, color: BRAND_NAVY_DARK });
    const lines = wrapTextLines(value, fontRegular, 10.5, maxWidth - 150);
    page.drawText(lines[0] || "", { x: PAGE_MARGIN + 150, y, size: 10.5, font: fontRegular, color: TEXT_DARK });
    y -= 16;
    for (const extra of lines.slice(1)) {
      ensureSpace(14);
      page.drawText(extra, { x: PAGE_MARGIN + 150, y, size: 10.5, font: fontRegular, color: TEXT_DARK });
      y -= 14;
    }
  }
  y -= 6;

  if (profile.headline) {
    drawParagraph(profile.headline, { size: 11.5, font: fontItalic, color: TEXT_MUTED, gap: 10 });
  }

  // ===================== HIGHLIGHTS =====================
  const topFacts = (profile.top_facts || []).filter((f) => f?.public_visible !== false || f?.logged_in_visible !== false);
  if (topFacts.length) {
    drawHeading("Highlights");
    for (const fact of topFacts) drawBullet(`${fact.label}: ${fact.value}`);
    y -= 4;
  }

  // ===================== SECTIONS (summary, languages, etc.) =====================
  for (const section of profile.sections || []) {
    drawHeading(section.title || "");
    for (const para of section.paragraphs || []) drawParagraph(para);
    for (const bullet of section.bullets || []) drawBullet(bullet);
  }

  // ===================== PROFESSIONAL EXPERIENCE =====================
  if ((profile.professional_experience || []).length) {
    drawHeading("Professional Experience");
    for (const role of profile.professional_experience) {
      ensureSpace(14);
      const titleLine = [role.role, role.organization].filter(Boolean).join(" \u2014 ");
      page.drawText(titleLine, { x: PAGE_MARGIN, y, size: 11, font: fontBold, color: TEXT_DARK });
      y -= 14;
      const subLine = [role.location, role.period].filter(Boolean).join("  \u2022  ");
      if (subLine) drawParagraph(subLine, { size: 9.5, color: TEXT_MUTED, gap: 4 });
      for (const bullet of role.bullets || []) drawBullet(bullet, { size: 9.5 });
      y -= 6;
    }
  }

  // ===================== EDUCATION =====================
  if ((profile.education || []).length) {
    drawHeading("Education");
    for (const edu of profile.education) {
      ensureSpace(14);
      const titleLine = [edu.title, edu.institution].filter(Boolean).join(" \u2014 ");
      page.drawText(titleLine, { x: PAGE_MARGIN, y, size: 11, font: fontBold, color: TEXT_DARK });
      y -= 14;
      if (edu.period) drawParagraph(edu.period, { size: 9.5, color: TEXT_MUTED, gap: 4 });
      for (const detail of edu.details || []) drawBullet(detail, { size: 9.5 });
      y -= 6;
    }
  }

  // ===================== DOCUMENT STATUS =====================
  if ((profile.documents || []).length) {
    drawHeading("Document Status");
    for (const d of profile.documents) {
      const label = d.document_type || d.document_kind || "Document";
      const redactionNote = d.sensitive_numbers_redacted_in_pdf ? " \u2014 numbers redacted" : "";
      drawBullet(`${label}: ${d.status || "available"}${redactionNote}`, { size: 9.5 });
    }
    y -= 4;
  }

  // ===================== MANUAL REVIEW NOTES =====================
  const reviewNotes = [
    ...(Array.isArray(profile.warnings) ? profile.warnings : []),
    ...(Array.isArray(profile.manual_review_flags) ? profile.manual_review_flags : []),
  ];
  if (reviewNotes.length) {
    drawHeading("Manual Review Notes");
    for (const note of reviewNotes) drawBullet(note, { size: 9.5, color: rgb(0.55, 0.15, 0.1) });
  }

  return doc.save();
}

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
    if (!ensureAuthorized(req)) return res.status(401).json({ error: "Invalid or missing token" });
    const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];
    if (!documents.length) return res.status(400).json({ error: "documents[] is required" });
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
    if (finalDoc.getPageCount() === 0) return res.status(422).json({ error: "No mergeable pages produced from input documents" });
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
    if (!ensureAuthorized(req)) return res.status(401).json({ error: "Invalid or missing token" });

    const pdfLanguage = (req.body?.profile?.pdfLanguage || "en").toLowerCase();
    const profile = pdfLanguage === "de" ? req.body?.profile?.profile_de : req.body?.profile?.profile_en;
    if (!profile) return res.status(400).json({ error: `profile.profile_${pdfLanguage} is required` });

    const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];
    const candidatePhoto = req.body?.candidatePhoto || null;

    logWithRequestId(requestId, "Rendering profile page", {
      displayName: profile.display_name,
      pdfLanguage,
      documentCount: documents.length,
      hasCandidatePhoto: Boolean(candidatePhoto),
    });

    const candidatePhotoPngBuffer = await resolveCandidatePhotoBuffer(candidatePhoto, documents, requestId);
    const profilePdfBytes = await renderProfilePdf(profile, candidatePhotoPngBuffer);
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
    logWithRequestId(requestId, `Final profile PDF built: ${pdfByteArrays.length} blob(s) merged`);

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
    if (!ensureAuthorized(req)) return res.status(401).json({ error: "Invalid or missing token" });
    const role = (req.body?.role || "image").toString();
    const providedMimeType = (req.body?.mimeType || "image/png").toString().toLowerCase();
    const data = req.body?.data;
    if (!data || !isImageMime(providedMimeType)) return res.status(400).json({ error: "A supported image mimeType and base64 data are required" });
    const decoded = decodeBase64ToBuffer(data, "publish-image data");
    const effectiveMimeType = decoded.mimeTypeFromDataUri || providedMimeType;
    if (!isImageMime(effectiveMimeType)) return res.status(400).json({ error: `Unsupported image mimeType "${effectiveMimeType}"` });
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
    res.json({ ok: true, role, tempImageId, mimeType: "image/png", publicUrl: `${publicBaseUrl}/temp-images/${fileName}` });
  } catch (err) {
    console.error(`[${requestId}] Image publish failed`, err);
    res.status(500).json({ error: "Image publish failed", details: String(err?.message || err) });
  }
});

app.get("/temp-images/:fileName", (req, res) => {
  const fileName = path.basename(req.params.fileName || "");
  const filePath = path.join(TEMP_IMAGE_DIR, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Image not found" });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(filePath);
});

app.delete("/publish-image/:tempImageId", (req, res) => {
  try {
    if (!ensureAuthorized(req)) return res.status(401).json({ error: "Invalid or missing token" });
    const tempImageId = path.basename(req.params.tempImageId || "");
    if (!tempImageId) return res.status(400).json({ error: "tempImageId is required" });
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
