'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const { parsePng } = require('./png_decoder');

const PDF_STATE_CACHE = new WeakMap();

function getPdfState(pdf){
  if (!Buffer.isBuffer(pdf)) throw new Error('pdf must be Buffer');
  let state = PDF_STATE_CACHE.get(pdf);
  if (state) return state;

  const pdfStr = pdf.toString('latin1');
  const meta = _parseLastTrailer(pdfStr);
  const xrefMap = _buildXrefMap(pdfStr, meta.startxref);

  state = { pdfStr, meta, xrefMap };
  PDF_STATE_CACHE.set(pdf, state);
  return state;
}

function _parseLastTrailer(pdfStr){
  const sxRe = /startxref\s+(\d+)\s+%%EOF/g;
  let sxMatch = null;
  let m;
  while ((m = sxRe.exec(pdfStr)) !== null) sxMatch = m;
  if (!sxMatch) throw new Error('startxref not found');
  const startxref = parseInt(sxMatch[1], 10);

  const trailers = pdfStr.match(/trailer\s*<<[\s\S]*?>>/g);
  if (!trailers || !trailers.length) throw new Error('trailer not found');
  const trailerStr = trailers[trailers.length - 1];

  const rootM = /\/Root\s+(\d+)\s+0\s+R/.exec(trailerStr);
  const sizeM = /\/Size\s+(\d+)/.exec(trailerStr);
  if (!rootM || !sizeM) throw new Error('missing /Root or /Size');

  return {
    startxref,
    rootRef: rootM[1] + ' 0 R',
    rootObjNum: parseInt(rootM[1], 10),
    size: parseInt(sizeM[1], 10)
  };
}

function _skipWs(str, pos){
  while (pos < str.length) {
    const ch = str.charCodeAt(pos);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0d || ch === 0x0a) pos++;
    else break;
  }
  return pos;
}

function _extractDictAt(str, idx){
  if (idx < 0 || idx >= str.length) return null;
  const tok = /<<|>>/g;
  tok.lastIndex = idx;
  let depth = 0, start = -1;
  let t;
  while ((t = tok.exec(str)) !== null) {
    const sym = str.substr(t.index, 2);
    if (sym === '<<') {
      if (depth === 0) start = t.index;
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        return { dictStr: str.slice(start, t.index + 2), endPos: tok.lastIndex };
      }
      if (depth < 0) break;
    }
  }
  return null;
}

function _parseXrefAt(str, offset, map, visited){
  if (visited.has(offset)) return;
  visited.add(offset);
  if (offset < 0 || offset >= str.length) return;
  if (str.slice(offset, offset + 4) !== 'xref') return;

  let pos = offset + 4;
  pos = _skipWs(str, pos);

  while (pos < str.length){
    if (str.startsWith('trailer', pos)){
      pos += 7;
      pos = _skipWs(str, pos);
      const dictStart = str.indexOf('<<', pos);
      const dict = _extractDictAt(str, dictStart);
      if (dict) {
        const prevM = /\/Prev\s+(\d+)/.exec(dict.dictStr);
        if (prevM) _parseXrefAt(str, parseInt(prevM[1], 10), map, visited);
      }
      break;
    }
    const headerRe = /(\d+)\s+(\d+)/y;
    headerRe.lastIndex = pos;
    const header = headerRe.exec(str);
    if (!header) break;
    pos = headerRe.lastIndex;
    const startObj = parseInt(header[1], 10);
    const count = parseInt(header[2], 10);
    for (let i = 0; i < count; i++){
      const entryRe = /(\d{10})\s+(\d{5})\s+([nf])/y;
      entryRe.lastIndex = pos;
      const entry = entryRe.exec(str);
      if (!entry) return;
      pos = entryRe.lastIndex;
      if (entry[3] === 'n'){
        const objNum = startObj + i;
        const off = parseInt(entry[1], 10);
        if (!map.has(objNum)) map.set(objNum, off);
      }
      pos = _skipWs(str, pos);
    }
  }
}

function _buildXrefMap(str, startxref){
  const map = new Map();
  const visited = new Set();
  if (typeof startxref === 'number' && !Number.isNaN(startxref)){
    _parseXrefAt(str, startxref, map, visited);
  }
  return map;
}

/* ------------------------- Basit PDF yardımcıları ------------------------- */

function readLastTrailer(pdf){
  const state = getPdfState(pdf);
  const { meta } = state;
  return {
    startxref: meta.startxref,
    rootRef: meta.rootRef,
    rootObjNum: meta.rootObjNum,
    size: meta.size
  };
}

/* ---- DENGELİ sözlük okuyan geliştirilmiş readObject (iç içe << >> destekler) ---- */
function readObject(pdf, objNum){
  const state = getPdfState(pdf);
  const { pdfStr, xrefMap } = state;
  let offset = xrefMap.get(objNum);

  const legacyRead = () => {
    const re = new RegExp(String(objNum) + '\\s+0\\s+obj\\b', 'g');
    let match;
    let best = null;
    let bestPriority = -1;
    while ((match = re.exec(pdfStr)) !== null){
      const bodyStart = re.lastIndex;
      const endIdx = pdfStr.indexOf('endobj', bodyStart);
      if (endIdx < 0) break;
      const body = pdfStr.slice(bodyStart, endIdx);
      const relIdx = body.indexOf('<<');
      if (relIdx >= 0){
        const dict = _extractDictAt(body, relIdx);
        if (dict){
          const dictStr = dict.dictStr;
          const typeMatch = /\/Type\s*\/([A-Za-z]+)/.exec(dictStr);
          if (typeMatch){
            const t = typeMatch[1];
            let priority = 1;
            if (t === 'Page') priority = 5;
            else if (t === 'Pages' || t === 'Catalog') priority = 4;
            else if (t === 'AcroForm' || t === 'Annot' || t === 'Sig' || t === 'DocTimeStamp') priority = 3;
            else if (t === 'FontDescriptor') priority = 0;
            else priority = 2;
            if (priority >= bestPriority) {
              const startIdx = pdfStr.indexOf(dictStr, bodyStart);
              const endIdxAbs = (startIdx >= 0) ? startIdx + dictStr.length : -1;
              best = { dictStr, start: startIdx, end: endIdxAbs };
              bestPriority = priority;
            }
          } else {
            if (bestPriority <= 1) {
              const startIdx = pdfStr.indexOf(dictStr, bodyStart);
              const endIdxAbs = (startIdx >= 0) ? startIdx + dictStr.length : -1;
              best = { dictStr, start: startIdx, end: endIdxAbs };
              bestPriority = 1;
            }
          }
        }
      }
      re.lastIndex = endIdx + 6;
    }
    return best;
  };

  if (offset == null) {
    return legacyRead();
  }

  const headerRe = /(\d+)\s+(\d+)\s+obj\b/y;
  headerRe.lastIndex = offset;
  const header = headerRe.exec(pdfStr);
  if (!header || parseInt(header[1], 10) !== objNum) {
    return legacyRead();
  }

  const dictIdx = pdfStr.indexOf('<<', headerRe.lastIndex);
  if (dictIdx < 0) return legacyRead();
  const dict = _extractDictAt(pdfStr, dictIdx);
  if (!dict) return legacyRead();
  return { dictStr: dict.dictStr, start: dictIdx, end: dict.endPos };
}

/* -------------------- Güvenli /Page bulucu (Pages ağacı) -------------------- */

