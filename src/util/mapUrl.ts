/**
 * 地图分享链接 ↔ 经纬度 ↔ 静态图地址（`O08`）。**纯函数**：不 import obsidian、
 * 不碰网络、不发请求 —— 真正去下载的那一步在 `integration/ObsidianMapTileBridge.ts`。
 *
 * 这一层单独拆出来的理由与 `util/linkPreview.ts` 完全一样：解析的形态又多又脏
 * （每个服务商一套参数名与坐标顺序），而这恰恰是**最值得一条一条钉死**的部分；
 * 混在"下载 + 落盘"里就只能靠真机点一下看一眼。
 *
 * ## 坐标顺序是个坑，所以按"服务商"分流
 *
 * `39.9042,116.4074`（纬度在前）与 `116.4074,39.9042`（经度在前）都是**合法数字**，
 * 认错了不会报错，只会把地图挪到另一个半球去（北京 ↔ 索马里外海）。所以：
 *
 *  * 先按链接的**主机名**认服务商（`maps.google.com` / `maps.apple.com` / `amap.com` /
 *    `map.baidu.com` / `openstreetmap.org`），再按那一家的约定读参数；
 *  * 认不出主机时才用**无歧义**的形态：`lat` + `lng` 成对出现、`#map=z/lat/lon`、
 *    `@lat,lon`。这几条里经纬度是**分别标名**的，位置反了也没关系。
 *
 * ## 不认识的链接返回 `null`，而不是"尽力猜一个"
 *
 * 与色板卡"认不出的那一格整行判错"同一条：`maps.app.goo.gl/xxxx` 这类短链要发一次
 * HTTP 才展开（重定向到完整地址），我们**不解**它 —— 猜一个坐标出来，用户会在一张
 * 错误的地图上找很久。返回 `null` 时调用方给的是"这个链接认不出来"，
 * 用户把浏览器地址栏里那条完整的粘过来就好。
 */

export type MapProvider = 'google' | 'apple' | 'amap' | 'baidu' | 'osm' | 'unknown';

export interface MapLink {
  provider: MapProvider;
  /** 纬度，`[-90, 90]` */
  lat: number;
  /** 经度，`[-180, 180]` */
  lon: number;
  /** 链接里带的缩放级别（没有就是 `null`，由调用方取默认值） */
  zoom: number | null;
  /**
   * 链接里带的**地点名**（`/maps/place/天安门`、高德的 `name=`、`q=天安门`）。
   * 空串 = 这条链接里只有坐标，没有名字。
   *
   * ★ 卡片只在**自己还没有名字**时才用它，绝不覆盖用户写过的地点名
   *   （见 `BoardView.applyMapLink`）—— 用户手写的那一个永远比链接里的可信。
   */
  label: string;
}

/** 静态图服务（`O08`）。`none` = 不出图，只存链接与坐标 */
export type MapTileProvider = 'none' | 'osm' | 'google' | 'amap';

/**
 * 全部档位，**顺序就是设置面板下拉框里的顺序**。
 *
 * ★ 放在这里而不是设置面板里：`normalizeSettings` 要按它做"这个值认不认"的判定
 *   （认不出就退回不出图），两处各写一份迟早会出现"面板里有这一档、校验却不认"。
 */
export const MAP_TILE_PROVIDERS: readonly MapTileProvider[] = ['none', 'osm', 'google', 'amap'];

export interface StaticMapOptions {
  provider: MapTileProvider;
  /** Google / 高德要的 key。`osm` 那一档不需要；缺 key 时这两档直接返回 `null` */
  key: string;
  /** 请求的图宽高（会按服务商的限制夹一次） */
  width: number;
  height: number;
}

/** 主机名 → 服务商。顺序有意义：`maps.app.goo.gl` 也得落进 `google` */
const PROVIDER_HOSTS: ReadonlyArray<{ provider: MapProvider; pattern: RegExp }> = [
  { provider: 'google', pattern: /(^|\.)(google\.[a-z.]+|goo\.gl)$/ },
  { provider: 'apple', pattern: /(^|\.)maps\.apple\.com$/ },
  { provider: 'amap', pattern: /(^|\.)(amap\.com|gaode\.com)$/ },
  { provider: 'baidu', pattern: /(^|\.)(map\.baidu\.com|baidu\.com)$/ },
  { provider: 'osm', pattern: /(^|\.)openstreetmap\.org$/ },
];

