'use strict';
const fs = require('fs');
const path = require('path');
const { PAdESManager } = require('./pades_manager');

(async () => {
  const baseDir = __dirname;
  const TSA_URL = process.env.TSA_URL || 'http://timestamp.digicert.com';
  const INPUT = path.join(baseDir, 'certificate.pdf');
  const OUT_PADES_T = path.join(baseDir, 'pades.pdf');
  const KEY_PATH = path.join(baseDir, 'key.pem');
  const CERT_PATH = path.join(baseDir, 'cert.pem');

  const pm = new PAdESManager({
    tsaUrl: TSA_URL,
    tsaOptions: { hashName: 'sha384', certReq: true }
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
      fieldName: 'VisibleSig',
      placeholderHexLen: 60000,
      visibleSignature: {
        fieldName: 'VisibleSig',
        pageIndex: 0,
        rect: [50, 50, 350, 200],
        stamp: {
          fontPath: path.join(baseDir, 'font.ttf'),
          pngLogoPath: path.join(baseDir, 'caduceus.png')
        }
      },
      documentTimestamp: { append: false },
    });
    fs.writeFileSync(OUT_PADES_T, pdf);
    console.log('OK', mode, '→', OUT_PADES_T);
  } catch (e) {
    console.error('PAdES-T error:', e.code || e.message || e);
  }
})();