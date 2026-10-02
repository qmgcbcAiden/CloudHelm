import { Children, createContext, isValidElement, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './markdown-message.module.css';

const InsideLink = createContext(false);

/** Model-provided links require an explicit HTTP(S) destination; no relative or executable URLs. */
export function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }): React.JSX.Element {
  if (!href) return <span className={styles.disabledLink}>{children}</span>;
  return <InsideLink.Provider value={true}><a href={href} target="_blank" rel="noopener noreferrer">{children}</a></InsideLink.Provider>;
}

function DeferredImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element {
  const insideLink = useContext(InsideLink);
  const label = `查看图片：${alt || '图片'}`;
  // Linked images retain the surrounding link's explicit destination without nesting anchors.
  if (insideLink || !src) return <span className={styles.imageLink}>{label}{!src ? '（地址不可用）' : ''}</span>;
  return <a className={styles.imageLink} href={src} target="_blank" rel="noopener noreferrer">{label}</a>;
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const child = Children.toArray(children).find(isValidElement);
  const code = child?.props as { className?: string; children?: ReactNode } | undefined;
  const language = /language-([^\s]+)/u.exec(code?.className ?? '')?.[1] ?? '代码';
  const text = Children.toArray(code?.children).filter((part) => typeof part === 'string' || typeof part === 'number').join('');
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(text); setCopied('copied'); }
    catch { setCopied('failed'); }
  }
  return <div className={styles.codeBlock}>
    <div className={styles.codeHeader}><span>{language}</span><button type="button" aria-label="复制代码" onClick={() => void copy()}>
      {copied === 'copied' ? '已复制' : copied === 'failed' ? '复制失败，点击重试' : '复制'}</button></div>
    <pre>{children}</pre>
    <span className={styles.copyStatus} role="status">{copied === 'copied' ? '代码已复制到剪贴板，不会执行。' : copied === 'failed' ? '无法访问剪贴板，请重试或手动选择代码。' : ''}</span>
  </div>;
}

export function MarkdownMessage({ text }: { text: string }): React.JSX.Element {
  return <div className={styles.markdown}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeMarkdownUrl} components={{
      a: MarkdownLink,
      img: DeferredImage,
      pre: CodeBlock,
      code: ({ children, className }) => <code className={`${styles.inlineCode} ${className ?? ''}`}>{children}</code>,
      table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>
    }}>{text}</ReactMarkdown>
  </div>;
}