/** 缺省缩放级别：看得见街区的程度。三家各有自己的可取值范围，见 `ZOOM_LIMITS` */
const DEFAULT_ZOOM = 15;

/** 各家的缩放范围（超出会被夹回来，而不是原样发出去等它报错） */
const ZOOM_LIMITS: Record<MapTileProvider, { min: number; max: number }> = {
  none: { min: 1, max: 19 },
  osm: { min: 1, max: 18 },
  google: { min: 0, max: 21 },
  // 高德静态图的文档值就是 3–18；超出会回一张空白图
  amap: { min: 3, max: 18 },
};

/** 各家静态图的尺寸上限（宽高都得夹） */
const SIZE_LIMITS: Record<MapTileProvider, { max: number }> = {
  none: { max: 640 },
  osm: { max: 1024 },
  google: { max: 640 },
  amap: { max: 1024 },
};

/** `39.9042, 116.4074` —— 没图时卡上显示的就是它 */
export function coordsText(lat: number, lon: number): string {
  return `${round4(lat)}, ${round4(lon)}`;
}

/** 同一个格式，参数是一条解析结果。★ 两处都叫这个数，格式必须是同一个 */
export function mapLinkLabel(link: MapLink): string {
  return coordsText(link.lat, link.lon);
}

/**
 * 从一段文本里认出一处坐标。
 *
 * 传进来的通常是**整条链接**（用户从浏览器地址栏复制的那一串），也允许是
 * 只写了一对数字的短文本（`39.9042, 116.4074`）—— 手敲坐标是很自然的一件事。
 * 认不出来返回 `null`，绝不猜。
 */
export function parseMapLink(text: string): MapLink | null {
  const raw = text.trim();
  // 上限纯属防呆：`parseMapLink` 会被"粘贴"这条路直接喂剪贴板内容，
  // 而剪贴板里可能是一整篇文档
  if (raw.length === 0 || raw.length > 4096) return null;

  // ① 整段就是一对坐标（中英文逗号、中英文括号都认：手敲和复制都可能是全角）
  const bare = /^[（(]?\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*[）)]?$/.exec(
    raw,
  );
  if (bare !== null) return makeLink('unknown', bare[1]!, bare[2]!, null, 'lat-lon');

  // ② `geo:39.9042,116.4074?z=15`（安卓 / 系统级分享出来的就是它）
  const geo =
    /^geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\?[^#]*\bz=(\d+(?:\.\d+)?))?/i.exec(raw);
  if (geo !== null) return makeLink('unknown', geo[1]!, geo[2]!, geo[3] ?? null, 'lat-lon');

  const url = toUrl(raw);
  if (url !== null) {
    const provider = providerOf(url.hostname);
    const query = url.searchParams;
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    // 地点名只认一次（各条形态共用）：坐标的读法五花八门，名字的来路就那么几条
    const label = placeLabelOf(url, query);

    // ③ `lat` 与 `lng` / `lon` 分别标了名 —— 这是唯一与"谁在前"无关的形态，先用它
    const latParam = query.get('lat') ?? query.get('mlat');
    const lonParam = query.get('lng') ?? query.get('lon') ?? query.get('long') ?? query.get('mlon');
    if (latParam !== null && lonParam !== null) {
      const link = makeLink(
        provider,
        latParam,
        lonParam,
        query.get('z') ?? query.get('zoom'),
        'lat-lon',
        label,
      );
      if (link !== null) return link;
    }

    // ④ `#map=15/39.9042/116.4074`（OpenStreetMap 的分享形态）
    const hashMap = /(?:^|&)map=(\d+(?:\.\d+)?)\/([-\d.]+)\/([-\d.]+)/.exec(hash);
    if (hashMap !== null) {
      const link = makeLink(provider, hashMap[2]!, hashMap[3]!, hashMap[1]!, 'lat-lon', label);
      if (link !== null) return link;
    }

    // ⑤ `@39.9042,116.4074,15z`（Google / Apple 的地址栏形态，可能出现在路径里）
    const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z?)?/.exec(
      `${url.pathname}${url.search}${url.hash}`,
    );
    if (at !== null) {
      const link = makeLink(provider, at[1]!, at[2]!, at[3] ?? null, 'lat-lon', label);
      if (link !== null) return link;
    }

    // ⑥ `!3d39.9042!4d116.4074`（Google 地图把落点编码在数据段里，分享出来的常常是它）
    const bang = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url.href);
    if (bang !== null) {
      const link = makeLink(provider, bang[1]!, bang[2]!, null, 'lat-lon', label);
      if (link !== null) return link;
    }

    // ⑦ 按各家的参数约定：同样是 `q=`，高德与别人反着来
    const pairs: ReadonlyArray<{ key: string; order: 'lat-lon' | 'lon-lat' }> =
      provider === 'amap'
        ? [
            { key: 'position', order: 'lon-lat' },
            { key: 'center', order: 'lon-lat' },
            { key: 'q', order: 'lat-lon' },
          ]
        : [
            { key: 'll', order: 'lat-lon' },
            { key: 'q', order: 'lat-lon' },
            { key: 'query', order: 'lat-lon' },
            { key: 'center', order: 'lat-lon' },
            { key: 'latlng', order: 'lat-lon' },
            { key: 'location', order: 'lat-lon' },
            { key: 'sll', order: 'lat-lon' },
            { key: 'daddr', order: 'lat-lon' },
          ];
    for (const pair of pairs) {
      const value = latitudeFromLoc(query.get(pair.key));
      if (value === null) continue;
      // `q=loc:39.9,116.4` / `q=39.9,116.4 (天安门)`：取开头那对数，后面的注解不管
      const match = /(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/.exec(value);
      if (match === null) continue;
      const link = makeLink(
        provider,
        match[1]!,
        match[2]!,
        query.get('z') ?? query.get('zoom'),
        pair.order,
        label,
      );
      if (link !== null) return link;
    }
  }

  return null;
}

