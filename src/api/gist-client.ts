import type {
  Gist,
  GistCommit,
  CreateGistParams,
  UpdateGistParams,
  GitHubUser,
  RateLimitInfo,
} from '@/types';
import { GIST_API_BASE, GIST_DESCRIPTION } from '@/types';

export class GistApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GistApiError';
  }
}

export class RateLimitExceededError extends Error {
  constructor(public resetAt: number) {
    super('GitHub API rate limit exceeded');
    this.name = 'RateLimitExceededError';
  }
}

export class GistApiClient {
  private token: string;
  private rateLimit: RateLimitInfo | null = null;

  constructor(token: string) {
    this.token = token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${GIST_API_BASE}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    this.updateRateLimit(response);

    if (response.status === 401) {
      throw new GistApiError(401, 'Invalid or expired token');
    }
    if (response.status === 403) {
      const remaining = parseInt(
        response.headers.get('x-ratelimit-remaining') || '0',
      );
      if (remaining === 0) {
        const reset = parseInt(
          response.headers.get('x-ratelimit-reset') || '0',
        );
        throw new RateLimitExceededError(reset * 1000);
      }
      throw new GistApiError(403, 'Forbidden');
    }
    if (!response.ok) {
      const body = await response.text();
      throw new GistApiError(
        response.status,
        `GitHub API error: ${response.status} - ${body}`,
      );
    }

    if (response.status === 204) return null as T;
    return response.json();
  }

  private updateRateLimit(response: Response): void {
    const limit = parseInt(response.headers.get('x-ratelimit-limit') || '0');
    const remaining = parseInt(
      response.headers.get('x-ratelimit-remaining') || '0',
    );
    const reset = parseInt(response.headers.get('x-ratelimit-reset') || '0');
    const used = parseInt(response.headers.get('x-ratelimit-used') || '0');
    if (limit > 0) {
      this.rateLimit = { limit, remaining, reset, used };
    }
  }

  getRateLimit(): RateLimitInfo | null {
    return this.rateLimit;
  }

  isRateLimitLow(): boolean {
    return this.rateLimit !== null && this.rateLimit.remaining < 100;
  }

  async getUser(): Promise<GitHubUser> {
    return this.request<GitHubUser>('/user');
  }

  async validateToken(): Promise<{ valid: boolean; hasGistScope: boolean }> {
    try {
      const response = await fetch(`${GIST_API_BASE}/user`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (!response.ok) return { valid: false, hasGistScope: false };
      const scopes = (
        response.headers.get('x-oauth-scopes')?.split(', ') || []
      ).map((s) => s.trim());
      return { valid: true, hasGistScope: scopes.includes('gist') };
    } catch {
      return { valid: false, hasGistScope: false };
    }
  }

  async findSyncGist(): Promise<Gist | null> {
    const gists = await this.request<Gist[]>('/gists?per_page=100');
    return gists.find((g) => g.description === GIST_DESCRIPTION) || null;
  }

  async createGist(params: CreateGistParams): Promise<Gist> {
    return this.request<Gist>('/gists', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getGist(gistId: string): Promise<Gist> {
    return this.request<Gist>(`/gists/${gistId}`);
  }

  async getGistVersion(gistId: string, sha: string): Promise<Gist> {
    return this.request<Gist>(`/gists/${gistId}/${sha}`);
  }

  async updateGist(gistId: string, params: UpdateGistParams): Promise<Gist> {
    return this.request<Gist>(`/gists/${gistId}`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    });
  }

  async getGistCommits(
    gistId: string,
    perPage = 10,
  ): Promise<GistCommit[]> {
    return this.request<GistCommit[]>(
      `/gists/${gistId}/commits?per_page=${perPage}`,
    );
  }

  async createSyncGist(
    bookmarksContent: string,
    metadataContent: string,
    deletedContent: string,
  ): Promise<Gist> {
    return this.createGist({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        'bookmarks.json': { content: bookmarksContent },
        'metadata.json': { content: metadataContent },
        'deleted.json': { content: deletedContent },
      },
    });
  }

  async updateSyncGist(
    gistId: string,
    bookmarksContent?: string,
    metadataContent?: string,
    deletedContent?: string,
  ): Promise<Gist> {
    const files: UpdateGistParams['files'] = {};
    if (bookmarksContent !== undefined) {
      files['bookmarks.json'] = { content: bookmarksContent };
    }
    if (metadataContent !== undefined) {
      files['metadata.json'] = { content: metadataContent };
    }
    if (deletedContent !== undefined) {
      files['deleted.json'] = { content: deletedContent };
    }
    return this.updateGist(gistId, { files });
  }
}
