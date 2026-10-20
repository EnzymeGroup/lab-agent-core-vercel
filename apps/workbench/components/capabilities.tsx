'use client';

import { useEffect } from 'react';
import { Bot, Brain, ChevronRight, Cpu, Plug, Sparkles, Terminal, Wrench } from 'lucide-react';
import { formatCost, type AgentState, type ToolDetail } from '../lib/api';
import McpServers from './mcp-servers';
import Memory from './memory';
import Skills from './skills';
import ToolSwitches from './tool-switches';
import { Badge } from './ui/badge';
import { Dialog } from './ui/dialog';

/**
 * Project capabilities: models, limits and prices, Skills (expandable), tools with schemas
 * and approval, helpers and compaction, Python policy and MCP servers (add/test/remove HTTP
 * servers). Stable hook: .capability-list.
 */

export type CapabilitySection = 'models' | 'skills' | 'memory' | 'tools' | 'agents' | 'python' | 'mcp';

const SECTIONS: Array<{ id: CapabilitySection; label: string }> = [
  { id: 'models', label: 'Models' }, { id: 'skills', label: 'Skills' }, { id: 'memory', label: 'Memory' }, { id: 'tools', label: 'Tools' }, { id: 'agents', label: 'Helpers' }, { id: 'python', label: 'Python' }, { id: 'mcp', label: 'MCP' },
];

