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
import { StatusBarManager } from './statusBarManager';
import axios from 'axios';
import * as https from 'https';
import { createLogger, createLoggerWithConfigMonitoring, Logger } from '@timheuer/vscode-ext-logger';
import { initializeLogger, getLogger } from './logger';

// Global logger instance
let logger: Logger;

// Create HTTPS agent with secure SSL handling - requires explicit user opt-in for insecure certificates
function createHttpsAgent(url: string, allowInsecureEnterpriseCerts: boolean = false): https.Agent | undefined {
	logger.debug('[createHttpsAgent] Called with:', { url, allowInsecureEnterpriseCerts });

	try {
		// If it's not github.com, treat as enterprise
		const isEnterprise = !url.includes('github.com');
		logger.debug('[createHttpsAgent] isEnterprise:', isEnterprise);

		if (isEnterprise && allowInsecureEnterpriseCerts) {
			logger.debug('[createHttpsAgent] Creating INSECURE agent for enterprise');
			// Only allow insecure certificates when explicitly enabled by user
			logger.warn('⚠️ SECURITY WARNING: Using insecure HTTPS agent for enterprise GitHub server (user-configured)');
			const agent = new https.Agent({
				rejectUnauthorized: false,
				// Allow self-signed certificates
				checkServerIdentity: () => undefined,
				// Keep connections alive
				keepAlive: true,
				maxSockets: 5
			});
			logger.debug('[createHttpsAgent] Insecure agent created successfully:', !!agent);
			return agent;
		} else if (isEnterprise) {
			logger.debug('[createHttpsAgent] Creating SECURE agent for enterprise');
			// For enterprise GitHub with secure certificates
			return new https.Agent({
				// Full certificate validation enabled
				rejectUnauthorized: true,
				// Keep connections alive
				keepAlive: true,
				maxSockets: 5
			});
		} else {
			logger.debug('[createHttpsAgent] Public GitHub detected, returning undefined (default agent)');
		}
	} catch (error) {
		logger.warn('[createHttpsAgent] Failed to create HTTPS agent, using default:', error);
	}

	logger.debug('[createHttpsAgent] Returning undefined (default secure agent)');
	return undefined;
}
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	// Initialize logger with configuration monitoring
	initializeLogger(context);
	logger = getLogger();

	// 🔒 Secure TLS handling - SSL verification enabled by default
	// Enterprise GitHub with self-signed certificates requires explicit user opt-in
	logger.info('Extension initialized with secure TLS handling (SSL verification enabled)');

	// Debug: Test configuration reading on startup
	const config = vscode.workspace.getConfiguration('awesome-copilot');
	const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);
	logger.debug('allowInsecureEnterpriseCerts setting:', allowInsecureEnterpriseCerts);
	logger.trace('Configuration inspection:', config.inspect('allowInsecureEnterpriseCerts'));

	// Register manage sources command (UI entry point)
	// Static imports for ESM/TS compatibility

	const manageSourcesDisposable = vscode.commands.registerCommand('awesome-copilot.manageSources', async () => {
		// Main quick pick menu
		let sources = RepoStorage.getSources(context);
		while (true) {
			const pick = await vscode.window.showQuickPick([
				{ label: 'Add Repository', description: 'Add a new public GitHub repo as a source' },
				{ label: 'Remove Repository', description: 'Remove a repo from sources' },
				{ label: 'Reset to Default', description: 'Restore default source list' },
				{ label: 'View Sources', description: sources.map((s: any) => `${s.owner}/${s.repo}`).join(', ') },
				{ label: 'Done', description: 'Exit' }
			], { placeHolder: 'Manage Copilot Sources' });
			if (!pick || pick.label === 'Done') { break; }
			if (pick.label === 'Add Repository') {
				const input = await vscode.window.showInputBox({
					prompt: 'Enter GitHub repo (owner/repo or full URL)',
					validateInput: (val: string) => {
						if (!val || !val.trim()) { return 'Repository required'; }
						return null;
					}
				});
				if (!input) { continue; }
				// Parse input - support GitHub Enterprise URLs
				let owner = '', repo = '', baseUrl = '';

				// Clean the input first
				const cleanInput = input.trim();
				logger.debug('Parsing input:', `"${cleanInput}"`);

				try {
					if (cleanInput.startsWith('http')) {
						// Enhanced URL parsing for enterprise GitHub
						const urlMatch = cleanInput.match(/^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)(?:\/.*)?$/);
						logger.debug('URL match result:', urlMatch);

						if (urlMatch) {
							const domain = urlMatch[1];
							owner = urlMatch[2];
							repo = urlMatch[3].replace(/\.git$/, ''); // Remove .git suffix if present

							logger.debug('Parsed URL - domain:', domain, 'owner:', owner, 'repo:', repo);

							// If not github.com, it's GitHub Enterprise
							if (domain !== 'github.com') {
								baseUrl = `https://${domain}`;
							}
						} else {
							throw new Error('Invalid URL format');
						}
					} else if (cleanInput.includes('/')) {
						const parts = cleanInput.split('/').filter(p => p.trim());
						logger.debug('Split parts:', parts);

						if (parts.length >= 2) {
							owner = parts[0].trim();
							repo = parts[1].trim().replace(/\.git$/, ''); // Remove .git suffix if present

							logger.debug('Parsed parts - owner:', owner, 'repo:', repo);
						}
					}
				} catch (parseError) {
					logger.error('URL parsing error:', parseError);
				}

				logger.debug('Final parsed values - owner:', owner, 'repo:', repo, 'baseUrl:', baseUrl);

				if (!owner || !repo) {
					vscode.window.showErrorMessage(`Invalid repository format. Use owner/repo or full URL. Parsed: owner="${owner}", repo="${repo}"`);
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

				// Validate repo structure (check that at least one content folder exists)
				try {
					const cats = ['chatmodes', 'instructions', 'prompts'];
					const foundFolders: string[] = [];
					const missingFolders: string[] = [];

					// Show progress for enterprise repos
					if (baseUrl) {
						statusBarManager.showLoading(`Validating repository structure for ${owner}/${repo}...`);
					}

					// Helper function to check if a folder exists
					const checkFolder = async (cat: string): Promise<boolean> => {
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
								logger.debug('🔑 Using configured enterprise GitHub token');
							} else {
								// Priority 2: Try VS Code's authentication provider
								try {
									const session = await vscode.authentication.getSession('github', [], {
										createIfNone: false,
										silent: true
									});
									if (session && session.accessToken) {
										headers['Authorization'] = `token ${session.accessToken}`;
										logger.debug('🔑 Using VS Code GitHub authentication');
									} else {
										logger.info('📝 No authentication available - please configure enterprise token');
									}
								} catch (authError) {
									logger.info('📝 VS Code GitHub auth not available - please configure enterprise token');
								}
							}
						}

						// Enhanced SSL handling with security configuration
						const config = vscode.workspace.getConfiguration('awesome-copilot');
						const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

						// Debug logging for SSL handling
						if (baseUrl) {
							logger.debug('Enterprise GitHub detected:', baseUrl);
							logger.debug('API URL:', apiUrl);
							logger.debug('Configuration check - allowInsecureEnterpriseCerts:', allowInsecureEnterpriseCerts);
							logger.trace('Configuration raw value:', config.get('allowInsecureEnterpriseCerts'));
							logger.trace('Full config inspection:', config.inspect('allowInsecureEnterpriseCerts'));
						}

						const httpsAgent = createHttpsAgent(apiUrl, allowInsecureEnterpriseCerts);

						// More debug logging for SSL handling
						if (baseUrl) {
							logger.debug('HTTPS Agent created:', !!httpsAgent);
							logger.debug('🔧 createHttpsAgent parameters:', {
								url: apiUrl,
								allowInsecureEnterpriseCerts: allowInsecureEnterpriseCerts,
								isEnterprise: !apiUrl.includes('github.com')
							});
							if (httpsAgent) {
								logger.debug('HTTPS Agent options:', {
									rejectUnauthorized: (httpsAgent as any).options?.rejectUnauthorized,
									checkServerIdentity: !!(httpsAgent as any).options?.checkServerIdentity
								});
							} else {
								logger.warn('❌ HTTPS Agent is undefined - checking createHttpsAgent logic');
							}
						}

						const axiosConfig: any = {
							headers: headers,
							timeout: 10000, // Increased timeout for enterprise
							// For enterprise GitHub, allow cookies for authentication
							withCredentials: !!baseUrl
						};

						// Apply SSL configuration for enterprise GitHub
						if (baseUrl) {
							if (httpsAgent) {
								axiosConfig.httpsAgent = httpsAgent;
								// Ensure axios uses the custom agent
								axiosConfig.agent = httpsAgent;
								logger.debug('✅ HTTPS Agent applied to axios config');
							} else {
								logger.debug('❌ No HTTPS Agent created - will use default (secure) TLS');
							}
						}


						try {
							let resp;
							if (baseUrl && allowInsecureEnterpriseCerts) {
								// Temporary global TLS override for this specific enterprise request
								logger.trace('🔧 [WORKAROUND] Applying global TLS override for enterprise GitHub request');
								const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
								process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

								try {
									resp = await axios.get(apiUrl, axiosConfig);
									logger.trace('🔧 [WORKAROUND] Enterprise request succeeded with global TLS override');
								} finally {
									// Restore original setting immediately
									if (originalRejectUnauthorized === undefined) {
										delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
									} else {
										process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
									}
									logger.trace('🔧 [WORKAROUND] TLS validation restored');
								}
							} else {
								resp = await axios.get(apiUrl, axiosConfig);
							}
							
							// Check if response contains valid directory content
							return Array.isArray(resp.data) && resp.data.length > 0;
						} catch (error: any) {
							// If 404, folder doesn't exist - that's okay for our flexible validation
							if (error.response?.status === 404) {
								return false;
							}
							// Re-throw other errors (auth, network, etc.)
							throw error;
						}
					};

					// Check each folder and track which ones exist
					for (const cat of cats) {
						const exists = await checkFolder(cat);
						if (exists) {
							foundFolders.push(cat);
						} else {
							missingFolders.push(cat);
						}
					}

					// Repository is valid if it has at least one content folder
					if (foundFolders.length === 0) {
						throw new Error(`Repository does not contain any of the required folders: ${cats.join(', ')}`);
					}

					// Create repo source object with baseUrl if needed
					const repoSource = baseUrl ? { owner, repo, baseUrl } : { owner, repo };
					sources.push(repoSource);
					await RepoStorage.setSources(context, sources);

					const displayUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `${owner}/${repo}`;
					
					// Create success message with found folders
					let successMessage = `✅ Successfully added: ${displayUrl}`;
					if (foundFolders.length > 0) {
						successMessage += `\n📁 Found folders: ${foundFolders.join(', ')}`;
						if (missingFolders.length > 0) {
							successMessage += `\n⚠️ Missing folders: ${missingFolders.join(', ')} (optional)`;
						}
					}
					
						statusBarManager.showSuccess(`✅ Successfully added: ${displayUrl}`);				} catch (err: any) {
					// Enhanced error handling with detailed diagnostics
					const errorMessage = (err && err.message) || err;
					const statusCode = err.response?.status;
					const responseData = err.response?.data;

					logger.error('Repository validation error:', {
						error: errorMessage,
						statusCode,
						responseData,
						owner,
						repo,
						baseUrl,
						input: input,
						apiUrl: baseUrl ? `${baseUrl}/api/v3/repos/${owner}/${repo}/contents/` : `https://api.github.com/repos/${owner}/${repo}/contents/`
					});

					if (statusCode === 404) {
						// 404 Not Found - Repository or path doesn't exist
						const repoUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `https://github.com/${owner}/${repo}`;

						// Debug the URL construction
						logger.error('404 Error URL construction debug:', {
							owner: `"${owner}"`,
							repo: `"${repo}"`,
							baseUrl: `"${baseUrl}"`,
							repoUrl: `"${repoUrl}"`,
							originalInput: `"${input}"`
						});

						const retryChoice = await vscode.window.showErrorMessage(
							`🔍 Repository Not Found or No Valid Content\n\nThe repository ${owner}/${repo} was not found or doesn't contain any of the required content folders (chatmodes, instructions, prompts).\n\nPlease verify:\n1. Repository exists at: ${repoUrl}\n2. Repository is public or you have access\n3. Repository contains at least one of: chatmodes, instructions, or prompts folders\n\nNote: A repository only needs to have ONE of these folders, not all of them.\n\nDebug: Input="${input}", Owner="${owner}", Repo="${repo}"`,
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
				if (!toRemove) { continue; }

				// Clear cache for the repository being removed
				githubService.clearRepoCache(toRemove.source);

				sources = sources.filter((s: any) => `${s.owner}/${s.repo}` !== toRemove.label);
				await RepoStorage.setSources(context, sources);

				// Refresh the tree provider to update the UI
				treeProvider.refresh();

				statusBarManager.showSuccess(`Removed source: ${toRemove.label}`);
			} else if (pick.label === 'Reset to Default') {
				// Clear all cache before resetting
				githubService.clearCache();

				sources = RepoStorage.getDefaultSources();
				await RepoStorage.setSources(context, sources);

				// Refresh the tree provider to update the UI
				treeProvider.refresh();

				statusBarManager.showSuccess('Sources reset to default');
			} else if (pick.label === 'View Sources') {
				statusBarManager.showInfo('Current sources: ' + sources.map((s: any) => `${s.owner}/${s.repo}`).join(', '), 8000);
			}
		}
	});

	// Initialize services
	const statusBarManager = new StatusBarManager();
	const githubService = new GitHubService(statusBarManager);
	const treeProvider = new AwesomeCopilotProvider(githubService, context);
	const previewProvider = new CopilotPreviewProvider();

	// Initialize repository sources from settings
	await RepoStorage.initializeFromSettings(context);

	// Listen for configuration changes
	const configChangeDisposable = RepoStorage.onConfigurationChanged(context, () => {
		// Refresh tree view when configuration changes
		treeProvider.refresh();
		statusBarManager.showInfo('Repository sources updated from settings');
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
		statusBarManager.showSuccess('Refreshed Awesome Copilot data');
	});

	// Register download command
	const downloadDisposable = vscode.commands.registerCommand('awesome-copilot.downloadItem', async (treeItem?: AwesomeCopilotTreeItem) => {
		if (!treeItem || !treeItem.copilotItem) {
			vscode.window.showErrorMessage('No file selected for download');
			return;
		}
		await downloadCopilotItem(treeItem.copilotItem, githubService);
	});

	// Register preview command
	const previewDisposable = vscode.commands.registerCommand('awesome-copilot.previewItem', async (treeItem?: AwesomeCopilotTreeItem) => {
		if (!treeItem || !treeItem.copilotItem) {
			vscode.window.showErrorMessage('No file selected for preview');
			return;
		}
		await previewCopilotItem(treeItem.copilotItem, githubService, previewProvider);
	});

	// Register repository-specific commands
	const removeRepoDisposable = vscode.commands.registerCommand('awesome-copilot.removeRepo', async (treeItem?: AwesomeCopilotTreeItem) => {
		// Validate that we have a tree item with the required properties
		if (!treeItem) {
			vscode.window.showErrorMessage('No repository selected for removal');
			return;
		}
		
		if (treeItem.itemType !== 'repo' || !treeItem.repo) {
			vscode.window.showErrorMessage('Invalid repository selection for removal');
			return;
		}

		const repo = treeItem.repo;
		const confirm = await vscode.window.showWarningMessage(
			`Remove repository ${repo.owner}/${repo.repo}?`,
			{ modal: true },
			'Remove'
		);

		if (confirm === 'Remove') {
			let sources = RepoStorage.getSources(context);
			if (sources.length <= 1) {
				vscode.window.showWarningMessage('At least one repository source is required.');
				return;
			}

			// Clear cache for the repository being removed
			githubService.clearRepoCache(repo);

			sources = sources.filter(s => !(s.owner === repo.owner && s.repo === repo.repo));
			await RepoStorage.setSources(context, sources);
			treeProvider.refresh();
			statusBarManager.showSuccess(`Removed repository: ${repo.owner}/${repo.repo}`);
		}
	});

	const refreshRepoDisposable = vscode.commands.registerCommand('awesome-copilot.refreshRepo', async (treeItem?: AwesomeCopilotTreeItem) => {
		// Validate that we have a tree item with the required properties
		if (!treeItem) {
			vscode.window.showErrorMessage('No repository selected for refresh');
			return;
		}
		
		if (treeItem.itemType !== 'repo' || !treeItem.repo) {
			vscode.window.showErrorMessage('Invalid repository selection for refresh');
			return;
		}

		const repo = treeItem.repo;
		// Clear cache for this specific repository only
		githubService.clearRepoCache(repo);
		// Refresh only this specific repository in the tree view
		treeProvider.refreshRepo(repo);
		statusBarManager.showSuccess(`Refreshed repository: ${repo.owner}/${repo.repo}`);
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
				if (!value.startsWith('ghp_') && !value.startsWith('gho_') && !value.startsWith('ghu_')) {
					return 'Invalid token format. GitHub tokens typically start with ghp_, gho_, or ghu_';
				}
				return null;
			}
		});

		if (token) {
			const config = vscode.workspace.getConfiguration('awesome-copilot');
			await config.update('enterpriseToken', token, vscode.ConfigurationTarget.Global);
			statusBarManager.showSuccess('Enterprise GitHub token configured successfully!');
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
			statusBarManager.showSuccess('Enterprise GitHub token cleared');
		}
	});


	// Register tree view visibility commands
	const toggleTreeViewDisposable = vscode.commands.registerCommand('awesome-copilot.toggleTreeView', async () => {
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		const currentValue = config.get<boolean>('showTreeView', true);
		await config.update('showTreeView', !currentValue, vscode.ConfigurationTarget.Global);
		const newState = !currentValue ? 'shown' : 'hidden';
		statusBarManager.showInfo(`Awesome Copilot tree view ${newState}`);
	});

	const showTreeViewDisposable = vscode.commands.registerCommand('awesome-copilot.showTreeView', async () => {
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		await config.update('showTreeView', true, vscode.ConfigurationTarget.Global);
		statusBarManager.showInfo('Awesome Copilot tree view shown');
	});

	const hideTreeViewDisposable = vscode.commands.registerCommand('awesome-copilot.hideTreeView', async () => {
		const config = vscode.workspace.getConfiguration('awesome-copilot');
		await config.update('showTreeView', false, vscode.ConfigurationTarget.Global);
		statusBarManager.showInfo('Awesome Copilot tree view hidden');
	});

	// Register GitHub authentication commands
	const signInToGitHubDisposable = vscode.commands.registerCommand('awesome-copilot.signInToGitHub', async () => {
		try {
			const session = await vscode.authentication.getSession('github', ['repo'], {
				createIfNone: true
			});

			if (session) {
				statusBarManager.showSuccess(`Signed in to GitHub as ${session.account.label}. Rate limit increased to 5,000 requests/hour!`);
				// Clear cache to refresh with authenticated requests
				githubService.clearCache();
				treeProvider.refresh();
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to sign in to GitHub: ${error}`);
		}
	});

	const signOutFromGitHubDisposable = vscode.commands.registerCommand('awesome-copilot.signOutFromGitHub', async () => {
		try {
			// Try to get current session
			const session = await vscode.authentication.getSession('github', ['repo'], {
				createIfNone: false,
				silent: true
			});

			if (session) {
				const confirm = await vscode.window.showWarningMessage(
					`Sign out from GitHub? This will reduce your API rate limit from 5,000 to 60 requests per hour.`,
					{ modal: true },
					'Sign Out'
				);

				if (confirm === 'Sign Out') {
					// Note: VS Code doesn't provide a direct way to sign out from a specific provider
					// The user needs to sign out through VS Code's account management
					await vscode.commands.executeCommand('workbench.action.showAccountsManagement');
					statusBarManager.showInfo('Please sign out from GitHub using the account management panel');
				}
			} else {
				statusBarManager.showInfo('Not currently signed in to GitHub');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Error checking GitHub authentication: ${error}`);
		}
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
		toggleTreeViewDisposable,
		showTreeViewDisposable,
		hideTreeViewDisposable,
		signInToGitHubDisposable,
		signOutFromGitHubDisposable,
		configChangeDisposable,
		treeView,
		previewProviderDisposable,
		statusBarManager
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
export function deactivate() { }
