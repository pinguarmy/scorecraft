export const PLAYBACK_CAPABILITY_SUMMARY = '基础音高与节奏；部分演奏记号尚未还原';

/** Disclose unsupported performance details without changing the source notation. */
export function scoreDetailWarnings(root: Element, tempoSeen: boolean): string[] {
  const all = (tag: string) => Array.from(root.getElementsByTagName(tag));
  const warnings: string[] = [];
  if (!tempoSeen) warnings.push('未识别到速度标记，当前使用 100 BPM，可按原谱手动设置。');
  if (all('octave-shift').length) warnings.push('乐谱含八度移位线，显示位置由原始 MusicXML 决定，播放使用音符中记录的音高；识别出的移位线须对照原稿核对。');
  if (all('fermata').length) warnings.push('延长记号目前仅显示，播放不会自动延长时值。');
  if (all('slur').length) warnings.push('闭合且同声部连续的连奏线可轻度延长钢琴释放，不改变起音与谱面时值；跨声部或未闭合线不推测，延音线按连续同音合并。');
  if (all('dynamics').some(dynamic => {
    let direction: Node | null = dynamic.parentNode;
    while (direction && direction.nodeName !== 'direction') direction = direction.parentNode;
    const explicit = direction && Array.from((direction as Element).getElementsByTagName('sound')).some(sound => sound.hasAttribute('dynamics') && sound.getAttribute('dynamics')!.trim() !== '' && Number.isFinite(Number(sound.getAttribute('dynamics'))) && Number(sound.getAttribute('dynamics')) >= 0);
    return !explicit && Array.from(dynamic.childNodes).some(node => node.nodeType === 1 && !['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'].includes(node.nodeName));
  })) warnings.push('部分力度符号不在当前支持的常见 ppp 至 fff 范围内，未推测其力度；常见符号使用固定近似值，sound dynamics 优先。');
  if (all('ornaments').length) warnings.push('装饰记号目前仅显示，未展开为额外演奏音符。');
  if (all('note').some(note => !note.getElementsByTagName('grace').length && !note.getElementsByTagName('cue').length && !Array.from(note.childNodes).some(child => child.nodeName === 'duration' && Number(child.textContent) > 0))) warnings.push('部分普通音符缺少有效 duration，未从附点或连音外观猜测时值，相关音符未播放。');
  if (all('part').some(part => {
    const tab = Array.from(part.getElementsByTagName('staff-type')).some(type => type.textContent?.trim() === 'tablature') || Array.from(part.getElementsByTagName('clef')).some(clef => Array.from(clef.getElementsByTagName('sign')).some(sign => sign.textContent?.trim() === 'TAB'));
    return Array.from(part.getElementsByTagName('note')).some(note => {
      if (['pitch', 'unpitched', 'rest', 'grace', 'cue'].some(tag => note.getElementsByTagName(tag).length)) return false;
      const duration = Array.from(note.childNodes).find(child => child.nodeName === 'duration');
      const positionOnly = ['string', 'fret'].some(tag => note.getElementsByTagName(tag).length);
      return Number(duration?.textContent) > 0 && (tab || positionOnly);
    });
  })) warnings.push('部分六线谱音符只有弦号或品位，未提供明确音高，当前不会根据调弦推测，相关音符未播放。');
  if (all('technical').some(technical => ['bend', 'slide', 'hammer-on', 'pull-off', 'harmonic'].some(tag => technical.getElementsByTagName(tag).length)) || all('slide').length) warnings.push('推弦、滑音、击勾弦或泛音等吉他技巧目前仅保留记号，播放未还原这些技巧，已有明确音高的音符仍按该音高播放。');
  return warnings;
}
