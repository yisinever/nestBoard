/**
 * 设置的脏数据收敛（T1.74 / `F11-12`）。
 *
 * `.data.json` 是用户能直接拿编辑器改的普通文件，也可能是几个版本前写下的。
 * 这里测的不是"能不能读到设置"，而是"读到垃圾时会不会把插件带进一个说不清的状态" ——
 * 一个 `"abc"` 混进 `autosaveDebounceMs`，表现是"自动保存再也不触发"，
 * 而用户绝不会想到这跟设置文件有关。
 */

import { describe, expect, it } from 'vitest';
import { RECENT_BOARDS_LIMIT } from '../../constants';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../settings/settings';

describe('normalizeSettings', () => {
  it('从没存过设置时给出一份默认值', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('不是对象的数据（数组 / 字符串 / 数字）退回默认值', () => {
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('认得的字段原样保留', () => {
    expect(
      normalizeSettings({
        newBoardFolder: '我的白板',
        attachmentLocation: 'custom',
        customAttachmentFolder: '附件/白板',
        attachmentNaming: 'original',
        autosaveDebounceMs: 800,
        linkPreview: true,
      }),
    ).toEqual({
      // ★ 先铺一层默认值，再盖上这次传进去的六个字段。
      //   断言的意思因此是"给的字段原样保留、其余是默认值"——写成一张
      //   硬编码的完整对象会把这条测试变成"每加一个设置项就红一次"，
      //   而那种红跟本测试想守的东西（脏数据收敛）毫无关系，
      //   修法也只是把新字段抄进来 —— 久而久之就没人再看它的失败了。
      ...DEFAULT_SETTINGS,
      newBoardFolder: '我的白板',
      attachmentLocation: 'custom',
      customAttachmentFolder: '附件/白板',
      attachmentNaming: 'original',
      autosaveDebounceMs: 800,
      linkPreview: true,
    });
  });

  it('未知字段被丢掉，不跟着流进运行时', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, futureThing: 1 })).toEqual(DEFAULT_SETTINGS);
  });

  it('目录去掉首尾斜杠与空白，并把反斜杠换成斜杠', () => {
    expect(normalizeSettings({ newBoardFolder: '  /Boards/  ' }).newBoardFolder).toBe('Boards');
    // Windows 上从资源管理器把路径粘进来是常见动作，而 `图\白板` 在 Vault 里
    // 是个**不存在**的目录 —— 表现是"附件导入了但看不见"
    expect(normalizeSettings({ newBoardFolder: '图\\白板' }).newBoardFolder).toBe('图/白板');
  });

  it('目录留空是合法值（库根目录），不会被打回默认值', () => {
    expect(normalizeSettings({ newBoardFolder: '   ' }).newBoardFolder).toBe('');
    expect(normalizeSettings({ customAttachmentFolder: '/' }).customAttachmentFolder).toBe('');
  });

  it('目录字段类型不对时退回默认值', () => {
    expect(normalizeSettings({ newBoardFolder: 123 }).newBoardFolder).toBe(
      DEFAULT_SETTINGS.newBoardFolder,
    );
  });

  it('自动保存间隔：坏值回落默认，越界值夹回范围', () => {
    expect(normalizeSettings({ autosaveDebounceMs: 'abc' }).autosaveDebounceMs).toBe(
      DEFAULT_SETTINGS.autosaveDebounceMs,
    );
    expect(normalizeSettings({ autosaveDebounceMs: NaN }).autosaveDebounceMs).toBe(
      DEFAULT_SETTINGS.autosaveDebounceMs,
    );
    expect(normalizeSettings({ autosaveDebounceMs: Infinity }).autosaveDebounceMs).toBe(
      DEFAULT_SETTINGS.autosaveDebounceMs,
    );

    // 0 会被 `setTimeout` 当成"立刻"，等于把防抖关掉了；负数更明显是错的。
    // 两者都夹到下限，而不是回落默认值 —— 用户的意图是"更快"，不是"用默认的"
    expect(normalizeSettings({ autosaveDebounceMs: 0 }).autosaveDebounceMs).toBe(50);
    expect(normalizeSettings({ autosaveDebounceMs: -100 }).autosaveDebounceMs).toBe(50);
    expect(normalizeSettings({ autosaveDebounceMs: 999_999 }).autosaveDebounceMs).toBe(60_000);
    // `setTimeout` 只认整数毫秒，小数留着会在日志里显示成怪值
    expect(normalizeSettings({ autosaveDebounceMs: 123.7 }).autosaveDebounceMs).toBe(124);
  });

  it('枚举字段只认写下来的那两个值', () => {
    expect(normalizeSettings({ attachmentLocation: 'weird' }).attachmentLocation).toBe('vault');
    expect(normalizeSettings({ attachmentNaming: 'weird' }).attachmentNaming).toBe('timestamp');
    // 缺字段的旧数据文件升级上来时，必须落回"跟进 Obsidian 设置"，
    // 而不是突然开始用一个空的自定义目录
    expect(normalizeSettings({ customAttachmentFolder: '附件' }).attachmentLocation).toBe('vault');
  });

  it('附件去重（T6.05）：只有显式 `true` 才算开，缺字段 / 手改的脏值一律当关', () => {
    expect(normalizeSettings({}).attachmentDedupe).toBe(false);
    expect(normalizeSettings({ attachmentDedupe: true }).attachmentDedupe).toBe(true);
    // ★ 去重会**改变已有行为**（同名不同内容的图可能被合并），所以 `.data.json` 里
    //   手改出来的 `"yes"` / `1` 都不该被解释成"用户同意了"——与 `minimap` 同一条规矩
    expect(normalizeSettings({ attachmentDedupe: 'yes' }).attachmentDedupe).toBe(false);
    expect(normalizeSettings({ attachmentDedupe: 1 }).attachmentDedupe).toBe(false);
  });

  it('链接预览开关（O20）：缺字段 → 默认**开**；只有显式 `false` 才算关', () => {
    // ★ 默认值从"关"改成"开"：授权点是**用户那一次点击**（「获取预览」），
    //   这个开关只决定"点下去算不算数"。默认关着的日子里，新用户看到的是一个
    //   点了没反应的按钮 —— 那不是隐私保护，那是看起来坏掉的功能
    expect(normalizeSettings({}).linkPreview).toBe(true);
    expect(normalizeSettings({ linkPreview: true }).linkPreview).toBe(true);
    // ★ 但已经关过的用户**保持关着**：改默认值是一回事，改写用户已经表达过的意思
    //   （他当初真的点过关）是另一回事
    expect(normalizeSettings({ linkPreview: false }).linkPreview).toBe(false);
    // 手改出来的脏值不是"关"（回落默认值）；注意这里**不是**"什么都当同意"——
    // 能关掉它的只有布尔里的那一个 `false`
    expect(normalizeSettings({ linkPreview: 'no' }).linkPreview).toBe(true);
    expect(normalizeSettings({ linkPreview: 0 }).linkPreview).toBe(true);
  });

  it('域名黑名单（T6.06）：缺字段 → 空表；写进去的整条 URL 落盘前就收成域名', () => {
    expect(normalizeSettings({}).linkPreviewBlocklist).toEqual([]);
    expect(
      normalizeSettings({ linkPreviewBlocklist: ['https://BiliBili.com/x?utm=a', 'b.com'] })
        .linkPreviewBlocklist,
    ).toEqual(['bilibili.com', 'b.com']);
    // ★ 坏数据（不是数组 / 混进数字）必须在这里就丢掉：这份列表会被
    //   `isHostBlocked` 在**每一次抓取**时线性扫描，脏元素进来就是每次白扫一遍
    expect(normalizeSettings({ linkPreviewBlocklist: 'b.com' }).linkPreviewBlocklist).toEqual([]);
    expect(normalizeSettings({ linkPreviewBlocklist: [1, null] }).linkPreviewBlocklist).toEqual([]);
  });

  // ── 静态图服务（O08）────────────────────────────────────────────
  // ★ 这一组的共同点：**认不出就一定退回"不出图"**。别的字段认不出最坏是看着不一样，
  //   这个字段认错的表现是"插件自己去联网了"——那是授权范围之外的事。
  describe('静态图服务（O08）', () => {
    it('缺字段（旧数据文件）→ 不出图；这一档默认必须是那个什么都不做的', () => {
      expect(normalizeSettings({}).mapTileProvider).toBe('none');
      expect(normalizeSettings({}).mapTileKey).toBe('');
    });

    it('认得的档位原样保留', () => {
      expect(normalizeSettings({ mapTileProvider: 'osm' }).mapTileProvider).toBe('osm');
      expect(normalizeSettings({ mapTileProvider: 'google' }).mapTileProvider).toBe('google');
      expect(normalizeSettings({ mapTileProvider: 'amap' }).mapTileProvider).toBe('amap');
    });

    it('★ 认不出的取值（含手改的 / 将来才会有的档位）一律退回"不出图"', () => {
      expect(normalizeSettings({ mapTileProvider: 'bing' }).mapTileProvider).toBe('none');
      expect(normalizeSettings({ mapTileProvider: 1 }).mapTileProvider).toBe('none');
      expect(normalizeSettings({ mapTileProvider: null }).mapTileProvider).toBe('none');
    });

    it('key 去首尾空白：从网页上复制常常带上换行', () => {
      expect(normalizeSettings({ mapTileKey: '  abc123\n' }).mapTileKey).toBe('abc123');
      expect(normalizeSettings({ mapTileKey: 42 }).mapTileKey).toBe('');
    });
  });
});

