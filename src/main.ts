/**
 * Nestboard 插件入口（唯一 default export）—— T1.05「插件入口与生命周期」。
 *
 * 三条硬性约定（DoD-4 / 03 §7.2）：
 *
 * 1. **onload 里所有 Obsidian 资源都走 `register*`**：
 *    `registerEvent` / `registerDomEvent` / `registerInterval` / `registerView` / `addCommand`。
 *    这样 `onunload` 时 Obsidian 会统一回收，不会出现"重载插件后事件监听器翻倍"。
 * 2. **`onunload` 只释放自建资源**（本插件是 `repository.dispose()`），
 *    已注册的资源不要再手动清理一遍。
 * 3. **本文件只做注册与装配**，不放业务逻辑 —— 逻辑全在 `model/` `io/` `ui/`。
 *
 * 阶段说明：Sprint 2 结束时本插件能「打开 `.nboard` → 无限画布 → 平移缩放 → 记住视口」；
 * 卡片渲染在 T1.24 `CardLayer`。
 */

import { Notice, Plugin, TFile, TFolder, getLanguage } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import { createNewBoard, registerCommands } from './commands';
import { createNewMind, registerMindCommands } from './mind/commands';
import { MindRepository } from './mind/io/MindRepository';
import type { MindRepositoryEvents } from './mind/io/MindRepository';
import { allMindViews } from './mind/view/host';
import { MindView } from './mind/view/MindView';
import {
  BOARD_EXT,
  FLUSH_INTERVAL_MS,
  MIND_EXT,
  SNAPSHOT_PLUGIN_DIR,
  SNAPSHOT_VAULT_DIR,
  VIEW_TYPE_BACKLINK,
  VIEW_TYPE_BOARD,
  VIEW_TYPE_BOARD_LIST,
  VIEW_TYPE_BOARD_SEARCH,
  VIEW_TYPE_CARD_INSPECTOR,
  VIEW_TYPE_MIND,
} from './constants';
import { AttachmentManager, resolveAttachmentFolder } from './io/AttachmentManager';
import type { AttachmentConfig } from './io/AttachmentManager';
import { BoardRegistry } from './io/BoardRegistry';
import { BoardRepository } from './io/BoardRepository';
import type { BoardRepositoryEvents } from './io/BoardRepository';
import { SnapshotStore } from './io/SnapshotStore';
import { ObsidianSnapshotIO } from './io/snapshotIO';
import { ObsidianVaultIO } from './io/vaultIO';
import type { VaultIO } from './io/vaultIO';
import { BacklinkPanelView } from './integration/BacklinkPanel';
import { registerBoardEmbed } from './integration/BoardEmbed';
import { BoardSearchIndex } from './integration/BoardSearchIndex';
import { IndexNoteBridge } from './integration/IndexNoteBridge';
import { LinkIndex, extractBoardDoc } from './integration/LinkIndex';
import { extractMindDoc } from './mind/io/extractLinks';
import { ObsidianAttachmentSink } from './integration/ObsidianAttachmentSink';
import {
  buildNestboardUri,
  NESTBOARD_PROTOCOL,
  parseNestboardUri,
} from './integration/ProtocolHandler';
import type { UriRejection } from './integration/ProtocolHandler';
import { RenameWatcher } from './integration/RenameWatcher';
import { isNotePath } from './model/drop';
import { INDEX_NOTE_BOARD_KEY } from './model/indexNote';
import { TAG_HUB_FOLDER, TAG_HUB_KEY } from './model/tagHub';
import { NestboardSettingTab } from './settings/SettingTab';
import { pushRecentBoards, renameRecentBoards } from './settings/recentBoards';
import { normalizeSettings } from './settings/settings';
import type { NestboardSettings } from './settings/settings';
import { addFileToBoard } from './ui/AddToBoard';
import { BoardListPanelView } from './ui/BoardListPanel';
import { BoardSearchPanelView } from './ui/BoardSearchPanel';
import { CardInspectorPanelView } from './ui/CardInspectorPanel';
import { addFileToUnsorted } from './ui/homeActions';
import { deleteBoardWithConfirm } from './ui/boardActions';
import { importCanvasAtPath } from './ui/canvasActions';
import { notifyConflictCopies, openConflictCompare } from './ui/conflictActions';
import { isConflictBoardPath } from './io/conflict';
import { ConflictModal } from './ui/modals/ConflictModal';
import type { ConflictChoice } from './ui/modals/ConflictModal';
import { debounce } from './util/debounce';
import type { Debounced } from './util/debounce';
import { describeError } from './util/errors';
import { getLocale, setHostLanguage, setLocale, t } from './util/i18n';
import type { MessageKey } from './util/i18n';
import { BoardView } from './view/BoardView';
import { allBoardViews, getActiveBoardView, openBoardView } from './view/BoardViewHost';
// 外观档（原版 / 拟物，`F2`）：一个类切换整套光影规则，写在 `document.body` 上
import { applyBoardStyleClass } from './view/themeVars';
import { fileMenuItems } from './view/interact/fileMenu';
import type { FileMenuAction, FileMenuTarget } from './view/interact/fileMenu';

/**
 * 白板 URI 的三种拒绝理由 → 三句各说各话的提示（T5.06）。
 *
 * ★ 做成映射而不是现场拼 key（`` t(`notice.uri${reason}`) ``）：拼出来的字符串逃不过
 *   类型检查，改名时不会有人提醒你 —— 而这三句恰恰是"链接写错了"时用户唯一的线索。
 */
const URI_REJECTION_NOTICE: Record<UriRejection, MessageKey> = {
  'missing-file': 'notice.protocolMissingFile',
  'not-a-board': 'notice.protocolNotBoard',
  'outside-vault': 'notice.protocolOutsideVault',
};

/**
 * 索引目录迁移的防抖窗口（ms，T7.01）。
 *
 * 设置面板的目录输入框是**逐键 onChange** 的，而迁移要"新目录写一遍 + 旧目录收掉"。
 * 800ms 是"用户停下打字"的粗略门槛：短了会在中间态上搬，长了会让人觉得"改完目录图谱没动"。
 */
const INDEX_RELOCATE_DEBOUNCE_MS = 800;

/** `require` 的两种可能宿主（CJS 模块作用域 / 全局注入），拿不到就说明不在桌面 Electron */
interface RequireHolder {
  require?: (id: string) => unknown;
  module?: { require?: (id: string) => unknown };
}

/**
 * 构建标记（排障用）。
 *
 * ★ 每次改动交互后**改一下这个字符串**：控制台探针第一句就打印它，
 *   于是"改了没生效"与"改了但没重载插件"能一眼分开 ——
 *   这两种情况的排查方向完全不同，靠猜会浪费很多时间。
 */
export const BUILD_TAG = 'index-note · 2026-09-13';

/**
 * 读取库外任意文件的 Node `fs`。
 *
 * ★ **动态**取 `require` 而不是 `import 'fs'`：构建配置把 `platform` 钉在
 *   `browser`（`03 §7.6`，防止误引 Node 内置模块导致移动端崩）。静态引入
 *   `node:fs` 会直接构建失败；这里只在运行时（桌面 Electron 才有）才去拿，
 *   拿不到就返回 `null`，移动端自然退化成"拖库外文件不生效"。
 * ★ 逐一试几种宿主形态：Obsidian 不同版本把 `require` 挂在 `globalThis` 还是
 *   仅模块作用域并不固定，漏试一种就会表现为"桌面端也读不到"。
 */
function loadNodeFs(): { promises: { readFile(path: string): Promise<Uint8Array> } } | null {
  const holder = globalThis as RequireHolder;
  const candidates = [holder.require, holder.module?.require];
  for (const req of candidates) {
    if (typeof req !== 'function') continue;
    try {
      return req('node:fs') as { promises: { readFile(path: string): Promise<Uint8Array> } };
    } catch {
      // 换下一种宿主形态再试
    }
  }
  return null;
}

/**
 * 右键目标 → 菜单规格认得的形状（O12）。
 *
 * ★ 只翻译三个字段，而不是把 `TAbstractFile` 直接递给规格层：那边一旦收下它，
 *   就和 `obsidian` 绑在一起了，也就再也没法在 node 下测"哪种目标有哪些项"。
 * ★ 认不出的子类返回 `null`（与其弹一份空菜单，不如什么都不弹）。
 */
function fileMenuTarget(file: TAbstractFile): FileMenuTarget | null {
  if (file instanceof TFolder) return { folder: true, extension: '', conflict: false };
  if (file instanceof TFile) {
    return { folder: false, extension: file.extension, conflict: isConflictBoardPath(file.path) };
  }
  return null;
}

