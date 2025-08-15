import * as vscode from 'vscode';
import { GitHubService } from './githubService';
import { CopilotItem, CopilotCategory, CATEGORY_LABELS, GitHubFile } from './types';

export class AwesomeCopilotTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly copilotItem?: CopilotItem,
        public readonly category?: CopilotCategory
    ) {
        super(label, collapsibleState);
        
        if (copilotItem) {
            this.contextValue = 'copilotFile';
            this.resourceUri = vscode.Uri.parse(copilotItem.file.download_url);
            this.description = `${(copilotItem.file.size / 1024).toFixed(1)}KB`;
            this.tooltip = new vscode.MarkdownString(`**${copilotItem.name}**\n\nSize: ${this.description}\n\nClick to preview content`);
            
            // Set appropriate icon based on category
            switch (copilotItem.category) {
                case CopilotCategory.ChatModes:
                    this.iconPath = new vscode.ThemeIcon('comment-discussion');
                    break;
                case CopilotCategory.Instructions:
                    this.iconPath = new vscode.ThemeIcon('book');
                    break;
                case CopilotCategory.Prompts:
                    this.iconPath = new vscode.ThemeIcon('lightbulb');
                    break;
            }
        } else if (category) {
            this.contextValue = 'copilotCategory';
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}

export class AwesomeCopilotProvider implements vscode.TreeDataProvider<AwesomeCopilotTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AwesomeCopilotTreeItem | undefined | null | void> = new vscode.EventEmitter<AwesomeCopilotTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AwesomeCopilotTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private items: Map<CopilotCategory, CopilotItem[]> = new Map();
    private loading: Set<CopilotCategory> = new Set();
    
    constructor(private githubService: GitHubService) {}

    refresh(): void {
        this.items.clear();
        this._onDidChangeTreeData.fire();
        this.loadAllCategories(true);
    }

    getTreeItem(element: AwesomeCopilotTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AwesomeCopilotTreeItem): Promise<AwesomeCopilotTreeItem[]> {
        if (!element) {
            // Return root categories only
            return [
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.ChatModes],
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    CopilotCategory.ChatModes
                ),
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Instructions], 
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    CopilotCategory.Instructions
                ),
                new AwesomeCopilotTreeItem(
                    CATEGORY_LABELS[CopilotCategory.Prompts],
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    CopilotCategory.Prompts
                )
            ];
        }

        if (element.category) {
            // Return files for the category
            const items = await this.getItemsForCategory(element.category);
            
            return items.map(item => 
                new AwesomeCopilotTreeItem(
                    item.name,
                    vscode.TreeItemCollapsibleState.None,
                    item
                )
            );
        }

        return [];
    }

    private async getItemsForCategory(category: CopilotCategory): Promise<CopilotItem[]> {
        if (!this.items.has(category) && !this.loading.has(category)) {
            this.loading.add(category);
            try {
                const files = await this.githubService.getFiles(category);
                const items = files.map((file: GitHubFile) => ({
                    id: `${category}-${file.name}`,
                    name: file.name,
                    category,
                    file
                }));
                this.items.set(category, items);
                this._onDidChangeTreeData.fire();
            } catch (error) {
                console.error(`Failed to load ${category}:`, error);
                return [];
            } finally {
                this.loading.delete(category);
            }
        }
        return this.items.get(category) || [];
    }

    private async loadAllCategories(forceRefresh: boolean = false): Promise<void> {
        const categories = [CopilotCategory.ChatModes, CopilotCategory.Instructions, CopilotCategory.Prompts];
        
        for (const category of categories) {
            try {
                const files = await this.githubService.getFiles(category, forceRefresh);
                const items = files.map((file: GitHubFile) => ({
                    id: `${category}-${file.name}`,
                    name: file.name,
                    category,
                    file
                }));
                this.items.set(category, items);
            } catch (error) {
                console.error(`Failed to load ${category}:`, error);
            }
        }
        
        this._onDidChangeTreeData.fire();
    }

    getItem(id: string): CopilotItem | undefined {
        for (const items of this.items.values()) {
            const found = items.find(item => item.id === id);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
}