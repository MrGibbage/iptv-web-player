import { createReadStream } from "node:fs";
import sax from "sax";

// Ported from Laomedeia (electron/xmltv.ts) — pure Node, no Electron
// dependency, so this needed zero changes to run server-side (PLAN.md
// "EPG ingestion").

export interface XmltvChannel {
  id: string;
  displayName: string;
  icon: string | null;
}

export interface XmltvProgram {
  channelId: string;
  startMs: number;
  stopMs: number;
  title: string;
  description: string;
}

export interface XmltvHandlers {
  onChannels(batch: XmltvChannel[]): void;
  onPrograms(batch: XmltvProgram[]): void;
}

const BATCH_SIZE = 1000;

// XMLTV timestamps look like "20260704073000 +0000" (offset optional,
// seconds optional). Returns null for unparseable values.
export function parseXmltvTime(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const [, year, month, day, hour, minute, second, sign, offH, offM] = m;
  let ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), second ? Number(second) : 0);
  if (sign) {
    const offsetMs = (Number(offH) * 60 + Number(offM)) * 60_000;
    ms += sign === "+" ? -offsetMs : offsetMs;
  }
  return ms;
}

// Streaming XMLTV parse — the file never fully materializes in memory.
// Channels and programs are delivered in batches; XMLTV files list all
// channels before any programs, so onChannels calls finish before the
// first onPrograms call.
export function parseXmltvFile(filePath: string, handlers: XmltvHandlers): Promise<{ channelCount: number; programCount: number }> {
  return new Promise((resolve, reject) => {
    const saxStream = sax.createStream(true, { trim: false });
    const fileStream = createReadStream(filePath, { encoding: "utf-8" });

    let channelCount = 0;
    let programCount = 0;
    let channelBatch: XmltvChannel[] = [];
    let programBatch: XmltvProgram[] = [];

    let currentChannel: { id: string; displayName: string | null; icon: string | null } | null = null;
    let currentProgram: {
      channelId: string;
      start: string;
      stop: string;
      title: string;
      description: string;
    } | null = null;
    // Which text-bearing element we're inside, if any.
    let textTarget: "display-name" | "title" | "desc" | null = null;

    const flushChannels = () => {
      if (channelBatch.length > 0) {
        handlers.onChannels(channelBatch);
        channelBatch = [];
      }
    };
    const flushPrograms = () => {
      if (programBatch.length > 0) {
        handlers.onPrograms(programBatch);
        programBatch = [];
      }
    };

    saxStream.on("opentag", (node) => {
      const attrs = node.attributes as Record<string, string>;
      switch (node.name) {
        case "channel":
          currentChannel = { id: String(attrs.id ?? ""), displayName: null, icon: null };
          break;
        case "programme":
          currentProgram = {
            channelId: String(attrs.channel ?? ""),
            start: String(attrs.start ?? ""),
            stop: String(attrs.stop ?? ""),
            title: "",
            description: "",
          };
          break;
        case "display-name":
          // Only the first display-name is the channel's name; later ones
          // are aliases/channel numbers.
          if (currentChannel && currentChannel.displayName === null) textTarget = "display-name";
          break;
        case "title":
          if (currentProgram) textTarget = "title";
          break;
        case "desc":
          if (currentProgram) textTarget = "desc";
          break;
        case "icon":
          if (currentChannel && attrs.src) currentChannel.icon = String(attrs.src);
          break;
      }
    });

    saxStream.on("text", (text) => {
      if (!textTarget) return;
      if (textTarget === "display-name" && currentChannel) {
        currentChannel.displayName = (currentChannel.displayName ?? "") + text;
      } else if (textTarget === "title" && currentProgram) {
        currentProgram.title += text;
      } else if (textTarget === "desc" && currentProgram) {
        currentProgram.description += text;
      }
    });

    saxStream.on("closetag", (name) => {
      if (name === "display-name" || name === "title" || name === "desc") {
        textTarget = null;
        return;
      }
      if (name === "channel" && currentChannel) {
        if (currentChannel.id) {
          channelBatch.push({
            id: currentChannel.id,
            displayName: (currentChannel.displayName ?? currentChannel.id).trim(),
            icon: currentChannel.icon,
          });
          channelCount++;
          if (channelBatch.length >= BATCH_SIZE) flushChannels();
        }
        currentChannel = null;
      } else if (name === "programme" && currentProgram) {
        const startMs = parseXmltvTime(currentProgram.start);
        const stopMs = parseXmltvTime(currentProgram.stop);
        if (currentProgram.channelId && startMs !== null && stopMs !== null && stopMs > startMs) {
          programBatch.push({
            channelId: currentProgram.channelId,
            startMs,
            stopMs,
            title: currentProgram.title.trim() || "(no title)",
            description: currentProgram.description.trim(),
          });
          programCount++;
          if (programBatch.length >= BATCH_SIZE) {
            // Channels always precede programs in XMLTV; flush any
            // remainder before the first program batch goes out.
            flushChannels();
            flushPrograms();
          }
        }
        currentProgram = null;
      }
    });

    saxStream.on("error", (err) => {
      fileStream.destroy();
      reject(new Error(`XMLTV parse error: ${err.message}`));
    });
    fileStream.on("error", (err) => {
      reject(new Error(`Could not read XMLTV file: ${err.message}`));
    });

    saxStream.on("end", () => {
      try {
        flushChannels();
        flushPrograms();
        resolve({ channelCount, programCount });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    fileStream.pipe(saxStream);
  });
}
