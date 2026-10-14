import { describe, expect, it } from 'vitest';
import {
  applyIdentityLinks,
  computeRevision,
  createSnapshot,
  diffCounts,
  findDuplicateUrls,
  normalizeUrl,
  parseSnapshot,
  reconcileFirstSync,
  serializeSnapshot,
} from '@/core/snapshot';
import type { Entry } from '@/core/types';
import { bookmark, childUids, find, folder, roots } from './helpers';

const device = { deviceId: 'dev-a', deviceName: 'Chrome on Windows' };

describe('指纹（revision）', () => {
  it('内容一样 → 指纹一样', () => {
    const a = [...roots(), bookmark('b1', 'root:0', 0, 'A', 'https://a.com')];
    const b = [...roots(), bookmark('b1', 'root:0', 0, 'A', 'https://a.com')];
    expect(computeRevision(a)).toBe(computeRevision(b));
  });

  it('只有时间戳变化 → 指纹不变（避免无意义的上传）', () => {
    const a = [...roots(), bookmark('b1', 'root:0', 0, 'A', 'https://a.com')];
    const b = a.map((entry) => ({ ...entry, updatedAt: '2030-01-01T00:00:00.000Z' }));
    expect(computeRevision(a)).toBe(computeRevision(b));
  });

  it('标题变化 → 指纹变化', () => {
    const a = [...roots(), bookmark('b1', 'root:0', 0, 'A', 'https://a.com')];
    const b = [...roots(), bookmark('b1', 'root:0', 0, 'B', 'https://a.com')];
    expect(computeRevision(a)).not.toBe(computeRevision(b));
  });

  it('数组顺序不同但内容相同 → 指纹相同', () => {
    const a = [...roots(), bookmark('b1', 'root:0', 0, 'A', 'https://a.com'), bookmark('b2', 'root:0', 1, 'B', 'https://b.com')];
    const b = [...a].reverse();
    expect(computeRevision(a)).toBe(computeRevision(b));
  });
});

describe('序列化 / 反序列化', () => {
  it('往返之后内容一致', () => {
    const entries: Entry[] = [
      ...roots(),
      folder('f1', 'root:0', 0, '开发'),
      bookmark('b1', 'f1', 0, 'GitHub', 'https://github.com'),
      bookmark('b2', 'root:1', 0, 'MDN', 'https://developer.mozilla.org'),
    ];
    const snapshot = createSnapshot(entries, device);
    const text = serializeSnapshot(snapshot);
    const parsed = parseSnapshot(text, device);

    expect(parsed.migrated).toBe(false);
    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.snapshot.entries).toHaveLength(entries.length);
    expect(parsed.snapshot.revision).toBe(snapshot.revision);
    expect(find(parsed.snapshot.entries, 'b1').parentUid).toBe('f1');
  });

  it('每条记录占一行，Gist 里肉眼可读', () => {
    const snapshot = createSnapshot([...roots(), bookmark('b1', 'root:0', 0, 'GitHub', 'https://github.com')], device);
    const text = serializeSnapshot(snapshot);
    expect(text).toContain('"kind": "cloudbookmark"');
    expect(text.split('\n').filter((line) => line.trim().startsWith('{"uid"')).length).toBe(3);
  });

  it('坏 JSON → 抛出可读错误', () => {
    expect(() => parseSnapshot('{ 这不是 json', device)).toThrowError(/JSON/);
  });

  it('缺字段的记录会被补全而不是让整份数据解析失败', () => {
    const text = JSON.stringify({
      kind: 'cloudbookmark',
      entries: [{ uid: 'x1', parentUid: 'root:0', index: 0, title: '只有标题' }],
    });
    const parsed = parseSnapshot(text, device);
    expect(parsed.snapshot.entries).toHaveLength(1);
    expect(find(parsed.snapshot.entries, 'x1').kind).toBe('folder');
    expect(find(parsed.snapshot.entries, 'x1').url).toBeNull();
  });

  it('重复 uid 会被重新分配并给出提示', () => {
    const text = JSON.stringify({
      kind: 'cloudbookmark',
      entries: [
        { uid: 'dup', parentUid: '', index: 0, kind: 'folder', title: 'A' },
        { uid: 'dup', parentUid: '', index: 1, kind: 'folder', title: 'B' },
      ],
    });
    const parsed = parseSnapshot(text, device);
    expect(parsed.snapshot.entries).toHaveLength(2);
    expect(new Set(parsed.snapshot.entries.map((entry) => entry.uid)).size).toBe(2);
    expect(parsed.warnings.some((warning) => warning.code === 'uid-duplicated')).toBe(true);
  });
});

describe('旧版本格式迁移', () => {
  const legacy = JSON.stringify({
    version: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
    checksum: 'abc',
    roots: {
      bookmark_bar: {
        id: '1',
        title: '书签栏',
        type: 'folder',
        children: [
          {
            id: 'bm_5',
            title: '开发',
            type: 'folder',
            children: [
              { id: 'bm_6', title: 'GitHub', type: 'bookmark', url: 'https://github.com' },
            ],
          },
          { id: 'bm_7', title: 'MDN', type: 'bookmark', url: 'https://developer.mozilla.org' },
        ],
      },
      other: { id: '2', title: '其他书签', type: 'folder', children: [] },
    },
  });

  it('层级、标题、网址都被保留下来', () => {
    const parsed = parseSnapshot(legacy, device);
    expect(parsed.migrated).toBe(true);
    expect(parsed.warnings.some((warning) => warning.code === 'legacy-migrated')).toBe(true);

    const entries = parsed.snapshot.entries;
    expect(entries.filter((entry) => entry.parentUid === '')).toHaveLength(2);

    const folderEntry = entries.find((entry) => entry.title === '开发');
    const github = entries.find((entry) => entry.title === 'GitHub');
    expect(github?.parentUid).toBe(folderEntry?.uid);
    expect(github?.url).toBe('https://github.com');
    expect(childUids(entries, 'root:0')).toHaveLength(2);
  });

  it('迁移结果是合法层级（没有孤儿）', () => {
    const parsed = parseSnapshot(legacy, device);
    for (const entry of parsed.snapshot.entries) {
      if (entry.parentUid === '') continue;
      expect(parsed.snapshot.entries.some((candidate) => candidate.uid === entry.parentUid)).toBe(true);
    }
  });
});

