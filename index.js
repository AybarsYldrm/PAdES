'use strict';
const fs = require('fs');
const path = require('path');
const { PAdESManager } = require('./pades_manager');
const { buildVisibleSignatureConfig } = require('./signature_config');

const DEFAULT_SIGNATURE_NAME = 'Aybars';

(async () => {
  const baseDir = __dirname;
  const TSA_URL = process.env.TSA_URL || 'http://timestamp.acs.microsoft.com';
  const INPUT = path.join(baseDir, 'certificate.pdf');
  const OUT_PADES_T = path.join(baseDir, '_certificate.pdf');
  const KEY_PATH = path.join(baseDir, 'key.pem');
  const CERT_PATH = path.join(baseDir, 'cert.pem');
  const signerName = process.env.SIGNATURE_NAME || DEFAULT_SIGNATURE_NAME;
  const visibleSignatureConfig = buildVisibleSignatureConfig({
    baseDir,
    env: process.env,
    signerName
  });

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
