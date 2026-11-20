import { useCallback, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import {
  inspectOpenOctaveShifts,
  readScore,
  removeOpenOctaveShiftsXml,
  updateNoteXml,
  updateTimeSignatureXml,
} from '../music';
import type { Score } from '../music';
import { updatePartNameXml } from '../music/part-labels';
import { pitchName } from './score-helpers';
import { editScoreMetadata, readInitialMeter, sourcePartName } from './score-xml';
import type { ActiveDocument, SetNotice } from './types';

/** activate(next, source, id, jobId, preserve) —— 见 App。校正都以 preserve=true 调用。 */
export type Activate = (next: Score, from: string, id: string, jobId?: string, preserve?: boolean) => void;

type Options = {
  score: Score | null;
  source: string;
  scoreRef: RefObject<Score | null>;
  activeRef: RefObject<ActiveDocument | null>;
  activate: Activate;
  setNotice: SetNotice;
  currentMeasureIndex: number;
};

/** 撤销栈只保留最近 12 个版本。 */
const pushUndo = (items: string[], xml: string) => [...items.slice(-11), xml];

/**
 * 识谱校对：曲名与作者、声部名称、未闭合八度线、拍号、单个音高，以及撤销。
 *
 * 每次修改都基于 scoreRef 中的当前 MusicXML 生成新谱；异步解析完成时若乐谱已被替换，就放弃结果。
 * 新谱以 preserve=true 交给 activate，保留文档编号、练习设置和播放位置。
 */
export function useScoreCorrections({
  score,
  source,
  scoreRef,
  activeRef,
  activate,
  setNotice,
  currentMeasureIndex,
}: Options) {
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [composerDraft, setComposerDraft] = useState('');
  const [renamingPartId, setRenamingPartId] = useState<string | null>(null);
  const [partNameDraft, setPartNameDraft] = useState('');
  const [confirmOctaveRemoval, setConfirmOctaveRemoval] = useState(false);
  const [meterMeasure, setMeterMeasure] = useState(1);
  const [meterBeats, setMeterBeats] = useState(4);
  const [meterBeatType, setMeterBeatType] = useState(4);
  const [confirmMeter, setConfirmMeter] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [editPitch, setEditPitch] = useState(60);
  const [undo, setUndo] = useState<string[]>([]);

  const openOctaveCount = useMemo(() => {
    if (!score) return 0;
    try {
      return inspectOpenOctaveShifts(score.xml);
    } catch {
      return 0;
    }
  }, [score]);
  const allNotes = useMemo(() => score?.parts.flatMap((part) => part.notes) || [], [score]);
  const selectedNote = allNotes.find((n) => n.id === selectedNoteId);
  const visibleNotes = useMemo(
    () => allNotes.filter((n) => n.measure === currentMeasureIndex + 1),
    [allNotes, currentMeasureIndex],
  );

  /** 切换乐谱时收起所有编辑表单；打开另一份谱（非 preserve）时再重置拍号表单、撤销栈和选中音符。 */
  function resetForScore(next: Score, preserve: boolean) {
    setEditingMetadata(false);
    setRenamingPartId(null);
    setConfirmOctaveRemoval(false);
    setConfirmMeter(false);
    if (!preserve) {
      const meter = readInitialMeter(next.xml);
      setMeterMeasure(1);
      setMeterBeats(meter.beats);
      setMeterBeatType(meter.beatType);
      setUndo([]);
      setSelectedNoteId(null);
    }
  }

  /** “编辑曲名”按钮：以当前曲名和作者填充表单并切换显示。 */
  function toggleMetadataEditor() {
    if (!score) return;
    setTitleDraft(score.title);
    setComposerDraft(score.composer);
    setEditingMetadata((v) => !v);
  }

  async function saveMetadata() {
    const current = scoreRef.current;
    const active = activeRef.current;
    if (!current || !active) return;
    try {
      const xml = editScoreMetadata(current.xml, { title: titleDraft, composer: composerDraft });
      const next = await readScore(xml, 'metadata.musicxml');
      if (scoreRef.current !== current) return;
      activate(next, active.source, active.id, active.jobId, true);
      setNotice({
        kind: 'info',
        text: '已保存曲名与作者，文档编号和练习设置不变。MusicXML 与 MIDI 导出会使用新曲名。',
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function requestMeterCorrection() {
    if (
      !score ||
      !Number.isInteger(meterMeasure) ||
      meterMeasure < 1 ||
      meterMeasure > score.measures.length ||
      !Number.isInteger(meterBeats) ||
      meterBeats < 1 ||
      meterBeats > 32 ||
      ![1, 2, 4, 8, 16, 32, 64].includes(meterBeatType)
    ) {
      setNotice({ kind: 'error', text: '请选择有效起点小节、1 至 32 的整数分子和支持的拍号分母。' });
      return;
    }
    setConfirmMeter(true);
  }

  /** 修改拍号表单任一字段时撤回待确认状态。 */
  function changeMeter(field: 'measure' | 'beats' | 'beatType', value: number) {
    if (field === 'measure') setMeterMeasure(value);
    else if (field === 'beats') setMeterBeats(value);
    else setMeterBeatType(value);
    setConfirmMeter(false);
  }

  async function correctMeter() {
    const current = scoreRef.current;
    const active = activeRef.current;
    if (!current || !active) return;
    try {
      const edited = await readScore(
        updateTimeSignatureXml(current.xml, meterBeats, meterBeatType, { measure: meterMeasure }),
        'meter-corrected.musicxml',
      );
      if (scoreRef.current !== current) return;
      setUndo((items) => pushUndo(items, current.xml));
      activate(edited, active.source, active.id, active.jobId, true);
      setNotice({
        kind: 'info',
        text: `已从第 ${meterMeasure} 小节校正拍号为 ${meterBeats}/${meterBeatType}，后续原有拍号变化保留。音符时值未自动修复，请对照原稿核对，可在音符校正中撤销。`,
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `拍号校正失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function removeOpenOctaves() {
    const current = scoreRef.current;
    const active = activeRef.current;
    if (!current || !active) return;
    try {
      const edited = await readScore(removeOpenOctaveShiftsXml(current.xml), 'corrected.musicxml');
      if (scoreRef.current !== current) return;
      setUndo((items) => pushUndo(items, current.xml));
      activate(edited, active.source, active.id, active.jobId, true);
      setNotice({
        kind: 'info',
        text: '已从浏览器校正版移除未闭合八度线，音高和原始扫描文件未改动。可在音符校正中撤销。',
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `移除失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** “改名”按钮：再次点击同一声部时收起表单。草稿取源声部的原始名称。 */
  function beginPartRename(partId: string) {
    const current = scoreRef.current;
    const part = current?.parts.find((item) => item.id === partId);
    if (!current || !part?.sourcePartId) return;
    if (renamingPartId === partId) {
      setRenamingPartId(null);
      return;
    }
    setPartNameDraft(sourcePartName(current.xml, part.sourcePartId) ?? part.name);
    setRenamingPartId(partId);
  }

  async function renamePart() {
    const current = scoreRef.current;
    const active = activeRef.current;
    const part = current?.parts.find((item) => item.id === renamingPartId);
    if (!current || !active || !part?.sourcePartId) return;
    try {
      const edited = await readScore(
        updatePartNameXml(current.xml, part.sourcePartId, partNameDraft),
        'renamed.musicxml',
      );
      if (scoreRef.current !== current) return;
      setUndo((items) => pushUndo(items, current.xml));
      activate(edited, active.source, active.id, active.jobId, true);
      setNotice({
        kind: 'info',
        text: '已保存源声部名称，音符和练习设置未改。MusicXML 导出会保留新名称，同一源声部拆出的谱表会一起更新。',
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `改名失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** 选中音符（下拉框或点击谱面），并把“改为”预设为它的原音高。保持引用稳定，供 ScoreView 使用。 */
  const selectNote = useCallback((id: string) => {
    setSelectedNoteId(id);
    const n = scoreRef.current?.parts.flatMap((p) => p.notes).find((note) => note.id === id);
    if (n) setEditPitch(n.midi);
  }, []);

  async function correctNote() {
    if (!score || !selectedNote || !Number.isInteger(editPitch) || editPitch < 0 || editPitch > 127) return;
    try {
      const previous = score.xml;
      const corrected = await readScore(updateNoteXml(score.xml, selectedNote.id, editPitch), 'corrected.musicxml');
      if (scoreRef.current !== score) return;
      setUndo((items) => pushUndo(items, previous));
      const active = activeRef.current;
      if (active) activate(corrected, source, active.id, active.jobId, true);
      setNotice({
        kind: 'info',
        text: `已将第 ${selectedNote.measure} 小节的 ${pitchName(selectedNote.midi)} 改为 ${pitchName(editPitch)}。播放已暂停，保留练习位置。`,
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `校正失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function undoCorrection() {
    const xml = undo[undo.length - 1];
    if (!xml) return;
    const current = scoreRef.current;
    try {
      const restored = await readScore(xml, 'undo.musicxml');
      if (scoreRef.current !== current) return;
      const active = activeRef.current;
      if (active) activate(restored, source, active.id, active.jobId, true);
      setUndo((items) => items.slice(0, -1));
      setSelectedNoteId(null);
      setNotice({ kind: 'info', text: '已撤销上一次乐谱修改。' });
    } catch (e) {
      setNotice({ kind: 'error', text: `撤销失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return {
    metadata: {
      editing: editingMetadata,
      setEditing: setEditingMetadata,
      titleDraft,
      setTitleDraft,
      composerDraft,
      setComposerDraft,
      toggleEditor: toggleMetadataEditor,
      save: saveMetadata,
    },
    partNames: {
      renamingPartId,
      setRenamingPartId,
      draft: partNameDraft,
      setDraft: setPartNameDraft,
      begin: beginPartRename,
      save: renamePart,
    },
    octaves: {
      openCount: openOctaveCount,
      confirming: confirmOctaveRemoval,
      setConfirming: setConfirmOctaveRemoval,
      remove: removeOpenOctaves,
    },
    meter: {
      measure: meterMeasure,
      beats: meterBeats,
      beatType: meterBeatType,
      confirming: confirmMeter,
      setConfirming: setConfirmMeter,
      change: changeMeter,
      request: requestMeterCorrection,
      apply: correctMeter,
    },
    notes: {
      selectedNoteId,
      selectedNote,
      visibleNotes,
      selectNote,
      editPitch,
      setEditPitch,
      correct: correctNote,
    },
    history: {
      undo,
      undoCorrection,
    },
    resetForScore,
  };
}

export type ScoreCorrections = ReturnType<typeof useScoreCorrections>;
