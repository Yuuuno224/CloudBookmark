/**
 * GitHub 授权
 * ==========
 *
 * 两种方式，用户任选其一：
 *
 *  A. **填 Token**：去 GitHub 生成一个 Personal Access Token 粘贴进来。
 *     不用注册任何应用，最省事；缺点是那一长串容易复制不全。
 *
 *  B. **用 GitHub 账号授权**（OAuth 设备流程）：扩展给你一个 8 位短码，
 *     你把它填到 GitHub 的授权页面上，回来就自动登录了。不用复制长字符串。
 *     这种方式需要一个 OAuth App 的 client_id（公开信息，不是密钥）。
 *
 * ## 为什么"用 GitHub 账号授权"要用户自己建 OAuth App
 *
 * 因为常规的"点按钮跳转授权"在纯前端扩展里走不通：那种方式需要用
 * client_secret 去换 access_token，而扩展的代码是公开的，藏不住任何密钥。
 * GitHub 的**设备流程**专门为无后端的客户端设计，换 token 不需要密钥，
 * 只需要公开的 client_id。
 *
 * client_id 不是密钥，所以理论上可以内置一个大家共用的；但只有注册这个
 * OAuth App 的人才能拿到它。所以这里做成：没有就给出图文步骤，
 * 让用户一分钟自己建一个（免费）。
 */

import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { describeRemaining } from '@/features/auth/device-flow';
import type { DeviceAuthStart } from '@/features/auth/oauth';
import { sendRequest, type EnvInfo } from '@/platform/messaging';
import { Banner, Button, Card, Field, Pill, TextInput } from '../../shared/components';
import { useAction } from '../../shared/useStore';

/** 创建 OAuth App 的页面。 */
const NEW_OAUTH_APP_URL = 'https://github.com/settings/applications/new';
/** 查看/撤销已授权应用的页面。 */
const AUTHORIZED_APPS_URL = 'https://github.com/settings/applications';

