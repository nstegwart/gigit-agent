import type { Feature } from '#/lib/types'
import { DependencyFlow } from '#/components/control-center/dependency'

/** Back-compat export — ART-022 interactive flow (zoom/pan/tree/warnings). */
export function WireGraph({ features }: { features: Array<Feature> }) {
  return <DependencyFlow features={features} />
}
