import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownMessage, safeMarkdownUrl } from './markdown-message.js';

const render = (text: string): string => renderToStaticMarkup(createElement(MarkdownMessage, { text }));

describe('assistant Markdown rendering', () => {
  it('renders headings, emphasis, lists, quotes, tables, and code while keeping code literal', () => {
    const html = render('## 验证结果\n\n**成功**\n\n- Docker 已安装\n- 服务已启动\n\n> 已核验\n\n| 项目 | 状态 |\n| --- | --- |\n| HTTP | 200 |\n\n运行 `docker ps`\n\n```bash\nprintf "<script>not executed</script>"\n```');
    expect(html).toContain('<h2>验证结果</h2>');
    expect(html).toContain('<strong>成功</strong>');
    expect(html).toContain('<ul>'); expect(html).toContain('<blockquote>'); expect(html).toContain('<table>');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('&lt;script&gt;not executed&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'mailto:owner@example.test', '//example.test/private', '/local', '#local', 'vbscript:msgbox(1)', 'https://user:secret@example.test/', 'http://user@example.test/'])('disables unsupported URL schemes and relative links: %s', (url) => {
    expect(safeMarkdownUrl(url)).toBe('');
  });

  it('permits only explicit HTTP(S) links with a separate browsing context and opener isolation', () => {
    const html = render('[服务](https://service.example.test/status) 和 [本机服务](http://127.0.0.1:8080/)');
    expect(html).toContain('href="https://service.example.test/status"');
    expect(html).toContain('href="http://127.0.0.1:8080/"');
    expect(html.match(/target="_blank" rel="noopener noreferrer"/gu)).toHaveLength(2);
  });

  it('drops raw HTML and decoded executable link destinations', () => {
    const html = render('<script>window.markdownExecuted=true</script>\n\n<img src="https://images.example.test/secret" onerror="alert(1)">\n\n[bad](jav&#x61;script:alert%281%29)\n\n[data](data:text/html;base64,SGVsbG8=)');
    expect(html).not.toMatch(/<(?:script|img)|onerror|href="(?:javascript|data):/u);
    expect(html).not.toContain('window.markdownExecuted');
    expect(html).toContain('bad');
  });

  it('renders remote images only as explicit links and never emits an image resource', () => {
    const html = render('![部署图](https://images.example.test/private.png)\n\n![blocked](data:image/svg+xml,unsafe)');
    expect(html).not.toContain('<img');
    expect(html).toContain('查看图片：部署图');
    expect(html).toContain('href="https://images.example.test/private.png"');
    expect(html).not.toContain('href="data:');
  });

  it('keeps an image wrapped in a link valid without nesting anchors', () => {
    const html = render('[![服务状态](https://images.example.test/status.png)](https://service.example.test/)');
    expect(html.match(/<a\s/gu)).toHaveLength(1);
    expect(html).toContain('href="https://service.example.test/"');
    expect(html).not.toContain('<img');
  });
});
