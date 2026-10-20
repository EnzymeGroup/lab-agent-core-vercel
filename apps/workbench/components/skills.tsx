'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api, errorMessage, type Skill } from '../lib/api';
import { Markdown } from './markdown';

/** Skills with their full SKILL.md on demand. Viewing a Skill never marks it as used by a run. */

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '');
}

function SkillItem({ token, skill }: { token: string; skill: Skill }) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');

  async function load() {
    if (content !== undefined) return;
    try {
      const result = await api<{ content: string }>(token, `/api/skill?name=${encodeURIComponent(skill.name)}`);
      setContent(stripFrontmatter(result.content));
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <li className="rounded-md border text-xs">
      <details className="group" onToggle={event => { if ((event.target as HTMLDetailsElement).open) void load(); }}>
        <summary className="flex items-start gap-2 p-3 hover:bg-accent/60">
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="min-w-0">
            <strong className="font-medium">{skill.name}</strong>
            <span className="mt-0.5 block text-muted-foreground">{skill.description}</span>
            <code className="mt-1 block font-mono text-[11px] break-all text-muted-foreground">{skill.path}</code>
          </span>
        </summary>
        <div className="border-t px-4 py-3">
          {error ? <p role="alert" className="text-destructive">{error}</p>
            : content === undefined ? <p role="status" className="text-muted-foreground">Loading SKILL.md…</p>
              : <Markdown>{content}</Markdown>}
        </div>
      </details>
    </li>
  );
}

export default function Skills({ token, skills }: { token: string; skills: Skill[] }) {
  if (!skills.length) return <p className="text-xs text-muted-foreground">No skills discovered.</p>;
  return <ul className="capability-list grid gap-2">{skills.map(skill => <SkillItem key={skill.path} token={token} skill={skill} />)}</ul>;
}
