/**
 * GitHub 设备授权流程（OAuth Device Flow）
 * ========================================
 *
 * ## 这是干什么的
 *
 * 它让用户**不用手动复制粘贴 Token**：
 *
 *   1. 扩展向 GitHub 要一个"设备码"，同时拿到一个短码（形如 `WDJB-MJHT`）
 *   2. 用户打开 GitHub 的授权页，把短码填进去，点同意
 *   3. 扩展每隔几秒问一次 GitHub"用户同意了没"，同意后拿到 access_token
 *
 * ## 为什么是"设备流程"而不是常见的"点按钮跳转授权"
 *
 * 常见的 OAuth 授权码流程（跳转 → GitHub 回调 → 拿 code 换 token）在
 * **没有后端服务器**的扩展里走不通：用 code 换 token 那一步需要
 * client_secret，而扩展的代码是公开的，藏不住任何密钥。
 *
 * 设备流程是 GitHub 专门为命令行工具、无后端客户端设计的：
 * **换 token 不需要 client_secret**，只需要公开的 client_id。
 * 所以它是纯前端扩展唯一能安全实现的方式。
 *
 * ## 这个文件刻意不碰 chrome.*
 *
 * 网络请求通过 `transport` 注入，等待通过 `sleep` 注入，
 * 所以整个轮询状态机可以用单元测试把每种分支都跑一遍
 * （见 tests/auth.device-flow.test.ts）。
 */

/** GitHub 的设备授权页（官方文档里的固定地址）。 */
export const DEVICE_VERIFICATION_URL = 'https://github.com/login/device';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** 轮询间隔的下限，GitHub 要求不低于 5 秒。 */
const MIN_INTERVAL_SECONDS = 5;
/** 收到 slow_down 时额外增加的秒数（RFC 8628 的规定）。 */
const SLOW_DOWN_STEP_SECONDS = 5;

export interface DeviceCodeInfo {
  /** 长码，只给扩展自己用，用来换 token。 */
  deviceCode: string;
  /** 短码，给用户看、让用户填到 GitHub 上。 */
  userCode: string;
  /** 用户要打开的地址。 */
  verificationUri: string;
  /** 带上短码的地址，用户点进去就自动填好了（GitHub 会返回）。 */
  verificationUriComplete: string | null;
  /** 这个设备码多久过期（秒）。 */
  expiresIn: number;
  /** 建议的轮询间隔（秒）。 */
  interval: number;
}

/** 轮询一次的结果。 */
export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number | null }
  | {
      status: 'done';
      token: string;
      scope: string | null;
      /**
       * 如果这个 OAuth App 开启了"令牌过期"，GitHub 会返回刷新令牌。
       * 默认是关闭的，所以通常都是 null。见 docs/07 的说明。
       */
      refreshToken: string | null;
      /** 令牌有效期（秒）；不过期时为 null。 */
      expiresIn: number | null;
    }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

