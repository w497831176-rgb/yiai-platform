export interface TagSortableApp {
  name: string;
  slug: string;
  tags?: string[];
}

const pinyinCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
  sensitivity: 'base',
  numeric: true,
});

function primaryTag(app: TagSortableApp): string | null {
  const tags = (app.tags ?? []).filter((tag) => typeof tag === 'string' && tag.trim() !== '');
  if (tags.length === 0) return null;
  return [...tags].sort((left, right) => pinyinCollator.compare(left, right))[0];
}

/** 未分类应用排在最后；其余按标签拼音、应用名称拼音和 slug 自动排序。 */
export function sortAppsByTagAndName<T extends TagSortableApp>(apps: T[]): T[] {
  return [...apps].sort((left, right) => {
    const leftTag = primaryTag(left);
    const rightTag = primaryTag(right);
    if (leftTag === null && rightTag !== null) return 1;
    if (leftTag !== null && rightTag === null) return -1;
    if (leftTag !== null && rightTag !== null) {
      const tagOrder = pinyinCollator.compare(leftTag, rightTag);
      if (tagOrder !== 0) return tagOrder;
    }

    const nameOrder = pinyinCollator.compare(left.name || left.slug, right.name || right.slug);
    return nameOrder !== 0 ? nameOrder : pinyinCollator.compare(left.slug, right.slug);
  });
}
