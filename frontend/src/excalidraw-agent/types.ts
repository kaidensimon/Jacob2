// The simplified shape format the AI produces. The client converts these into
// real Excalidraw elements via convertToExcalidrawElements (see convert.ts).
export type AgentShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'text'
  | 'arrow'
  | 'line'

export interface AgentShape {
  id: string
  type: AgentShapeType
  x?: number
  y?: number
  width?: number
  height?: number
  text?: string
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  fontSize?: number
  // arrows: bind endpoints to other shapes by id
  fromId?: string
  toId?: string
  points?: [number, number][]
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
  | { error: string }

// Items shown in the chat panel.
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'error'; text: string }
