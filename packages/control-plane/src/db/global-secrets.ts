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
import { StoreValidationError, StoreOperationError } from "./errors";

const log = createLogger("global-secrets");

export class GlobalSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  /**
   * Set or update global secrets.
   *
   * @param secrets - Record of secret key-value pairs to set
   * @returns Object containing counts of created and updated secrets, plus normalized keys
   * @throws {StoreValidationError} If secrets object is empty or contains invalid keys/values
   * @throws {StoreOperationError} If database operation fails
   */
  async setSecrets(
    secrets: Record<string, string>
  ): Promise<{ created: number; updated: number; keys: string[] }> {
    // Validate input
    if (!secrets || Object.keys(secrets).length === 0) {
      throw new StoreValidationError("Secrets object cannot be empty", "secrets");
    }

    const now = Date.now();

    const normalized: Record<string, string> = {};
    let totalValueBytes = 0;
    for (const [rawKey, value] of Object.entries(secrets)) {
      const key = normalizeKey(rawKey);
      validateKey(key);
      validateValue(value);
      totalValueBytes += new TextEncoder().encode(value).length;
      normalized[key] = value;
    }

    if (totalValueBytes > MAX_TOTAL_VALUE_SIZE) {
      throw new SecretsValidationError(`Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`);
    }

    try {
      const existingKeys = await this.db
        .prepare("SELECT key FROM global_secrets")
        .all<{ key: string }>();
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
        await this.db.batch(statements);
      }

      return { created, updated, keys: incomingKeys };
    } catch (error) {
      if (error instanceof SecretsValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to set global secrets",
        "GlobalSecretsStore",
        "setSecrets",
        error
      );
    }
  }

  /**
   * List all global secret keys with metadata.
   *
   * @returns Array of secret metadata (key, createdAt, updatedAt)
   * @throws {StoreOperationError} If database operation fails
   */
  async listSecretKeys(): Promise<SecretMetadata[]> {
    try {
      const result = await this.db
        .prepare("SELECT key, created_at, updated_at FROM global_secrets ORDER BY key")
        .all<{ key: string; created_at: number; updated_at: number }>();

      return (result.results || []).map((row) => ({
        key: row.key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      throw new StoreOperationError(
        "Failed to list global secret keys",
        "GlobalSecretsStore",
        "listSecretKeys",
        error
      );
    }
  }

  /**
   * Get all global secrets with decrypted values.
   *
   * @returns Record of decrypted secret key-value pairs
   * @throws {StoreOperationError} If database operation or decryption fails
   */
  async getDecryptedSecrets(): Promise<Record<string, string>> {
    try {
      const result = await this.db
        .prepare("SELECT key, encrypted_value FROM global_secrets")
        .all<{ key: string; encrypted_value: string }>();

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
            throw new Error(`Failed to decrypt global secret '${row.key}'`);
          }
        })
      );

      return Object.fromEntries(decryptedEntries);
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get decrypted global secrets",
        "GlobalSecretsStore",
        "getDecryptedSecrets",
        error
      );
    }
  }

  /**
   * Delete a global secret by key.
   *
   * @param key - Secret key to delete (will be normalized)
   * @returns True if secret was deleted, false if it didn't exist
   * @throws {StoreValidationError} If key is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async deleteSecret(key: string): Promise<boolean> {
    // Validate input
    if (!key || key.trim() === "") {
      throw new StoreValidationError("Secret key cannot be empty", "key");
    }

    try {
      const result = await this.db
        .prepare("DELETE FROM global_secrets WHERE key = ?")
        .bind(normalizeKey(key))
        .run();

      return (result.meta?.changes ?? 0) > 0;
    } catch (error) {
      throw new StoreOperationError(
        "Failed to delete global secret",
        "GlobalSecretsStore",
        "deleteSecret",
        error
      );
    }
  }
}
