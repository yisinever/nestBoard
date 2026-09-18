import { describe, expect, it } from 'vitest';
import {
  MAP_TILE_PROVIDERS,
  coordsText,
  mapLinkLabel,
  parseMapLink,
  staticMapRequest,
  type MapLink,
  type StaticMapOptions,
} from '../../util/mapUrl';

/** 解析成功并断言服务商，省得每个用例都写一遍非空断言 */
function parse(text: string): MapLink {
  const link = parseMapLink(text);
  expect(link, text).not.toBeNull();
  return link!;
}

const options = (over: Partial<StaticMapOptions> = {}): StaticMapOptions => ({
  provider: 'osm',
  key: '',
  width: 640,
  height: 360,
  ...over,
});

describe('parseMapLink：各家分享链接的形态', () => {
  it('Google：地址栏那串 `@lat,lon,zoomz`', () => {
    const link = parse('https://www.google.com/maps/@39.9042,116.4074,15z?hl=zh-CN');
    expect(link).toMatchObject({ provider: 'google', lat: 39.9042, lon: 116.4074, zoom: 15 });
  });

  it('Google：`!3d…!4d…`（"分享"按钮复制出来的常常是这种）', () => {
    const link = parse(
      'https://www.google.com/maps/place/天安门/@39.9,116.4,17z/data=!3m1!4b1!4m5!3m4!1s0x0!8m2!3d39.9055!4d116.3976',
    );
    // `@` 那一段在路径里排在前面，`!3d!4d` 是**落点** —— 两者都可能不一样，
    // 但 `@` 是"当前取景中心"，先认它（与浏览器里看到的一致）
    expect(link).toMatchObject({ provider: 'google', lat: 39.9, lon: 116.4 });
  });

  it('Google：`?q=lat,lon`，以及 `q=loc:` 前缀', () => {
    expect(parse('https://maps.google.com/?q=39.9042,116.4074')).toMatchObject({
      lat: 39.9042,
      lon: 116.4074,
      zoom: null,
    });
    expect(parse('https://maps.google.com/?q=loc:39.9042,116.4074')).toMatchObject({
      lat: 39.9042,
      lon: 116.4074,
    });
  });

  it('Apple：`?ll=lat,lon`', () => {
    expect(parse('https://maps.apple.com/?ll=39.9042,116.4074&q=天安门')).toMatchObject({
      provider: 'apple',
      lat: 39.9042,
      lon: 116.4074,
    });
  });

  it('★ 高德：`position` 是**经度在前**（认错了地图会跑到索马里外海）', () => {
    const link = parse('https://uri.amap.com/marker?position=116.4074,39.9042&name=天安门');
    expect(link).toMatchObject({ provider: 'amap', lat: 39.9042, lon: 116.4074 });
  });

  it('★ 高德：`lat` 与 `lng` 分别标名时与"谁在前"无关', () => {
    expect(parse('https://ditu.amap.com/regeo?lng=116.4074&lat=39.9042')).toMatchObject({
      provider: 'amap',
      lat: 39.9042,
      lon: 116.4074,
    });
  });

  it('百度：`latlng=lat,lng`（与高德相反，纬度在前）', () => {
    expect(
      parse('https://api.map.baidu.com/geocoder?latlng=39.9042,116.4074&output=html'),
    ).toMatchObject({
      provider: 'baidu',
      lat: 39.9042,
      lon: 116.4074,
    });
  });

  it('OSM：`#map=zoom/lat/lon`（坐标在 fragment 里，`search` 里什么都没有）', () => {
    expect(parse('https://www.openstreetmap.org/#map=15/39.9042/116.4074')).toMatchObject({
      provider: 'osm',
      lat: 39.9042,
      lon: 116.4074,
      zoom: 15,
    });
  });

  it('OSM：`?mlat=&mlon=`', () => {
    expect(
      parse('https://www.openstreetmap.org/?mlat=39.9042&mlon=116.4074#map=15/39.9042/116.4074'),
    ).toMatchObject({ provider: 'osm', lat: 39.9042, lon: 116.4074 });
  });

  it('只写了一对坐标（手敲也认）', () => {
    expect(parse('39.9042, 116.4074')).toMatchObject({
      provider: 'unknown',
      lat: 39.9042,
      lon: 116.4074,
    });
    expect(parse('（39.9042，116.4074）')).toMatchObject({ lat: 39.9042, lon: 116.4074 });
  });

  it('`geo:` URI（系统级分享出来的那一种）', () => {
    expect(parse('geo:39.9042,116.4074?z=15')).toMatchObject({
      lat: 39.9042,
      lon: 116.4074,
      zoom: 15,
    });
  });

  it('认不出的主机也照样解析：`lat` + `lng` 是无歧义的', () => {
    expect(parse('https://example.com/where?lat=39.9042&lng=116.4074')).toMatchObject({
      provider: 'unknown',
      lat: 39.9042,
      lon: 116.4074,
    });
  });
});

