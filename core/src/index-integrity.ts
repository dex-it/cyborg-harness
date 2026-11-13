// Публичный вход ядра для подписи и проверки пакетов плагинов (Node): ключи Ed25519, запись `integrity.json`, проверка над прочитанными байтами (TR-10, ADR-CH-0017).
// Только именованные экспорты; перечень сверяет core/test/public-api.test.ts.
export {
  INTEGRITY_FILE,
  INTEGRITY_FORMAT,
  canonicalBytes,
  describeDiff,
  diffHashes,
  checkPublicKey,
  generateSigningKey,
  hashFiles,
  keyIdOf,
  parseIntegrity,
  publicKeyOf,
  readPackageTree,
  renderIntegrity,
  sha256Hex,
  signBytes,
  signIntegrity,
  verifyBytes,
  verifyIntegrity,
} from './integrity.ts';

export { signRevocations, verifyRevocations } from './trust-store.ts';

export type { HashDiff, IntegrityCode, IntegrityManifest, IntegrityVerdict, PackageBytes, PackageTree, SignInput, SigningKey, VerifyPolicy } from './integrity.ts';
export type { RevocationInput, RevocationList } from './trust-store.ts';
