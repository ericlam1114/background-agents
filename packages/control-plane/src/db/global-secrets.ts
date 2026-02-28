import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  MAX_TOTAL_VALUE_SIZE,
  MAX_SECRETS_PER_SCOPE,
  SecretsValidationError,
  normalizeKey,
  validateKey,
  validateValue,
} from "./secrets-validation";
import type { SecretMetadata } from "./secrets-validation";
import { StoreOperationError } from "./errors";

const log = createLogger("global-secrets");

/**
 * Store for managing globally-scoped encrypted secrets.
 *
 * Provides CRUD operations for secrets that are encrypted at rest using
 * the provided encryption key. All keys are normalized and validated
 * according to the secrets-validation rules.
 */
export class GlobalSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  /**
   * Set or update one or more global secrets.
   *
   * @param secrets - Map of secret keys to values. Keys are normalized and validated.
   * @returns Object containing counts of created and updated secrets, plus the list of keys.
   * @throws {SecretsValidationError} If any key or value fails validation, or limits are exceeded.
   * @throws {StoreOperationError} If the database operation fails.
   */
  async setSecrets(
    secrets: Record<string, string>
  ): Promise<{ created: number; updated: number; keys: string[] }> {
    // Validate input is not empty
    if (!secrets || Object.keys(secrets).length === 0) {
      throw new SecretsValidationError("Cannot set secrets: input is empty");
    }

    const now = Date.now();

    const normalized: Record<string, string> = {};
    let totalValueBytes = 0;
    for (const [rawKey, value] of Object.entries(secrets)) {
      // Validate key is not empty
      if (!rawKey || rawKey.trim() === "") {
        throw new SecretsValidationError("Secret key cannot be empty");
      }
      // Validate value is not empty
      if (value === "") {
        throw new SecretsValidationError(`Secret value for key '${rawKey}' cannot be empty`);
      }

      const key = normalizeKey(rawKey);
      validateKey(key);
      validateValue(value);
      totalValueBytes += new TextEncoder().encode(value).length;
      normalized[key] = value;
    }

    if (totalValueBytes > MAX_TOTAL_VALUE_SIZE) {
      throw new SecretsValidationError(`Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`);
    }

    let existingKeys;
    try {
      existingKeys = await this.db.prepare("SELECT key FROM global_secrets").all<{ key: string }>();
    } catch (e) {
      throw new StoreOperationError(
        "Failed to fetch existing secrets",
        "GlobalSecretsStore",
        "setSecrets",
        e
      );
    }

    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      throw new SecretsValidationError(
        `Global secrets would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
          `(current: ${existingKeySet.size}, adding: ${netNew})`
      );
    }

    let created = 0;
    let updated = 0;

    const statements: D1PreparedStatement[] = [];
    for (const [key, value] of Object.entries(normalized)) {
      const encrypted = await encryptToken(value, this.encryptionKey);
      const isNew = !existingKeySet.has(key);
      if (isNew) created++;
      else updated++;

      statements.push(
        this.db
          .prepare(
            `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               encrypted_value = excluded.encrypted_value,
               updated_at = excluded.updated_at`
          )
          .bind(key, encrypted, now, now)
      );
    }

    if (statements.length > 0) {
      try {
        await this.db.batch(statements);
      } catch (e) {
        throw new StoreOperationError(
          "Failed to save secrets to database",
          "GlobalSecretsStore",
          "setSecrets",
          e
        );
      }
    }

    return { created, updated, keys: incomingKeys };
  }

  /**
   * List all global secret keys with metadata (creation and update timestamps).
   *
   * @returns Array of secret metadata objects, sorted by key.
   * @throws {StoreOperationError} If the database operation fails.
   */
  async listSecretKeys(): Promise<SecretMetadata[]> {
    let result;
    try {
      result = await this.db
        .prepare("SELECT key, created_at, updated_at FROM global_secrets ORDER BY key")
        .all<{ key: string; created_at: number; updated_at: number }>();
    } catch (e) {
      throw new StoreOperationError(
        "Failed to list secret keys",
        "GlobalSecretsStore",
        "listSecretKeys",
        e
      );
    }

    return (result.results || []).map((row) => ({
      key: row.key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Retrieve all global secrets, decrypted.
   *
   * @returns Map of secret keys to their decrypted values.
   * @throws {StoreOperationError} If the database operation fails or decryption fails.
   */
  async getDecryptedSecrets(): Promise<Record<string, string>> {
    let result;
    try {
      result = await this.db
        .prepare("SELECT key, encrypted_value FROM global_secrets")
        .all<{ key: string; encrypted_value: string }>();
    } catch (e) {
      throw new StoreOperationError(
        "Failed to fetch secrets from database",
        "GlobalSecretsStore",
        "getDecryptedSecrets",
        e
      );
    }

    const rows = result.results || [];
    const decryptedEntries = await Promise.all(
      rows.map(async (row) => {
        try {
          const decryptedValue = await decryptToken(row.encrypted_value, this.encryptionKey);
          return [row.key, decryptedValue] as const;
        } catch (e) {
          log.error("Failed to decrypt global secret", {
            key: row.key,
            error: e instanceof Error ? e.message : String(e),
          });
          throw new StoreOperationError(
            `Failed to decrypt global secret '${row.key}'`,
            "GlobalSecretsStore",
            "getDecryptedSecrets",
            e
          );
        }
      })
    );

    return Object.fromEntries(decryptedEntries);
  }

  /**
   * Delete a global secret by key.
   *
   * @param key - The secret key to delete (will be normalized).
   * @returns True if the secret was deleted, false if it didn't exist.
   * @throws {SecretsValidationError} If the key is empty.
   * @throws {StoreOperationError} If the database operation fails.
   */
  async deleteSecret(key: string): Promise<boolean> {
    // Validate key is not empty
    if (!key || key.trim() === "") {
      throw new SecretsValidationError("Secret key cannot be empty");
    }

    let result;
    try {
      result = await this.db
        .prepare("DELETE FROM global_secrets WHERE key = ?")
        .bind(normalizeKey(key))
        .run();
    } catch (e) {
      throw new StoreOperationError(
        "Failed to delete secret from database",
        "GlobalSecretsStore",
        "deleteSecret",
        e
      );
    }

    return (result.meta?.changes ?? 0) > 0;
  }
}
