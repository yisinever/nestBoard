/**
 * 链接卡预览的**纯逻辑**（T2.04–T2.06 / `F2-4-1`–`F2-4-5`）。
 *
 * 三件事收在这里，都是为了能在 node 下逐条钉死：
 *
 *   1. **什么算一条可以做成卡的 URL**（`normalizeUrl`）—— 判定写松了的后果是把
 *      `mailto:` / `javascript:` / 一句普通文本变成链接卡，而用户根本没法解释它从哪来；
 *   2. **从 URL 里取一个能看的域名**（`domainOf`）—— 卡片默认只显示域名
 *      （`F2-4-2`），这是"没抓取过"时唯一的身份信息；
 *   3. **从一段 HTML 里抠出标题 / 摘要 / 图标等预览元数据**
 *      （`parseLinkMeta`：`O20` 的 og 系列 + `O23` 的 DOM 兜底）——
 *      这是整个插件里**唯一一处解析外部内容**的地方。
 *
 * ★ 为什么用正则而不是 `DOMParser`：`DOMParser` 只在浏览器环境有，而本文件要跑
 *   `vitest`（`environment: 'node'`，没有 DOM）。为了"读 5 个 meta 标签"引一整个
 *   jsdom 进去，代价远大于收益。代价是正则必须写得足够谨慎 —— 见 `parseLinkMeta`。
 *
 * ★ 这里不做任何网络请求：抓取是 `integration/ObsidianLinkPreviewBridge` 的活，
 *   本文件只负责"拿到 HTML 之后怎么理解它"。
 */

import type { LinkContent } from '../model/schema';

// ─────────────────────────────────────────────────────────────
// URL 判定
// ─────────────────────────────────────────────────────────────

/** 唯一允许的两种协议。`mailto:` / `obsidian:` / `javascript:` 都不是"网页" */
const HTTP_SCHEME = /^https?:\/\//i;

/**
 * 裸域名形态（用户从浏览器地址栏复制时常常没有 `https://` 前缀）。
 *
 * ★ 结尾那个 `(\/|$|\?|#|:)` 是必须的：没有它，`a.com` 匹配了，但 `a.company`
 *   也会被当成"域名 + `any`"这种荒唐的切分 —— 有了它，`a.company` 仍然整体匹配
 *   （`\.[\w-]+` 会把 `company` 吃进去），而 `mailto:x@y.com` 因为 `mailto` 后面是
 *   `:` 而不是 `.` 直接不匹配。
 */
