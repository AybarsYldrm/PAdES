'use strict';

const DEFAULT_SIGNATURE_ORIGIN = 'bottom-left';
const DEFAULT_SIGNATURE_POSITION = { x: 430, y: 130, width: 80, origin: DEFAULT_SIGNATURE_ORIGIN };

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
    .split(/[ ,\s]+/)
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

const parseSignaturePositions = (value, fallbackDefault = DEFAULT_SIGNATURE_POSITION) => {
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

module.exports = {
  DEFAULT_SIGNATURE_ORIGIN,
  DEFAULT_SIGNATURE_POSITION,
  parseSignaturePositions
};
