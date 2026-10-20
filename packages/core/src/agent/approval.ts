import type { UIMessage } from 'ai';
import { InputError } from '../errors.js';
import type { ApprovalDecision, PendingApproval, SessionRecord } from '../types.js';

/**
 * Human approval for configured tools, using the AI SDK's native toolApproval.
 * A turn that reaches such a call ends with the part in state "approval-requested";
 * respond() writes the decision onto that part and continues the same assistant message.
 */

type ToolPart = { type: string; toolName?: string; toolCallId: string; state: string; input?: unknown; approval?: { id: string; approved?: boolean; reason?: string } };

const isToolPart = (part: UIMessage['parts'][number]): boolean => part.type === 'dynamic-tool' || part.type.startsWith('tool-');
const toolName = (part: ToolPart) => part.type === 'dynamic-tool' ? part.toolName ?? '' : part.type.slice(5);

/** "*" matches everything, "mcp_*" a prefix, anything else an exact name. */
export function approvalMatcher(patterns: readonly string[] = []): (name: string) => boolean {
  return name => patterns.some(pattern => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

/** Tool calls in the last assistant message that still wait for a decision. */
export function pendingApprovals(session: SessionRecord): PendingApproval[] {
  const last = session.messages.at(-1);
  if (last?.role !== 'assistant') return [];
  return last.parts.filter(isToolPart).map(part => part as unknown as ToolPart)
    .filter(part => part.state === 'approval-requested' && part.approval)
    .map(part => ({ approvalId: part.approval!.id, toolCallId: part.toolCallId, toolName: toolName(part), input: part.input }));
}

/** Validate untrusted decisions. Every pending call must be answered exactly once. */
export function parseDecisions(value: unknown): ApprovalDecision[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new InputError('approvals must be an array of 1–64 decisions.');
  return value.map(item => {
    const { approvalId, approved, reason } = (item ?? {}) as Record<string, unknown>;
    if (typeof approvalId !== 'string' || !approvalId || approvalId.length > 200 || typeof approved !== 'boolean') throw new InputError('Each approval needs an approvalId and approved: true or false.');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 2000)) throw new InputError('An approval reason must be at most 2000 characters.');
    return { approvalId, approved, ...(reason ? { reason } : {}) };
  });
}

/** Write decisions onto the stored parts. Only the server's own pending calls can be answered. */
export function applyDecisions(session: SessionRecord, decisions: ApprovalDecision[]): void {
  const pending = new Map(pendingApprovals(session).map(item => [item.approvalId, item]));
  const answered = new Set<string>();
  for (const decision of decisions) {
    if (!pending.has(decision.approvalId)) throw new InputError(`No pending approval ${decision.approvalId} in this session.`);
    if (answered.has(decision.approvalId)) throw new InputError(`Approval ${decision.approvalId} was answered twice.`);
    answered.add(decision.approvalId);
  }
  const missing = [...pending.values()].filter(item => !answered.has(item.approvalId));
  if (missing.length) throw new InputError(`Answer every pending tool call: ${missing.map(item => item.toolName).join(', ')}.`);
  const byId = new Map(decisions.map(decision => [decision.approvalId, decision]));
  const last = session.messages.at(-1)!;
  last.parts = last.parts.map(part => {
    const tool = part as unknown as ToolPart;
    const decision = isToolPart(part) && tool.state === 'approval-requested' ? byId.get(tool.approval?.id ?? '') : undefined;
    if (!decision) return part;
    return { ...tool, state: 'approval-responded', approval: { ...tool.approval!, approved: decision.approved, ...(decision.reason ? { reason: decision.reason } : {}) } } as unknown as UIMessage['parts'][number];
  });
}

/** Decisions a UI encoded on the assistant message it sent back (useChat addToolApprovalResponse). */
export function decisionsFromMessage(message: { role: string; parts: unknown[] }): ApprovalDecision[] {
  if (message.role !== 'assistant') return [];
  return message.parts.map(part => part as Partial<ToolPart>)
    .filter(part => part.state === 'approval-responded' && part.approval && typeof part.approval.approved === 'boolean')
    .map(part => ({ approvalId: String(part.approval!.id), approved: part.approval!.approved!, ...(part.approval!.reason ? { reason: String(part.approval!.reason) } : {}) }));
}