const BARE_HOST = /^[\w-]+(\.[\w-]+)+(\/|$|\?|#|:)/;

/**
 * 把用户给的文本规范成一条绝对 URL；不是"网页链接"时返回 `null`。
 *
 * `example.com/a` → `https://example.com/a`（补协议）。
 * 返回值走 `URL.toString()` 规范化，于是 `https://a.com` 与 `https://a.com/`
 * 会得到**同一个字符串** —— 去重、比较因此不必再考虑这些写法差异。
 */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (text.length === 0) return null;
  // 含空白 = 一段话而不是一条链接。放行的话"看看这个 https://a.com"整句都会被
  // 当成 URL，抓取必然失败，用户看到的是"获取预览按钮点了没反应"
  if (/\s/.test(text)) return null;

  const candidate = HTTP_SCHEME.test(text) ? text : BARE_HOST.test(text) ? `https://${text}` : '';
  if (candidate.length === 0) return null;

  try {
    const url = new URL(candidate);
    // `new URL` 会接受 `javascript:` / `data:` / `file:` —— 这里必须自己关门
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname.length === 0) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 是否是可直接放进 `<img src>` / 交给浏览器打开的外部地址 */
export function isExternalUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * 展示用域名：去掉 `www.`，解析失败返回空串。
 *
 * ★ 去掉 `www.` 是有意的：地址栏里它是噪声，而卡片上这一行是"我在看哪个站"的
 *   唯一线索，越短越好认。
 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 分类器用的首字母图标：`example.com` → `E`；给不出就用 `?` */
export function siteInitialOf(url: string): string {
  const domain = domainOf(url);
  if (domain.length === 0) return '?';
  const first = domain.match(/[a-z0-9]/i);
  return first ? first[0].toUpperCase() : '?';
}

/** 相对地址 → 绝对；解不开返回 `null`（`og:image` 是 `undefined` 之类时会出现） */
export function resolveUrl(base: string, relative: string): string | null {
  const value = relative.trim();
  if (value.length === 0) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 域名黑名单（T6.06 / `F2-4-6`）
// ─────────────────────────────────────────────────────────────

/**
 * 把用户在设置里写的一行收成"用来比对的域名"。
 *
 * 目标只有一个：**用户怎么写，我们都认**。以下是全部会被剥掉的东西（各有一条现实理由）：
 *
 *  · `https://` 前缀 —— 从地址栏复制来的链接必然带它，要求用户手删是刁难；
 *  · 路径 / 查询 / 锚点 —— 用户想封的是**站**，不是某一页；
 *  · 端口 —— `example.com:8443` 与 `example.com` 对用户来说是同一个站；
 *  · `user@` 用户信息 —— 从某些后台复制来的链接会带；
 *  · 前导 `*.` —— 用户表达"所有子域"的常见写法；本实现本来就是**站点级**匹配
 *    （见 `isHostBlocked`），所以这层前缀只是把用户的意图写明白；
 *  · 前导 `www.` —— **与前一条同源**：`www.x.com` 与 `x.com` 在用户心里是同一个站。
 *    代价是"只封 www 不封主域"做不到，但那种需求基本不存在，而多一个开关就多一种
 *    "为什么我封了却没拦住"的困惑。
 *
 * 收不出东西（空串、纯空白、纯符号）时返回 `''`，调用方负责丢掉它。
 */
export function normalizeBlockedHost(entry: string): string {
  let text = entry.trim().toLowerCase();
  if (text.length === 0) return '';

  const scheme = text.indexOf('://');
  if (scheme >= 0) text = text.slice(scheme + 3);

  text = text.split(/[/?#]/)[0] ?? '';

  const at = text.lastIndexOf('@');
  if (at >= 0) text = text.slice(at + 1);

  const colon = text.indexOf(':');
  if (colon >= 0) text = text.slice(0, colon);

  text = text.replace(/^\*\./, '').replace(/^www\./, '');
  return text;
}

/**
 * 把设置里的原始数组收成一份可用的黑名单：逐行归一化、丢掉空行、去掉重复。
 *
 * ★ 在这里去重而不是"用的时候现查"：黑名单会在**每次抓取**时被线性扫描
 *   （`isHostBlocked`），列表里堆十个 `bilibili.com` 就是十次白扫；
 *   而用户在设置里粘贴一列 URL 时，重复是常态。
 * ★ 顺带把用户写进去的整条 URL 缩短成域名 —— 存进 `.data.json` 的因此是干净的域名，
 *   不是一坨带 `?utm=` 的原始链接（那也是隐私上更该做的事）。
 */
export function normalizeLinkBlocklist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const host = normalizeBlockedHost(item);
    if (host.length > 0) seen.add(host);
  }
  return [...seen];
}

/**
 * 这条链接的域名是否被拉黑了。
 *
 * 匹配规则是**站点级**：`bilibili.com` 同时拦住 `bilibili.com`、`www.bilibili.com`、
 * `m.bilibili.com`……
 *
 * ★ 为什么必须带子域：只做精确匹配的话，"封了 `bilibili.com` 却挡不住 `m.bilibili.com`"
 *   等于没封 —— 而移动版往往正是用户想躲的那一个。
 * ★ 为什么不做"只匹配精确主机"的开关：那会立刻引出 `*.` / 后缀 / 正则三种写法，
 *   而黑名单的每一次失配都会表现为"设置里明明写了却还在抓"，是这里最贵的 bug。
 * ★ 比较用 `endsWith('.') + 域名`，而不是 `endsWith(域名)`：后者会让 `notbilibili.com`
 *   撞上 `bilibili.com` 的判断 —— 一个改一个字母就能被"误封"的假阳性。
 * ★ 传入的链接必须先过 `normalizeUrl`（绝对地址）；解不出域名时返回 `false`
 *   （拦的是"确定要拦的"，不是"看不出是什么的"）。
 * ★ `blocklist` 必须是 `normalizeLinkBlocklist` 出来的结果（小写、无 `www.`、无重复）。
 */
export function isHostBlocked(url: string, blocklist: readonly string[]): boolean {
  const host = domainOf(url);
  if (host.length === 0) return false;
  for (const entry of blocklist) {
    if (entry.length === 0) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// HTML 元数据解析
// ─────────────────────────────────────────────────────────────

/**
 * 抓取结果（`LinkPreview` 在 `cards/registry.ts` 有同名结构，这里保持字段一致）。
 *
 * ★ `siteName` / `icon` / `finalUrl`（`O20`）与 `image` 一样**永远是字符串**，
 *   取不到就是空串 —— 解析层不做"键在不在"那层区分（那是 `LinkContent` 的规矩，
 *   见 `model/schema.ts`）。这样调用方判断只要 `length > 0`。
 */
export interface LinkMeta {
  title: string;
  description: string;
  image: string;
  /** `og:site_name`（`O20`）：站点自报的名字，没有就是空串 */
  siteName: string;
  /** 站点图标（`O20`）：`og:logo` 或 `<link rel="…icon…">`，已补成全地址；没有就是空串 */
  icon: string;
  /** `og:url`（`O20`）：页面声明的规范地址，已补成全地址；没有就是空串 */
  finalUrl: string;
}

const META_TAG = /<meta\b[^>]*>/gi;
const TITLE_TAG = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_TAG = /<link\b[^>]*>/gi;
/** `<h1>` / `<h2>`（`O23` 标题兜底）。反向引用 `\1` 保证开闭标签级别一致 */
const HEADING_TAG = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
/** 首个 `<p>`（`O23` 摘要兜底） */
const PARAGRAPH_TAG = /<p\b[^>]*>([\s\S]*?)<\/p>/i;
/** 所有 `<img>`（`O23` 找带 `logo` 关键词的那张） */
const IMG_TAG = /<img\b[^>]*>/gi;
/** `src` / `alt` / `class` / `id` 任一处带 `logo`（不分大小写）就算候选 */
const LOGO_HINT = /logo/i;

/** 常见实体 + 数字实体。`&nbsp;` 归一成普通空格：标题里一个不换行的空格会让省略号排版出错 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    const named = NAMED_ENTITIES[key] ?? NAMED_ENTITIES[key.replace(/^#/, '#')];
    if (named !== undefined) return named;
    if (key.startsWith('#')) {
      const hex = key.startsWith('#x');
      const code = Number.parseInt(hex ? key.slice(2) : key.slice(1), hex ? 16 : 10);
      // 越界 / NaN 一律原样留着：宁可显示 `&#9999999;`，也不要在 `fromCodePoint` 上抛错
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

/**
 * 从一个 `<meta>` 标签里取某个属性的值。
 *
 * 三种引号形态都吃：`content="a"` / `content='a'` / `content=a`（最后一种在真实
 * 网页里不合法但确实存在）。属性**顺序不定**，所以必须先在标签内定位属性名，
 * 而不是靠"第几个引号对"来切。
 */
function attrOf(tag: string, name: string): string {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) return '';
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * 一个 `<link>` 是不是站点图标，是的话是哪一档（`O20`）。
 *
 * ★ `rel` 是**空格分隔的记号集合**（`icon` / `shortcut icon` / `apple-touch-icon`），
 *   所以按记号判断而不是整串比对 —— 真实页面里 `rel="shortcut icon"` 与
 *   `rel="icon shortcut"` 都存在。`rel="shortcut"`（少了 `icon`）太含糊，不收。
 * ★ 分两档是为了定优先级（见 `parseLinkMeta`）：`apple-touch-icon` 通常是
 *   180×180 的 PNG，比 `favicon.ico` 更适合当卡面那 16px 的记号。
 */
function iconRelKind(tag: string): 'apple' | 'icon' | null {
  const rel = attrOf(tag, 'rel').toLowerCase();
  if (rel.length === 0) return null;
  const tokens = rel.split(/\s+/);
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) {
    return 'apple';
  }
  return tokens.includes('icon') ? 'icon' : null;
}

/**
 * 一段 HTML 片段 → 纯文本（`O23` 的 DOM 兜底共用）。
 *
 * ★ 标签替换成**空格**而不是空串：`多数派<span>少数派</span>` 直接删标签会粘成
 *   `多数派少数派`；空格 + `collapseWhitespace` 才是对的。
 * ★ 不解析嵌套结构、不认 `<script>`：这里只为从 `<h1>` / `<p>` 里取一句话，
 *   真去解析 HTML 就得引 jsdom，代价远大于收益（与 `parseLinkMeta` 同一取舍）。
 */
function textOf(fragment: string): string {
  return collapseWhitespace(decodeEntities(fragment.replace(/<[^>]*>/g, ' ')));
}

/**
 * 标题的 DOM 兜底（`O23`）：**首个 `<h1>`** 优先，没有就用**首个 `<h2>`**。
 *
 * ★ h1 在文档里可能排在 h2 之后，但按信息量仍是首选 —— 所以先把 h1 全部找完，
 *   找不到才回落到"记住的第一个 h2"。
 */
export function firstHeadingText(html: string): string {
  let fallback = '';
  HEADING_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_TAG.exec(html)) !== null) {
    const text = textOf(match[2]);
    if (text.length === 0) continue;
    if (match[1] === '1') return text;
    if (fallback.length === 0) fallback = text;
  }
  return fallback;
}

/**
 * 摘要的 DOM 兜底（`O23`）：**首个 `<p>`** 的纯文本，超长截断到 `maxLength` + `…`。
 *
 * ★ 兜底本身就有"可能抓到导航/声明"的风险，但这只在**没有任何描述标签**时发生；
 *   截断 + 省略号至少让它看起来像"摘录"而不是一段乱码。
 */
export function firstParagraphText(html: string, maxLength = 100): string {
  const match = PARAGRAPH_TAG.exec(html);
  if (!match) return '';
  const text = textOf(match[1]);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

/**
 * 图标的 DOM 兜底其一（`O23`）：找 `<img>` 里 **`src`/`alt`/`class`/`id` 带 `logo`** 的那张。
 *
 * ★ 只收能补成 http(s) 的地址（与 `icon` 同规矩）：`data:` 图放进 `<img src>` 是空框。
 * ★ 取**第一个**命中的：页面里常常"头部 logo"在前、"合作伙伴 logo"在后。
 */
export function firstLogoImage(html: string, pageUrl: string): string {
  IMG_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMG_TAG.exec(html)) !== null) {
    const tag = match[0];
    const src = attrOf(tag, 'src');
    if (src.length === 0) continue;
    const hint = `${src} ${attrOf(tag, 'alt')} ${attrOf(tag, 'class')} ${attrOf(tag, 'id')}`;
    if (!LOGO_HINT.test(hint)) continue;
    const resolved = resolveUrl(pageUrl, src);
    if (resolved !== null && isExternalUrl(resolved)) return resolved;
  }
  return '';
}

