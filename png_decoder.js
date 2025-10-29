'use strict';
const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

function readUInt32BE(buf, offset){
  return (buf[offset] << 24) | (buf[offset+1] << 16) | (buf[offset+2] << 8) | buf[offset+3];
}

function paethPredictor(a, b, c){
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeFilterRow(filterType, rowData, out, outOffset, bytesPerPixel, prevRow){
  switch (filterType) {
    case 0: // None
      rowData.copy(out, outOffset);
      break;
    case 1: // Sub
      for (let i = 0; i < rowData.length; i++) {
        const left = (i >= bytesPerPixel) ? out[outOffset + i - bytesPerPixel] : 0;
        out[outOffset + i] = (rowData[i] + left) & 0xFF;
      }
      break;
    case 2: // Up
      for (let i = 0; i < rowData.length; i++) {
        const up = prevRow ? prevRow[i] : 0;
        out[outOffset + i] = (rowData[i] + up) & 0xFF;
      }
      break;
    case 3: // Average
      for (let i = 0; i < rowData.length; i++) {
        const left = (i >= bytesPerPixel) ? out[outOffset + i - bytesPerPixel] : 0;
        const up = prevRow ? prevRow[i] : 0;
        const avg = Math.floor((left + up) / 2);
        out[outOffset + i] = (rowData[i] + avg) & 0xFF;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < rowData.length; i++) {
        const left = (i >= bytesPerPixel) ? out[outOffset + i - bytesPerPixel] : 0;
        const up = prevRow ? prevRow[i] : 0;
        const upLeft = (prevRow && i >= bytesPerPixel) ? prevRow[i - bytesPerPixel] : 0;
        const pred = paethPredictor(left, up, upLeft);
        out[outOffset + i] = (rowData[i] + pred) & 0xFF;
      }
      break;
    default:
      throw new Error('Unsupported PNG filter type ' + filterType);
  }
}

function parsePng(buffer){
  if (!Buffer.isBuffer(buffer)) throw new Error('PNG input must be a Buffer');
  if (buffer.length < PNG_SIGNATURE.length + 12) throw new Error('PNG too small');
  if (!buffer.slice(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let pos = PNG_SIGNATURE.length;
  let width = null, height = null, bitDepth = null, colorType = null;
  const idatChunks = [];

  while (pos + 8 <= buffer.length) {
    const length = readUInt32BE(buffer, pos); pos += 4;
    const type = buffer.toString('latin1', pos, pos + 4); pos += 4;
    const dataEnd = pos + length;
    if (dataEnd > buffer.length) throw new Error('PNG chunk length exceeds file size');
    const chunkData = buffer.slice(pos, dataEnd);
    pos = dataEnd + 4; // skip CRC

    if (type === 'IHDR') {
      width = readUInt32BE(chunkData, 0);
      height = readUInt32BE(chunkData, 4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      const compression = chunkData[10];
      const filter = chunkData[11];
      const interlace = chunkData[12];
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error('Unsupported PNG compression/filter/interlace method');
      }
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width == null || height == null || bitDepth == null || colorType == null) {
    throw new Error('PNG missing IHDR');
  }
  if (bitDepth !== 8) {
    throw new Error('Only 8-bit PNGs are supported');
  }
  if (![0,2,4,6].includes(colorType)) {
    throw new Error('Unsupported PNG color type ' + colorType);
  }

  const compressed = Buffer.concat(idatChunks);
  let inflated;
  try {
    inflated = zlib.inflateSync(compressed);
  } catch (err) {
    throw new Error('Unable to inflate PNG IDAT data: ' + err.message);
  }

  const channels = (colorType === 0) ? 1 : (colorType === 2) ? 3 : (colorType === 4) ? 2 : 4;
  const colorChannels = (colorType === 4) ? 1 : (colorType === 6) ? 3 : channels;
  const hasAlpha = (colorType === 4 || colorType === 6);
  const bytesPerPixel = channels;
  const rowSize = width * bytesPerPixel;
  const expectedLength = height * (rowSize + 1);
  if (inflated.length !== expectedLength) {
    throw new Error('PNG data length mismatch: expected ' + expectedLength + ', got ' + inflated.length);
  }

  const decoded = Buffer.alloc(width * height * channels);
  let srcPos = 0;
  let dstPos = 0;
  let prevRow = null;
  for (let row = 0; row < height; row++) {
    const filterType = inflated[srcPos++];
    const rowData = inflated.slice(srcPos, srcPos + rowSize);
    decodeFilterRow(filterType, rowData, decoded, dstPos, bytesPerPixel, prevRow);
    prevRow = decoded.slice(dstPos, dstPos + rowSize);
    srcPos += rowSize;
    dstPos += rowSize;
  }

  let colorData;
  let alphaData = null;

  if (!hasAlpha) {
    colorData = decoded;
  } else {
    colorData = Buffer.alloc(width * height * colorChannels);
    alphaData = Buffer.alloc(width * height);
    let inPos = 0;
    let colorPos = 0;
    let alphaPos = 0;
    for (let i = 0; i < width * height; i++) {
      if (colorChannels === 1) {
        colorData[colorPos++] = decoded[inPos++];
      } else {
        colorData[colorPos++] = decoded[inPos++];
        colorData[colorPos++] = decoded[inPos++];
        colorData[colorPos++] = decoded[inPos++];
      }
      alphaData[alphaPos++] = decoded[inPos++];
    }
  }

  const colorSpace = (colorChannels === 1) ? 'DeviceGray' : 'DeviceRGB';

  return {
    width,
    height,
    bitDepth,
    colorSpace,
    pixelData: colorData,
    alphaData
  };
}

module.exports = { parsePng };
