/**
 * 链接卡纯逻辑单元测试（T2.04–T2.06 / `F2-4-1`–`F2-4-5`）。
 *
 * 这里钉的是四件"错了极难肉眼发现"的事：
 *   1. **谁有资格变成链接卡**（`normalizeUrl`）—— 放行 `javascript:` 是一类安全
 *      事故，把一句普通文本认成 URL 则是"粘贴了没反应"或"凭空多出一张卡"；
 *   2. **域名怎么显示**（`domainOf` / `siteInitialOf`）—— 没抓取过时它是卡片上
 *      唯一的身份信息；
 *   3. **`og:` 标签怎么读**（`parseLinkMeta`）—— 正则写松一点就会把残缺片段当
 *      标题；属性顺序、引号形态、相对地址都是真实网页里天天出现的变体。
 *      `O20` 起还多三样（站点名 / 图标 / 最终网址）与两条"宁可当作没抓到"的取舍：
 *      图标与最终网址**只认 http(s)**，`data:` 与解不开的相对地址一律回落到空串；
 *   4. **三种状态怎么分**（`linkStateOf`）—— `bare` 与 `fetched` 判错，按钮就永远
 *      显示成"获取预览"，用户会以为抓取从来没成功过；
 *   5. **哪些站一个请求都不发**（`isHostBlocked`）—— 黑名单的每一次**漏拦**都会变成
 *      "我明明写了它却还在抓"，而每一次**误拦**都会变成一个静默失败的按钮；
 *      两边的失败都不报错，所以只能在这里钉死。
 */

import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  domainOf,
  isExternalUrl,
  isHostBlocked,
  linkDisplayUrlOf,
  linkSiteNameOf,
  linkStateOf,
  linkTitleOf,
  normalizeBlockedHost,
  normalizeLinkBlocklist,
  normalizeUrl,
  parseLinkMeta,
  resolveUrl,
  siteInitialOf,
} from '../../util/linkPreview';

// ── normalizeUrl ──────────────────────────────────────────────

describe('normalizeUrl', () => {
  it('裸域名补上 https://', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('www.example.com/a/b?q=1')).toBe('https://www.example.com/a/b?q=1');
  });

  it('已带协议的保持协议（不把 http 偷偷升级成 https）', () => {
    expect(normalizeUrl('http://example.com/x')).toBe('http://example.com/x');
    expect(normalizeUrl('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
  });

  it('裸域名带端口也算', () => {
    expect(normalizeUrl('a.com:8080/x')).toBe('https://a.com:8080/x');
  });

  it('★ 拒绝一切非 http(s) 协议', () => {
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('obsidian://open?vault=v')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('data:text/html,<b>x</b>')).toBeNull();
  });

  it('含空白的整段文本不算 URL（"看看这个 https://a.com"不该整句变卡）', () => {
    expect(normalizeUrl('https://a.com 看这个')).toBeNull();
    expect(normalizeUrl('这是一段普通文本')).toBeNull();
  });

  it('空串 / 纯空白 → null', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('前后空白会被修掉（从地址栏复制常带一个换行）', () => {
    expect(normalizeUrl('  https://example.com/x\n')).toBe('https://example.com/x');
  });

  it('两种写法归一成同一个字符串（去重、比较因此不必再考虑写法差异）', () => {
    expect(normalizeUrl('https://a.com')).toBe(normalizeUrl('https://a.com/'));
  });
});

