import { describe, expect, it } from 'vitest';
import {
  describeError,
  DeviceFlowError,
  pollDeviceTokenOnce,
  requestDeviceCode,
  type DeviceFlowTransport,
} from '@/features/auth/device-flow';

/** 有剧本的假传输层：按顺序返回预先准备好的响应，并记录收到的请求。 */
function scriptedTransport(responses: Array<{ status?: number; body: Record<string, unknown> }>): DeviceFlowTransport & {
  calls: Array<{ url: string; body: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  let index = 0;
  return {
    calls,
    async postForm(url, body) {
      calls.push({ url, body });
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { status: response.status ?? 200, body: response.body };
    },
  };
}

describe('申请设备码', () => {
  it('能解析出短码、验证地址和轮询间隔', async () => {
    const transport = scriptedTransport([
      {
        body: {
          device_code: 'long-code',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://github.com/login/device',
          verification_uri_complete: 'https://github.com/login/device?user_code=WDJB-MJHT',
          expires_in: 900,
          interval: 5,
        },
      },
    ]);

    const info = await requestDeviceCode('Iv1.abc123', 'gist', transport);

    expect(info.userCode).toBe('WDJB-MJHT');
    expect(info.deviceCode).toBe('long-code');
    expect(info.verificationUri).toBe('https://github.com/login/device');
    expect(info.verificationUriComplete).toContain('WDJB-MJHT');
    expect(info.expiresIn).toBe(900);
    expect(info.interval).toBe(5);

    // 请求必须打到正确的地址，并且带上 client_id 和 scope
    expect(transport.calls[0]!.url).toBe('https://github.com/login/device/code');
    expect(transport.calls[0]!.body).toEqual({ client_id: 'Iv1.abc123', scope: 'gist' });
  });

  it('轮询间隔不会被设置得小于 GitHub 要求的 5 秒', async () => {
    const transport = scriptedTransport([
      { body: { device_code: 'c', user_code: 'A-B', interval: 1 } },
    ]);
    const info = await requestDeviceCode('id', 'gist', transport);
    expect(info.interval).toBe(5);
  });

  it('OAuth App 没开 Device Flow 时给出可操作的提示', async () => {
    const transport = scriptedTransport([
      { status: 400, body: { error: 'device_flow_disabled' } },
    ]);
    await expect(requestDeviceCode('id', 'gist', transport)).rejects.toThrowError(/Enable Device Flow/);
  });

  it('没填 client_id 时直接拒绝，不发请求', async () => {
    const transport = scriptedTransport([{ body: {} }]);
    await expect(requestDeviceCode('   ', 'gist', transport)).rejects.toBeInstanceOf(DeviceFlowError);
    expect(transport.calls).toHaveLength(0);
  });

  it('返回内容缺字段时报错而不是继续往下走', async () => {
    const transport = scriptedTransport([{ body: { device_code: 'only-this' } }]);
    await expect(requestDeviceCode('id', 'gist', transport)).rejects.toThrowError(/格式不对/);
  });
});

describe('轮询换 token', () => {
  const url = 'https://github.com/login/oauth/access_token';

  it('用户还没同意 → pending', async () => {
    const transport = scriptedTransport([{ status: 200, body: { error: 'authorization_pending' } }]);
    expect(await pollDeviceTokenOnce('id', 'code', transport)).toEqual({ status: 'pending' });
  });

  it('请求太快 → slow_down（调用方应该放慢）', async () => {
    const transport = scriptedTransport([{ status: 200, body: { error: 'slow_down' } }]);
    expect(await pollDeviceTokenOnce('id', 'code', transport)).toEqual({ status: 'slow_down', interval: null });
  });

  it('slow_down 时如果 GitHub 给了新的 interval，就照它的来', async () => {
    const transport = scriptedTransport([{ status: 200, body: { error: 'slow_down', interval: 20 } }]);
    expect(await pollDeviceTokenOnce('id', 'code', transport)).toEqual({ status: 'slow_down', interval: 20 });
  });

  it('设备码过期 → expired', async () => {
    const transport = scriptedTransport([{ status: 200, body: { error: 'expired_token' } }]);
    expect(await pollDeviceTokenOnce('id', 'code', transport)).toEqual({ status: 'expired' });
  });

  it('文档里另一种写法的过期错误码也能识别（token_expired）', async () => {
    const transport = scriptedTransport([{ status: 200, body: { error: 'token_expired' } }]);
    expect(await pollDeviceTokenOnce('id', 'code', transport)).toEqual({ status: 'expired' });
  });

  it('用户点了拒绝 → denied', async () => {
    const transport = scriptedTransport([{ status: 200, body: { error: 'access_denied' } }]);
    expect(await pollDeviceTokenOnce('id', 'code', transport)).toEqual({ status: 'denied' });
  });

  it('成功 → 返回 token 和 scope，并且请求体里没有 client_secret', async () => {
    const transport = scriptedTransport([
      { status: 200, body: { access_token: 'gho_xxxx', token_type: 'bearer', scope: 'gist' } },
    ]);
    const result = await pollDeviceTokenOnce('Iv1.abc', 'device-code-1', transport);

    expect(result).toEqual({
      status: 'done',
      token: 'gho_xxxx',
      scope: 'gist',
      refreshToken: null,
      expiresIn: null,
    });
    expect(transport.calls[0]!.url).toBe(url);
    expect(transport.calls[0]!.body).toEqual({
      client_id: 'Iv1.abc',
      device_code: 'device-code-1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    // 这是"纯前端扩展也能用 OAuth"的关键：全程没有 client_secret
    expect(Object.keys(transport.calls[0]!.body)).not.toContain('client_secret');
  });

  it('App 开了"令牌过期"时，会一并带出 refresh_token 和有效期', async () => {
    const transport = scriptedTransport([
      {
        status: 200,
        body: {
          access_token: 'gho_short',
          token_type: 'bearer',
          scope: 'gist',
          expires_in: 28800,
          refresh_token: 'ghr_yyyy',
        },
      },
    ]);
    const result = await pollDeviceTokenOnce('Iv1.abc', 'code', transport);
    expect(result).toMatchObject({ status: 'done', refreshToken: 'ghr_yyyy', expiresIn: 28800 });
  });

  it('未知错误 → error 且带上 GitHub 的描述', async () => {
    const transport = scriptedTransport([
      { status: 400, body: { error: 'weird_thing', error_description: 'GitHub 说不行' } },
    ]);
    const result = await pollDeviceTokenOnce('id', 'code', transport);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toContain('GitHub 说不行');
  });
});

describe('错误文案', () => {
  it('常见错误码都有中文解释', () => {
    for (const code of [
      'authorization_pending',
      'slow_down',
      'expired_token',
      'access_denied',
      'incorrect_device_code',
      'device_flow_disabled',
    ]) {
      const message = describeError(code);
      expect(message).not.toContain(code);
      expect(message.length).toBeGreaterThan(4);
    }
  });

  it('未知错误码会回落到 GitHub 的描述', () => {
    expect(describeError('brand_new_error', '描述在这里')).toBe('描述在这里');
  });
});