/**
 * 图标的 DOM 兜底其二（`O23`）：站点**根目录**的 `/favicon.ico`。
 *
 * ★ 这是"猜"出来的地址，也是**最后一档** —— 没抓到就退字母徽章（`cards/link.ts`）。
 *   之所以敢猜：它只是写进卡片的**远程地址**，渲染时才可能去取一次，失败有兜底，
 *   与 `O20` 的图标同一类（不额外发"发现请求"，只是这回连声明都没有）。
 */
function faviconUrl(pageUrl: string): string {
  const resolved = resolveUrl(pageUrl, '/favicon.ico');
  return resolved !== null && isExternalUrl(resolved) ? resolved : '';
}

/**
 * 解析网页 HTML → 预览元数据。
 *
 * 取值优先级按"信息量从高到低"排：
 *   title：`og:title` → `twitter:title` → `<title>` → 首个 `<h1>` → 首个 `<h2>`（`O23`）
 *   image：`og:image` → `og:image:url` → `twitter:image`
 *   description：`og:description` → `twitter:description` → `name="description"` → 首个 `<p>`（`O23`）
 *   siteName（`O20`）：`og:site_name`
 *   icon（`O20`）：`og:logo` → `apple-touch-icon` → `icon` / `shortcut icon`
 *   icon（`O23` 兜底）：带 `logo` 关键词的 `<img>` → 站点根 `/favicon.ico`
 *   finalUrl（`O20`）：`og:url`（页面自报的规范地址；跟随重定向后的真地址由桥补上）
 *
 * ★ 同一属性出现多次时**取第一个**：`og:image` 常常有多张（主图 + 备用），
 *   而第一个按规范就是主图。
 * ★ `og:image` / `og:url` / 图标这类经常是相对地址（`/og.png`）—— 必须用
 *   **页面地址**做基准补全，否则卡片会去请求 `file:///og.png`，表现是图永远裂着。
 * ★ 图标只从**这份 HTML** 里取，**不额外发请求**去试探 `favicon.ico`：
 *   解析层的每一次"顺手多问一句"都会变成用户没点过的一次联网。
 *   （`O23` 的 `/favicon.ico` 兜底**不是请求**：只是往卡片里写一个猜出来的地址，
 *   渲染时才可能去取一次、失败退字母徽章 —— 与声明式图标同一类。）
 * ★ 这里的正则只看 `<meta ...>` / `<link ...>` / `<title>`：不试图"解析 HTML"。
 *   网页里大段内联脚本中的字符串可能包含 `og:image` 字样，但它们几乎不会刚好长成
 *   `<meta property="og:image" content="…">` 的形状。
 */