export interface DeviceFlowTransport {
  /** 发一个 application/x-www-form-urlencoded 的 POST，返回状态码和解析后的 JSON。 */
  postForm(url: string, body: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
}

export class DeviceFlowError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

/** 默认传输层：用 fetch。需要扩展在 manifest 里声明 github.com 的 host_permissions。 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): DeviceFlowTransport {
  return {
    async postForm(url, body) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          // GitHub 的设备授权端点**不支持 CORS 预检（OPTIONS）**，
          // 所以这里只能使用"安全列表"里的请求头：
          // Accept 和 Content-Type: application/x-www-form-urlencoded。
          // 千万别在这里加自定义头（比如 X-GitHub-Api-Version），
          // 那会触发预检，请求直接失败。
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
      });
      let parsed: Record<string, unknown> = {};
      try {
        parsed = (await response.json()) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed };
    },
  };
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 第一步：申请设备码。
 *
 * 注意：OAuth App 必须勾选了 "Enable Device Flow"，否则这里会报错。
 */
export async function requestDeviceCode(
  clientId: string,
  scope: string,
  transport: DeviceFlowTransport,
): Promise<DeviceCodeInfo> {
  if (!clientId.trim()) {
    throw new DeviceFlowError('client-id-missing', '还没有填写 OAuth App 的 client_id。');
  }

  const { body } = await transport.postForm(DEVICE_CODE_URL, {
    client_id: clientId.trim(),
    scope,
  });

  const error = str(body.error);
  if (error) {
    throw new DeviceFlowError(error, describeError(error, str(body.error_description)));
  }

  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  if (!deviceCode || !userCode) {
    throw new DeviceFlowError('unexpected-response', 'GitHub 返回的设备码格式不对，请稍后再试。');
  }

  const expiresIn = num(body.expires_in, 900);
  const interval = Math.max(MIN_INTERVAL_SECONDS, num(body.interval, MIN_INTERVAL_SECONDS));

  return {
    deviceCode,
    userCode,
    verificationUri: str(body.verification_uri, DEVICE_VERIFICATION_URL),
    verificationUriComplete: str(body.verification_uri_complete) || null,
    expiresIn,
    interval,
  };
}

/**
 * 第二步：轮询一次"用户同意了没"。
 *
 * 设计成"轮询一次"而不是"一直轮询"，是为了让调用方掌握节奏：
 * 后台 Service Worker 随时可能被浏览器回收，如果在这里写一个
 * 十几分钟的循环，被回收就前功尽弃。改成每次只问一次、
 * 状态存在存储里，就完全不怕被回收了。
 */
export async function pollDeviceTokenOnce(
  clientId: string,
  deviceCode: string,
  transport: DeviceFlowTransport,
): Promise<DevicePollResult> {
  const { body } = await transport.postForm(ACCESS_TOKEN_URL, {
    client_id: clientId.trim(),
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  const token = str(body.access_token);
  if (token) {
    return {
      status: 'done',
      token,
      scope: str(body.scope) || null,
      refreshToken: str(body.refresh_token) || null,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : null,
    };
  }

  const error = str(body.error);
  switch (error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      // GitHub 的响应里会带上新的 interval；带就听它的，没带就加 5 秒
      return { status: 'slow_down', interval: typeof body.interval === 'number' ? body.interval : null };
    // 官方文档里出错码表写的是 expired_token，但同一页的说明文字里写成了
    // token_expired，两个都兜住，免得哪天真遇到就认不出来
    case 'expired_token':
    case 'token_expired':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      return { status: 'error', message: describeError(error, str(body.error_description)) };
  }
}

/** 把 GitHub 的错误码翻译成人能看懂的中文。 */
export function describeError(code: string, description = ''): string {
  switch (code) {
    case 'authorization_pending':
      return '还没有在 GitHub 上完成授权。';
    case 'slow_down':
      return '请求太快了，正在放慢轮询速度。';
    case 'expired_token':
      return '这个设备码已经过期了，请重新发起授权。';
    case 'access_denied':
      return '你在 GitHub 上取消了授权。';
    case 'incorrect_device_code':
      return '设备码无效，请重新发起授权。';
    case 'device_flow_disabled':
      return '这个 OAuth App 没有启用 Device Flow。请到 GitHub 的 OAuth App 设置里勾选 "Enable Device Flow"。';
    case 'incorrect_client_credentials':
      return 'client_id 不正确。请检查是否复制完整（它形如 Iv1.xxxxxxxxxxxx）。';
    case 'unsupported_grant_type':
      return 'GitHub 不接受这个授权方式（可能是 OAuth App 配置不对）。';
    case 'client_id-missing':
      return '还没有填写 OAuth App 的 client_id。';
    default:
      return description || (code ? `GitHub 返回了错误：${code}` : 'GitHub 返回了无法识别的响应。');
  }
}

/** 把秒数变成"还剩 12 分钟"这种文案。 */
export function describeRemaining(seconds: number): string {
  if (seconds <= 0) return '已过期';
  if (seconds < 60) return `还剩 ${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `还剩 ${minutes} 分钟`;
}

export { MIN_INTERVAL_SECONDS, SLOW_DOWN_STEP_SECONDS };
