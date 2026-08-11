import { WorkflowBuilder } from '@/components/workflows/workflow-builder';

export default async function WorkflowPage({ params }: PageProps<'/workflows/[workflowId]'>) {
  const { workflowId } = await params;
  return <WorkflowBuilder workflowId={workflowId} />;
}
