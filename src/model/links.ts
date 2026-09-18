/**
 * 引用与断链（T3.19 / `F8-07`）。
 *
 * 「这张卡指向的文件还在不在」原本只有卡片渲染时才知道 —— 每张卡各自去查一次
 * Vault，谁也没法回答"整块板一共有几处断链"。这里把"卡片上有哪些外部引用"
 * 抽成纯函数，**存在性判断仍由视图注入**（只有视图那层拿得到 Vault / URL 能力），
 * 于是"总览"与"过滤"可以共用同一份引用清单。
 *
 * ★ 为什么是"引用清单 + 判定"而不是直接返回断链：同一个清单要喂给两个消费者 ——
 *   断链总览（列出所有断链）与"只看断链"过滤（判断某张卡有没有断链）。
 *   直接返回断链会让后者变成"每个过滤器各扫一遍"。
 */

import { normalizeUrl } from '../util/linkPreview';
import type { BoardFile, Card, CardType } from '../model/schema';

/** 卡片可以指向的外部目标种类（决定"用什么方式判断它还在不在"） */
export type RefKind = 'image' | 'file' | 'noteRef' | 'boardRef' | 'link';

/** 一处外部引用 */
export interface CardRef {
  cardId: string;
  /** 卡片的标题（总览里要显示"是哪张卡断的"）；空串 = 这张卡没标题 */
  cardTitle: string;
  cardType: CardType;
  kind: RefKind;
  /** 引用目标：Vault 路径（前四种）或 URL（`link`） */
  path: string;
}

/**
 * 一张卡对外部世界的引用。
 *
 * `note`（内联便签）/ `todo` / `swatch` / `ink` 的内容全在 `.nboard` 里，
 * 不指向任何外部文件 —— 它们永远不会断链，所以不产生引用。
 *
 * ★ **空路径不算引用**：刚建好、还没选文件的卡片 `path === ''`，把它算成
 *   "断链"会让总览在新建一张图片卡后立刻报一条假警。
 */
export function refsOfCard(card: Card): CardRef[] {
  const base = { cardId: card.id, cardTitle: card.title, cardType: card.type };
  switch (card.type) {
    case 'image':
      return pathRef(base, 'image', card.content.path);
    case 'file':
      return pathRef(base, 'file', card.content.path);
    case 'noteRef':
      return pathRef(base, 'noteRef', card.content.path);
    case 'boardRef':
      return pathRef(base, 'boardRef', card.content.path);
    case 'link':
      return pathRef(base, 'link', card.content.url);
    // 便签 / 待办 / 色板 / 手绘都不指向库文件；同步便签（T7.04）与评论卡（T7.05）
    // 同理 —— 它们的正文都存在白板文件里，没有任何可断的外部引用
    case 'note':
    case 'todo':
    case 'swatch':
    case 'ink':
    case 'syncNote':
    case 'comment':
      return [];
    // 地图卡指向的也是一张图片文件（T7.03）：它一样会断，而"断的是一张图"
    // 对用户来说就是同一件事 —— 复用 `image` 这种引用种类，
    // 于是断链总览、只看断链、重新链接的扩展名过滤全都不用为它开新分支。
    case 'map':
      return pathRef(base, 'image', card.content.path);
    // 视频卡（`A1`）指向的是一份**文件**：断链 / 重新链接走"文件"那一套
    // （与文件卡同一个引用种类 —— 它俩在"这份文件还在不在"上没有区别）
    case 'video':
      return pathRef(base, 'file', card.content.path);
    // 音频卡（`A2`）：同上
    case 'audio':
      return pathRef(base, 'file', card.content.path);
    // 仅标题卡（`A3`）：只有一行字，不指向任何文件 ⇒ 没有引用可断
    case 'titleCard':
      return [];
    // 图集卡（`A4`）：**每一张图**都是一条图片引用 —— 断链总览里该看到
    // "这张卡里少了一张"，而不是整张卡一个引用都没有
    case 'gallery':
      return card.content.paths.flatMap((path) => pathRef(base, 'image', path));
    default:
      return assertNever(card);
  }
}

/** 整块白板上的全部引用（按 `board.cards` 顺序） */
export function collectRefs(board: BoardFile): CardRef[] {
  const refs: CardRef[] = [];
  for (const card of board.cards) refs.push(...refsOfCard(card));
  return refs;
}

/**
 * 断链清单。`isValid` 由调用方注入 —— 视图用它去 Vault 里查、或校验 URL。
 *
 * ★ 判定交给调用方而不是这里内置：`model/` 层不许 import `obsidian`
 *   （`03 §7.2`），而"文件在不在"只有 Obsidian 知道。
 */
export function brokenRefsOf(board: BoardFile, isValid: (ref: CardRef) => boolean): CardRef[] {
  return collectRefs(board).filter((ref) => !isValid(ref));
}

/** 默认的 URL 校验：`link` 卡用它判"链接是否还写得对"（Vault 能力不需要） */
export function isUsableUrl(ref: CardRef): boolean {
  return normalizeUrl(ref.path) !== null;
}

/** 有引用、且引用全都是 Vault 路径（`link` 除外）时，交给 `exists` 判 */
export function refExistsInVault(ref: CardRef, exists: (path: string) => boolean): boolean {
  if (ref.kind === 'link') return isUsableUrl(ref);
  return exists(ref.path) || ref.path.trim().length === 0;
}

function pathRef(
  base: { cardId: string; cardTitle: string; cardType: CardType },
  kind: RefKind,
  path: string,
): CardRef[] {
  const trimmed = path.trim();
  if (trimmed.length === 0) return [];
  return [{ ...base, kind, path: trimmed }];
}

function assertNever(value: never): never {
  throw new Error(`未处理的卡片类型：${JSON.stringify(value)}`);
}
