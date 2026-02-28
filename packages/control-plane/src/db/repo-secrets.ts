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

export type { SecretMetadata } from "./secrets-validation";

const log = createLogger("repo-secrets");

export class RepoSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  /**
   * Set or update repository secrets.
   *
   * @param repoId - Repository ID
   * @param repoOwner - Repository owner
   * @param repoName - Repository name
   * @param secrets - Record of secret key-value pairs to set
   * @returns Object containing counts of created and updated secrets, plus normalized keys
   * @throws {StoreValidationError} If repoOwner, repoName are empty or secrets object is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async setSecrets(
    repoId: number,
    repoOwner: string,
    repoName: string,
    secrets: Record<string, string>
  ): Promise<{ created: number; updated: number; keys: string[] }> {
    // Validate inputs
    if (!repoOwner || repoOwner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "repoOwner");
    }
    if (!repoName || repoName.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "repoName");
    }
    if (!secrets || Object.keys(secrets).length === 0) {
      throw new StoreValidationError("Secrets object cannot be empty", "secrets");
    }

    const owner = repoOwner.toLowerCase();
    const name = repoName.toLowerCase();
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
        .prepare("SELECT key FROM repo_secrets WHERE repo_id = ?")
        .bind(repoId)
        .all<{ key: string }>();
      const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

      const incomingKeys = Object.keys(normalized);
      const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
      if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
        throw new SecretsValidationError(
          `Repository would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
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
              `INSERT INTO repo_secrets
               (repo_id, repo_owner, repo_name, key, encrypted_value, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(repo_id, key) DO UPDATE SET
                 repo_owner = excluded.repo_owner,
                 repo_name = excluded.repo_name,
                 encrypted_value = excluded.encrypted_value,
                 updated_at = excluded.updated_at`
            )
            .bind(repoId, owner, name, key, encrypted, now, now)
        );
      }

      if (statements.length > 0) {
        await this.db.batch(statements);
      }

      return { created, updated, keys: incomingKeys };
    } catch (error) {
      if (error instanceof SecretsValidationError || error instanceof StoreValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to set repository secrets",
        "RepoSecretsStore",
        "setSecrets",
        error
      );
    }
  }

  /**
   * List all secret keys for a repository with metadata.
   *
   * @param repoId - Repository ID
   * @returns Array of secret metadata (key, createdAt, updatedAt)
   * @throws {StoreOperationError} If database operation fails
   */
  async listSecretKeys(repoId: number): Promise<SecretMetadata[]> {
    try {
      const result = await this.db
        .prepare(
          "SELECT key, created_at, updated_at FROM repo_secrets WHERE repo_id = ? ORDER BY key"
        )
        .bind(repoId)
        .all<{ key: string; created_at: number; updated_at: number }>();

      return (result.results || []).map((row) => ({
        key: row.key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      throw new StoreOperationError(
        "Failed to list repository secret keys",
        "RepoSecretsStore",
        "listSecretKeys",
        error
      );
    }
  }

  /**
   * Get all repository secrets with decrypted values.
   *
   * @param repoId - Repository ID
   * @returns Record of decrypted secret key-value pairs
   * @throws {StoreOperationError} If database operation or decryption fails
   */
  async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
    try {
      const result = await this.db
        .prepare("SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?")
        .bind(repoId)
        .all<{ key: string; encrypted_value: string }>();

      const rows = result.results || [];
      const decryptedEntries = await Promise.all(
        rows.map(async (row) => {
          try {
            const decryptedValue = await decryptToken(row.encrypted_value, this.encryptionKey);
            return [row.key, decryptedValue] as const;
          } catch (e) {
            log.error("Failed to decrypt secret", {
              repo_id: repoId,
              key: row.key,
              error: e instanceof Error ? e.message : String(e),
            });
            throw new Error(`Failed to decrypt secret '${row.key}'`);
          }
        })
      );

      return Object.fromEntries(decryptedEntries);
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get decrypted repository secrets",
        "RepoSecretsStore",
        "getDecryptedSecrets",
        error
      );
    }
  }

  /**
   * Delete a repository secret by key.
   *
   * @param repoId - Repository ID
   * @param key - Secret key to delete (will be normalized)
   * @returns True if secret was deleted, false if it didn't exist
   * @throws {StoreValidationError} If key is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async deleteSecret(repoId: number, key: string): Promise<boolean> {
    // Validate input
    if (!key || key.trim() === "") {
      throw new StoreValidationError("Secret key cannot be empty", "key");
    }

    try {
      const result = await this.db
        .prepare("DELETE FROM repo_secrets WHERE repo_id = ? AND key = ?")
        .bind(repoId, normalizeKey(key))
        .run();

      return (result.meta?.changes ?? 0) > 0;
    } catch (error) {
      throw new StoreOperationError(
        "Failed to delete repository secret",
        "RepoSecretsStore",
        "deleteSecret",
        error
      );
    }
  }
}
