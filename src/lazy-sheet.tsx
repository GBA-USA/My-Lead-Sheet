import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { reloadOntoPublished } from "./app-build";

/** How long a sheet's code may take before `Waiting` shows, so a load from the phone's cache does not flash it. */
const WAITING_SHOWN_MS = 400;

/**
 * A sheet whose code loads on its first open, so the main script keeps its size. A load that fails while the site
 * publishes another version means a deploy replaced this page's files, and the new service worker dropped the old
 * ones, so no retry can work: the page reloads onto the published version. Any other failure shows `Unloaded`. Closing
 * `Unloaded` or `Waiting` calls off a reload not yet started, and the next open loads again.
 */
export function lazySheet<P extends { onClose: () => void }>(load: () => Promise<ComponentType<P>>, Unloaded: ComponentType<P>, Waiting?: ComponentType<P>): ComponentType<P> {
  let attempt = new AbortController();
  const start = () => {
    attempt.abort();
    const { signal } = (attempt = new AbortController());
    return lazy<ComponentType<P>>(() =>
      load().then(
        (Loaded) => ({ default: Loaded }),
        async () => {
          if ((await reloadOntoPublished(signal)) === "reloading") await new Promise<never>(() => {});
          return { default: (props: P) => <Unloaded {...closing(props)} /> };
        },
      ),
    );
  };
  let Loading = start();
  function closing(props: P): P {
    return {
      ...props,
      onClose: () => {
        Loading = start();
        props.onClose();
      },
    };
  }
  return function LazySheet(props: P) {
    return (
      <Suspense fallback={Waiting ? <Later><Waiting {...closing(props)} /></Later> : null}>
        <Loading {...props} />
      </Suspense>
    );
  };
}

function Later({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), WAITING_SHOWN_MS);
    return () => clearTimeout(timer);
  }, []);
  return shown ? children : null;
}
