// React 18.3 and @types/react 18.3.27 do not know the `inert` prop, so it is never passed as JSX. The
// attribute is toggled on the element in a layout effect, before the browser paints.

import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

export function useInert(ref: RefObject<HTMLElement>, on: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.toggleAttribute('inert', on);
    return () => {
      if (on) el.removeAttribute('inert');
    };
  }, [ref, on]);
}
