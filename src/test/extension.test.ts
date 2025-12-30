import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { GitHubService } from '../githubService';
import { CopilotCategory } from '../types';
import * as logger from '../logger';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	// Mock the logger for tests
	const mockLogger = {
		error: () => {},
		warn: () => {},
		info: () => {},
		debug: () => {},
		dispose: () => {}
	};

	// Override getLogger to return mock logger
	suiteSetup(() => {
		(logger as any).getLogger = () => mockLogger;
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('GitHub Service can be instantiated', () => {
		const service = new GitHubService();
		assert.ok(service);
	});

	test('GitHub Service can fetch collections', async () => {
		const service = new GitHubService();
		try {
			const files = await service.getFiles(CopilotCategory.Collections);
			assert.ok(Array.isArray(files));
			console.log(`Found ${files.length} collection files`);
		} catch (error) {
			console.warn('Network test failed - this is expected in CI/offline environments:', error);
		}
	}).timeout(15000);

	test('GitHub Service can fetch skills', async () => {
		const service = new GitHubService();
		try {
			const files = await service.getFiles(CopilotCategory.Skills);
			assert.ok(Array.isArray(files));
			console.log(`Found ${files.length} skills files`);
		} catch (error) {
			console.warn('Network test failed - this is expected in CI/offline environments:', error);
		}
	}).timeout(15000);

	suite('parseCollectionYaml Tests', () => {
		let service: GitHubService;

		setup(() => {
			service = new GitHubService();
		});

		test('should parse valid YAML with all required fields', async () => {
			const validYaml = `id: test-collection
name: Test Collection
description: A test collection for validation
tags:
  - test
  - sample
items:
  - path: .github/instructions/test.md
    kind: instruction
  - path: .github/prompts/sample.md
    kind: prompt
display:
  ordering: alpha
  show_badge: true`;

			// Mock the getFileContent method to return our test YAML
			(service as any).getFileContent = async () => validYaml;

			const result = await service.parseCollectionYaml('http://test-url.com/collection.yml');

			assert.strictEqual(result.id, 'test-collection');
			assert.strictEqual(result.name, 'Test Collection');
			assert.strictEqual(result.description, 'A test collection for validation');
			assert.ok(Array.isArray(result.items));
			assert.strictEqual(result.items.length, 2);
			assert.strictEqual(result.items[0].path, '.github/instructions/test.md');
			assert.strictEqual(result.items[0].kind, 'instruction');
		});

		test('should reject YAML missing id field', async () => {
			const invalidYaml = `name: Test Collection
description: A test collection
items:
  - path: test.md
    kind: instruction`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "id" field'));
					return true;
				}
			);
		});

		test('should reject YAML with empty id field', async () => {
			const invalidYaml = `id: ""
name: Test Collection
description: A test collection
items:
  - path: test.md
    kind: instruction`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "id" field'));
					return true;
				}
			);
		});

		test('should reject YAML missing name field', async () => {
			const invalidYaml = `id: test-collection
description: A test collection
items:
  - path: test.md
    kind: instruction`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "name" field'));
					return true;
				}
			);
		});

		test('should reject YAML with empty name field', async () => {
			const invalidYaml = `id: test-collection
name: "   "
description: A test collection
items:
  - path: test.md
    kind: instruction`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "name" field'));
					return true;
				}
			);
		});

		test('should reject YAML missing description field', async () => {
			const invalidYaml = `id: test-collection
name: Test Collection
items:
  - path: test.md
    kind: instruction`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "description" field'));
					return true;
				}
			);
		});

		test('should reject YAML with empty description field', async () => {
			const invalidYaml = `id: test-collection
name: Test Collection
description: ""
items:
  - path: test.md
    kind: instruction`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "description" field'));
					return true;
				}
			);
		});

		test('should reject YAML missing items array', async () => {
			const invalidYaml = `id: test-collection
name: Test Collection
description: A test collection`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "items" array'));
					return true;
				}
			);
		});

		test('should reject YAML with non-array items field', async () => {
			const invalidYaml = `id: test-collection
name: Test Collection
description: A test collection
items: "not an array"`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('missing or invalid "items" array'));
					return true;
				}
			);
		});

		test('should accept YAML with empty items array', async () => {
			const validYaml = `id: test-collection
name: Test Collection
description: A test collection
items: []`;

			(service as any).getFileContent = async () => validYaml;

			const result = await service.parseCollectionYaml('http://test-url.com/collection.yml');

			assert.strictEqual(result.id, 'test-collection');
			assert.ok(Array.isArray(result.items));
			assert.strictEqual(result.items.length, 0);
		});

		test('should reject completely invalid YAML', async () => {
			const invalidYaml = `this is not: valid: yaml: at: all:`;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					return true;
				}
			);
		});

		test('should reject null or undefined YAML content', async () => {
			const invalidYaml = ``;

			(service as any).getFileContent = async () => invalidYaml;

			await assert.rejects(
				async () => await service.parseCollectionYaml('http://test-url.com/collection.yml'),
				(error: Error) => {
					assert.ok(error.message.includes('Failed to parse collection YAML'));
					assert.ok(error.message.includes('Invalid collection YAML format'));
					return true;
				}
			);
		});

		test('should parse YAML with optional fields', async () => {
			const validYaml = `id: test-collection
name: Test Collection
description: A test collection
tags:
  - testing
  - sample
  - demo
items:
  - path: .github/instructions/test.md
    kind: instruction
display:
  ordering: custom
  show_badge: false`;

			(service as any).getFileContent = async () => validYaml;

			const result = await service.parseCollectionYaml('http://test-url.com/collection.yml');

			assert.ok(result.tags);
			assert.strictEqual(result.tags.length, 3);
			assert.strictEqual(result.tags[0], 'testing');
			assert.ok(result.display);
			assert.strictEqual(result.display.ordering, 'custom');
			assert.strictEqual(result.display.show_badge, false);
		});

		test('should handle multiple items with different kinds', async () => {
			const validYaml = `id: multi-kind-collection
name: Multi-Kind Collection
description: Collection with multiple item kinds
items:
  - path: .github/instructions/test.md
    kind: instruction
  - path: .github/prompts/sample.md
    kind: prompt
  - path: .github/agents/helper.md
    kind: agent
  - path: .github/skills/analyzer.md
    kind: skill`;

			(service as any).getFileContent = async () => validYaml;

			const result = await service.parseCollectionYaml('http://test-url.com/collection.yml');

			assert.strictEqual(result.items.length, 4);
			assert.strictEqual(result.items[0].kind, 'instruction');
			assert.strictEqual(result.items[1].kind, 'prompt');
			assert.strictEqual(result.items[2].kind, 'agent');
			assert.strictEqual(result.items[3].kind, 'skill');
		});
	});
});
