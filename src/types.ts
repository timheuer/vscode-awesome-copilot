/**
 * Types and interfaces for the Awesome Copilot Browser extension
 */


// Represents a file in a GitHub repo
export interface GitHubFile {
    name: string;
    path: string;
    download_url: string;
    size: number;
    type: 'file' | 'dir';
    repo?: RepoSource; // Optional: which repo this file comes from
    displayName?: string; // For handling duplicate filenames across repos
}


// Represents a GitHub repo source
export interface RepoSource {
    owner: string;
    repo: string;
    label?: string;
    baseUrl?: string; // For GitHub Enterprise: https://github.wdf.sap.corp
}

export interface CopilotItem {
    id: string;
    name: string;
    category: CopilotCategory;
    file: GitHubFile;
    content?: string;
    repo: RepoSource;
}

export enum CopilotCategory {
    Collections = 'collections',
    Instructions = 'instructions',
    Prompts = 'prompts',
    Agents = 'agents',
    Skills = 'skills'
}


// Cache per repo+category
export interface CacheEntry {
    data: GitHubFile[];
    timestamp: number;
    category: CopilotCategory;
    repo: RepoSource;
}

export const CATEGORY_LABELS: Record<CopilotCategory, string> = {
    [CopilotCategory.Collections]: 'Collections',
    [CopilotCategory.Instructions]: 'Instructions',
    [CopilotCategory.Prompts]: 'Prompts',
    [CopilotCategory.Agents]: 'Agents',
    [CopilotCategory.Skills]: 'Skills'
};

export const FOLDER_PATHS: Record<CopilotCategory, string> = {
    [CopilotCategory.Collections]: '.github/collections',
    [CopilotCategory.Instructions]: '.github/instructions',
    [CopilotCategory.Prompts]: '.github/prompts',
    [CopilotCategory.Agents]: '.github/agents',
    [CopilotCategory.Skills]: '.github/skills'
};
