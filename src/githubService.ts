
import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import { GitHubFile, CopilotCategory, CacheEntry, RepoSource } from './types';
import { RepoStorage } from './repoStorage';
import { StatusBarManager } from './statusBarManager';
import { getLogger } from './logger';

type RequestHeadersResult = {
    headers: Record<string, string>;
    authSource: 'none' | 'enterprise-token' | 'vscode-github-session';
};

export class GitHubService {
    private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
    // Cache key: repoKey|category
    private cache: Map<string, CacheEntry> = new Map();
    private statusBarManager: StatusBarManager;

    private static readonly UNAUTHENTICATED_AUTH_SOURCE = 'none';

    private getRepoKey(repo: RepoSource): string {
        return `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }

    private getHeaderValue(error: unknown, headerName: string): string | undefined {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const value = isAxiosError ? (error as any).response?.headers?.[headerName] : undefined;

        if (value === undefined || value === null) {
            return undefined;
        }

        return String(value);
    }

    private isRateLimitExceeded(error: unknown): boolean {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const statusCode = isAxiosError ? (error as any).response?.status : undefined;
        const remaining = this.getHeaderValue(error, 'x-ratelimit-remaining');
        const retryAfter = this.getHeaderValue(error, 'retry-after');
        const message = this.formatError(error).toLowerCase();

        return statusCode === 429 || remaining === '0' || retryAfter !== undefined || message.includes('rate limit');
    }

    private logCategoryFetchSummary(repo: RepoSource, category: CopilotCategory, rawItems: GitHubFile[], filteredItems: GitHubFile[]): void {
        const fileCount = rawItems.filter(item => item.type === 'file').length;
        const directoryCount = rawItems.filter(item => item.type === 'dir').length;
        const repoKey = this.getRepoKey(repo);

        getLogger().trace(
            `Fetched listing for ${repoKey}/${category}: raw=${rawItems.length}, files=${fileCount}, dirs=${directoryCount}, returned=${filteredItems.length}`
        );
    }

    private logHttpError(repoKey: string, category: CopilotCategory, error: unknown): void {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const statusCode = isAxiosError ? (error as any).response?.status : undefined;
        const remaining = this.getHeaderValue(error, 'x-ratelimit-remaining');
        const reset = this.getHeaderValue(error, 'x-ratelimit-reset');
        const retryAfter = this.getHeaderValue(error, 'retry-after');

        getLogger().trace(
            `HTTP error retrieving listing for ${repoKey}/${category}: status=${statusCode ?? 'unknown'}, remaining=${remaining ?? 'unknown'}, reset=${reset ?? 'unknown'}, retryAfter=${retryAfter ?? 'unknown'}, error=${this.formatError(error)}`
        );
    }

    private cacheListingResult(cacheKey: string, category: CopilotCategory, repo: RepoSource, data: GitHubFile[], timestamp: number): void {
        this.cache.set(cacheKey, {
            data,
            timestamp,
            category,
            repo
        });
    }

    private getCachedListing(cacheKey: string): CacheEntry | undefined {
        return this.cache.get(cacheKey);
    }

    private logStaleCacheFallback(repoKey: string, category: CopilotCategory, cacheEntry: CacheEntry): void {
        const ageMinutes = Math.floor((Date.now() - cacheEntry.timestamp) / (60 * 1000));
        getLogger().debug(
            `Using stale cached listing for ${repoKey}/${category} with ${cacheEntry.data.length} item(s) after fetch failure (${ageMinutes}m old)`
        );
    }

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
    private async handleAuthError(error: any, isEnterprise: boolean = false, silent: boolean = false): Promise<boolean> {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const statusCode = isAxiosError ? error.response?.status : undefined;

        if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
            const config = vscode.workspace.getConfiguration('awesome-copilot');
            const enableAuth = config.get<boolean>('enableGithubAuth', true);

            if (!enableAuth) {
                if (!silent) {
                    this.statusBarManager.showWarning('GitHub authentication is disabled. Enable it to avoid rate limits.');
                }
                return false;
            }

            // Check if this is a rate limit issue
            if (this.isRateLimitExceeded(error)) {
                const resetTime = this.getHeaderValue(error, 'x-ratelimit-reset');
                if (resetTime) {
                    if (silent) {
                        return false;
                    }

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
                if (silent) {
                    return false;
                }

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
    private async createRequestHeaders(isEnterprise: boolean = false, includeAuth: boolean = true): Promise<RequestHeadersResult> {
        const headers: Record<string, string> = {
            'User-Agent': 'VSCode-AwesomeCopilot-Extension',
            'Accept': 'application/vnd.github.v3+json'
        };

        if (!includeAuth) {
            getLogger().trace('Proceeding without GitHub authentication headers');
            return { headers, authSource: GitHubService.UNAUTHENTICATED_AUTH_SOURCE };
        }

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
                    getLogger().trace('Using configured enterprise token for GitHub request headers');
                    return { headers, authSource: 'enterprise-token' };
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
                    getLogger().trace(`Using VS Code GitHub authentication session for request headers (${session.account.label})`);
                    return { headers, authSource: 'vscode-github-session' };
                }
            } catch (authError) {
                getLogger().debug('GitHub authentication failed (silent):', authError);
            }
        }

        getLogger().trace('Proceeding without GitHub authentication headers');

        return { headers, authSource: GitHubService.UNAUTHENTICATED_AUTH_SOURCE };
    }

    private isRateLimitError(error: unknown): boolean {
        return this.isRateLimitExceeded(error);
    }

    private shouldRetryWithoutAuth(error: unknown, authSource: RequestHeadersResult['authSource']): boolean {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const statusCode = isAxiosError ? (error as any).response?.status : undefined;

        return statusCode === 403 && authSource !== GitHubService.UNAUTHENTICATED_AUTH_SOURCE && !this.isRateLimitError(error);
    }

    private async executeListingRequest(
        apiUrl: string,
        axiosConfig: any,
        isEnterprise: boolean,
        allowInsecureEnterpriseCerts: boolean
    ): Promise<GitHubFile[]> {
        if (isEnterprise && allowInsecureEnterpriseCerts) {
            const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

            try {
                const response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                return response.data as GitHubFile[];
            } finally {
                if (originalRejectUnauthorized === undefined) {
                    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                } else {
                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                }
            }
        }

        const response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
        return response.data as GitHubFile[];
    }

    private async fetchCategoryListing(repo: RepoSource, category: CopilotCategory): Promise<GitHubFile[]> {
        const apiUrl = this.buildApiUrl(repo, category);
        const repoKey = this.getRepoKey(repo);
        const isEnterprise = !!repo.baseUrl;
        const config = vscode.workspace.getConfiguration('awesome-copilot');
        const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

        let requestHeaders = await this.createRequestHeaders(isEnterprise);

        getLogger().trace(`Fetching listing for ${repoKey}/${category} from ${apiUrl}`);

        const axiosConfig: any = {
            timeout: 10000,
            headers: requestHeaders.headers,
            withCredentials: isEnterprise
        };

        if (isEnterprise) {
            const httpsAgent = this.createHttpsAgent(apiUrl);
            if (httpsAgent) {
                axiosConfig.httpsAgent = httpsAgent;
                axiosConfig.agent = httpsAgent;
            }
        }

        try {
            return await this.executeListingRequest(apiUrl, axiosConfig, isEnterprise, allowInsecureEnterpriseCerts);
        } catch (initialError) {
            const authRetried = await this.handleAuthError(initialError, isEnterprise, true);
            if (authRetried) {
                requestHeaders = await this.createRequestHeaders(isEnterprise);
                axiosConfig.headers = requestHeaders.headers;

                try {
                    return await this.executeListingRequest(apiUrl, axiosConfig, isEnterprise, allowInsecureEnterpriseCerts);
                } catch (retriedError) {
                    if (this.shouldRetryWithoutAuth(retriedError, requestHeaders.authSource)) {
                        getLogger().trace(`Retrying listing for ${repoKey}/${category} without auth headers after authenticated 403 (${requestHeaders.authSource})`);
                        const unauthenticatedHeaders = await this.createRequestHeaders(isEnterprise, false);
                        axiosConfig.headers = unauthenticatedHeaders.headers;
                        return await this.executeListingRequest(apiUrl, axiosConfig, isEnterprise, allowInsecureEnterpriseCerts);
                    }

                    throw retriedError;
                }
            }

            if (this.shouldRetryWithoutAuth(initialError, requestHeaders.authSource)) {
                getLogger().trace(`Retrying listing for ${repoKey}/${category} without auth headers after authenticated 403 (${requestHeaders.authSource})`);
                const unauthenticatedHeaders = await this.createRequestHeaders(isEnterprise, false);
                axiosConfig.headers = unauthenticatedHeaders.headers;
                return await this.executeListingRequest(apiUrl, axiosConfig, isEnterprise, allowInsecureEnterpriseCerts);
            }

            throw initialError;
        }
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
            const repoKey = this.getRepoKey(repo);
            const cacheKey = `${repoKey}|${category}`;
            const cacheEntry = this.getCachedListing(cacheKey);
            if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
                getLogger().trace(`Using cached listing for ${repoKey}/${category} with ${cacheEntry.data.length} item(s)`);
                allFiles = allFiles.concat(cacheEntry.data);
                continue;
            }
            try {
                const rawFiles = await this.fetchCategoryListing(repo, category);

                // For Skills category, show directories (folders); for other categories, show files
                const files = rawFiles
                    .filter((file: GitHubFile) => {
                        if (category === CopilotCategory.Skills) {
                            return file.type === 'dir';
                        }
                        return file.type === 'file';
                    })
                    .map(f => ({ ...f, repo }));

                this.logCategoryFetchSummary(repo, category, rawFiles, files);
                this.cacheListingResult(cacheKey, category, repo, files, now);
                allFiles = allFiles.concat(files);
            } catch (error) {
                // Handle different types of errors
                const isAxiosError = error && typeof error === 'object' && 'response' in error;
                const statusCode = isAxiosError ? (error as any).response?.status : undefined;

                if (statusCode === 404) {
                    // 404 is expected when a repository doesn't have a particular category folder
                    getLogger().debug(`Category '${category}' not found in ${repo.owner}/${repo.repo} (this is normal)`);
                    this.cacheListingResult(cacheKey, category, repo, [], now);
                } else {
                    this.logHttpError(repoKey, category, error);
                    getLogger().debug(`Failed to fetch listing for ${repoKey}/${category}: ${this.formatError(error)}`);

                    if (cacheEntry) {
                        this.logStaleCacheFallback(repoKey, category, cacheEntry);
                        allFiles = allFiles.concat(cacheEntry.data);
                    } else {
                        getLogger().trace(`No cached listing available for ${repoKey}/${category}; returning empty result after fetch failure`);
                    }
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

        getLogger().trace(`Merged listing for category '${category}' across ${sources.length} source(s): ${allFiles.length} item(s)`);

        return allFiles;
    }

    // Get files for a category from a specific repository
    async getFilesByRepo(repo: RepoSource, category: CopilotCategory, forceRefresh: boolean = false): Promise<GitHubFile[]> {
        const now = Date.now();
        const repoKey = this.getRepoKey(repo);
        const cacheKey = `${repoKey}|${category}`;
        const cacheEntry = this.getCachedListing(cacheKey);

        if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
            getLogger().trace(`Using cached listing for ${repoKey}/${category} with ${cacheEntry.data.length} item(s)`);
            return cacheEntry.data;
        }

        try {
            const rawFiles = await this.fetchCategoryListing(repo, category);

            // For Skills category, show directories (folders); for other categories, show files
            const files = rawFiles
                .filter((file: GitHubFile) => {
                    if (category === CopilotCategory.Skills) {
                        return file.type === 'dir';
                    }
                    return file.type === 'file';
                })
                .map(f => ({ ...f, repo }));

            this.logCategoryFetchSummary(repo, category, rawFiles, files);

            this.cacheListingResult(cacheKey, category, repo, files, now);

            return files;
        } catch (error) {
            // Handle different types of errors
            const isAxiosError = error && typeof error === 'object' && 'response' in error;
            const statusCode = isAxiosError ? (error as any).response?.status : undefined;

            if (statusCode === 404) {
                // 404 is expected when a repository doesn't have a particular category folder
                // Return empty array instead of throwing error
                getLogger().debug(`Category '${category}' not found in ${repo.owner}/${repo.repo} (this is normal)`);
                this.cacheListingResult(cacheKey, category, repo, [], now);
                return [];
            } else {
                this.logHttpError(repoKey, category, error);
                getLogger().debug(`Failed to fetch listing for ${repoKey}/${category}: ${this.formatError(error)}`);

                if (cacheEntry) {
                    this.logStaleCacheFallback(repoKey, category, cacheEntry);
                    return cacheEntry.data;
                }

                getLogger().trace(`No cached listing available for ${repoKey}/${category}; returning empty result after fetch failure`);
            }
            return [];
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

            // Add all items first
            for (const item of items) {
                contents.push({ ...item, repo });
            }

            // Recursively get subdirectory contents in parallel for better performance
            const subdirs = items.filter(item => item.type === 'dir');
            if (subdirs.length > 0) {
                const subContentPromises = subdirs.map(dir => this.getDirectoryContents(repo, dir.path));
                const subContentsArrays = await Promise.all(subContentPromises);

                // Flatten and add all subdirectory contents
                for (const subContents of subContentsArrays) {
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