function _readKidsArray(dictStr){
  const m = /\/Kids\s*\[\s*([^\]]*)\]/.exec(dictStr);
  if (!m) return [];
  const arr = [];
  const re = /(\d+)\s+0\s+R/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) arr.push(parseInt(mm[1], 10));
  return arr;
}
function _dictHasType(dictStr, typeName){
  return new RegExp('\\/Type\\s+\\/' + typeName + '\\b').test(dictStr);
}
function _findFirstPageFrom(pdf, objNum, depth){
  if (depth > 20) return null;
  const obj = readObject(pdf, objNum);
  if (!obj) return null;
  if (_dictHasType(obj.dictStr, 'Page')) return objNum;
  if (_dictHasType(obj.dictStr, 'Pages')){
    const kids = _readKidsArray(obj.dictStr);
    for (let i=0;i<kids.length;i++){
      const p = _findFirstPageFrom(pdf, kids[i], depth+1);
      if (p) return p;
    }
  }
  return null;
}
function findFirstPageObjNumSafe(pdf){
  const meta = readLastTrailer(pdf);
  const catalog = readObject(pdf, meta.rootObjNum);
  if (!catalog) throw new Error('Catalog (Root) not found');
  const pagesRef = /\/Pages\s+(\d+)\s+0\s+R/.exec(catalog.dictStr);
  if (!pagesRef) throw new Error('Catalog has no /Pages');
  const pagesNum = parseInt(pagesRef[1], 10);
  const firstPage = _findFirstPageFrom(pdf, pagesNum, 0);
  if (!firstPage) throw new Error('No /Page found via /Pages tree');
  return firstPage;
}

function _findFirstPageByScan(pdf){
  const state = getPdfState(pdf);
  const { pdfStr, xrefMap } = state;
  const sorted = Array.from(xrefMap.keys()).sort((a,b) => a - b);
  for (let i = 0; i < sorted.length; i++){
    const num = sorted[i];
    const obj = readObject(pdf, num);
    if (obj && /\/Type\s*\/Page\b/.test(obj.dictStr)) return num;
  }
  const objRe = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = objRe.exec(pdfStr)) !== null){
    const num = parseInt(m[1], 10);
    if (Number.isNaN(num)) continue;
    const bodyStart = objRe.lastIndex;
    const endIdx = pdfStr.indexOf('endobj', bodyStart);
    if (endIdx < 0) break;
    const body = pdfStr.slice(bodyStart, endIdx);
    if (/\/Type\s*\/Page\b/.test(body)) return num;
    objRe.lastIndex = endIdx + 6;
  }
  return null;
}

function _countPagesUnder(pdf, objNum, visited = new Set()){
  if (visited.has(objNum)) return 0;
  visited.add(objNum);
  const obj = readObject(pdf, objNum);
  if (!obj) return 0;
  if (_dictHasType(obj.dictStr, 'Page')) return 1;
  if (!_dictHasType(obj.dictStr, 'Pages')) return 0;
  const kids = _extractRefArray(obj.dictStr, '/Kids');
  let total = 0;
  for (let i = 0; i < kids.length; i++){
    total += _countPagesUnder(pdf, kids[i], visited);
  }
  return total;
}

function _findPageByIndex(pdf, objNum, targetIndex){
  const obj = readObject(pdf, objNum);
  if (!obj) return null;
  if (_dictHasType(obj.dictStr, 'Page')) {
    return targetIndex === 0 ? { pageObjNum: objNum } : null;
  }
  if (!_dictHasType(obj.dictStr, 'Pages')) return null;
  const kids = _extractRefArray(obj.dictStr, '/Kids');
  let remaining = targetIndex;
  for (let i = 0; i < kids.length; i++){
    const kid = kids[i];
    const kidObj = readObject(pdf, kid);
    if (!kidObj) continue;
    if (_dictHasType(kidObj.dictStr, 'Page')) {
      if (remaining === 0) return { pageObjNum: kid };
      remaining -= 1;
      continue;
    }
    if (_dictHasType(kidObj.dictStr, 'Pages')) {
      const countMatch = /\/Count\s+(\d+)/.exec(kidObj.dictStr);
      const childCount = countMatch ? parseInt(countMatch[1], 10) : _countPagesUnder(pdf, kid);
      if (!Number.isInteger(childCount) || childCount < 0) {
        continue;
      }
      if (remaining < childCount) {
        return _findPageByIndex(pdf, kid, remaining);
      }
      remaining -= childCount;
    }
  }
  return null;
}

function findPageObjNumByIndex(pdf, pageIndex){
  if (typeof pageIndex !== 'number' || pageIndex < 0) throw new Error('pageIndex must be >= 0');
  const meta = readLastTrailer(pdf);
  const catalog = readObject(pdf, meta.rootObjNum);
  if (!catalog) throw new Error('Catalog (Root) not found');
  const pagesRef = /\/Pages\s+(\d+)\s+0\s+R/.exec(catalog.dictStr);
  if (!pagesRef) throw new Error('Catalog has no /Pages');
  const pagesNum = parseInt(pagesRef[1], 10);
  const result = _findPageByIndex(pdf, pagesNum, pageIndex);
  if (!result || typeof result.pageObjNum !== 'number') {
    throw new Error('Page index out of range');
  }
  return result.pageObjNum;
}

/* -------------------- AcroForm/Sig & Widget inşa yardımcıları -------------------- */

function _injectKeyRef(dictStr, key, valueRef){
  const re = new RegExp(key.replace('/', '\\/') + '\\s+\\d+\\s+0\\s+R');
  if (re.test(dictStr)) return dictStr;
  return dictStr.replace(/>>\s*$/, ' ' + key + ' ' + valueRef + ' >>');
}
function _injectKeyRaw(dictStr, rawKV){
  const k = rawKV.split(/\s+/)[0];
  const re = new RegExp(k.replace('/', '\\/') + '\\b');
  if (re.test(dictStr)) return dictStr;
  return dictStr.replace(/>>\s*$/, ' ' + rawKV + ' >>');
}

