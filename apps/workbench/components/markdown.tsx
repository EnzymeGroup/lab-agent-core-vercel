import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';

/**
 * Model and artifact Markdown. Raw HTML is never interpreted (no rehype-raw),
 * images are shown as links so nothing loads remotely, and only http(s) links open.
 */

function safeHref(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return;
  }
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    return safe ? <a href={safe} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>;
  },
  img: ({ src, alt }) => {
    const safe = safeHref(typeof src === 'string' ? src : undefined);
    const label = alt || 'image';
    return safe ? <a href={safe} target="_blank" rel="noreferrer noopener">[{label}]</a> : <span>[{label}]</span>;
  },
  table: ({ children }) => <div className="not-prose my-3 overflow-x-auto rounded-md border"><table className="w-full text-left text-xs [&_td]:border-t [&_td]:px-3 [&_td]:py-1.5 [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:font-medium">{children}</table></div>,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(
      'prose prose-sm max-w-none break-words dark:prose-invert',
      'prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-relaxed',
      'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
      'prose-pre:rounded-md prose-pre:border prose-pre:bg-muted prose-pre:text-foreground',
      'prose-a:text-foreground prose-a:underline-offset-4',
      className,
    )}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{children}</ReactMarkdown>
    </div>
  );
}
