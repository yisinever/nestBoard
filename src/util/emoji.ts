/**
 * 卡面图标（emoji）：一处存放"能给卡片选哪些图标"与"用户给的算不算一个图标"（`O10`）。
 *
 * ★ 为什么是**精选清单**而不是"把 3000 个 emoji 全摊开"：
 *   卡面图标要干的事是"一眼认出这是哪块板"，所以清单是按用途挑的（待办 / 资料 /
 *   灵感 / 时间……）。全摊开等于让用户在几百个长得差不多的方块里找一个连自己
 *   都说不清的东西 —— 挑得越少，选得越快。
 * ★ 但清单不是围墙：系统输入法面板（macOS 是 `⌃⌘Space`）打得出来的 emoji，
 *   粘进输入框就算数 —— `emojiSuggestions` 会把它排到第一个。清单只负责"省事"。
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可在 node 下单测。
 */

/**
 * 卡面图标最多留这么多个 UTF-16 码元。
 *
 * 16 是**组合 emoji** 的长度底线：「👨‍👩‍👧‍👦」11 个码元、「🏳️‍🌈」6 个。
 * 上限卡在 16 既装得下它们，又拦得住"把一整段话当图标"的脏数据 ——
 * 卡面上那一格只有 16×16 像素，多出来的字只会把标题挤没。
 */
export const ICON_MAX_LENGTH = 16;

/**
 * 归一化一个图标：剔掉控制字符、去掉首尾空白、超长截断。
 *
 * 返回空串 = **没有图标**（`content.icon` 这个键不写进文件）。读入口
 * （`model/validate.ts`）与写入口（图标选择器 / 右键清除）共用这一份 ——
 * 两处各写一份的话，"存进去的"与"读回来的"迟早不是一个东西。
 */
export function normalizeIcon(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // 控制字符（含换行与制表）落进 DOM 只会变成看不见的排版破坏，先剔掉再谈长度。
  // ★ 逐字符判码点而不是写正则字符类：`no-control-regex` 那条 lint 规则禁的正是
  //   "正则里出现控制字符区间"，而这里确实要的是一整段区间 —— 换成循环既守住
  //   同一条边界，也不必挂一行 disable。
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    cleaned += ch;
  }
  return cleaned.trim().slice(0, ICON_MAX_LENGTH);
}

/**
 * 精选清单：**按用途分组**（`08 §3.1`）。
 *
 * ★ 分组是给脑图的**快捷操作栏**用的（点开就能按类挑，不必打字）；白板那个
 *   `IconPickerModal` 是模糊搜索的形态，读的是下面那份拍平的清单 ——
 *   **两边共用这一份数据**，差别只在呈现（"按类挑"与"搜出来的"必须是同一个集合）。
 * ★ 只带 `key` 不带标题：标题是界面语言（`mind.emojiGroup.<key>` 那几条 i18n），
 *   而这一份是纯数据。
 */
export type EmojiGroupKey =
  | 'symbols'
  | 'geometry'
  | 'office'
  | 'status'
  | 'docs'
  | 'ideas'
  | 'time'
  | 'people'
  | 'nature'
  | 'tools';

export const EMOJI_GROUPS: readonly { key: EmojiGroupKey; emojis: readonly string[] }[] = [
  // ★ 前三组（其他符号 / 几何 / 办公）放**最前**（用户 2026-09-16 指定，参照 emojiall 的分类）：
  //   标记一个节点时最常用的恰恰是"符号 / 色块 / 办公"这三类 —— 它们不该藏在列表中间
  {
    key: 'symbols',
    emojis: [
      '✅',
      '❌',
      '❗',
      '❓',
      '⚠️',
      '➕',
      '➖',
      '➗',
      '✖️',
      '✔️',
      '☑️',
      '♻️',
      '🔰',
      '🆗',
      '🆙',
      '🔱',
    ],
  },
  {
    key: 'geometry',
    emojis: [
      '🔴',
      '🟠',
      '🟡',
      '🟢',
      '🔵',
      '🟣',
      '🟤',
      '⚫',
      '⚪',
      '🟥',
      '🟧',
      '🟨',
      '🟩',
      '🟦',
      '🟪',
      '🟫',
    ],
  },
  {
    key: 'office',
    emojis: [
      '📌',
      '📍',
      '📎',
      '🖇️',
      '📐',
      '📏',
      '✂️',
      '🗃️',
      '🗄️',
      '🗑️',
      '📁',
      '📂',
      '📅',
      '📆',
      '🗓️',
      '📇',
    ],
  },
  { key: 'status', emojis: ['⭐', '🔥', '🚧', '🎯', '🏁', '⏳', '🔍', '🧩'] },
  { key: 'docs', emojis: ['📝', '📄', '📚', '📖', '🗂️', '🔖', '🧾', '📰'] },
  { key: 'ideas', emojis: ['💡', '🧠', '✨', '🧪', '🎨', '🎵', '🖊️', '🖋️'] },
  { key: 'time', emojis: ['⏰', '⌛', '🚀', '🧭', '🔔', '🕐', '📈', '📉'] },
  { key: 'people', emojis: ['👥', '💬', '📣', '🤝', '🌍'] },
  { key: 'nature', emojis: ['🌱', '🌊', '🍀', '🍃', '☀️', '🌙', '☕', '🐛'] },
  { key: 'tools', emojis: ['🛠️', '⚙️', '🔒', '🔑', '💰', '🎁'] },
];

/**
 * 拍平的清单（顺序 = 上面各组的顺序）。
 *
 * ★ 从分组**推出来**而不是各写一份：这一份是白板那个模糊搜索选择器的候选，
 *   另写一份的话"按类挑得到的"与"搜出来的"迟早不是一个集合。
 */
export const EMOJI_CHOICES: readonly string[] = EMOJI_GROUPS.flatMap((group) => group.emojis);

/**
 * 随机挑一个图标（新建卡片时的"默认记号"，如新建白板卡）。
 *
 * ★ 与 `EMOJI_CHOICES` 同一份清单：挑出来的必须能在**选择器里找得到** ——
 *   否则用户想换一个同款都找不着。
 * ★ 收成函数而不是在调用处裸写 `Math.random`：一来语法上只有一处，
 *   二来单测能替换它（`vi.spyOn(Math, 'random')` 也行，但收在这里之后，
 *   "按类型挑一组"这类调整只动这一处）。
 * ★ 清单为空时给空串（= 没有图标），不抛：图标是**可选**的装饰。
 */
export function randomBoardIcon(): string {
  if (EMOJI_CHOICES.length === 0) return '';
  return EMOJI_CHOICES[Math.floor(Math.random() * EMOJI_CHOICES.length)] ?? '';
}

/**
 * 选择器要显示的候选（纯函数，好单测）。
 *
 * 规则两条，顺序要紧：
 * 1. 输入框空着 → 精选清单（"省事"那条路）；
 * 2. 输入框里有东西 → **它自己排第一**，同一个字符从清单里去掉（不重复出现）。
 *
 * ★ 第 2 条不能省。`SuggestModal` 的回车拿的是**高亮的那一项**，不是输入框里的字：
 *   没有这条的话，用户从系统面板粘进来的 emoji 会因为"不在清单里"而永远选不中 ——
 *   一按回车就变成了清单的第一个 `📌`，而他会以为"这个 emoji 插件不支持"。
 */
export function emojiSuggestions(query: string): string[] {
  const typed = normalizeIcon(query);
  if (typed.length === 0) return [...EMOJI_CHOICES];
  return [typed, ...EMOJI_CHOICES.filter((emoji) => emoji !== typed)];
}
