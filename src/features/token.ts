/**
 * Token 的安全存储
 * ================
 *
 * ## 做了什么
 *
 * 1. 明文 Token **只在内存里**存在（Service Worker 生命周期内），不落盘。
 * 2. 落盘的是 AES-GCM 加密后的密文，密钥由 `扩展ID + 设备ID` 用 PBKDF2 派生。
 *
 * ## 诚实的说明（很重要，别被"加密"两个字骗了）
 *
 * 派生密钥的两个材料（扩展 id、设备 id）都存在同一台电脑上，
 * 所以这层加密**只能防止"别人随手打开扩展存储就看到明文 Token"**，
 * 防不住能读你磁盘、能调试你浏览器的恶意软件。
 *
 * 真正保护 Token 的是这两点，请务必遵守：
 *   - Token 只勾选 `gist` 一个权限（即使泄露也只能读写 Gist）
 *   - 不把 Token 写进日志、不发给任何第三方地址
 *
 * 如果哪天想更安全，可以改成"让用户自己设一个主密码"，
 * 那时候密钥就不在这台机器上了（代价是每次启动要输密码）。
 */

import { AppError } from '@/core/types';
import { base64ToBytes, bytesToBase64 } from '@/platform/base64';
import { kvStore, type TokenBlob } from '@/platform/kv';

const PBKDF2_ITERATIONS = 120_000;
const TOKEN_CACHE_MS = 5 * 60 * 1000;

let cached: { token: string; at: number } | null = null;

async function deriveKey(deviceId: string): Promise<CryptoKey> {
  const seed = new TextEncoder().encode(`${chrome.runtime.id}:${deviceId}`);
  const material = await crypto.subtle.importKey('raw', seed, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: seed, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 保存 Token（自动加密）。 */
export async function saveToken(token: string, deviceId: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new AppError('token-empty', 'Token 不能为空。');

  const key = await deriveKey(deviceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(trimmed),
  );

  const blob: TokenBlob = { iv: bytesToBase64(iv), data: bytesToBase64(encrypted) };
  await kvStore.set('tokenBlob', blob);
  cached = { token: trimmed, at: Date.now() };
}

/** 读取 Token；解不开（例如扩展重装过）会返回 null，界面应提示重新填写。 */
export async function getToken(deviceId: string): Promise<string | null> {
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;

  const blob = await kvStore.get('tokenBlob');
  if (!blob) return null;

  try {
    const key = await deriveKey(deviceId);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(blob.iv) },
      key,
      base64ToBytes(blob.data),
    );
    const token = new TextDecoder().decode(decrypted);
    cached = { token, at: Date.now() };
    return token;
  } catch {
    // 解密失败：密钥变了（重装扩展）或数据被改坏了
    return null;
  }
}

export async function removeToken(): Promise<void> {
  await kvStore.set('tokenBlob', null);
  cached = null;
}

export async function hasToken(deviceId: string): Promise<boolean> {
  return (await getToken(deviceId)) !== null;
}

/** 有没有"存过但解不开"的 Token，用来给用户更准确的提示。 */
export async function hasBrokenToken(): Promise<boolean> {
  const blob = await kvStore.get('tokenBlob');
  return Boolean(blob);
}
