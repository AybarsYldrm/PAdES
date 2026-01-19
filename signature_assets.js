'use strict';

const path = require('path');
const { generateStampPNG } = require('./stamp');

const getSignatureAssets = (baseDir) => ({
  fontPath: path.join(baseDir, 'font.ttf'),
  logoPath: path.join(baseDir, 'caduceus.png')
});

const buildSignatureImageBuffer = ({ baseDir, signerName, outputPath }) => {
  const { fontPath, logoPath } = getSignatureAssets(baseDir);
  return generateStampPNG({
    fontPath,
    pngLogoPath: logoPath,
    personName: signerName,
    outPath: outputPath
  });
};

module.exports = { getSignatureAssets, buildSignatureImageBuffer };
