import * as vscode from 'vscode';
import { CopilotItem } from './types';

export class CopilotPreviewProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    private items: Map<string, CopilotItem> = new Map();

    readonly onDidChange = this._onDidChange.event;

    setItem(uri: vscode.Uri, item: CopilotItem): void {
        this.items.set(uri.toString(), item);
        this._onDidChange.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const item = this.items.get(uri.toString());
        if (!item) {
            return 'Content not available';
        }

        const lines = item.content?.split('\n') || [];
        const preview = lines.slice(0, 15).join('\n');
        const truncated = lines.length > 15 ? '\n\n... (truncated, download to see full content)' : '';

        return `# ${item.name}

**Category:** ${item.category}
**Size:** ${(item.file.size / 1024).toFixed(1)}KB
**Source:** ${item.file.download_url}

---

${preview}${truncated}`;
    }
}