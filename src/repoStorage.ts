import * as vscode from 'vscode';
import { RepoSource } from './types';
import { getLogger } from './logger';

const STORAGE_KEY = 'awesomeCopilot.sources';
const CONFIG_KEY = 'awesome-copilot.repositories';
const DEFAULT_SOURCES: RepoSource[] = [
  { owner: 'github', repo: 'awesome-copilot', label: 'Awesome Copilot' }
];

export class RepoStorage {
  /**
   * Get repository sources from VS Code settings first, then fallback to global state
   */
  static getSources(context: vscode.ExtensionContext): RepoSource[] {
    // First try to get from VS Code settings
    const config = vscode.workspace.getConfiguration();
    const configSources = config.get<RepoSource[]>(CONFIG_KEY);
    
    if (configSources && Array.isArray(configSources) && configSources.length > 0) {
      // Sync config to global state for backward compatibility
      context.globalState.update(STORAGE_KEY, configSources);
      return configSources;
    }
    
    // Fallback to global state
    const raw = context.globalState.get<RepoSource[]>(STORAGE_KEY);
    if (raw && Array.isArray(raw) && raw.length > 0) {
      // Sync global state to config
      this.syncToConfig(raw);
      return raw;
    }
    
    // Use defaults and sync to both
    this.syncToConfig(DEFAULT_SOURCES);
    context.globalState.update(STORAGE_KEY, DEFAULT_SOURCES);
    return [...DEFAULT_SOURCES];
  }

  /**
   * Set repository sources in both global state and VS Code settings
   */
  static async setSources(context: vscode.ExtensionContext, sources: RepoSource[]): Promise<void> {
    // Update global state
    await context.globalState.update(STORAGE_KEY, sources);
    
    // Update VS Code settings
    await this.syncToConfig(sources);
  }

  /**
   * Get default repository sources
   */
  static getDefaultSources(): RepoSource[] {
    return [...DEFAULT_SOURCES];
  }

  /**
   * Sync repository sources to VS Code settings
   */
  private static async syncToConfig(sources: RepoSource[]): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration();
      await config.update(CONFIG_KEY, sources, vscode.ConfigurationTarget.Global);
    } catch (error) {
      getLogger().warn('Failed to sync repository sources to settings:', error);
    }
  }

  /**
   * Listen for configuration changes and sync back to global state
   */
  static onConfigurationChanged(context: vscode.ExtensionContext, callback?: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(CONFIG_KEY)) {
        const config = vscode.workspace.getConfiguration();
        const configSources = config.get<RepoSource[]>(CONFIG_KEY);
        
        if (configSources && Array.isArray(configSources)) {
          // Sync from config to global state
          await context.globalState.update(STORAGE_KEY, configSources);
          
          // Notify callback if provided
          if (callback) {
            callback();
          }
        }
      }
    });
  }

  /**
   * Initialize repository sources from settings on startup
   */
  static async initializeFromSettings(context: vscode.ExtensionContext): Promise<void> {
    const sources = this.getSources(context);
    getLogger().info('Initialized repository sources:', sources.map(s => `${s.owner}/${s.repo}`).join(', '));
  }
}
