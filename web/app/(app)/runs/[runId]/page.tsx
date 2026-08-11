import { RunTimeline } from '@/components/runs/run-timeline';

export default async function RunPage({ params }: PageProps<'/runs/[runId]'>) {
  const { runId } = await params;
  return <RunTimeline runId={runId} />;
}