describe('parseMapLink：认不出来的一律返回 null（绝不猜一个坐标）', () => {
  it('★ 短链（`maps.app.goo.gl` / `amap.com/xxx`）：要发一次 HTTP 才展开，我们不猜', () => {
    expect(parseMapLink('https://maps.app.goo.gl/abcdEFGH1234')).toBeNull();
    expect(parseMapLink('https://surl.amap.com/2xYzAb1c3d')).toBeNull();
  });

  it('地点页 / 首页：链接合法，但里面没有坐标', () => {
    expect(parseMapLink('https://www.google.com/maps/place/天安门')).toBeNull();
    expect(parseMapLink('https://www.amap.com/')).toBeNull();
  });

  it('★ 越界的数字（纬度 91 / 经度 200）：看着像坐标，但不是', () => {
    expect(parseMapLink('91.0,116.4')).toBeNull();
    expect(parseMapLink('163.0,116.4')).toBeNull();
    expect(parseMapLink('39.9042,200.0')).toBeNull();
    expect(parseMapLink('https://maps.google.com/?q=91,116')).toBeNull();
  });

  it('不是链接也不是坐标的文本', () => {
    expect(parseMapLink('')).toBeNull();
    expect(parseMapLink('   ')).toBeNull();
    expect(parseMapLink('今天下午三点开会')).toBeNull();
    expect(parseMapLink('https://example.com/')).toBeNull();
  });

  it('★ 剪贴板里可能是一整篇文档：超长文本直接不看', () => {
    expect(parseMapLink('39.9042,116.4074'.padEnd(5000, '啊'))).toBeNull();
  });
});

// ── 地点名（O08）──────────────────────────────────────────────
// ★ 这一组钉的是"什么**不是**地名"：坐标那串数字看起来也是一段文字，
//   把它当地名会得到一张叫「39.9,116.4」的地图卡 —— 用户看到的是一个鬼复读自己。
describe('parseMapLink：地点名（O08）', () => {
  it('Google `/maps/place/天安门`：路径里那一段就是名字（百分号编码要解开）', () => {
    const link = parse(
      'https://www.google.com/maps/place/%E5%A4%A9%E5%AE%89%E9%97%A8/@39.9042,116.4074,15z',
    );
    expect(link.label).toBe('天安门');
  });

  it('Google `?q=天安门`：不是坐标的那一段就是名字（整条链接里只有它说的是"什么地方"）', () => {
    const link = parse('https://maps.google.com/?q=天安门&center=39.9042,116.4074');
    expect(link).toMatchObject({ lat: 39.9042, lon: 116.4074 });
    expect(link.label).toBe('天安门');
  });

  it('★ `?q=39.9042,116.4074` 里的 q 是**搜索词**，不是地名', () => {
    expect(parse('https://maps.google.com/?q=39.9042,116.4074').label).toBe('');
  });

  it('★ `q=天安门 (39.9042, 116.4074)`：括号里那串是坐标，名字只取括号前那一截', () => {
    expect(parse('https://maps.google.com/?q=天安门 (39.9042, 116.4074)').label).toBe('天安门');
  });

  it('高德 `&name=`：用户自己在地图上选的点名，最可信', () => {
    const link = parse('https://uri.amap.com/marker?position=116.4074,39.9042&name=天安门');
    expect(link).toMatchObject({ provider: 'amap', lat: 39.9042, lon: 116.4074 });
    expect(link.label).toBe('天安门');
  });

  it('认不出名字时是**空串**而不是 null（调用方少一层判断）', () => {
    expect(parse('https://maps.apple.com/?ll=39.9042,116.4074').label).toBe('');
    expect(parse('39.9042,116.4074').label).toBe('');
  });

  it('名字超长时截断：卡面的标题行放不下更多，链接里也从不会更长', () => {
    const long = '天'.repeat(200);
    const link = parse(`https://maps.google.com/?q=${long}&center=39.9,116.4`);
    expect(link.label.length).toBe(80);
  });

  it('半截的 `%` 不能让整条链接解析失败（剪贴板里什么都可能有）', () => {
    const link = parseMapLink('https://maps.google.com/maps/place/%E5%A4/@39.9,116.4,15z');
    expect(link).not.toBeNull();
    expect(link!.lat).toBe(39.9);
  });
});