/** 地点名的字符上限：卡面上的标题行放不下更多，链接里的名字也从来不会更长 */
const MAX_LABEL_CHARS = 80;

/**
 * 链接里"这是个什么地方"那一段。
 *
 * 三个来路，按可信度排：
 *  1. 高德 `marker?position=..&name=天安门` —— 用户自己在地图上选的点名，最准；
 *  2. 路径里的 `/maps/place/天安门`（Google / Apple 的地址栏形态）；
 *  3. `q=` / `query=` / `daddr=` 里**不是坐标**的那一段（`?q=天安门`）。
 *
 * ★ 第 3 条必须排除坐标本身：`?q=39.9,116.4` 里那个 `q` 是"搜索词"，
 *   把它当地点名会得到一张叫"39.9,116.4"的地图卡。
 */
function placeLabelOf(url: URL, query: URLSearchParams): string {
  const named = cleanLabel(decode(query.get('name') ?? query.get('title') ?? ''));
  if (named.length > 0) return named;

  const placed = /\/place\/([^/?#]+)/.exec(url.pathname);
  if (placed !== null) {
    const text = cleanLabel(decode(placed[1]!));
    if (text.length > 0) return text;
  }

  for (const key of ['q', 'query', 'daddr']) {
    const value = query.get(key);
    if (value === null) continue;
    const stripped = value.replace(/^loc:/i, '').trim();
    // 开头就是数字 → 这一串是坐标，不是名字
    if (/^-?\d/.test(stripped)) continue;
    // `q=天安门 (39.9, 116.4)` → 取括号前那一截
    const text = cleanLabel(stripped.replace(/[(（].*$/, '').trim());
    if (text.length > 0) return text;
  }
  return '';
}

function cleanLabel(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_LABEL_CHARS ? text.slice(0, MAX_LABEL_CHARS) : text;
}

/** `decodeURIComponent` 遇到半截的 `%` 会抛 —— 那是剪贴板里的内容，不是我们的 bug */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 按服务商拼一条静态图地址（`O08`）。
 *
 * 返回 `null` 的四种情况都**不是错误**，而是"这一档做不到"：
 *  * `provider === 'none'`：用户没开（默认就是没开，见设置里的说明）；
 *  * 需要 key 而 key 是空的 —— 与其发一个必定 401 的请求，不如当场说清楚；
 *  * 经纬度超出范围（`parseMapLink` 已经挡过一道，这里是二次防线）；
 *  * 认不出的服务商。
 */
export function staticMapRequest(link: MapLink, options: StaticMapOptions): string | null {
  if (options.provider === 'none') return null;
  if (!Number.isFinite(link.lat) || !Number.isFinite(link.lon)) return null;
  if (Math.abs(link.lat) > 90 || Math.abs(link.lon) > 180) return null;

  const limits = ZOOM_LIMITS[options.provider];
  const zoom = clampInt(link.zoom ?? DEFAULT_ZOOM, limits.min, limits.max);
  const max = SIZE_LIMITS[options.provider].max;
  const width = clampInt(options.width, 64, max);
  const height = clampInt(options.height, 64, max);
  const { lat, lon } = { lat: round4(link.lat), lon: round4(link.lon) };
  const key = options.key.trim();

  switch (options.provider) {
    case 'osm':
      // ★ 这一档是**第三方社区服务**（staticmap.openstreetmap.de），不需要 key。
      //   它没有 SLA，也不保证长期可用 —— 设置里就是这么写的。真不能用了就换
      //   自己的 Google / 高德 key，或者把它关掉（`none`）
      return (
        'https://staticmap.openstreetmap.de/staticmap.php' +
        `?center=${lat},${lon}&zoom=${zoom}&size=${width}x${height}` +
        `&markers=${lat},${lon},red-pushpin`
      );
    case 'google':
      if (key.length === 0) return null;
      return (
        'https://maps.googleapis.com/maps/api/staticmap' +
        `?center=${lat},${lon}&zoom=${zoom}&size=${width}x${height}&scale=2` +
        `&markers=color:red%7C${lat},${lon}&key=${encodeURIComponent(key)}`
      );
    case 'amap':
      // ★ 高德两点：`location` 是**经度在前**，`size` 用 `*` 分隔 —— 写成 `x` 会被忽略，
      //   然后收到一张默认尺寸的图（不报错，只是不对）
      if (key.length === 0) return null;
      return (
        'https://restapi.amap.com/v3/staticmap' +
        `?location=${lon},${lat}&zoom=${zoom}&size=${width}*${height}` +
        `&markers=mid,,A:${lon},${lat}&key=${encodeURIComponent(key)}`
      );
    default:
      return null;
  }
}

/** 主机名 → 服务商。认不出就是 `unknown`（仍然会用无歧义的那几条形态试着解析） */
function providerOf(hostname: string): MapProvider {
  const host = hostname.toLowerCase();
  for (const entry of PROVIDER_HOSTS) {
    if (entry.pattern.test(host)) return entry.provider;
  }
  return 'unknown';
}

/** `q=loc:39.9,116.4` 这种前缀取掉，只留坐标那一段 */
function latitudeFromLoc(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/^loc:/i, '');
}

/**
 * 造一个 `MapLink`，顺带把"是不是一对像样的经纬度"验掉。
 *
 * @param order `lat-lon` = 第一个数是纬度；`lon-lat` = 第一个数是经度（高德的 `position`）
 * @param label 地点名，没有就传空串
 */
function makeLink(
  provider: MapProvider,
  first: string,
  second: string,
  zoom: string | null,
  order: 'lat-lon' | 'lon-lat',
  label = '',
): MapLink | null {
  const a = Number.parseFloat(first);
  const b = Number.parseFloat(second);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const lat = order === 'lat-lon' ? a : b;
  const lon = order === 'lat-lon' ? b : a;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const parsedZoom = zoom === null ? Number.NaN : Number.parseFloat(zoom);
  return {
    provider,
    lat: round4(lat),
    lon: round4(lon),
    zoom: Number.isFinite(parsedZoom) ? parsedZoom : null,
    label: cleanLabel(label),
  };
}

/** 补上协议再解析。裸域名（`maps.google.com/...`）在剪贴板里很常见 */
function toUrl(raw: string): URL | null {
  const candidates = [raw, `https://${raw}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate);
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/** 四位小数 ≈ 10 米，够用了；多余的位数只会让标签变长 */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
