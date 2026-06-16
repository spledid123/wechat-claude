import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveAppRoot } from "../../src/electron/paths.js";

describe("electron main runtime path", () => {
  it("uses PORTABLE_EXECUTABLE_DIR for single-file portable builds", () => {
    expect(resolveAppRoot({
      isPackaged: true,
      execPath: "C:\\Users\\123\\AppData\\Local\\Temp\\random\\WeChat Claude.exe",
      cwd: "C:\\Users\\123\\AppData\\Local\\Temp\\random",
      portableDir: "D:\\Apps\\WeChat Claude",
    })).toBe("D:\\Apps\\WeChat Claude");
  });

  it("falls back to the packaged executable directory for unpacked builds", () => {
    expect(resolveAppRoot({
      isPackaged: true,
      execPath: "D:\\Apps\\WeChat Claude\\WeChat Claude.exe",
      cwd: "D:\\Apps\\WeChat Claude",
    })).toBe(path.dirname("D:\\Apps\\WeChat Claude\\WeChat Claude.exe"));
  });

  it("uses cwd during development", () => {
    expect(resolveAppRoot({
      isPackaged: false,
      execPath: "D:\\1\\wechat_claude\\node_modules\\electron\\dist\\electron.exe",
      cwd: "D:\\1\\wechat_claude",
    })).toBe("D:\\1\\wechat_claude");
  });
});
