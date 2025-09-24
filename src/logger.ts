import * as vscode from 'vscode';
import { createLoggerWithConfigMonitoring, Logger } from '@timheuer/vscode-ext-logger';

// Global logger instance
let logger: Logger;

/**
 * Initialize the logger with configuration monitoring
 * @param context VS Code extension context
 */
export function initializeLogger(context: vscode.ExtensionContext): void {
    logger = createLoggerWithConfigMonitoring('Awesome Copilot', 'awesome-copilot', 'logLevel', 'info', true, context);
    
    // Add to context disposables for cleanup
    context.subscriptions.push(logger);
}

/**
 * Get the logger instance
 * @returns The logger instance
 * @throws Error if logger hasn't been initialized
 */
export function getLogger(): ReturnType<typeof createLoggerWithConfigMonitoring> {
    if (!logger) {
        throw new Error('Logger not initialized. Call initializeLogger() first.');
    }
    return logger;
}