describe('首次同步配对', () => {
  it('URL 相同的书签会被认成同一条，不会产生重复', () => {
    const local: Entry[] = [...roots(), bookmark('local-1', 'root:0', 0, 'GitHub', 'https://github.com/')];
    const remote: Entry[] = [...roots(), bookmark('remote-1', 'root:0', 0, 'GitHub', 'https://github.com')];

    const { links, localOnly, remoteOnly } = reconcileFirstSync(local, remote);
    expect(links).toEqual([{ localUid: 'local-1', remoteUid: 'remote-1' }]);
    expect(localOnly).toHaveLength(0);
    expect(remoteOnly).toHaveLength(0);
  });

  it('配对后改写 uid，合并时就是"同一条"，不会两边各建一条', () => {
    const local: Entry[] = [...roots(), bookmark('local-1', 'root:0', 0, 'GitHub', 'https://github.com')];
    const { links } = reconcileFirstSync(local, [
      ...roots(),
      bookmark('remote-1', 'root:0', 0, 'GitHub', 'https://github.com'),
    ]);
    const { entries, renames } = applyIdentityLinks(local, links);
    expect(renames.get('local-1')).toBe('remote-1');
    expect(entries.some((entry) => entry.uid === 'remote-1')).toBe(true);
    expect(entries.some((entry) => entry.uid === 'local-1')).toBe(false);
  });

  it('父子关系会跟着 uid 改写一起更新', () => {
    const local: Entry[] = [
      ...roots(),
      folder('lf', 'root:0', 0, '开发'),
      bookmark('lb', 'lf', 0, 'GitHub', 'https://github.com'),
    ];
    const links = [{ localUid: 'lf', remoteUid: 'rf' }];
    const { entries } = applyIdentityLinks(local, links);
    expect(find(entries, 'lb').parentUid).toBe('rf');
  });

  it('同 URL 出现多次时不猜，交给用户', () => {
    const local: Entry[] = [
      ...roots(),
      bookmark('l1', 'root:0', 0, 'A', 'https://dup.com'),
      bookmark('l2', 'root:0', 1, 'B', 'https://dup.com'),
    ];
    const remote: Entry[] = [...roots(), bookmark('r1', 'root:0', 0, 'A', 'https://dup.com')];
    const { links } = reconcileFirstSync(local, remote);
    expect(links).toHaveLength(0);
  });

  it('同名文件夹会配对', () => {
    const local: Entry[] = [...roots(), folder('lf', 'root:0', 0, '开发')];
    const remote: Entry[] = [...roots(), folder('rf', 'root:0', 0, '开发')];
    expect(reconcileFirstSync(local, remote).links).toEqual([{ localUid: 'lf', remoteUid: 'rf' }]);
  });
});

describe('URL 归一化与重复检测', () => {
  it('大小写、末尾斜杠会被统一', () => {
    expect(normalizeUrl('HTTPS://GitHub.com/')).toBe('https://github.com');
    expect(normalizeUrl('https://github.com')).toBe('https://github.com');
  });

  it('查询串和锚点保留（不轻易把两条书签并成一条）', () => {
    expect(normalizeUrl('https://a.com/x?q=1')).toBe('https://a.com/x?q=1');
    expect(normalizeUrl('https://a.com/x#top')).toBe('https://a.com/x#top');
  });

  it('不是标准 URL 的字符串原样保留（chrome:// 之类）', () => {
    expect(normalizeUrl('  chrome://bookmarks  ')).toBe('chrome://bookmarks');
  });

  it('能找出重复书签', () => {
    const entries: Entry[] = [
      ...roots(),
      bookmark('a', 'root:0', 0, 'A', 'https://dup.com/'),
      bookmark('b', 'root:1', 0, 'B', 'https://dup.com'),
      bookmark('c', 'root:1', 1, 'C', 'https://unique.com'),
    ];
    const duplicates = findDuplicateUrls(entries);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.uids.sort()).toEqual(['a', 'b']);
  });
});

describe('改动量统计', () => {
  it('能数出新增/更新/移动/删除', () => {
    const before: Entry[] = [
      ...roots(),
      bookmark('keep', 'root:0', 0, 'Keep', 'https://keep.com'),
      bookmark('edit', 'root:0', 1, 'Edit', 'https://edit.com'),
      bookmark('move', 'root:0', 2, 'Move', 'https://move.com'),
      bookmark('gone', 'root:0', 3, 'Gone', 'https://gone.com'),
    ];
    const after: Entry[] = [
      ...roots(),
      bookmark('keep', 'root:0', 0, 'Keep', 'https://keep.com'),
      bookmark('edit', 'root:0', 1, 'Edited', 'https://edit.com'),
      { ...before[4]!, parentUid: 'root:1' },
      bookmark('new', 'root:0', 3, 'New', 'https://new.com'),
    ];
    expect(diffCounts(before, after)).toEqual({ added: 1, updated: 1, removed: 1, moved: 1 });
  });
});
