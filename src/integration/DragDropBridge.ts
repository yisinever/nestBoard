/**
 * 拖放接线（T1.63 / T1.64 / T1.65 / T6.11，`F6-01–F6-07`）。
 *
 * 四条来路，一套处理：
 *
 * | 来路 | `DataTransfer` 形态 | 走哪条路 |
 * | --- | --- | --- |
 * | Obsidian 文件浏览器（T1.64） | 只有文本：`obsidian://open?file=…` 或库内相对路径 | 直接建卡 |
 * | 别的笔记里拖出来的 `[[链接]]` | 库内相对路径 / 短名 | 直接建卡 |
 * | 系统文件管理器（T1.65） | `files` 里是二进制 | 先落库（`F9-01`）再建卡 |
 * | 笔记编辑器里选中的一段文字（T6.11） | 只有文本，且**不是**库内路径 | 直接变成一张便签卡 |
 *
 * ★ 判定的顺序是**先文本后文件**，不是反过来：Obsidian 内部的拖拽也可能带上
 *   一个空的 `files` 条目，先看 `files` 就会把"库里已有的文件"当成"外面来的新文件"
 *   复制一份进来。库里已经有的路径，永远优先直接用。
 *
 * ★ 拖到画布之外不会被处理 —— 监听器就挂在画布上，事件根本到不了这里（T1.64 的验收点之一）。
 *   真正需要额外小心的是反面：指针在**画布内部的卡片之间**移动时会连续触发
 *   `dragleave`，按它清预览就会疯狂闪烁，所以清预览前要确认"真的出去了"。
 *
 * ★ 本文件不 import `obsidian`：`inVault` / `importFile` 两个外部事实由调用方注入，
 *   于是"读 `DataTransfer` → 判定 → 落点"这条链能在 node 下用假事件走完。
 *
 * ★ 这里**只上报路径**，不认识卡片、不认识白板模型 —— 建卡与落位是 `BoardView` 的事。
 */

import type { DropCardKind, DropItem } from '../model/drop';
import {
  baseNameOf,
  dropKindForPath,
  dropTextPreviewName,
  noteContentFromDropText,
  normalizeDropPath,
  resolveDropText,
} from '../model/drop';

/** 预览里的一项：只有"会变成什么"，没有路径 —— 系统文件此刻还没有库内路径 */
export interface DragPreviewItem {
  kind: DropCardKind;
  name: string;
}

/** 拖拽预览（T1.66 的幽灵卡用它） */
export interface DragDropPreview {
  /** **客户端**坐标：视图自己减画布原点再换算世界坐标（与其余指针逻辑同一套约定） */
  clientX: number;
  clientY: number;
  items: DragPreviewItem[];
}

export interface DragDropPorts {
  /**
   * 把拖拽文本里的路径解析成库内真实路径。
   * 返回 `null` 表示"不在库里 / 不是文件 / 无法解析" —— 这类候选会被静默丢掉。
   * ★ 需要支持短名解析（`getFirstLinkpathDest`），因为 Obsidian 拖文件浏览器/链接
   *   时给的 text/plain 经常只有文件名，没有目录前缀。
   */
  resolvePath(path: string): string | null;
  /** 系统文件落库（T1.65）；失败返回 `null`，不要抛 */
  importFile(file: File): Promise<string | null>;
  /**
   * 只有 `text/uri-list`、没有 `files` 时的第二条落库路（macOS Finder 常见）。
   *
   * ★ 有些平台拖本地文件时 `dataTransfer.files` 是空的，只在 `text/uri-list`
   *   里留下 `file:///绝对路径`。这时没有 `File` 对象可读，只能把路径交回宿主
   *   （它能用 Node 的 `fs` 读盘）。可选：不实现就退回"什么都不发生"。
   */
  importUri?(absolutePath: string): Promise<string | null>;
  /** 预览（`null` = 收起）。会被高频调用（`dragover` 每帧一次），实现要够轻 */
  onPreview(preview: DragDropPreview | null): void;
  /** 落点：拿到的路径**保证已在库内**，顺序与拖入顺序一致（T1.66 的错开依赖它） */
  onDrop(paths: readonly string[], clientX: number, clientY: number): void;
  /**
   * 落点：拖进来的是一段**文本**（T6.11 / `F6-07`）—— 内容已归一化（换行统一、首尾去白）。
   *
   * ★ 与 `onDrop` 分成两个口而不是"路径列表里塞个假路径"：宿主那边要走完全不同的
   *   建卡路径（不是"路径 → 卡片"，而是"正文 → 便签卡"），还要写进历史，
   *   用同一个口就得在宿主里再判一次"这条路径是不是假的"。
   */
  onDropText?(content: string, clientX: number, clientY: number): void;
  /** 开始导入 N 个系统文件：导入要读盘 + 写盘，几百毫秒的空窗期得让用户知道 */
  onImporting?(count: number): void;
  /** 导入失败的原文件名（只提示，不阻断其余项） */
  onImportFailed?(names: readonly string[]): void;
}

