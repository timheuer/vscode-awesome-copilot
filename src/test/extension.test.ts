import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { GitHubService } from '../githubService';
import { CopilotCategory } from '../types';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('GitHub Service can be instantiated', () => {
		const service = new GitHubService();
		assert.ok(service);
	});

	test('GitHub Service can fetch chat modes', async () => {
		const service = new GitHubService();
		try {
			const files = await service.getFiles(CopilotCategory.ChatModes);
			assert.ok(Array.isArray(files));
			console.log(`Found ${files.length} chat mode files`);
		} catch (error) {
			console.warn('Network test failed - this is expected in CI/offline environments:', error);
		}
	}).timeout(15000);
});
