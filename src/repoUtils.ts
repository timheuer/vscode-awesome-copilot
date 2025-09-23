import { RepoSource } from './types';

/**
 * Return a human-friendly base identification (owner/repo) regardless of enterprise/public.
 */
export function getRepoIdentifier(repo: RepoSource): string {
  return `${repo.owner}/${repo.repo}`;
}

/**
 * Build the canonical repository browsing URL.
 * Public GitHub: https://github.com/owner/repo
 * Enterprise: <baseUrl>/owner/repo (baseUrl should not end with slash)
 */
export function getRepoUrl(repo: RepoSource): string {
  if (repo.baseUrl) {
    const base = repo.baseUrl.replace(/\/$/, '');
    return `${base}/${repo.owner}/${repo.repo}`;
  }
  return `https://github.com/${repo.owner}/${repo.repo}`;
}

/**
 * Build the API base (used for diagnostics/logging) without category.
 * Enterprise: <baseUrl>/api/v3/repos/owner/repo/contents/
 * Public: https://api.github.com/repos/owner/repo/contents/
 */
export function getRepoApiContentsRoot(repo: RepoSource): string {
  if (repo.baseUrl) {
    const base = repo.baseUrl.replace(/\/$/, '');
    return `${base}/api/v3/repos/${repo.owner}/${repo.repo}/contents/`;
  }
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/`;
}

/**
 * Return a type tag for display: [Enterprise] or [GitHub.com]
 */
export function getRepoTypeTag(repo: RepoSource): string {
  return repo.baseUrl ? '[Enterprise]' : '[GitHub.com]';
}

/**
 * Preferred display label combining optional custom label and identifier.
 * If repo.label provided: "<label> (owner/repo)" else "owner/repo"
 */
export function formatRepoLabel(repo: RepoSource): string {
  const id = getRepoIdentifier(repo);
  return repo.label ? `${repo.label} (${id})` : id;
}

/**
 * Multi-line rich display block used in quick-picks or info messages.
 */
export function formatRepoDisplay(repo: RepoSource, index?: number): string {
  const hasIndex = typeof index === 'number' && !Number.isNaN(index);
  const lineIndex = hasIndex ? `${(index as number) + 1}. ` : '';
  const tag = getRepoTypeTag(repo);
  return `${lineIndex}${formatRepoLabel(repo)} ${tag}\n   ${getRepoUrl(repo)}`;
}
