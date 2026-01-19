'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { PDFPAdESWriter, ensureAcroFormAndEmptySigField } = require('./pdf_parser');
const { pemToDer, parseCertBasics, parseKeyUsageAndEKU, extractSubjectCN } = require('./x509_extract');
const { buildTSQ, requestTimestamp, extractTimeStampTokenOrThrow } = require('./rfc3161');
const { OIDS } = require('./oids');
const { buildCAdES_BES_auto, addUnsignedAttr_signatureTimeStampToken, buildSignedData } = require('./cades_builder');

// TSA hash adı -> OID
const HASH_NAME_TO_OID = {
  sha256: OIDS.sha256,
  sha384: OIDS.sha384,
  sha512: OIDS.sha512,
};

class PAdESManager {
  constructor({ tsaUrl, tsaOptions = {}, tsaHeaders = {}, logger = null }) {
    this.tsaUrl = tsaUrl;
    this.tsaOptions = tsaOptions; // { hashName, certReq, reqPolicyOid, nonceBytes }
    this.tsaHeaders = tsaHeaders; // { Authorization: 'Basic ...', ... }
    this._buildTSQ = buildTSQ;
    this._requestTimestamp = requestTimestamp;
    this._extractTimeStampTokenOrThrow = extractTimeStampTokenOrThrow;
    this._hashSignatureForTimestamp = (signatureValue, hashName) => {
      const normalizedHash = (hashName || 'sha256').toLowerCase();
      if (!Buffer.isBuffer(signatureValue)) {
        signatureValue = Buffer.from(signatureValue);
      }
      return crypto.createHash(normalizedHash).update(signatureValue).digest();
    };
    this._parseKeyUsageAndEKU = parseKeyUsageAndEKU;
    const resolvedLogger = logger || null;
    if (resolvedLogger && typeof resolvedLogger.debug === 'function') {
      this.logger = resolvedLogger;
    } else if (resolvedLogger && typeof resolvedLogger.log === 'function') {
      this.logger = { debug: resolvedLogger.log.bind(resolvedLogger) };
    } else {
      this.logger = null;
    }
  }

