export interface GistFile {
  filename: string;
  type: string;
  language: string;
  raw_url: string;
  size: number;
  content: string;
}

export interface Gist {
  id: string;
  description: string;
  public: boolean;
  created_at: string;
  updated_at: string;
  url: string;
  files: Record<string, GistFile>;
  history: GistCommit[];
  owner: {
    login: string;
    id: number;
  };
}

export interface GistCommit {
  url: string;
  version: string;
  committed_at: string;
  change_status: {
    total: number;
    additions: number;
    deletions: number;
  };
  user: {
    login: string;
    id: number;
  };
}

export interface CreateGistParams {
  description: string;
  public: boolean;
  files: Record<string, { content: string }>;
}

export interface UpdateGistParams {
  description?: string;
  files: Record<string, { content: string } | null>;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

export const GIST_DESCRIPTION = 'cloudbookmark-sync';
export const GIST_API_BASE = 'https://api.github.com';