export function parseLinkMeta(html: string, pageUrl: string): LinkMeta {
  const byProperty = new Map<string, string>();

  META_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = META_TAG.exec(html)) !== null) {
    const key = (attrOf(tag[0], 'property') || attrOf(tag[0], 'name')).toLowerCase();
    if (key.length === 0 || byProperty.has(key)) continue;
    const value = attrOf(tag[0], 'content').trim();
    if (value.length === 0) continue;
    byProperty.set(key, value);
  }

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = byProperty.get(key);
      if (value !== undefined && value.length > 0) return value;
    }
    return '';
  };

  // `<link>` 图标：apple 那档优先收一个，其余（`icon` / `shortcut icon`）收第一个
  let appleIcon = '';
  let plainIcon = '';
  LINK_TAG.lastIndex = 0;
  let link: RegExpExecArray | null;
  while ((link = LINK_TAG.exec(html)) !== null) {
    const kind = iconRelKind(link[0]);
    if (kind === null) continue;
    const href = attrOf(link[0], 'href').trim();
    if (href.length === 0) continue;
    if (kind === 'apple') {
      if (appleIcon.length === 0) appleIcon = href;
    } else if (plainIcon.length === 0) {
      plainIcon = href;
    }
  }

  const titleTag = TITLE_TAG.exec(html);
  const title =
    pick('og:title', 'twitter:title') ||
    (titleTag ? decodeEntities(titleTag[1]).trim() : '') ||
    // `O23` DOM 兜底：没有 og / <title> 的老站，标题常常只在 <h1>（或 <h2>）里
    firstHeadingText(html);
  const description =
    // `O23` DOM 兜底：没有任何描述标签时，退到首个 <p> 的纯文本（截断）
    pick('og:description', 'twitter:description', 'description') || firstParagraphText(html);
  const rawImage = pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image');
  const rawIcon = pick('og:logo') || appleIcon || plainIcon;

  return {
    title: collapseWhitespace(title),
    description: collapseWhitespace(description),
    image: rawImage.length > 0 ? (resolveUrl(pageUrl, rawImage) ?? '') : '',
    siteName: collapseWhitespace(pick('og:site_name')),
    // ★ 补全之后还要是 http(s)：页面里 `data:` 的 `href` 很常见，
    //   那种地址放进 `<img src>` 只会画出一个空框（见 `isExternalUrl`）
    // ★ `O23` 兜底：页面声明的图标 → 带 logo 关键词的 <img> → 站点根 /favicon.ico
    icon:
      externalUrlOrEmpty(pageUrl, rawIcon) || firstLogoImage(html, pageUrl) || faviconUrl(pageUrl),
    finalUrl: externalUrlOrEmpty(pageUrl, pick('og:url')),
  };
}

