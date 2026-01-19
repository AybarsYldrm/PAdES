'use strict';
const fs = require('fs');
const path = require('path');
const { PAdESManager } = require('./pades_manager');
const { buildSignatureImageBuffer } = require('./signature_assets');
const {
  DEFAULT_SIGNATURE_ORIGIN,
  DEFAULT_SIGNATURE_POSITION,
  parseSignaturePositions
} = require('./signature_positions');
const { parseBoolean, formatDateTR } = require('./signature_utils');

const DEFAULT_SIGNATURE_NAME = 'Aybars';
const DEFAULT_TEXT_TEMPLATE = 'İmzalayan: {{CN}}\nTarih: {{DATE}}';

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
    signatureImageBuffer = buildSignatureImageBuffer({
      baseDir,
      outPath: signatureOutputPath,
      signerName
    });
  } catch (error) {
    console.warn('Signature image generation failed:', error.message);
  }

  const textEnabled = parseBoolean(process.env.SIGNATURE_TEXT_ENABLED, true);
  const textTemplate = process.env.SIGNATURE_TEXT_TEMPLATE || DEFAULT_TEXT_TEMPLATE;
  const resolvedTextTemplate = textTemplate.replace(/\{\{\s*DATE\s*\}\}/g, formatDateTR());
  const defaultOrigin = process.env.SIGNATURE_ORIGIN || DEFAULT_SIGNATURE_ORIGIN;
  const useCertificateCN = parseBoolean(process.env.SIGNATURE_USE_CN, true);

  const signaturePositions = parseSignaturePositions(
    process.env.SIGNATURE_POSITIONS,
    {
      ...DEFAULT_SIGNATURE_POSITION,
      origin: defaultOrigin
    }
  );

  const visibleSignatureConfig = signatureImageBuffer
    ? {
        imageBuffer: signatureImageBuffer,
        coordinateMap: signaturePositions.coordinateMap,
        defaultPosition: signaturePositions.defaultPosition,
        textTemplate: textEnabled ? resolvedTextTemplate : undefined,
        textLines: textEnabled ? undefined : [],
        useCertificateCN,
        cnFallbackEnabled: textEnabled,
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
