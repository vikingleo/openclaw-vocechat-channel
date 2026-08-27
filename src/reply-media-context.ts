import path from "node:path";

export type VoceChatReplyMediaAttachment = {
  localFile?: unknown;
  storedFile?: unknown;
  normalizedFile?: unknown;
};

export function buildVoceChatReplyMediaLocalRoots(params: {
  baseMediaLocalRoots?: readonly unknown[];
  inboundMediaRootDir?: unknown;
  generatedMediaRootDir?: unknown;
  attachments?: readonly VoceChatReplyMediaAttachment[];
}): string[] {
  const roots: string[] = [];

  const addRoot = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) return;
    const resolved = path.resolve(trimmed);
    if (!roots.includes(resolved)) roots.push(resolved);
  };

  const addFileParent = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) return;
    const dir = path.dirname(path.resolve(trimmed));
    if (dir === path.parse(dir).root) return;
    addRoot(dir);
  };

  for (const root of params.baseMediaLocalRoots ?? []) addRoot(root);
  addRoot(params.inboundMediaRootDir);
  addRoot(params.generatedMediaRootDir);

  for (const attachment of params.attachments ?? []) {
    addFileParent(attachment.localFile);
    addFileParent(attachment.storedFile);
    addFileParent(attachment.normalizedFile);
  }

  return roots;
}
