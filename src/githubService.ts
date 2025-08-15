import axios from 'axios';
import * as vscode from 'vscode';
import { GitHubFile, CopilotCategory, CacheEntry } from './types';

export class GitHubService {
    private static readonly BASE_URL = 'https://api.github.com/repos/github/awesome-copilot/contents';
    private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
    private cache: Map<CopilotCategory, CacheEntry> = new Map();

    async getFiles(category: CopilotCategory, forceRefresh: boolean = false): Promise<GitHubFile[]> {
        const cacheEntry = this.cache.get(category);
        const now = Date.now();

        // Return cached data if valid and not forcing refresh
        if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
            return cacheEntry.data;
        }

        try {
            const url = `${GitHubService.BASE_URL}/${category}`;
            const response = await axios.get<GitHubFile[]>(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'VSCode-AwesomeCopilot-Extension'
                }
            });

            const files = response.data.filter((file: GitHubFile) => file.type === 'file');
            
            // Update cache
            this.cache.set(category, {
                data: files,
                timestamp: now,
                category
            });

            return files;
        } catch (error) {
            console.error(`Failed to fetch ${category} files:`, error);
            
            // Return cached data if available, even if stale
            if (cacheEntry) {
                vscode.window.showWarningMessage(`Using cached data for ${category}. Network error occurred.`);
                return cacheEntry.data;
            }
            
            // Show error and return empty array
            vscode.window.showErrorMessage(`Failed to load ${category} from GitHub: ${error}`);
            return [];
        }
    }

    async getFileContent(downloadUrl: string): Promise<string> {
        try {
            const response = await axios.get(downloadUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'VSCode-AwesomeCopilot-Extension'
                }
            });
            return response.data;
        } catch (error) {
            console.error('Failed to fetch file content:', error);
            throw new Error(`Failed to fetch file content: ${error}`);
        }
    }

    clearCache(): void {
        this.cache.clear();
    }

    getCacheStatus(): string {
        const entries = Array.from(this.cache.entries());
        if (entries.length === 0) {
            return 'Cache empty';
        }
        
        const now = Date.now();
        const status = entries.map(([category, entry]) => {
            const age = Math.floor((now - entry.timestamp) / (60 * 1000)); // minutes
            return `${category}: ${entry.data.length} files (${age}m old)`;
        }).join(', ');
        
        return status;
    }
}