export function AuthCard(props: { env: EnvInfo | null; onChanged: () => void | Promise<void> }) {
  const action = useAction();

  const [tokenInput, setTokenInput] = createSignal('');
  const [showToken, setShowToken] = createSignal(false);
  /** 用户正在输入框里改的 client_id；null 表示"还用已保存的那个"。 */
  const [clientIdDraft, setClientIdDraft] = createSignal<string | null>(null);

  const [flow, setFlow] = createSignal<DeviceAuthStart | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [deviceError, setDeviceError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /** 输入框里显示的 client_id：优先用用户改过的，否则用已保存的。 */
  const clientId = () => clientIdDraft() ?? props.env?.oauthClientId ?? '';
  const readyToAuthorize = () => clientId().trim().length > 0;

  const remaining = () => {
    const current = flow();
    if (!current) return 0;
    return Math.max(0, Math.round((current.expiresAt - now()) / 1000));
  };

  onMount(() => {
    // 倒计时（只用来显示"还剩几分钟"）
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      clearInterval(ticker);
      stopPolling();
    });
  });

  onMount(() => {
    // 界面刷新后，如果上次授权还没做完，接着显示
    void sendRequest({ type: 'auth:device-status' })
      .then((start) => {
        if (!start) return;
        setFlow(start);
        schedulePolling(start.interval);
      })
      .catch(() => undefined);
  });

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePolling(intervalSeconds: number) {
    stopPolling();
    // GitHub 要求两次请求之间至少间隔 interval 秒，这里再留一点余量
    pollTimer = setInterval(() => void checkOnce(), Math.max(5, intervalSeconds) * 1000 + 250);
  }

  async function checkOnce() {
    try {
      const result = await sendRequest({ type: 'auth:device-check' });
      switch (result.status) {
        case 'pending':
          setNow(Date.now());
          return;
        case 'slow_down':
          // GitHub 让我们放慢，按新间隔重新排
          schedulePolling(result.interval);
          return;
        case 'done':
          stopPolling();
          setFlow(null);
          setDeviceError(null);
          await props.onChanged();
          action.setNotice(
            result.expiring
              ? `授权成功${result.login ? `（@${result.login}）` : ''}。注意：这个 OAuth App 开启了令牌过期，8 小时后需要重新授权，建议在 App 设置里关掉。`
              : `授权成功${result.login ? `（@${result.login}）` : ''}，接下来就可以同步书签了。`,
          );
          return;
        case 'expired':
          stopPolling();
          setFlow(null);
          setDeviceError('验证码过期了，请重新点「开始授权」。');
          return;
        case 'denied':
          stopPolling();
          setFlow(null);
          setDeviceError('你在 GitHub 上取消了授权。');
          return;
        case 'idle':
          stopPolling();
          setFlow(null);
          return;
        case 'error':
          stopPolling();
          setFlow(null);
          setDeviceError(result.message);
          return;
      }
    } catch (error) {
      // 网络抖动就下次再问，不要打断整个流程
      console.warn('[CloudBookmark] 查询授权状态失败，稍后重试', error);
    }
  }

  // -------------------------------------------------------------------------
  // A. 填 Token
  // -------------------------------------------------------------------------

  const saveToken = () =>
    action.run(
      async () => {
        const token = tokenInput().trim();
        if (!token) throw new Error('请先粘贴 Token。');
        const { login } = await sendRequest({ type: 'token:save', token });
        setTokenInput('');
        await props.onChanged();
        return login;
      },
      { notice: 'Token 验证通过并已加密保存。' },
    );

  // -------------------------------------------------------------------------
  // B. 用 GitHub 授权
  // -------------------------------------------------------------------------

  const beginDeviceAuth = () =>
    action.run(async () => {
      setDeviceError(null);
      setCopied(false);
      const start = await sendRequest({
        type: 'auth:device-start',
        clientId: clientIdDraft() ?? undefined,
      });
      setClientIdDraft(null);
      setFlow(start);
      schedulePolling(start.interval);
      void copyCode(start.userCode);
      await props.onChanged(); // 让输入框里刚填的 client_id 变成"已保存"
      return start;
    });

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // 剪贴板可能因为权限或焦点问题失败；界面上会提示手动复制
      setCopied(false);
    }
  }

  const cancelDeviceAuth = () =>
    action.run(async () => {
      stopPolling();
      await sendRequest({ type: 'auth:device-cancel' });
      setFlow(null);
      setDeviceError(null);
    });

  const removeCredential = () =>
    action.run(
      async () => {
        await sendRequest({ type: 'token:remove' });
        await props.onChanged();
      },
      { notice: '已移除本机保存的凭据。' },
    );

  return (
    <Card
      title="GitHub 授权"
      hint="CloudBookmark 把书签存在你自己账号下的私有 Gist 里，所以需要先授权。两种方式任选一种，拿到的权限完全一样（都只有 gist）。"
    >
      {/* ---------------- 当前状态 ---------------- */}
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <Show when={props.env?.hasToken} fallback={<Pill tone="default">未配置</Pill>}>
          <Pill tone="success">已配置</Pill>
          <Show when={props.env?.login}>
            <span class="text-sm text-ink-soft">@{props.env!.login}</span>
          </Show>
          <Show when={props.env?.authMethod}>
            <span class="text-xs text-ink-faint">
              （{props.env!.authMethod === 'oauth' ? 'GitHub 授权' : '手动填写的 Token'}）
            </span>
          </Show>
        </Show>
      </div>

      {/* ---------------- 各种提示 ---------------- */}
      <div class="space-y-3">
        <Show when={props.env?.tokenExpiresAt}>
          <Banner tone="warn" title="这个授权会在 8 小时后失效">
            <p>
              你的 OAuth App 开启了「Expiring user tokens」。书签同步会因此每 8 小时掉线一次、
              需要重新授权。建议到 OAuth App 设置里把这一项关掉。
            </p>
          </Banner>
        </Show>
        <Show when={deviceError()}>
          <Banner tone="danger" title="授权没有完成">
            <p>{deviceError()}</p>
          </Banner>
        </Show>
        <Show when={action.error()}>
          <Banner tone="danger" title="操作失败">
            <p class="break-words">{action.error()}</p>
          </Banner>
        </Show>
        <Show when={action.notice()}>
          <Banner tone="success">
            <p>{action.notice()}</p>
          </Banner>
        </Show>
      </div>

      {/* ---------------- 授权进行中 ---------------- */}
      <Show when={flow()}>
        {(current) => (
          <div class="mt-4 rounded-lg border border-accent-line bg-accent-soft p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium text-accent-ink">在 GitHub 页面上填入下面的验证码</p>
                <p class="mt-0.5 text-xs leading-relaxed text-accent-ink">
                  {copied() ? '验证码已经复制到剪贴板，' : '请选中下面的验证码复制，'}
                  粘贴到 GitHub 页面的输入框里，然后点绿色的 Authorize 按钮。
                  {describeRemaining(remaining())}内有效。
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={cancelDeviceAuth} disabled={action.busy()}>
                取消
              </Button>
            </div>

            <div class="mt-3 flex flex-wrap items-center gap-3">
              <code class="select-all rounded-md border border-accent-line bg-surface px-4 py-2 font-mono text-xl font-bold tracking-widest text-ink">
                {current().userCode}
              </code>
              <Button size="sm" onClick={() => void copyCode(current().userCode)}>
                {copied() ? '已复制' : '复制验证码'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void chrome.tabs.create({
                    url: current().verificationUriComplete ?? current().verificationUri,
                  })
                }
              >
                打开 GitHub 授权页
              </Button>
            </div>

            <p class="mt-3 text-xs leading-relaxed text-accent-ink">
              授权完成后本页会自动继续，不需要再点别的东西。这个页面可以先放着不关。
            </p>
          </div>
        )}
      </Show>

      {/* ---------------- 方式 A ---------------- */}
      <div class="mt-4 rounded-lg border border-line p-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-ink">方式一：填一个 Token</h3>
          <Pill tone="default">不用注册任何应用</Pill>
        </div>

        <div class="mt-3 space-y-3">
          <Field
            label={props.env?.hasToken ? '更换 Token' : 'Personal Access Token'}
            hint="只需要 gist 权限。经典 Token 勾选 gist；细粒度 Token 选 Gists → Read and write。"
          >
            <div class="flex gap-2">
              <TextInput
                type={showToken() ? 'text' : 'password'}
                value={tokenInput()}
                onInput={setTokenInput}
                placeholder="ghp_… 或 github_pat_…"
                monospace
              />
              <Button
                variant="primary"
                onClick={saveToken}
                loading={action.busy()}
                disabled={!tokenInput().trim()}
              >
                验证并保存
              </Button>
            </div>
          </Field>

          <button
            type="button"
            class="text-xs text-ink-faint hover:text-ink-soft"
            onClick={() => setShowToken(!showToken())}
          >
            {showToken() ? '隐藏输入内容' : '显示输入内容'}
          </button>

          <details class="rounded-md bg-surface-raised p-3 text-xs leading-relaxed text-ink-soft">
            <summary class="cursor-pointer font-medium text-ink">怎么创建 Token</summary>
            <ol class="mt-2 list-decimal space-y-0.5 pl-4">
              <li>打开 GitHub → Settings → Developer settings → Personal access tokens</li>
              <li>选 Tokens (classic) → Generate new token</li>
              <li>
                只勾选 <code class="rounded bg-surface px-1">gist</code>，其它一律不勾
              </li>
              <li>生成后复制粘贴到上面的输入框</li>
            </ol>
            <p class="mt-2">
              提示：只勾一个权限是有意为之。万一 Token 泄露，别人也只能读写你的 Gist，
              动不了你的代码仓库。
            </p>
          </details>
        </div>
      </div>

      {/* ---------------- 方式 B ---------------- */}
      <div class="mt-4 rounded-lg border border-line p-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-ink">方式二：用 GitHub 账号授权</h3>
          <Pill tone="info">不用复制长字符串</Pill>
        </div>

        <div class="mt-3 space-y-3">
          <p class="text-xs leading-relaxed text-ink-soft">
            点「开始授权」后，扩展会给你一个 8 位验证码。把验证码填到 GitHub 的授权页面上，
            回来这里就自动登录了。
          </p>

          <Show when={!readyToAuthorize()}>
            <Banner tone="info" title="需要先准备一个 OAuth App 的 client_id">
              <p>client_id 是公开信息、不是密钥，可以放心填。免费创建一个只要一分钟：</p>
              <ol class="mt-1 list-decimal space-y-0.5 pl-4">
                <li>
                  打开{" "}
                  <button
                    type="button"
                    class="text-brand underline"
                    onClick={() => void chrome.tabs.create({ url: NEW_OAUTH_APP_URL })}
                  >
                    GitHub 新建 OAuth App 页面
                  </button>
                </li>
                <li>
                  Application name 随便填（比如 CloudBookmark），Homepage URL 填{" "}
                  <code class="rounded bg-surface px-1">https://github.com</code>
                </li>
                <li>
                  <strong>勾选 "Enable Device Flow"</strong>（很重要，不勾会一直报错）
                </li>
                <li>创建后把页面上的 Client ID 复制到下面的输入框</li>
              </ol>
            </Banner>
          </Show>

          <Field
            label="OAuth App 的 Client ID"
            hint="形如 Iv1.0123456789abcdef。点「开始授权」时会自动保存，以后不用再填。"
          >
            <TextInput
              value={clientId()}
              onInput={setClientIdDraft}
              placeholder="Iv1.xxxxxxxxxxxxxxxx"
              monospace
            />
          </Field>

          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={beginDeviceAuth}
              loading={action.busy()}
              disabled={!readyToAuthorize() || flow() !== null}
            >
              开始授权
            </Button>
            <Button variant="ghost" onClick={() => void chrome.tabs.create({ url: NEW_OAUTH_APP_URL })}>
              去创建 OAuth App
            </Button>
          </div>
        </div>
      </div>

      {/* ---------------- 移除凭据 ---------------- */}
      <Show when={props.env?.hasToken}>
        <div class="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <Button variant="ghost" onClick={removeCredential} disabled={action.busy()}>
            移除本机保存的凭据
          </Button>
          <button
            type="button"
            class="text-xs text-ink-faint hover:text-ink-soft"
            onClick={() => void chrome.tabs.create({ url: AUTHORIZED_APPS_URL })}
          >
            在 GitHub 上查看 / 撤销已授权的应用
          </button>
        </div>
      </Show>

      <p class="mt-3 text-xs leading-relaxed text-ink-faint">
        无论用哪种方式，凭据都会加密后存在本机，只在请求 GitHub 时使用，不会发给任何第三方。
      </p>
    </Card>
  );
}