export default class NestboardPlugin extends Plugin {
  /**
   * **这次构建的标识**（`06 §11.55`）。
   *
   * ★ 排查"改了怎么没生效"时，第一件要问清的就是"跑的是哪一份包"：用户报障里有一大半
   *   其实是旧包（库里没同步 / 换包后没重启 / 解压了更早的 zip）。这个字符串让那件事
   *   一句话可查 —— 设置页（`settings.section.build` 那一节）与控制台
   *   `document.body.dataset.nestboardBuild` 读的是同一个值。
   * ★★ **每次构建时手工更新它**（与 `06 §11.55` 里记的产物一起）。
   */
  readonly buildStamp = '2026-09-23 b108';

  vaultIO!: VaultIO;
  repository!: BoardRepository;
  /**
   * 脑图的仓储（`06 §9` P1）。
   *
   * ★ 与 `repository` **各自一个实例**：两份同六条规则的独立实现，互不影响。
   *   共用的只有 `VaultIO` 端口与 `SnapshotStore` 那个旁路观察者。
   */
  mindRepository!: MindRepository;
  registry!: BoardRegistry;
  /**
   * 跨白板链接索引（T5.01 / T5.02）：内联卡正文里的 `[[链接]]` 与 `#标签`。
   *
   * Obsidian 自己的 `metadataCache` 只索引 `.md`，`.nboard` 里写的链接在它的反链面板
   * 与全局图谱里**根本不存在**（这就是「已知限制：内联卡链接不参与全局图谱」的由来）。
   * 这个索引是插件自己补上的那一块，只读、不写回。
   */
  linkIndex!: LinkIndex;
  /**
   * 跨白板搜索索引（T7.02 / `F8-08`）。
   *
   * 与 `linkIndex` 是**同一类东西**（都得先把全部 `.nboard` 读一遍），但触发时机正相反：
   * `linkIndex` 在加载时就扫（反链面板随时可能被打开），而这个索引**只在用户真的打开
   * 跨白板搜索侧栏时才开始扫** —— 它在内存里留下的是一整份板子模型，代价比链接索引
   * 大得多，让不用这个功能的人付这笔钱没有道理（`R4`：启动读全库白板的 JSON 会卡住插件）。
   */
  boardSearch!: BoardSearchIndex;
  /**
   * 可选「索引笔记」同步桥（T7.01 / `F10-09` / `F7-09`）。
   *
   * `.nboard` 是自定义扩展名，Obsidian 只索引 `.md` —— 于是白板的元信息与内联卡里
   * 写过的 `[[链接]]` 在图谱、搜索、Dataview 里都不存在。打开设置里的开关后，
   * 这个桥会为每块白板维护一份 `.md` 索引笔记（默认关闭）。
   *
   * ★ 它**不认识 Obsidian**：读写、列目录、删文件全部由下面注入的端口提供，
   *   所以"什么时候写、什么时候绝不写"那套判断只靠端口就能测（`03 §7.2`）。
   */
  indexNotes!: IndexNoteBridge;
  /**
   * 索引目录迁移的防抖（T7.01）；见 `INDEX_RELOCATE_DEBOUNCE_MS` 与 `indexRelocateFrom`。
   */
  private scheduleIndexRelocate: Debounced | null = null;
  /**
   * 这一串目录改动**开始之前**的目录 —— 也就是真正要收掉的那一份。
   *
   * ★ 不能拿"上一次的中间值"去搬：连续敲字时每一步的 change 都只说"从上一个中间值到
   *   这个中间值"，而最早那份（用户原来真正在用的）会在这条链里被漏掉，永远留在库里。
   */
  private indexRelocateFrom: string | null = null;
  /**
   * 用户设置（T1.74）。
   *
   * ★ 刻意占用 `Plugin` 自己的 `settings` 槽位（官方注释里写明"在 `onload` 里把读到的
   *   数据赋给它"），而不是另起一个 `nestboardSettings`：这样任何按惯例去找
   *   `plugin.settings` 的代码都能找到它。基类声明为 `unknown`，这里收窄成真实类型。
   *
   * ★ 公开而不是私有：`commands.ts` 的新建路径要从这里读目录，白板视图的粘贴路径
   *   要读附件命名。这些地方都不该再各自 `loadData()` 一遍 —— 那会得到几份可能
   *   不一致的快照，而 `.data.json` 是可以被外部编辑的。
   */
  override settings!: NestboardSettings;
  /**
   * 外部改名跟随（T1.46）。
   *
   * 放在插件级而不是视图级：改名的对象是 Vault 里的笔记，与"此刻开着哪块白板"无关；
   * 视图一关一开不该丢掉订阅，而 `onload` 只建一次的代价也最低。
   */
  private renameWatcher!: RenameWatcher;

  /** 附件导入（T1.49）。**懒建**：不拖不粘的会话根本用不到它，而它握着去重索引 */
  private attachmentsManager: AttachmentManager | null = null;

  /** 已弹出的冲突对话框（同一块白板只弹一个，避免连环弹窗） */
  private readonly conflictDialogs = new Set<string>();

  /** 版本快照（T4.01 / `F11-11`）。`repository` 每次写盘成功都会问它一次 */
  snapshotStore!: SnapshotStore;

