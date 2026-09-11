/**
 * 图片工具：读取 File 为 dataURL、降采样生成可持久化的缩略版。
 */
export interface ImageMeta {
  dataUrl: string;
  width: number;
  height: number;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 将图片降采样到最长边 maxDim，返回 PNG dataURL（用于 localStorage 持久化）。 */
export async function downscaleForStorage(src: string, maxDim = 1280): Promise<string> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return src;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

/** 将 dataURL 还原为 File（用于刷新恢复后再次分析）。 */
export async function imageDataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = dataUrl.startsWith('data:image/jpeg') ? 'jpg' : dataUrl.startsWith('data:image/webp') ? 'webp' : 'png';
  return new File([blob], name.includes('.') ? name : `${name}.${ext}`, { type: blob.type || `image/${ext}` });
}
