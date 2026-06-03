import { arrayBufferToBase64, base64ToArrayBuffer } from '@/utils/helpers';

const ENCRYPTED_TOKEN_KEY = 'encrypted_token';
const TOKEN_IV_KEY = 'token_iv';
const INSTALL_TIME_KEY = 'install_time';

interface EncryptedData {
  iv: string;
  data: string;
}

async function getMasterKey(): Promise<CryptoKey> {
  let installTime = await chrome.storage.local.get(INSTALL_TIME_KEY);
  if (!installTime[INSTALL_TIME_KEY]) {
    const time = Date.now().toString();
    await chrome.storage.local.set({ [INSTALL_TIME_KEY]: time });
    installTime = { [INSTALL_TIME_KEY]: time };
  }

  const seed = new TextEncoder().encode(
    chrome.runtime.id + installTime[INSTALL_TIME_KEY],
  );
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seed,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: seed,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptToken(token: string): Promise<EncryptedData> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  );
  return {
    iv: arrayBufferToBase64(iv.buffer),
    data: arrayBufferToBase64(encrypted),
  };
}

async function decryptToken(encrypted: EncryptedData): Promise<string> {
  const key = await getMasterKey();
  const iv = base64ToArrayBuffer(encrypted.iv);
  const data = base64ToArrayBuffer(encrypted.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    data,
  );
  return new TextDecoder().decode(decrypted);
}

export class TokenManager {
  private cachedToken: string | null = null;

  async saveToken(token: string): Promise<void> {
    const encrypted = await encryptToken(token);
    await chrome.storage.local.set({
      [ENCRYPTED_TOKEN_KEY]: encrypted.data,
      [TOKEN_IV_KEY]: encrypted.iv,
    });
    this.cachedToken = token;
    await chrome.storage.session.set({ token });
  }

  async getToken(): Promise<string | null> {
    if (this.cachedToken) return this.cachedToken;

    const session = await chrome.storage.session.get('token');
    if (session.token) {
      this.cachedToken = session.token;
      return session.token;
    }

    const stored = await chrome.storage.local.get([
      ENCRYPTED_TOKEN_KEY,
      TOKEN_IV_KEY,
    ]);
    if (!stored[ENCRYPTED_TOKEN_KEY] || !stored[TOKEN_IV_KEY]) {
      return null;
    }

    try {
      const token = await decryptToken({
        iv: stored[TOKEN_IV_KEY],
        data: stored[ENCRYPTED_TOKEN_KEY],
      });
      this.cachedToken = token;
      await chrome.storage.session.set({ token });
      return token;
    } catch {
      return null;
    }
  }

  async removeToken(): Promise<void> {
    await chrome.storage.local.remove([ENCRYPTED_TOKEN_KEY, TOKEN_IV_KEY]);
    await chrome.storage.session.remove('token');
    this.cachedToken = null;
  }

  async hasToken(): Promise<boolean> {
    const token = await this.getToken();
    return token !== null;
  }
}

export const tokenManager = new TokenManager();
