import { isValidModel } from "@open-inspect/shared";
import { StoreValidationError, StoreOperationError } from "./errors";

export class ModelPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesValidationError";
  }
}

export class ModelPreferencesStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get the list of enabled model IDs, or null if no preferences stored.
   *
   * @returns Array of enabled model IDs, or null if no preferences are configured
   * @throws {StoreOperationError} If database operation fails
   */
  async getEnabledModels(): Promise<string[] | null> {
    try {
      const row = await this.db
        .prepare("SELECT enabled_models FROM model_preferences WHERE id = 'global'")
        .first<{ enabled_models: string }>();

      if (!row) return null;

      return JSON.parse(row.enabled_models) as string[];
    } catch (error) {
      throw new StoreOperationError(
        "Failed to get enabled models",
        "ModelPreferencesStore",
        "getEnabledModels",
        error
      );
    }
  }

  /**
   * Set the list of enabled model IDs.
   * Validates all IDs against VALID_MODELS.
   *
   * @param modelIds - Array of model IDs to enable
   * @throws {StoreValidationError} If modelIds array is empty or contains only invalid models
   * @throws {ModelPreferencesValidationError} If any model IDs are invalid
   * @throws {StoreOperationError} If database operation fails
   */
  async setEnabledModels(modelIds: string[]): Promise<void> {
    // Validate input
    if (!modelIds || modelIds.length === 0) {
      throw new StoreValidationError("Model IDs array cannot be empty", "modelIds");
    }

    const unique = [...new Set(modelIds)];
    const invalid = unique.filter((id) => !isValidModel(id));
    if (invalid.length > 0) {
      throw new ModelPreferencesValidationError(`Invalid model IDs: ${invalid.join(", ")}`);
    }

    if (unique.length === 0) {
      throw new ModelPreferencesValidationError("At least one model must be enabled");
    }

    try {
      const now = Date.now();
      await this.db
        .prepare(
          `INSERT INTO model_preferences (id, enabled_models, updated_at)
           VALUES ('global', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             enabled_models = excluded.enabled_models,
             updated_at = excluded.updated_at`
        )
        .bind(JSON.stringify(unique), now)
        .run();
    } catch (error) {
      throw new StoreOperationError(
        "Failed to set enabled models",
        "ModelPreferencesStore",
        "setEnabledModels",
        error
      );
    }
  }
}
