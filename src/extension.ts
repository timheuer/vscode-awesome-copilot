// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { AwesomeCopilotProvider, AwesomeCopilotTreeItem } from './treeProvider';
import { GitHubService } from './githubService';
import { CopilotPreviewProvider } from './previewProvider';
import { CopilotItem, FOLDER_PATHS, CopilotCategory } from './types';
import * as path from 'path';
import * as fs from 'fs';
import { RepoStorage } from './repoStorage';
import axios from 'axios';
import { getRepoUrl, getRepoApiContentsRoot, formatRepoDisplay } from './repoUtils';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	// Removed global TLS disabling for security. Enterprise instances must present valid certificates instead.

	// Register manage sources command (UI entry point)
	// Static imports for ESM/TS compatibility

	const manageSourcesDisposable = vscode.commands.registerCommand('awesome-copilot.manageSources', async () => {
		// Main quick pick menu
		let sources = await RepoStorage.getSources(context);
		while (true) {
			const pick = await vscode.window.showQuickPick([
				{ label: 'Add Repository', description: 'Add a new public GitHub repo as a source' },
				{ label: 'Remove Repository', description: 'Remove a repo from sources' },
				{ label: 'Reset to Default', description: 'Restore default source list' },
				{ label: 'View Sources', description: sources.map((s: any) => `${s.owner}/${s.repo}`).join(', ') },
				{ label: 'Done', description: 'Exit' }
			], { placeHolder: 'Manage Copilot Sources' });
			if (!pick || pick.label === 'Done') {break;}
			if (pick.label === 'Add Repository') {
				const input = await vscode.window.showInputBox({
					prompt: 'Enter GitHub repo (owner/repo or full URL)',
					validateInput: (val: string) => {
						if (!val || !val.trim()) {return 'Repository required';}
						return null;
					}
				});
				if (!input) {continue;}
				// Parse input - support GitHub Enterprise URLs
				let owner = '', repo = '', baseUrl = '';
				try {
					if (input.startsWith('http')) {
						// Enhanced URL parsing for enterprise GitHub
						const urlMatch = input.match(/https?:\/\/([^\/]+)\/(.+?)\/(.+?)(?:\/.*)?$/);
						if (urlMatch) {
							const domain = urlMatch[1];
							owner = urlMatch[2];
							repo = urlMatch[3].replace(/\.git$/, ''); // Remove .git suffix if present
							
							// If not github.com, it's GitHub Enterprise
							if (domain !== 'github.com') {
								baseUrl = `https://${domain}`;
							}
						} else {
							throw new Error('Invalid URL format');
						}
					} else if (input.includes('/')) {
						const parts = input.split('/').filter(p => p.trim());
						if (parts.length >= 2) {
							owner = parts[0].trim();
							repo = parts[1].trim().replace(/\.git$/, ''); // Remove .git suffix if present
						}
					}
				} catch (parseError) {
					console.error('URL parsing error:', parseError);
				}
				if (!owner || !repo) {
					vscode.window.showErrorMessage('Invalid repository format. Use owner/repo or full URL.');
					continue;
				}
				// Check for duplicate
				if (sources.some((s: any) => s.owner === owner && s.repo === repo)) {
					vscode.window.showWarningMessage('Repository already added.');
					continue;
				}
				// For enterprise GitHub, show info message
				if (baseUrl) {
					const enterpriseUrl = `${baseUrl}/${owner}/${repo}`;
					vscode.window.showInformationMessage(
						`🔐 Enterprise GitHub Detected: ${enterpriseUrl}\n\nPlease ensure you have configured your Personal Access Token using "Configure Enterprise Token" command.`
					);
				}

				// Validate repo structure (basic: check folders exist)
				try {
					const cats = ['chatmodes', 'instructions', 'prompts'];
					let valid = true;
					
					// Show progress for enterprise repos
					if (baseUrl) {
						vscode.window.showInformationMessage(`🔍 Validating repository structure for ${owner}/${repo}...`);
					}
					
					for (const cat of cats) {
						// Build correct API URL for GitHub or GitHub Enterprise
						let apiUrl: string;
						if (baseUrl) {
							apiUrl = `${baseUrl}/api/v3/repos/${owner}/${repo}/contents/${cat}`;
						} else {
							apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${cat}`;
						}
						
						const headers: Record<string, string> = {
							'User-Agent': 'VSCode-AwesomeCopilot-Extension',
							'Accept': 'application/vnd.github.v3+json'
						};
						
						if (baseUrl) {
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
							const config = vscode.workspace.getConfiguration('awesome-copilot');
							const enterpriseToken = config.get<string>('enterpriseToken');
							
							if (enterpriseToken) {
								headers['Authorization'] = `token ${enterpriseToken}`;
								console.log('🔑 Using configured enterprise GitHub token');
							} else {
								// Priority 2: Try VS Code's authentication provider
								try {
									const session = await vscode.authentication.getSession('github', [], { 
										createIfNone: false,
										silent: true 
									});
									if (session && session.accessToken) {
										headers['Authorization'] = `token ${session.accessToken}`;
										console.log('🔑 Using VS Code GitHub authentication');
									} else {
										console.log('📝 No authentication available - please configure enterprise token');
									}
								} catch (authError) {
									console.log('📝 VS Code GitHub auth not available - please configure enterprise token');
								}
							}
						}
						
						// (Removed custom HTTPS agent logic to avoid disabling TLS validation)
						if (baseUrl) {
							console.log('Enterprise GitHub detected:', baseUrl);
							console.log('API URL:', apiUrl);
						}
						
						const resp = await axios.get(apiUrl, { 
							headers: headers,
							timeout: 10000,
							withCredentials: !!baseUrl
						});
						if (!Array.isArray(resp.data)) { valid = false; break; }
					}
					if (!valid) {throw new Error('Missing required folders (chatmodes, instructions, prompts)');}
					
					// Create repo source object with baseUrl if needed
					const repoSource = baseUrl ? { owner, repo, baseUrl } : { owner, repo };
					sources.push(repoSource);
					await RepoStorage.setSources(context, sources);
					const displayUrl = getRepoUrl(repoSource as any);
					vscode.window.showInformationMessage(`✅ Successfully added: ${displayUrl}`);
					
				} catch (err: any) {
					// Enhanced error handling with detailed diagnostics
					const errorMessage = (err && err.message) || err;
					const statusCode = err.response?.status;
					const responseData = err.response?.data;
					
					console.error('Repository validation error:', {
						error: errorMessage,
						statusCode,
						responseData,
						owner,
						repo,
						baseUrl,
						apiUrl: getRepoApiContentsRoot({ owner, repo, baseUrl } as any)
					});
					
					if (statusCode === 404) {
						// 404 Not Found - Repository or path doesn't exist
						const repoUrl = getRepoUrl({ owner, repo, baseUrl } as any);
						const retryChoice = await vscode.window.showErrorMessage(
							`🔍 Repository Not Found (404)\n\nThe repository ${owner}/${repo} was not found or doesn't contain the required folders (chatmodes, instructions, prompts).\n\nPlease verify:\n1. Repository exists at: ${repoUrl}\n2. Repository is public or you have access\n3. Repository contains the required folder structure`,
							'Check Repository',
							'Retry',
							'Cancel'
						);
						
						if (retryChoice === 'Check Repository') {
							await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
						} else if (retryChoice === 'Retry') {
							continue;
						}
					} else if (baseUrl && (statusCode === 401 || errorMessage.includes('401') || errorMessage.includes('Unauthorized'))) {
						// Authentication error for enterprise GitHub
						const retryChoice = await vscode.window.showErrorMessage(
							`🔐 Authentication Required (401)\n\nFailed to access ${baseUrl}/${owner}/${repo}.\n\nPlease configure your Personal Access Token using "Configure Enterprise Token" command.`,
							'Configure Token',
							'Retry',
							'Cancel'
						);
						
						if (retryChoice === 'Configure Token') {
							// Run the token configuration command
							await vscode.commands.executeCommand('awesome-copilot.configureEnterpriseToken');
						} else if (retryChoice === 'Retry') {
							// Let user try again in the main loop
							continue;
						}
					} else if (statusCode === 403) {
						// Forbidden - Rate limit or access denied
						const retryChoice = await vscode.window.showErrorMessage(
							`🚫 Access Forbidden (403)\n\nAccess to ${owner}/${repo} is forbidden. This could be due to:\n1. Repository is private and you don't have access\n2. API rate limit exceeded\n3. Token doesn't have required permissions`,
							'Configure Token',
							'Retry',
							'Cancel'
						);
						
						if (retryChoice === 'Configure Token') {
							await vscode.commands.executeCommand('awesome-copilot.configureEnterpriseToken');
						} else if (retryChoice === 'Retry') {
							continue;
						}
					} else {
						// Other errors
						vscode.window.showErrorMessage(`❌ Failed to add repository: ${errorMessage}${statusCode ? ` (${statusCode})` : ''}`);
					}
				}
			} else if (pick.label === 'Remove Repository') {
				if (sources.length === 1) {
					vscode.window.showWarningMessage('At least one source is required.');
					continue;
				}
				const toRemove = await vscode.window.showQuickPick(
					sources.map((s: any) => ({ label: `${s.owner}/${s.repo}`, source: s })),
					{ placeHolder: 'Select a repo to remove' }
				);
				if (!toRemove) {continue;}
				
				// Clear cache for the repository being removed
				githubService.clearRepoCache(toRemove.source);
				
				sources = sources.filter((s: any) => `${s.owner}/${s.repo}` !== toRemove.label);
				await RepoStorage.setSources(context, sources);
				
				// Refresh the tree provider to update the UI
				treeProvider.refresh();
				
				vscode.window.showInformationMessage(`Removed source: ${toRemove.label}`);
			} else if (pick.label === 'Reset to Default') {
				// Clear all cache before resetting
				githubService.clearCache();
				
				sources = RepoStorage.getDefaultSources();
				await RepoStorage.setSources(context, sources);
				
				// Refresh the tree provider to update the UI
				treeProvider.refresh();
				
				vscode.window.showInformationMessage('Sources reset to default.');
			} else if (pick.label === 'View Sources') {
				vscode.window.showInformationMessage('Current sources: ' + sources.map((s: any) => `${s.owner}/${s.repo}`).join(', '));
			}
		}
	});

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "awesome-copilot" is now active!');

	// Initialize services
	const githubService = new GitHubService();
	const treeProvider = new AwesomeCopilotProvider(githubService, context);
	const previewProvider = new CopilotPreviewProvider();

	// Initialize repository sources from settings
	await RepoStorage.initializeFromSettings(context);

	// Listen for configuration changes
	const configChangeDisposable = RepoStorage.onConfigurationChanged(context, () => {
		// Refresh tree view when configuration changes
		treeProvider.refresh();
		vscode.window.showInformationMessage('Repository sources updated from settings');
	});

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

	// Register repository-specific commands
	const removeRepoDisposable = vscode.commands.registerCommand('awesome-copilot.removeRepo', async (treeItem: AwesomeCopilotTreeItem) => {
		if (treeItem.itemType === 'repo' && treeItem.repo) {
			const repo = treeItem.repo;
			const confirm = await vscode.window.showWarningMessage(
				`Remove repository ${repo.owner}/${repo.repo}?`,
				{ modal: true },
				'Remove'
			);
			
			if (confirm === 'Remove') {
				let sources = await RepoStorage.getSources(context);
				if (sources.length <= 1) {
					vscode.window.showWarningMessage('At least one repository source is required.');
					return;
				}
				
				// Clear cache for the repository being removed
				githubService.clearRepoCache(repo);
				
				sources = sources.filter(s => !(s.owner === repo.owner && s.repo === repo.repo));
				await RepoStorage.setSources(context, sources);
				treeProvider.refresh();
				vscode.window.showInformationMessage(`Removed repository: ${repo.owner}/${repo.repo}`);
			}
		}
	});

	const refreshRepoDisposable = vscode.commands.registerCommand('awesome-copilot.refreshRepo', async (treeItem: AwesomeCopilotTreeItem) => {
		if (treeItem.itemType === 'repo' && treeItem.repo) {
			const repo = treeItem.repo;
			// Clear cache for this repository
			githubService.clearCache();
			treeProvider.refresh();
			vscode.window.showInformationMessage(`Refreshed repository: ${repo.owner}/${repo.repo}`);
		}
	});

	// Register token configuration command
	const configTokenDisposable = vscode.commands.registerCommand('awesome-copilot.configureEnterpriseToken', async () => {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter your Enterprise GitHub Personal Access Token',
			password: true,
			placeHolder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value || value.trim() === '') {
					return 'Token cannot be empty';
				}
				const validPrefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']; // include newer GitHub token prefixes
				if (!validPrefixes.some(prefix => value.startsWith(prefix))) {
					return `Invalid token format. Expected one of: ${validPrefixes.join(', ')}`;
				}
				return null;
			}
		});
		
		if (token) {
			const config = vscode.workspace.getConfiguration('awesome-copilot');
			await config.update('enterpriseToken', token, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('🔑 Enterprise GitHub token configured successfully!');
		}
	});

	// Register clear token command
	const clearTokenDisposable = vscode.commands.registerCommand('awesome-copilot.clearEnterpriseToken', async () => {
		const confirm = await vscode.window.showWarningMessage(
			'Clear Enterprise GitHub token?',
			{ modal: true },
			'Clear'
		);
		
		if (confirm === 'Clear') {
			const config = vscode.workspace.getConfiguration('awesome-copilot');
			await config.update('enterpriseToken', undefined, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('Enterprise GitHub token cleared');
		}
	});

	// Register show configured repositories command
	const showReposDisposable = vscode.commands.registerCommand('awesome-copilot.showConfiguredRepos', async () => {
		const sources = await RepoStorage.getSources(context);
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		const enterpriseToken = config.get<string>('enterpriseToken');
		
		if (sources.length === 0) {
			vscode.window.showInformationMessage('No repositories configured');
			return;
		}
		
		const repoList = sources.map((repo: any, index: number) => formatRepoDisplay(repo, index)).join('\n\n');
		
		const authStatus = enterpriseToken ? '🔑 Enterprise Token: Configured' : '⚠️ Enterprise Token: Not configured';
		
		const message = `**Configured Repositories (${sources.length}):**\n\n${repoList}\n\n**Authentication:**\n${authStatus}`;
		
		const choice = await vscode.window.showInformationMessage(
			message,
			{ modal: true },
			'Open Settings',
			'Manage Sources',
			'OK'
		);
		
		if (choice === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'awesome-copilot.repositories');
		} else if (choice === 'Manage Sources') {
			await vscode.commands.executeCommand('awesome-copilot.manageSources');
		}
	});

	// Register tree view visibility commands
	const toggleTreeViewDisposable = vscode.commands.registerCommand('awesome-copilot.toggleTreeView', async () => {
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		const currentValue = config.get<boolean>('showTreeView', true);
		await config.update('showTreeView', !currentValue, vscode.ConfigurationTarget.Global);
		const newState = !currentValue ? 'shown' : 'hidden';
		vscode.window.showInformationMessage(`Awesome Copilot tree view ${newState}`);
	});

	const showTreeViewDisposable = vscode.commands.registerCommand('awesome-copilot.showTreeView', async () => {
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		await config.update('showTreeView', true, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage('Awesome Copilot tree view shown');
	});

	const hideTreeViewDisposable = vscode.commands.registerCommand('awesome-copilot.hideTreeView', async () => {
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		await config.update('showTreeView', false, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage('Awesome Copilot tree view hidden');
	});

	context.subscriptions.push(
		refreshDisposable,
		downloadDisposable,
		previewDisposable,
		manageSourcesDisposable,
		removeRepoDisposable,
		refreshRepoDisposable,
		configTokenDisposable,
		clearTokenDisposable,
		showReposDisposable,
		toggleTreeViewDisposable,
		showTreeViewDisposable,
		hideTreeViewDisposable,
		configChangeDisposable,
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
