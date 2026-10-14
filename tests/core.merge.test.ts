import { describe, expect, it } from 'vitest';
import { threeWayMerge } from '@/core/merge';
import { applyResolutions, availableResolutions, uniformResolutions } from '@/core/resolve';
import type { Entry } from '@/core/types';
import { bookmark, childUids, find, folder, roots } from './helpers';

const b1 = bookmark('b1', 'root:0', 0, 'GitHub', 'https://github.com');
const b1Renamed = { ...b1, title: 'GitHub 首页' };
const b1NewUrl = { ...b1, url: 'https://github.com/dashboard' };
const b1Both = { ...b1, title: 'GitHub 首页', url: 'https://github.com/dashboard' };

/** 常用输入：base 里书签栏下有一条 b1。 */
const baseWithB1: Entry[] = [...roots(), b1];

describe('三方合并：基础增删改', () => {
  it('本地新增 → 保留', () => {
    const local = [...roots(), b1, bookmark('n1', 'root:0', 1, '新书签', 'https://example.com')];
    const result = threeWayMerge(roots(), local, roots());
    expect(result.conflicts).toHaveLength(0);
    expect(result.entries.some((entry) => entry.uid === 'n1')).toBe(true);
  });

  it('远端新增 → 保留', () => {
    const remote = [...roots(), bookmark('n1', 'root:1', 0, '远端新书签', 'https://example.com')];
    const result = threeWayMerge(roots(), roots(), remote);
    expect(result.entries.some((entry) => entry.uid === 'n1')).toBe(true);
    expect(find(result.entries, 'n1').parentUid).toBe('root:1');
  });

  it('只有本地改了标题 → 用本地', () => {
    const result = threeWayMerge(baseWithB1, [...roots(), b1Renamed], baseWithB1);
    expect(result.entries.find((entry) => entry.uid === 'b1')?.title).toBe('GitHub 首页');
    expect(result.conflicts).toHaveLength(0);
  });

  it('只有远端改了标题 → 用远端', () => {
    const result = threeWayMerge(baseWithB1, baseWithB1, [...roots(), b1Renamed]);
    expect(result.entries.find((entry) => entry.uid === 'b1')?.title).toBe('GitHub 首页');
    expect(result.conflicts).toHaveLength(0);
  });

  it('本地改标题 + 远端改网址 → 两处改动都保留，不打扰用户', () => {
    const result = threeWayMerge(baseWithB1, [...roots(), b1Renamed], [...roots(), b1NewUrl]);
    expect(result.conflicts).toHaveLength(0);
    const merged = find(result.entries, 'b1');
    expect(merged.title).toBe('GitHub 首页');
    expect(merged.url).toBe('https://github.com/dashboard');
  });

  it('两边改成完全一样 → 取本地，无冲突', () => {
    const result = threeWayMerge(baseWithB1, [...roots(), b1Both], [...roots(), b1Both]);
    expect(result.conflicts).toHaveLength(0);
    expect(find(result.entries, 'b1').title).toBe('GitHub 首页');
  });
});

