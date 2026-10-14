/** GitHub Gist API 的数据结构（只声明我们真正用到的字段）。 */

export interface GistFile {
  filename: string;
  type?: string;
  language?: string | null;
  raw_url: string;
  size: number;
  /** GitHub 对超过约 1MB 的文件会截断 content，此时要改用 raw_url 取全文。 */
  truncated?: boolean;
  content?: string;
}

export interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  created_at: string;
  updated_at: string;
  html_url: string;
  files: Record<string, GistFile>;
  history?: Array<{ version: string; committed_at: string }>;
  owner?: { login: string } | null;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
}

export interface TokenCheck {
  valid: boolean;
  login: string | null;
  scopes: string[];
  hasGistScope: boolean;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  /** 重置时间（毫秒时间戳）。 */
  resetAt: number;
}

export interface GistFilePayload {
  content: string;
}
