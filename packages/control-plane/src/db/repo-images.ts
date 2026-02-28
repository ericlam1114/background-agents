import { StoreValidationError, StoreOperationError } from "./errors";

export interface RepoImageBuild {
  id: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
}

export interface RepoImage {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider_image_id: string;
  base_sha: string;
  base_branch: string;
  status: "building" | "ready" | "failed";
  build_duration_seconds: number | null;
  error_message: string | null;
  created_at: number;
}

export class RepoImageStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Register a new repository image build.
   *
   * @param build - Build information including id, repo owner, repo name, and base branch
   * @throws {StoreValidationError} If id, repoOwner, repoName, or baseBranch is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async registerBuild(build: RepoImageBuild): Promise<void> {
    // Validate input
    if (!build.id || build.id.trim() === "") {
      throw new StoreValidationError("Build ID cannot be empty", "id");
    }
    if (!build.repoOwner || build.repoOwner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "repoOwner");
    }
    if (!build.repoName || build.repoName.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "repoName");
    }
    if (!build.baseBranch || build.baseBranch.trim() === "") {
      throw new StoreValidationError("Base branch cannot be empty", "baseBranch");
    }

    try {
      const now = Date.now();
      await this.db
        .prepare(
          `INSERT INTO repo_images (id, repo_owner, repo_name, base_branch, provider_image_id, status, base_sha, created_at)
           VALUES (?, ?, ?, ?, '', 'building', '', ?)`
        )
        .bind(
          build.id,
          build.repoOwner.toLowerCase(),
          build.repoName.toLowerCase(),
          build.baseBranch,
          now
        )
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to register build",
        "RepoImageStore",
        "registerBuild",
        error
      );
    }
  }

  /**
   * Mark a build as ready and optionally replace the previous ready image.
   *
   * @param buildId - Build ID to mark as ready
   * @param providerImageId - Provider image ID
   * @param baseSha - Base commit SHA
   * @param buildDurationSeconds - Build duration in seconds
   * @returns Object containing the replaced image ID (null if none)
   * @throws {StoreValidationError} If buildId, providerImageId, or baseSha is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async markReady(
    buildId: string,
    providerImageId: string,
    baseSha: string,
    buildDurationSeconds: number
  ): Promise<{ replacedImageId: string | null }> {
    // Validate input
    if (!buildId || buildId.trim() === "") {
      throw new StoreValidationError("Build ID cannot be empty", "buildId");
    }
    if (!providerImageId || providerImageId.trim() === "") {
      throw new StoreValidationError("Provider image ID cannot be empty", "providerImageId");
    }
    if (!baseSha || baseSha.trim() === "") {
      throw new StoreValidationError("Base SHA cannot be empty", "baseSha");
    }

    try {
      const build = await this.db
        .prepare("SELECT repo_owner, repo_name FROM repo_images WHERE id = ?")
        .bind(buildId)
        .first<{ repo_owner: string; repo_name: string }>();

      if (!build) return { replacedImageId: null };

      const oldReady = await this.db
        .prepare(
          "SELECT id, provider_image_id FROM repo_images WHERE repo_owner = ? AND repo_name = ? AND status = 'ready'"
        )
        .bind(build.repo_owner, build.repo_name)
        .first<{ id: string; provider_image_id: string }>();

      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            "UPDATE repo_images SET status = 'ready', provider_image_id = ?, base_sha = ?, build_duration_seconds = ? WHERE id = ?"
          )
          .bind(providerImageId, baseSha, buildDurationSeconds, buildId),
      ];

      if (oldReady) {
        statements.push(this.db.prepare("DELETE FROM repo_images WHERE id = ?").bind(oldReady.id));
      }

      await this.db.batch(statements);

      return { replacedImageId: oldReady?.provider_image_id ?? null };
    } catch (error) {
      throw new StoreOperationError(
        "Failed to mark build as ready",
        "RepoImageStore",
        "markReady",
        error
      );
    }
  }

  /**
   * Mark a build as failed with an error message.
   *
   * @param buildId - Build ID to mark as failed
   * @param error - Error message
   * @throws {StoreValidationError} If buildId or error is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async markFailed(buildId: string, error: string): Promise<void> {
    // Validate input
    if (!buildId || buildId.trim() === "") {
      throw new StoreValidationError("Build ID cannot be empty", "buildId");
    }
    if (!error || error.trim() === "") {
      throw new StoreValidationError("Error message cannot be empty", "error");
    }

    try {
      await this.db
        .prepare("UPDATE repo_images SET status = 'failed', error_message = ? WHERE id = ?")
        .bind(error, buildId)
        .run();
    } catch (err) {
      throw new StoreOperationError(
        "Failed to mark build as failed",
        "RepoImageStore",
        "markFailed",
        err
      );
    }
  }

  /**
   * Get the latest ready image for a repository.
   *
   * @param repoOwner - Repository owner
   * @param repoName - Repository name
   * @returns Latest ready image or null if none exists
   * @throws {StoreValidationError} If repoOwner or repoName is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async getLatestReady(repoOwner: string, repoName: string): Promise<RepoImage | null> {
    // Validate input
    if (!repoOwner || repoOwner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "repoOwner");
    }
    if (!repoName || repoName.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "repoName");
    }

    try {
      return this.db
        .prepare(
          "SELECT * FROM repo_images WHERE repo_owner = ? AND repo_name = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1"
        )
        .bind(repoOwner.toLowerCase(), repoName.toLowerCase())
        .first<RepoImage>();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get latest ready image",
        "RepoImageStore",
        "getLatestReady",
        error
      );
    }
  }

  /**
   * Get build status for a repository (up to 10 most recent builds).
   *
   * @param repoOwner - Repository owner
   * @param repoName - Repository name
   * @returns Array of recent builds in reverse chronological order
   * @throws {StoreValidationError} If repoOwner or repoName is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async getStatus(repoOwner: string, repoName: string): Promise<RepoImage[]> {
    // Validate input
    if (!repoOwner || repoOwner.trim() === "") {
      throw new StoreValidationError("Repository owner cannot be empty", "repoOwner");
    }
    if (!repoName || repoName.trim() === "") {
      throw new StoreValidationError("Repository name cannot be empty", "repoName");
    }

    try {
      const result = await this.db
        .prepare(
          "SELECT * FROM repo_images WHERE repo_owner = ? AND repo_name = ? ORDER BY created_at DESC LIMIT 10"
        )
        .bind(repoOwner.toLowerCase(), repoName.toLowerCase())
        .all<RepoImage>();

      return result.results || [];
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get repository status",
        "RepoImageStore",
        "getStatus",
        error
      );
    }
  }

  /**
   * Get build status for all repositories (up to 100 most recent builds).
   *
   * @returns Array of recent builds across all repositories in reverse chronological order
   * @throws {StoreOperationError} If database operation fails
   */
  async getAllStatus(): Promise<RepoImage[]> {
    try {
      const result = await this.db
        .prepare("SELECT * FROM repo_images ORDER BY created_at DESC LIMIT 100")
        .all<RepoImage>();

      return result.results || [];
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get all repository status",
        "RepoImageStore",
        "getAllStatus",
        error
      );
    }
  }

  /**
   * Mark stale builds as failed (builds older than maxAgeMs that are still in 'building' status).
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of builds marked as failed
   * @throws {StoreOperationError} If database operation fails
   */
  async markStaleBuildsAsFailed(maxAgeMs: number): Promise<number> {
    try {
      const cutoff = Date.now() - maxAgeMs;
      const result = await this.db
        .prepare(
          "UPDATE repo_images SET status = 'failed', error_message = ? WHERE status = 'building' AND created_at < ?"
        )
        .bind("build timed out (no callback received)", cutoff)
        .run();

      return result.meta?.changes ?? 0;
    } catch (error) {
      throw new StoreOperationError(
        "Failed to mark stale builds as failed",
        "RepoImageStore",
        "markStaleBuildsAsFailed",
        error
      );
    }
  }

  /**
   * Delete old failed builds (failed builds older than maxAgeMs).
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of builds deleted
   * @throws {StoreOperationError} If database operation fails
   */
  async deleteOldFailedBuilds(maxAgeMs: number): Promise<number> {
    try {
      const cutoff = Date.now() - maxAgeMs;
      const result = await this.db
        .prepare("DELETE FROM repo_images WHERE status = 'failed' AND created_at < ?")
        .bind(cutoff)
        .run();

      return result.meta?.changes ?? 0;
    } catch (error) {
      throw new StoreOperationError(
        "Failed to delete old failed builds",
        "RepoImageStore",
        "deleteOldFailedBuilds",
        error
      );
    }
  }
}