describe('coordsText / mapLinkLabel', () => {
  it('四位小数、纬度在前 —— 没图时卡上显示的就是它', () => {
    expect(
      mapLinkLabel({
        provider: 'google',
        lat: 39.9042567,
        lon: 116.4074123,
        zoom: null,
        label: '',
      }),
    ).toBe('39.9043, 116.4074');
    expect(coordsText(39.9042567, 116.4074123)).toBe('39.9043, 116.4074');
  });
});

describe('MAP_TILE_PROVIDERS', () => {
  it('第一档是「不出图」：面板上排第一个的必须是那个不会联网的选项', () => {
    expect(MAP_TILE_PROVIDERS[0]).toBe('none');
    expect([...MAP_TILE_PROVIDERS].sort()).toEqual(['amap', 'google', 'none', 'osm']);
  });
});

describe('staticMapRequest：拼一条静态图地址', () => {
  const link = parse('https://www.google.com/maps/@39.9042,116.4074,15z');

  it('`none`（默认）→ 不拼，一个字都不发', () => {
    expect(staticMapRequest(link, options({ provider: 'none' }))).toBeNull();
  });

  it('OSM 社区静态图：不需要 key，经纬度写成 `lat,lon`', () => {
    const url = staticMapRequest(link, options())!;
    expect(url).toContain('staticmap.openstreetmap.de');
    expect(url).toContain('center=39.9042,116.4074');
    expect(url).toContain('zoom=15');
    expect(url).toContain('size=640x360');
    expect(url).toContain('markers=39.9042,116.4074,red-pushpin');
  });

  it('★ Google / 高德缺 key → null（与其发一个必定 401 的请求，不如当场说清楚）', () => {
    expect(staticMapRequest(link, options({ provider: 'google' }))).toBeNull();
    expect(staticMapRequest(link, options({ provider: 'amap' }))).toBeNull();
    expect(staticMapRequest(link, options({ provider: 'google', key: '   ' }))).toBeNull();
  });

  it('★ 高德：`location` 经度在前、`size` 用 `*` 分隔（写成 `x` 会被忽略，然后回一张默认尺寸的图）', () => {
    const url = staticMapRequest(link, options({ provider: 'amap', key: 'KEY' }))!;
    expect(url).toContain('location=116.4074,39.9042');
    expect(url).toContain('size=640*360');
    expect(url).toContain('markers=mid,,A:116.4074,39.9042');
    expect(url).toContain('key=KEY');
  });

  it('Google：带 `scale=2` 与标记', () => {
    const url = staticMapRequest(link, options({ provider: 'google', key: 'K EY' }))!;
    expect(url).toContain('center=39.9042,116.4074');
    expect(url).toContain('scale=2');
    expect(url).toContain('key=K%20EY');
  });

  it('★ 缩放级别按各家的范围夹回来（高德 3–18、OSM 1–18、Google 0–21）', () => {
    const low = { provider: 'google' as const, lat: 1, lon: 2, zoom: 0, label: '' };
    const high = { provider: 'google' as const, lat: 1, lon: 2, zoom: 25, label: '' };
    expect(staticMapRequest(low, options({ provider: 'google', key: 'k' }))).toContain('zoom=0');
    expect(staticMapRequest(high, options({ provider: 'google', key: 'k' }))).toContain('zoom=21');
    expect(staticMapRequest(high, options({ provider: 'amap', key: 'k' }))).toContain('zoom=18');
    expect(staticMapRequest(high, options({ provider: 'osm' }))).toContain('zoom=18');
  });

  it('没带缩放级别时用默认值 15', () => {
    const noZoom = parse('39.9042,116.4074');
    expect(staticMapRequest(noZoom, options())).toContain('zoom=15');
  });

  it('尺寸夹进各家上限', () => {
    expect(staticMapRequest(link, options({ width: 5000, height: 10 }))).toContain('size=1024x64');
    expect(
      staticMapRequest(link, options({ provider: 'google', key: 'k', width: 5000, height: 10 })),
    ).toContain('size=640x64');
  });

  it('二次防线：越界的经纬度不拼地址', () => {
    expect(
      staticMapRequest({ provider: 'osm', lat: 91, lon: 0, zoom: null, label: '' }, options()),
    ).toBeNull();
  });
});