/**
 * 需要的最小 DOM 能力。
 *
 * `HTMLElement` 结构上满足它，所以生产代码直接传画布元素即可；
 * 单测给一个只记账的假对象 —— 于是这套接线的判定逻辑不必依赖 jsdom。
 */
export interface DragHost {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void;
  /** `other` 是否在宿主内部。`other` 为 `null`（拖出了窗口）时必须返回 `false` */
  contains(other: unknown): boolean;
}

/** 待落卡的一项：系统文件此刻 `path` 还是 `null`，落库后才有 */
interface Candidate {
  path: string | null;
  file: File | null;
  /** 只有 `file://` URI、没有 `File` 对象时，这里是库外绝对路径（见 `importUri`） */
  uri?: string;
  /** 拖进来的**一段文本**（T6.11）：没有路径也没有文件，建卡用的是这段正文 */
  text?: string;
  name: string;
  kind: DropCardKind;
}

/** 读文本：拿不到（该类型不存在）返回 `null`，与"空字符串"区分开 */
function readText(transfer: DataTransfer, type: string): string | null {
  try {
    const value = transfer.getData(type);
    return value.length > 0 ? value : null;
  } catch {
    // 少数环境在 `dragover` 阶段拒绝读取；当作"没有"处理，`drop` 时还会再读一次
    return null;
  }
}

/**
 * 系统文件 → 候选。
 *
 * 文件夹会被 Electron 塞进 `files`（`type` 为空、`size` 为 0），放进来会写出一个
 * 0 字节的假文件；直接丢掉。代价是"0 字节且类型未知"的真实文件也不收 ——
 * 两害相权，凭空多出一个打不开的文件更糟。
 */
function fileCandidate(file: File): Candidate | null {
  if (file.size === 0 && file.type === '') return null;
  return { path: null, file, name: file.name, kind: dropKindForPath(file.name) };
}

/**
 * `text/uri-list` 里指向系统文件的项 → 库外绝对路径。
 *
 * 每行一个 URI，`#` 开头是注释（RFC 2483）。只收 `file://` —— `http://` 那种
 * 外链不该变成卡片（合规：不抓取外部内容，`03 §7.5`），`normalizeDropPath`
 * 已经会把带 scheme 的非文件 URL 变成空串，这里再显式挡一道更清楚。
 */
