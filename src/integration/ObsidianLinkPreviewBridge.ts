/**
 * `LinkPreviewBridge` 的生产实现（T2.04–T2.06）。
 *
 * 链接卡的抓取链上**唯一** import `obsidian` 的地方：取网页、取图片、落盘附件。
 * 卡片定义（`cards/link.ts`）只认桥接口，于是"按钮什么时候出现、抓不到怎么显示"
 * 那些规则可以脱离 Obsidian 单测。
 *
 * ★ 走 `requestUrl` 而不是 `fetch`：`fetch` 在 Electron 渲染进程里受同源策略约束，
 *   `https://example.com` 的 `og:` 标签根本读不到（CORS 不给响应头）。`requestUrl`
 *   是 Obsidian 提供的主进程代理请求，没有这个限制 —— 这也是插件内唯一正确的
 *   联网姿势。
 *
 * ★ 四道闸门都**返回 `null` 而不抛异常**：
 *   1. 总开关没开（`F11-07`；`O20` 起默认**开启**）→ 连请求都不发；
 *   2. 地址不是 http(s)（`normalizeUrl` 挡掉 `javascript:` / `file:`）；
 *   3. 域名在用户的**黑名单**里（`F2-4-6` / T6.06）→ 同样连请求都不发；
 *   4. 下载量超限（一个 40MB 的 HTML 或一张 20MB 的 `og:image`）。
 *   卡片在渲染路径上调它，抛错会带走整屏卡片。
 *
 * ★ `O20` 起解析面扩到站点名 / 图标 / 最终网址，但**没有新增任何请求**：
 *   这三样都是从上面那一次 `requestUrl` 拿到的 HTML（外加响应自带的最终地址）里读的。
 */

import { requestUrl } from 'obsidian';
import type { LinkPreview, LinkPreviewBridge } from '../cards/registry';
import { extensionForMime } from '../io/AttachmentManager';
import { isExternalUrl, isHostBlocked, normalizeUrl, parseLinkMeta } from '../util/linkPreview';

/** 一次抓取最多接受的 HTML 字符数：正文再长的页面，元数据也在前 2MB 里 */
const MAX_HTML_CHARS = 2 * 1024 * 1024;
/** 预览图上限。超过就当没有 —— 一张 20MB 的图落进附件目录是事故而不是功能 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 抓取时带的 `User-Agent`（`O24`）。
 *
 * ★ 很多站点对"没有 UA / 一眼是脚本"的请求直接 403 或回一个空壳 —— 带一个普通
 *   浏览器 UA 是最低成本的改善。
 * ★ 但**只带 UA**：不加 `Referer`、不加 `Cookie`、也不复用用户的任何登录态。
 *   我们要的只是那一次 GET 的公开页面，不该顺走用户的身份信息（与"一次点击
 *   一次请求、无痕"这条线一致）。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 交给宿主的几件事：读开关、读黑名单、把二进制落成附件 */
export interface LinkPreviewHost {
  /** 设置里的总开关，`O20` 起默认 `true` */
  enabled(): boolean;
  /**
   * 用户拉黑的域名（`F2-4-6` / T6.06），**已归一化**的小写主机名。
   *
   * ★ 做成闭包而不是构造时的快照值：用户把某个站加进黑名单之后，**已经开着的白板**
   *   下一次点"获取预览"就该被拦住，不必关掉视图重开（与 `enabled` 同一条理由）。
   */
  blockedHosts(): readonly string[];
  /** 落盘成 Vault 附件并返回 vault 相对路径；失败返回 `null`（由宿主自己兜异常） */
  importImage(data: ArrayBuffer, name: string): Promise<string | null>;
}

/**
 * 响应上那个"最终落到哪"的地址（`O20`）。
 *
 * ★ `requestUrl` **跟随重定向**，但公开类型 `RequestUrlResponse` 里只声明了
 *   `status / headers / arrayBuffer / json / text` —— 没有 `url`。运行时（不同
 *   Obsidian 版本 / 底层实现）可能带，能读就读；读不到就退到 `og:url`。
 * ★ 读出来还要过一遍 `normalizeUrl`：它不是我们要的类型时当作没有，
 *   而不是把一段脏字符串写进卡片。
 */
function responseUrlOf(response: unknown): string {
  const value = (response as { url?: unknown }).url;
  return typeof value === 'string' ? (normalizeUrl(value) ?? '') : '';
}

/** 从 URL 与响应头猜一个像样的附件名：`链接预览-<时间戳>.<ext>` */
function previewImageName(url: string, contentType: string): string {
  const fromMime = extensionForMime(contentType.split(';')[0]?.trim() ?? '');
  if (fromMime !== null) return `链接预览.${fromMime}`;

  // 响应头不可信（很多 CDN 回 `application/octet-stream`）→ 退回看地址后缀
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot > 0 && last.length - dot <= 5) {
      const ext = last.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]+$/.test(ext)) return `链接预览.${ext}`;
    }
  } catch {
    /* 地址已经过 `normalizeUrl`，这里不该失败；真失败了用下面的兜底 */
  }
  return '链接预览.png';
}

