import type { IProviderSetting } from '~/types/model';
import { BaseProvider } from './base-provider';
import type { ModelInfo, ProviderInfo } from './types';
import * as providers from './registry';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LLMManager');

export class LLMManager {
  private static _instance: LLMManager;
  private _providers: Map<string, BaseProvider> = new Map();
  private _modelList: ModelInfo[] = [];
  private readonly _env: any = {};

  private constructor(_env: Record<string, string>) {
    this._registerProvidersFromDirectory();
    this._env = _env;
  }

  static getInstance(env: Record<string, string> = {}): LLMManager {
    if (!LLMManager._instance) {
      LLMManager._instance = new LLMManager(env);
    }

    return LLMManager._instance;
  }

  get env() {
    return this._env;
  }

  private async _registerProvidersFromDirectory() {
    try {
      /*
       * Dynamically import all files from the providers directory
       * const providerModules = import.meta.glob('./providers/*.ts', { eager: true });
       */

      // Look for exported classes that extend BaseProvider
      for (const exportedItem of Object.values(providers)) {
        if (typeof exportedItem === 'function' && exportedItem.prototype instanceof BaseProvider) {
          const provider = new exportedItem();

          try {
            this.registerProvider(provider);
          } catch (error: any) {
            logger.warn('Failed To Register Provider: ', provider.name, 'error:', error.message);
          }
        }
      }
    } catch (error) {
      logger.error('Error registering providers:', error);
    }
  }

  registerProvider(provider: BaseProvider) {
    if (this._providers.has(provider.name)) {
      logger.warn(`Provider ${provider.name} is already registered. Skipping.`);
      return;
    }

    logger.info('Registering Provider: ', provider.name);
    this._providers.set(provider.name, provider);
    this._modelList = [...this._modelList, ...provider.staticModels];
  }

  getProvider(name: string): BaseProvider | undefined {
    return this._providers.get(name);
  }

  getAllProviders(): BaseProvider[] {
    return Array.from(this._providers.values());
  }

  getModelList(): ModelInfo[] {
    return this._modelList;
  }

  async updateModelList(options: {
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    serverEnv?: Record<string, string>;
  }): Promise<ModelInfo[]> {
    const { apiKeys, providerSettings, serverEnv } = options;

    let enabledProviders = Array.from(this._providers.values()).map((p) => p.name);

    if (providerSettings && Object.keys(providerSettings).length > 0) {
      enabledProviders = enabledProviders.filter((p) => providerSettings[p].enabled);
    }

    // Get dynamic models from all providers that support them
    const dynamicModels = await Promise.all(
      Array.from(this._providers.values())
        .filter((provider) => enabledProviders.includes(provider.name))
        .filter(
          (provider): provider is BaseProvider & Required<Pick<ProviderInfo, 'getDynamicModels'>> =>
            !!provider.getDynamicModels,
        )
        .map(async (provider) => {
          const cachedModels = provider.getModelsFromCache(options);

          if (cachedModels) {
            return cachedModels;
          }

          const dynamicModels = await provider
            .getDynamicModels(apiKeys, providerSettings?.[provider.name], serverEnv)
            .then((models) => {
              logger.info(`Caching ${models.length} dynamic models for ${provider.name}`);
              provider.storeDynamicModels(options, models);

              return models;
            })
            .catch((err) => {
              logger.error(`Error getting dynamic models ${provider.name} :`, err);
              return [];
            });

          return dynamicModels;
        }),
    );
    const staticModels = Array.from(this._providers.values()).flatMap((p) => p.staticModels || []);
    const dynamicModelsFlat = dynamicModels.flat();
    const dynamicModelKeys = dynamicModelsFlat.map((d) => `${d.name}-${d.provider}`);
    const filteredStaticModesl = staticModels.filter((m) => !dynamicModelKeys.includes(`${m.name}-${m.provider}`));

    // Combine static and dynamic models
    const modelList = [...dynamicModelsFlat, ...filteredStaticModesl];
    modelList.sort((a, b) => a.name.localeCompare(b.name));
    this._modelList = modelList;

    return modelList;
  }

  getStaticModelList() {
    return [...this._providers.values()].flatMap((p) => p.staticModels || []);
  }

