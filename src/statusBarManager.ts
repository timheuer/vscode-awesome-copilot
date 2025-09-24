import * as vscode from 'vscode';

/**
 * StatusBarManager handles displaying status messages in the VS Code status bar
 * instead of showing disruptive popup information messages for general status updates.
 */
export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private timeoutId: NodeJS.Timeout | undefined;

    constructor() {
        // Create status bar item with priority to position it appropriately
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'awesome-copilot.showStatusHistory';
    }

    /**
     * Show a status message in the status bar temporarily
     * @param message The message to display
     * @param duration How long to show the message in milliseconds (default: 5000ms)
     * @param icon Optional icon to show with the message
     */
    showStatus(message: string, duration: number = 5000, icon?: string): void {
        // Clear any existing timeout
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }

        // Set the status bar text and icon
        this.statusBarItem.text = `${icon ? `$(${icon}) ` : ''}${message}`;
        this.statusBarItem.show();

        // Auto-hide after specified duration
        this.timeoutId = setTimeout(() => {
            this.hide();
        }, duration);
    }

    /**
     * Show a success status message with a checkmark icon
     * @param message The success message to display
     * @param duration How long to show the message in milliseconds (default: 3000ms)
     */
    showSuccess(message: string, duration: number = 3000): void {
        this.showStatus(message, duration, 'check');
    }

    /**
     * Show an info status message with an info icon
     * @param message The info message to display
     * @param duration How long to show the message in milliseconds (default: 4000ms)
     */
    showInfo(message: string, duration: number = 4000): void {
        this.showStatus(message, duration, 'info');
    }

    /**
     * Show a warning status message with a warning icon
     * @param message The warning message to display
     * @param duration How long to show the message in milliseconds (default: 6000ms)
     */
    showWarning(message: string, duration: number = 6000): void {
        this.showStatus(message, duration, 'warning');
    }

    /**
     * Show a loading status message with a sync icon
     * @param message The loading message to display
     */
    showLoading(message: string): void {
        this.showStatus(message, 0, 'sync~spin'); // 0 duration means manual hide
    }

    /**
     * Hide the status bar item
     */
    hide(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        this.statusBarItem.hide();
    }

    /**
     * Set a persistent status that stays until manually changed
     * @param message The message to display persistently
     * @param icon Optional icon to show with the message
     */
    setPersistentStatus(message: string, icon?: string): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        this.statusBarItem.text = `${icon ? `$(${icon}) ` : ''}${message}`;
        this.statusBarItem.show();
    }

    /**
     * Dispose of the status bar item
     */
    dispose(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }
        this.statusBarItem.dispose();
    }
}