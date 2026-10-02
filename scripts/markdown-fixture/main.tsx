import { createRoot } from 'react-dom/client';
import { MarkdownMessage } from '../../apps/desktop/src/renderer/markdown-message.js';
import '../../apps/desktop/src/renderer/global.css';
import './preview.css';

const text = [
  '## Docker 部署完成',
  '**服务运行正常**，以下是验证结果。',
  '- 容器已启动，并配置自动重启\n- 健康检查返回 HTTP 200',
  '> 配置变更前已保存恢复副本。',
  '| 验证项 | 结果 |\n| --- | --- |\n| 容器状态 | running |\n| 监听端口 | 8080 |',
  '你可以用 `docker ps` 查看容器。',
  '```bash\ndocker logs --tail 50 demo-service\n```',
  '[访问服务](https://service.example.test/status)',
  '![部署示意图](https://images.example.test/private.png)',
  '[不可执行链接](javascript:alert%281%29)',
  '<img src="https://images.example.test/raw.png" onerror="window.markdownExecuted=true">',
  '<script>window.markdownExecuted=true</script>'
].join('\n\n');
createRoot(document.getElementById('root')!).render(<main className="preview-card"><header>CloudHelm · AI 助手</header><MarkdownMessage text={text} /></main>);