function externalFilePaths(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || !/^file:\/\//i.test(trimmed)) {
      continue;
    }
    let path = normalizeDropPath(trimmed, true);
    // `file:///C:/Users/…` 去掉 scheme 后是 `/C:/Users/…`，多一个前导斜杠；
    // Windows 上 `fs` 不认这个形态，去掉它才读得到
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export class DragDropBridge {
  private readonly listeners: { type: string; listener: EventListener }[] = [];
  /** 目前是否已经报过预览：避免在 `dragleave` 里对着一片空白反复喊"收起" */
  private previewing = false;
  private disposed = false;

  constructor(
    private readonly host: DragHost,
    private readonly ports: DragDropPorts,
  ) {
    // `dragenter` 与 `dragover` 同一套处理：前者是许多浏览器真正决定
    // "这里能不能放"的时机，只在 `dragover` 上 `preventDefault` 会有人放不进来
    this.listen('dragenter', this.handleDragOver);
    this.listen('dragover', this.handleDragOver);
    this.listen('dragleave', this.handleDragLeave);
    this.listen('drop', this.handleDrop);
  }

  dispose(): void {
    this.disposed = true;
    for (const { type, listener } of this.listeners.splice(0)) {
      this.host.removeEventListener(type, listener);
    }
    this.previewing = false;
  }

  // ── 事件 ─────────────────────────────────────────────────

  private readonly handleDragOver = (event: DragEvent): void => {
    const candidates = this.readCandidates(event);
    // 系统文件管理器在 dragover 阶段不会暴露 `files`，只能看到 `text/uri-list`
    // 或 `Files` 类型标记；不提前 preventDefault，drop 事件就落不到画布上。
    // 对候选为空但"看起来是外部文件"的情况也放行，drop 阶段再按 files 真正处理。
    const mayAccept = candidates.length > 0 || this.mightAcceptExternal(event);
    if (!mayAccept) {
      this.clearPreview();
      return;
    }
    event.preventDefault();
    // ★ 也要挡住冒泡：工作区自己也在监听拖放，不拦就会"卡片建出来了，
    //   同时那个文件还在新标签页里打开了一次"（F6-06 的验收点）
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.publishPreview(event, candidates);
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    // 指针只是在画布内部的元素之间移动（画布 → 卡片 → 画布）也会触发 `dragleave`；
    // 只有"真的离开了宿主"才收起预览，否则拖过每张卡片都会闪一下
    if (this.host.contains(event.relatedTarget)) return;
    this.clearPreview();
  };

  private readonly handleDrop = (event: DragEvent): void => {
    const candidates = this.readCandidates(event);
    this.clearPreview();
    if (candidates.length === 0) {
      // ★ "拖进来了、然后什么都不发生"是最糟的一种反馈 —— 用户只会认为插件坏了。
      //   而这里确实存在一类**真实意图落空**：系统给了 `files`（说明拖的确实是文件），
      //   但每一项都被判成不可导入。目前只有一种：**文件夹**（Electron 给它的
      //   `size` 是 0、`type` 是空串，落库会写出一个 0 字节的假文件，故在
      //   `fileCandidate` 里被丢掉）。这时必须说一句话，而不是静默返回。
      //   ★ 只在 `files` 非空时才提示：拖一段文字进来本来就该无声无息。
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        this.ports.onImportFailed?.(files.map((file) => file.name));
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.land(candidates, event.clientX, event.clientY);
  };

  /** 外部系统文件管理器在 dragover 阶段只留下类型标记，真正的 files 要到 drop 才能读 */
  private mightAcceptExternal(event: DragEvent): boolean {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const types = Array.from(transfer.types ?? []);
    return types.includes('Files') || types.includes('text/uri-list');
  }

  // ── 读 `DataTransfer` ────────────────────────────────────

  private readCandidates(event: DragEvent): Candidate[] {
    const transfer = event.dataTransfer;
    if (!transfer) return [];

    const resolvePath = (path: string): string | null => this.ports.resolvePath(path);

    // ① 文本里的**库内路径**优先（T1.63 / T1.64）：库里已经有了，不必也不该再复制一份
    const text = readText(transfer, 'text/plain') ?? readText(transfer, 'text/uri-list');
    if (text !== null) {
      const known = resolveDropText(text, resolvePath);
      if (known.length > 0) return known.map(toCandidate);
    }

    // ② 剩下的才是系统文件（T1.65）：必须先把二进制落进库，才有路径能建卡
    const files = Array.from(transfer.files ?? []);
    if (files.length > 0) {
      const mapped: Candidate[] = [];
      for (const file of files) {
        const candidate = fileCandidate(file);
        if (candidate) mapped.push(candidate);
      }
      return mapped;
    }

    // ③ macOS Finder 有时既不给库内路径、也不给 `files`，只在 `text/uri-list`
    //    留一串 `file:///…`。这时没有 `File` 对象可读，只能把绝对路径交给宿主去读盘。
    const uriText = readText(transfer, 'text/uri-list');
    if (uriText !== null && this.ports.importUri) {
      const external = externalFilePaths(uriText);
      if (external.length > 0) {
        return external.map((absolutePath) => ({
          path: null,
          file: null,
          uri: absolutePath,
          name: baseNameOf(absolutePath),
          kind: dropKindForPath(absolutePath),
        }));
      }
    }

    // ④ 剩下的文本 → **便签卡**（T6.11 / `F6-07`：从笔记编辑器拖选中的一段文字进来）。
    //    ★ 必须排在最后：它接住的是"前面三条都不成立"的文本，于是拖系统文件、
    //      拖库内链接、拖 `file://` 的行为一个字节都没变。
    //    ★ `file://` 那一串仍要显式挡一道：**多行**的 uri-list 不满足 `BARE_URL`
    //      的单行形态，若在这里变成一张写着路径的便签卡，就等于把 T1.65 截胡了。
    if (text !== null && externalFilePaths(text).length === 0) {
      const content = noteContentFromDropText(text);
      if (content !== null) {
        return [
          {
            path: null,
            file: null,
            text: content,
            name: dropTextPreviewName(content),
            kind: 'note',
          },
        ];
      }
    }

    return [];
  }

  // ── 预览（T1.66） ────────────────────────────────────────

  private publishPreview(event: DragEvent, candidates: readonly Candidate[]): void {
    this.previewing = true;
    this.ports.onPreview({
      clientX: event.clientX,
      clientY: event.clientY,
      items: candidates.map((candidate) => ({ kind: candidate.kind, name: candidate.name })),
    });
  }

  private clearPreview(): void {
    if (!this.previewing) return;
    this.previewing = false;
    this.ports.onPreview(null);
  }

  // ── 落点 ─────────────────────────────────────────────────

  private async land(
    candidates: readonly Candidate[],
    clientX: number,
    clientY: number,
  ): Promise<void> {
    // 文本候选不用落库（它就是内容本身），算不上"待导入" —— 数进去会平白弹一句
    // "正在导入 1 个文件"
    const pending = candidates.filter(
      (candidate) => candidate.path === null && candidate.text === undefined,
    ).length;
    if (pending > 0) this.ports.onImporting?.(pending);

    const paths: string[] = [];
    const texts: string[] = [];
    const failed: string[] = [];

    for (const candidate of candidates) {
      if (candidate.path !== null) {
        paths.push(candidate.path);
        continue;
      }

      // 文本候选（T6.11）：不落库、不建"路径卡"，交给宿主当便签正文
      if (candidate.text !== undefined) {
        texts.push(candidate.text);
        continue;
      }

      // ★ 串行而不是 `Promise.all`：一次并发读二十个文件会把内存顶出一个尖峰，
      //   而且**顺序就是落位顺序**（T1.66 的错开落位依赖它）—— 并发会让顺序随机
      let imported: string | null = null;
      try {
        if (candidate.file) imported = await this.ports.importFile(candidate.file);
        else if (candidate.uri && this.ports.importUri) {
          imported = await this.ports.importUri(candidate.uri);
        }
      } catch {
        imported = null;
      }
      if (imported !== null && imported.length > 0) paths.push(imported);
      else failed.push(candidate.name);
    }

    if (failed.length > 0) this.ports.onImportFailed?.(failed);
    // 中途被关掉视图：`dispose` 之后不要再往一个死视图里塞卡片
    if (this.disposed) return;
    if (paths.length > 0) this.ports.onDrop(paths, clientX, clientY);
    for (const content of texts) this.ports.onDropText?.(content, clientX, clientY);
  }

  private listen(type: string, handler: (event: DragEvent) => void): void {
    const listener = handler as unknown as EventListener;
    // `preventDefault` 要求非 passive 监听器；拖放事件默认非 passive，
    // 但显式写出来才不会在某天被人加上全局默认值后静默失效
    const options: AddEventListenerOptions | undefined =
      type === 'dragleave' ? undefined : { passive: false };
    this.host.addEventListener(type, listener, options);
    this.listeners.push({ type, listener });
  }
}

/** 库内已有路径 → 候选 */
function toCandidate(item: DropItem): Candidate {
  return { path: item.path, file: null, name: item.name, kind: item.kind };
}
