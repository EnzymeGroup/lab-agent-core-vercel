import type { UIMessage } from 'ai';

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'Waiting for data…';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return; }
}

export default function Message({ message }: { message: UIMessage }) {
  return (
    <article className={`message message-${message.role}`} aria-label={`${message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System'} message`}>
      <div className="message-speaker"><span className={`speaker-icon ${message.role}`} aria-hidden="true">{message.role === 'user' ? 'Y' : message.role === 'assistant' ? 'L' : 'S'}</span><span>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System'}</span></div>
      <div className="message-content">{message.parts.map((part, index) => {
        if (part.type === 'text') return <div key={index} className="message-text">{part.text}</div>;
        if (part.type === 'step-start') return null;
        if (part.type === 'reasoning') return <details key={index} className="reasoning"><summary>Reasoning</summary><div className="message-text">{part.text}</div></details>;
        if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
          const tool = part as unknown as { type: string; toolName?: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string };
          const failed = tool.state === 'output-error' || tool.state === 'output-denied';
          return <details key={tool.toolCallId || index} open className={`tool-call ${failed ? 'tool-failed' : ''}`}><summary><code>{tool.toolName || tool.type.slice(5)}</code><span className="tool-phase">{tool.state.replaceAll('-', ' ')}</span></summary><div className="tool-body"><span className="field-label">ARGUMENTS</span><pre>{printable(tool.input)}</pre>{tool.output !== undefined && <><span className="field-label">OUTPUT</span><pre>{printable(tool.output)}</pre></>}{tool.errorText && <p className="tool-error" role="alert">{tool.errorText}</p>}{tool.state === 'output-denied' && <p className="tool-error">Tool execution was denied.</p>}{(tool.state === 'approval-requested' || tool.state === 'approval-responded') && <p>Tool approval requires action in the configured agent runtime.</p>}</div></details>;
        }
        if (part.type === 'source-url') {
          const href = safeUrl(part.url);
          return href ? <a className="source-link" key={index} href={href} target="_blank" rel="noreferrer">{part.title || href} ↗</a> : null;
        }
        if (part.type === 'file') {
          const href = safeUrl(part.url);
          return href ? <a className="source-link" key={index} href={href} target="_blank" rel="noreferrer">{part.filename || 'Attached file'} ↗</a> : <p key={index} className="muted">Attachment: {part.filename || part.mediaType}</p>;
        }
        return <details key={index} className="message-data"><summary>{part.type}</summary><pre>{printable(part)}</pre></details>;
      })}</div>
    </article>
  );
}
