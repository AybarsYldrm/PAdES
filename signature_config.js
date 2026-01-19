'use strict';

const path = require('path');
const { buildSignatureImageBuffer } = require('./signature_assets');
const {
  DEFAULT_SIGNATURE_ORIGIN,
  DEFAULT_SIGNATURE_POSITION,
  parseSignaturePositions
} = require('./signature_positions');
const { parseBoolean, formatDateTR } = require('./signature_utils');

const DEFAULT_TEXT_TEMPLATE = 'İmzalayan: {{CN}}\nTarih: {{DATE}}';

const resolveSignatureOutputPath = (env) => {
  if (env.SIGNATURE_IMAGE_OUTPUT) {
    return path.resolve(env.SIGNATURE_IMAGE_OUTPUT);
  }
  return null;
};

const buildVisibleSignatureConfig = ({ baseDir, env, signerName }) => {
  const signatureOutputPath = resolveSignatureOutputPath(env);
  let signatureImageBuffer = null;
  try {
    signatureImageBuffer = buildSignatureImageBuffer({
      baseDir,
      outputPath: signatureOutputPath,
      signerName
    });
  } catch (error) {
    console.warn('Signature image generation failed:', error.message);
  }

  if (!signatureImageBuffer) {
    return null;
  }

  const textEnabled = parseBoolean(env.SIGNATURE_TEXT_ENABLED, true);
  const textTemplate = env.SIGNATURE_TEXT_TEMPLATE || DEFAULT_TEXT_TEMPLATE;
  const resolvedTextTemplate = textTemplate.replace(/\{\{\s*DATE\s*\}\}/g, formatDateTR());
  const defaultOrigin = env.SIGNATURE_ORIGIN || DEFAULT_SIGNATURE_ORIGIN;
  const useCertificateCN = parseBoolean(env.SIGNATURE_USE_CN, true);

  const signaturePositions = parseSignaturePositions(env.SIGNATURE_POSITIONS, {
    ...DEFAULT_SIGNATURE_POSITION,
    origin: defaultOrigin
  });

  return {
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
  };
};

module.exports = { buildVisibleSignatureConfig };
