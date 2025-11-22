'use strict';
const path = require('path');
const crypto = require('crypto');
const { PDFPAdESWriter, ensureAcroFormAndEmptySigField, applyVisibleSignatureStamp } = require('./pdf_parser');
const { pemToDer, parseCertBasics, parseKeyUsageAndEKU, extractSubjectCommonName } = require('./x509_extract');
const { buildTSQ, requestTimestamp, extractTimeStampTokenOrThrow } = require('./rfc3161');
const { OIDS } = require('./oids');
const { buildCAdES_BES_auto, addUnsignedAttr_signatureTimeStampToken, buildSignedData } = require('./cades_builder');
const { generateStamp } = require('./stamp');

function normalizeFieldName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\//, '');
}

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

  #shouldAllowMissingNonce() {
    const opt = this.tsaOptions ? this.tsaOptions.allowMissingNonce : undefined;
    return opt === undefined ? true : opt !== false;
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
      const ensured = ensureAcroFormAndEmptySigField(workingPdf, normalizedFieldName);
      workingPdf = ensured.pdf;
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
    const allowMissingNonce = this.#shouldAllowMissingNonce();

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

    const leafDer = pemToDer(certPem);
    const subjectCommonName = extractSubjectCommonName(leafDer);
    const normalizedFieldName = normalizeFieldName(fieldName);
    const targetFieldName = normalizedFieldName || 'Sig1';
    const visibleFieldName = targetFieldName;
    const visibleReason = (visibleSignature && typeof visibleSignature === 'object' && typeof visibleSignature.reason === 'string')
      ? visibleSignature.reason
      : null;
    let resolvedStampName = null;

    const visibleSigConfig = (visibleSignature && typeof visibleSignature === 'object') ? visibleSignature : null;
    const ensureOptions = {};

    if (visibleSigConfig) {
      const rectSource = typeof visibleSigConfig.rect === 'function'
        ? visibleSigConfig.rect(subjectCommonName)
        : visibleSigConfig.rect;
      if (Array.isArray(rectSource) && rectSource.length === 4) {
        ensureOptions.rect = rectSource.map((v) => Number(v) || 0);
      }
      const pageIndexSource = typeof visibleSigConfig.pageIndex === 'function'
        ? visibleSigConfig.pageIndex(subjectCommonName)
        : visibleSigConfig.pageIndex;
      if (typeof pageIndexSource === 'number' && pageIndexSource >= 0) {
        ensureOptions.pageIndex = Math.floor(pageIndexSource);
      }
    }

    const ensuredField = ensureAcroFormAndEmptySigField(pdfBuffer, targetFieldName, ensureOptions);
    pdfBuffer = ensuredField.pdf;

    // KeyUsage kontrolü (auto fallback DocTS)
    const { keyUsage = {}, eku = [] } = this._parseKeyUsageAndEKU(leafDer);
    const keyUsageBitsPresent = Object.values(keyUsage).some(Boolean);
    const canSignByKU = !keyUsageBitsPresent || keyUsage.digitalSignature || keyUsage.contentCommitment;
    const ekuList = Array.isArray(eku) ? eku : [];
    const tsaOnly = ekuList.length > 0 && ekuList.every((oid) => oid === OIDS.id_kp_timeStamping);
    const canSign = canSignByKU && !tsaOnly;
    this._logDebug('PAdES.keyUsage', { keyUsage, eku: ekuList, canSign, reason: canSign ? 'allowed' : 'disallowed' });

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

    if (visibleSignature && typeof visibleSignature === 'object') {
      const rectInput = visibleSignature.rect || visibleSignature.position;
      if (!rectInput) {
        throw new Error('visibleSignature.rect or visibleSignature.position must be provided');
      }

      let stampBuffer = visibleSignature.stampBuffer;
      if (stampBuffer && !Buffer.isBuffer(stampBuffer)) {
        throw new Error('visibleSignature.stampBuffer must be a Buffer');
      }

      const stampCfg = (visibleSignature && typeof visibleSignature.stamp === 'object') ? visibleSignature.stamp : {};
      if (!stampBuffer) {
        let subjectName = '';
        try {
          subjectName = extractSubjectCommonName(leafDer) || '';
        } catch (err) {
          subjectName = '';
          this._logDebug('PAdES.visibleSignature.subjectCN.error', { message: err.message });
        }
        const resolvedName = (() => {
          if (typeof visibleSignature.personName === 'function') return visibleSignature.personName(subjectCommonName);
          if (typeof visibleSignature.personName === 'string') return visibleSignature.personName;
          if (typeof stampCfg.personName === 'function') return stampCfg.personName(subjectCommonName);
          if (typeof stampCfg.personName === 'string') return stampCfg.personName;
          return subjectName;
        })();
        const stampInput = {
          fontPath: stampCfg.fontPath || path.join(__dirname, 'font.ttf'),
          pngLogoPath: stampCfg.pngLogoPath || path.join(__dirname, 'caduceus.png'),
          personName: resolvedName
        };
        if (typeof stampCfg.finalW === 'number') stampInput.finalW = stampCfg.finalW;
        if (typeof stampCfg.finalH === 'number') stampInput.finalH = stampCfg.finalH;
        if (typeof stampCfg.leftW === 'number') stampInput.leftW = stampCfg.leftW;
        if (typeof stampCfg.rightW === 'number') stampInput.rightW = stampCfg.rightW;
        if (typeof stampCfg.SS === 'number') stampInput.SS = stampCfg.SS;
        if (stampCfg.outPath) stampInput.outPath = stampCfg.outPath;
        stampBuffer = generateStamp(stampInput);
        resolvedStampName = stampInput.personName;
      }

      if (!resolvedStampName) {
        if (typeof stampCfg.personName === 'string') resolvedStampName = stampCfg.personName;
        else if (typeof stampCfg.personName === 'function') resolvedStampName = stampCfg.personName(subjectCommonName);
        else if (typeof visibleSignature.personName === 'string') resolvedStampName = visibleSignature.personName;
        else if (typeof visibleSignature.personName === 'function') resolvedStampName = visibleSignature.personName(subjectCommonName);
      }

      const pageIndexForAppearance = (visibleSignature.pageIndex == null) ? 0 : visibleSignature.pageIndex;
      this._logDebug('PAdES.visibleSignature.apply', {
        fieldName: visibleFieldName,
        pageIndex: pageIndexForAppearance,
        hasCustomStamp: !!visibleSignature.stampBuffer,
        rect: rectInput
      });
      pdfBuffer = applyVisibleSignatureStamp({
        pdfBuffer,
        fieldName: visibleFieldName,
        rect: rectInput,
        pageIndex: pageIndexForAppearance,
        stampBuffer
      });
    }

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
    const placeholderFieldName = visibleFieldName || normalizedFieldName || null;
    const signerDisplayName = resolvedStampName || subjectCommonName || null;
    writer.preparePlaceholder({
      subFilter: 'ETSI.CAdES.detached',
      placeholderHexLen,
      fieldName: placeholderFieldName,
      signerName: signerDisplayName || undefined,
      reason: visibleReason || undefined
    });
    this._logDebug('PAdES.preparePlaceholder', { fieldName: placeholderFieldName || 'Sig1', placeholderHexLen });

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
    const allowMissingNonce = this.#shouldAllowMissingNonce();

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
