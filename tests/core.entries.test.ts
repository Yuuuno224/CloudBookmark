import { describe, expect, it } from 'vitest';
import {
  buildTree,
  childrenOrder,
  collectSubtreeUids,
  contentEquals,
  countKinds,
  normalizeIndexes,
  repairHierarchy,
} from '@/core/entries';
import type { Entry } from '@/core/types';
import { bookmark, childUids, find, folder, roots } from './helpers';

describe('内容比较', () => {
  it('index 不同不算内容变化（排序单独处理）', () => {
    const a = bookmark('b1', 'root:0', 0, 'A', 'https://a.com');
    const b = { ...a, index: 5 };
    expect(contentEquals(a, b)).toBe(true);
  });

  it('换文件夹算内容变化', () => {
    const a = bookmark('b1', 'root:0', 0, 'A', 'https://a.com');
    expect(contentEquals(a, { ...a, parentUid: 'root:1' })).toBe(false);
  });

  it('网址变化算内容变化', () => {
    const a = bookmark('b1', 'root:0', 0, 'A', 'https://a.com');
    expect(contentEquals(a, { ...a, url: 'https://b.com' })).toBe(false);
  });
});

describe('层级修复', () => {
  it('父亲不存在的孤儿会被挂到其他书签下，而不是被丢掉', () => {
    const entries: Entry[] = [...roots(), bookmark('orphan', '不存在的文件夹', 0, '孤儿', 'https://o.com')];
    const result = repairHierarchy(entries);
    expect(result.entries).toHaveLength(entries.length);
    expect(find(result.entries, 'orphan').parentUid).toBe('root:1');
    expect(result.warnings[0]!.code).toBe('orphan-reattached');
  });

  it('互相做父亲的环会被打断', () => {
    const entries: Entry[] = [
      ...roots(),
      folder('x', 'y', 0, 'X'),
      folder('y', 'x', 0, 'Y'),
    ];
    const result = repairHierarchy(entries);
    expect(result.entries).toHaveLength(4);
    expect(result.warnings.some((warning) => warning.code === 'cycle-broken')).toBe(true);
    // 修复后每条记录的父亲都必须真实存在
    for (const entry of result.entries) {
      if (entry.parentUid === '') continue;
      expect(result.entries.some((candidate) => candidate.uid === entry.parentUid)).toBe(true);
    }
  });

  it('自己当自己的父亲也能被打断', () => {
    const entries: Entry[] = [...roots(), folder('self', 'self', 0, '自环')];
    const result = repairHierarchy(entries);
    expect(find(result.entries, 'self').parentUid).toBe('root:1');
  });

  it('没有"其他书签"时兜底挂到第一个根目录', () => {
    const entries: Entry[] = [folder('root:0', '', 0, '书签栏'), bookmark('orphan', 'nope', 0, '孤儿', 'https://o.com')];
    expect(find(repairHierarchy(entries).entries, 'orphan').parentUid).toBe('root:0');
  });

  it('一个根目录都没有时，孤儿变成顶层节点（仍然不丢）', () => {
    const entries: Entry[] = [bookmark('orphan', 'nope', 0, '孤儿', 'https://o.com')];
    const result = repairHierarchy(entries);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.parentUid).toBe('');
  });

  it('重复 uid 只保留第一条', () => {
    const entries: Entry[] = [...roots(), folder('dup', 'root:0', 0, '第一'), folder('dup', 'root:0', 1, '第二')];
    const result = repairHierarchy(entries);
    expect(result.entries.filter((entry) => entry.uid === 'dup')).toHaveLength(1);
    expect(find(result.entries, 'dup').title).toBe('第一');
  });
});

describe('编号与排序', () => {
  it('index 被重新编号成 0..n-1', () => {
    const entries: Entry[] = [
      ...roots(),
      bookmark('a', 'root:0', 10, 'A', 'https://a.com'),
      bookmark('b', 'root:0', 3, 'B', 'https://b.com'),
    ];
    const normalized = normalizeIndexes(entries);
    expect(find(normalized, 'b').index).toBe(0);
    expect(find(normalized, 'a').index).toBe(1);
  });

  it('childrenOrder 按 index 返回 uid', () => {
    const entries: Entry[] = [...roots(), bookmark('a', 'root:0', 1, 'A', 'https://a.com'), bookmark('b', 'root:0', 0, 'B', 'https://b.com')];
    expect(childrenOrder(entries, 'root:0')).toEqual(['b', 'a']);
  });
});

describe('子树收集', () => {
  it('能取到所有后代（不含自己）', () => {
    const entries: Entry[] = [
      ...roots(),
      folder('f1', 'root:0', 0, 'F1'),
      folder('f2', 'f1', 0, 'F2'),
      bookmark('b1', 'f2', 0, 'B1', 'https://b1.com'),
    ];
    const subtree = collectSubtreeUids(entries, 'f1');
    expect([...subtree].sort()).toEqual(['b1', 'f2']);
  });
});

describe('组装成树', () => {
  it('层级和顺序都正确', () => {
    const entries: Entry[] = [
      ...roots(),
      folder('f1', 'root:0', 0, '开发'),
      bookmark('b1', 'f1', 0, 'GitHub', 'https://github.com'),
      bookmark('b2', 'f1', 1, 'MDN', 'https://developer.mozilla.org'),
      bookmark('b3', 'root:1', 0, '其他', 'https://other.com'),
    ];
    const tree = buildTree(entries);
    expect(tree.map((node) => node.uid)).toEqual(['root:0', 'root:1']);
    expect(tree[0]!.children.map((node) => node.uid)).toEqual(['f1']);
    expect(tree[0]!.children[0]!.children.map((node) => node.uid)).toEqual(['b1', 'b2']);
    expect(tree[1]!.children.map((node) => node.uid)).toEqual(['b3']);
  });
});

describe('统计', () => {
  it('数出文件夹和书签数量', () => {
    expect(countKinds([...roots(), bookmark('b1', 'root:0', 0, 'A', 'https://a.com')])).toEqual({
      folders: 2,
      bookmarks: 1,
      total: 3,
    });
  });
});

describe('组合场景：脏数据 + 组树', () => {
  it('孤儿节点在树上也能看到（挂在其他书签下）', () => {
    const entries: Entry[] = [...roots(), bookmark('orphan', 'ghost', 0, '孤儿', 'https://o.com')];
    const tree = buildTree(repairHierarchy(entries).entries);
    expect(childUids(repairHierarchy(entries).entries, 'root:1')).toEqual(['orphan']);
    expect(tree).toHaveLength(2);
  });
});
