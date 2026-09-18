/**
 * `MapTileBridge` 的生产实现（`O08`）。
 *
 * 地图卡"粘贴分享链接"这条链上**唯一** import `obsidian` 的地方：发一次请求、
 * 把图落进附件目录。地址怎么拼（`staticMapRequest`）与链接怎么解析（`parseMapLink`）
 * 都在 `util/mapUrl.ts` 里，与这里无关 —— 于是"各家链接认不认得出、高德的经纬度
 * 谁在前"这些最容易错的部分可以脱离 Obsidian 单测。
 *
 * ★ 与 `ObsidianLinkPreviewBridge` 是三件一模一样的事：走 `requestUrl`（`fetch`
 *   在 Electron 渲染进程里会被 CORS 挡掉）、限制下载量、失败返回 `null` 不抛。
 *   差别只有一处：**这里没有域名黑名单**。那个黑名单管的是"抓别人网页上的图"，
 *   而这里的请求是用户自己粘了一条地图链接之后点名要的 —— 拦住它只会让人
 *   对着一个不听话的菜单项发愁（理由另见 `MapTileBridge`）。
 *
 * ★ 三道闸门，都在**发请求之前**：
 *   1. 设置里挑好了服务商，且该档需要的 key 填了（`enabled`）；
 *   2. 地址是 http(s)（拼出来的地址一定是我们自己的模板，这道防的是将来被改坏）；
 *   3. 下载量不超限。
 */

import { requestUrl } from 'obsidian';
import type { MapTileBridge } from '../cards/registry';
import { extensionForMime } from '../io/AttachmentManager';
import type { MapTileProvider } from '../util/mapUrl';

/** 一张静态地图的上限。超了就当没拿到 —— 地图图不该有 20MB */
const MAX_TILE_BYTES = 8 * 1024 * 1024;

/** 交给宿主的几件事：读设置、落盘附件 */
export interface MapTileHost {
  /**
   * 设置里挑的静态图服务。
   *
   * ★ 做成闭包而不是构造时的快照值：用户改完设置，**已经开着的白板**下一次粘贴
   *   就该用新的那一档（与 `LinkPreviewHost.enabled` 同一条理由）。
   */
  provider(): MapTileProvider;
  /** 那一档要的 key（`osm` 不需要，空串正常） */
  key(): string;
  /** 落盘成 Vault 附件并返回 vault 相对路径；失败返回 `null`（由宿主自己兜异常） */
  importImage(data: ArrayBuffer, name: string): Promise<string | null>;
}

export class ObsidianMapTileBridge implements MapTileBridge {
  constructor(private readonly host: MapTileHost) {}

  /**
   * 挑好了服务商、并且那一档需要的 key 也填了 —— 才算"可用"。
   *
   * ★ 把 key 也并进 `enabled`，而不是让它到 `fetch` 里再失败一次：卡片据此决定
   *   卡面提示要说"设置里挑一个静态图服务就能出图"还是别的；而"挑了 Google 却没填 key"
   *   这种半配置状态，从用户视角看就是**还不能出图**，说成"可以"是骗人。
   * ★ `osm` 那一档是社区服务，不需要 key（见设置里的说明）。
   */
  get enabled(): boolean {
    const provider = this.host.provider();
    if (provider === 'none') return false;
    if (provider === 'osm') return true;
    return this.host.key().trim().length > 0;
  }

  async fetch(url: string, name: string): Promise<string | null> {
    if (!this.enabled) return null;
    if (!/^https?:\/\//i.test(url)) return null;

    try {
      const response = await requestUrl({ url, method: 'GET', throw: false });
      if (response.status < 200 || response.status >= 300) {
        // ★ 状态码要**记下来**：这条链上最容易出问题的就是 key（401 / 403）
        //   与配额（429），只回一句"失败了"用户没法自己排查
        console.warn('[nestboard] 静态地图请求被拒', response.status, url);
        return null;
      }

      const bytes = response.arrayBuffer;
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_TILE_BYTES) return null;

      // ★ 认一眼是不是真图片：高德 / Google 在参数写错时会**回一张 200 的文本说明**
      //   （或一个 JSON），直接落盘就成了一张打不开的附件 —— 而卡片会一直画着断图
      const contentType = response.headers['content-type'] ?? '';
      if (!looksLikeImage(bytes, contentType)) {
        console.warn('[nestboard] 静态地图返回的不是图片', url);
        return null;
      }

      // ★ 扩展名按**响应头**决定，不从 `url` 里猜：静态图服务回的是 `?...&key=…`，
      //   路径上根本没有后缀（与链接预览那条链不同，那里至少还有可能带后缀）。
      //   认不出 MIME 时兜底 png —— 上面的字节头已经确认过它是一张真图了
      const extension = extensionForMime(contentType.split(';')[0]?.trim() ?? '') ?? 'png';
      return await this.host.importImage(bytes, `${name}.${extension}`);
    } catch (error) {
      console.warn('[nestboard] 静态地图下载失败', url, error);
      return null;
    }
  }
}

/**
 * 字节头 + `content-type` 双判。
 *
 * ★ 两份判据都要，因为两份都不可信：有的服务商把 `content-type` 写成
 *   `application/octet-stream`（图是真的），有的写成 `image/png`（内容却是 HTML 报错页）。
 *   认字节头才是硬证据，`content-type` 只在字节头认不出时兜底。
 */
function looksLikeImage(bytes: ArrayBuffer, contentType: string): boolean {
  const head = new Uint8Array(bytes.slice(0, 8));
  // PNG / JPEG / GIF / WEBP 的魔数（够覆盖各家静态图了）
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
  if (head[0] === 0xff && head[1] === 0xd8) return true;
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return true;
  if (
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45
  ) {
    return true;
  }
  return contentType.toLowerCase().startsWith('image/');
}
