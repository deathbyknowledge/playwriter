export type ConnectionState = 'idle' | 'connected' | 'extension-replaced'
export type TabState = 'connecting' | 'connected' | 'error'

export interface TabInfo {
  sessionId?: string
  targetId?: string
  state: TabState
  errorText?: string
  pinnedCount?: number
  attachOrder?: number
}

export interface ExtensionState {
  tabs: Map<number, TabInfo>
  connectionState: ConnectionState
  currentTabId: number | undefined
  errorText: string | undefined
}

// CDP types (simplified for extension use)
export interface CDPEvent {
  method: string
  sessionId?: string
  params?: Record<string, unknown>
}

// Protocol namespace for CDP types
export namespace Protocol {
  export namespace Target {
    export interface TargetInfo {
      targetId: string
      type: string
      title: string
      url: string
      attached?: boolean
      browserContextId?: string
    }

    export interface CreateTargetResponse {
      targetId: string
    }

    export interface CloseTargetResponse {
      success: boolean
    }

    export interface GetTargetInfoResponse {
      targetInfo: TargetInfo
    }
  }
}

// Extension protocol messages
export interface ExtensionCommandMessage {
  id: number
  method: 'forwardCDPCommand'
  params: {
    method: string
    sessionId?: string
    params?: Record<string, unknown>
  }
}

export interface ExtensionResponseMessage {
  id: number
  method?: undefined
  result?: unknown
  error?: string
}
