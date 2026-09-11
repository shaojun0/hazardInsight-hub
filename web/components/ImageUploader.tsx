import { useRef, useState } from 'react';
import { IconImage } from './icons';
import { ALLOWED_EXT } from '../lib/constants';

interface Props {
  onFile: (file: File) => void;
}

export function ImageUploader({ onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const handleFile = (file: File | undefined | null) => {
    if (!file) return;
    const okExt = ALLOWED_EXT.includes(file.name.split('.').pop()?.toLowerCase() ?? '');
    const okType = /^image\/(jpeg|png|webp)$/.test(file.type);
    if (!okExt && !okType) return;
    onFile(file);
  };

  return (
    <div
      className={`dropzone ${drag ? 'drag' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
    >
      <div className="dz-ico">
        <IconImage size={26} />
      </div>
      <div className="dz-main">点击上传或拖拽工程现场图片</div>
      <div className="dz-sub">上传后 AI 将结合标准法规及历史案例自动识别安全隐患</div>
      <span
        className="btn btn-primary btn-sm"
        onClick={(e) => {
          e.stopPropagation();
          inputRef.current?.click();
        }}
      >
        选择图片
      </span>
      <div className="dz-fmts">支持 JPG / JPEG / PNG / WebP，单张 ≤ 15MB</div>
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