/**
 * Home 白板路径（T5.07 / `F11-09`）。
 *
 * 这一组里最要紧的是**"空串 ≠ 坏数据"**：Home 路径走的是白板路径那一套规则
 * （`util/boardPath.ts`，与 `obsidian://nestboard?file=` 共用），而那一套把空串
 * 判为"拒绝"。要是这里不先把空串捞出来，用户就**永远清不掉**设置里那个输入框 ——
 * 一删就自己长回默认路径。这类"看起来只是校验，实际是可用性 bug"的事，
 * 只有测到了才有人想起来。
 */
describe('normalizeSettings：Home 白板路径', () => {
  it('缺字段（旧数据文件）→ 默认路径', () => {
    expect(normalizeSettings({}).homeBoardPath).toBe(DEFAULT_SETTINGS.homeBoardPath);
  });

  it('空串 / 空白 = **关掉 Home**，不是坏数据（否则输入框清不空）', () => {
    expect(normalizeSettings({ homeBoardPath: '' }).homeBoardPath).toBe('');
    expect(normalizeSettings({ homeBoardPath: '   ' }).homeBoardPath).toBe('');
  });

  it('沿用白板路径那套宽容规则：补扩展名、去前导斜杠、反斜杠转正', () => {
    expect(normalizeSettings({ homeBoardPath: 'Boards/Home' }).homeBoardPath).toBe(
      'Boards/Home.nboard',
    );
    expect(normalizeSettings({ homeBoardPath: '/Boards/Home.nboard' }).homeBoardPath).toBe(
      'Boards/Home.nboard',
    );
    expect(normalizeSettings({ homeBoardPath: 'Boards\\Home.nboard' }).homeBoardPath).toBe(
      'Boards/Home.nboard',
    );
  });

  it('与 `?file=` 同一条规则：填得进设置的路径，就是链接里能用的那个', () => {
    const typed = '资料/我的 板';
    // 设置里归一化出来的结果，应当正好是链接解析器接受并还原的那个路径
    expect(normalizeSettings({ homeBoardPath: typed }).homeBoardPath).toBe('资料/我的 板.nboard');
  });

  it('真的坏了（别的扩展名 / 越界 / 非字符串）→ 回落默认路径，而不是"变成关掉"', () => {
    // ★ 回落默认而不是置空：用户明明填了东西，界面却显示"未启用"，
    //   他没法从现象里诊断出是自己填错了
    expect(normalizeSettings({ homeBoardPath: '笔记/A.md' }).homeBoardPath).toBe(
      DEFAULT_SETTINGS.homeBoardPath,
    );
    expect(normalizeSettings({ homeBoardPath: '../别处/A.nboard' }).homeBoardPath).toBe(
      DEFAULT_SETTINGS.homeBoardPath,
    );
    expect(normalizeSettings({ homeBoardPath: 123 }).homeBoardPath).toBe(
      DEFAULT_SETTINGS.homeBoardPath,
    );
  });
});

