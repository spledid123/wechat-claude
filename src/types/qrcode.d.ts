declare module "qrcode" {
  export function toDataURL(text: string, options?: unknown): Promise<string>;
  export function toFile(path: string, text: string, options?: unknown): Promise<void>;
}