export class ObsidianLinkPreviewBridge implements LinkPreviewBridge {
  constructor(private readonly host: LinkPreviewHost) {}

  get enabled(): boolean {
    return this.host.enabled();
  }

  /**
   * 这条链接的域名在不在黑名单里（`F2-4-6`）。
   *
   * ★ 先 `normalizeUrl` 再判：`m.bilibili.com` 这种裸域名要先补成绝对地址才解析得出主机，
   *   而"用户只敲了域名"恰恰是最常见的形态 —— 顺序反了会整类漏拦。
   * ★ 解不出主机时返回 `false`：拦的是"确定要拦的"，不是"看不出是什么的"。
   */
  isBlocked(url: string): boolean {
    const target = normalizeUrl(url);
    if (target === null) return false;
    return this.isHostBlocked(target);
  }

  /** 已归一化的绝对地址 → 是否被拦。★ 每次都**现读**黑名单，所以设置改完立刻生效 */
  private isHostBlocked(target: string): boolean {
    return isHostBlocked(target, this.host.blockedHosts());
  }

  async fetch(url: string): Promise<LinkPreview | null> {
    if (!this.enabled) return null;
    const target = normalizeUrl(url);
    if (target === null) return null;
    // 黑名单在归一化**之后**判（理由见 `isBlocked`）。★ 这里自己拦一次，
    //   不依赖调用方先问 —— 调用方漏问一次就是"黑名单里写着却还在抓"
    if (this.isHostBlocked(target)) return null;

    try {
      const response = await requestUrl({
        url: target,
        method: 'GET',
        // ★ 显式声明想要 HTML：有些站点只在 `Accept` 里带 `text/html` 时才回
        //   渲染好的页面（否则给一个空壳 SPA），那样 og 标签一个都读不到
        // ★ 带上普通浏览器 UA（`O24`）：不少站点对无 UA 的请求直接 403
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': BROWSER_UA },
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) return null;

      const html = response.text ?? '';
      if (html.length === 0 || html.length > MAX_HTML_CHARS) return null;

      const meta = parseLinkMeta(html, target);
      // 一个字段都没解析出来 = 这不是个正常网页（登录墙 / 纯 JS 渲染），
      // 与其写一条空预览让用户以为抓到了，不如老实说失败。
      // ★ `O20` 之后判据保持不变：站点名 / 图标 / 最终网址**不算数** ——
      //   一个只有 `<link rel="icon">`（或只剩 `O23` 的 `/favicon.ico` 兜底）的空壳
      //   不算"抓到了预览"；`O23` 的 `<h1>` / `<p>` 兜底若真给出了标题 / 摘要，则照常算数。
      if (meta.title.length === 0 && meta.description.length === 0 && meta.image.length === 0) {
        return null;
      }
      return {
        title: meta.title,
        description: meta.description,
        image: meta.image,
        siteName: meta.siteName,
        icon: meta.icon,
        // 响应自己的最终地址（跟随重定向后的真地址）优先于页面自报的 `og:url`
        finalUrl: responseUrlOf(response) || meta.finalUrl,
      };
    } catch (error) {
      console.warn('[nestboard] 链接预览抓取失败', target, error);
      return null;
    }
  }

  async cacheImage(url: string): Promise<string | null> {
    if (!this.enabled) return null;
    if (!isExternalUrl(url)) return null;

    const target = normalizeUrl(url);
    if (target === null) return null;
    // ★ 这里判的是**图片自己的主机**，不是页面的主机：`og:image` 常常放在 CDN 上，
    //   "页面没被封、图所在的那个站被封"同样不该发这个请求（否则黑名单形同虚设）
    if (this.isHostBlocked(target)) return null;

    try {
      // 图片也带 UA（`O24`）：部分 CDN 对无 UA 的请求同样会拒
      const response = await requestUrl({
        url: target,
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA },
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) return null;

      const bytes = response.arrayBuffer;
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;

      const contentType = response.headers['content-type'] ?? '';
      return await this.host.importImage(bytes, previewImageName(target, contentType));
    } catch (error) {
      // 落盘失败不是错误路径而是**已知退路**：卡片会退回远程地址（见 `cards/link.ts`），
      // 所以这里只记一行日志，不打扰用户
      console.warn('[nestboard] 预览图落盘失败', url, error);
      return null;
    }
  }

  async openExternal(url: string): Promise<boolean> {
    const target = normalizeUrl(url);
    if (target === null) return false;
    // Obsidian 桌面端会拦截 `window.open` 并用系统浏览器打开，移动端则有自己的
    // 处理；两条路都不需要我们碰 Electron 的 `shell`（那种写法在移动端直接崩）
    window.open(target, '_blank');
    return true;
  }
}
