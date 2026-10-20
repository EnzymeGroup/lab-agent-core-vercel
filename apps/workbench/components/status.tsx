import { CircleCheck, CircleDashed, CircleX, LoaderCircle, ShieldQuestion, TriangleAlert } from 'lucide-react';
import type { RunRecord } from '../lib/api';
import { Badge } from './ui/badge';

type Delivery = RunRecord['delivery'];
type Execution = RunRecord['execution'];

export const deliveryLabel: Record<Delivery, string> = { not_checked: 'Not checked', passed: 'Passed', partial: 'Partial', failed: 'Failed' };
export const executionLabel: Record<Execution, string> = { running: 'Running', awaiting_approval: 'Needs approval', completed: 'Completed', failed: 'Failed', aborted: 'Aborted' };

export function DeliveryBadge({ delivery }: { delivery: Delivery }) {
  const tone = delivery === 'passed' ? 'success' : delivery === 'partial' ? 'warning' : delivery === 'failed' ? 'danger' : 'neutral';
  const Icon = delivery === 'passed' ? CircleCheck : delivery === 'partial' ? TriangleAlert : delivery === 'failed' ? CircleX : CircleDashed;
  return <Badge tone={tone}><Icon />{deliveryLabel[delivery]}</Badge>;
}

export function ExecutionBadge({ execution }: { execution: Execution }) {
  const tone = execution === 'completed' ? 'neutral' : execution === 'running' || execution === 'awaiting_approval' ? 'warning' : execution === 'failed' ? 'danger' : 'neutral';
  return (
    <Badge tone={tone}>
      {execution === 'running' && <LoaderCircle className="animate-spin" />}
      {execution === 'awaiting_approval' && <ShieldQuestion />}
      {executionLabel[execution]}
    </Badge>
  );
}