function Section({ id, icon: Icon, title, count, children }: { id: CapabilitySection; icon: typeof Wrench; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section id={`capability-${id}`} aria-label={title} className="scroll-mt-4 space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-muted-foreground" />{title}
        {count !== undefined && <span className="text-xs font-normal text-muted-foreground tabular">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: string }) => <p className="text-xs text-muted-foreground">{children}</p>;
const itemClass = 'rounded-md border p-3 text-xs';
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

export default function Capabilities({ token, state, section, onChanged, onClose }: { token: string; state: AgentState; section?: CapabilitySection; onChanged(): Promise<unknown>; onClose(): void }) {
  const tools: ToolDetail[] = state.toolDetails ?? state.tools.map(name => ({ name, description: '', inputSchema: undefined, needsApproval: false }));
  const models = state.models ?? [{ key: 'default', ...state.model, default: true }];
  const access = state.fileAccess;
  const subagents = state.subagents ?? [];
  const limits: Array<[string, string]> = state.limits ? [
    ['Context budget', `${state.limits.maxContextChars.toLocaleString()} chars`],
    ['Max steps', String(state.limits.maxSteps)],
    ['Turn timeout', seconds(state.limits.timeoutMs)],
    ['Provider retries', String(state.limits.maxRetries ?? 2)],
    ...(state.limits.maxContextTokens ? [['Context tokens', state.limits.maxContextTokens.toLocaleString()] as [string, string]] : []),
    ...(state.limits.maxTurnTokens ? [['Turn token budget', state.limits.maxTurnTokens.toLocaleString()] as [string, string]] : []),
  ] : [];
  const facts: Array<[string, React.ReactNode]> = [
    ['Project', <code key="p" className="font-mono break-all">{state.project}</code>],
    ['Concurrency', 'One project, one active operation. Sessions share the same project lock.'],
    ['File access', !access ? 'File access policy is not reported by this server.'
      : access.mode === 'development' ? 'Development: edits are limited to configured write roots.' : 'Analysis: writes are limited to the current run output.'],
  ];
  if (access?.readRoots) facts.push(['Read roots', <code key="r" className="font-mono">{access.readRoots.join(', ') || 'None configured'}</code>]);
  if (access?.writeRoots) facts.push(['Write roots', <code key="w" className="font-mono">{access.writeRoots.join(', ') || 'None configured'}</code>]);

  // Opened from a sidebar shortcut: jump to that section once the dialog has rendered.
  useEffect(() => {
    if (section) requestAnimationFrame(() => document.getElementById(`capability-${section}`)?.scrollIntoView({ block: 'start' }));
  }, [section]);

  return (
    <Dialog title="Project capabilities" description="Configuration, connection status and MCP servers" closeLabel="Close capabilities" onClose={onClose}>
      <nav aria-label="Capability sections" className="-mt-1 mb-5 flex flex-wrap gap-1">
        {SECTIONS.map(item => (
          <a key={item.id} href={`#capability-${item.id}`} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={event => { event.preventDefault(); document.getElementById(`capability-${item.id}`)?.scrollIntoView({ block: 'start' }); }}>{item.label}</a>
        ))}
      </nav>
      <div className="space-y-7">
        <dl className="grid gap-x-4 gap-y-2.5 rounded-md bg-muted p-4 text-xs sm:grid-cols-[120px_1fr]">
          {facts.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0">{value}</dd></div>)}
        </dl>

        <Section id="models" icon={Cpu} title="Models and limits" count={models.length}>
          <ul className="capability-list grid gap-2 sm:grid-cols-2">
            {models.map(model => (
              <li key={model.key} className={itemClass}>
                <div className="flex items-center gap-2"><strong className="font-medium">{model.key}</strong>{model.default && <Badge>default</Badge>}</div>
                <code className="mt-1 block font-mono text-[11px] break-all text-muted-foreground">{model.provider} / {model.id}</code>
                {state.pricing?.[model.key] && <p className="mt-1 text-muted-foreground">{formatCost(state.pricing[model.key].input)} in · {formatCost(state.pricing[model.key].output)} out per million tokens</p>}
              </li>
            ))}
          </ul>
          {models.length === 1 && <Empty>Add a models map in agent.config.ts to choose between models per session.</Empty>}
          {limits.length > 0 && (
            <dl className="grid grid-cols-3 gap-2 text-xs">
              {limits.map(([label, value]) => <div key={label} className={itemClass}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 tabular">{value}</dd></div>)}
            </dl>
          )}
          {state.pricing && !Object.keys(state.pricing).length && <Empty>Add pricing in agent.config.ts to see run and session cost.</Empty>}
        </Section>

        <Section id="skills" icon={Sparkles} title="Skills" count={state.skills.length}>
          <Skills token={token} skills={state.skills} />
        </Section>

        <Section id="memory" icon={Brain} title="Project memory" count={state.memory ? state.memory.length : undefined}>
          <Memory token={token} entries={state.memory} onChanged={onChanged} />
        </Section>

        <Section id="tools" icon={Wrench} title="Tools" count={tools.length}>
          {tools.length ? (
            <ul className="capability-list grid gap-2">
              {tools.map(tool => (
                <li key={tool.name} className={itemClass}>
                  <div className="flex items-center gap-2">
                    <strong className="font-medium"><code className="font-mono">{tool.name}</code></strong>
                    {tool.needsApproval && !tool.alwaysAllow && <Badge tone="warning">Needs approval</Badge>}
                    {tool.alwaysAllow && <Badge>Always allowed</Badge>}
                    {tool.enabled === false && <Badge tone="danger">Off</Badge>}
                  </div>
                  <p className="mt-1 text-muted-foreground">{tool.description || 'Description not reported by this server.'}</p>
                  <ToolSwitches token={token} tool={tool} busy={state.busy} onChanged={onChanged} />
                  <details className="group mt-2">
                    <summary className="flex items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronRight className="size-3 transition-transform group-open:rotate-90" />Input schema for {tool.name}</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2.5 font-mono text-[11px]">{tool.inputSchema === undefined ? 'Schema not reported by this server.' : JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
          ) : <Empty>No tools configured.</Empty>}
        </Section>

        <Section id="agents" icon={Bot} title="Helpers and context" count={subagents.length}>
          {subagents.length ? (
            <ul className="capability-list grid gap-2">
              {subagents.map(helper => (
                <li key={helper.name} className={itemClass}>
                  <div className="flex items-center justify-between gap-2"><strong className="font-medium">{helper.name}</strong><span className="text-muted-foreground">{helper.model} · {helper.maxSteps} steps</span></div>
                  <p className="mt-1 text-muted-foreground">{helper.description}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">{helper.tools.join(', ') || 'No tools'}</p>
                </li>
              ))}
            </ul>
          ) : <Empty>No helpers configured. Add subagents in agent.config.ts to let the agent delegate through runSubagent.</Empty>}
          <dl className="grid gap-x-4 gap-y-2 rounded-md bg-muted p-4 text-xs sm:grid-cols-[120px_1fr]">
            <dt className="text-muted-foreground">Approval</dt>
            <dd>{state.approval?.length ? <code className="font-mono">{state.approval.join(', ')}</code> : 'No tool needs approval.'}</dd>
            <dt className="text-muted-foreground">Compaction</dt>
            <dd>{state.compaction === undefined ? 'Not reported by this server.' : state.compaction === false ? 'Off: the oldest turns are left out when the context is full.'
              : `Older turns are summarized at ${Math.round(state.compaction.at * 100)}% of the budget; the last ${state.compaction.keepTurns} turn(s) stay verbatim.`}</dd>
          </dl>
        </Section>

        <Section id="python" icon={Terminal} title="Python script policy">
          <p className="text-xs text-muted-foreground">Registered Python and native tools execute trusted host code. Chat tool calls may have side effects. Script modes restrict when a registered Python script is available; they do not create an OS sandbox.</p>
          {state.pythonScripts === undefined ? <Empty>Script modes are not reported by this server.</Empty>
            : state.pythonScripts.length ? (
              <ul className="capability-list grid gap-2">
                {state.pythonScripts.map(script => (
                  <li key={script.name} className={itemClass}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="font-medium"><code className="font-mono">{script.name}</code></strong>
                      <span className="flex gap-1">{script.modes.length ? script.modes.map(mode => <Badge key={mode}>{mode === 'chat' ? 'Chat' : 'Task'}</Badge>) : <Badge>Neither mode</Badge>}</span>
                    </div>
                    <p className="mt-1 text-muted-foreground">{script.description}</p>
                    <p className="sr-only">Allowed in: {script.modes.map(mode => mode === 'chat' ? 'Chat' : 'Task').join(', ') || 'Neither mode'}</p>
                  </li>
                ))}
              </ul>
            ) : <Empty>No Python scripts configured.</Empty>}
        </Section>

        <Section id="mcp" icon={Plug} title="MCP servers" count={state.mcp?.length}>
          {state.mcp === undefined ? <Empty>MCP connection status is not reported by this server.</Empty>
            : <McpServers token={token} servers={state.mcp} busy={state.busy} onChanged={onChanged} />}
        </Section>
      </div>
    </Dialog>
  );
}
