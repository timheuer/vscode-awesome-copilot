
import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import { GitHubFile, CopilotCategory, CacheEntry, RepoSource } from './types';
import { RepoStorage } from './repoStorage';


export class GitHubService {
    private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
    // Cache key: repoKey|category
    private cache: Map<string, CacheEntry> = new Map();

    // Create HTTPS agent with secure SSL handling - requires explicit user opt-in for insecure certificates
    private createHttpsAgent(url: string): https.Agent | undefined {
        try {
            // Check security configuration
            const config = vscode.workspace.getConfiguration('awesome-copilot');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            // If it's not github.com, treat as enterprise
            const isEnterprise = !url.includes('github.com');


            if (isEnterprise && allowInsecureEnterpriseCerts) {
                // Only allow insecure certificates when explicitly enabled by user
                console.warn('⚠️ SECURITY WARNING: Using insecure HTTPS agent for enterprise GitHub server');
                return new https.Agent({
                    rejectUnauthorized: false,
                    checkServerIdentity: () => undefined,
                    keepAlive: true,
                    maxSockets: 5
                });
            } else if (isEnterprise) {
                return new https.Agent({
                    rejectUnauthorized: true,
                    keepAlive: true,
                    maxSockets: 5
                });
            }
        } catch (error) {
            console.warn('Failed to create HTTPS agent:', error);
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
                    return headers;
                }
            } catch (authError) {
                // Silent failure for auth attempts
            }
        }

        return headers;
    }

    // Get files for a category from all sources, merged
    async getFiles(category: CopilotCategory, forceRefresh: boolean = false, context?: vscode.ExtensionContext): Promise<GitHubFile[]> {
        // Get sources from storage (context required for multi-repo)
        let sources: RepoSource[] = [{ owner: 'github', repo: 'awesome-copilot', label: 'Awesome Copilot' }];
        if (context) {
            try { sources = RepoStorage.getSources(context); } catch { }
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
                const apiUrl = this.buildApiUrl(repo, category);
                const isEnterprise = !!repo.baseUrl;
                const headers = await this.createRequestHeaders(isEnterprise);

                const axiosConfig: any = {
                    timeout: 10000,
                    headers: headers,
                    // For enterprise GitHub, allow cookies to be sent for authentication
                    withCredentials: isEnterprise
                };

                // Apply SSL configuration for enterprise GitHub
                if (isEnterprise) {
                    const httpsAgent = this.createHttpsAgent(apiUrl);
                    if (httpsAgent) {
                        axiosConfig.httpsAgent = httpsAgent;
                        axiosConfig.agent = httpsAgent;
                    }
                }

                let response;
                const config = vscode.workspace.getConfiguration('awesome-copilot');
                const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

                if (isEnterprise && allowInsecureEnterpriseCerts) {
                    // Temporary global TLS override for this specific enterprise request
                    const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                    try {
                        response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                    } finally {
                        // Restore original setting immediately
                        if (originalRejectUnauthorized === undefined) {
                            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                        } else {
                            process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                        }
                    }
                } else {
                    response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                }
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
        // Handle duplicate filenames by adding repo information to displayName
        const fileNameCounts = new Map<string, number>();
        const duplicateNames = new Set<string>();

        // First pass: count occurrences of each filename
        for (const file of allFiles) {
            const count = fileNameCounts.get(file.name) || 0;
            fileNameCounts.set(file.name, count + 1);
            if (count >= 1) {
                duplicateNames.add(file.name);
            }
        }

        // Second pass: add displayName for duplicates
        for (const file of allFiles) {
            if (duplicateNames.has(file.name) && file.repo) {
                // For duplicates, show "filename.ext (owner/repo)"
                file.displayName = `${file.name} (${file.repo.owner}/${file.repo.repo})`;
            } else {
                // For unique files, use original name
                file.displayName = file.name;
            }
        }

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

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                // For enterprise GitHub, allow cookies to be sent for authentication
                withCredentials: isEnterprise
            };

            // Apply SSL configuration for enterprise GitHub
            if (isEnterprise) {
                const httpsAgent = this.createHttpsAgent(apiUrl);
                if (httpsAgent) {
                    axiosConfig.httpsAgent = httpsAgent;
                    axiosConfig.agent = httpsAgent;
                }
            }

            let response;
            const config = vscode.workspace.getConfiguration('awesome-copilot');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            if (isEnterprise && allowInsecureEnterpriseCerts) {
                // Temporary global TLS override for this specific enterprise request
                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                try {
                    response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                } finally {
                    // Restore original setting immediately
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            } else {
                response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
            }

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

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                // For enterprise GitHub, allow cookies for authentication
                withCredentials: isEnterprise
            };

            // Apply SSL configuration for enterprise GitHub
            if (isEnterprise) {
                const httpsAgent = this.createHttpsAgent(downloadUrl);
                if (httpsAgent) {
                    axiosConfig.httpsAgent = httpsAgent;
                    axiosConfig.agent = httpsAgent;
                }
            }

            let response;
            const config = vscode.workspace.getConfiguration('awesome-copilot');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            if (isEnterprise && allowInsecureEnterpriseCerts) {
                // Temporary global TLS override for this specific enterprise request
                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                try {
                    response = await axios.get(downloadUrl, axiosConfig);
                } finally {
                    // Restore original setting immediately
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            } else {
                response = await axios.get(downloadUrl, axiosConfig);
            }
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
