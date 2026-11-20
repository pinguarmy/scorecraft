/** 乐谱上方的一条提示；error 以 role="alert" 播报。 */
export type Notice = { kind: 'error' | 'info'; text: string } | null;

/** 识别所用的原稿：本页上传的 blob，或服务器扫描档案中的原稿地址。 */
export type Original = { url: string; name: string; pdf: boolean; jobId?: string };

/** 当前打开的文档：谱库编号、来源说明、对应扫描任务和首次打开时间。 */
export type ActiveDocument = { id: string; source: string; jobId?: string; opened?: number };

export type SetNotice = (notice: Notice) => void;
