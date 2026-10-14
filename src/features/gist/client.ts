/**
 * GitHub Gist API 客户端
 * ======================
 *
 * 只做三件事：发请求、把 HTTP 状态码翻译成人能看懂的错误、记录速率限制。
 * 业务逻辑（该不该合并、该不该上传）不在这里。
 *
 * 关于跨域：Manifest V3 里扩展页面请求外部域名，必须在 manifest 的
 * `host_permissions` 里声明，否则请求会被浏览器拦掉。
 * 这一条原版漏了，所以 API 调用在某些环境下会直接失败。
 */

import { AppError } from '@/core/types';
import type { Gist, GistFilePayload, GitHubUser, RateLimitInfo, TokenCheck } from './types';

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;

export class GistClient {
  #token: string;
  #rateLimit: RateLimitInfo | null = null;

  constructor(token: string) {
    this.#token = token;
  }

  setToken(token: string): void {
    this.#token = token;
  }

  get rateLimit(): RateLimitInfo | null {
    return this.#rateLimit;
  }

  // -------------------------------------------------------------------------
  // 底层请求
  // -------------------------------------------------------------------------

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? '请求超时' : '网络请求失败';
      throw new AppError('network', `${reason}，请检查网络或代理设置。`, error instanceof Error ? error.message : undefined);
    } finally {
      clearTimeout(timer);
    }

    this.#rememberRateLimit(response);

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    throw await this.#toError(response);
  }

  #rememberRateLimit(response: Response): void {
    const limit = Number.parseInt(response.headers.get('x-ratelimit-limit') ?? '', 10);
    const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10);
    const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10);
    if (Number.isFinite(limit) && limit > 0) {
      this.#rateLimit = {
        limit,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        resetAt: Number.isFinite(reset) ? reset * 1000 : Date.now(),
      };
    }
  }

  async #toError(response: Response): Promise<AppError> {
    const body = await response.text().catch(() => '');
    const detail = body.slice(0, 500);

    if (response.status === 401) {
      return new AppError('token-invalid', 'Token 无效或已被撤销，请到设置页重新填写。', detail);
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = this.#rateLimit?.remaining ?? 0;
      if (remaining === 0) {
        const minutes = this.#rateLimit ? Math.max(1, Math.ceil((this.#rateLimit.resetAt - Date.now()) / 60000)) : 60;
        return new AppError('rate-limited', `已触发 GitHub 接口次数限制，请约 ${minutes} 分钟后再试。`, detail);
      }
      return new AppError('forbidden', 'Token 权限不足。请确认 Token 勾选了 gist 权限。', detail);
    }
    if (response.status === 404) {
      return new AppError('gist-missing', '这个 Gist 不存在或已被删除。', detail);
    }
    if (response.status === 413 || response.status === 422) {
      return new AppError('payload-rejected', 'GitHub 拒绝了这次写入，通常是因为书签数据太大（超过单个文件上限）。', detail);
    }
    if (response.status >= 500) {
      return new AppError('github-error', 'GitHub 服务暂时不可用，请稍后再试。', detail);
    }
    return new AppError('github-error', `GitHub 返回了 ${response.status} 错误。`, detail);
  }

  // -------------------------------------------------------------------------
  // 账号与权限
  // -------------------------------------------------------------------------

  async getUser(): Promise<GitHubUser> {
    return this.#request<GitHubUser>('/user');
  }

  /**
   * 验证 Token 是否可用、有没有 gist 权限。
   *
   * 注意：细粒度 Token（fine-grained）**不会**返回 x-oauth-scopes 头，
   * 这种情况下不能因为"没有 gist scope"就判定失败，只能靠实际能不能读写 Gist。
   */
  async checkToken(): Promise<TokenCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}/user`, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      this.#rememberRateLimit(response);

      if (response.status === 401) {
        return { valid: false, login: null, scopes: [], hasGistScope: false };
      }
      if (!response.ok) {
        // 403 也可能是速率限制，但对"验证 Token"这个动作来说，能连上就算有效
        const scopesHeader = response.headers.get('x-oauth-scopes');
        return {
          valid: response.status !== 401,
          login: null,
          scopes: scopesHeader ? scopesHeader.split(',').map((scope) => scope.trim()).filter(Boolean) : [],
          hasGistScope: scopesHeader ? scopesHeader.includes('gist') : true,
        };
      }

      const user = (await response.json()) as GitHubUser;
      const scopesHeader = response.headers.get('x-oauth-scopes');
      if (!scopesHeader) {
        // 细粒度 Token：没有 scope 头，默认认为权限没问题（真不行会在创建 Gist 时报错）
        return { valid: true, login: user.login, scopes: [], hasGistScope: true };
      }
      const scopes = scopesHeader.split(',').map((scope) => scope.trim()).filter(Boolean);
      return { valid: true, login: user.login, scopes, hasGistScope: scopes.includes('gist') };
    } catch {
      return { valid: false, login: null, scopes: [], hasGistScope: false };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Gist 读写
  // -------------------------------------------------------------------------

  async listGists(page = 1, perPage = 100): Promise<Gist[]> {
    return this.#request<Gist[]>(`/gists?per_page=${perPage}&page=${page}`);
  }

  async getGist(gistId: string): Promise<Gist> {
    return this.#request<Gist>(`/gists/${gistId}`);
  }

  async createGist(params: {
    description: string;
    public: boolean;
    files: Record<string, GistFilePayload>;
  }): Promise<Gist> {
    return this.#request<Gist>('/gists', { method: 'POST', body: JSON.stringify(params) });
  }

  async updateGist(gistId: string, files: Record<string, GistFilePayload>): Promise<Gist> {
    return this.#request<Gist>(`/gists/${gistId}`, {
      method: 'PATCH',
      body: JSON.stringify({ files }),
    });
  }

  async deleteGist(gistId: string): Promise<void> {
    await this.#request<void>(`/gists/${gistId}`, { method: 'DELETE' });
  }

  /** 当文件被截断时，去 raw_url 取全文。 */
  async fetchRaw(rawUrl: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#token}` },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new AppError('raw-fetch-failed', `读取 Gist 原文件失败（${response.status}）。`);
      }
      return await response.text();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('network', '读取 Gist 原文件失败，请检查网络。', error instanceof Error ? error.message : undefined);
    } finally {
      clearTimeout(timer);
    }
  }
}
