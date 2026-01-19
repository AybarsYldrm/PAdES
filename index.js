'use strict';
const fs = require('fs');
const path = require('path');
const { PAdESManager } = require('./pades_manager');
const { generateStampPNG } = require('./stamp');

const DEFAULT_SIGNATURE_POSITION = { x: 430, y: 130, width: 80 };
const DEFAULT_SIGNATURE_NAME = 'Aybars';
const DEFAULT_TEXT_TEMPLATE = 'İmzalayan: {{CN}}\nTarih: {{DATE}}';
const DEFAULT_SIGNATURE_ORIGIN = 'bottom-left';

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parseNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const parsePositionValues = (value) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim();
  const originSplit = normalized.split(':');
  const originCandidate = originSplit.length > 1 ? originSplit.shift().trim() : null;
  const coordString = originSplit.join(':').trim();
  const parts = coordString
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  const [x, y, width, height] = parts.map(parseNumber);
  if (x === null || y === null || width === null) {
    return null;
  }
  const rect = { x, y, width };
  if (originCandidate) {
    rect.origin = originCandidate;
  }
  if (height !== null) {
    rect.height = height;
  }
  return rect;
};

const parseSignaturePositions = (value, fallbackDefault) => {
  const coordinateMap = {};
  let defaultPosition = fallbackDefault;

  if (!value) {
    return { coordinateMap, defaultPosition };
  }

  const trimmed = String(value).trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if (parsed.defaultPosition) {
          defaultPosition = parsed.defaultPosition;
        }
        if (parsed.coordinateMap && typeof parsed.coordinateMap === 'object') {
          Object.assign(coordinateMap, parsed.coordinateMap);
        }
      }
      return { coordinateMap, defaultPosition };
    } catch (error) {
      console.warn('SIGNATURE_POSITIONS JSON parse failed:', error.message);
    }
  }

  const entries = trimmed.split(';').map((item) => item.trim()).filter(Boolean);
  for (const entry of entries) {
    const [namePartRaw, coordsPart] = entry.split('=').map((item) => item.trim());
    if (!coordsPart) {
      continue;
    }
    const [namePart, originPart] = namePartRaw ? namePartRaw.split('@').map((item) => item.trim()) : [];
    const rect = parsePositionValues(coordsPart);
    if (!rect) {
      continue;
    }
    if (originPart) {
      rect.origin = originPart;
    }
    if (!namePart || namePart.toLowerCase() === 'default') {
      defaultPosition = rect;
    } else {
      coordinateMap[namePart] = rect;
    }
  }

  return { coordinateMap, defaultPosition };
};

const formatDate = () => {
  const now = new Date();
  return now.toLocaleString('tr-TR', { hour12: false });
};

const generateSignatureImageBuffer = ({ baseDir, outPath, signerName }) => {
  const fontPath = path.join(baseDir, 'font.ttf');
  const logoPath = path.join(baseDir, 'caduceus.png');
  return generateStampPNG({
    fontPath,
    pngLogoPath: logoPath,
    personName: signerName,
    outPath
  });
};

(async () => {
  const baseDir = __dirname;
  const TSA_URL = process.env.TSA_URL || 'http://timestamp.acs.microsoft.com';
  const INPUT = path.join(baseDir, 'certificate.pdf');
  const OUT_PADES_T = path.join(baseDir, '_certificate.pdf');
  const KEY_PATH = path.join(baseDir, 'key.pem');
  const CERT_PATH = path.join(baseDir, 'cert.pem');
  const signerName = process.env.SIGNATURE_NAME || DEFAULT_SIGNATURE_NAME;
  const signatureOutputPath = process.env.SIGNATURE_IMAGE_OUTPUT
    ? path.resolve(process.env.SIGNATURE_IMAGE_OUTPUT)
    : null;
  let signatureImageBuffer = null;
  try {
    signatureImageBuffer = generateSignatureImageBuffer({
      baseDir,
      outPath: signatureOutputPath,
      signerName
    });
  } catch (error) {
    console.warn('Signature image generation failed:', error.message);
  }

  const textEnabled = parseBoolean(process.env.SIGNATURE_TEXT_ENABLED, true);
  const textTemplate = process.env.SIGNATURE_TEXT_TEMPLATE || DEFAULT_TEXT_TEMPLATE;
  const resolvedTextTemplate = textTemplate.replace(/\{\{\s*DATE\s*\}\}/g, formatDate());
  const defaultOrigin = process.env.SIGNATURE_ORIGIN || DEFAULT_SIGNATURE_ORIGIN;

  const signaturePositions = parseSignaturePositions(process.env.SIGNATURE_POSITIONS, {
    ...DEFAULT_SIGNATURE_POSITION,
    origin: defaultOrigin
  });

  const visibleSignatureConfig = signatureImageBuffer
    ? {
        imageBuffer: signatureImageBuffer,
        coordinateMap: signaturePositions.coordinateMap,
        defaultPosition: signaturePositions.defaultPosition,
        textTemplate: textEnabled ? resolvedTextTemplate : undefined,
        textLines: textEnabled ? undefined : [],
        textFontSize: 9,
        textMinFontSize: 8,
        textFontStep: 0.5,
        textPadding: { top: 4, bottom: 4, left: 6 },
        textPosition: 'top'
      }
    : null;

  if (!visibleSignatureConfig) {
    console.warn('Signature appearance skipped (signature image missing).');
  }

  const pm = new PAdESManager({
    tsaUrl: TSA_URL,
    tsaOptions: { hashName: 'sha256', certReq: true }
  });

  const pdfSource = fs.readFileSync(INPUT);
  const keyPem = fs.readFileSync(KEY_PATH, 'utf8');
  const certPem = fs.readFileSync(CERT_PATH, 'utf8');
  const chain = []; // ['issuer.pem','root.pem'].map(p=>fs.readFileSync(path.join(baseDir, p),'utf8'));

  // PAdES-T (tek imzada imza + TSA attribute)
  try {
    const { pdf, mode } = await pm.signPAdES_T({
      pdfBuffer: Buffer.from(pdfSource),
      keyPem,
      certPem,
      chainPems: chain,
      fieldName: Date.now().toString(16),
      placeholderHexLen: 120000,
      documentTimestamp: { append: false },
      visibleSignature: visibleSignatureConfig
    });
    fs.writeFileSync(OUT_PADES_T, pdf);
    console.log('OK', mode, '→', OUT_PADES_T);
  } catch (e) {
    console.error('PAdES-T error:', e.code || e.message || e);
  }
})();
