import { ListPageSkeleton } from '../components/Skeleton';

export default function ContainersLoading() {
  return <ListPageSkeleton rows={4} rowHeight={56} titleWidth={140} />;
}
