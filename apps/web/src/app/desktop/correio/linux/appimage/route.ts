import { linuxDownload } from "../linux-download";

export function GET() {
  return linuxDownload("appimage");
}
