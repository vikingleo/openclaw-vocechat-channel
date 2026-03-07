import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PANEL_STORE_VERSION = 1;
const DEFAULT_PANEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ControlPanelRecord {
  panelId: string;
  chatId: string;
  threadId: number | null;
  messageId: number;
  ownerSenderId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface ControlPanelStoreFile {
  version: number;
  panels: Record<string, ControlPanelRecord>;
}

export class ControlPanelStore {
  constructor(
    private readonly filePath: string,
    private readonly ttlMs = DEFAULT_PANEL_TTL_MS,
  ) {}

  create(params: {
    chatId: string;
    threadId: number | null;
    ownerSenderId: string;
  }): ControlPanelRecord {
    const state = this.read();
    this.pruneExpired(state);
    const now = Date.now();
    const record: ControlPanelRecord = {
      panelId: crypto.randomBytes(4).toString("hex"),
      chatId: params.chatId,
      threadId: params.threadId,
      messageId: 0,
      ownerSenderId: params.ownerSenderId,
      createdAtMs: now,
      updatedAtMs: now,
    };
    state.panels[record.panelId] = record;
    this.write(state);
    return record;
  }

  get(panelId: string): ControlPanelRecord | null {
    const state = this.read();
    this.pruneExpired(state);
    const record = state.panels[panelId];
    if (!record) {
      this.write(state);
      return null;
    }
    return record;
  }

  update(panelId: string, updater: (current: ControlPanelRecord) => ControlPanelRecord): ControlPanelRecord | null {
    const state = this.read();
    this.pruneExpired(state);
    const current = state.panels[panelId];
    if (!current) {
      this.write(state);
      return null;
    }
    state.panels[panelId] = {
      ...updater(current),
      updatedAtMs: Date.now(),
    };
    this.write(state);
    return state.panels[panelId] ?? null;
  }

  private read(): ControlPanelStoreFile {
    if (!fs.existsSync(this.filePath)) {
      return emptyStore();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<ControlPanelStoreFile>;
      return {
        version: PANEL_STORE_VERSION,
        panels: isRecord(parsed.panels)
          ? Object.fromEntries(Object.entries(parsed.panels).filter(([, value]) => isPanelRecord(value)))
          : {},
      };
    } catch {
      return emptyStore();
    }
  }

  private write(state: ControlPanelStoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private pruneExpired(state: ControlPanelStoreFile): void {
    const deadline = Date.now() - this.ttlMs;
    for (const [panelId, record] of Object.entries(state.panels)) {
      if (record.updatedAtMs < deadline) {
        delete state.panels[panelId];
      }
    }
  }
}

function emptyStore(): ControlPanelStoreFile {
  return {
    version: PANEL_STORE_VERSION,
    panels: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPanelRecord(value: unknown): value is ControlPanelRecord {
  if (!isRecord(value)) return false;
  return typeof value.panelId === "string"
    && typeof value.chatId === "string"
    && (typeof value.threadId === "number" || value.threadId === null)
    && typeof value.messageId === "number"
    && typeof value.ownerSenderId === "string"
    && typeof value.createdAtMs === "number"
    && typeof value.updatedAtMs === "number";
}
