import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CopilotItem, RepoSource } from './types';
import { getLogger } from './logger';

const DOWNLOADS_STORAGE_KEY = 'awesomeCopilot.downloads';

export interface DownloadMetadata {
    itemId: string;
    itemName: string;
    category: string;
    repoOwner: string;
    repoName: string;
    repoBaseUrl?: string;
    downloadTimestamp: number;
    sha: string;
    size: number;
    downloadUrl: string;
}

export class DownloadTracker {
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Record a download when an item is downloaded
     */
    async recordDownload(item: CopilotItem, content?: string): Promise<void> {
        try {
            const downloads = this.getDownloads();
            
            // Calculate SHA hash from content if provided, or use file SHA from GitHub
            let sha: string;
            if (content) {
                sha = crypto.createHash('sha256').update(content).digest('hex');
            } else {
                // Use the file's SHA from GitHub metadata if available
                sha = (item.file as any).sha || '';
            }

            const metadata: DownloadMetadata = {
                itemId: item.id,
                itemName: item.name,
                category: item.category,
                repoOwner: item.repo.owner,
                repoName: item.repo.repo,
                repoBaseUrl: item.repo.baseUrl,
                downloadTimestamp: Date.now(),
                sha: sha,
                size: item.file.size,
                downloadUrl: item.file.download_url
            };

            // Store or update the download metadata
            downloads[item.id] = metadata;
            
            await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, downloads);
            
            getLogger().debug('Recorded download:', { itemId: item.id, itemName: item.name });
        } catch (error) {
            getLogger().error('Failed to record download:', error);
        }
    }

    /**
     * Get all recorded downloads
     */
    getDownloads(): Record<string, DownloadMetadata> {
        return this.context.globalState.get<Record<string, DownloadMetadata>>(DOWNLOADS_STORAGE_KEY) || {};
    }

    /**
     * Check if an item has been downloaded
     */
    isDownloaded(itemId: string): boolean {
        const downloads = this.getDownloads();
        return itemId in downloads;
    }

    /**
     * Get download metadata for an item
     */
    getDownloadMetadata(itemId: string): DownloadMetadata | undefined {
        const downloads = this.getDownloads();
        return downloads[itemId];
    }

    /**
     * Check if a downloaded item has updates available
     * Returns true if the remote file has changed (different SHA or size)
     */
    hasUpdate(item: CopilotItem): boolean {
        const metadata = this.getDownloadMetadata(item.id);
        if (!metadata) {
            return false; // Not downloaded, so no update to check
        }

        // Compare SHA if available from GitHub metadata
        const remoteSha = (item.file as any).sha;
        if (remoteSha && metadata.sha && remoteSha !== metadata.sha) {
            return true;
        }

        // Compare size as a fallback
        if (item.file.size !== metadata.size) {
            return true;
        }

        return false;
    }

    /**
     * Find all items that have updates available
     */
    findItemsWithUpdates(allItems: CopilotItem[]): CopilotItem[] {
        const itemsWithUpdates: CopilotItem[] = [];
        
        for (const item of allItems) {
            if (this.hasUpdate(item)) {
                itemsWithUpdates.push(item);
            }
        }

        return itemsWithUpdates;
    }

    /**
     * Remove a download record (e.g., when user manually deletes the file)
     */
    async removeDownload(itemId: string): Promise<void> {
        try {
            const downloads = this.getDownloads();
            delete downloads[itemId];
            await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, downloads);
            getLogger().debug('Removed download record:', itemId);
        } catch (error) {
            getLogger().error('Failed to remove download record:', error);
        }
    }

    /**
     * Clear all download records
     */
    async clearAllDownloads(): Promise<void> {
        try {
            await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, {});
            getLogger().info('Cleared all download records');
        } catch (error) {
            getLogger().error('Failed to clear download records:', error);
        }
    }
}
