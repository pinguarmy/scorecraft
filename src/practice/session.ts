export type PracticeSession = {
  tempo: number;
  transpose: number;
  metronome: boolean;
  muted: string[];
  solo: string | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  position: number;
  followRepeats: boolean;
  countIn: boolean;
  /** Optional for older typed callers; sanitization always materializes a fresh map. */
  partInstruments?: Record<string, string>;
  /** Optional for older typed callers; sanitization always supplies view defaults. */
  followMode?: 'scroll' | 'page';
  followEnabled?: boolean;
};

export type RecentDocument = {
  id: string;
  title: string;
  composer: string;
  xml: string;
  opened: number;
  source: string;
  jobId?: string;
  session: PracticeSession;
};

export type SessionBounds = {
  tempo: number;
  totalBeats: number;
  measureCount: number;
  partIds: string[];
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const SESSION_KEY = 'scorecraft.documents.v2';
export const LEGACY_RECENT_KEY = 'scorecraft.recent.v1';
export const LEGACY_SETTINGS_KEY = 'scorecraft.practice.v1';
export const MAX_DOCUMENTS = 4;
export const MAX_XML_CHARS = 350_000;

const INSTRUMENT_IDS = new Set([
  'piano-bright',
  'piano-warm',
  'guitar-acoustic',
  'guitar-electric',
  'bass-electric',
  'strings',
  'synth-pad',
  'drums',
]);
function instrumentEntries(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && INSTRUMENT_IDS.has(entry[1]),
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXPLICIT_JOB_RE = /^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXPLICIT_SHA_RE = /^sha256:[0-9a-f]{64}$/i;

export function isValidDocId(id: unknown): id is string {
  return typeof id === 'string' && (EXPLICIT_JOB_RE.test(id.trim()) || EXPLICIT_SHA_RE.test(id.trim()));
}

function normalizeXml(raw: string): string {
  let xml = typeof raw === 'string' ? raw : '';
  if (xml.startsWith('\uFEFF')) {
    xml = xml.slice(1);
  }
  return xml.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

export function sanitizeSession(value: unknown, bounds: SessionBounds): PracticeSession {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

  // Tempo: clamp 30..240 from bounds.tempo as default
  const fallbackTempo =
    typeof bounds?.tempo === 'number' && Number.isFinite(bounds.tempo)
      ? Math.max(30, Math.min(240, Math.round(bounds.tempo)))
      : 88;
  const tempo =
    typeof raw?.tempo === 'number' && Number.isFinite(raw.tempo)
      ? Math.max(30, Math.min(240, Math.round(raw.tempo)))
      : fallbackTempo;

  // Transpose: integer -12..12
  const transpose =
    typeof raw?.transpose === 'number' && Number.isFinite(raw.transpose)
      ? Math.max(-12, Math.min(12, Math.round(raw.transpose)))
      : 0;

  // Metronome: boolean, default false, reject non-boolean truthy values
  const metronome = raw?.metronome === true;

  // Muted: filtered unique existing IDs from bounds.partIds
  const partIds = Array.isArray(bounds?.partIds)
    ? bounds.partIds.filter((id): id is string => typeof id === 'string')
    : [];
  const partIdSet = new Set(partIds);
  const partInstruments = Object.fromEntries(
    instrumentEntries(raw?.partInstruments).filter(([id]) => partIdSet.has(id)),
  );
  const rawMuted = Array.isArray(raw?.muted) ? raw.muted : [];
  const muted: string[] = [];
  const seenMuted = new Set<string>();
  for (const id of rawMuted) {
    if (typeof id === 'string' && partIdSet.has(id) && !seenMuted.has(id)) {
      seenMuted.add(id);
      muted.push(id);
    }
  }

  // Solo: existing or null
  const solo = typeof raw?.solo === 'string' && partIdSet.has(raw.solo) ? raw.solo : null;

  // Loop: boolean flag, default false, reject non-boolean truthy values
  const loop = raw?.loop === true;

  // Start / end: integer 1..measureCount with end >= start
  const maxMeasures = Math.max(1, Math.floor(bounds?.measureCount || 1));
  const loopStart =
    typeof raw?.loopStart === 'number' && Number.isFinite(raw.loopStart)
      ? Math.max(1, Math.min(maxMeasures, Math.floor(raw.loopStart)))
      : 1;
  let loopEnd =
    typeof raw?.loopEnd === 'number' && Number.isFinite(raw.loopEnd)
      ? Math.max(1, Math.min(maxMeasures, Math.floor(raw.loopEnd)))
      : 1;
  if (loopEnd < loopStart) {
    loopEnd = loopStart;
  }

  // Position: finite 0..totalBeats
  const maxBeats = Math.max(
    0,
    typeof bounds?.totalBeats === 'number' && Number.isFinite(bounds.totalBeats) ? bounds.totalBeats : 0,
  );
  const position =
    typeof raw?.position === 'number' && Number.isFinite(raw.position)
      ? Math.max(0, Math.min(maxBeats, raw.position))
      : 0;

  // Follow repeats: defaults true, strictly false only when explicitly false
  const followRepeats = raw?.followRepeats === false ? false : true;

  // Count in: boolean, default false, reject non-boolean truthy values
  const countIn = raw?.countIn === true;

  return {
    tempo,
    transpose,
    metronome,
    muted,
    solo,
    loop,
    loopStart,
    loopEnd,
    position,
    followRepeats,
    countIn,
    partInstruments,
    followMode: raw?.followMode === 'page' ? 'page' : 'scroll',
    followEnabled: raw?.followEnabled === false ? false : true,
  };
}

export async function documentId(xml: string, explicitId?: string): Promise<string> {
  if (typeof explicitId === 'string') {
    const trimmed = explicitId.trim();
    if (EXPLICIT_JOB_RE.test(trimmed) || EXPLICIT_SHA_RE.test(trimmed)) {
      return trimmed.toLowerCase();
    }
  }

  const normalized = normalizeXml(xml);
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hashHex}`;
}

function deriveStorageBounds(rawSession: unknown): SessionBounds {
  const session = rawSession && typeof rawSession === 'object' ? (rawSession as Record<string, unknown>) : null;
  const partIds: string[] = [];
  if (Array.isArray(session?.muted)) {
    for (const id of session.muted) {
      if (typeof id === 'string' && id && !partIds.includes(id)) {
        partIds.push(id);
      }
    }
  }
  if (typeof session?.solo === 'string' && session.solo && !partIds.includes(session.solo)) {
    partIds.push(session.solo);
  }
  // Score bounds are unavailable during storage hydration. Preserve valid map
  // entries here; the caller re-sanitizes against the parsed score's real IDs.
  for (const [id] of instrumentEntries(session?.partInstruments)) {
    if (id && !partIds.includes(id)) partIds.push(id);
  }
  return {
    tempo: typeof session?.tempo === 'number' && Number.isFinite(session.tempo) ? session.tempo : 88,
    totalBeats: 1e9,
    measureCount: 100_000,
    partIds,
  };
}

function sanitizeDocumentWithId(raw: unknown, id: string): RecentDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.xml !== 'string' || item.xml.length > MAX_XML_CHARS) return null;
  if (!isValidDocId(id)) return null;

  const session = sanitizeSession(item.session, deriveStorageBounds(item.session));
  const title = typeof item.title === 'string' && item.title ? item.title : '未命名乐谱';
  const composer = typeof item.composer === 'string' ? item.composer : '';
  const source = typeof item.source === 'string' ? item.source : '';
  const opened = typeof item.opened === 'number' && Number.isFinite(item.opened) ? item.opened : Date.now();

  let jobId: string | undefined;
  if (typeof item.jobId === 'string' && UUID_RE.test(item.jobId.trim())) {
    jobId = item.jobId.trim().toLowerCase();
  }

  return {
    id: id.trim().toLowerCase(),
    title,
    composer,
    xml: item.xml,
    opened,
    source,
    ...(jobId ? { jobId } : {}),
    session,
  };
}

export function sanitizeDocument(raw: unknown): RecentDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !isValidDocId(item.id)) return null;
  return sanitizeDocumentWithId(raw, item.id);
}

export async function loadDocuments(storage: StorageLike): Promise<RecentDocument[]> {
  if (!storage || typeof storage.getItem !== 'function') return [];

  let v2Raw: string | null = null;
  try {
    v2Raw = storage.getItem(SESSION_KEY);
  } catch {
    return [];
  }

  let parsedV2: unknown = null;
  let isV2ValidArray = false;

  if (v2Raw !== null) {
    try {
      const parsed = JSON.parse(v2Raw);
      if (Array.isArray(parsed)) {
        parsedV2 = parsed;
        isV2ValidArray = true;
      }
    } catch {
      // Malformed v2 JSON: fallback to v1 migration
    }
  }

  if (isV2ValidArray && Array.isArray(parsedV2)) {
    // Explicit valid v2 array: respect clear history ([] must not resurrect v1)
    if (parsedV2.length === 0) {
      return [];
    }

    const docs: RecentDocument[] = [];
    for (const item of parsedV2) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.xml !== 'string' || raw.xml.length > MAX_XML_CHARS) continue;

      let id = typeof raw.id === 'string' && isValidDocId(raw.id) ? raw.id.trim().toLowerCase() : '';
      if (!id) {
        id = await documentId(raw.xml);
      }
      const doc = sanitizeDocumentWithId(raw, id);
      if (doc) docs.push(doc);
      if (docs.length >= MAX_DOCUMENTS) break;
    }
    return docs;
  }

  // v2 missing, malformed, or non-array: migrate from legacy v1
  let v1RecentRaw: string | null = null;
  let v1PracticeRaw: string | null = null;
  try {
    v1RecentRaw = storage.getItem(LEGACY_RECENT_KEY);
    v1PracticeRaw = storage.getItem(LEGACY_SETTINGS_KEY);
  } catch {
    return [];
  }

  if (v1RecentRaw === null) return [];

  let v1Recent: unknown;
  try {
    v1Recent = JSON.parse(v1RecentRaw);
  } catch {
    // Avoid dropping legacy on bad JSON
    return [];
  }
  if (!Array.isArray(v1Recent) || v1Recent.length === 0) return [];

  let legacyTempo = 88;
  let legacyTranspose = 0;
  let legacyMetronome = false;
  if (v1PracticeRaw) {
    try {
      const practice = JSON.parse(v1PracticeRaw);
      if (practice && typeof practice === 'object') {
        if (typeof practice.tempo === 'number' && Number.isFinite(practice.tempo)) {
          legacyTempo = Math.max(30, Math.min(240, Math.round(practice.tempo)));
        }
        if (typeof practice.transpose === 'number' && Number.isFinite(practice.transpose)) {
          legacyTranspose = Math.max(-12, Math.min(12, Math.round(practice.transpose)));
        }
        legacyMetronome = practice.metronome === true;
      }
    } catch {
      // Ignore corrupt practice settings
    }
  }

  const migratedDocs: RecentDocument[] = [];
  const hashMap = new Map<string, string>();

  for (const item of v1Recent) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.xml !== 'string' || raw.xml.length > MAX_XML_CHARS) continue;

    let id = hashMap.get(raw.xml);
    if (!id) {
      id = await documentId(raw.xml);
      hashMap.set(raw.xml, id);
    }

    const title = typeof raw.title === 'string' && raw.title ? raw.title : '未命名乐谱';
    const composer = '';
    const source = typeof raw.source === 'string' ? raw.source : '';
    const opened = typeof raw.opened === 'number' && Number.isFinite(raw.opened) ? raw.opened : Date.now();

    let jobId: string | undefined;
    if (typeof raw.jobId === 'string' && UUID_RE.test(raw.jobId.trim())) {
      jobId = raw.jobId.trim().toLowerCase();
    }

    const session: PracticeSession = {
      tempo: legacyTempo,
      transpose: legacyTranspose,
      metronome: legacyMetronome,
      muted: [],
      solo: null,
      loop: false,
      loopStart: 1,
      loopEnd: 1,
      position: 0,
      followRepeats: true,
      countIn: false,
      partInstruments: {},
      followMode: 'scroll',
      followEnabled: true,
    };

    migratedDocs.push({
      id,
      title,
      composer,
      xml: raw.xml,
      opened,
      source,
      ...(jobId ? { jobId } : {}),
      session,
    });

    if (migratedDocs.length >= MAX_DOCUMENTS) break;
  }

  if (migratedDocs.length > 0) {
    // Migration write only nonempty to v2; do NOT overwrite legacy keys
    saveDocuments(storage, migratedDocs);
  }

  return migratedDocs;
}

export function saveDocuments(storage: StorageLike, docs: RecentDocument[]): boolean {
  if (!storage || typeof storage.setItem !== 'function' || !Array.isArray(docs)) return false;

  const bounded: RecentDocument[] = [];
  for (const doc of docs) {
    const sanitized = sanitizeDocument(doc);
    if (sanitized) bounded.push(sanitized);
    if (bounded.length >= MAX_DOCUMENTS) break;
  }

  try {
    storage.setItem(SESSION_KEY, JSON.stringify(bounded));
    return true;
  } catch {
    return false;
  }
}

export function upsertDocument(docs: RecentDocument[], doc: RecentDocument): RecentDocument[] {
  const current = Array.isArray(docs) ? docs : [];
  if (!doc || typeof doc !== 'object') return [...current];
  if (typeof doc.xml !== 'string' || doc.xml.length > MAX_XML_CHARS) {
    // Reject oversized XML without dropping others
    return [...current];
  }
  if (typeof doc.id !== 'string' || !isValidDocId(doc.id)) {
    return [...current];
  }

  const normalizedId = doc.id.trim().toLowerCase();
  const normalizedDoc: RecentDocument = {
    ...doc,
    id: normalizedId,
    session: sanitizeSession(doc.session, deriveStorageBounds(doc.session)),
  };

  const filtered = current.filter(
    (item) => item && typeof item.id === 'string' && item.id.trim().toLowerCase() !== normalizedId,
  );
  const next = [normalizedDoc, ...filtered];
  const valid = next.filter(
    (item) => item && typeof item.xml === 'string' && item.xml.length <= MAX_XML_CHARS && isValidDocId(item.id),
  );
  return valid.slice(0, MAX_DOCUMENTS);
}
