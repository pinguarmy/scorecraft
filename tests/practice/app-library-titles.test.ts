import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryItems, libraryItemTitle } from '../../src/app/library-items';
import type { LibrarySaveState, SavedDocumentMetadata } from '../../src/practice/library';
import type { RecentDocument } from '../../src/practice/session';

const recent = (id: string, title: string): RecentDocument =>
  ({ id, source: 's', title, composer: '', xml: '<x/>', opened: 1, session: {} }) as RecentDocument;
const saved = (id: string, title: string): SavedDocumentMetadata => ({
  id,
  title,
  composer: '',
  source: 's',
  opened: 2,
  updatedAt: 2,
  xmlBytes: 10,
});

test('libraryItemTitle falls back to 未命名乐谱 for blank titles only', () => {
  assert.equal(libraryItemTitle(''), '未命名乐谱');
  assert.equal(libraryItemTitle('   '), '未命名乐谱');
  assert.equal(libraryItemTitle(undefined), '未命名乐谱');
  assert.equal(libraryItemTitle('晨光'), '晨光');
});

test('library items never carry an empty title, so the open button has an accessible name', () => {
  const snapshot = recent('c', '');
  const states: Record<string, LibrarySaveState> = { c: { id: 'c', status: 'error', error: 'x' } };
  const items = buildLibraryItems([recent('a', '')], [saved('b', ' ')], states, new Map([['c', snapshot]]), []);
  assert.deepEqual(items.map((item) => [item.id, item.title]).sort(), [
    ['a', '未命名乐谱'],
    ['b', '未命名乐谱'],
    ['c', '未命名乐谱'],
  ]);
});
