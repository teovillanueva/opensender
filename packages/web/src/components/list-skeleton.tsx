import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholder shaped like the list tables (bordered container, header
 * bar, icon + text rows), so the skeleton → content swap is layout-stable.
 */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex h-10 items-center gap-6 border-b border-border/60 px-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-3 w-20" />
      </div>
      {Array.from({ length: rows }, (_, index) => `row-${index}`).map((key) => (
        <div
          key={key}
          className="flex h-14 items-center gap-3 border-b border-border/60 px-4 last:border-b-0"
        >
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-4 w-56 max-w-[40%]" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