function _ensureDocTimeStampPerms(pdf, rootDict, docTsRef){
  let updatedRoot = rootDict;
  let rootChanged = false;
  const extraObjs = [];

  const permsRefMatch = /\/Perms\s+(\d+)\s+0\s+R/.exec(updatedRoot);
  if (permsRefMatch){
    const permsObjNum = parseInt(permsRefMatch[1], 10);
    const permsObj = readObject(pdf, permsObjNum);
    if (permsObj && permsObj.dictStr){
      const docRefRe = /\/DocTimeStamp\s+\d+\s+0\s+R/;
      let permsDict = permsObj.dictStr;
      let newPermsDict;
      if (docRefRe.test(permsDict)){
        newPermsDict = permsDict.replace(docRefRe, '/DocTimeStamp ' + docTsRef);
      } else {
        newPermsDict = permsDict.replace(/>>\s*$/, ' /DocTimeStamp ' + docTsRef + ' >>');
      }
      if (newPermsDict !== permsDict){
        extraObjs.push({ objNum: permsObjNum, contentStr: newPermsDict });
      }
    } else {
      const replacement = '/Perms << /DocTimeStamp ' + docTsRef + ' >>';
      const replaced = updatedRoot.replace(permsRefMatch[0], replacement);
      if (replaced !== updatedRoot){
        updatedRoot = replaced;
        rootChanged = true;
      }
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const permsInlineMatch = /\/Perms\s*<<([\s\S]*?)>>/.exec(updatedRoot);
  if (permsInlineMatch){
    const inner = permsInlineMatch[1];
    const docRefRe = /\/DocTimeStamp\s+\d+\s+0\s+R/;
    let newInner;
    if (docRefRe.test(inner)){
      newInner = inner.replace(docRefRe, '/DocTimeStamp ' + docTsRef);
    } else {
      newInner = inner.trim() + ' /DocTimeStamp ' + docTsRef;
    }
    const replacement = '/Perms << ' + newInner.trim() + ' >>';
    if (replacement !== permsInlineMatch[0]){
      updatedRoot = updatedRoot.slice(0, permsInlineMatch.index) +
                    replacement +
                    updatedRoot.slice(permsInlineMatch.index + permsInlineMatch[0].length);
      rootChanged = true;
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const injected = _injectKeyRaw(updatedRoot, '/Perms << /DocTimeStamp ' + docTsRef + ' >>');
  if (injected !== updatedRoot){
    updatedRoot = injected;
    rootChanged = true;
  }
  return { rootDict: updatedRoot, rootChanged, extraObjs };
}

function _ensureDocTimeStampAcroForm(pdf, rootDict, allocateObjNum, opts){
  opts = opts || {};
  const docTsRef = opts.docTsRef;
  const pageRefStr = opts.pageRefStr || null;
  const fieldLabel = (typeof opts.fieldName === 'string' && opts.fieldName.length > 0)
    ? opts.fieldName
    : 'DocTimeStamp';

  if (!docTsRef) {
    throw new Error('docTsRef must be provided while preparing DocTimeStamp placeholder.');
  }

  let updatedRoot = rootDict;
  let rootChanged = false;
  const extraObjs = [];

  const fieldObjNum = allocateObjNum();
  let widgetObjNum = null;

  if (pageRefStr) {
    const pageMatch = /^(\d+)\s+0\s+R$/.exec(pageRefStr);
    if (pageMatch) {
      const pageObjNum = parseInt(pageMatch[1], 10);
      const pageObj = readObject(pdf, pageObjNum);
      if (pageObj && pageObj.dictStr && /\/Type\s*\/Page\b/.test(pageObj.dictStr)) {
        widgetObjNum = allocateObjNum();
        const widgetDict = '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /F 132 /Parent ' +
                           fieldObjNum + ' 0 R /P ' + pageRefStr + ' >>';
        extraObjs.push({ objNum: widgetObjNum, contentStr: widgetDict });
        const updatedPage = _appendUniqueRef(pageObj.dictStr, '/Annots', widgetObjNum);
        if (updatedPage !== pageObj.dictStr) {
          extraObjs.push({ objNum: pageObjNum, contentStr: updatedPage });
        }
      }
    }
  }

  let fieldDict = '<< /FT /Sig /T (' + fieldLabel + ') /Ff 0 /V ' + docTsRef;
  if (widgetObjNum) {
    fieldDict += ' /Kids [ ' + widgetObjNum + ' 0 R ]';
  }
  fieldDict += ' >>';
  extraObjs.push({ objNum: fieldObjNum, contentStr: fieldDict });

  const ensureAcroDict = (dictStr) => {
    let out = dictStr;
    out = _injectKeyRaw(out, '/Type /AcroForm');
    out = /\/Fields\s*\[/.test(out) ? out : _injectKeyRaw(out, '/Fields []');
    out = _appendUniqueRef(out, '/Fields', fieldObjNum);
    out = _ensureSigFlags(out);
    return out;
  };

  const acroInlineMatch = /\/AcroForm\s*<<([\s\S]*?)>>/.exec(updatedRoot);
  if (acroInlineMatch) {
    const original = acroInlineMatch[0];
    const dictStr = '<<' + acroInlineMatch[1] + '>>';
    const ensured = ensureAcroDict(dictStr);
    if (ensured !== dictStr) {
      const replacement = '/AcroForm ' + ensured;
      updatedRoot = updatedRoot.slice(0, acroInlineMatch.index) +
                    replacement +
                    updatedRoot.slice(acroInlineMatch.index + original.length);
      rootChanged = true;
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const acroRefMatch = /\/AcroForm\s+(\d+)\s+0\s+R/.exec(updatedRoot);
  if (acroRefMatch) {
    const acroNum = parseInt(acroRefMatch[1], 10);
    const acroObj = readObject(pdf, acroNum);
    const dictStr = acroObj && acroObj.dictStr ? acroObj.dictStr : '<<>>';
    const ensured = ensureAcroDict(dictStr);
    if (ensured !== dictStr) {
      extraObjs.push({ objNum: acroNum, contentStr: ensured });
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const acroObjNum = allocateObjNum();
  let acroDict = '<< /Type /AcroForm /Fields [] /SigFlags 3 >>';
  acroDict = _appendUniqueRef(acroDict, '/Fields', fieldObjNum);
  acroDict = _ensureSigFlags(acroDict);
  extraObjs.push({ objNum: acroObjNum, contentStr: acroDict });
  const injected = _injectKeyRef(updatedRoot, '/AcroForm', acroObjNum + ' 0 R');
  if (injected !== updatedRoot) {
    updatedRoot = injected;
    rootChanged = true;
  }

  return { rootDict: updatedRoot, rootChanged, extraObjs };
}

function _appendUniqueRef(dictStr, arrayKey, objNum){
  const ref = objNum + ' 0 R';
  const keyRe = new RegExp(arrayKey.replace('/', '\\/') + '\\s*\\[([\\s\\S]*?)\]');
  const match = keyRe.exec(dictStr);
  if (match){
    const inside = match[1];
    const refRe = new RegExp('\\b' + objNum + '\\s+0\\s+R\\b');
    if (refRe.test(inside)) return dictStr;
    const existingRefs = inside.match(/\d+\s+0\s+R/g) || [];
    existingRefs.push(ref);
    const replaced = arrayKey + ' [ ' + existingRefs.join(' ') + ' ]';
    return dictStr.slice(0, match.index) +
           replaced +
           dictStr.slice(match.index + match[0].length);
  }
  return _injectKeyRaw(dictStr, arrayKey + ' [ ' + ref + ' ]');
}

function _upsertKeyRaw(dictStr, key, rawValue){
  const keyEsc = key.replace('/', '\\/');
  const valuePattern = '(<<[\\s\\S]*?>>|\\[[\\s\\S]*?\]|\((?:[^\\\\)]|\\.)*\)|[^/<>\s][^/\s>]*)';
  const re = new RegExp('(' + keyEsc + '\\s+)' + valuePattern);
  if (re.test(dictStr)) {
    return dictStr.replace(re, function(_match, prefix){
      return prefix + rawValue;
    });
  }
  return _injectKeyRaw(dictStr, key + ' ' + rawValue);
}

function _formatPdfNumber(num){
  if (typeof num !== 'number' || !Number.isFinite(num)) return '0';
  if (Math.abs(num) >= 1e6 || Math.abs(num) <= 1e-6) {
    return num.toExponential(6).replace(/0+e/, 'e').replace(/\.e/, 'e');
  }
  const fixed = num.toFixed(6);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function _setRect(dictStr, rect){
  if (!Array.isArray(rect) || rect.length !== 4) return dictStr;
  const rectVals = rect.map((n) => _formatPdfNumber(Number(n) || 0));
  return _upsertKeyRaw(dictStr, '/Rect', '[ ' + rectVals.join(' ') + ' ]');
}

function _setKeyRef(dictStr, key, objNum){
  if (typeof objNum !== 'number' || objNum < 0) return dictStr;
  return _upsertKeyRaw(dictStr, key, objNum + ' 0 R');
}

function _extractArrayContent(dictStr, key){
  const keyEsc = key.replace('/', '\\/');
  const re = new RegExp(keyEsc + '\\s*\[(.*?)\]', 's');
  const match = re.exec(dictStr);
  if (!match) return null;
  return match[1];
}

function _extractRefArray(dictStr, key){
  const content = _extractArrayContent(dictStr, key);
  if (!content) return [];
  const refs = [];
  const re = /(\d+)\s+0\s+R/g;
  let m;
  while ((m = re.exec(content)) !== null){
    refs.push(parseInt(m[1], 10));
  }
  return refs;
}

function _parseRect(dictStr){
  const match = /\/Rect\s*\[([^\]]+)\]/.exec(dictStr);
  if (!match) return null;
  const parts = match[1].trim().split(/\s+/).slice(0, 4);
  if (parts.length !== 4) return null;
  return parts.map((p) => parseFloat(p));
}

function _extractRef(dictStr, key){
  const keyEsc = key.replace('/', '\\/');
  const re = new RegExp(keyEsc + '\\s+(\d+)\\s+0\\s+R');
  const match = re.exec(dictStr);
  return match ? parseInt(match[1], 10) : null;
}

function _extractDictEntries(dictStr){
  const entries = [];
  const re = /\/([A-Za-z0-9\.\-#]+)\s+(<<[\s\S]*?>>|\[[\s\S]*?\]|\((?:[^\\)]|\\.)*\)|\/?[^\s<>]+)/g;
  let m;
  while ((m = re.exec(dictStr)) !== null){
    entries.push({ key: '/' + m[1], value: m[2] });
  }
  return entries;
}

function _composeWidgetDict({ rect, parentObjNum, pageObjNum, extras = [], flags = 132 }){
  const parts = ['<<', '/Type /Annot', '/Subtype /Widget', '/FT /Sig'];
  if (Array.isArray(rect) && rect.length === 4) {
    const rectVals = rect.map((n) => _formatPdfNumber(Number(n) || 0));
    parts.push('/Rect [ ' + rectVals.join(' ') + ' ]');
  }
  if (typeof flags === 'number') {
    parts.push('/F ' + flags);
  }
  if (typeof parentObjNum === 'number' && parentObjNum >= 0) {
    parts.push('/Parent ' + parentObjNum + ' 0 R');
  }
  if (typeof pageObjNum === 'number' && pageObjNum >= 0) {
    parts.push('/P ' + pageObjNum + ' 0 R');
  }
  extras.forEach((entry) => {
    if (entry && entry.key && entry.value) {
      parts.push(entry.key + ' ' + entry.value);
    }
  });
  parts.push('>>');
  return parts.join(' ');
}

function _removeRefFromArray(dictStr, arrayKey, objNum){
  const content = _extractArrayContent(dictStr, arrayKey);
  if (!content) return dictStr;
  const ref = objNum + ' 0 R';
  const refs = content.match(/\d+\s+0\s+R/g) || [];
  const filtered = refs.filter((item) => item !== ref);
  if (filtered.length === refs.length) return dictStr;
  const keyEsc = arrayKey.replace('/', '\\/');
  const re = new RegExp(keyEsc + '\\s*\[[^\]]*\]');
  if (filtered.length === 0) {
    return dictStr.replace(re, '');
  }
  const replacement = arrayKey + ' [ ' + filtered.join(' ') + ' ]';
  return dictStr.replace(re, replacement);
}

function _ensureSigFlags(dictStr){
  if (/\/SigFlags\s+3\b/.test(dictStr)) return dictStr;
  if (/\/SigFlags\b/.test(dictStr)){
    return dictStr.replace(/\/SigFlags\s+\d+/, '/SigFlags 3');
  }
  return _injectKeyRaw(dictStr, '/SigFlags 3');
}

function _buildXrefSorted(newObjs){
  const byNum = newObjs.slice().sort(function(a,b){ return a.objNum - b.objNum; });
  const groups = [];
  var i = 0;
  while (i < byNum.length){
    var start = byNum[i].objNum;
    var arr = [byNum[i]];
    i++;
    while (i < byNum.length && byNum[i].objNum === arr[arr.length - 1].objNum + 1){
      arr.push(byNum[i]); i++;
    }
    groups.push({ start: start, arr: arr });
  }
  var out = 'xref\n';
  for (var gi = 0; gi < groups.length; gi++){
    var g = groups[gi];
    out += (g.start + ' ' + g.arr.length + '\n');
    for (var ai = 0; ai < g.arr.length; ai++){
      var o = g.arr[ai];
      out += (String(o.offset).padStart(10,'0') + ' 00000 n \n');
    }
  }
  return out;
}

function _appendXrefTrailer(baseBuf, newObjs, opts){
  const size = opts.size, rootRef = opts.rootRef, prevXref = opts.prevXref;
  var pos = baseBuf.length;
  const chunks = [];
  for (var i=0; i<newObjs.length; i++){
    var o = newObjs[i];
    o.offset = pos;
    const header = Buffer.from(o.objNum + ' 0 obj\n', 'latin1');
    let body;
    if (Buffer.isBuffer(o.contentBuffer)) {
      body = o.contentBuffer;
    } else if (typeof o.contentStr === 'string') {
      body = Buffer.from(o.contentStr, 'latin1');
    } else {
      body = Buffer.alloc(0);
    }
    const footer = Buffer.from('\nendobj\n', 'latin1');
    const chunk = Buffer.concat([header, body, footer]);
    chunks.push(chunk);
    pos += chunk.length;
  }
  const xrefPos = pos;
  const xref = _buildXrefSorted(newObjs);
  const trailer = 'trailer\n<< /Size ' + size + ' /Root ' + rootRef + ' /Prev ' + prevXref + ' >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
  return Buffer.concat([baseBuf, Buffer.concat(chunks), Buffer.from(xref + trailer, 'latin1')]);
}

/**
 * PDF’te AcroForm yoksa oluşturur; boş /Sig alanı yoksa ekler.
 * Ayrıca:
 *  - AcroForm’a /SigFlags 3,
 *  - Boş /Sig field + görünmez Widget (/Parent=field, /P=page),
 *  - 1. sayfanın /Annots’una widget referansı eklenir (gerçek /Page objesi!).
 */
function ensureAcroFormAndEmptySigField(pdfBuffer, fieldName, options){
  const opts = options || {};
  const requestedName = (typeof fieldName === 'string' && fieldName.length > 0) ? fieldName : null;
  const fieldLabel = requestedName || 'Sig1';
  const requestedRect = Array.isArray(opts.rect) && opts.rect.length === 4 ? opts.rect.map((v) => Number(v) || 0) : null;
  const hasPageIndex = typeof opts.pageIndex === 'number' && opts.pageIndex >= 0;
  const requestedPageIndex = hasPageIndex ? Math.floor(opts.pageIndex) : null;

  const meta = readLastTrailer(pdfBuffer);
  const root = readObject(pdfBuffer, meta.rootObjNum);
  if (!root) throw new Error('Root object not found');

  const acroInfo = locateAcroForm(pdfBuffer, meta.rootObjNum);
  const existingField = findEmptySignatureField(pdfBuffer, meta.rootObjNum, requestedName);

  const updates = new Map();
  let nextObj = meta.size;

  let acroObjNum;
  let acroDict = acroInfo ? acroInfo.dictStr : null;
  let acroChanged = false;

  let rootDict = root.dictStr;
  let rootChanged = false;

  if (acroInfo) {
    acroObjNum = acroInfo.objNum;
  } else {
    acroObjNum = nextObj++;
    acroDict = '<< /Type /AcroForm /Fields [] /SigFlags 3 >>';
    acroChanged = true;
    const updatedRoot = _injectKeyRef(rootDict, '/AcroForm', acroObjNum + ' 0 R');
    if (updatedRoot !== rootDict) {
      rootDict = updatedRoot;
      rootChanged = true;
    }
  }

  if (acroDict) {
    const withType = _injectKeyRaw(acroDict, '/Type /AcroForm');
    if (withType !== acroDict) {
      acroDict = withType;
      acroChanged = true;
    }
    const withFlags = _ensureSigFlags(acroDict);
    if (withFlags !== acroDict) {
      acroDict = withFlags;
      acroChanged = true;
    }
  }

  let fieldObjNum;
  let widgetObjNum = null;
  let widgetDictStr = null;
  let fieldDictStr = null;
  let pageObjNum = null;
  let originalWidgetPage = null;

  if (existingField) {
    fieldObjNum = existingField.objNum;
    fieldDictStr = existingField.dictStr;
    const kids = _extractRefArray(fieldDictStr, '/Kids');
    if (kids.length > 0) {
      widgetObjNum = kids[0];
      const widgetObj = readObject(pdfBuffer, widgetObjNum);
      if (widgetObj && widgetObj.dictStr) {
        widgetDictStr = widgetObj.dictStr;
        const pageMatch = /\/P\s+(\d+)\s+0\s+R/.exec(widgetDictStr);
        if (pageMatch) {
          originalWidgetPage = parseInt(pageMatch[1], 10);
          if (Number.isInteger(originalWidgetPage)) {
            pageObjNum = originalWidgetPage;
          }
        }
      }
    }
    if (!widgetObjNum) {
      widgetObjNum = nextObj++;
      widgetDictStr = '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /F 132 /Parent ' + fieldObjNum + ' 0 R >>';
      updates.set(widgetObjNum, { contentStr: widgetDictStr });
      const updatedFieldDict = _appendUniqueRef(fieldDictStr || '<<>>', '/Kids', widgetObjNum);
      if (updatedFieldDict !== fieldDictStr) {
        fieldDictStr = updatedFieldDict;
        updates.set(fieldObjNum, { contentStr: fieldDictStr });
      }
    }
    const updatedAcro = _appendUniqueRef(acroDict || '<<>>', '/Fields', fieldObjNum);
    if (updatedAcro !== acroDict) {
      acroDict = updatedAcro;
      acroChanged = true;
    }
  } else {
    fieldObjNum = nextObj++;
    widgetObjNum = nextObj++;
    fieldDictStr = '<< /FT /Sig /T (' + fieldLabel + ') /Ff 0 /Kids [ ' + widgetObjNum + ' 0 R ] >>';
    updates.set(fieldObjNum, { contentStr: fieldDictStr });

    try {
      pageObjNum = hasPageIndex ? findPageObjNumByIndex(pdfBuffer, requestedPageIndex) : findFirstPageObjNumSafe(pdfBuffer);
    } catch (err) {
      pageObjNum = _findFirstPageByScan(pdfBuffer);
      if (!pageObjNum) throw err;
    }
    const pageObj = readObject(pdfBuffer, pageObjNum);
    if (!pageObj || !/\/Type\s*\/Page\b/.test(pageObj.dictStr)) {
      throw new Error('Resolved page is not /Type /Page');
    }

    widgetDictStr = '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /F 132 /Parent ' + fieldObjNum + ' 0 R /P ' + pageObjNum + ' 0 R >>';
    updates.set(widgetObjNum, { contentStr: widgetDictStr });

    let pageDict = pageObj.dictStr;
    const updatedPage = _appendUniqueRef(pageDict || '<<>>', '/Annots', widgetObjNum);
    if (updatedPage !== pageDict) {
      updates.set(pageObjNum, { contentStr: updatedPage });
    }

    const updatedAcro = _appendUniqueRef(acroDict || '<<>>', '/Fields', fieldObjNum);
    if (updatedAcro !== acroDict) {
      acroDict = updatedAcro;
      acroChanged = true;
    }
  }

  if (!widgetDictStr) {
    const widgetObj = readObject(pdfBuffer, widgetObjNum);
    widgetDictStr = widgetObj && widgetObj.dictStr ? widgetObj.dictStr : '<<>>';
  }

  const resolvePageObj = () => {
    if (typeof pageObjNum === 'number' && pageObjNum >= 0) return pageObjNum;
    if (hasPageIndex) {
      try {
        pageObjNum = findPageObjNumByIndex(pdfBuffer, requestedPageIndex);
        return pageObjNum;
      } catch (_err) {
        // fallthrough
      }
    }
    if (typeof originalWidgetPage === 'number' && originalWidgetPage >= 0) {
      pageObjNum = originalWidgetPage;
      return pageObjNum;
    }
    try {
      pageObjNum = findFirstPageObjNumSafe(pdfBuffer);
      return pageObjNum;
    } catch (_err) {
      pageObjNum = _findFirstPageByScan(pdfBuffer);
      return pageObjNum;
    }
  };

  const finalPageObj = resolvePageObj();

  let appliedRect = null;
  if (requestedRect) {
    appliedRect = requestedRect;
  } else {
    const existingRect = _parseRect(widgetDictStr);
    if (existingRect) appliedRect = existingRect;
  }

  const parentObjNum = (() => {
    const existingParent = _extractRef(widgetDictStr, '/Parent');
    if (typeof existingParent === 'number' && existingParent >= 0) return existingParent;
    return fieldObjNum;
  })();

  const extras = _extractDictEntries(widgetDictStr || '<<>>').filter((entry) => {
    const key = entry.key;
    return !['/Type', '/Subtype', '/FT', '/Rect', '/F', '/Parent', '/P'].includes(key);
  });

  const targetPageObjNum = (typeof finalPageObj === 'number' && finalPageObj >= 0)
    ? finalPageObj
    : (typeof originalWidgetPage === 'number' && originalWidgetPage >= 0 ? originalWidgetPage : null);

  widgetDictStr = _composeWidgetDict({
    rect: Array.isArray(appliedRect) ? appliedRect : null,
    parentObjNum,
    pageObjNum: targetPageObjNum,
    extras
  });
  updates.set(widgetObjNum, { contentStr: widgetDictStr });

  if (typeof targetPageObjNum === 'number' && targetPageObjNum >= 0) {
    const pageObj = readObject(pdfBuffer, targetPageObjNum);
    if (pageObj && pageObj.dictStr) {
      let pageDict = pageObj.dictStr;
      const pageWithAnnot = _appendUniqueRef(pageDict, '/Annots', widgetObjNum);
      if (pageWithAnnot !== pageDict) {
        pageDict = pageWithAnnot;
        updates.set(targetPageObjNum, { contentStr: pageDict });
      }
    }
    if (typeof originalWidgetPage === 'number' && originalWidgetPage >= 0 && originalWidgetPage !== targetPageObjNum) {
      const oldPageObj = readObject(pdfBuffer, originalWidgetPage);
      if (oldPageObj && oldPageObj.dictStr) {
        const cleaned = _removeRefFromArray(oldPageObj.dictStr, '/Annots', widgetObjNum);
        if (cleaned !== oldPageObj.dictStr) {
          updates.set(originalWidgetPage, { contentStr: cleaned });
        }
      }
    }
  }

  if (acroChanged && typeof acroObjNum === 'number') {
    updates.set(acroObjNum, { contentStr: acroDict });
  }
  if (rootChanged) {
    updates.set(meta.rootObjNum, { contentStr: rootDict });
  }

  if (updates.size === 0) {
    const rectOut = Array.isArray(appliedRect) ? appliedRect : (_parseRect(widgetDictStr) || [0, 0, 0, 0]);
    return {
      pdf: pdfBuffer,
      fieldObjNum,
      widgetObjNum,
      pageObjNum: typeof targetPageObjNum === 'number' ? targetPageObjNum : (typeof originalWidgetPage === 'number' ? originalWidgetPage : null),
      rect: rectOut
    };
  }

  const newObjs = [];
  updates.forEach((value, key) => {
    newObjs.push({ objNum: key, ...value });
  });
  const maxObjNum = newObjs.reduce((max, obj) => Math.max(max, obj.objNum), -Infinity);
  const newSize = Math.max(meta.size, maxObjNum + 1);
  const updatedPdf = _appendXrefTrailer(pdfBuffer, newObjs, { size: newSize, rootRef: meta.rootRef, prevXref: meta.startxref });
  const rectOut = Array.isArray(appliedRect) ? appliedRect : (_parseRect(widgetDictStr) || [0, 0, 0, 0]);

  return {
    pdf: updatedPdf,
    fieldObjNum,
    widgetObjNum,
    pageObjNum: typeof targetPageObjNum === 'number' ? targetPageObjNum : (typeof originalWidgetPage === 'number' ? originalWidgetPage : null),
    rect: rectOut
  };
}

/* --------------------------- İmza yerleştirici sınıfı --------------------------- */

class PDFPAdESWriter {
  constructor(pdfBuffer){
    if (!Buffer.isBuffer(pdfBuffer)) throw new Error('pdfBuffer must be Buffer');
    this.pdf = pdfBuffer;
    const meta = readLastTrailer(this.pdf);
    this.rootRef = meta.rootRef;
    this.rootObjNum = meta.rootObjNum;
    this.size = meta.size;
    this.prevXref = meta.startxref;
    this._ph = null;
  }

  /**
   * subFilter:
   *  - 'ETSI.CAdES.detached'  → PAdES-T imza (Type /Sig)
   *  - 'ETSI.RFC3161'         → Belge Zaman Damgası (Type /Sig, SubFilter ETSI.RFC3161)
   * fieldName: varsa o isimli /Sig alanı doldurulur; yoksa ilk boş alan
   */
  preparePlaceholder(opts){
    opts = opts || {};
    var subFilter = opts.subFilter || 'ETSI.CAdES.detached';
    var placeholderHexLen = (typeof opts.placeholderHexLen === 'number') ? opts.placeholderHexLen : 120000;
    if (placeholderHexLen < 2) {
      throw new Error('placeholderHexLen must be at least 2.');
    }
    if (placeholderHexLen % 2 !== 0) {
      placeholderHexLen += 1;
    }
    var fieldName = opts.fieldName || null;

    const acro = locateAcroForm(this.pdf, this.rootObjNum);
    if (!acro) throw new Error('/AcroForm not found. Provide at least one empty /Sig field.');
    const field = findEmptySignatureField(this.pdf, this.rootObjNum, fieldName);
    if (!field) throw new Error('Empty signature field not found (FT/Sig without /V).');

    // Widget → /P (sayfa) referansını bul; imza sözlüğüne /P ekleyelim (doğrulamalı)
    var pageRefStr = null;
    const fieldObj = readObject(this.pdf, field.objNum);
    if (fieldObj){
      const kidM = /\/Kids\s*\[\s*(\d+)\s+0\s+R/.exec(fieldObj.dictStr);
      if (kidM){
        const wNum = parseInt(kidM[1],10);
        const wObj = readObject(this.pdf, wNum);
        if (wObj){
          const pM = /\/P\s+(\d+)\s+0\s+R/.exec(wObj.dictStr);
          if (pM) pageRefStr = pM[1] + ' 0 R';
        }
      }
    }
    if (pageRefStr) {
      const mm = /(\d+)\s+0\s+R/.exec(pageRefStr);
      if (mm) {
        const pg = readObject(this.pdf, parseInt(mm[1],10));
        if (!pg || !/\/Type\s*\/Page\b/.test(pg.dictStr)) {
          pageRefStr = null;
        }
      } else {
        pageRefStr = null;
      }
    }

    const sigObjNum = this.size;
    const fieldObjNum = field.objNum;
    const placeholderHex = new Array(placeholderHexLen + 1).join('0');
    const dateStr = this._pdfDate(new Date());
    const BR = '0000000000 0000000000 0000000000 0000000000';

    const pPart = pageRefStr ? (' /P ' + pageRefStr) : '';
    const sigDict = '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /' + subFilter + pPart +
                    ' /ByteRange [' + BR + '] /Contents <' + placeholderHex + '> /M (' + dateStr + ') >>';

    const fieldOrig = readObject(this.pdf, fieldObjNum);
    const newFieldDictStr = this._injectV(fieldOrig.dictStr, sigObjNum + ' 0 R');

    const baseLen = this.pdf.length;
    const appendedParts = [];
    const xrefObjs = [];
    let offsetCursor = baseLen;

    const pushObj = (objNum, contentStr) => {
      const objStr = objNum + ' 0 obj\n' + contentStr + '\nendobj\n';
      const buf = Buffer.from(objStr, 'latin1');
      appendedParts.push(buf);
      xrefObjs.push({ objNum, offset: offsetCursor });
      offsetCursor += buf.length;
    };

    pushObj(sigObjNum, sigDict);
    pushObj(fieldObjNum, newFieldDictStr);

    if (subFilter === 'ETSI.RFC3161') {
      const rootObj = readObject(this.pdf, this.rootObjNum);
      if (!rootObj || !rootObj.dictStr) {
        throw new Error('Root object not found while preparing DocTimeStamp placeholder.');
      }
      const docTsRef = sigObjNum + ' 0 R';
      const permsInfo = _ensureDocTimeStampPerms(this.pdf, rootObj.dictStr, docTsRef);
      if (permsInfo.rootChanged) {
        pushObj(this.rootObjNum, permsInfo.rootDict);
      }
      if (Array.isArray(permsInfo.extraObjs) && permsInfo.extraObjs.length) {
        permsInfo.extraObjs.forEach((extra) => {
          pushObj(extra.objNum, extra.contentStr);
        });
      }
    }

    const appended = Buffer.concat(appendedParts);
    const xrefPos = baseLen + appended.length;
    const xref = _buildXrefSorted(xrefObjs);

    const maxObjNum = xrefObjs.length > 0
      ? xrefObjs.reduce((max, obj) => Math.max(max, obj.objNum), -Infinity)
      : (this.size - 1);
    const newSize = Math.max(this.size, maxObjNum + 1);
    const trailer = 'trailer\n<< /Size ' + newSize + ' /Root ' + this.rootRef + ' /Prev ' + this.prevXref + ' >>\nstartxref\n' + xrefPos + '\n%%EOF\n';

    var draft = Buffer.concat([this.pdf, appended, Buffer.from(xref + trailer, 'latin1')]);

    const spans = this._locateNewSigSpans(draft, sigObjNum);
    const contentsStart = spans.contentsStart;
    const contentsEnd   = spans.contentsEnd;
    const brNumsStart   = spans.brNumsStart;
    const lessThanPos   = spans.lessThanPos;
    const greaterThanPos = spans.greaterThanPos;

    const beforeLen = lessThanPos - 0;
    const afterStart = greaterThanPos + 1;
    const afterLen = draft.length - afterStart;

    const brText = this._p10(0) + ' ' + this._p10(beforeLen) + ' ' + this._p10(afterStart) + ' ' + this._p10(afterLen);
    draft = this._patchByteRange(draft, brNumsStart, brText);

    this.pdf = draft;
    this._ph = {
      sigObjNum: sigObjNum,
      fieldObjNum: fieldObjNum,
      contentsStart: contentsStart,
      contentsEnd: contentsEnd,
      lessThanPos: lessThanPos,
      greaterThanPos: greaterThanPos,
      afterStart: afterStart,
      placeholderHexLen: placeholderHexLen
    };
    return {
      sigObjNum: sigObjNum,
      fieldObjNum: fieldObjNum,
      subFilter: subFilter,
      placeholderHexLen: placeholderHexLen,
      byteRange: [0, beforeLen, afterStart, afterLen]
    };
  }

  prepareDocumentTimeStampPlaceholder(opts){
    opts = opts || {};
    var placeholderHexLen = (typeof opts.placeholderHexLen === 'number') ? opts.placeholderHexLen : 64000;

    if (placeholderHexLen < 2) {
      throw new Error('placeholderHexLen must be at least 2.');
    }
    if (placeholderHexLen % 2 !== 0) {
      placeholderHexLen += 1;
    }

    let nextObjNum = this.size;
    const allocateObjNum = () => nextObjNum++;

    const docTsObjNum = allocateObjNum();
    let pageRefStr = null;
    try {
      const firstPage = findFirstPageObjNumSafe(this.pdf);
      if (typeof firstPage === 'number' && firstPage >= 0) {
        pageRefStr = firstPage + ' 0 R';
      }
    } catch (err) {
      // ignore — /P anahtarı zorunlu değil, bulamazsak eklemeyelim
      pageRefStr = null;
    }

    const placeholderHex = new Array(placeholderHexLen + 1).join('0');
    const dateStr = this._pdfDate(new Date());
    const BR = '0000000000 0000000000 0000000000 0000000000';
    const pPart = pageRefStr ? (' /P ' + pageRefStr) : '';
    const sigDict = '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161' + pPart +
                    ' /ByteRange [' + BR + '] /Contents <' + placeholderHex + '> /M (' + dateStr + ') >>';

    const rootObj = readObject(this.pdf, this.rootObjNum);
    if (!rootObj || !rootObj.dictStr) {
      throw new Error('Root object not found while preparing DocTimeStamp placeholder.');
    }

    const docTsRef = docTsObjNum + ' 0 R';
    const permsInfo = _ensureDocTimeStampPerms(this.pdf, rootObj.dictStr, docTsRef);

    const acroInfo = _ensureDocTimeStampAcroForm(this.pdf, permsInfo.rootDict, allocateObjNum, {
      docTsRef,
      pageRefStr,
      fieldName: opts.fieldName
    });

    const newObjs = [{ objNum: docTsObjNum, contentStr: sigDict }];
    if (permsInfo.rootChanged || acroInfo.rootChanged) {
      newObjs.push({ objNum: this.rootObjNum, contentStr: acroInfo.rootDict });
    }
    if (Array.isArray(permsInfo.extraObjs) && permsInfo.extraObjs.length) {
      Array.prototype.push.apply(newObjs, permsInfo.extraObjs);
    }
    if (Array.isArray(acroInfo.extraObjs) && acroInfo.extraObjs.length) {
      Array.prototype.push.apply(newObjs, acroInfo.extraObjs);
    }

    const newSize = Math.max(this.size, nextObjNum);

    const draft = _appendXrefTrailer(this.pdf, newObjs, {
      size: newSize,
      rootRef: this.rootRef,
      prevXref: this.prevXref
    });

    const spans = this._locateNewSigSpans(draft, docTsObjNum);
    const contentsStart = spans.contentsStart;
    const contentsEnd   = spans.contentsEnd;
    const brNumsStart   = spans.brNumsStart;
    const lessThanPos   = spans.lessThanPos;
    const greaterThanPos = spans.greaterThanPos;

    const beforeLen = lessThanPos - 0;
    const afterStart = greaterThanPos + 1;
    const afterLen = draft.length - afterStart;

    const brText = this._p10(0) + ' ' + this._p10(beforeLen) + ' ' + this._p10(afterStart) + ' ' + this._p10(afterLen);
    const patched = this._patchByteRange(draft, brNumsStart, brText);

    this.pdf = patched;
    this._ph = {
      sigObjNum: docTsObjNum,
      fieldObjNum: null,
      contentsStart: contentsStart,
      contentsEnd: contentsEnd,
      lessThanPos: lessThanPos,
      greaterThanPos: greaterThanPos,
      afterStart: afterStart,
      placeholderHexLen: placeholderHexLen
    };
    return {
      sigObjNum: docTsObjNum,
      fieldObjNum: null,
      subFilter: 'ETSI.RFC3161',
      placeholderHexLen: placeholderHexLen,
      byteRange: [0, beforeLen, afterStart, afterLen]
    };
  }

  computeByteRangeHash(algo){
    if (!algo) algo = 'sha256';
    if (!this._ph) throw new Error('call preparePlaceholder() first');
    const h = crypto.createHash(algo);
    const a = 0;
    const b = this._ph.lessThanPos;
    const c = this._ph.afterStart;
    const d = this.pdf.length - this._ph.afterStart;
    h.update(this.pdf.slice(a, a + b));
    h.update(this.pdf.slice(c, c + d));
    return h.digest();
  }

  injectCMS(cmsDer){
    if (!this._ph) throw new Error('call preparePlaceholder() first');
    const dataHexRaw = Buffer.isBuffer(cmsDer) ? cmsDer.toString('hex') : String(cmsDer).replace(/\s+/g,'');
    const dataHex = dataHexRaw.toUpperCase();
    const capacity = (this._ph.contentsEnd - this._ph.contentsStart + 1);
    if (dataHex.length > capacity) throw new Error('/Contents capacity too small. Need hex ' + dataHex.length + ', have ' + capacity);
    const padded = dataHex + new Array(capacity - dataHex.length + 1).join('0');
    const before = this.pdf.slice(0, this._ph.contentsStart);
    const after  = this.pdf.slice(this._ph.contentsEnd + 1);
    this.pdf = Buffer.concat([before, Buffer.from(padded, 'latin1'), after]);
  }

  toBuffer(){ return this.pdf; }

  /* ----------------------------- iç yardımcılar ----------------------------- */

  _injectV(dictStr, sigRef){
    if (/\/V\s+\d+\s+0\s+R/.test(dictStr)) return dictStr;
    return dictStr.replace(/>>\s*$/, ' /V ' + sigRef + ' >>');
  }
  _p10(n){ return String(n).padStart(10,'0'); }
  _pdfDate(d){
    function pad(x){ return String(x).padStart(2,'0'); }
    return 'D:' + d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) +
           pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  _locateNewSigSpans(buf, sigObjNum){
    const s = buf.toString('latin1');
    const pat = sigObjNum + '\\s+0\\s+obj\\s*<<[\\s\\S]*?>>\\s*endobj';
    const reObj = new RegExp(pat);
    const m = reObj.exec(s); if (!m) throw new Error('signature object not found');
    const objStr = m[0]; const base = m.index;

    const mc = /\/Contents\s*<([\s\S]*?)>/.exec(objStr);
    if (!mc) throw new Error('/Contents placeholder missing');
    const rel = objStr.slice(mc.index);
    const ltOffset = rel.indexOf('<');
    if (ltOffset < 0) throw new Error('/Contents opening < not found');
    const gtOffset = rel.indexOf('>', ltOffset);
    if (gtOffset < 0) throw new Error('/Contents closing > not found');
    const lessThanPos = base + mc.index + ltOffset;
    const greaterThanPos = base + mc.index + gtOffset;
    const cStartInObj = lessThanPos + 1 - base;
    const inside = mc[1].replace(/[\s\r\n]/g,'');
    const cEndInObj   = cStartInObj + inside.length;

    const mbr = /\/ByteRange\s*\[\s*0{10}\s+0{10}\s+0{10}\s+0{10}\s*\]/.exec(objStr);
    if (!mbr) throw new Error('/ByteRange placeholder missing');
    const brNumsStart = mbr.index + objStr.slice(mbr.index).indexOf('[') + 1;

    return {
      contentsStart: base + cStartInObj,
      contentsEnd: base + cEndInObj - 1,
      brNumsStart: base + brNumsStart,
      lessThanPos: lessThanPos,
      greaterThanPos: greaterThanPos
    };
  }

  _patchByteRange(buf, brNumsStart, text){
    if (!/^\d{10}\s+\d{10}\s+\d{10}\s+\d{10}$/.test(text)) throw new Error('BR text must be 4x 10-digit ints');
    const before = buf.slice(0, brNumsStart);
    const after  = buf.slice(brNumsStart + text.length);
    return Buffer.concat([before, Buffer.from(text, 'latin1'), after]);
  }
}

function applyVisibleSignatureAppearance(pdfBuffer, options){
  if (!options || typeof options !== 'object') throw new Error('options required');
  const { widgetObjNum, pageObjNum = null, rect, pngBuffer, appearanceName, parentObjNum = null } = options;
  if (!Buffer.isBuffer(pngBuffer)) throw new Error('pngBuffer must be Buffer');
  if (typeof widgetObjNum !== 'number') throw new Error('widgetObjNum must be a number');
  const rectArr = Array.isArray(rect) && rect.length === 4 ? rect.map((v) => Number(v) || 0) : null;
  if (!rectArr) throw new Error('rect must be an array of 4 numbers');

  const png = parsePng(pngBuffer);
  const meta = readLastTrailer(pdfBuffer);
  let nextObj = meta.size;

  const imageObjNum = nextObj++;
  let smaskObjNum = null;
  const newObjs = [];

  const colorCompressed = zlib.deflateSync(png.pixelData);
  const imageDictParts = [
    '/Type /XObject',
    '/Subtype /Image',
    '/Width ' + png.width,
    '/Height ' + png.height,
    '/ColorSpace /' + png.colorSpace,
    '/BitsPerComponent ' + png.bitDepth,
    '/Filter /FlateDecode',
    '/Length ' + colorCompressed.length
  ];
  if (png.alphaData) {
    smaskObjNum = nextObj++;
    imageDictParts.push('/SMask ' + smaskObjNum + ' 0 R');
  }
  const imageHeader = '<< ' + imageDictParts.join(' ') + ' >>\nstream\n';
  const imageBuffer = Buffer.concat([Buffer.from(imageHeader, 'latin1'), colorCompressed, Buffer.from('\nendstream', 'latin1')]);
  newObjs.push({ objNum: imageObjNum, contentBuffer: imageBuffer });

  if (png.alphaData) {
    const alphaCompressed = zlib.deflateSync(png.alphaData);
    const smaskParts = [
      '/Type /XObject',
      '/Subtype /Image',
      '/Width ' + png.width,
      '/Height ' + png.height,
      '/ColorSpace /DeviceGray',
      '/BitsPerComponent 8',
      '/Filter /FlateDecode',
      '/Length ' + alphaCompressed.length
    ];
    const smaskHeader = '<< ' + smaskParts.join(' ') + ' >>\nstream\n';
    const smaskBuffer = Buffer.concat([Buffer.from(smaskHeader, 'latin1'), alphaCompressed, Buffer.from('\nendstream', 'latin1')]);
    newObjs.push({ objNum: smaskObjNum, contentBuffer: smaskBuffer });
  }

  const rectWidth = rectArr[2] - rectArr[0];
  const rectHeight = rectArr[3] - rectArr[1];
  const appearanceWidth = Math.abs(rectWidth);
  const appearanceHeight = Math.abs(rectHeight);
  if (appearanceWidth === 0 || appearanceHeight === 0) {
    throw new Error('visible signature rect must have non-zero width and height');
  }

  const rawName = typeof appearanceName === 'string' && appearanceName.length > 0 ? appearanceName : 'ImStamp';
  const sanitized = rawName.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '') || 'ImStamp';
  const nameToken = '/' + sanitized;

  const appearanceBodyLines = [
    'q',
    _formatPdfNumber(appearanceWidth) + ' 0 0 ' + _formatPdfNumber(appearanceHeight) + ' 0 0 cm',
    nameToken + ' Do',
    'Q'
  ];
  const appearanceBody = Buffer.from(appearanceBodyLines.join('\n') + '\n', 'latin1');
  const appearanceDictParts = [
    '/Type /XObject',
    '/Subtype /Form',
    '/FormType 1',
    '/BBox [0 0 ' + _formatPdfNumber(appearanceWidth) + ' ' + _formatPdfNumber(appearanceHeight) + ']',
    '/Resources << /XObject << ' + nameToken + ' ' + imageObjNum + ' 0 R >> >>',
    '/Length ' + appearanceBody.length
  ];
  const appearanceHeader = '<< ' + appearanceDictParts.join(' ') + ' >>\nstream\n';
  const appearanceBuffer = Buffer.concat([Buffer.from(appearanceHeader, 'latin1'), appearanceBody, Buffer.from('\nendstream', 'latin1')]);
  const appearanceObjNum = nextObj++;
  newObjs.push({ objNum: appearanceObjNum, contentBuffer: appearanceBuffer });

  const widgetObj = readObject(pdfBuffer, widgetObjNum);
  if (!widgetObj || !widgetObj.dictStr) throw new Error('Widget object not found');
  const existingParent = _extractRef(widgetObj.dictStr, '/Parent');
  const existingPage = _extractRef(widgetObj.dictStr, '/P');
  const extras = _extractDictEntries(widgetObj.dictStr).filter((entry) => {
    return !['/Type', '/Subtype', '/FT', '/Rect', '/F', '/Parent', '/P', '/AP', '/AS'].includes(entry.key);
  });
  const normalizedWidget = _composeWidgetDict({
    rect: rectArr,
    parentObjNum: typeof parentObjNum === 'number' && parentObjNum >= 0
      ? parentObjNum
      : (typeof existingParent === 'number' ? existingParent : null),
    pageObjNum: typeof pageObjNum === 'number' && pageObjNum >= 0
      ? pageObjNum
      : (typeof existingPage === 'number' ? existingPage : null),
    extras
  });
  let widgetDict = normalizedWidget.replace(/>>\s*$/, '');
  if (!/\/Parent\s+\d+\s+0\s+R/.test(widgetDict) && typeof existingParent === 'number' && existingParent >= 0) {
    widgetDict += ' /Parent ' + existingParent + ' 0 R';
  }
  if (typeof pageObjNum === 'number' && pageObjNum >= 0 && !/\/P\s+\d+\s+0\s+R/.test(widgetDict)) {
    widgetDict += ' /P ' + pageObjNum + ' 0 R';
  }
  widgetDict += ' /AP << /N ' + appearanceObjNum + ' 0 R >>';
  widgetDict += ' /AS /N';
  widgetDict += ' >>';
  newObjs.push({ objNum: widgetObjNum, contentStr: widgetDict });

  const maxObjNum = newObjs.reduce((max, obj) => Math.max(max, obj.objNum), -Infinity);
  const newSize = Math.max(meta.size, maxObjNum + 1);
  const updatedPdf = _appendXrefTrailer(pdfBuffer, newObjs, { size: newSize, rootRef: meta.rootRef, prevXref: meta.startxref });

  return {
    pdf: updatedPdf,
    appearanceObjNum,
    imageObjNum,
    smaskObjNum,
    widgetObjNum
  };
}

/* ------------------------------ AcroForm lookup ------------------------------ */

function locateAcroForm(pdf, rootObjNum){
  const root = readObject(pdf, rootObjNum);
  if (!root) return null;
  const acroRef = /\/AcroForm\s+(\d+)\s+0\s+R/.exec(root.dictStr);
  if (!acroRef) return null;
  const acroNum = parseInt(acroRef[1],10);
  const acroObj = readObject(pdf, acroNum);
  if (!acroObj) return null;
  return { objNum: acroNum, dictStr: acroObj.dictStr };
}
function listFields(acroFormDictStr){
  const m = /\/Fields\s*\[\s*([^\]]*)\]/.exec(acroFormDictStr);
  if (!m) return [];
  const arr = [];
  const re = /(\d+)\s+0\s+R/g;
  var mm;
  while ((mm = re.exec(m[1])) !== null){ arr.push(parseInt(mm[1],10)); }
  return arr;
}
function findEmptySignatureField(pdf, rootObjNum, fieldName){
  const acro = locateAcroForm(pdf, rootObjNum);
  if (!acro) return null;
  const refs = listFields(acro.dictStr);
  for (var i=0; i<refs.length; i++){
    const n = refs[i];
    const f = readObject(pdf, n);
    if (!f) continue;
    if (!/\/FT\s*\/Sig/.test(f.dictStr)) continue;
    if (/\/V\s+\d+\s+0\s+R/.test(f.dictStr)) continue;
    if (fieldName) {
      const nameM = /\/T\s*\((.*?)\)/.exec(f.dictStr);
      if (!nameM || nameM[1] !== fieldName) continue;
    }
    return { objNum: n, dictStr: f.dictStr };
  }
  return null;
}

/* --------------------------------- exports --------------------------------- */

module.exports = {
  PDFPAdESWriter,
  ensureAcroFormAndEmptySigField,
  applyVisibleSignatureAppearance,
  readLastTrailer,
  readObject
};
