import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mimeTypeForFilename,
  persistWecomDownload,
  readWecomOutboundFile,
  safeWecomFilename,
} from "../media.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("WeCom media helpers", () => {
  it("removes path traversal and reserved filename characters", () => {
    expect(safeWecomFilename("../../bad:name?.png")).toBe("bad_name_.png");
  });

  it("persists a downloaded file below the channel directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-"));
    tempDirs.push(dir);
    const stored = await persistWecomDownload({
      mediaDir: dir,
      buffer: Buffer.from("hello"),
      filename: "../notes.txt",
    });
    expect(path.dirname(stored.absPath)).toBe(dir);
    expect(await fs.readFile(stored.absPath, "utf8")).toBe("hello");
    expect(stored.originalName).toBe("notes.txt");
    expect(stored.mimeType).toBe("text/plain");
  });

  it("selects outbound media types from safe metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-"));
    tempDirs.push(dir);
    const file = path.join(dir, "picture.png");
    await fs.writeFile(file, Buffer.from([1, 2, 3]));
    const outbound = await readWecomOutboundFile(file);
    expect(outbound.mediaType).toBe("image");
    expect(outbound.filename).toBe("picture.png");
    expect(mimeTypeForFilename("README")).toBe("application/octet-stream");
  });
});
