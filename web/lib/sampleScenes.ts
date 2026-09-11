/**
 * 演示样例场景：将内置 SVG 场景渲染为 PNG，用于无真实图片时快速体验 Demo。
 * 每个样例保留 scenarioId 供后台识别场景标记。
 */
export interface SampleScene {
  id: string;
  label: string;
  desc: string;
  scenarioId: string;
  width: number;
  height: number;
}

const W = 1200;
const H = 800;

const sceneDesk = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#dfe7f1"/>
  <rect y="0" width="${W}" height="120" fill="#cdd9e8"/>
  <rect x="60" y="190" width="1080" height="470" rx="18" fill="#f6e7c8" stroke="#d9c191" stroke-width="4"/>
  <rect x="60" y="190" width="1080" height="34" rx="12" fill="#e4d2a8"/>
  <rect x="620" y="660" width="520" height="140" rx="14" fill="#cbb98a"/>
  <rect x="160" y="660" width="360" height="140" rx="14" fill="#cbb98a"/>
  <!-- 插排 -->
  <rect x="210" y="300" width="300" height="64" rx="10" fill="#f2f2f2" stroke="#9aa8b8" stroke-width="3"/>
  <g fill="#444">
    <rect x="235" y="316" width="30" height="26" rx="4"/>
    <rect x="280" y="316" width="30" height="26" rx="4"/>
    <rect x="325" y="316" width="30" height="26" rx="4"/>
    <rect x="370" y="316" width="30" height="26" rx="4"/>
  </g>
  <rect x="455" y="306" width="34" height="46" rx="5" fill="#d9534f"/>
  <!-- 充电器1 -->
  <rect x="266" y="150" width="66" height="100" rx="8" fill="#333c4a"/>
  <rect x="278" y="164" width="42" height="52" rx="6" fill="#1c2330"/>
  <!-- 充电器2 -->
  <rect x="360" y="130" width="66" height="100" rx="8" fill="#7c3aed"/>
  <rect x="372" y="144" width="42" height="52" rx="6" fill="#4c1d95"/>
  <!-- 充电器3 -->
  <rect x="220" y="120" width="56" height="86" rx="8" fill="#0e7a56"/>
  <!-- 电源线 -->
  <path d="M489 330 C 560 330, 600 250, 640 220" stroke="#3b4757" stroke-width="9" fill="none"/>
  <path d="M640 220 C 700 190, 760 210, 790 260" stroke="#3b4757" stroke-width="9" fill="none"/>
  <path d="M262 364 C 240 430, 200 460, 150 470" stroke="#3b4757" stroke-width="8" fill="none"/>
  <path d="M150 470 C 120 480, 110 500, 130 520" stroke="#3b4757" stroke-width="8" fill="none"/>
  <!-- 水瓶 -->
  <rect x="760" y="224" width="74" height="200" rx="20" fill="#dbeafe" stroke="#7aa7e8" stroke-width="4"/>
  <rect x="802" y="200" width="26" height="34" rx="6" fill="#54a0ff"/>
  <rect x="760" y="250" width="74" height="120" rx="14" fill="#bfdbfe"/>
  <!-- 纸巾 -->
  <rect x="630" y="170" width="120" height="120" rx="10" fill="#ffffff" stroke="#d5dde7" stroke-width="3"/>
  <path d="M660 180 q 30 -6 60 0" stroke="#e6ebf2" stroke-width="4" fill="none"/>
  <!-- 纸张与杂物 -->
  <rect x="600" y="360" width="150" height="30" rx="6" fill="#ffffff" stroke="#dbe3ee" stroke-width="2"/>
  <rect x="610" y="396" width="120" height="26" rx="6" fill="#fdf3cf" stroke="#e4d9a4" stroke-width="2"/>
  <rect x="90" y="250" width="90" height="54" rx="8" fill="#f97316"/>
  <rect x="90" y="320" width="72" height="40" rx="8" fill="#22c55e"/>
  <text x="90" y="615" font-size="30" fill="#8a7a4d">桌面场景 · 多用电设备集中（演示图）</text>
</svg>`;

const sceneWorkshop = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#d6deea"/>
  <rect y="0" width="${W}" height="720" fill="#e8eef6"/>
  <rect y="560" width="${W}" height="240" fill="#b9c6d6"/>
  <g>
    <path d="M0 620 h1200" stroke="#f59e0b" stroke-width="16"/>
    <rect x="0" y="620" width="1200" height="8" fill="#20262e"/>
  </g>
  <!-- 配电箱 -->
  <rect x="140" y="150" width="340" height="420" rx="12" fill="#8b98a8" stroke="#5d6b7c" stroke-width="6"/>
  <rect x="182" y="196" width="256" height="300" rx="6" fill="#dde4ec"/>
  <rect x="210" y="230" width="90" height="120" fill="#b7c2d1"/>
  <circle cx="262" cy="200" r="20" fill="#c0392b"/>
  <rect x="396" y="210" width="30" height="120" rx="6" fill="#3b82f6"/>
  <rect x="150" y="100" width="110" height="40" rx="8" fill="#f39c12"/>
  <text x="158" y="127" font-size="22" fill="#fff" font-weight="bold">有电危险</text>
  <rect x="140" y="575" width="340" height="26" rx="6" fill="#6b7787"/>
  <!-- 电缆 -->
  <path d="M320 570 C 300 630, 240 640, 200 700 C 180 730, 260 760, 420 770 C 600 780, 760 730, 880 700 C 980 675, 1040 690, 1120 680" stroke="#262f3a" stroke-width="16" fill="none"/>
  <path d="M560 570 C 560 620, 640 640, 700 660" stroke="#3b4757" stroke-width="10" fill="none"/>
  <!-- 杂物 -->
  <rect x="620" y="140" width="150" height="150" rx="8" fill="#8b5cf6"/>
  <rect x="820" y="200" width="120" height="120" rx="8" fill="#f59e0b"/>
  <rect x="700" y="420" width="200" height="40" rx="8" fill="#94a3b8"/>
  <text x="60" y="760" font-size="30" fill="#556273">配电区域 · 临时用电（演示图）</text>
</svg>`;

