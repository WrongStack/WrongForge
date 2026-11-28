/**
 * Test-only: the tooltip provider the app root supplies (App.tsx wraps the
 * whole shell in one). A view that renders a `Tip` needs it — render the view
 * inside `<Tips>` when it is tested on its own.
 */

import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

export function Tips({ children }: { children: ReactNode }) {
  return <Tooltip.Provider>{children}</Tooltip.Provider>;
}
