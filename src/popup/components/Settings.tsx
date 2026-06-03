import { createSignal, Show } from 'solid-js';
import { tokenManager } from '@/auth';
import { GistApiClient } from '@/api';

interface SettingsProps {
  onTokenSaved?: () => void;
}

export function Settings(props: SettingsProps) {
  const [token, setToken] = createSignal('');
  const [validating, setValidating] = createSignal(false);
  const [error, setError] = createSignal('');
  const [success, setSuccess] = createSignal(false);
  const [hasExisting, setHasExisting] = createSignal(false);

  const checkExisting = async () => {
    const has = await tokenManager.hasToken();
    setHasExisting(has);
  };
  checkExisting();

  const handleSave = async () => {
    const t = token().trim();
    if (!t) {
      setError('请输入 GitHub Personal Access Token');
      return;
    }

    setValidating(true);
    setError('');
    setSuccess(false);

    try {
      const api = new GistApiClient(t);
      const { valid, hasGistScope } = await api.validateToken();

      if (!valid) {
        setError('Token 无效或已过期');
        return;
      }
      if (!hasGistScope) {
        setError('Token 缺少 gist 权限，请重新创建并勾选 gist scope');
        return;
      }

      await tokenManager.saveToken(t);
      setSuccess(true);
      props.onTokenSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setValidating(false);
    }
  };

  const handleRemove = async () => {
    await tokenManager.removeToken();
    setHasExisting(false);
    setSuccess(false);
  };

  return (
    <div class="p-4 space-y-4">
      <div>
        <h2 class="text-base font-semibold text-gray-800 mb-2">GitHub Token 设置</h2>
        <p class="text-xs text-gray-500 mb-3">
          需要 GitHub Personal Access Token（仅需 gist 权限）用于同步书签数据到 Gist。
        </p>
      </div>

      <Show when={hasExisting()}>
        <div class="p-3 bg-green-50 border border-green-200 rounded-md">
          <p class="text-sm text-green-700">已配置 Token</p>
          <button
            onClick={handleRemove}
            class="mt-2 text-xs text-red-500 hover:text-red-700"
          >
            移除 Token
          </button>
        </div>
      </Show>

      <Show when={!hasExisting() || token()}>
        <div class="space-y-2">
          <label class="block text-sm font-medium text-gray-700">
            Personal Access Token
          </label>
          <input
            type="password"
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
            placeholder="ghp_xxxxxxxxxxxx"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p class="text-xs text-gray-400">
            创建路径：GitHub Settings → Developer settings → Personal access tokens → Tokens (classic) → 勾选 gist
          </p>
        </div>

        <Show when={error()}>
          <p class="text-sm text-red-500">{error()}</p>
        </Show>

        <Show when={success()}>
          <p class="text-sm text-green-500">Token 验证成功并已保存</p>
        </Show>

        <button
          onClick={handleSave}
          disabled={validating()}
          classList={{
            'w-full py-2 px-4 text-sm font-medium rounded-md transition': true,
            'bg-blue-500 text-white hover:bg-blue-600': !validating(),
            'bg-gray-300 text-gray-500 cursor-not-allowed': validating(),
          }}
        >
          {validating() ? '验证中...' : '保存并验证'}
        </button>
      </Show>
    </div>
  );
}
