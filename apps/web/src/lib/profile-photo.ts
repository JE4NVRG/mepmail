import { TEAM_LOGO_MAX_BYTES } from "./image-type";

/** A small square avatar, re-encoded locally so the original EXIF is not uploaded. */
export async function prepareProfilePhoto(file: File): Promise<File> {
  if (!file.size || file.size > TEAM_LOGO_MAX_BYTES) throw new Error("size");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("type");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("decode");
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    if (!blob || blob.size > TEAM_LOGO_MAX_BYTES) throw new Error("decode");
    return new File([blob], "profile.webp", { type: blob.type });
  } finally {
    bitmap.close();
  }
}

export async function uploadProfilePhoto(file: File): Promise<void> {
  const body = new FormData();
  body.set("file", file);
  const response = await fetch("/api/profile-photo", { method: "POST", body });
  if (!response.ok) throw new Error("upload");
}

export async function removeProfilePhoto(): Promise<void> {
  const response = await fetch("/api/profile-photo", { method: "DELETE" });
  if (!response.ok) throw new Error("remove");
}
