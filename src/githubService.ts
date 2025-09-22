
import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import { GitHubFile, CopilotCategory, CacheEntry, RepoSource } from './types';
import { RepoStorage } from './repoStorage';


export class GitHubService {
    private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
    // Cache key: repoKey|category
    private cache: Map<string, CacheEntry> = new Map();

    // Create HTTPS agent with proper SSL handling (following VS Code Git extension pattern)
    private createHttpsAgent(url: string): https.Agent | undefined {
        try {
            // Check VS Code git.ignoreLegacyWarning and http.systemCertificates settings
            const gitConfig = vscode.workspace.getConfiguration('git');
            const httpConfig = vscode.workspace.getConfiguration('http');
            
            // If it's not github.com, treat as enterprise
            const isEnterprise = !url.includes('github.com');
            
            if (isEnterprise) {
                // For enterprise GitHub servers, use more permissive SSL options
                return new https.Agent({
                    rejectUnauthorized: false,
                    // Allow self-signed certificates
                    checkServerIdentity: () => undefined,
                    // Keep connections alive
                    keepAlive: true,
                    maxSockets: 5
                });
            }
        } catch (error) {
            console.warn('Failed to create HTTPS agent, using default:', error);
        }
        
        return undefined;
    }

    // Create request headers with proper authentication for enterprise GitHub
    private async createRequestHeaders(isEnterprise: boolean = false): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'User-Agent': 'VSCode-AwesomeCopilot-Extension',
            'Accept': 'application/vnd.github.v3+json'
        };

        if (isEnterprise) {
            // Enhanced enterprise GitHub auth headers
            headers['X-Requested-With'] = 'VSCode-Extension';
            headers['Accept-Encoding'] = 'gzip, deflate, br';
            headers['Accept-Language'] = 'en-US,en;q=0.9';
            headers['Cache-Control'] = 'no-cache';
            headers['Pragma'] = 'no-cache';
            headers['Sec-Fetch-Dest'] = 'empty';
            headers['Sec-Fetch-Mode'] = 'cors';
            headers['Sec-Fetch-Site'] = 'same-origin';
            
            // Priority 1: Check for configured enterprise token
            const config = vscode.workspace.getConfiguration('awesome-copilot');
            const enterpriseToken = config.get<string>('enterpriseToken');
            
            if (enterpriseToken) {
                headers['Authorization'] = `token ${enterpriseToken}`;
                console.log('🔑 Using configured enterprise GitHub token for API requests');
                return headers;
            }
            
            // Priority 2: Try VS Code's authentication provider
            try {
                const session = await vscode.authentication.getSession('github', [], { 
                    createIfNone: false,
                    silent: true 
                });
                if (session && session.accessToken) {
                    headers['Authorization'] = `token ${session.accessToken}`;
                    console.log('🔑 Using VS Code GitHub authentication for API requests');
                    return headers;
                }
            } catch (authError) {
                console.warn('📝 VS Code GitHub auth not available for API requests');
            }
            
            console.warn('⚠️ No authentication token available for enterprise GitHub API requests');
        }

        return headers;
    }

    // Get files for a category from all sources, merged
    async getFiles(category: CopilotCategory, forceRefresh: boolean = false, context?: vscode.ExtensionContext): Promise<GitHubFile[]> {
        // Get sources from storage (context required for multi-repo)
        let sources: RepoSource[] = [{ owner: 'github', repo: 'awesome-copilot', label: 'Awesome Copilot' }];
        if (context) {
            try { sources = RepoStorage.getSources(context); } catch {}
        }
        const now = Date.now();
        let allFiles: GitHubFile[] = [];
        for (const repo of sources) {
            const repoKey = `${repo.owner}/${repo.repo}`;
            const cacheKey = `${repoKey}|${category}`;
            const cacheEntry = this.cache.get(cacheKey);
            if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
                allFiles = allFiles.concat(cacheEntry.data);
                continue;
            }
            try {
                const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${category}`;
                const response = await axios.get<GitHubFile[]>(url, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'VSCode-AwesomeCopilot-Extension'
                    }
                });
                const files = (response.data as GitHubFile[]).filter((file: GitHubFile) => file.type === 'file').map(f => ({ ...f, repo }));
                this.cache.set(cacheKey, {
                    data: files,
                    timestamp: now,
                    category,
                    repo
                });
                allFiles = allFiles.concat(files);
            } catch (error) {
                // Show error for this repo, but continue others
                vscode.window.showWarningMessage(`Failed to load ${category} from ${repo.owner}/${repo.repo}: ${error}`);
            }
        }
        // Optionally: handle duplicate filenames (add repo info to name, etc.)
        // For now, just return all files (UI can distinguish by repo)
        return allFiles;
    }

    // Get files for a category from a specific repository
    async getFilesByRepo(repo: RepoSource, category: CopilotCategory, forceRefresh: boolean = false): Promise<GitHubFile[]> {
        const now = Date.now();
        const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
        const cacheKey = `${repoKey}|${category}`;
        const cacheEntry = this.cache.get(cacheKey);

        if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
            return cacheEntry.data;
        }

        try {
            // Support GitHub Enterprise Server URLs
            const apiUrl = this.buildApiUrl(repo, category);
            const isEnterprise = !!repo.baseUrl;
            const headers = await this.createRequestHeaders(isEnterprise);
            
            const response = await axios.get<GitHubFile[]>(apiUrl, {
                timeout: 10000,
                headers: headers,
                // Use robust SSL handling
                httpsAgent: this.createHttpsAgent(apiUrl),
                // For enterprise GitHub, allow cookies to be sent for authentication
                withCredentials: isEnterprise
            });

            const files = (response.data as GitHubFile[])
                .filter((file: GitHubFile) => file.type === 'file')
                .map(f => ({ ...f, repo }));

            this.cache.set(cacheKey, {
                data: files,
                timestamp: now,
                category,
                repo
            });

            return files;
        } catch (error) {
            console.error(`Failed to load ${category} from ${repo.owner}/${repo.repo}:`, error);
            throw new Error(`Failed to load ${category} from ${repo.owner}/${repo.repo}: ${error}`);
        }
    }

    async getFileContent(downloadUrl: string): Promise<string> {
        try {
            const isEnterprise = !downloadUrl.includes('github.com');
            const headers = await this.createRequestHeaders(isEnterprise);
            
            const response = await axios.get(downloadUrl, {
                timeout: 10000,
                headers: headers,
                // Use robust SSL handling
                httpsAgent: this.createHttpsAgent(downloadUrl),
                // For enterprise GitHub, allow cookies for authentication
                withCredentials: isEnterprise
            });
            return response.data;
        } catch (error) {
            console.error('Failed to fetch file content:', error);
            throw new Error(`Failed to fetch file content: ${error}`);
        }
    }

    // Build API URL for GitHub or GitHub Enterprise Server
    private buildApiUrl(repo: RepoSource, category: CopilotCategory): string {
        if (repo.baseUrl) {
            // GitHub Enterprise Server
            // Convert https://github.wdf.sap.corp to https://github.wdf.sap.corp/api/v3
            const baseUrl = repo.baseUrl.replace(/\/$/, ''); // Remove trailing slash
            return `${baseUrl}/api/v3/repos/${repo.owner}/${repo.repo}/contents/${category}`;
        } else {
            // Public GitHub
            return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${category}`;
        }
    }

    clearCache(): void {
        this.cache.clear();
    }

    // Clear cache entries for a specific repository
    clearRepoCache(repo: RepoSource): void {
        const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
        const keysToDelete: string[] = [];
        
        // Find all cache keys for this repository
        for (const cacheKey of this.cache.keys()) {
            if (cacheKey.startsWith(`${repoKey}|`)) {
                keysToDelete.push(cacheKey);
            }
        }
        
        // Delete the cache entries
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }
        
        console.log(`Cleared cache for repository: ${repo.owner}/${repo.repo}`);
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
