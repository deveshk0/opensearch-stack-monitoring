import { DependencyList, useEffect, useRef } from "react";

// Refresh ticks share an in-flight request; changed query inputs invalidate it.
export function usePollingEffect(
  request: (isCurrent: () => boolean) => Promise<unknown>,
  dependencies: DependencyList,
  tick: number,
) {
  const refresh = useRef(() => {});
  useEffect(() => {
    let active = true;
    let pending = false;
    const run = () => {
      if (pending) return;
      pending = true;
      void request(() => active).finally(() => {
        pending = false;
      });
    };
    refresh.current = run;
    run();
    return () => {
      active = false;
    };
  }, dependencies);
  useEffect(() => refresh.current(), [tick]);
}
