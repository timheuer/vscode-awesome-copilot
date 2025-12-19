
import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import { GitHubFile, CopilotCategory, CacheEntry, RepoSource } from './types';
import { RepoStorage } from './repoStorage';
import { StatusBarManager } from './statusBarManager';
import { getLogger } from './logger';


export class GitHubService {
    private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
    // Cache key: repoKey|category
    private cache: Map<string, CacheEntry> = new Map();
    private statusBarManager: StatusBarManager;

    constructor(statusBarManager?: StatusBarManager) {
        // Use provided status bar manager or create a new one
        this.statusBarManager = statusBarManager || new StatusBarManager();
    }

    // Check if GitHub authentication is available and prompt if needed
    private async ensureGitHubAuth(isEnterprise: boolean = false): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('awesome-copilot');
        const enableAuth = config.get<boolean>('enableGithubAuth', true);
        
        if (!enableAuth) {
            return false;
        }

        try {
            // For enterprise, check if token is configured first
            if (isEnterprise) {
                const enterpriseToken = config.get<string>('enterpriseToken');
                if (enterpriseToken) {
                    return true;
                }
            }

            // Try to get existing session
            let session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: false,
                silent: true
            });

            if (!session) {
                // Prompt user to sign in
                const signInChoice = await vscode.window.showInformationMessage(
                    'Sign in to GitHub to increase API rate limits from 60 to 5,000 requests per hour.',
                    'Sign In',
                    'Skip'
                );

                if (signInChoice === 'Sign In') {
                    session = await vscode.authentication.getSession('github', ['repo'], {
                        createIfNone: true
                    });
                    if (session) {
                        this.statusBarManager.showInfo('GitHub authentication successful!');
                        return true;
                    }
                }
                return false;
            }
            return true;
        } catch (error) {
            getLogger().error('GitHub authentication error:', error);
            return false;
        }
    }

    // Handle authentication-related HTTP errors
    private async handleAuthError(error: any, isEnterprise: boolean = false): Promise<boolean> {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const statusCode = isAxiosError ? error.response?.status : undefined;

        if (statusCode === 401 || statusCode === 403) {
            const config = vscode.workspace.getConfiguration('awesome-copilot');
            const enableAuth = config.get<boolean>('enableGithubAuth', true);
            
            if (!enableAuth) {
                this.statusBarManager.showWarning('GitHub authentication is disabled. Enable it to avoid rate limits.');
                return false;
            }

            // Check if this is a rate limit issue
            const rateLimitRemaining = error.response?.headers['x-ratelimit-remaining'];
            if (rateLimitRemaining === '0') {
                const resetTime = error.response?.headers['x-ratelimit-reset'];
                if (resetTime) {
                    const resetDate = new Date(parseInt(resetTime) * 1000);
                    const waitMinutes = Math.ceil((resetDate.getTime() - Date.now()) / (60 * 1000));
                    this.statusBarManager.showWarning(`Rate limit exceeded. Resets in ${waitMinutes} minutes.`);
                    
                    // Suggest authentication if not already authenticated
                    const authChoice = await vscode.window.showWarningMessage(
                        `GitHub API rate limit exceeded. Sign in to GitHub to get 5,000 requests/hour instead of 60.`,
                        'Sign In',
                        'Wait'
                    );
                    
                    if (authChoice === 'Sign In') {
                        return await this.ensureGitHubAuth(isEnterprise);
                    }
                }
            } else {
                // Other authentication error
                const authChoice = await vscode.window.showErrorMessage(
                    'GitHub authentication failed. Sign in to access private repositories and increase rate limits.',
                    'Sign In',
                    'Skip'
                );
                
                if (authChoice === 'Sign In') {
                    return await this.ensureGitHubAuth(isEnterprise);
                }
            }
        }
        return false;
    }

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
                getLogger().warn('⚠️ SECURITY WARNING: Using insecure HTTPS agent for enterprise GitHub server');
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
            getLogger().warn('Failed to create HTTPS agent:', error);
        }
        return undefined;
    }

    // Create request headers with proper authentication for GitHub
    private async createRequestHeaders(isEnterprise: boolean = false): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'User-Agent': 'VSCode-AwesomeCopilot-Extension',
            'Accept': 'application/vnd.github.v3+json'
        };

        // Try to authenticate for all GitHub requests (both public and enterprise)
        const config = vscode.workspace.getConfiguration('awesome-copilot');
        const enableAuth = config.get<boolean>('enableGithubAuth', true);
        
        if (enableAuth) {
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
                const enterpriseToken = config.get<string>('enterpriseToken');
                if (enterpriseToken) {
                    headers['Authorization'] = `token ${enterpriseToken}`;
                    return headers;
                }
            }

            // Try VS Code's GitHub authentication provider for both public and enterprise GitHub
            try {
                const session = await vscode.authentication.getSession('github', ['repo'], {
                    createIfNone: false,
                    silent: true
                });
                if (session && session.accessToken) {
                    headers['Authorization'] = `token ${session.accessToken}`;
                    return headers;
                }
            } catch (authError) {
                getLogger().debug('GitHub authentication failed (silent):', authError);
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
            const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
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

                try {
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
                } catch (requestError) {
                    // Handle authentication errors and retry
                    const authRetried = await this.handleAuthError(requestError, isEnterprise);
                    if (authRetried) {
                        // Retry with new authentication
                        const newHeaders = await this.createRequestHeaders(isEnterprise);
                        axiosConfig.headers = newHeaders;
                        
                        if (isEnterprise && allowInsecureEnterpriseCerts) {
                            const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                            try {
                                response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                            } finally {
                                if (originalRejectUnauthorized === undefined) {
                                    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                                } else {
                                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                                }
                            }
                        } else {
                            response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                        }
                    } else {
                        throw requestError;
                    }
                }

                // For Skills category, show directories (folders); for other categories, show files
                const files = (response.data as GitHubFile[])
                    .filter((file: GitHubFile) => {
                        if (category === CopilotCategory.Skills) {
                            return file.type === 'dir';
                        }
                        return file.type === 'file';
                    })
                    .map(f => ({ ...f, repo }));
                this.cache.set(cacheKey, {
                    data: files,
                    timestamp: now,
                    category,
                    repo
                });
                allFiles = allFiles.concat(files);
            } catch (error) {
                // Handle different types of errors
                const isAxiosError = error && typeof error === 'object' && 'response' in error;
                const statusCode = isAxiosError ? (error as any).response?.status : undefined;
                
                if (statusCode === 404) {
                    // 404 is expected when a repository doesn't have a particular category folder
                    getLogger().debug(`Category '${category}' not found in ${repo.owner}/${repo.repo} (this is normal)`);
                } else {
                    // Show warning in status bar for other errors (auth, network, etc.)
                    this.statusBarManager.showWarning(`Failed to load ${category} from ${repo.owner}/${repo.repo}: ${error}`);
                }
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

            // For Skills category, show directories (folders); for other categories, show files
            const files = (response.data as GitHubFile[])
                .filter((file: GitHubFile) => {
                    if (category === CopilotCategory.Skills) {
                        return file.type === 'dir';
                    }
                    return file.type === 'file';
                })
                .map(f => ({ ...f, repo }));

            this.cache.set(cacheKey, {
                data: files,
                timestamp: now,
                category,
                repo
            });

            return files;
        } catch (error) {
            // Handle different types of errors
            const isAxiosError = error && typeof error === 'object' && 'response' in error;
            const statusCode = isAxiosError ? (error as any).response?.status : undefined;
            
            if (statusCode === 404) {
                // 404 is expected when a repository doesn't have a particular category folder
                // Return empty array instead of throwing error
                getLogger().debug(`Category '${category}' not found in ${repo.owner}/${repo.repo} (this is normal)`);
                return [];
            } else {
                // Log and throw error for other types of errors (auth, network, etc.)
                getLogger().error(`Failed to load ${category} from ${repo.owner}/${repo.repo}:`, error);
                throw new Error(`Failed to load ${category} from ${repo.owner}/${repo.repo}: ${error}`);
            }
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
            getLogger().error('Failed to fetch file content:', error);
            throw new Error(`Failed to fetch file content: ${error}`);
        }
    }

    // Get contents of a directory recursively (for Skills folders)
    async getDirectoryContents(repo: RepoSource, path: string): Promise<GitHubFile[]> {
        try {
            const apiUrl = this.buildApiUrlForPath(repo, path);
            const isEnterprise = !!repo.baseUrl;
            const headers = await this.createRequestHeaders(isEnterprise);

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                withCredentials: isEnterprise
            };

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
                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                try {
                    response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                } finally {
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            } else {
                response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
            }

            const contents: GitHubFile[] = [];
            const items = response.data as GitHubFile[];

            for (const item of items) {
                contents.push({ ...item, repo });
                
                // Recursively get subdirectory contents
                if (item.type === 'dir') {
                    const subContents = await this.getDirectoryContents(repo, item.path);
                    contents.push(...subContents);
                }
            }

            return contents;
        } catch (error) {
            getLogger().error(`Failed to fetch directory contents for ${path}:`, error);
            throw new Error(`Failed to fetch directory contents: ${error}`);
        }
    }

    // Build API URL for a specific path
    private buildApiUrlForPath(repo: RepoSource, path: string): string {
        if (repo.baseUrl) {
            const baseUrl = repo.baseUrl.replace(/\/$/, '');
            return `${baseUrl}/api/v3/repos/${repo.owner}/${repo.repo}/contents/${path}`;
        } else {
            return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`;
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

        getLogger().info(`Cleared cache for repository: ${repo.owner}/${repo.repo}`);
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
