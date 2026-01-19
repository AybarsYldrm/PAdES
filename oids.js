'use strict';
const OIDS = {
  // CMS content types
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  // attributes
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  // digests
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  // RSA
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaSha256: '1.2.840.113549.1.1.11',
  rsaSha384: '1.2.840.113549.1.1.12',
  rsaSha512: '1.2.840.113549.1.1.13',
  // EC + ECDSA-with-SHA*
  idEcPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  // EKU
  id_kp_timeStamping: '1.3.6.1.5.5.7.3.8',
  // curves
  prime256v1: '1.2.840.10045.3.1.7',
  secp384r1:  '1.3.132.0.34',
  secp521r1:  '1.3.132.0.35'
};
const HASH_BY_NAME = { sha256: OIDS.sha256, sha384: OIDS.sha384, sha512: OIDS.sha512 };
const RSA_SIG_BY_HASH = { sha256: OIDS.rsaSha256, sha384: OIDS.rsaSha384, sha512: OIDS.rsaSha512 };
const ECDSA_SIG_BY_HASH = { sha256: OIDS.ecdsaSha256, sha384: OIDS.ecdsaSha384, sha512: OIDS.ecdsaSha512 };
const CURVE2HASH = { [OIDS.prime256v1]: 'sha256', [OIDS.secp384r1]: 'sha384', [OIDS.secp521r1]: 'sha512' };

function digestOidByName(name){ const oid=HASH_BY_NAME[name]; if(!oid) throw new Error('Unknown digest: '+name); return oid; }
function rsaSigOidByHash(name){ const oid=RSA_SIG_BY_HASH[name]; if(!oid) throw new Error('Unknown RSA-hash: '+name); return oid; }
function ecdsaSigOidByHash(name){ const oid=ECDSA_SIG_BY_HASH[name]; if(!oid) throw new Error('Unknown ECDSA-hash: '+name); return oid; }
function recommendHashForCurve(curveOid){ return CURVE2HASH[curveOid] || 'sha256'; }

module.exports = { OIDS, digestOidByName, rsaSigOidByHash, ecdsaSigOidByHash, recommendHashForCurve };
