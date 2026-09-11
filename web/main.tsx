import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('root 容器不存在');

createRoot(container).render(<App />);
