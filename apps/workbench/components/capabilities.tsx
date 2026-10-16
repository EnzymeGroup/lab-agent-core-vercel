'use client';

import { useEffect, useRef } from 'react';
import type { AgentState } from '../lib/api';

export default function Capabilities({ state, onClose }: { state: AgentState; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const tools = state.toolDetails ?? state.tools.map(name => ({ name, description: '', inputSchema: undefined }));

  return <dialog ref={dialog} className="workbench-dialog capabilities-dialog" aria-labelledby="capabilities-title" onClose={onClose}>
    <div className="dialog-heading"><div><h2 id="capabilities-title">Project capabilities</h2><p>Read-only configuration and current connection status</p></div><button autoFocus onClick={() => dialog.current?.close()} aria-label="Close capabilities">Close</button></div>
    <div className="dialog-body">
      <section><h3>Project & model</h3><dl className="capability-facts"><div><dt>Project</dt><dd><code>{state.project}</code></dd></div><div><dt>Model</dt><dd>{state.model.provider} / {state.model.id}</dd></div><div><dt>Concurrency</dt><dd>One project, one active operation. Sessions share the same project lock.</dd></div><div><dt>File access</dt><dd>{state.fileAccess ? state.fileAccess.mode === 'development' ? 'Development: edits are limited to configured write roots.' : 'Analysis: writes are limited to the current run output.' : 'File access policy is not reported by this server.'}</dd></div>{state.fileAccess?.readRoots && <div><dt>Read roots</dt><dd><code>{state.fileAccess.readRoots.join(', ') || 'None configured'}</code></dd></div>}{state.fileAccess?.writeRoots && <div><dt>Write roots</dt><dd><code>{state.fileAccess.writeRoots.join(', ') || 'None configured'}</code></dd></div>}</dl></section>
      <section><h3>Tools <span className="count-label">{tools.length}</span></h3>{tools.length ? <ul className="capability-list">{tools.map(tool => <li key={tool.name}><strong><code>{tool.name}</code></strong><p>{tool.description || 'Description not reported by this server.'}</p><details><summary>Input schema for {tool.name}</summary><pre>{tool.inputSchema === undefined ? 'Schema not reported by this server.' : JSON.stringify(tool.inputSchema, null, 2)}</pre></details></li>)}</ul> : <p className="section-note">No tools configured.</p>}</section>
      <section><h3>Skills <span className="count-label">{state.skills.length}</span></h3>{state.skills.length ? <ul className="capability-list">{state.skills.map(skill => <li key={skill.path}><strong>{skill.name}</strong><p>{skill.description}</p><code>{skill.path}</code></li>)}</ul> : <p className="section-note">No skills discovered.</p>}</section>
      <section><h3>Python script policy</h3><p className="section-note">Registered Python and native tools execute trusted host code. Chat tool calls may have side effects. Script modes restrict when a registered Python script is available; they do not create an OS sandbox.</p>{state.pythonScripts === undefined ? <p className="section-note">Script modes are not reported by this server.</p> : state.pythonScripts.length ? <ul className="capability-list">{state.pythonScripts.map(script => <li key={script.name}><strong><code>{script.name}</code></strong><p>{script.description}</p><p>Allowed in: {script.modes.map(mode => mode === 'chat' ? 'Chat' : 'Task').join(', ') || 'Neither mode'}</p></li>)}</ul> : <p className="section-note">No Python scripts configured.</p>}</section>
      <section><h3>MCP servers</h3>{state.mcp === undefined ? <p className="section-note">MCP connection status is not reported by this server.</p> : state.mcp.length ? <ul className="capability-list">{state.mcp.map(server => <li key={server.name}><div className="mcp-heading"><strong>{server.name}</strong><span className={`status ${server.status === 'connected' ? 'status-running' : 'status-failed'}`}>{server.status}</span></div><p>{server.transport} · {server.optional ? 'Optional' : 'Required'}</p>{server.error && <p className="input-error">{server.error}</p>}</li>)}</ul> : <p className="section-note">No MCP servers configured.</p>}</section>
    </div>
  </dialog>;
}