/**
 * 「最近打开」（T5.08 / `F7-04`）。
 *
 * 这一组只有一个重点：它是**插件自己写的**字段，而 `data.json` 同时是用户能拿编辑器
 * 直接改的文件 —— 两头都可能塞进奇怪的东西。坏掉时唯一能做的正确选择是"丢掉那一条"，
 * 而不是让整份设置加载失败（那会连带所有白板都打不开，代价完全不成比例）。
 */
describe('normalizeSettings：最近打开', () => {
  it('缺字段（旧数据文件）→ 空列表，而不是 undefined', () => {
    expect(normalizeSettings({}).recentBoards).toEqual([]);
  });

  it('坏数据（不是数组 / 混进非字符串）→ 只丢坏的那几条', () => {
    expect(normalizeSettings({ recentBoards: 'Boards/A.nboard' }).recentBoards).toEqual([]);
    expect(normalizeSettings({ recentBoards: ['A.nboard', 7, null] }).recentBoards).toEqual([
      'A.nboard',
    ]);
  });

  it('顺序原样保留（它就是"最近"这件事本身），并去重去空白', () => {
    expect(normalizeSettings({ recentBoards: [' B ', 'A.nboard', 'B'] }).recentBoards).toEqual([
      'B',
      'A.nboard',
    ]);
  });

  it('超过上限的部分截掉', () => {
    const many = Array.from({ length: RECENT_BOARDS_LIMIT + 3 }, (_unused, i) => `B${i}.nboard`);
    expect(normalizeSettings({ recentBoards: many }).recentBoards).toHaveLength(
      RECENT_BOARDS_LIMIT,
    );
  });
});
