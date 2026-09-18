/**
 * ID 生成（T1.08 依赖）。
 *
 * 为什么不用 `crypto.randomUUID()` / Node `crypto`：
 * ① 引 Node 内置模块会把插件绑死在桌面端（`eslint.config.mjs` 也禁止这么做）；
 * ② `randomUUID` 在旧 WebView 上不一定有；
 * ③ 我们需要**单调递增可排序**的 ID（ULID 思路），便于调试与 diff。
 *
 * 实现：Crockford Base32（无 I/L/O/U，肉眼不易混），
 * 时间戳 10 字符 + 随机 8 字符 —— 同一毫秒内靠自增计数器保证有序。
 */

import type { ID_PREFIX } from '../constants';

/** 白板 / 卡片 / 分栏 / 连线 / 编组 的 ID 前缀 */
export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 8;

let lastTime = -1;
let counter = 0;

/** 固定长度 Base32 编码（从低位到高位填充） */
function encodeBase32(value: number, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET.charAt(Math.floor(Math.random() * 32));
  }
  return out;
}

/**
 * 生成一个有序 ID，形如 `c_01J9ZK3M7QX8B4RT`。
 * @param prefix 见 `ID_PREFIX`
 * @param now 注入时间戳，仅为可测试性；生产代码不要传
 */
export function createId(prefix: IdPrefix, now: number = Date.now()): string {
  if (now === lastTime) {
    counter = (counter + 1) % 32;
  } else {
    lastTime = now;
    counter = 0;
  }
  return `${prefix}_${encodeBase32(now, TIME_LENGTH)}${encodeBase32(counter, 1)}${encodeRandom(
    RANDOM_LENGTH - 1,
  )}`;
}

/** 仅供测试：重置单调计数器，避免用例之间互相影响 */
export function __resetIdCounter(): void {
  lastTime = -1;
  counter = 0;
}
