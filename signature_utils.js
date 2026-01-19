'use strict';

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

const formatDateTR = (date = new Date()) => date.toLocaleString('tr-TR', { hour12: false });

module.exports = { parseBoolean, formatDateTR };