  override async onload(): Promise<void> {
    // ★★ **构建戳**（排查"没生效"用，2026-09-17 加）：把这次构建的**唯一标识**写在 DOM 与
    //   控制台上 —— 于是"现场跑的到底是哪一版"从一个猜谜变成一句话：
    //     Obsidian 控制台（`⌘⌥I` → Console）里敲 `document.body.dataset.nestboardBuild`
    //   背景：前几轮用户反复说"没生效"，其中一部分是**库里/正在跑的还是旧包**（换包后没重启、
    //   或者按老习惯解压了 `plugins/` 里那个更早的 zip）—— 有这一行，一次就能定论。
    //   ★ 每次构建时**手工更新**这个字符串（与 `06 §11.55` 的记录一致）。
    document.body.dataset.nestboardBuild = this.buildStamp;

    // ★ 设置要在**一切装配之前**读出来：自动保存节奏是构造参数，附件目录与新建目录
    //   也都在下面的装配过程中被取用。晚一步读就会有一段"用默认值跑"的窗口
    this.settings = normalizeSettings(await this.loadData());
    // ★ 外观档要在**装配之前**落到 `body` 上（`F2`）：视图、菜单、设置面板都读它，
    //   等到某一个视图打开再写，用户会先看见一帧原版样子
    this.applyStyleMode();
    // ★ 语言必须在**任何 `t()` 之前**定下来（T3.23）：下面的 `registerCommands`
    //   会把命令名一次性翻成中文/英文，晚一步就会留下半中半英的命令面板
    // ★ 宿主语言走 Obsidian 官方的 `getLanguage()`（社区审核要求；插件 minAppVersion
    //   1.8.7 起提供），在入口读一次注入给 i18n —— 那个模块本身不碰 obsidian
    setHostLanguage(getLanguage());
    setLocale(this.settings.language);

    this.vaultIO = new ObsidianVaultIO(this.app);
    // 快照走 adapter 直读直写（目录通常不在 Vault 索引里，见 `snapshotIO.ts`）
    this.snapshotStore = new SnapshotStore(new ObsidianSnapshotIO(this.app), {
      root: () => this.snapshotRoot,
      enabled: () => this.settings.snapshotEnabled,
    });
    this.repository = new BoardRepository(this.vaultIO, {
      saveDebounceMs: this.settings.autosaveDebounceMs,
      // ★ 旁路：写盘成功后才评估要不要打快照，失败也不会回灌到保存流程
      observer: this.snapshotStore.observer,
    });
    // 脑图的仓储（`06 §9` P1）：同六条规则，但**实例与类型都独立** ——
    // 两份各自演进，不会因为一方加字段逼着另一方跟着动。
    // ★ 快照走同一个 `SnapshotStore`（`mindId` 只是分目录用的键）：
    //   这三行适配是刻意的，见 `MindSaveObserver` 的注释。
    this.mindRepository = new MindRepository(this.vaultIO, {
      saveDebounceMs: this.settings.autosaveDebounceMs,
      observer: {
        afterSave: (payload) =>
          this.snapshotStore.observer.afterSave({
            path: payload.path,
            boardId: payload.mindId,
            revision: payload.revision,
            text: payload.text,
          }),
      },
    });
    this.registry = new BoardRegistry(this.vaultIO);
    // 只传两个窄接口（`RenameWatcher` 因此不认识 Obsidian，能在 node 下直测）
    this.renameWatcher = new RenameWatcher({
      openPaths: () => this.repository.openPaths(),
      mutate: (path, mutator) => this.repository.mutate(path, mutator),
      // ★ 脑图那一半（`06 §6` 的"断链"那一行）：附件被改名 / 移动时，`.nestmind` 里
      //   那条引用与正文里的 `[[链接]]` 都要跟着走 —— 不做的话，下次打开就是一堆
      //   灰回形针，用户得一个个手动重挂。
      // ★ 与白板共用同一个 watcher（一次事件、两类文档各扫一遍）：两边各起一个监听
      //   迟早会出现"只有一个跟着走了"的怪状态
      openMindPaths: () => this.mindRepository.openPaths(),
      mutateMind: (path, mutator) => this.mindRepository.mutate(path, mutator),
    });

    // 跨白板链接索引（T5.01）。★★ `resolve` 在这里注入而不是让 `LinkIndex` 自己去
    // import `obsidian`：`[[某笔记]]` 到底指哪个文件（最短唯一名 / 别名 / 大小写）
    // 只有 `metadataCache` 知道，但把这条依赖挡在索引外面，索引就能在 node 下直测。
    this.linkIndex = new LinkIndex({
      // ★ **两份文档类型都扫**（`06 §8`：反链索引要覆盖 `.nestmind`）：
      //   白板的 `.nboard` 是它的老本行，脑图的 `.nestmind` 靠下面注入的 `extract` 认。
      //   ★ `list` 合成两份而不是给 `vaultIO.list` 加个多扩展名重载：那个端口的作用
      //     就是"列出某一种扩展名的文件"，在这里合并不必把它撑得更宽。
      list: async () => [
        ...(await this.vaultIO.list(BOARD_EXT)),
        ...(await this.vaultIO.list(MIND_EXT)),
      ],
      read: (path) => this.vaultIO.read(path),
      // 按扩展名分派"文本 → 出链 / 标签"：白板那份在 `integration/LinkIndex.ts`，
      // 脑图那份在 `mind/io/extractLinks.ts`（`06 §7.2` 的接缝）
      extract: (path, text) =>
        path.endsWith(`.${MIND_EXT}`) ? extractMindDoc(path, text) : extractBoardDoc(path, text),
      resolve: (target, sourcePath) =>
        this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path ?? null,
    });

    // 跨白板搜索索引（T7.02）。★ 这里**不** `rebuild()`：见字段说明 —— 它由侧栏
    //   `onOpen` 里的 `ensure()` 懒启动。两个端口与 `linkIndex` 完全相同，差别只在
    //   "什么时候开始读"以及"读来的东西留不留"。
    this.boardSearch = new BoardSearchIndex({
      list: () => this.vaultIO.list(BOARD_EXT),
      read: (path) => this.vaultIO.read(path),
    });

    // 索引笔记（T7.01 / `F10-09` + `F7-09`）。★ 只在这一处构造：开关与目录都走端口
    //   "每次现取"，所以用户在设置里拨开关、改目录都不必重建这个对象。
    this.indexNotes = new IndexNoteBridge({
      enabled: () => this.settings.enableIndexNote,
      folder: () => this.settings.indexNoteFolder,
      // 白板清单走 `vaultIO` 而不是 `registry.all()`：注册表只装"解析得出 `meta.id`"的
      // 白板，而这里要的是**库里的全部** `.nboard` —— 是否生成由 `entryOf` 决定
      // （见 bridge 的 `syncBoard`：注册表里没有就不拿文件名凑一份假数据写出去）
      listBoards: () => this.vaultIO.list(BOARD_EXT),
      read: (path) => this.vaultIO.read(path),
      create: (path, content) => this.vaultIO.create(path, content),
      // 覆盖写走 `process`：`vault.modify` 中途失败会留下半份文件，而 `process` 的
      // transform 抛出时"一个字节都不写"（`03 §3.2 W1`）
      write: (path, content) => this.vaultIO.process(path, () => content),
      // 删除走回收站：用户说"删"指的是"我不想在库里看见它了"，不是"永远消失"
      remove: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.app.vault.trash(file, true);
      },
      // ★ 只认 frontmatter 那一栏（`nestboard-board`），一个文件都不读：这个接口会在
      //   迁移目录 / 清理 / 删除命令里被调到，而那时我们只知道一个目录名。
      //   清单是**线索**，真正决定删不删的是文件里的生成物标记（bridge 的 `removeNote`）
      listIndexNotes: async (folder) => {
        const prefix = folder.length > 0 ? `${folder}/` : '';
        const found: string[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
          if (prefix.length > 0 && !file.path.startsWith(prefix)) continue;
          const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
          if (frontmatter && typeof frontmatter[INDEX_NOTE_BOARD_KEY] === 'string') {
            found.push(file.path);
          }
        }
        return found;
      },
      // ★ `cardCount` 原样透传（含 `null`），**不要**在这里顺手 `ensureCardCount()`：
      //   那等于"为了次要产物把每块板的 JSON 都读一遍解析一遍"，正是 `R4` 拒绝的事
      entryOf: (path) => {
        const entry = this.registry.getByPath(path);
        return entry
          ? {
              title: entry.title,
              tags: entry.tags,
              cardCount: entry.cardCount,
              updatedAt: entry.updatedAt,
            }
          : null;
      },
      linksOf: (path) =>
        this.linkIndex.linksOf(path).map((hit) => ({
          target: hit.target,
          resolved: hit.resolved,
        })),
      // `F1` ①：卡内标签走同一个 `LinkIndex`（它本来就按文档存了 tags，
      //   只是从前没人取）—— 与 `linksOf` 同源同口径，不必再扫一遍文件
      cardTagsOf: (path) => this.linkIndex.tagsOf(path),
      // `F1` ②：标签枢纽笔记的清单 —— 与 `listIndexNotes` 同一套（只认 frontmatter
      //   那一栏、一个文件都不读；删不删由文件里的标记定）
      listTagHubs: async (folder) => {
        const prefix = folder.length > 0 ? `${folder}/` : '';
        const tagsPrefix = `${prefix}${TAG_HUB_FOLDER}/`;
        const found: string[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
          if (!file.path.startsWith(tagsPrefix)) continue;
          const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
          if (frontmatter && typeof frontmatter[TAG_HUB_KEY] === 'string') found.push(file.path);
        }
        return found;
      },
      boardUri: (path) => buildNestboardUri(path),
    });
    // 目录迁移防抖（T7.01）：见字段说明。目标目录从端口"现取"，所以回调里只说"从哪搬"
    this.scheduleIndexRelocate = debounce(() => {
      const from = this.indexRelocateFrom;
      this.indexRelocateFrom = null;
      if (from !== null) void this.indexNotes.relocate(from);
    }, INDEX_RELOCATE_DEBOUNCE_MS);

    // 视图必须**先注册**，命令里的 openBoardView 才能找到这个视图类型
    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    // 把 .nboard 绑到我们的视图：点击文件 / 内部链接 / 文件浏览器都直接进白板（F7-01）
    this.registerExtensions([BOARD_EXT], VIEW_TYPE_BOARD);

    // 侧栏「跨白板反链」（T5.03）。★ 这里**不**调用 `registerExtensions` ——
    // 那个 API 是把某个**文件扩展名**绑到视图上（`.nboard` → 白板），
    // 而这个面板没有对应文件类型，它只是侧栏里的一块。
    this.registerView(VIEW_TYPE_BACKLINK, (leaf) => new BacklinkPanelView(leaf, this));

    // 侧栏「白板列表」（T5.08 / `F7-04`）：目录树 / 最近打开 / 按标签三种看法。
    // 同 `VIEW_TYPE_BACKLINK`，没有对应文件类型，所以不注册扩展名
    this.registerView(VIEW_TYPE_BOARD_LIST, (leaf) => new BoardListPanelView(leaf, this));

    // 侧栏「跨白板搜索」（T7.02 / `F8-08`）：整个库当搜索范围（白板内搜索只能搜眼前这一块）。
    // 同 `VIEW_TYPE_BOARD_LIST`，没有对应文件类型，所以不注册扩展名
    this.registerView(VIEW_TYPE_BOARD_SEARCH, (leaf) => new BoardSearchPanelView(leaf, this));