const sceneScaffold = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#cfd9e8"/>
  <rect y="0" width="${W}" height="300" fill="#a9c4ee"/>
  <rect y="0" width="${W}" height="120" fill="#93b4e8"/>
  <!-- 楼体 -->
  <rect x="820" y="120" width="380" height="680" fill="#cbd5e1" stroke="#94a3b8" stroke-width="4"/>
  <rect x="900" y="200" width="140" height="90" fill="#7ba7dc"/>
  <!-- 脚手架钢管 -->
  <g stroke="#d98a28" stroke-width="18" fill="none">
    <rect x="120" y="200" width="720" height="600" rx="4"/>
  </g>
  <g stroke="#b0691a" stroke-width="14" fill="none">
    <line x1="210" y1="200" x2="210" y2="800"/>
    <line x1="330" y1="200" x2="330" y2="800"/>
    <line x1="600" y1="200" x2="600" y2="800"/>
    <line x1="750" y1="200" x2="750" y2="800"/>
    <line x1="120" y1="330" x2="840" y2="330"/>
    <line x1="120" y1="520" x2="840" y2="520"/>
    <line x1="120" y1="650" x2="840" y2="650"/>
  </g>
  <g stroke="#c1781f" stroke-width="10" fill="none">
    <line x1="300" y1="330" x2="330" y2="520"/>
    <line x1="570" y1="330" x2="600" y2="520"/>
    <line x1="720" y1="520" x2="750" y2="650"/>
  </g>
  <!-- 脚手板 -->
  <rect x="135" y="288" width="690" height="34" rx="4" fill="#cd9a4f"/>
  <rect x="135" y="322" width="220" height="30" rx="4" fill="#b9883e"/>
  <!-- 作业人员 -->
  <circle cx="640" cy="200" r="26" fill="#f5f5f5"/>
  <rect x="612" y="226" width="56" height="70" rx="12" fill="#f97316"/>
  <rect x="606" y="296" width="26" height="46" rx="8" fill="#f97316"/>
  <rect x="648" y="296" width="26" height="46" rx="8" fill="#f97316"/>
  <!-- 临边无护栏警示线 -->
  <path d="M135 262 h690" stroke="#e0342f" stroke-width="8" stroke-dasharray="26 22"/>
  <text x="120" y="760" font-size="30" fill="#4a5868">高处作业脚手架 · 临边（演示图）</text>
</svg>`;

const sceneClean = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#e6eef8"/>
  <rect y="0" width="${W}" height="140" fill="#d3e3f6"/>
  <rect x="60" y="200" width="1080" height="460" rx="18" fill="#f7fafd" stroke="#ccd9e8" stroke-width="4"/>
  <rect x="60" y="200" width="1080" height="30" rx="12" fill="#e3edf8"/>
  <!-- 整洁摆设 -->
  <rect x="220" y="300" width="150" height="90" rx="8" fill="#ffffff" stroke="#b9c9dc" stroke-width="3"/>
  <rect x="210" y="430" width="170" height="60" rx="8" fill="#eef4fb" stroke="#b9c9dc" stroke-width="3"/>
  <circle cx="520" cy="360" r="60" fill="#22c55e"/>
  <rect x="600" y="300" width="60" height="120" rx="8" fill="#93c5fd"/>
  <!-- 5S 看板 -->
  <rect x="820" y="280" width="220" height="180" rx="10" fill="#2563eb"/>
  <text x="860" y="350" font-size="42" fill="#fff" font-weight="bold">5S</text>
  <text x="855" y="410" font-size="24" fill="#dbeafe">整洁 · 有序</text>
  <text x="855" y="445" font-size="20" fill="#bfdbfe">文明施工 达标</text>
  <text x="100" y="740" font-size="30" fill="#5c6b7f">整洁现场 · 无明显隐患（演示图）</text>
</svg>`;

export const SAMPLE_SCENES: Array<{ meta: SampleScene; svg: string }> = [
  { meta: { id: 'desk', label: '桌面用电设备', desc: '多充电器集中使用场景', scenarioId: 'desk', width: W, height: H }, svg: sceneDesk },
  { meta: { id: 'workshop', label: '配电箱区域', desc: '临时用电场景', scenarioId: 'workshop', width: W, height: H }, svg: sceneWorkshop },
  { meta: { id: 'scaffold', label: '高处脚手架', desc: '高处作业场景', scenarioId: 'scaffold', width: W, height: H }, svg: sceneScaffold },
  { meta: { id: 'clean', label: '整洁现场', desc: '无隐患演示', scenarioId: 'clean', width: W, height: H }, svg: sceneClean },
];

/** 将 SVG 场景渲染为 PNG Blob（并保留 scenarioId 供后台标记） */
export async function renderSampleScene(scene: { meta: SampleScene; svg: string }): Promise<{ blob: Blob; dataUrl: string; scenarioId: string }> {
  const img = new Image();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(scene.svg)}`;
  img.src = url;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('示例图渲染失败'));
  });
  const canvas = document.createElement('canvas');
  canvas.width = scene.meta.width;
  canvas.height = scene.meta.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, scene.meta.width, scene.meta.height);
  ctx.drawImage(img, 0, 0, scene.meta.width, scene.meta.height);
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 生成失败'))), 'image/png');
  });
  return { blob, dataUrl: canvas.toDataURL('image/png'), scenarioId: scene.meta.scenarioId };
}
