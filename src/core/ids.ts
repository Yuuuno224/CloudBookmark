/**
 * id 生成
 * =======
 *
 * uid 必须在"两台互不通信的设备"上都不重复，所以用密码学随机数。
 * 长度 16 位的 62 进制 ≈ 95 bit，随机碰撞概率可以忽略。
 *
 * 为什么不用 uuid？因为 uuid 是 36 个字符，一条记录里 uid + parentUid
 * 就占 72 字节；书签上千条时 JSON 会白白大出几百 KB，而 Gist 单个文件
 * 有大小限制。
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 生成一个随机字符串。仅用于"唯一性"，不用于加密。 */
export function randomId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** 书签/文件夹的稳定身份。 */
export function newUid(): string {
  return randomId(16);
}

/** 快照内容指纹（比 revision 短一点就够了）。 */
export function newRevision(): string {
  return randomId(20);
}

/** 通用记录 id（变更记录、同步历史、冲突…）。 */
export function newRecordId(): string {
  return randomId(12);
}

/** 当前时间的 ISO 字符串。 */
export function nowIso(): string {
  return new Date().toISOString();
}
