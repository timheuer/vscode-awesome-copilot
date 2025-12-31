import * as vscode from 'vscode';
import * as fs from 'fs';
import { GitHubService } from './githubService';
import { CopilotItem, CopilotCategory, CATEGORY_LABELS, FOLDER_PATHS, GitHubFile, RepoSource } from './types';
import { RepoStorage } from './repoStorage';
import { getLogger } from './logger';
import { DownloadTracker } from './downloadTracker';

// Text document provider for remote content in diff view
class RemoteContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        return Buffer.from(uri.query, 'base64').toString('utf8');
    }
}

export class AwesomeCopilotTreeItem extends vscode.TreeItem {
    public readonly copilotItem?: CopilotItem;
    public readonly category?: CopilotCategory;
    public readonly repo?: RepoSource;
    public readonly itemType: 'repo' | 'category' | 'file';

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        itemType: 'repo' | 'category' | 'file',
        copilotItem?: CopilotItem,
        category?: CopilotCategory,
        repo?: RepoSource
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.copilotItem = copilotItem;
        this.category = category;
        this.repo = repo;

        if (itemType === 'file' && copilotItem) {
            this.contextValue = 'copilotFile';
            // Skills are folders, not individual files
            if (copilotItem.category === CopilotCategory.Skills && copilotItem.file.type === 'dir') {
                this.description = 'Skill Folder';
                this.tooltip = new vscode.MarkdownString(
                    `**${copilotItem.name}**\n\nType: Skill Folder\nRepo: ${copilotItem.repo ? copilotItem.repo.owner + '/' + copilotItem.repo.repo : ''}\n\nClick to preview or download entire skill folder`
                );
                this.iconPath = new vscode.ThemeIcon('folder');
            } else {
                this.resourceUri = vscode.Uri.parse(copilotItem.file.download_url);
                this.description = `${(copilotItem.file.size / 1024).toFixed(1)}KB`;
                
                // Collections are special - they contain multiple files
                if (copilotItem.category === CopilotCategory.Collections) {
                    this.tooltip = new vscode.MarkdownString(
                        `**${copilotItem.name}**\n\nType: Collection (contains multiple files)\nSize: ${(copilotItem.file.size / 1024).toFixed(1)}KB\nRepo: ${copilotItem.repo ? copilotItem.repo.owner + '/' + copilotItem.repo.repo : ''}\n\nClick to preview or download collection`
                    );
                } else {
                    this.tooltip = new vscode.MarkdownString(
                        `**${copilotItem.name}**\n\nSize: ${(copilotItem.file.size / 1024).toFixed(1)}KB\nRepo: ${copilotItem.repo ? copilotItem.repo.owner + '/' + copilotItem.repo.repo : ''}\n\nClick to preview content`
                    );
                }
                
                // Set appropriate icon based on category
                switch (copilotItem.category) {
                    case CopilotCategory.Collections:
                        this.iconPath = new vscode.ThemeIcon('comment-discussion');
                        break;
                    case CopilotCategory.Instructions:
                        this.iconPath = new vscode.ThemeIcon('book');
                        break;
                    case CopilotCategory.Prompts:
                        this.iconPath = new vscode.ThemeIcon('lightbulb');
                        break;
                    case CopilotCategory.Agents:
                        this.iconPath = new vscode.ThemeIcon('robot');
                        break;
                    case CopilotCategory.Skills:
                        this.iconPath = new vscode.ThemeIcon('tools');
                        break;
                }
            }
        } else if (itemType === 'category') {
            this.contextValue = 'copilotCategory';
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (itemType === 'repo' && repo) {
            this.contextValue = 'copilotRepo';
            this.iconPath = new vscode.ThemeIcon('repo');
            this.description = `${repo.owner}/${repo.repo}`;
            this.tooltip = new vscode.MarkdownString(
                `**Repository**: ${repo.owner}/${repo.repo}\n\n${repo.label || 'GitHub Repository'}\n\nRight-click for options`
            );
        }
    }
}