    // 侧栏「卡片属性」（`B1`，用户 2026-09-18）：单例，跟随当前选中的卡片。
    // 同 `VIEW_TYPE_BOARD_LIST`：没有对应文件类型，所以只 `registerView`、不绑扩展名
    this.registerView(VIEW_TYPE_CARD_INSPECTOR, (leaf) => new CardInspectorPanelView(leaf));

    // 脑图（`.nestmind`，`06 §2`）：**第二个文档类型**，与白板平级各占一个视图。
    // ★ 与 `VIEW_TYPE_BOARD` 那两行逐条同理：先把视图注册上，再把扩展名绑过去 ——
    //   于是点文件 / 内部链接 / 文件浏览器都直接进脑图。
    // ★ 两个 `registerExtensions` 各绑各的扩展名，Obsidian 不会把它们混起来；
    //   视图类型也必须不同，否则打开 `.nestmind` 会落到白板视图里（反之亦然）。
    this.registerView(VIEW_TYPE_MIND, (leaf) => new MindView(leaf, this));
    this.registerExtensions([MIND_EXT], VIEW_TYPE_MIND);

    // 白板 URI `obsidian://nestboard?file=…&card=…`（T5.06 / F10-06）。
    // ★ 这是**唯一一条"库外的世界能指回库内的某一张卡"**的通路（其余全是库内互指），
    //   所以地址格式要稳、要能被别的 App 照抄（格式定义在 `integration/ProtocolHandler.ts`）
    this.registerObsidianProtocolHandler(NESTBOARD_PROTOCOL, (params) => {
      void this.openBoardUri(params);
    });

    registerCommands(this);
    // 脑图的命令（`06 §9` P0-b）：单独一份表，见 `mind/commands.ts` 的文件头
    registerMindCommands(this);
    // 白板嵌入笔记（T3.16）：```nestboard 代码块 + `![[x.nboard]]`，两种写法同一套只读渲染
    registerBoardEmbed(this);
    this.registerRepositoryEvents();
    this.registerVaultEvents();
    this.registerFileMenu();
    this.registerFlushTriggers();
    this.addSettingTab(new NestboardSettingTab(this.app, this));

    await this.registry.build();

