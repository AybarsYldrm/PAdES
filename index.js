'use strict';
const fs = require('fs');
const path = require('path');
const { PAdESManager } = require('./pades_manager');
const { generateStampPNG } = require('./test');



(async () => {
  const baseDir = __dirname;
  const TSA_URL = process.env.TSA_URL || 'http://timestamp.acs.microsoft.com';
  const INPUT = path.join(baseDir, 'certificate.pdf');
  const OUT_PADES_T = path.join(baseDir, '_certificate.pdf');
  const KEY_PATH = path.join(baseDir, 'key.pem');
  const CERT_PATH = path.join(baseDir, 'cert.pem');
  const defaultSignatureImage = path.join(baseDir, 'signature.png');
  const resolveSignatureImage = () => {
    if (process.env.SIGNATURE_IMAGE) {
      const resolved = path.resolve(process.env.SIGNATURE_IMAGE);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      console.warn('SIGNATURE_IMAGE points to a missing file:', resolved);
    }
    if (fs.existsSync(defaultSignatureImage)) {
      return defaultSignatureImage;
    }
    return null;
  };

  const SIGNATURE_IMAGE = resolveSignatureImage();

  const visibleSignatureConfig = SIGNATURE_IMAGE
    ? {
        imagePath: SIGNATURE_IMAGE,
        coordinateMap: {
          Aybars: { x: 430, y: 130, width: 80 }
        },
        defaultPosition: { x: 430, y: 130, width: 80 },
        textTemplate: `İmzalayan: {{CN}}\nTarih: ${Date.now()}`, 
        textFontSize: 9,
        textMinFontSize: 8,
        textFontStep: 0.5,
        textPadding: { top: 4, bottom: 4, left: 6 },
        textPosition: 'top'
      }
    : null;

  if (!visibleSignatureConfig) {
    console.warn('Signature appearance demo skipped (signature.png not found and SIGNATURE_IMAGE not set).');
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