/**
 * 相对地址 → 绝对地址，并**只放行 http(s)**；补不全或不是网页地址时返回空串。
 *
 * ★ 与 `image` 的处理**刻意不同**（那边补全成什么就存什么）：图标与最终网址都会
 *   直接写进卡片、由 `<img src>` / 导出层消费，而 `data:` / `javascript:` 这类
 *   地址在那里只有坏处（空框 / 安全面），不如当作"没抓到"。
 */
function externalUrlOrEmpty(pageUrl: string, relative: string): string {
  if (relative.trim().length === 0) return '';
  const resolved = resolveUrl(pageUrl, relative);
  return resolved !== null && isExternalUrl(resolved) ? resolved : '';
}

/** 折叠空白：元数据里常有换行与多余缩进，直接写进 DOM 会撑出奇怪的空白 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// 卡片状态
// ─────────────────────────────────────────────────────────────

/**
 * 链接卡此刻处于哪一档。
 *
 *  * `empty`   —— 还没有 URL（新建但没填，或粘贴时没识别出链接）；
 *  * `bare`    —— 有 URL、没抓过：卡片显示"域名 + 获取预览"（`F2-4-2`）；
 *  * `fetched` —— 抓过了：显示标题/描述/预览图，按钮变成"重新获取"。
 *
 * ★ 判据是 `fetchedAt` 而不是"title 非空"：有的站点就是没有标题，
 *   用内容判断会让这类卡片**永远**显示成"没抓过"，按钮点几次都一样。
 */