    // 跨白板链接索引（T5.01）：**不 await** —— 扫描要读遍全部 `.nboard`，几百毫秒到
    // 几秒不等，吊在这里等于每次加载插件都卡一下。索引内部按片让出主线程，
    // 每片结束广播一次，侧栏会自己逐段长出来。
    void this.linkIndex.rebuild();
    // `metadataCache` 可能在索引扫完之后才建好，那样第一次扫描会把几乎所有链接都
    // 解析成"未解析"（退回按文件名匹配）。`resolved` 是 Obsidian 明确给出的
    // "缓存已就绪 / 批量变更后"的信号，用它把解析结果纠正一次（见 `reresolve`）。
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.linkIndex.reresolve()));

    // 索引笔记 / 标签枢纽（`F1`）在**启动时也补一遍**：等 `LinkIndex` 扫完（卡内标签
    //   在它那儿）再跑，否则第一轮会写出"没有卡内标签"的旧 frontmatter。幂等
    //   （内容一致不写盘），所以每次启动跑一遍几乎零成本 —— 却能兜住"用户手动删了
    //   生成物""外部改了 data.json 开关"这类没有任何事件可听的情况。
    void this.linkIndex.rebuild().then(() => {
      if (this.settings.enableIndexNote) return this.indexNotes.syncAll();
      return undefined;
    });

    // 同步冲突副本（T4.03）：启动扫一遍，有就提示一句（没有则完全不出声）。
    // ★ 不 await：扫描要遍历整个库的文件列表，不能拖慢插件加载
    void notifyConflictCopies(this);

    // 排障入口：控制台里敲 `nestboardDebug` 就能确认"加载的是哪份构建"、并直接
    // 问到当前视图的真实状态（路径 / 只读 / 工具条清单）。
    // ★ 只挂这一个只读入口，**刻意不打启动日志**：
    //   ① `console.debug` 在 Obsidian 控制台默认被 verbose 过滤，等于没打；
    //   ② `console.log` 看得见，却会污染每一位用户的控制台，与 DoD-1
    //      「产物中不得残留 console.log」相抵 —— 这个 global 是更好的排障入口。
    (globalThis as { nestboardDebug?: unknown }).nestboardDebug = {
      build: BUILD_TAG,
      view: () => getActiveBoardView(this.app),
      views: () => allBoardViews(this.app),
      // 链接索引的规模。`unresolved` 长期不归零 = `metadataCache` 没解析出来，
      // 反链会退化到"按文件名匹配"，这时该看的是 `resolve` 而不是索引本身
      links: () => this.linkIndex.stats(),
      // 索引笔记（T7.01）的排障：`conflicts` 长期非空 = 用户库里蹲着同名笔记
      // （我们一个字都没动它），那说明有白板的索引笔记**从来没生成过** ——
      // 而用户多半只看到"图谱里少了一条边"，不知道少的是哪块板
      indexNotes: () => ({
        conflicts: this.indexNotes.conflicts(),
        pending: this.indexNotes.pendingCount,
      }),
      // 跨白板搜索（T7.02）的规模。★ 用户报"跨板搜索搜不到"时先看这个数字是不是
      // 等于库里白板总数 —— 偏小就是还有板没进索引（读不出来 / 还没扫到），
      // 而那种情况下侧栏自己会说"正在索引"，不该被当成功能坏了
      boardSearch: () => this.boardSearch.stats(),
    };
  }

  override onunload(): void {
    // `onunload` 是同步的，无法 await —— 「最后 400ms 的编辑不丢」主要由
    // 失焦 flush + 30s 定时兜底保证（见 registerFlushTriggers），这里再尽力补一次（03 §3.2 W5）。
    void this.repository.flushAll().finally(() => {
      this.repository.dispose();
    });
    // 脑图同理：先把攒着的改动推下去，再放掉自建资源（两者同一个理由，见上）
    void this.mindRepository.flushAll().finally(() => {
      this.mindRepository.dispose();
    });
    // 索引记着分片扫描的世代号：`dispose()` 会让进行中的扫描在下一片开头自行放弃。
    // 少了这一步，重载插件后可能还有一次上一世的扫描在后台往废弃的表里写
    this.linkIndex.dispose();
    // 跨白板搜索索引同理（T7.02）：让进行中的扫描在下一片开头自行放弃
    this.boardSearch.dispose();
    // 还没到点的那次目录迁移先落下来：用户改完目录立刻重载插件的话，旧目录会留着一份
    this.scheduleIndexRelocate?.flush();
    // 索引笔记（T7.01）：先把防抖攒着的落盘，再 `dispose`。顺序不能反 —— `dispose`
    // 会让 `disposed` 立起来，之后 `drain` 里的 `syncBoard` 全走 `disabled`，
    // 用户最后几秒的编辑就白攒了（与上面 `flushAll` → `dispose` 是同一条规矩）。
    void this.indexNotes.drain().finally(() => this.indexNotes.dispose());
    console.debug('[nestboard] plugin unloaded');
  }

  // ── 装配：Repository 的事件 → 提示 / 对话框 ────────────────

  private registerRepositoryEvents(): void {
    // 保存成功后同步索引条目（内部用内存模型，不额外读盘）
    this.repository.on('saved', ({ path }) => {
      const board = this.repository.get(path);
      if (!board) return;
      this.registry.updateFromBoard(path, board);
      // 跨白板链接索引（T5.02）同样吃内存模型。★ 绝不能在这里改成"重新读一次盘"
      // —— 自动保存每次都会触发，那等于把每次自动保存变成一次额外的磁盘读
      this.linkIndex.updateFromBoard(path, board);
      // 跨白板搜索索引（T7.02）同一条理由：吃内存模型，否则每次自动保存都多读一次盘
      this.boardSearch.updateFromBoard(path, board);
      // 索引笔记（T7.01）：只攒不写 —— 每次保存都会改 `updatedAt`，直接落盘就是
      // "打字期间每秒两次写盘"，图谱与 Dataview 跟着重算两次。防抖攒够 2s 才写一次
      this.indexNotes.scheduleSync(path);
    });

    this.repository.on('conflict', (payload) => {
      this.openConflictModal(payload);
    });

    // 脑图的冲突同样弹那个三选一（`P3-c-2`）：不接这一条的话，冲突会**静默停在内存里**
    // —— 界面上什么都没有，用户接着改、改完关掉，改动一个字节都没落盘。
    this.mindRepository.on('conflict', (payload) => {
      this.openMindConflictModal(payload);
    });

    this.repository.on('protected', ({ path, reason }) => {
      new Notice(
        reason === 'future-version'
          ? t('notice.futureVersion', { path })
          : t('notice.boardProtected', { path }),
      );
    });

    this.repository.on('error', ({ path, error }) => {
      new Notice(t('notice.saveFailed', { path, error: describeError(error) }));
    });
  }

  // ── 装配：附件导入（T1.49 / T1.65 / T1.68） ────────────────

  /**
   * 附件写入器（T1.49 的生产接线，被 T1.65 的系统文件拖入消费）。
   *
   * 放在**插件级**而不是视图级：去重索引与附件目录都是全局概念 ——
   * 每块白板各持一个实例会让同一张图在每块板上各存一份，正好与 `F9-03` 相反。
   */
  get attachments(): AttachmentManager {
    this.attachmentsManager ??= new AttachmentManager(new ObsidianAttachmentSink(this.app), () =>
      this.attachmentConfig(),
    );
    return this.attachmentsManager;
  }

  /**
   * 附件命名的 `ImportOptions`（`F11-06` / T1.74）。
   *
   * ★ 拖入与粘贴两条路**共用这一份规则**，而不是各自读一遍设置：
   *   规则散成两份的话，"设置里改了但粘贴进来的图还是老名字"这种问题迟早出现。
   */
  get attachmentOptions(): { timestamp: boolean } {
    return { timestamp: this.settings.attachmentNaming !== 'original' };
  }

  /**
   * 拖入**这一份文件**时的命名选项（O14）。
   *
   * ★ 笔记不是附件：`F11-06` 的「附件命名」是给图 / PDF 这类**素材**准备的。
   *   给 `.md` 也套上 `<时间戳>-` 前缀，会让它在文件树里跟原名对不上号 ——
   *   拖进来一份 `会议纪要.md`，库里出现的却是 `20260913-153012-会议纪要.md`；
   *   而紧接着落下的引用卡显示的就是那个带时间戳的名字，用户看到的是
   *   "我拖进来的笔记**换了名字**"。
   * ★ 笔记一律**保留原名**，重名交给写入层的 `uniquePath` 顺延（`会议纪要 2.md`）——
   *   这与 Obsidian 自己"拖文件进库不改名"的行为一致。
   * ★ 判定用 `isNotePath` 而不是拿扩展名字符串现比：扩展名表只有 `model/drop.ts` 一份
   *   （`.md` / `.markdown` 两种写法，将来加 `.mdx` 时也只改那一处）。
   */
  private importOptionsForName(name: string): { timestamp: boolean } {
    return isNotePath(name) ? { timestamp: false } : this.attachmentOptions;
  }

  /**
   * 快照根目录（T4.01，03 §1.4 的 A / B 两个方案）。
   *
   * ★ 返回**Vault 相对路径**而不是绝对路径：`vault.adapter` 的基准就是 Vault 根，
   *   而两个候选位置都在它下面。
   * ★ 插件目录用 `configDir` 拼而不是 `manifest.dir`：后者是绝对路径，
   *   在移动端与桌面端的形态不一样；`configDir` 还允许用户改掉 `.obsidian` 这个名字。
   */
  get snapshotRoot(): string {
    return this.settings.snapshotLocation === 'vault'
      ? SNAPSHOT_VAULT_DIR
      : `${this.app.vault.configDir}/plugins/${this.manifest.id}/${SNAPSHOT_PLUGIN_DIR}`;
  }

  /**
   * 外部文件 → 落库（T1.65）。
   *
   * 失败返回 `null` 而不是抛：一次拖入可能带着十个文件，其中一个读不出来
   * 不该让另外九个一起失败（`DragDropBridge` 就是这么用它的）。
   */
  async importDroppedFile(file: File): Promise<string | null> {
    try {
      return await this.attachments.importSystemFile(file, this.importOptionsForName(file.name));
    } catch (error) {
      console.warn('[nestboard] 附件导入失败', describeError(error));
      return null;
    }
  }

  /**
   * 库外绝对路径 → 落库（T1.65 的兜底路）。
   *
   * ★ 只在"拖拽只给了 `text/uri-list`、没给 `File` 对象"时才走这里（macOS Finder
   *   常见）。没有 `File` 就没有 `arrayBuffer()`，只能按路径读盘。
   * ★ 读不到就返回 `null`：拖拽本来就可能带着超过一个文件，一个失败不该拖垮其余项。
   */
  async importDroppedUri(absolutePath: string): Promise<string | null> {
    try {
      const fs = loadNodeFs();
      if (!fs) return null;
      const data = await fs.promises.readFile(absolutePath);
      // `Buffer` 常常只是底层 `ArrayBuffer` 的一段视图，`new Uint8Array(data)`
      // 直接拷出**真正属于这个文件**的字节；再取 `.buffer` 才不会把同池的无关字节写进去
      const bytes = new Uint8Array(data).buffer as ArrayBuffer;
      return await this.attachments.importData(bytes, absolutePath, {
        fallbackBase: '拖入文件',
        ...this.importOptionsForName(absolutePath),
      });
    } catch (error) {
      console.warn('[nestboard] 外部路径导入失败', describeError(error));
      return null;
    }
  }

  /**
   * 链接卡的预览图 → 落库（T2.06 / `F2-4-4`）。
   *
   * ★ 与拖入 / 粘贴**共用同一个 `AttachmentManager`**：附件目录、命名规则、去重
   *   都该跟着用户的设置走（`F11-06`）。链接预览图没有任何理由另立一套规则 ——
   *   那只会让"我的附件到底放哪了"多出一种答案。
   * ★ 失败返回 `null` 而不是抛：调用方（`ObsidianLinkPreviewBridge`）会退回到
   *   直接用远程地址显示 —— 那是一条**正常退路**，不是错误。
   */
  async importPreviewImage(data: ArrayBuffer, name: string): Promise<string | null> {
    try {
      return await this.attachments.importData(data, name, this.attachmentOptions);
    } catch (error) {
      console.warn('[nestboard] 预览图落盘失败', describeError(error));
      return null;
    }
  }

  /**
   * 附件目录（`F11-06` / T1.74）。两条来源，用户选了哪条就走哪条：
   *
   * 1. `attachmentLocation === 'custom'` → 用设置里那个目录。
   *    ★ 这时**刻意不去看** Obsidian 的附件设置：面板上写着"自定义目录"，实际却因为
   *      Obsidian 那边还开着别的选项而落到别处，是最难排查的一类问题。
   * 2. 否则跟随 Obsidian 自己的「附件默认位置」设置。
   *    ★ `./` 这类"相对当前文件"的取值需要一个基准目录 —— 在本插件里最贴近
   *      "当前文件"的就是**正在看的那块白板**：拖进哪块板，附件就落在它旁边。
   *
   * ★ `boardPath` 是显式参数而不是在这里现取"当前活动白板"：`./` 这个取值依赖基准目录，
   *   "附件整理"扫的目录必须和"拖进来时写过哪儿"是**同一个**答案 —— 让调用方
   *   （导入 / 整理）各自把当时那块板传进来，两者就不可能各算各的。
   */
  attachmentFolderFor(boardPath: string | null): string {
    if (this.settings.attachmentLocation === 'custom') return this.settings.customAttachmentFolder;

    const baseFolder =
      boardPath !== null && boardPath.includes('/')
        ? boardPath.slice(0, boardPath.lastIndexOf('/'))
        : '';
    // ★ `Vault.getConfig` 在运行时存在，但官方 `.d.ts` 里没暴露 —— 用结构类型取；
    //   取不到就退到"库根目录"，不能因为读不到一项设置就让整个附件导入失败
    const vaultConfig = this.app.vault as unknown as {
      getConfig?: (key: string) => unknown;
    };
    return resolveAttachmentFolder(vaultConfig.getConfig?.('attachmentFolderPath'), baseFolder);
  }

  private attachmentConfig(): AttachmentConfig {
    return {
      folder: this.attachmentFolderFor(getActiveBoardView(this.app)?.boardPath ?? null),
      // ★ 去重开关（T6.05 / `F2-3-10`）：默认**关**。同一次会话里把同一个文件拖两次
      //   常常是用户明确的重复动作（想放别处 / 想改名），静默合并成一份会让人以为
      //   "第二次没生效"。打开后按 SHA-256 **内容**判重，且只在本次会话内生效。
      //   ★ 这里是**每次调用现读**设置：用户在设置面板里一改，下一次导入就生效，
      //     不必重启插件（与附件目录同一条规矩）。
      dedupe: this.settings.attachmentDedupe,
    };
  }

  // ── 设置（T1.74 / `F11-01`） ──────────────────────────────

  /**
   * 合并一批设置改动 → 收敛 → 落盘 → 推给运行时。
   *
   * ★ 每次都过一遍 `normalizeSettings`：设置面板送来的是"用户输入"，不是可信数据。
   *   目录字段会把 `Boards/` 这种尾斜杠收敛掉，间隔字段会把越界值夹回范围。
   *
   * ★ 新板目录与附件目录**不需要**在这里推：它们是"用的时候现读"（`findFreeBoardPath`
   *   与 `attachmentConfig`），改完下一次新建 / 下一次导入就生效。只有自动保存间隔
   *   是构造时就吃进 `BoardRepository` 的，必须显式推一次。索引笔记目录（T7.01）是
   *   第三种：它也是"现取"，但**改目录还得把旧目录那份收掉**，所以也要在这里搬一次。
   *
   * ★ 命令面板里的命令名（`commands.ts` 注册时一次性 `t()` 出来的）**不在这里刷新**：
   *   Obsidian 没有"改一个已注册命令的名字"的正规 API。要让它跟着变，
   *   关掉再打开插件（或重载 App）即可 —— 命令名与工具栏、右键菜单不同，
   *   后者是我们自己画的，可以随时重写文案。
   */
  async updateSettings(changes: Partial<NestboardSettings>): Promise<void> {
    const previousLocale = getLocale();
    // 索引笔记（T7.01）的两项要"改前改后对比"，必须在赋值之前抓下来：
    // 下面这行执行完，`this.settings` 已经是新值了
    const previousIndexNoteFolder = this.settings.indexNoteFolder;
    const wasIndexNoteEnabled = this.settings.enableIndexNote;
    this.settings = normalizeSettings({ ...this.settings, ...changes });
    await this.saveData(this.settings);
    this.repository.setSaveDebounce(this.settings.autosaveDebounceMs);

    // ★ 快照开关 / 位置变了要清掉"最近一次快照"的缓存：位置换了之后新目录里
    //   可能一份都没有，缓存会误判"刚打过"而一直不打第一份
    if (changes.snapshotEnabled !== undefined || changes.snapshotLocation !== undefined) {
      this.snapshotStore.invalidate();
    }

    // ★ 语言（T3.23）：`setLocale` 会重新解析（`auto` 就是现场再读一次 Obsidian 语言）。
    //   只有**真的换了语言**才值得让视图重画文案 —— 否则用户每调一次圆角，
    //   所有打开的视图都要重排一遍工具栏与菜单。
    // ★ 重新注入一次宿主语言：用户可能刚在 Obsidian 里换掉界面语言，`auto` 那一档
    //   要读到新的值（见 `setHostLanguage`）
    setHostLanguage(getLanguage());
    const localeChanged = setLocale(this.settings.language) !== previousLocale;
    // ★ 外观档（`F2`）：**与语言无关**，所以不塞进 `refreshLocalizedChrome`
    //   （那个函数只在"已打开的视图"上跑；档是全局的、还要覆盖菜单与设置面板）
    this.applyStyleMode();
    this.refreshLocalizedChrome(localeChanged);

    // ★ 缩略图导航器（T5.09）是**已打开视图的现场状态**（不是"下次新建才生效"），
    //   所以改了这一项要立刻推给所有开着的板。
    // ★ 而它**不属于"文案 / 外观"**，不该塞进 `refreshLocalizedChrome` ——
    //   那个函数每次改卡片圆角都会跑一遍，让"一个开关的状态"跟着重排工具栏没道理。
    // ★ 判 `!== undefined` 而不是判值：设置面板把 true 改成 true 也会走到这里，
    //   而这里推一次 `setVisible` 是幂等的（内部同值直接返回），不值得为此再比一次。
    if (changes.minimap !== undefined) {
      for (const view of allBoardViews(this.app)) view.applyMinimapSetting(this.settings.minimap);
      // ★ 脑图那一半（`P2-c`）：与白板共用**同一份设置**、同一个组件 ⇒ 这一项一变，
      //   两类视图都要跟着亮 / 灭（"我要一个缩略图导航器"是一个偏好，不是两份）
      for (const view of allMindViews(this.app)) view.applyMinimapSetting(this.settings.minimap);
    }

    // ★ 图片清晰度（`A5`）：这一档在**渲染图片卡的那一刻**才判定 ⇒ 拨了开关要让已经打开的
    //   白板立刻重画，否则用户回到白板看到的还是旧样子，只会以为"这开关没用"。
    //   （与上面那个开关同一条：这是**已打开视图的现场状态**，不是"下次新建才生效"。）
    if (changes.alwaysFullImage !== undefined) {
      for (const view of allBoardViews(this.app)) view.applyImageQualitySetting();
    }

    // ── 索引笔记（T7.01 / `F10-09` + `F7-09`） ────────────────
    //
    // ★ 两件事都只能在这里做：桥的端口是"现取"，别的时机没人会来问。
    //
    // ① **刚打开开关** → 立刻补齐，而不是等用户下次保存白板才看见文件。不补的话
    //    用户点完开关回去看，目录还是空的，只会得出"这功能坏了"（`syncAll` 分片
    //    让出主线程，所以这里 `void` 掉也不会把设置面板卡住）。
    if (!wasIndexNoteEnabled && this.settings.enableIndexNote) {
      void this.indexNotes.syncAll();
    }

    // ② **改了目录** → 新目录写一遍、旧目录那份收掉。不做的话图谱里同一条边会出现
    //    两次 —— 其中一次指向上一秒的自己。
    //    ★ 只在**开关打开**时搬：关着的时候新目录不会长出新文件，把旧目录收掉等于
    //      "用户只是关了个开关，文件却没了"，那是破坏而不是整理。
    //    ★ 必须防抖，且记住"这一串改动开始之前"的目录：目录框是逐键 onChange 的，
    //      不防抖就会边打字边在库里造出 `B/`、`Bo/`、`Boa/` 一串目录再收走。
    if (
      this.settings.enableIndexNote &&
      this.settings.indexNoteFolder !== previousIndexNoteFolder
    ) {
      if (this.indexRelocateFrom === null) this.indexRelocateFrom = previousIndexNoteFolder;
      this.scheduleIndexRelocate?.();
    }

    // ③ **反链侧栏顶部那句提示**（`F10-08`）也是按这个开关显示的，所以拨了开关要让
    //    已经打开的侧栏当场消失 / 出现 —— 否则用户从设置面板打开它、回头看侧栏，
    //    那句"点这里开启"还挂在那儿，等于告诉用户"你刚才那一下没生效"。
    //    只传 `enableIndexNote` 时才通知：别的设置改动与那句提示无关。
    if (changes.enableIndexNote !== undefined) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BACKLINK)) {
        if (leaf.view instanceof BacklinkPanelView) leaf.view.refreshIndexNoteHint();
      }
    }
  }

  // ── 「最近打开」（T5.08 / F7-04） ──────────────────────────

  /**
   * 记一次「最近打开」。
   *
   * ★ 必须由 `BoardView.onLoadFile` 调，而不是挂在某条命令上：那是**所有**打开方式的
   *   唯一汇合点（文件浏览器双击、内部链接、`obsidian://` 协议、侧栏点击、目录树……），
   *   挂在命令上会漏掉"用户最常用的那种打开方式"，而列表看起来只是"偶尔不准"。
   *
   * ★ 内容没变就**不写盘**：`pushRecentBoards` 用"返回原数组引用"表达这一点。
   *   用户在几块板之间来回点时，这不是性能优化 —— 是别让每次点击都写一次 `data.json`。
   */
  rememberRecentBoard(path: string): void {
    const next = pushRecentBoards(this.settings.recentBoards, path);
    if (next === this.settings.recentBoards) return;
    void this.saveRecentBoards(next);
  }

  /**
   * 白板改名 / 移动后，把「最近打开」里那条路径也搬过去。
   *
   * ★ 不搬的后果不是"少一项"，而是**那一项凭空消失**：侧栏渲染时会拿历史里的路径
   *   逐条回索引里核对（`ui/boardList.ts` 的 `recentBoards()`），对不上就静默跳过。
   *   用户刚把板改了名，回头发现自己最顺手的那条捷径没了，还找不到原因。
   */
  renameRecentBoard(oldPath: string, newPath: string): void {
    const next = renameRecentBoards(this.settings.recentBoards, oldPath, newPath);
    if (next === this.settings.recentBoards) return;
    void this.saveRecentBoards(next);
  }

  /**
   * 只落盘「最近打开」，**故意不走 `updateSettings`**。
   *
   * ★ `updateSettings` 里挂着一串"用户改了偏好才需要做的事"（重设自动保存防抖、
   *   作废快照缓存、必要时让所有打开的视图重画文案）。"我打开了一块板"不是偏好变更，
   *   每次打开都跑那一串既是浪费，也会让"设置变更"这个入口的含义变含糊。
   * ★ 但归一化照样走：`normalizeSettings` 是这份设置的**唯一**守门人，
   *   上限（`RECENT_BOARDS_LIMIT`）与去重都钉在它里面 —— 绕过它写盘等于开了个后门。
   */
  private async saveRecentBoards(next: readonly string[]): Promise<void> {
    this.settings = normalizeSettings({ ...this.settings, recentBoards: [...next] });
    await this.saveData(this.settings);
  }

  /**
   * 把设置变化推给已打开的视图（T3.23 / T3.24）。
   *
   * ★ 只对**打开的**视图做事：没打开的下次创建时自然读到新设置。
   *   新建卡片的默认色 / 新板背景属于"下次新建才生效"，本来就无需推送。
   */
  /**
   * 把外观档（原版 / 拟物，`F2`）写进 `document.body`。
   *
   * ★ 为什么是 `body` 而不是某个视图的根容器：拟物的作用面（`11 §6` 13d）**跨容器** ——
   *   白板视图、嵌在笔记里的白板、右键菜单、设置面板都在 `body` 下不同的子树里。
   *   写在 `body` 上是唯一一处能一次覆盖全部的地方，也省得每个容器各记一次。
   * ★ 与逐视图推的 CSS 变量分工：变量是**视图级**的（圆角 / 字号 / 字体），
   *   档是**全局级**的；原版档会把这个类**摘掉** ⇒ 既有规则一条都不受影响
   *   （`11 §7` 的回归基线是靠这条结构性保证的）。
   */
  private applyStyleMode(): void {
    if (typeof document === 'undefined') return;
    applyBoardStyleClass(document.body, this.settings);
  }

  private refreshLocalizedChrome(localeChanged: boolean): void {
    for (const view of allBoardViews(this.app)) {
      // 卡片外观是纯 CSS 变量：无论语言变没变都要重推（用户可能刚改了圆角）
      view.applyAppearanceSettings();
      if (localeChanged) view.refreshLocalizedLabels();
    }
  }

  // ── 装配：文件 / 文件夹右键菜单（T1.67、O12，F10-02） ──────

  /**
   * 文件树右键菜单（T1.67 / O12）。
   *
   * 「有哪些项、怎么分组」全在 `view/interact/fileMenu.ts`（纯数据、可在 node 下单测），
   * 这里只做两件只有本层做得了的事：把 `TAbstractFile` 翻译成菜单认得的**目标**，
   * 以及把菜单项的 id 接到真实动作上。
   *
   * ★ `Record<FileMenuAction, …>` 而不是 `switch`：漏一个动作**编译不过**，
   *   而 `switch` 少一个 `case` 只会安静地什么都不做（点上去没反应，最难查的一类 bug）。
   */
  private registerFileMenu(): void {
    const handlers: Record<FileMenuAction, (path: string) => void> = {
      // 在**用户右键的那个文件夹里**建一块板（O12）。功能上就是 ⌘⇧N 加一个落点，
      // 所以直接转调它：提示文案、建完打开、失败怎么说都只该有一份
      newBoardHere: (path) => void createNewBoard(this, path),
      // 在同一个文件夹里建一份脑图（`C4`，用户 2026-09-18）。与上面那条同一个形状：
      // 转调命令层那个实现，提示文案 / 建完打开 / 失败怎么说都只有一份
      newMindHere: (path) => void createNewMind(this, path),
      importCanvas: (path) => void importCanvasAtPath(this, path),
      // Home 收件箱（T5.07 / `F7-03`）：「新建卡片的默认落点」
      addToUnsorted: (path) => addFileToUnsorted(this, path),
      addToBoard: (path) => void addFileToBoard(this, path),
      deleteBoard: (path) => void deleteBoardWithConfirm(this, path),
      viewConflict: (path) => void openConflictCompare(this, path),
    };

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        const target = fileMenuTarget(file);
        if (!target) return;
        const path = file.path;

        for (const item of fileMenuItems(target, {
          homeConfigured: this.settings.homeBoardPath !== '',
        })) {
          // 分组由规格层给的 `separatorBefore` 表达：组与组之间一条线，组内连着排
          if (item.separatorBefore) menu.addSeparator();
          menu.addItem((entry) => {
            entry.setTitle(item.title).setIcon(item.icon);
            entry.onClick(() => handlers[item.id](path));
          });
        }
      }),
    );
  }

  // ── 装配：白板 URI（T5.06 / F10-06） ──────────────────────

  /**
   * 处理 `obsidian://nestboard?file=…&card=…`。
   *
   * 副作用全在这一层（解析与校验是纯的，见 `integration/ProtocolHandler.ts`）：
   * 提示、找文件、开视图、定位卡片。
   */
  private async openBoardUri(params: Record<string, unknown>): Promise<void> {
    const parsed = parseNestboardUri(params);
    if (!parsed.ok) {
      new Notice(t(URI_REJECTION_NOTICE[parsed.reason]));
      return;
    }

    const { path, cardId } = parsed.uri;

    // ★ 先确认文件在不在，而不是直接开视图：`openBoardView` 对不存在的路径会开出一个
    //   "文件不存在"的空标签页，而用户手里只有一个坏链接 —— 他要知道的正是
    //   "这个链接指的是哪块板"。一句带路径的提示比一个空白标签页有用得多。
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
      new Notice(t('notice.protocolBoardMissing', { path }));
      return;
    }

    const view = await openBoardView(this.app, path);
    if (!view) {
      // 走到这里说明文件在、但视图没开出来（比如用户把白板视图类型禁用了）
      new Notice(t('notice.protocolBoardMissing', { path }));
      return;
    }

    // 没有 `card` 参数时不碰视口：那是一条"只打开这块板"的链接。
    // 定位到一张**已经不存在的卡**时 `revealCardById` 自己会静默放弃 —— 链接比卡片活得久
    // 是常态（卡片删了、链接还留在某篇笔记里），不该为此报错
    if (cardId) view.revealCardById(cardId);
  }

  // ── 装配：Vault 事件（自我写入识别在 Repository 内部完成） ──

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return;
        // 脑图走它自己的仓储（`06 §9` P1）：两种文档类型的重载 / 冲突判定互不干扰
        if (file.extension === MIND_EXT) {
          this.mindRepository.handleExternalModify(file.path);
          return;
        }
        if (file.extension !== BOARD_EXT) return;
        this.repository.handleExternalModify(file.path);
        // 外部改动（别的设备 / 别的编辑器）只能重读盘（T5.02）
        void this.linkIndex.update(file.path);
        void this.boardSearch.update(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile)) return;

        // 同步工具刚丢进来一份冲突副本（T4.03）：这不是"新建了一块板"，
        // 而是一份要人来处置的待办 —— 提示一声，别让它安安静静躺在库里。
        // ★ 只提示、不 return：下面那条"按扩展名入索引"要跟 `BoardRegistry.build()`
        //   的过滤条件保持一致，否则同一份副本"重启后进索引、当场创建却不进"。
        if (isConflictBoardPath(file.path)) {
          new Notice(t('notice.conflictCopyAppeared', { path: file.path }), 8000);
        }

        if (file.extension !== BOARD_EXT) return;
        // 索引笔记（T7.01）要等注册表先落地才同步：桥拿不到条目就不生成
        // （见 `IndexNoteBridge.syncBoard`），所以顺着同一个 `upsert` 的尾巴走
        void this.registry.upsert(file.path).then(() => this.indexNotes.syncBoard(file.path));
        // 新建的板子（含同步工具刚同步下来的）也要进链接索引，否则要等下次重启
        void this.linkIndex.update(file.path);
        void this.boardSearch.update(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === MIND_EXT) {
          // 文件没了：会话与挂起的定时器一起收掉（对着已删除的路径写回去等于把它复活）
          this.mindRepository.close(file.path);
          return;
        }
        if (file.extension !== BOARD_EXT) return;
        this.registry.remove(file.path);
        // 删掉的白板必须当场退出链接索引：留着它，反链会指向一块已经不存在的板
        this.linkIndex.remove(file.path);
        // 跨板搜索同理：留着它，搜索结果点进去是一块打不开的板
        this.boardSearch.remove(file.path);
        // 索引笔记（T7.01）：**不看开关** —— 一份指向已删白板的笔记是坏数据
        // （图谱里留着一条通向不存在笔记的边），收掉它不需要用户先想起那个开关
        void this.indexNotes.removeBoard(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === MIND_EXT) {
          // 路径跟着搬（不搬的话视图按新路径 `get()` 会拿到 null，画布当场变空）
          this.mindRepository.movePath(oldPath, file.path);
          return;
        }
        if (file.extension !== BOARD_EXT) return;
        this.registry.movePath(oldPath, file.path);
        // 只换 key，不重扫：内容一个字节都没变，重读一遍纯属浪费
        this.linkIndex.renamePath(oldPath, file.path);
        this.boardSearch.renamePath(oldPath, file.path);
        // 内容仓库的内存 session 也按路径索引：不搬的话视图按**新路径** `get()`
        // 拿到 `null`（画布当场变空），而旧 key 上的防抖保存还会往旧路径写（T1.73）
        this.repository.movePath(oldPath, file.path);
        // 视图里按路径记账的地方不止 `currentPath`（还有 `⌘[` 的历史、`⌘U` 的父级缓存）。
        // 逐个视图喂一遍：`FileView.onRename` 钩子是主路，这条是**兜底** ——
        // `retargetPath` 自带幂等（旧路径对不上就不动），两条路一起走不会重复生效
        for (const view of allBoardViews(this.app)) view.retargetPath(oldPath, file.path);
        // 「最近打开」是按路径记账的第四处（T5.08）：不搬的话那一行会静默消失
        this.renameRecentBoard(oldPath, file.path);
        // 索引笔记（T7.01）是按路径记账的第五处：新位置写一份、旧位置那份收掉。
        // ★ 只有新的那份**真的就位**了才收旧的（见 `renameBoard`）：否则"刚改完名、
        //   注册表还没跟上"的那一瞬间会把索引笔记整个弄丢，而不只是暂时缺一份
        void this.indexNotes.renameBoard(oldPath, file.path);
      }),
    );

    // 卡片引用跟随（T1.46）。与上面那条**刻意分开**：
    //  * 上面只管"白板索引自己"，且只对 `.nboard` 有意义；
    //  * 这里管"白板里的卡片指向谁"—— 目标可以是任意 `.md` / 图片 / 附件，
    //    也可以是另一块 `.nboard`（`boardRef` / `meta.parent`）。
    //    只处理**打开中的**白板：没打开的会在下次打开时走 `io/migrate.ts` 的同一套修复。
    this.renameWatcher.start({
      onRename: (handler) => {
        const ref = this.app.vault.on('rename', (file, oldPath) => {
          // 文件夹改名会连带触发子文件的事件，逐个文件处理即可
          if (file instanceof TFile) handler(oldPath, file.path);
        });
        // 用 `register`（而不是 `registerEvent`）是刻意的：适配器要**返回**退订函数，
        // 而 `registerEvent` 只接收 `EventRef`，拿不到"手动退订"这一步
        const dispose = (): void => this.app.vault.offref(ref);
        this.register(dispose);
        return dispose;
      },
    });
  }

  // ── 装配：强制 flush 的三道保险（T1.12） ───────────────────

  /**
   * 把两种文档类型攒着的改动一起推下去（W5：失焦 / 页面隐藏 / 定时兜底三条路都走它）。
   *
   * ★ 合成一个函数而不是在三处各写两行：**新加一种文档类型时只改这里**，
   *   漏一处就是"某种文档改了没落盘"这类只在切窗口时才暴露的问题。
   */
  private async flushEverything(): Promise<void> {
    await Promise.all([this.repository.flushAll(), this.mindRepository.flushAll()]);
  }

  private registerFlushTriggers(): void {
    // ① 窗口失焦（切到别的 App / 系统弹窗）
    this.registerDomEvent(window, 'blur', () => {
      void this.flushEverything();
    });

    // ② 页面不可见（移动端切后台不一定触发 blur）
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flushEverything();
    });

    // ③ 定时兜底：即使前两道都没触发，最多也只有 30s 的改动在内存里
    this.registerInterval(
      window.setInterval(() => {
        void this.flushEverything();
      }, FLUSH_INTERVAL_MS),
    );
  }

  // ── 冲突对话框 ────────────────────────────────────────────

  private openConflictModal(payload: BoardRepositoryEvents['conflict']): void {
    const { path } = payload;
    new Notice(t('notice.conflict', { path }));

    if (this.conflictDialogs.has(path)) return; // 同一块板只弹一个
    this.conflictDialogs.add(path);

    const modal = new ConflictModal(this.app, {
      path,
      // 磁盘那一份读不出来时"用磁盘版本"要置灰（对话框只关心这一件事，见 `ConflictModal`）
      diskUnreadable: payload.disk === null,
      onChoose: (choice) => {
        void this.resolveConflict(path, choice);
      },
      onDismissed: () => {
        this.conflictDialogs.delete(path);
      },
    });
    modal.open();
  }

  /**
   * 脑图的冲突：走**同一个**对话框（`06 §9` P3-c-2）。
   *
   * ★ 不另做一个对话框：`03 §3.4` 那三条路对两种文档逐字相同，而"同一种事两副面孔"
   *   正是用户最容易误操作的地方。差别只在"谁来执行"（各自的仓储）。
   * ★ 与白板共用同一个 `conflictDialogs` 集合：它按**路径**去重，而一条路径要么是
   *   `.nboard` 要么是 `.nestmind`，不会撞车。
   */
  private openMindConflictModal(payload: MindRepositoryEvents['conflict']): void {
    const { path } = payload;
    new Notice(t('notice.conflict', { path }));

    if (this.conflictDialogs.has(path)) return;
    this.conflictDialogs.add(path);

    new ConflictModal(this.app, {
      path,
      diskUnreadable: payload.disk === null,
      onChoose: (choice) => {
        void this.resolveMindConflict(path, choice);
      },
      onDismissed: () => {
        this.conflictDialogs.delete(path);
      },
    }).open();
  }

  private async resolveMindConflict(path: string, choice: ConflictChoice): Promise<void> {
    this.conflictDialogs.delete(path);
    try {
      if (choice === 'disk') {
        await this.mindRepository.useDisk(path);
        return;
      }
      if (choice === 'mine') {
        await this.mindRepository.keepMine(path);
        return;
      }
      const copyPath = await this.findFreeCopyPath(path, MIND_EXT);
      await this.mindRepository.saveAsCopy(path, copyPath);
      new Notice(t('notice.copySaved', { path: copyPath }));
    } catch (error) {
      new Notice(t('notice.saveFailed', { path, error: describeError(error) }));
    }
  }

  private async resolveConflict(path: string, choice: ConflictChoice): Promise<void> {
    this.conflictDialogs.delete(path);
    try {
      if (choice === 'disk') {
        await this.repository.useDisk(path);
        return;
      }
      if (choice === 'mine') {
        await this.repository.keepMine(path);
        return;
      }
      const copyPath = await this.findFreeCopyPath(path);
      await this.repository.saveAsCopy(path, copyPath);
      new Notice(t('notice.copySaved', { path: copyPath }));
    } catch (error) {
      new Notice(t('notice.saveFailed', { path, error: describeError(error) }));
    }
  }

  /**
   * `Boards/A.nboard` → `Boards/A (conflict 2026-09-11T02-00-00).nboard`
   *
   * ★ 扩展名是参数（`P3-c-2`）：脑图的副本要留 `.nestmind` —— 写成一个别的扩展名，
   *   下一次打开它就不是脑图了（"副本救回来了但打不开"是最糟的一种数据安全）。
   */
  private async findFreeCopyPath(path: string, ext: string = BOARD_EXT): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suffix = `.${ext}`;
    const base = path.endsWith(suffix) ? path.slice(0, -suffix.length) : path;

    for (let index = 1; index < 100; index++) {
      const tail = index === 1 ? '' : ` ${index}`;
      const candidate = `${base} (conflict ${stamp}${tail})${suffix}`;
      if (!(await this.vaultIO.exists(candidate))) return candidate;
    }
    return `${base} (conflict ${stamp} ${Date.now()})${suffix}`;
  }
}