describe('isExternalUrl', () => {
  it('只认 http(s)', () => {
    expect(isExternalUrl('https://a.com/x.png')).toBe(true);
    expect(isExternalUrl('assets/a.png')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
  });
});

// ── 域名 ──────────────────────────────────────────────────────

describe('domainOf', () => {
  it('去掉 www.（卡片上这一行越短越好认）', () => {
    expect(domainOf('https://www.example.com/a')).toBe('example.com');
    expect(domainOf('https://sub.example.com/')).toBe('sub.example.com');
  });

  it('解析失败返回空串而不是抛错', () => {
    expect(domainOf('not a url')).toBe('');
    expect(domainOf('')).toBe('');
  });
});

describe('siteInitialOf', () => {
  it('取域名的第一个字母并大写', () => {
    expect(siteInitialOf('https://example.com')).toBe('E');
    expect(siteInitialOf('https://1password.com')).toBe('1');
  });

  it('给不出域名时用 `?` 兜底', () => {
    expect(siteInitialOf('')).toBe('?');
  });
});

describe('resolveUrl', () => {
  it('相对地址按页面地址补全', () => {
    expect(resolveUrl('https://a.com/post/1', '/og.png')).toBe('https://a.com/og.png');
    expect(resolveUrl('https://a.com/post/1', 'og.png')).toBe('https://a.com/post/og.png');
  });

  it('协议相对地址继承页面协议', () => {
    expect(resolveUrl('https://a.com/', '//cdn.a.com/x.png')).toBe('https://cdn.a.com/x.png');
  });

  it('空值 / 解不开的地址返回 null', () => {
    expect(resolveUrl('https://a.com/', '   ')).toBeNull();
    expect(resolveUrl('不是地址', 'x.png')).toBeNull();
  });
});

// ── 实体解码 ──────────────────────────────────────────────────

describe('decodeEntities', () => {
  it('常见命名实体', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(
      'a & b <c> "d" \'e\'',
    );
  });

  it('`&nbsp;` 归一成普通空格（标题里一个不换行空格会让省略号排版出错）', () => {
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
  });

  it('数字实体（十进制与十六进制）', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('越界 / 认不出的实体原样留着，不抛错', () => {
    expect(decodeEntities('&#9999999;')).toBe('&#9999999;');
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });
});

// ── parseLinkMeta ─────────────────────────────────────────────

const PAGE = 'https://example.com/post/1';

describe('parseLinkMeta', () => {
  it('优先 og:，其次 twitter:，最后 `<title>`', () => {
    const html = `
      <html><head>
        <title>普通标题</title>
        <meta name="twitter:title" content="推特标题">
        <meta property="og:title" content="OG 标题">
      </head></html>`;
    expect(parseLinkMeta(html, PAGE).title).toBe('OG 标题');
  });

  it('只有 `<title>` 时用它', () => {
    const html = '<html><head><title>只有它</title></head></html>';
    expect(parseLinkMeta(html, PAGE).title).toBe('只有它');
  });

  it('描述按 og → twitter → name="description" 回落', () => {
    expect(parseLinkMeta('<meta name="description" content="普通描述">', PAGE).description).toBe(
      '普通描述',
    );
    expect(
      parseLinkMeta(
        '<meta name="description" content="普通描述"><meta property="og:description" content="OG 描述">',
        PAGE,
      ).description,
    ).toBe('OG 描述');
  });

  it('★ 属性顺序颠倒、单引号、无引号都能读（真实网页三种都有）', () => {
    expect(parseLinkMeta(`<meta content="先内容后属性" property="og:title">`, PAGE).title).toBe(
      '先内容后属性',
    );
    expect(parseLinkMeta(`<meta property='og:title' content='单引号'>`, PAGE).title).toBe('单引号');
    expect(parseLinkMeta(`<meta property=og:title content=裸值>`, PAGE).title).toBe('裸值');
  });

  it('同一属性出现多次时取第一个（`og:image` 常常有多张，第一张是主图）', () => {
    const html = `
      <meta property="og:image" content="https://cdn.a.com/1.png">
      <meta property="og:image" content="https://cdn.a.com/2.png">`;
    expect(parseLinkMeta(html, PAGE).image).toBe('https://cdn.a.com/1.png');
  });

  it('★ 相对地址的 og:image 用页面地址补全（否则图永远裂着）', () => {
    expect(parseLinkMeta('<meta property="og:image" content="/og.png">', PAGE).image).toBe(
      'https://example.com/og.png',
    );
  });

  it('`og:image:url` 与 `twitter:image` 作为回退', () => {
    expect(
      parseLinkMeta('<meta property="og:image:url" content="https://a.com/x.png">', PAGE).image,
    ).toBe('https://a.com/x.png');
    expect(
      parseLinkMeta('<meta name="twitter:image" content="https://a.com/y.png">', PAGE).image,
    ).toBe('https://a.com/y.png');
  });

  it('标题与描述里的换行 / 多余缩进被折叠', () => {
    const html = '<meta property="og:title" content="第一行\n    第二行">';
    expect(parseLinkMeta(html, PAGE).title).toBe('第一行 第二行');
  });

  it('空 HTML / 没有 meta：标题/描述/图片全空且不抛错（图标退到 favicon 兜底）', () => {
    // ★ `O20` 之后解析层**永远**把这六个键都给出（空值 = 空串），
    //   所以这里用 `toEqual` 钉住整份形状：少一个键就说明有人在某处偷偷改成可选了
    const EMPTY = {
      title: '',
      description: '',
      image: '',
      siteName: '',
      // `O23`：连 `<link>` / `<img>` 都没有时，图标兜底到站点根 `/favicon.ico`
      icon: 'https://example.com/favicon.ico',
      finalUrl: '',
    };
    expect(parseLinkMeta('', PAGE)).toEqual(EMPTY);
    expect(parseLinkMeta('<html><body>正文</body></html>', PAGE)).toEqual(EMPTY);
  });

  it('实体在 meta 内容里被解码（`&amp;` 该显示成 `&`）', () => {
    expect(parseLinkMeta('<meta property="og:title" content="A &amp; B">', PAGE).title).toBe(
      'A & B',
    );
  });

  it('属性存在但内容为空时不占位（空值不该压过下一档回退）', () => {
    const html = '<meta property="og:title" content=""><title>兜底标题</title>';
    expect(parseLinkMeta(html, PAGE).title).toBe('兜底标题');
  });

  // ── O20 新增的三样：站点名 / 图标 / 最终网址 ──────────────

  it('站点名读 `og:site_name`（没有就是空串，不猜域名）', () => {
    expect(parseLinkMeta('<meta property="og:site_name" content="少数派">', PAGE).siteName).toBe(
      '少数派',
    );
    expect(parseLinkMeta('<meta property="og:title" content="只有标题">', PAGE).siteName).toBe('');
  });

  it('站点名里的换行 / 缩进同样被折叠', () => {
    const html = '<meta property="og:site_name" content="  少数\n   派  ">';
    expect(parseLinkMeta(html, PAGE).siteName).toBe('少数 派');
  });

  it('★ 图标读 `<link rel="…icon…">` 并补成全地址', () => {
    expect(parseLinkMeta('<link rel="icon" href="/favicon.ico">', PAGE).icon).toBe(
      'https://example.com/favicon.ico',
    );
    // 协议相对地址也要能补（CDN 上很常见）
    expect(parseLinkMeta('<link rel="shortcut icon" href="//cdn.a.com/f.ico">', PAGE).icon).toBe(
      'https://cdn.a.com/f.ico',
    );
  });

  it('★ `rel` 是空格分隔的记号集合，`shortcut icon` / `icon shortcut` 都认', () => {
    expect(parseLinkMeta('<link rel="shortcut icon" href="https://a.com/a.ico">', PAGE).icon).toBe(
      'https://a.com/a.ico',
    );
    expect(parseLinkMeta('<link rel="icon shortcut" href="https://a.com/b.ico">', PAGE).icon).toBe(
      'https://a.com/b.ico',
    );
  });

  it('★ `apple-touch-icon` 优先于 `favicon.ico`（前者通常是更大的 PNG）', () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="apple-touch-icon" href="/touch.png">`;
    expect(parseLinkMeta(html, PAGE).icon).toBe('https://example.com/touch.png');
  });

  it('`og:logo` 比任何 `<link>` 都优先（那是页面自己说的"这是我的 logo"）', () => {
    const html = `
      <link rel="apple-touch-icon" href="/touch.png">
      <meta property="og:logo" content="https://cdn.a.com/logo.png">`;
    expect(parseLinkMeta(html, PAGE).icon).toBe('https://cdn.a.com/logo.png');
  });

  it('★ 只认 http(s) 图标：`data:` 声明会被丢掉（退到 favicon 兜底）', () => {
    // 声明是 `data:` → 当作没有 → `O23` 的 `/favicon.ico` 兜底接上
    expect(parseLinkMeta('<link rel="icon" href="data:image/png;base64,AAAA">', PAGE).icon).toBe(
      'https://example.com/favicon.ico',
    );
    // 页面地址本身不可解析时，连 favicon 也补不出来 —— 仍当作没有
    expect(parseLinkMeta('<link rel="icon" href="/favicon.ico">', '不是地址').icon).toBe('');
  });

  it('`rel="shortcut"`（少了 `icon`）太含糊，不收 —— 于是退到 favicon 兜底', () => {
    expect(parseLinkMeta('<link rel="shortcut" href="/f.ico">', PAGE).icon).toBe(
      'https://example.com/favicon.ico',
    );
  });

  it('最终网址读 `og:url` 并补全', () => {
    expect(parseLinkMeta('<meta property="og:url" content="/canonical">', PAGE).finalUrl).toBe(
      'https://example.com/canonical',
    );
    expect(parseLinkMeta('<meta property="og:url" content="https://a.com/x">', PAGE).finalUrl).toBe(
      'https://a.com/x',
    );
  });

  it('`og:url` 不是 http(s) 时当作没有（别把 `javascript:` 写进卡片）', () => {
    expect(
      parseLinkMeta('<meta property="og:url" content="javascript:alert(1)">', PAGE).finalUrl,
    ).toBe('');
  });

  // ── O23：DOM 兜底（没有规范 Meta 标签的页面） ────────────

  it('★ 没有 og / `<title>` 时，标题回落到首个 `<h1>`', () => {
    const html = '<html><body><h1>文章大标题</h1><p>正文</p></body></html>';
    expect(parseLinkMeta(html, PAGE).title).toBe('文章大标题');
  });

  it('★ 没有 `<h1>` 时回落到首个 `<h2>`（且 h1 永远优先，哪怕它排在后面）', () => {
    expect(parseLinkMeta('<h2>二级标题</h2>', PAGE).title).toBe('二级标题');
    expect(parseLinkMeta('<h2>二级</h2><h1>一级</h1>', PAGE).title).toBe('一级');
  });

  it('`<h1>` 里的内联标签与实体被清掉（`<span>` / `&amp;`）', () => {
    const html = '<h1>多数派<span> · 少数派</span> &amp; 友商</h1>';
    expect(parseLinkMeta(html, PAGE).title).toBe('多数派 · 少数派 & 友商');
  });

  it('★ 没有描述标签时，摘要回落到首个 `<p>`（超长截断到 100 字 + 省略号）', () => {
    const html = '<p>  这是第一段   正文  </p><p>第二段不要</p>';
    expect(parseLinkMeta(html, PAGE).description).toBe('这是第一段 正文');

    const long = `<p>${'字'.repeat(150)}</p>`;
    const parsed = parseLinkMeta(long, PAGE).description;
    expect(parsed.endsWith('…')).toBe(true);
    expect(parsed.length).toBe(101); // 100 字 + 省略号
  });

  it('★ og 标签存在时，DOM 兜底**不抢**（优先级一字不变）', () => {
    const html = `
      <meta property="og:title" content="OG 标题">
      <meta property="og:description" content="OG 描述">
      <h1>不该用我</h1><p>也不该用我</p>`;
    const meta = parseLinkMeta(html, PAGE);
    expect(meta.title).toBe('OG 标题');
    expect(meta.description).toBe('OG 描述');
  });

  it('★ 没有声明图标时，找带 `logo` 关键词的 `<img>` 并补全', () => {
    expect(parseLinkMeta('<img class="site-logo" src="/img/logo.png">', PAGE).icon).toBe(
      'https://example.com/img/logo.png',
    );
    // `alt` / `id` 里的 logo 也算（不同站写法不同）
    expect(parseLinkMeta('<img id="brandLogo" src="//cdn.a.com/b.png">', PAGE).icon).toBe(
      'https://cdn.a.com/b.png',
    );
  });

  it('★ `<img>` 也不带 logo 时，图标兜底到站点根 `/favicon.ico`', () => {
    expect(parseLinkMeta('<body><img src="/photo.png">纯文本</body>', PAGE).icon).toBe(
      'https://example.com/favicon.ico',
    );
  });

  it('`<img>` 里的候选必须是 http(s)（`data:` 图不当图标）', () => {
    const html = '<img class="logo" src="data:image/png;base64,AAAA">';
    // data: 被丢掉后仍会退到 favicon 兜底
    expect(parseLinkMeta(html, PAGE).icon).toBe('https://example.com/favicon.ico');
  });
});

// ── 状态 ──────────────────────────────────────────────────────

describe('linkStateOf', () => {
  it('没有 URL → empty（刚建出来，不是"抓取失败"）', () => {
    expect(linkStateOf({ url: '', fetchedAt: null })).toBe('empty');
    expect(linkStateOf({ url: '   ', fetchedAt: null })).toBe('empty');
  });

  it('有 URL 没抓过 → bare（显示"域名 + 获取预览"）', () => {
    expect(linkStateOf({ url: 'https://a.com/', fetchedAt: null })).toBe('bare');
  });

  it('抓过 → fetched', () => {
    expect(linkStateOf({ url: 'https://a.com/', fetchedAt: '2026-09-11T00:00:00.000Z' })).toBe(
      'fetched',
    );
  });

  it('★ 判据是 `fetchedAt` 而不是"标题非空"：没有标题的站点也该记住"抓过了"', () => {
    expect(linkStateOf({ url: 'https://a.com/', fetchedAt: '2026-09-11T00:00:00.000Z' })).toBe(
      'fetched',
    );
  });
});

describe('linkTitleOf', () => {
  it('有标题用标题', () => {
    expect(linkTitleOf({ url: 'https://a.com/x', title: '标题' })).toBe('标题');
  });

  it('没有标题回落到域名（不是整条 URL —— 卡片上放不下）', () => {
    expect(linkTitleOf({ url: 'https://www.a.com/x/y/z', title: '' })).toBe('a.com');
  });

  it('URL 也不合法时退回原串（总比空着强）', () => {
    expect(linkTitleOf({ url: '还不是地址', title: '' })).toBe('还不是地址');
  });

  it('★ 有 `finalUrl` 时回落链看的是**展开后的**域名（短链的标题不该是 `b23.tv`）', () => {
    expect(
      linkTitleOf({
        url: 'https://b23.tv/abc',
        finalUrl: 'https://www.bilibili.com/video/BV1',
        title: '',
      }),
    ).toBe('bilibili.com');
  });
});

// ── 展示用的地址与站点名（O20） ────────────────────────────────

describe('linkDisplayUrlOf', () => {
  it('有 `finalUrl` 用它（短链展开后的真实地址）', () => {
    expect(
      linkDisplayUrlOf({
        url: 'https://b23.tv/abc',
        finalUrl: 'https://www.bilibili.com/video/BV1',
      }),
    ).toBe('https://www.bilibili.com/video/BV1');
  });

  it('没有（或空串）时回到用户粘的那条 `url`', () => {
    expect(linkDisplayUrlOf({ url: 'https://a.com/x' })).toBe('https://a.com/x');
    expect(linkDisplayUrlOf({ url: 'https://a.com/x', finalUrl: '   ' })).toBe('https://a.com/x');
  });
});

describe('linkSiteNameOf', () => {
  it('有站点名用站点名（这是那一行最准的答案）', () => {
    expect(
      linkSiteNameOf({ url: 'https://www.bilibili.com/video/BV1', siteName: '哔哩哔哩' }),
    ).toBe('哔哩哔哩');
  });

  it('没有站点名回落到展示地址的域名', () => {
    expect(linkSiteNameOf({ url: 'https://www.a.com/x', siteName: '' })).toBe('a.com');
    expect(linkSiteNameOf({ url: 'https://b23.tv/abc', finalUrl: 'https://www.a.com/x' })).toBe(
      'a.com',
    );
  });

  it('域名也解不出时退回原串（总比空着强）', () => {
    expect(linkSiteNameOf({ url: '还不是地址' })).toBe('还不是地址');
  });
});

// ── 域名黑名单（T6.06 / F2-4-6） ──────────────────────────────

describe('normalizeBlockedHost', () => {
  it('从地址栏粘来的整条 URL 收成域名', () => {
    expect(normalizeBlockedHost('https://www.bilibili.com/video/BV1?spm=1#t=2')).toBe(
      'bilibili.com',
    );
    // 没有 `www.` 的也一样（用户很少会特意加）
    expect(normalizeBlockedHost('http://bilibili.com/')).toBe('bilibili.com');
  });

  it('只写域名时原样通过（最常见的那种写法）', () => {
    expect(normalizeBlockedHost('bilibili.com')).toBe('bilibili.com');
  });

  it('大小写与首尾空白都收敛掉（用户不会在意这些）', () => {
    expect(normalizeBlockedHost('  BiliBili.COM  ')).toBe('bilibili.com');
  });

  it('★ 端口与 `user@` 前缀一并剥掉：不剥的话用户看到的是一条"写了也没用"的规则', () => {
    // 从某些后台 / 调试工具复制来的链接会带端口和用户信息，真实存在
    expect(normalizeBlockedHost('example.com:8443/x')).toBe('example.com');
    expect(normalizeBlockedHost('https://user@example.com/x')).toBe('example.com');
  });

  it('`*.` 前缀被剥掉：本实现本来就是整站级匹配，这层前缀只是把意图写明白', () => {
    expect(normalizeBlockedHost('*.bilibili.com')).toBe('bilibili.com');
  });

  it('收不出东西时返回空串（交给调用方丢掉，而不是留一条空规则）', () => {
    expect(normalizeBlockedHost('')).toBe('');
    expect(normalizeBlockedHost('   ')).toBe('');
    // 只有协议 / 只有路径 —— 归不出域名，宁可丢掉
    expect(normalizeBlockedHost('https://')).toBe('');
  });
});

describe('normalizeLinkBlocklist', () => {
  it('逐行收成域名、去重（粘贴一列 URL 时重复是常态）', () => {
    expect(
      normalizeLinkBlocklist([
        'https://BiliBili.com/x?utm=a',
        'bilibili.com',
        '  www.bilibili.com  ',
        'example.com',
      ]),
    ).toEqual(['bilibili.com', 'example.com']);
  });

  it('坏数据一律丢掉，绝不让它流进每次抓取都要扫的那份列表', () => {
    expect(normalizeLinkBlocklist(null)).toEqual([]);
    expect(normalizeLinkBlocklist('bilibili.com')).toEqual([]);
    expect(normalizeLinkBlocklist([1, '', '   ', null, 'a.com'])).toEqual(['a.com']);
  });
});

describe('isHostBlocked', () => {
  const blocked = ['bilibili.com', 'example.com'];

  it('命中主域', () => {
    expect(isHostBlocked('https://bilibili.com/', blocked)).toBe(true);
  });

  it('★ 命中子域（含 `www.`）：只做精确匹配的话，"封了主域却挡不住 m." 等于没封', () => {
    expect(isHostBlocked('https://m.bilibili.com/x', blocked)).toBe(true);
    expect(isHostBlocked('https://www.bilibili.com/x', blocked)).toBe(true);
    expect(isHostBlocked('https://api.v2.example.com/x', blocked)).toBe(true);
  });

  it('★ 不误伤"只是拿域名当了后缀"的站（`endsWith(域名)` 会在这里出假阳性）', () => {
    expect(isHostBlocked('https://notbilibili.com/', blocked)).toBe(false);
    expect(isHostBlocked('https://bilibili.com.evil.net/', blocked)).toBe(false);
  });

  it('黑名单为空 → 谁都不拦', () => {
    expect(isHostBlocked('https://bilibili.com/', [])).toBe(false);
  });

  it('解不出域名时返回 false（拦的是"确定要拦的"，不是"看不出是什么的"）', () => {
    expect(isHostBlocked('还不是地址', blocked)).toBe(false);
    expect(isHostBlocked('', blocked)).toBe(false);
  });
});
