import path from "node:path";

export function resolveAppRoot(options: {
  isPackaged: boolean;
  execPath: string;
  cwd: string;
  portableDir?: string;
}): string {
  if (options.portableDir) {
    return options.portableDir;
  }
  if (options.isPackaged) {
    return path.dirname(options.execPath);
  }
  return options.cwd;
}
