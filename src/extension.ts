// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { AwesomeCopilotProvider, AwesomeCopilotTreeItem } from './treeProvider';
import { GitHubService } from './githubService';
import { CopilotPreviewProvider } from './previewProvider';
import { CopilotItem, FOLDER_PATHS, CopilotCategory } from './types';
import * as path from 'path';
import * as fs from 'fs';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "awesome-copilot" is now active!');

	// Initialize services
	const githubService = new GitHubService();
	const treeProvider = new AwesomeCopilotProvider(githubService);
	const previewProvider = new CopilotPreviewProvider();

	// Register providers
	const treeView = vscode.window.createTreeView('awesomeCopilotExplorer', {
		treeDataProvider: treeProvider,
		showCollapseAll: true
	});

	// Auto-preview when selecting a file
	treeView.onDidChangeSelection(async (e) => {
		if (e.selection.length > 0) {
			const selectedItem = e.selection[0];
			if (selectedItem.copilotItem) {
				await previewCopilotItem(selectedItem.copilotItem, githubService, previewProvider);
			}
		}
	});

	const previewProviderDisposable = vscode.workspace.registerTextDocumentContentProvider('copilot-preview', previewProvider);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json

	// Register refresh command
	const refreshDisposable = vscode.commands.registerCommand('awesome-copilot.refreshAwesomeCopilot', () => {
		treeProvider.refresh();
		vscode.window.showInformationMessage('Refreshed Awesome Copilot data');
	});

	// Register download command
	const downloadDisposable = vscode.commands.registerCommand('awesome-copilot.downloadItem', async (treeItem: AwesomeCopilotTreeItem) => {
		if (treeItem.copilotItem) {
			await downloadCopilotItem(treeItem.copilotItem, githubService);
		}
	});

	// Register preview command
	const previewDisposable = vscode.commands.registerCommand('awesome-copilot.previewItem', async (treeItem: AwesomeCopilotTreeItem) => {
		if (treeItem.copilotItem) {
			await previewCopilotItem(treeItem.copilotItem, githubService, previewProvider);
		}
	});

	context.subscriptions.push(
		refreshDisposable,
		downloadDisposable,
		previewDisposable,
		treeView,
		previewProviderDisposable
	);
}

async function downloadCopilotItem(item: CopilotItem, githubService: GitHubService): Promise<void> {
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

		// Get target folder path
		const targetFolder = FOLDER_PATHS[item.category];
		const fullTargetPath = path.join(workspaceFolder.uri.fsPath, targetFolder);

		// Show input box for filename confirmation
		const filename = await vscode.window.showInputBox({
			prompt: `Download ${item.name} to ${targetFolder}`,
			value: item.name,
			validateInput: (value) => {
				if (!value || value.trim() === '') {
					return 'Filename cannot be empty';
				}
				return null;
			}
		});

		if (!filename) {
			return; // User cancelled
		}

		const targetFilePath = path.join(fullTargetPath, filename);

		// Check if file exists
		if (fs.existsSync(targetFilePath)) {
			const overwrite = await vscode.window.showWarningMessage(
				`File ${filename} already exists. Do you want to overwrite it?`,
				'Overwrite', 'Cancel'
			);
			
			if (overwrite !== 'Overwrite') {
				return;
			}
		}

		// Create directory if it doesn't exist
		if (!fs.existsSync(fullTargetPath)) {
			fs.mkdirSync(fullTargetPath, { recursive: true });
		}

		// Fetch content and save file
		const content = await githubService.getFileContent(item.file.download_url);
		fs.writeFileSync(targetFilePath, content, 'utf8');

		// Show success message and offer to open file
		const openFile = await vscode.window.showInformationMessage(
			`Successfully downloaded ${filename}`,
			'Open File'
		);

		if (openFile === 'Open File') {
			const document = await vscode.workspace.openTextDocument(targetFilePath);
			await vscode.window.showTextDocument(document);
		}

	} catch (error) {
		vscode.window.showErrorMessage(`Failed to download ${item.name}: ${error}`);
	}
}

async function previewCopilotItem(item: CopilotItem, githubService: GitHubService, previewProvider: CopilotPreviewProvider): Promise<void> {
	try {
		// Fetch content if not already cached
		if (!item.content) {
			item.content = await githubService.getFileContent(item.file.download_url);
		}

		// Create and show preview document
		const previewUri = vscode.Uri.parse(`copilot-preview:${encodeURIComponent(item.name)}`);
		
		// Set the item content in the preview provider
		previewProvider.setItem(previewUri, item);
		
		const doc = await vscode.workspace.openTextDocument(previewUri);
		await vscode.window.showTextDocument(doc, { preview: true });

	} catch (error) {
		vscode.window.showErrorMessage(`Failed to preview ${item.name}: ${error}`);
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}
