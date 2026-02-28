import {
  isValidModel,
  isValidReasoningEffort,
  INTEGRATION_DEFINITIONS,
  type IntegrationId,
  type IntegrationSettingsMap,
  type GitHubBotSettings,
  type LinearBotSettings,
} from "@open-inspect/shared";
import { StoreValidationError, StoreOperationError } from "./errors";

export class IntegrationSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSettingsValidationError";
  }
}

const VALID_INTEGRATION_IDS = new Set<string>(INTEGRATION_DEFINITIONS.map((d) => d.id));

export function isValidIntegrationId(id: string): id is IntegrationId {
  return VALID_INTEGRATION_IDS.has(id);
}

export class IntegrationSettingsStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get global settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @returns Global settings for the integration, or null if not configured
   * @throws {StoreValidationError} If integrationId is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async getGlobal<K extends IntegrationId>(
    integrationId: K
  ): Promise<IntegrationSettingsMap[K]["global"] | null> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }

    try {
      const row = await this.db
        .prepare("SELECT settings FROM integration_settings WHERE integration_id = ?")
        .bind(integrationId)
        .first<{ settings: string }>();

      if (!row) return null;
      return JSON.parse(row.settings) as IntegrationSettingsMap[K]["global"];
    } catch (error) {
      if (error instanceof StoreValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to get global settings",
        "IntegrationSettingsStore",
        "getGlobal",
        error
      );
    }
  }

  /**
   * Set or update global settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @param settings - Global settings to set
   * @throws {StoreValidationError} If integrationId is empty
   * @throws {IntegrationSettingsValidationError} If settings validation fails
   * @throws {StoreOperationError} If database operation fails
   */
  async setGlobal<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["global"]
  ): Promise<void> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }

    if (settings.enabledRepos !== undefined) {
      if (
        !Array.isArray(settings.enabledRepos) ||
        !settings.enabledRepos.every((r) => typeof r === "string")
      ) {
        throw new IntegrationSettingsValidationError("enabledRepos must be an array of strings");
      }
      settings = {
        ...settings,
        enabledRepos: settings.enabledRepos.map((r) => r.toLowerCase()),
      };
    }

    if (settings.defaults) {
      settings = {
        ...settings,
        defaults: this.validateAndNormalizeSettings(integrationId, settings.defaults),
      };
    }

    try {
      const now = Date.now();
      await this.db
        .prepare(
          `INSERT INTO integration_settings (integration_id, settings, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(integration_id) DO UPDATE SET
             settings = excluded.settings,
             updated_at = excluded.updated_at`
        )
        .bind(integrationId, JSON.stringify(settings), now, now)
        .run();
    } catch (error) {
      if (error instanceof IntegrationSettingsValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to set global settings",
        "IntegrationSettingsStore",
        "setGlobal",
        error
      );
    }
  }

  /**
   * Delete global settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @throws {StoreValidationError} If integrationId is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async deleteGlobal<K extends IntegrationId>(integrationId: K): Promise<void> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }

    try {
      await this.db
        .prepare("DELETE FROM integration_settings WHERE integration_id = ?")
        .bind(integrationId)
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to delete global settings",
        "IntegrationSettingsStore",
        "deleteGlobal",
        error
      );
    }
  }

  /**
   * Get repository-specific settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @param repo - Repository identifier
   * @returns Repository settings, or null if not configured
   * @throws {StoreValidationError} If integrationId or repo is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async getRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<IntegrationSettingsMap[K]["repo"] | null> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }
    if (!repo || repo.trim() === "") {
      throw new StoreValidationError("Repository identifier cannot be empty", "repo");
    }

    try {
      const row = await this.db
        .prepare(
          "SELECT settings FROM integration_repo_settings WHERE integration_id = ? AND repo = ?"
        )
        .bind(integrationId, repo.toLowerCase())
        .first<{ settings: string }>();

      if (!row) return null;
      return JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"];
    } catch (error) {
      if (error instanceof StoreValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to get repository settings",
        "IntegrationSettingsStore",
        "getRepoSettings",
        error
      );
    }
  }

  /**
   * Set or update repository-specific settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @param repo - Repository identifier
   * @param settings - Repository settings to set
   * @throws {StoreValidationError} If integrationId or repo is empty
   * @throws {IntegrationSettingsValidationError} If settings validation fails
   * @throws {StoreOperationError} If database operation fails
   */
  async setRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string,
    settings: IntegrationSettingsMap[K]["repo"]
  ): Promise<void> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }
    if (!repo || repo.trim() === "") {
      throw new StoreValidationError("Repository identifier cannot be empty", "repo");
    }

    const normalized = this.validateAndNormalizeSettings(integrationId, settings);

    try {
      const now = Date.now();
      await this.db
        .prepare(
          `INSERT INTO integration_repo_settings (integration_id, repo, settings, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(integration_id, repo) DO UPDATE SET
             settings = excluded.settings,
             updated_at = excluded.updated_at`
        )
        .bind(integrationId, repo.toLowerCase(), JSON.stringify(normalized), now, now)
        .run();
    } catch (error) {
      if (error instanceof IntegrationSettingsValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to set repository settings",
        "IntegrationSettingsStore",
        "setRepoSettings",
        error
      );
    }
  }

  /**
   * Delete repository-specific settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @param repo - Repository identifier
   * @throws {StoreValidationError} If integrationId or repo is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async deleteRepoSettings<K extends IntegrationId>(integrationId: K, repo: string): Promise<void> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }
    if (!repo || repo.trim() === "") {
      throw new StoreValidationError("Repository identifier cannot be empty", "repo");
    }

    try {
      await this.db
        .prepare("DELETE FROM integration_repo_settings WHERE integration_id = ? AND repo = ?")
        .bind(integrationId, repo.toLowerCase())
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to delete repository settings",
        "IntegrationSettingsStore",
        "deleteRepoSettings",
        error
      );
    }
  }

  /**
   * List all repository-specific settings for an integration.
   *
   * @param integrationId - Integration identifier
   * @returns Array of repository settings with repository identifiers
   * @throws {StoreValidationError} If integrationId is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async listRepoSettings<K extends IntegrationId>(
    integrationId: K
  ): Promise<Array<{ repo: string; settings: IntegrationSettingsMap[K]["repo"] }>> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }

    try {
      const { results } = await this.db
        .prepare("SELECT repo, settings FROM integration_repo_settings WHERE integration_id = ?")
        .bind(integrationId)
        .all<{ repo: string; settings: string }>();

      return results.map((row) => ({
        repo: row.repo,
        settings: JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"],
      }));
    } catch (error) {
      if (error instanceof StoreValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to list repository settings",
        "IntegrationSettingsStore",
        "listRepoSettings",
        error
      );
    }
  }

  /**
   * Get merged configuration for a repository, combining global defaults and repo-specific overrides.
   *
   * @param integrationId - Integration identifier
   * @param repo - Repository identifier
   * @returns Resolved configuration with enabled repos list and merged settings
   * @throws {StoreValidationError} If integrationId or repo is empty
   * @throws {StoreOperationError} If database operation fails
   */
  async getResolvedConfig<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<ResolvedIntegrationConfig<IntegrationSettingsMap[K]["repo"]>> {
    // Validate input
    if (!integrationId || integrationId.trim() === "") {
      throw new StoreValidationError("Integration ID cannot be empty", "integrationId");
    }
    if (!repo || repo.trim() === "") {
      throw new StoreValidationError("Repository identifier cannot be empty", "repo");
    }

    try {
      const [globalSettings, repoSettings] = await Promise.all([
        this.getGlobal(integrationId),
        this.getRepoSettings(integrationId, repo),
      ]);

      // undefined → null (all repos), [] → [] (disabled), [...] → [...] (allowlist)
      const enabledRepos =
        globalSettings?.enabledRepos !== undefined ? globalSettings.enabledRepos : null;

      const defaults = globalSettings?.defaults ?? {};
      const overrides = repoSettings ?? {};

      // Generic merge: repo overrides win, undefined keys don't clobber defaults
      const settings: Record<string, unknown> = { ...defaults };
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) {
          settings[key] = value;
        }
      }

      return { enabledRepos, settings } as ResolvedIntegrationConfig<
        IntegrationSettingsMap[K]["repo"]
      >;
    } catch (error) {
      if (error instanceof StoreValidationError) {
        throw error;
      }
      throw new StoreOperationError(
        "Failed to get resolved configuration",
        "IntegrationSettingsStore",
        "getResolvedConfig",
        error
      );
    }
  }

  private validateAndNormalizeSettings<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["repo"]
  ): IntegrationSettingsMap[K]["repo"] {
    if (integrationId === "github") {
      return this.validateAndNormalizeGitHubSettings(
        settings as GitHubBotSettings
      ) as IntegrationSettingsMap[K]["repo"];
    }

    if (integrationId === "linear") {
      this.validateLinearSettings(settings as LinearBotSettings);
    }

    return settings;
  }

  private validateModelAndEffort(settings: { model?: string; reasoningEffort?: string }): void {
    if (settings.model !== undefined && !isValidModel(settings.model)) {
      throw new IntegrationSettingsValidationError(`Invalid model ID: ${settings.model}`);
    }

    if (
      settings.model !== undefined &&
      settings.reasoningEffort !== undefined &&
      !isValidReasoningEffort(settings.model, settings.reasoningEffort)
    ) {
      throw new IntegrationSettingsValidationError(
        `Invalid reasoning effort "${settings.reasoningEffort}" for model "${settings.model}"`
      );
    }
  }

  private validateAndNormalizeGitHubSettings(settings: GitHubBotSettings): GitHubBotSettings {
    this.validateModelAndEffort(settings);

    if (
      settings.codeReviewInstructions !== undefined &&
      typeof settings.codeReviewInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("codeReviewInstructions must be a string");
    }

    if (
      settings.commentActionInstructions !== undefined &&
      typeof settings.commentActionInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("commentActionInstructions must be a string");
    }

    if (settings.allowedTriggerUsers !== undefined) {
      if (
        !Array.isArray(settings.allowedTriggerUsers) ||
        !settings.allowedTriggerUsers.every((u) => typeof u === "string")
      ) {
        throw new IntegrationSettingsValidationError(
          "allowedTriggerUsers must be an array of strings"
        );
      }
      return {
        ...settings,
        allowedTriggerUsers: settings.allowedTriggerUsers.map((u) => u.trim().toLowerCase()),
      };
    }

    return settings;
  }

  private validateLinearSettings(settings: LinearBotSettings): void {
    this.validateModelAndEffort(settings);

    if (
      settings.allowUserPreferenceOverride !== undefined &&
      typeof settings.allowUserPreferenceOverride !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("allowUserPreferenceOverride must be a boolean");
    }

    if (
      settings.allowLabelModelOverride !== undefined &&
      typeof settings.allowLabelModelOverride !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("allowLabelModelOverride must be a boolean");
    }

    if (
      settings.emitToolProgressActivities !== undefined &&
      typeof settings.emitToolProgressActivities !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("emitToolProgressActivities must be a boolean");
    }
  }
}

export interface ResolvedIntegrationConfig<TRepo extends object = Record<string, unknown>> {
  enabledRepos: string[] | null;
  settings: TRepo;
}
