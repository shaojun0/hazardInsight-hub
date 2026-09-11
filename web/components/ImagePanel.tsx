import { useRef, type RefObject } from 'react';
import type { BBox, Hazard } from '../../shared/types';
import { ImageAnnotator, type AnnotatorHandle } from './ImageAnnotator';
import { ImageUploader } from './ImageUploader';
import { SAMPLE_SCENES } from '../lib/sampleScenes';
import type { Phase } from '../lib/constants';
import { ALLOWED_EXT } from '../lib/constants';
import { IconDownload, IconImage, IconTrash, IconUpload } from './icons';

interface Props {
  annotatorRef: RefObject<AnnotatorHandle | null>;
  previewUrl: string | null;
  imageName?: string;
  imageSize?: number;
  hazards: Hazard[];
  phase: Phase;
  selectedHazardId: Hazard['id'] | null;
  showLabels: boolean;
  exportFileName?: string;
  onFile: (file: File, scenarioId: string | null) => void;
  onUseSample: (sceneId: string) => void;
  onClear: () => void;
  onSelectHazard: (hazardId: Hazard['id'] | null) => void;
  onChangeBBox: (hazardId: Hazard['id'], bbox: BBox) => void;
  onToggleLabels: (v: boolean) => void;
}

export function ImagePanel(props: Props) {
  const { annotatorRef } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pickFile = (file: File | undefined | null) => {
    if (!file) return;
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext) && !/^image\/(jpeg|png|webp)$/.test(file.type)) return;
    props.onFile(file, null);
  };

  function exportImage() {
    const dataUrl = annotatorRef.current?.getDataUrl();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${props.exportFileName ?? 'hazard-annotation'}-说明图.png`;
    a.click();
  }

  if (!props.previewUrl) {
    return (
      <div className="card">
        <div className="card-pad" style={{ padding: 16 }}>
          <div className="section-label">原始现场图片</div>
          <ImageUploader onFile={(f) => props.onFile(f, null)} />
          <div className="sample-btns" style={{ marginTop: 14 }}>
            <span className="hint">没有现场图片？使用演示样例：</span>
            {SAMPLE_SCENES.map((s) => (
              <button
                key={s.meta.id}
                className="btn btn-primary-soft btn-sm"
                onClick={() => props.onUseSample(s.meta.id)}
                title={s.meta.desc}
              >
                <IconImage size={13} />
                {s.meta.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card wb-img-card">
      <div className="wb-img-head">
        <span className="title">原始现场图片</span>
        <div className="wb-img-tools" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="switch-row">
            <span style={{ whiteSpace: 'nowrap' }}>AI 标注</span>
            <label className="switch">
              <input type="checkbox" checked={props.showLabels} onChange={(e) => props.onToggleLabels(e.target.checked)} />
              <span className="track" />
              <span className="thumb" />
            </label>
          </span>
          <button className="btn btn-primary-soft btn-sm" onClick={exportImage} title="将不可见/可见标注绘制到原图并导出 PNG">
            <IconDownload size={13} />
            生成隐患说明图
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()} title="重新选择图片">
            <IconUpload size={13} />
            重新上传
          </button>
          <button className="btn btn-danger-soft btn-sm" onClick={props.onClear} title="删除当前图片">
            <IconTrash size={13} />
            删除
          </button>
        </div>
      </div>

      <div className="wb-img-body">
        <div
          className="image-wrap"
          onPointerDown={(event) => {
            if (event.button === 0) props.onSelectHazard(null);
          }}
        >
          <ImageAnnotator
            ref={annotatorRef}
            imageUrl={props.previewUrl}
            hazards={props.hazards}
            selectedHazardId={props.selectedHazardId}
            showLabels={props.showLabels}
            onSelectHazard={props.onSelectHazard}
            onChangeBBox={props.onChangeBBox}
          />
        </div>
        {props.phase === 'analyzing' && (
          <div className="disclaimer-bar" style={{ marginTop: 12 }}>
            <span className="spinner blue" />
            AI 正在分析图片，识别结果即将展示…
          </div>
        )}
      </div>

      <div className="img-meta" style={{ padding: '0 14px 12px' }}>
        <div className="row">
          <span className="fmt">{extOf(props.imageName)}</span>
          <span className="muted">{props.imageName}</span>
          {formatBytes(props.imageSize) && <span className="muted">· {formatBytes(props.imageSize)}</span>}
        </div>
        <span className="muted">
          {props.hazards.length > 0 ? (
            <>点击图片中的标注框可定位到对应隐患（共 {props.hazards.length} 处）</>
          ) : props.phase === 'analyzing' ? (
            'AI 正在分析评审中…'
          ) : (
            '当前图像未标注明显隐患'
          )}
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          pickFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function extOf(name?: string): string {
  const ext = (name ?? 'png').split('.').pop()?.toLowerCase() ?? 'png';
  return ext === 'jpeg' ? 'jpg' : ext;
}
