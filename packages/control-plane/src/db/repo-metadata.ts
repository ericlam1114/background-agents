import type { RepoMetadata } from "@open-inspect/shared";
import { StoreValidationError, StoreOperationError } from "./errors";

/** D1 batch() supports at most 100 statements per call. */
const D1_BATCH_LIMIT = 100;

interface RepoMetadataRow {
  repo_owner: string;
  repo_name: string;
  description: string | null;
  aliases: string | null;
  channel_associations: string | null;
  keywords: string | null;
  image_build_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ImageBuildEnabledRepo {
  repoOwner: string;
  repoName: string;
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toMetadata(row: RepoMetadataRow): RepoMetadata {
  const metadata: RepoMetadata = {};
  if (row.description != null) metadata.description = row.description;
  const aliases = parseJsonArray(row.aliases);
  if (aliases) metadata.aliases = aliases;
  const channelAssociations = parseJsonArray(row.channel_associations);
  if (channelAssociations) metadata.channelAssociations = channelAssociations;
  const keywords = parseJsonArray(row.keywords);
  if (keywords) metadata.keywords = keywords;
  return metadata;
}

export class RepoMetadataStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get repository metadata.
   *
   * @param owner - Repository owner
   * @param name - Repository name
   * @returns Repository metadata or null if not found
   * @throws {StoreValidationError} If owner or name is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async get(owner: string, name: string): Promise<RepoMetadata | null> {
    // Validate input
    if (!owner || owner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "owner");
    }
    if (!name || name.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "name");
    }

    try {
      const row = await this.db
        .prepare("SELECT * FROM repo_metadata WHERE repo_owner = ? AND repo_name = ?")
        .bind(owner.toLowerCase(), name.toLowerCase())
        .first<RepoMetadataRow>();

      return row ? toMetadata(row) : null;
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get repository metadata",
        "RepoMetadataStore",
        "get",
        error
      );
    }
  }

  /**
   * Insert or update repository metadata.
   *
   * @param owner - Repository owner
   * @param name - Repository name
   * @param metadata - Metadata to store
   * @throws {StoreValidationError} If owner or name is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async upsert(owner: string, name: string, metadata: RepoMetadata): Promise<void> {
    // Validate input
    if (!owner || owner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "owner");
    }
    if (!name || name.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "name");
    }

    try {
      const now = Date.now();
      const normalizedOwner = owner.toLowerCase();
      const normalizedName = name.toLowerCase();

      await this.db
        .prepare(
          `INSERT INTO repo_metadata (repo_owner, repo_name, description, aliases, channel_associations, keywords, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
             description = excluded.description,
             aliases = excluded.aliases,
             channel_associations = excluded.channel_associations,
             keywords = excluded.keywords,
             updated_at = excluded.updated_at`
        )
        .bind(
          normalizedOwner,
          normalizedName,
          metadata.description ?? null,
          metadata.aliases ? JSON.stringify(metadata.aliases) : null,
          metadata.channelAssociations ? JSON.stringify(metadata.channelAssociations) : null,
          metadata.keywords ? JSON.stringify(metadata.keywords) : null,
          now,
          now
        )
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to upsert repository metadata",
        "RepoMetadataStore",
        "upsert",
        error
      );
    }
  }

  /**
   * Get metadata for multiple repositories in batch.
   *
   * @param repos - Array of repository owner/name pairs
   * @returns Map of "owner/name" keys to metadata
   * @throws {StoreOperationError} If database operation fails
   */
  async getBatch(
    repos: Array<{ owner: string; name: string }>
  ): Promise<Map<string, RepoMetadata>> {
    if (repos.length === 0) return new Map();

    try {
      const map = new Map<string, RepoMetadata>();

      // D1 batch() has a per-call statement limit; chunk to stay within it.
      for (let start = 0; start < repos.length; start += D1_BATCH_LIMIT) {
        const chunk = repos.slice(start, start + D1_BATCH_LIMIT);

        const statements = chunk.map((repo) =>
          this.db
            .prepare("SELECT * FROM repo_metadata WHERE repo_owner = ? AND repo_name = ?")
            .bind(repo.owner.toLowerCase(), repo.name.toLowerCase())
        );

        const results = await this.db.batch<RepoMetadataRow>(statements);

        for (let i = 0; i < chunk.length; i++) {
          const rows = results[i]?.results;
          if (rows && rows.length > 0) {
            const key = `${chunk[i].owner.toLowerCase()}/${chunk[i].name.toLowerCase()}`;
            map.set(key, toMetadata(rows[0]));
          }
        }
      }

      return map;
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get batch repository metadata",
        "RepoMetadataStore",
        "getBatch",
        error
      );
    }
  }

  /**
   * Get all repositories with image build enabled.
   *
   * @returns Array of repositories with image build enabled
   * @throws {StoreOperationError} If database operation fails
   */
  async getImageBuildEnabledRepos(): Promise<ImageBuildEnabledRepo[]> {
    try {
      const result = await this.db
        .prepare("SELECT repo_owner, repo_name FROM repo_metadata WHERE image_build_enabled = 1")
        .all<{ repo_owner: string; repo_name: string }>();

      return (result.results || []).map((row) => ({
        repoOwner: row.repo_owner,
        repoName: row.repo_name,
      }));
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get image build enabled repositories",
        "RepoMetadataStore",
        "getImageBuildEnabledRepos",
        error
      );
    }
  }

  /**
   * Enable or disable image build for a repository.
   *
   * @param owner - Repository owner
   * @param name - Repository name
   * @param enabled - Whether to enable or disable image build
   * @throws {StoreValidationError} If owner or name is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async setImageBuildEnabled(owner: string, name: string, enabled: boolean): Promise<void> {
    // Validate input
    if (!owner || owner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "owner");
    }
    if (!name || name.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "name");
    }

    try {
      const now = Date.now();
      const normalizedOwner = owner.toLowerCase();
      const normalizedName = name.toLowerCase();

      await this.db
        .prepare(
          `INSERT INTO repo_metadata (repo_owner, repo_name, image_build_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
             image_build_enabled = excluded.image_build_enabled,
             updated_at = excluded.updated_at`
        )
        .bind(normalizedOwner, normalizedName, enabled ? 1 : 0, now, now)
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to set image build enabled",
        "RepoMetadataStore",
        "setImageBuildEnabled",
        error
      );
    }
  }
}