export type LinkState = 'empty' | 'bare' | 'fetched';

export function linkStateOf(content: Pick<LinkContent, 'url' | 'fetchedAt'>): LinkState {
  if (content.url.trim().length === 0) return 'empty';
  return content.fetchedAt === null ? 'bare' : 'fetched';
}

/**
 * 卡面上真正要展示的那条地址（`O20`）：展开后的最终网址优先。
 *
 * ★ 短链抓过一次之后，`url` 还是用户粘的那条 `b23.tv/…`，而 `finalUrl` 是展开后的
 *   真实地址 —— 卡片上那个"我在看哪个站"的答案，用后者才对。
 */
export function linkDisplayUrlOf(content: Pick<LinkContent, 'url' | 'finalUrl'>): string {
  const final = content.finalUrl?.trim() ?? '';
  return final.length > 0 ? final : content.url;
}

/** 卡片上显示的主标题：抓到的标题 → 展示地址的域名 → 展示地址本身 */
export function linkTitleOf(content: Pick<LinkContent, 'url' | 'title' | 'finalUrl'>): string {
  if (content.title.trim().length > 0) return content.title.trim();
  const url = linkDisplayUrlOf(content);
  return domainOf(url) || url;
}

/**
 * 卡片站点那一行显示什么（`O20`）：站点名 → 展示地址的域名 → 展示地址本身。
 *
 * ★ 与 `linkTitleOf` 的回落链一样，只是多了一层"站点自报的名字"（`og:site_name`）
 *   —— 那一行本来就是"我在哪个站"，域名只是没有站点名时的答案。
 */
export function linkSiteNameOf(
  content: Pick<LinkContent, 'url' | 'siteName' | 'finalUrl'>,
): string {
  const name = content.siteName?.trim() ?? '';
  if (name.length > 0) return name;
  const url = linkDisplayUrlOf(content);
  return domainOf(url) || url;
}
