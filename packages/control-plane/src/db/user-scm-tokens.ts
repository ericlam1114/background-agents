import { encryptToken, decryptToken } from "../auth/crypto";
import { StoreValidationError, StoreOperationError } from "./errors";

/** Fallback token lifetime when GitHub doesn't provide expires_in (8 hours). */
export const DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface ScmTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Raw ciphertext of the refresh token — used as the CAS comparand. */
  refreshTokenEncrypted: string;
}

export type CasResult = { ok: true } | { ok: false; reason: "cas_conflict" };

export class UserScmTokenStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  /**
   * Get SCM tokens for a user.
   *
   * @param providerUserId - Provider user ID
   * @returns Decrypted token record or null if not found
   * @throws {StoreValidationError} If providerUserId is empty
   * @throws {StoreOperationError} If database operation or decryption fails
   */
  async getTokens(providerUserId: string): Promise<ScmTokenRecord | null> {
    // Validate input
    if (!providerUserId || providerUserId.trim() === "") {
      throw new StoreValidationError("Provider user ID cannot be empty", "providerUserId");
    }

    try {
      const row = await this.db
        .prepare(
          "SELECT access_token_encrypted, refresh_token_encrypted, token_expires_at FROM user_scm_tokens WHERE provider_user_id = ?"
        )
        .bind(providerUserId)
        .first<{
          access_token_encrypted: string;
          refresh_token_encrypted: string;
          token_expires_at: number;
        }>();

      if (!row) return null;

      const [accessToken, refreshToken] = await Promise.all([
        decryptToken(row.access_token_encrypted, this.encryptionKey),
        decryptToken(row.refresh_token_encrypted, this.encryptionKey),
      ]);

      return {
        accessToken,
        refreshToken,
        expiresAt: row.token_expires_at,
        refreshTokenEncrypted: row.refresh_token_encrypted,
      };
    } catch (error) {
      if (error instanceof StoreValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to get user SCM tokens",
        "UserScmTokenStore",
        "getTokens",
        error
      );
    }
  }

  /**
   * Insert or update SCM tokens for a user.
   * Only updates if the new token has a later expiry (freshness guard).
   *
   * @param providerUserId - Provider user ID
   * @param accessToken - Access token to encrypt and store
   * @param refreshToken - Refresh token to encrypt and store
   * @param expiresAt - Token expiration timestamp
   * @throws {StoreValidationError} If any string parameter is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async upsertTokens(
    providerUserId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: number
  ): Promise<void> {
    // Validate inputs
    if (!providerUserId || providerUserId.trim() === "") {
      throw new StoreValidationError("Provider user ID cannot be empty", "providerUserId");
    }
    if (!accessToken || accessToken.trim() === "") {
      throw new StoreValidationError("Access token cannot be empty", "accessToken");
    }
    if (!refreshToken || refreshToken.trim() === "") {
      throw new StoreValidationError("Refresh token cannot be empty", "refreshToken");
    }

    try {
      const now = Date.now();
      const [accessTokenEncrypted, refreshTokenEncrypted] = await Promise.all([
        encryptToken(accessToken, this.encryptionKey),
        encryptToken(refreshToken, this.encryptionKey),
      ]);

      await this.db
        .prepare(
          `INSERT INTO user_scm_tokens
           (provider_user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_user_id) DO UPDATE SET
             access_token_encrypted = excluded.access_token_encrypted,
             refresh_token_encrypted = excluded.refresh_token_encrypted,
             token_expires_at = excluded.token_expires_at,
             updated_at = excluded.updated_at
           WHERE excluded.token_expires_at > user_scm_tokens.token_expires_at`
        )
        .bind(providerUserId, accessTokenEncrypted, refreshTokenEncrypted, expiresAt, now, now)
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to upsert user SCM tokens",
        "UserScmTokenStore",
        "upsertTokens",
        error
      );
    }
  }

  /**
   * Update SCM tokens using compare-and-swap (CAS).
   * Only updates if the current refresh token matches the expected value.
   *
   * @param providerUserId - Provider user ID
   * @param expectedRefreshTokenEncrypted - Expected encrypted refresh token (CAS comparand)
   * @param newAccessToken - New access token to encrypt and store
   * @param newRefreshToken - New refresh token to encrypt and store
   * @param newExpiresAt - New token expiration timestamp
   * @returns CAS result indicating success or conflict
   * @throws {StoreValidationError} If any string parameter is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async casUpdateTokens(
    providerUserId: string,
    expectedRefreshTokenEncrypted: string,
    newAccessToken: string,
    newRefreshToken: string,
    newExpiresAt: number
  ): Promise<CasResult> {
    // Validate inputs
    if (!providerUserId || providerUserId.trim() === "") {
      throw new StoreValidationError("Provider user ID cannot be empty", "providerUserId");
    }
    if (!expectedRefreshTokenEncrypted || expectedRefreshTokenEncrypted.trim() === "") {
      throw new StoreValidationError(
        "Expected refresh token cannot be empty",
        "expectedRefreshTokenEncrypted"
      );
    }
    if (!newAccessToken || newAccessToken.trim() === "") {
      throw new StoreValidationError("New access token cannot be empty", "newAccessToken");
    }
    if (!newRefreshToken || newRefreshToken.trim() === "") {
      throw new StoreValidationError("New refresh token cannot be empty", "newRefreshToken");
    }

    try {
      const now = Date.now();
      const [newAccessTokenEncrypted, newRefreshTokenEncrypted] = await Promise.all([
        encryptToken(newAccessToken, this.encryptionKey),
        encryptToken(newRefreshToken, this.encryptionKey),
      ]);

      const result = await this.db
        .prepare(
          `UPDATE user_scm_tokens
           SET access_token_encrypted = ?,
               refresh_token_encrypted = ?,
               token_expires_at = ?,
               updated_at = ?
           WHERE provider_user_id = ? AND refresh_token_encrypted = ?`
        )
        .bind(
          newAccessTokenEncrypted,
          newRefreshTokenEncrypted,
          newExpiresAt,
          now,
          providerUserId,
          expectedRefreshTokenEncrypted
        )
        .run();

      const changes = result.meta?.changes ?? 0;
      return changes > 0 ? { ok: true } : { ok: false, reason: "cas_conflict" };
    } catch (error) {
      throw new StoreOperationError(
        "Failed to CAS update user SCM tokens",
        "UserScmTokenStore",
        "casUpdateTokens",
        error
      );
    }
  }

  isTokenFresh(expiresAt: number, bufferMs = 60_000): boolean {
    return Date.now() + bufferMs < expiresAt;
  }
}