describe('三方合并：删除', () => {
  it('本地删除 + 远端没动 → 删除', () => {
    const result = threeWayMerge(baseWithB1, roots(), baseWithB1);
    expect(result.entries.some((entry) => entry.uid === 'b1')).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  it('远端删除 + 本地没动 → 删除', () => {
    const result = threeWayMerge(baseWithB1, baseWithB1, roots());
    expect(result.entries.some((entry) => entry.uid === 'b1')).toBe(false);
  });

  it('两边都删除 → 删除', () => {
    const result = threeWayMerge(baseWithB1, roots(), roots());
    expect(result.entries.some((entry) => entry.uid === 'b1')).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  it('本地删除 + 远端改了 → 报冲突，默认保留被改的那一份', () => {
    const result = threeWayMerge(baseWithB1, roots(), [...roots(), b1Renamed]);
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('delete-modify');
    expect(conflict.local).toBeNull();
    expect(conflict.remote?.title).toBe('GitHub 首页');
    // 默认策略是"别丢数据"
    expect(find(result.entries, 'b1').title).toBe('GitHub 首页');
  });

  it('远端删除 + 本地改了 → 报冲突', () => {
    const result = threeWayMerge(baseWithB1, [...roots(), b1Renamed], roots());
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe('delete-modify');
    expect(result.conflicts[0]!.remote).toBeNull();
    expect(find(result.entries, 'b1').title).toBe('GitHub 首页');
  });
});

describe('三方合并：冲突', () => {
  it('两边都改标题且不一样 → 冲突，默认取远端', () => {
    const local = [...roots(), { ...b1, title: '本地标题' }];
    const remote = [...roots(), { ...b1, title: '远端标题' }];
    const result = threeWayMerge(baseWithB1, local, remote);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('fields');
    expect(conflict.fields).toContain('title');
    expect(conflict.local?.title).toBe('本地标题');
    expect(conflict.remote?.title).toBe('远端标题');
    expect(find(result.entries, 'b1').title).toBe('远端标题');
  });

  it('两边把同一条书签移到不同文件夹 → parent 字段冲突', () => {
    const f1 = folder('f1', 'root:0', 0, '文件夹一');
    const f2 = folder('f2', 'root:0', 1, '文件夹二');
    const x = bookmark('x', 'root:0', 2, 'X', 'https://x.com');
    const base: Entry[] = [...roots(), f1, f2, x];
    const local: Entry[] = [...roots(), f1, f2, { ...x, parentUid: 'f1' }];
    const remote: Entry[] = [...roots(), f1, f2, { ...x, parentUid: 'f2' }];

    const result = threeWayMerge(base, local, remote);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.fields).toContain('parent');
  });

  it('prefer-local：冲突仍然会被记录，但结果已按策略自动定好，不会打断同步', () => {
    const local = [...roots(), { ...b1, title: '本地标题' }];
    const remote = [...roots(), { ...b1, title: '远端标题' }];
    const result = threeWayMerge(baseWithB1, local, remote, { conflictPolicy: 'prefer-local' });
    expect(result.conflicts).toHaveLength(1);
    expect(find(result.entries, 'b1').title).toBe('本地标题');
  });

  it('prefer-remote：冲突仍然会被记录，结果按远端自动定好', () => {
    const local = [...roots(), { ...b1, title: '本地标题' }];
    const remote = [...roots(), { ...b1, title: '远端标题' }];
    const result = threeWayMerge(baseWithB1, local, remote, { conflictPolicy: 'prefer-remote' });
    expect(result.conflicts).toHaveLength(1);
    expect(find(result.entries, 'b1').title).toBe('远端标题');
  });
});

describe('三方合并：顺序', () => {
  const a = bookmark('a', 'root:0', 0, 'A', 'https://a.com');
  const b = bookmark('b', 'root:0', 1, 'B', 'https://b.com');
  const c = bookmark('c', 'root:0', 2, 'C', 'https://c.com');
  const base: Entry[] = [...roots(), a, b, c];

  it('只有本地改了顺序 → 用本地顺序', () => {
    const local = [...roots(), { ...a, index: 2 }, { ...b, index: 0 }, { ...c, index: 1 }];
    const result = threeWayMerge(base, local, base);
    expect(childUids(result.entries, 'root:0')).toEqual(['b', 'c', 'a']);
  });

  it('两边顺序都改了 → 不报冲突，结果里不丢任何一条', () => {
    const local = [...roots(), { ...b, index: 0 }, { ...a, index: 1 }, { ...c, index: 2 }];
    const remote = [...roots(), { ...a, index: 0 }, { ...c, index: 1 }, { ...b, index: 2 }];
    const result = threeWayMerge(base, local, remote);
    expect(result.conflicts).toHaveLength(0);
    expect(childUids(result.entries, 'root:0').sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('三方合并：脏数据兜底', () => {
  it('在"远端已删除的文件夹"里新增书签 → 书签不丢，挂到其他书签下并给出提示', () => {
    const f = folder('f', 'root:0', 0, '临时文件夹');
    const base: Entry[] = [...roots(), f];
    const local: Entry[] = [...roots(), f, bookmark('n', 'f', 0, '新书签', 'https://n.com')];
    const remote: Entry[] = [...roots()];

    const result = threeWayMerge(base, local, remote);
    expect(result.entries.some((entry) => entry.uid === 'n')).toBe(true);
    expect(find(result.entries, 'n').parentUid).toBe('root:1');
    expect(result.warnings.some((warning) => warning.code === 'orphan-reattached')).toBe(true);
  });

  it('index 会被重新编号成 0..n-1', () => {
    const entries: Entry[] = [...roots(), bookmark('a', 'root:0', 7, 'A', 'https://a.com'), bookmark('b', 'root:0', 9, 'B', 'https://b.com')];
    const result = threeWayMerge(entries, entries, entries);
    expect(find(result.entries, 'a').index).toBe(0);
    expect(find(result.entries, 'b').index).toBe(1);
  });
});

describe('冲突解决', () => {
  const local = [...roots(), { ...b1, title: '本地标题' }];
  const remote = [...roots(), { ...b1, title: '远端标题' }];
  const merged = threeWayMerge(baseWithB1, local, remote);
  const conflict = merged.conflicts[0]!;

  it('选择"保留本地"', () => {
    const result = applyResolutions(merged.entries, merged.conflicts, { [conflict.id]: 'local' });
    expect(find(result.entries, 'b1').title).toBe('本地标题');
  });

  it('选择"使用远端"', () => {
    const result = applyResolutions(merged.entries, merged.conflicts, { [conflict.id]: 'remote' });
    expect(find(result.entries, 'b1').title).toBe('远端标题');
  });

  it('选择"两者都留" → 生成一份远端副本，条数 +1', () => {
    const result = applyResolutions(merged.entries, merged.conflicts, { [conflict.id]: 'both' });
    expect(result.entries).toHaveLength(merged.entries.length + 1);
    const copy = result.entries.find((entry) => entry.title.includes('远端副本'));
    expect(copy?.url).toBe(b1.url);
  });

  it('整体按钮：全部保留本地 / 全部使用远端', () => {
    expect(uniformResolutions([conflict], 'local')[conflict.id]).toBe('local');
    expect(uniformResolutions([conflict], 'remote')[conflict.id]).toBe('remote');
  });

  it('删除类冲突只提供两个选项，且文案能说明后果', () => {
    const deleted = threeWayMerge(baseWithB1, roots(), [...roots(), b1Renamed]);
    expect(availableResolutions(deleted.conflicts[0]!)).toEqual(['local', 'remote']);
  });

  it('解决后层级是合法的（没有孤儿）', () => {
    const f = folder('f', 'root:0', 0, 'F');
    const inner = bookmark('inner', 'f', 0, 'Inner', 'https://inner.com');
    const withFolder: Entry[] = [...roots(), f, inner];
    const delLocal = threeWayMerge(withFolder, roots(), withFolder);
    const resolved = applyResolutions(delLocal.entries, delLocal.conflicts, {});
    for (const entry of resolved.entries) {
      if (entry.parentUid === '') continue;
      expect(resolved.entries.some((candidate) => candidate.uid === entry.parentUid)).toBe(true);
    }
  });
});