export class AwesomeCopilotProvider implements vscode.TreeDataProvider<AwesomeCopilotTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AwesomeCopilotTreeItem | undefined | null | void> = new vscode.EventEmitter<AwesomeCopilotTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AwesomeCopilotTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private repoItems: Map<string, Map<CopilotCategory, CopilotItem[]>> = new Map();
    private loading: Set<string> = new Set();
    private context: vscode.ExtensionContext | undefined;
    private downloadTracker: DownloadTracker | undefined;

    constructor(private githubService: GitHubService, context?: vscode.ExtensionContext, downloadTracker?: DownloadTracker) {
        this.context = context;
        this.downloadTracker = downloadTracker;
    }

    refresh(): void {
        // Clear all cached data
        this.repoItems.clear();
        this.loading.clear();

        // Fire tree data change event to refresh the UI
        this._onDidChangeTreeData.fire();

        // Reload data for current repositories
        this.loadAllReposAndCategories(true);
    }

    // Refresh only a specific repository in the tree
    refreshRepo(repo: RepoSource): void {
        // Find and remove cached data for this specific repo
        const repoKey = `${repo.owner}/${repo.repo}`;
        this.repoItems.delete(repoKey);
        
        // Clear loading states for this repo
        const loadingKeysToDelete = Array.from(this.loading).filter(key => key.startsWith(`${repoKey}-`));
        loadingKeysToDelete.forEach(key => this.loading.delete(key));

        // Find the tree item for this repository
        const repos = this.context ? RepoStorage.getSources(this.context) : [{ owner: 'github', repo: 'awesome-copilot', label: 'Awesome Copilot' }];
        const targetRepo = repos.find(r => r.owner === repo.owner && r.repo === repo.repo && (r.baseUrl || 'github.com') === (repo.baseUrl || 'github.com'));
        
        if (targetRepo) {
            // Create the tree item for this repo
            const repoTreeItem = new AwesomeCopilotTreeItem(
                targetRepo.label || `${targetRepo.owner}/${targetRepo.repo}`,
                vscode.TreeItemCollapsibleState.Expanded,
                'repo',
                undefined,
                undefined,
                targetRepo
            );

            // Fire change event for just this repository tree item
            this._onDidChangeTreeData.fire(repoTreeItem);

            // Preload the data for this repository
            this.loadSingleRepo(targetRepo, true);
        }
    }

    // Load data for a single repository
    private async loadSingleRepo(repo: RepoSource, forceRefresh: boolean = false): Promise<void> {
        const repoKey = `${repo.owner}/${repo.repo}`;
        if (!this.repoItems.has(repoKey)) {
            this.repoItems.set(repoKey, new Map());
        }

        const repoData = this.repoItems.get(repoKey)!;
        const categories = [CopilotCategory.Collections, CopilotCategory.Instructions, CopilotCategory.Prompts, CopilotCategory.Agents, CopilotCategory.Skills];

        const allItems: CopilotItem[] = [];

        for (const category of categories) {
            const loadingKey = `${repoKey}-${category}`;
            
            if (!this.loading.has(loadingKey)) {
                this.loading.add(loadingKey);
                
                try {
                    const files = await this.githubService.getFilesByRepo(repo, category, forceRefresh);
                    const items = files.map((file: GitHubFile) => ({
                        id: `${category}-${file.name}-${repo.owner}-${repo.repo}`,
                        name: file.name,
                        category,
                        file,
                        repo: repo
                    }));
                    repoData.set(category, items);
                    allItems.push(...items);
                } catch (error: any) {
                    // Handle different types of errors
                    const statusCode = error?.response?.status || (error?.message?.includes('404') ? 404 : undefined);
                    
                    if (statusCode === 404) {
                        // 404 is expected when a repository doesn't have a particular category folder
                        repoData.set(category, []);
                        getLogger().debug(`Category '${category}' not found in ${repoKey} (this is normal)`);
                    } else {
                        // Show error for other types of errors (auth, network, etc.)
                        getLogger().error(`Failed to load ${category} from ${repoKey}: ${error}`);
                    }
                } finally {
                    this.loading.delete(loadingKey);
                }
            }
        }

        // Fire change event to update UI for this repo after all categories are loaded
        this._onDidChangeTreeData.fire();

        // Check for updates if setting is enabled
        await this.checkForUpdates(allItems);
    }

    getTreeItem(element: AwesomeCopilotTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AwesomeCopilotTreeItem): Promise<AwesomeCopilotTreeItem[]> {
        if (!element) {
            // Return root repositories
            const repos = this.context ? RepoStorage.getSources(this.context) : [{ owner: 'github', repo: 'awesome-copilot', label: 'Awesome Copilot' }];
            return repos.map(repo =>
                new AwesomeCopilotTreeItem(
                    repo.label || `${repo.owner}/${repo.repo}`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'repo',
                    undefined,
                    undefined,
                    repo
                )
            );
        }

        if (element.itemType === 'repo' && element.repo) {
            // Return categories for this repository
            return [
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Collections],
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'category',
                    undefined,
                    CopilotCategory.Collections,
                    element.repo
                ),
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Instructions],
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'category',
                    undefined,
                    CopilotCategory.Instructions,
                    element.repo
                ),
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Prompts],
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'category',
                    undefined,
                    CopilotCategory.Prompts,
                    element.repo
                ),
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Agents],
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'category',
                    undefined,
                    CopilotCategory.Agents,
                    element.repo
                ),
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Skills],
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'category',
                    undefined,
                    CopilotCategory.Skills,
                    element.repo
                )
            ];
        }

        if (element.itemType === 'category' && element.category && element.repo) {
            // Return files for the category in this repository
            const items = await this.getItemsForRepoAndCategory(element.repo, element.category);

            return items.map(item =>
                new AwesomeCopilotTreeItem(
                    item.name,
                    vscode.TreeItemCollapsibleState.None,
                    'file',
                    item,
                    element.category,
                    element.repo
                )
            );
        }

        return [];
    }

    private async getItemsForRepoAndCategory(repo: RepoSource, category: CopilotCategory): Promise<CopilotItem[]> {
        const repoKey = `${repo.owner}/${repo.repo}`;
        const loadingKey = `${repoKey}-${category}`;

        if (!this.repoItems.has(repoKey)) {
            this.repoItems.set(repoKey, new Map());
        }

        const repoData = this.repoItems.get(repoKey)!;

        if (!repoData.has(category) && !this.loading.has(loadingKey)) {
            this.loading.add(loadingKey);
            try {
                // Fetch files from specific repository
                const files = await this.githubService.getFilesByRepo(repo, category);
                const items = files.map((file: GitHubFile) => ({
                    id: `${category}-${file.name}-${repo.owner}-${repo.repo}`,
                    name: file.name,
                    category,
                    file,
                    repo: repo
                }));
                repoData.set(category, items);
                this._onDidChangeTreeData.fire();
            } catch (error: any) {
                // Handle different types of errors
                const statusCode = error?.response?.status || (error?.message?.includes('404') ? 404 : undefined);
                
                if (statusCode === 404) {
                    // 404 is expected when a repository doesn't have a particular category folder
                    // Set empty array and don't show error to user
                    repoData.set(category, []);
                    getLogger().debug(`Category '${category}' not found in ${repoKey} (this is normal)`);
                } else {
                    // Show error for other types of errors (auth, network, etc.)
                    vscode.window.showErrorMessage(`Failed to load ${category} from ${repoKey}: ${error}`);
                }
                return [];
            } finally {
                this.loading.delete(loadingKey);
            }
        }

        return repoData.get(category) || [];
    }

    private async loadAllReposAndCategories(forceRefresh: boolean = false): Promise<void> {
        if (!this.context) {
            return;
        }

        const repos = RepoStorage.getSources(this.context);
        const categories = [CopilotCategory.Collections, CopilotCategory.Instructions, CopilotCategory.Prompts, CopilotCategory.Agents, CopilotCategory.Skills];

        // Collect all items for update checking
        const allItems: CopilotItem[] = [];

        for (const repo of repos) {
            const repoKey = `${repo.owner}/${repo.repo}`;
            if (!this.repoItems.has(repoKey)) {
                this.repoItems.set(repoKey, new Map());
            }

            const repoData = this.repoItems.get(repoKey)!;

            for (const category of categories) {
                try {
                    const files = await this.githubService.getFilesByRepo(repo, category, forceRefresh);
                    const items = files.map((file: GitHubFile) => ({
                        id: `${category}-${file.name}-${repo.owner}-${repo.repo}`,
                        name: file.name,
                        category,
                        file,
                        repo: repo
                    }));
                    repoData.set(category, items);
                    allItems.push(...items);
                } catch (error: any) {
                    // Handle different types of errors
                    const statusCode = error?.response?.status || (error?.message?.includes('404') ? 404 : undefined);
                    
                    if (statusCode === 404) {
                        // 404 is expected when a repository doesn't have a particular category folder
                        // Set empty array and don't show error to user
                        repoData.set(category, []);
                        getLogger().debug(`Category '${category}' not found in ${repoKey} (this is normal)`);
                    } else {
                        // Show error for other types of errors (auth, network, etc.)
                        vscode.window.showErrorMessage(`Failed to load ${category} from ${repoKey}: ${error}`);
                    }
                }
            }
        }

        this._onDidChangeTreeData.fire();

        // Check for updates if setting is enabled
        await this.checkForUpdates(allItems);
    }

    private async checkForUpdates(allItems: CopilotItem[]): Promise<void> {
        // Check if update checking is enabled
        const config = vscode.workspace.getConfiguration('awesome-copilot');
        const checkForUpdates = config.get<boolean>('checkForUpdates', true);

        if (!checkForUpdates || !this.downloadTracker) {
            return;
        }

        try {
            // Find items with updates
            const itemsWithUpdates = this.downloadTracker.findItemsWithUpdates(allItems);

            if (itemsWithUpdates.length > 0) {
                // Group by category for better readability
                const updatesByCategory: Record<string, CopilotItem[]> = {};
                for (const item of itemsWithUpdates) {
                    const categoryLabel = CATEGORY_LABELS[item.category];
                    if (!updatesByCategory[categoryLabel]) {
                        updatesByCategory[categoryLabel] = [];
                    }
                    updatesByCategory[categoryLabel].push(item);
                }

                // Build detailed message for logging
                let detailedMessage = `Updates available for ${itemsWithUpdates.length} downloaded item(s):\n\n`;
                for (const [category, items] of Object.entries(updatesByCategory)) {
                    detailedMessage += `${category}:\n`;
                    for (const item of items) {
                        detailedMessage += `  • ${item.name}\n`;
                    }
                    detailedMessage += '\n';
                }

                // Build summary for notification (single line with categories)
                const categoryList = Object.keys(updatesByCategory).join(', ');
                const shortMessage = `📦 Updates available for ${itemsWithUpdates.length} downloaded item(s) in: ${categoryList}`;

                // Show notification with action button
                const choice = await vscode.window.showInformationMessage(
                    shortMessage,
                    'Show Details',
                    'Dismiss'
                );

                if (choice === 'Show Details') {
                    // Show detailed list in a quick pick with actions
                    const quickPickItems: Array<vscode.QuickPickItem & { item?: CopilotItem }> = [];
                    for (const [category, categoryItems] of Object.entries(updatesByCategory)) {
                        quickPickItems.push({
                            label: category,
                            kind: vscode.QuickPickItemKind.Separator
                        });
                        for (const item of categoryItems) {
                            quickPickItems.push({
                                label: item.name,
                                description: 'Update available',
                                detail: 'Click to download the latest version',
                                item: item
                            });
                        }
                    }

                    const selected = await vscode.window.showQuickPick(quickPickItems, {
                        title: '📦 Available Updates',
                        placeHolder: 'Select an item to download the latest version'
                    });

                    // If user selected an item, trigger download
                    if (selected && selected.item) {
                        await this.handleUpdateDownload(selected.item);
                    }
                }

                getLogger().info(detailedMessage);
            }
        } catch (error) {
            getLogger().error('Error checking for updates:', error);
        }
    }

    private async handleUpdateDownload(item: CopilotItem): Promise<void> {
        try {
            // Loop to allow returning to menu after viewing diff
            let continueLoop = true;
            while (continueLoop) {
                // Ask user what they want to do
                const action = await vscode.window.showQuickPick(
                    [
                        { label: 'Download Update', description: 'Download and replace the local version', value: 'download' },
                        { label: 'Show Diff', description: 'Compare local version with the update', value: 'diff' },
                        { label: 'Cancel', description: '', value: 'cancel' }
                    ],
                    {
                        title: `Update Available: ${item.name}`,
                        placeHolder: 'Choose an action'
                    }
                );

                if (!action || action.value === 'cancel') {
                    return;
                }

                if (action.value === 'download') {
                    // Create a tree item wrapper to trigger the download command
                    const treeItem = new AwesomeCopilotTreeItem(
                        item.name,
                        vscode.TreeItemCollapsibleState.None,
                        'file',
                        item,
                        item.category,
                        item.repo
                    );

                    // Execute the download command
                    await vscode.commands.executeCommand('awesome-copilot.downloadItem', treeItem);
                    continueLoop = false; // Exit after download
                } else if (action.value === 'diff') {
                    await this.showDiff(item);
                    // After showing diff, loop back to menu (continueLoop stays true)
                }
            }
        } catch (error) {
            getLogger().error('Error handling update:', error);
            vscode.window.showErrorMessage(`Failed to handle update for ${item.name}: ${error}`);
        }
    }

    private async showDiff(item: CopilotItem): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            // Get the local file path
            const targetFolder = FOLDER_PATHS[item.category];
            const localFilePath = vscode.Uri.file(
                `${workspaceFolder.uri.fsPath}/${targetFolder}/${item.name}`
            );

            // Check if local file exists
            if (!fs.existsSync(localFilePath.fsPath)) {
                vscode.window.showWarningMessage(`Local file not found: ${item.name}. It may have been moved or deleted.`);
                return;
            }

            // Fetch the remote content
            const remoteContent = await this.githubService.getFileContent(item.file.download_url);

            // Create a virtual document for the remote content
            const remoteUri = vscode.Uri.parse(`copilot-remote:${item.name}`).with({
                query: Buffer.from(remoteContent).toString('base64')
            });

            // Register a text document provider for the remote content
            const providerDisposable = vscode.workspace.registerTextDocumentContentProvider(
                'copilot-remote',
                new RemoteContentProvider()
            );

            try {
                // Open diff view
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    localFilePath,
                    remoteUri,
                    `${item.name} (Local ↔ Remote Update)`,
                    { preview: true }
                );
            } finally {
                // Clean up the provider after giving time for the diff to load
                setTimeout(() => providerDisposable.dispose(), 5000);
            }
        } catch (error) {
            getLogger().error('Error showing diff:', error);
            vscode.window.showErrorMessage(`Failed to show diff for ${item.name}: ${error}`);
        }
    }

    getItem(id: string): CopilotItem | undefined {
        for (const repoData of this.repoItems.values()) {
            for (const items of repoData.values()) {
                const found = items.find(item => item.id === id);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }
}