  _logDebug(message, context) {
    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(message, context || {});
    }
  }

  /**
   * DocTimeStamp (ETSI.RFC3161) — imza olmadan yalnız TSA damgası ekler.
   * AcroForm/Sig yoksa görünmez bir /Sig alanı otomatik eklenir.
   */
  async addDocTimeStamp({ pdfBuffer, fieldName = null, placeholderHexLen = 64000 }) {
    const normalizedFieldName = (typeof fieldName === 'string' && fieldName.length > 0) ? fieldName : null;
    let workingPdf = pdfBuffer;

    if (normalizedFieldName) {
      workingPdf = ensureAcroFormAndEmptySigField(workingPdf, normalizedFieldName);
    }

    const writer = new PDFPAdESWriter(workingPdf);
    if (normalizedFieldName) {
      writer.preparePlaceholder({ subFilter: 'ETSI.RFC3161', placeholderHexLen, fieldName: normalizedFieldName });
    } else {
      writer.prepareDocumentTimeStampPlaceholder({ placeholderHexLen });
    }
    this._logDebug('DocTimeStamp.preparePlaceholder', {
      fieldName: normalizedFieldName,
      placeholderHexLen,
      mode: normalizedFieldName ? 'acro-field' : 'standalone'
    });

    // TSA hash seçimi
    const tsHashName = (this.tsaOptions.hashName || 'sha256').toLowerCase();
    const tsHashOid  = HASH_NAME_TO_OID[tsHashName] || OIDS.sha256;
    const allowMissingNonce = this.tsaOptions.allowMissingNonce;

    const tbsHash = writer.computeByteRangeHash(tsHashName);
    this._logDebug('DocTimeStamp.byteRangeHash', { hashAlgorithm: tsHashName, digest: tbsHash.toString('hex') });
    const { der: tsqDer, nonce: tsNonce } = this._buildTSQ(tbsHash, { hashOid: tsHashOid, certReq: true, ...this.tsaOptions });
    this._logDebug('DocTimeStamp.tsqBuilt', {
      nonce: tsNonce ? tsNonce.toString('hex') : null,
      tsqLength: tsqDer.length
    });
    const { der: tsRespDer } = await this._requestTimestamp(this.tsaUrl, tsqDer, this.tsaHeaders);
    this._logDebug('DocTimeStamp.tsaResponse', { responseLength: tsRespDer.length });
    const tst = this._extractTimeStampTokenOrThrow(tsRespDer, {
      expectedImprint: tbsHash,
      expectedNonce: tsNonce,
      expectedHashOid: tsHashOid,
      allowMissingNonce
    });

    writer.injectCMS(tst);
    this._logDebug('DocTimeStamp.injected', { cmsLength: tst.length });
    return writer.toBuffer();
  }

  /**
   * PAdES-T (CAdES-BES + signatureTimeStampToken).
   * Sertifikada imza yetkisi yoksa otomatik DocTS’e düşer.
   * AcroForm/Sig yoksa görünmez bir /Sig alanı otomatik eklenir.
   *
   * DocTS ekleme akışı `documentTimestamp` nesnesiyle yönetilir.
   *  - { append: true, fieldName, placeholderHexLen } → imzadan sonra DocTS ekler.
   *  - append=false (varsayılan) → yalnız imza + signatureTimeStampToken üretir.
   *  - Eski `addDocumentTimeStamp` ve ilgili parametreler geriye dönük uyumluluk için
   *    desteklenir.
   */
  async signPAdES_T({
    pdfBuffer,
    keyPem,
    certPem,
    chainPems = [],
    fieldName = null,
    placeholderHexLen = 120000,
    addDocumentTimeStamp = false,
    docTimeStampFieldName = null,
    docTimeStampPlaceholderHexLen = 64000,
    documentTimestamp = null,
    visibleSignature = null
  }) {
    this._logDebug('PAdES.sign.start', {
      fieldName,
      addDocumentTimeStamp,
      documentTimestampProvided: !!documentTimestamp
    });
    pdfBuffer = ensureAcroFormAndEmptySigField(pdfBuffer, fieldName || 'Sig1');

    // KeyUsage kontrolü (auto fallback DocTS)
    const leafDer = pemToDer(certPem);
    const subjectCN = (() => {
      try {
        return extractSubjectCN(leafDer) || null;
      } catch (err) {
        this._logDebug('PAdES.subjectCN.error', { error: err && err.message ? err.message : String(err) });
        return null;
      }
    })();
    const { keyUsage = {}, eku = [] } = this._parseKeyUsageAndEKU(leafDer);
    const keyUsageBitsPresent = Object.values(keyUsage).some(Boolean);
    const canSignByKU = !keyUsageBitsPresent || keyUsage.digitalSignature || keyUsage.contentCommitment;
    const ekuList = Array.isArray(eku) ? eku : [];
    const tsaOnly = ekuList.length > 0 && ekuList.every((oid) => oid === OIDS.id_kp_timeStamping);
    const canSign = canSignByKU && !tsaOnly;
    this._logDebug('PAdES.keyUsage', { keyUsage, eku: ekuList, canSign, reason: canSign ? 'allowed' : 'disallowed' });

    const normalizeFieldName = (name) => (typeof name === 'string' && name.length > 0 ? name : null);
    const resolvedDocTs = (() => {
      if (documentTimestamp && typeof documentTimestamp === 'object') {
        const append = !!documentTimestamp.append;
        const normalizedField = normalizeFieldName(documentTimestamp.fieldName);
        const placeholder = (typeof documentTimestamp.placeholderHexLen === 'number' && documentTimestamp.placeholderHexLen > 0)
          ? documentTimestamp.placeholderHexLen
          : 64000;
        return { append, fieldName: normalizedField, placeholderHexLen: placeholder };
      }

      const legacyField = normalizeFieldName(docTimeStampFieldName);
      const placeholder = (typeof docTimeStampPlaceholderHexLen === 'number' && docTimeStampPlaceholderHexLen > 0)
        ? docTimeStampPlaceholderHexLen
        : 64000;
      return { append: !!addDocumentTimeStamp, fieldName: legacyField, placeholderHexLen: placeholder };
    })();

    this._logDebug('PAdES.docTimeStamp.config', {
      append: resolvedDocTs.append,
      fieldName: resolvedDocTs.fieldName,
      placeholderHexLen: resolvedDocTs.placeholderHexLen,
      viaDocumentTimestampOption: !!documentTimestamp
    });

    if (!canSign) {
      const docTsPlaceholderLen = resolvedDocTs.append ? resolvedDocTs.placeholderHexLen : placeholderHexLen;
      const fallbackField = resolvedDocTs.append ? resolvedDocTs.fieldName : normalizeFieldName(fieldName);
      this._logDebug('PAdES.fallback.docTimeStamp', {
        fieldName: fallbackField,
        placeholderHexLen: docTsPlaceholderLen,
        appendRequested: resolvedDocTs.append
      });
      const fallbackPdf = await this.addDocTimeStamp({
        pdfBuffer,
        fieldName: fallbackField,
        placeholderHexLen: docTsPlaceholderLen
      });
      return { pdf: fallbackPdf, mode: 'docts-fallback' };
    }

    // PAdES-T akışı
    const writer = new PDFPAdESWriter(pdfBuffer);
    writer.preparePlaceholder({
      subFilter: 'adbe.pkcs7.detached',
      placeholderHexLen,
      fieldName,
      signerName: subjectCN || undefined
    });
    this._logDebug('PAdES.preparePlaceholder', { fieldName: fieldName || 'Sig1', placeholderHexLen });

    if (visibleSignature) {
      try {
        const cn = subjectCN;
        const coordMap = (visibleSignature && typeof visibleSignature === 'object' && visibleSignature.coordinateMap) || {};
        const defaultPosition = visibleSignature.defaultPosition || null;
        let resolved = null;
        if (cn && coordMap && Object.prototype.hasOwnProperty.call(coordMap, cn)) {
          resolved = coordMap[cn];
        }
        if (!resolved) {
          resolved = defaultPosition;
        }
        if (!resolved) {
          throw new Error('No visible signature position configured for CN ' + (cn || 'unknown'));
        }
        const rect = {};
        if (typeof resolved.x === 'number') rect.x = resolved.x;
        if (typeof resolved.y === 'number') rect.y = resolved.y;
        if (typeof resolved.width === 'number') rect.width = resolved.width;
        if (typeof resolved.height === 'number') rect.height = resolved.height;
        if (typeof resolved.origin === 'string' && resolved.origin.length > 0) {
          rect.origin = resolved.origin;
        }
        let imageBuffer = visibleSignature.imageBuffer || null;
        if (!imageBuffer) {
          if (!visibleSignature.imagePath) {
            throw new Error('visibleSignature.imagePath or imageBuffer must be provided');
          }
          imageBuffer = fs.readFileSync(visibleSignature.imagePath);
        }
        const maintainAspectRatio = visibleSignature.maintainAspectRatio !== false;
        const resolveTextLines = () => {
          const templ = visibleSignature.textTemplate || visibleSignature.textLines || visibleSignature.text;
          const cnValue = cn || visibleSignature.cnFallback || null;
          if (Array.isArray(templ)) {
            return templ
              .map((line) =>
                typeof line === 'string'
                  ? line.replace(/\{\{\s*CN\s*\}\}/g, cnValue || '').trim()
                  : null
              )
              .filter((line) => line && line.length > 0);
          }
          if (typeof templ === 'string' && templ.length > 0) {
            const text = templ.replace(/\{\{\s*CN\s*\}\}/g, cnValue || '').trim();
            return text ? [text] : [];
          }
          if (cnValue) {
            return ['İmzalayan: ' + cnValue];
          }
          return [];
        };
        const textLines = resolveTextLines();
        const textOpts = {
          textLines,
          textFontSize: visibleSignature.textFontSize,
          textLineHeight: visibleSignature.textLineHeight,
          textPadding: visibleSignature.textPadding,
          textPosition: visibleSignature.textPosition,
          textColor: visibleSignature.textColor,
          textMinFontSize: visibleSignature.textMinFontSize,
          textFontStep: visibleSignature.textFontStep
        };
        const appearanceResult = writer.applyVisibleSignatureFromPng({
          imageBuffer,
          rect,
          maintainAspectRatio,
          ...textOpts
        });
        this._logDebug('PAdES.visibleSignature.applied', {
          cn,
          rect: appearanceResult
        });
      } catch (err) {
        throw new Error('Visible signature appearance failed: ' + (err && err.message ? err.message : err));
      }
    }

    // İmzalanacak veri özeti (algoritma sertifikanın eğrisine göre)
    const { recommendedHash } = parseCertBasics(leafDer);
    const tbsHash = writer.computeByteRangeHash(recommendedHash);
    this._logDebug('PAdES.byteRangeHash', { hashAlgorithm: recommendedHash, digest: tbsHash.toString('hex') });

    // CAdES-BES üretimi
    const { signerInfo, signatureValue, hashName, leafDer: _ld, chainDer } =
      buildCAdES_BES_auto(tbsHash, keyPem, certPem, chainPems);
    this._logDebug('PAdES.signatureValue', { length: signatureValue.length });

    // İmza Zaman Damgası (RFC3161) — signatureValue üzerinde
    const tsHashName = (this.tsaOptions.hashName || 'sha256').toLowerCase();
    const tsHashOid  = HASH_NAME_TO_OID[tsHashName] || OIDS.sha256;
    const allowMissingNonce = this.tsaOptions.allowMissingNonce;

    const sigValHash = this._hashSignatureForTimestamp(signatureValue, tsHashName);
    this._logDebug('PAdES.signatureTimestamp.hash', {
      hashAlgorithm: tsHashName,
      digest: sigValHash.toString('hex')
    });
    const { der: tsqDer, nonce: tsNonce } = this._buildTSQ(sigValHash, { hashOid: tsHashOid, certReq: true, ...this.tsaOptions });
    this._logDebug('PAdES.signatureTimestamp.tsqBuilt', {
      nonce: tsNonce ? tsNonce.toString('hex') : null,
      tsqLength: tsqDer.length
    });
    const { der: tsRespDer } = await this._requestTimestamp(this.tsaUrl, tsqDer, this.tsaHeaders);
    this._logDebug('PAdES.signatureTimestamp.tsaResponse', { responseLength: tsRespDer.length });
    const tst = this._extractTimeStampTokenOrThrow(tsRespDer, {
      expectedImprint: sigValHash,
      expectedNonce: tsNonce,
      expectedHashOid: tsHashOid,
      allowMissingNonce
    });

    const signerInfo_T = addUnsignedAttr_signatureTimeStampToken(signerInfo, tst);
    const cmsT = buildSignedData(hashName, [_ld, ...chainDer], signerInfo_T);

    writer.injectCMS(cmsT);
    this._logDebug('PAdES.signatureTimestamp.injected', { cmsLength: cmsT.length });
    let signedPdf = writer.toBuffer();

    if (resolvedDocTs.append) {
      const docTsField = resolvedDocTs.fieldName;
      this._logDebug('PAdES.appendDocTimeStamp', {
        fieldName: docTsField,
        placeholderHexLen: resolvedDocTs.placeholderHexLen
      });
      signedPdf = await this.addDocTimeStamp({
        pdfBuffer: signedPdf,
        fieldName: docTsField,
        placeholderHexLen: resolvedDocTs.placeholderHexLen
      });
      return { pdf: signedPdf, mode: 'pades-t+docts' };
    }

    return { pdf: signedPdf, mode: 'pades-t' };
  }
}

module.exports = { PAdESManager };
