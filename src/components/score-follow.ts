import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

export type FollowMode = 'scroll' | 'page';
export type FollowState = { key: string; beat: number; playing: boolean; initialized: boolean; enabled: boolean };
export const freshFollowState = (): FollowState => ({ key: '', beat: 0, playing: false, initialized: false, enabled: true });
const originalPadding = new WeakMap<HTMLElement, string>();

/** Native OSMD pages remain intact: one real SVG and cursor container per page. */
export function arrangeScorePages(container: HTMLElement, mode: FollowMode): HTMLElement[] {
  const pages = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.querySelector('svg'));
  if (!originalPadding.has(container)) originalPadding.set(container, container.style.padding);
  container.style.padding = mode === 'page' ? '0px' : originalPadding.get(container)!;
  container.style.display = mode === 'page' ? 'flex' : 'block';
  container.style.overflowX = mode === 'page' ? 'auto' : '';
  container.style.scrollSnapType = mode === 'page' ? 'x mandatory' : '';
  container.style.scrollbarWidth = mode === 'page' ? 'thin' : '';
  for (const [index, page] of pages.entries()) {
    page.dataset.scorePage = String(index + 1);
    page.setAttribute('aria-label', `乐谱第 ${index + 1} 页`);
    page.style.flex = mode === 'page' ? '0 0 100%' : '';
    page.style.maxWidth = '100%';
    page.style.scrollSnapAlign = mode === 'page' ? 'start' : '';
    if (mode === 'page') page.style.width = '100%';
    const svg = page.querySelector('svg');
    if (svg) {
      svg.style.maxHeight = mode === 'page' ? 'calc(100dvh - 220px)' : '';
      svg.style.width = mode === 'page' ? '100%' : '';
      svg.style.objectFit = mode === 'page' ? 'contain' : '';
    }
  }
  if (mode !== 'page') container.scrollLeft = 0;
  return pages;
}

export function currentScorePage(osmd: OpenSheetMusicDisplay): number {
  return Math.max(1, osmd.cursor?.currentPageNumber || 1);
}

export function showScorePage(container: HTMLElement, page: number, behavior: ScrollBehavior = 'auto'): void {
  const pages = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.querySelector('svg'));
  const selected = pages[Math.max(0, Math.min(pages.length - 1, page - 1))];
  if (!selected) return;
  const left = selected.getBoundingClientRect().left - pages[0].getBoundingClientRect().left;
  container.scrollTo({ left, behavior });
}

/** Call after the actual cursor has been positioned. No renderer work occurs here. */
export function followScorePosition(osmd: OpenSheetMusicDisplay, container: HTMLElement, state: FollowState, input: { mode: FollowMode; enabled: boolean; playing: boolean; beat: number }): boolean {
  const cursor = osmd.cursor;
  const system = osmd.GraphicSheet?.MeasureList[cursor?.iterator.CurrentMeasureIndex]?.find(Boolean)?.ParentMusicSystem;
  const page = currentScorePage(osmd);
  const key = `${page}:${system?.PositionAndShape.AbsolutePosition.y ?? -1}`;
  const seek = state.initialized && !input.playing && Math.abs(input.beat - state.beat) > .001;
  const resume = state.initialized && input.playing && !state.playing;
  const crossedSystem = state.initialized && key !== state.key;
  const enabledNow = input.enabled && !state.enabled;
  const initialPosition = !state.initialized && input.beat > .001;
  const shouldConsider = input.enabled && (initialPosition || seek || resume || enabledNow || (input.playing && (!state.initialized || crossedSystem)));
  state.key = key; state.beat = input.beat; state.playing = input.playing; state.enabled = input.enabled; state.initialized = true;
  if (!shouldConsider || !cursor?.cursorElement) return false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (input.mode === 'page') {
    showScorePage(container, page, reduced ? 'auto' : 'smooth');
    return true;
  }
  const rect = cursor.cursorElement.getBoundingClientRect();
  const dock = document.querySelector<HTMLElement>('.transport');
  const dockRect = dock?.getBoundingClientRect();
  const dockFixed = dock && getComputedStyle(dock).position === 'fixed';
  const top = 32;
  const bottom = dockFixed && dockRect ? Math.min(window.innerHeight - 24, dockRect.top - 20) : window.innerHeight - 32;
  // A tall multi-part system cannot fit at once: preserve its top rather than oscillating between edges.
  const fits = rect.height <= bottom - top;
  const visible = rect.top >= top && (fits ? rect.bottom <= bottom : rect.top <= top + 100);
  if (visible) return false;
  const target = Math.max(0, window.scrollY + rect.top - top - (fits ? Math.min(80, (bottom - top - rect.height) / 3) : 0));
  window.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
  return true;
}
