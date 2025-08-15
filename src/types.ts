/**
 * Types and interfaces for the Awesome Copilot Browser extension
 */

export interface GitHubFile {
    name: string;
    path: string;
    download_url: string;
    size: number;
    type: 'file' | 'dir';
}

export interface CopilotItem {
    id: string;
    name: string;
    category: CopilotCategory;
    file: GitHubFile;
    content?: string;
}

export enum CopilotCategory {
    ChatModes = 'chatmodes',
    Instructions = 'instructions', 
    Prompts = 'prompts'
}

export interface CacheEntry {
    data: GitHubFile[];
    timestamp: number;
    category: CopilotCategory;
}

export const CATEGORY_LABELS: Record<CopilotCategory, string> = {
    [CopilotCategory.ChatModes]: 'Chat Modes',
    [CopilotCategory.Instructions]: 'Instructions',
    [CopilotCategory.Prompts]: 'Prompts'
};

export const FOLDER_PATHS: Record<CopilotCategory, string> = {
    [CopilotCategory.ChatModes]: '.github/chatmodes',
    [CopilotCategory.Instructions]: '.github/instructions',
    [CopilotCategory.Prompts]: '.github/prompts'
};