  async getModelListFromProvider(
    providerArg: BaseProvider,
    options: {
      apiKeys?: Record<string, string>;
      providerSettings?: Record<string, IProviderSetting>;
      serverEnv?: Record<string, string>;
    },
  ): Promise<ModelInfo[]> {
    const provider = this._providers.get(providerArg.name);

    if (!provider) {
      throw new Error(`Provider ${providerArg.name} not found`);
    }

    const staticModels = provider.staticModels || [];

    if (!provider.getDynamicModels) {
      return staticModels;
    }

    const { apiKeys, providerSettings, serverEnv } = options;

    const cachedModels = provider.getModelsFromCache({
      apiKeys,
      providerSettings,
      serverEnv,
    });

    if (cachedModels) {
      logger.info(`Found ${cachedModels.length} cached models for ${provider.name}`);
      return [...cachedModels, ...staticModels];
    }

    logger.info(`Getting dynamic models for ${provider.name}`);

    const dynamicModels = await provider
      .getDynamicModels?.(apiKeys, providerSettings?.[provider.name], serverEnv)
      .then((models) => {
        logger.info(`Got ${models.length} dynamic models for ${provider.name}`);
        provider.storeDynamicModels(options, models);

        return models;
      })
      .catch((err) => {
        logger.error(`Error getting dynamic models ${provider.name} :`, err);
        return [];
      });
    const dynamicModelsName = dynamicModels.map((d) => d.name);
    const filteredStaticList = staticModels.filter((m) => !dynamicModelsName.includes(m.name));
    const modelList = [...dynamicModels, ...filteredStaticList];
    modelList.sort((a, b) => a.name.localeCompare(b.name));

    return modelList;
  }

  getStaticModelListFromProvider(providerArg: BaseProvider) {
    const provider = this._providers.get(providerArg.name);

    if (!provider) {
      throw new Error(`Provider ${providerArg.name} not found`);
    }

    return [...(provider.staticModels || [])];
  }

  getDefaultProvider(userApiKeys?: Record<string, string>): BaseProvider {
    // First try to find a provider with a valid API key
    for (const provider of this._providers.values()) {
      if (this.isProviderConfigured(provider, userApiKeys)) {
        logger.info(`Using configured provider as default: ${provider.name}`);
        return provider;
      }
    }

    // If no provider has API key, return the first one (will show error to user)
    const firstProvider = this._providers.values().next().value;

    if (!firstProvider) {
      throw new Error('No providers registered');
    }

    logger.warn(`No configured providers found, defaulting to: ${firstProvider.name}`);

    return firstProvider;
  }

  /**
   * Get all providers that are properly configured
   */
  getConfiguredProviders(userApiKeys?: Record<string, string>): BaseProvider[] {
    const configuredProviders: BaseProvider[] = [];

    for (const provider of this._providers.values()) {
      if (this.isProviderConfigured(provider, userApiKeys)) {
        configuredProviders.push(provider);
      }
    }

    return configuredProviders;
  }

  /**
   * Check if a provider is properly configured with API key
   */
  private isProviderConfigured(provider: BaseProvider, userApiKeys?: Record<string, string>): boolean {
    try {
      // Check if the provider has the required API key in environment
      const apiKeyEnvVar = provider.config.apiTokenKey;

      if (!apiKeyEnvVar) {
        /*
         * Provider doesn't require API key (like local providers)
         * For local providers, we need to check if they're actually running
         * by checking if we have cached models for them
         */
        const localProviders = ['ollama', 'lmstudio'];

        if (localProviders.includes(provider.name.toLowerCase())) {
          // Check if we have successfully cached models for this local provider
          const staticModels = this.getStaticModelListFromProvider(provider);
          const cachedModels =
            provider.getModelsFromCache?.({
              apiKeys: userApiKeys || {},
              providerSettings: {},
              serverEnv: this._env,
            }) || [];

          // Local provider is considered configured if it has models available
          const hasModels = staticModels.length > 0 || cachedModels.length > 0;

          if (!hasModels) {
            logger.warn(`Local provider ${provider.name} has no available models, considering it unconfigured`);
          }

          return hasModels;
        }

        // For other providers without API key requirement, assume they're configured
        return true;
      }

      // Check user-provided API keys first (from UI)
      if (userApiKeys && userApiKeys[provider.name]) {
        const userApiKey = userApiKeys[provider.name];

        if (userApiKey && userApiKey.trim().length > 0) {
          return true;
        }
      }

      // Fallback to environment variables
      const apiKey = this._env[apiKeyEnvVar];

      return !!(apiKey && apiKey.trim().length > 0);
    } catch (error) {
      logger.warn(`Error checking provider configuration for ${provider.name}:`, error);
      return false;
    }
  }
}
