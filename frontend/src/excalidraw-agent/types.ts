// The simplified shape format the AI produces. The client converts these into
// real Excalidraw elements via convertToExcalidrawElements (see convert.ts).
export type AgentShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'text'
  | 'arrow'
  | 'line'
  | 'math'

export interface AgentShape {
  id: string
  type: AgentShapeType
  x?: number
  y?: number
  width?: number
  height?: number
  text?: string
  // math: a LaTeX string, rendered to an image element on the canvas
  latex?: string
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  fontSize?: number
  // arrows: bind endpoints to other shapes by id
  fromId?: string
  toId?: string
  points?: [number, number][]
  // Filled in by the client once a `math` shape has been rendered to an image.
  fileId?: string
}

export type AlignEdge =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center-horizontal'
  | 'center-vertical'

// One streamed action from the model. `complete`/`time` are streaming metadata.
export type AgentAction =
  | { _type: 'think'; text?: string; complete?: boolean; time?: number }
  | { _type: 'message'; text?: string; complete?: boolean; time?: number }
  // The agent can't tell what to draw — ask the user to elaborate, draw nothing.
  | {
      _type: 'needContext'
      text?: string
      needsMoreContext?: boolean
      complete?: boolean
      time?: number
    }
  | { _type: 'create'; shape?: AgentShape; complete?: boolean; time?: number }
  | {
      _type: 'update'
      shape?: Partial<AgentShape> & { id: string }
      complete?: boolean
      time?: number
    }
  | { _type: 'delete'; id?: string; complete?: boolean; time?: number }
  // Geometric / layout actions — the client does the precise math.
  | { _type: 'move'; id?: string; x?: number; y?: number; complete?: boolean; time?: number }
  | {
      _type: 'resize'
      id?: string
      width?: number
      height?: number
      complete?: boolean
      time?: number
    }
  | {
      _type: 'align'
      ids?: string[]
      edge?: AlignEdge
      complete?: boolean
      time?: number
    }
  | {
      _type: 'distribute'
      ids?: string[]
      axis?: 'horizontal' | 'vertical'
      complete?: boolean
      time?: number
    }
  | {
      _type: 'stack'
      ids?: string[]
      axis?: 'horizontal' | 'vertical'
      gap?: number
      complete?: boolean
      time?: number
    }
  // The agent's own camera: zoom to specific shapes, a region, or fit everything.
  | {
      _type: 'setMyView'
      ids?: string[]
      bounds?: { x: number; y: number; w: number; h: number }
      complete?: boolean
      time?: number
    }
  | { _type: 'review'; text?: string; complete?: boolean; time?: number }
  // Tool: render a real 2D/3D plot of these expressions and feed the image back
  // as a drawing reference (so the agent traces the correct shape).
  | {
      _type: 'graphRef'
      dimension?: '2d' | '3d'
      expressions?: string[]
      // Optional: where to place the plot (viewport-relative), so it fits the
      // agent's layout when invoked partway through a drawing.
      x?: number
      y?: number
      width?: number
      height?: number
      text?: string
      complete?: boolean
      time?: number
    }
  // Tool: deterministically draw a region-between-curves figure (for region of
  // integration / change of order). The client draws curves, shaded region,
  // axes, and both strips; the agent only adds integrals/labels around it.
  | {
      _type: 'regionRef'
      lower?: string // lower bounding curve y = f(x)
      upper?: string // upper bounding curve y = f(x)
      xmin?: number
      xmax?: number
      x?: number
      y?: number
      width?: number
      height?: number
      text?: string
      complete?: boolean
      time?: number
    }
  | { error: string }

// Items shown in the chat panel.
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'video'; url: string; title: string }
  | { kind: 'save-prompt'; animationId: number; title: string }
