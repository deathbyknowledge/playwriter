import type { CDPSession } from './cdp-session.js'
import type { Protocol } from 'devtools-protocol'

export interface BreakpointInfo {
  id: string
  file: string
  line: number
}

export interface ConsoleEntry {
  type: string
  message: string
  timestamp: number
}

export interface LocationInfo {
  url: string
  lineNumber: number
  columnNumber: number
  callstack: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
  }>
  sourceContext: string
}

export interface EvaluateResult {
  value: unknown
  consoleOutput: string[]
}

export interface VariablesResult {
  [scope: string]: Record<string, unknown>
}

export class Debugger {
  private cdp: CDPSession
  private debuggerEnabled = false
  private paused = false
  private currentCallFrames: Protocol.Debugger.CallFrame[] = []
  private breakpoints = new Map<string, BreakpointInfo>()
  private consoleOutput: ConsoleEntry[] = []

  constructor({ cdp }: { cdp: CDPSession }) {
    this.cdp = cdp
    this.setupEventListeners()
  }

  private setupEventListeners() {
    this.cdp.on('Debugger.paused', (params) => {
      this.paused = true
      this.currentCallFrames = params.callFrames
    })

    this.cdp.on('Debugger.resumed', () => {
      this.paused = false
      this.currentCallFrames = []
    })

    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      const message = params.args
        .map((arg) => {
          if (arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean') {
            return String(arg.value)
          }
          if (arg.type === 'object') {
            if (arg.value) {
              return JSON.stringify(arg.value, null, 2)
            }
            return arg.description || `[${arg.subtype || arg.type}]`
          }
          return JSON.stringify(arg)
        })
        .join(' ')

      this.consoleOutput.push({
        type: params.type,
        message,
        timestamp: Date.now(),
      })

      if (this.consoleOutput.length > 100) {
        this.consoleOutput.shift()
      }
    })
  }

  async enable(): Promise<void> {
    if (this.debuggerEnabled) {
      return
    }
    await this.cdp.send('Debugger.enable')
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Runtime.runIfWaitingForDebugger')
    this.debuggerEnabled = true
  }

  async executeCode({ code }: { code: string }): Promise<EvaluateResult> {
    await this.enable()

    const consoleStartIndex = this.consoleOutput.length

    const wrappedCode = `
      try {
        ${code}
      } catch (e) {
        e;
      }
    `

    const response = await this.cdp.send('Runtime.evaluate', {
      expression: wrappedCode,
      objectGroup: 'console',
      includeCommandLineAPI: true,
      silent: false,
      returnByValue: true,
      generatePreview: true,
      awaitPromise: true,
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })

    const consoleOutputs = this.consoleOutput.slice(consoleStartIndex)
    const value = await this.processRemoteObject(response.result)

    return {
      value,
      consoleOutput: consoleOutputs.map((o) => `[${o.type}] ${o.message}`),
    }
  }

  async setBreakpoint({ file, line }: { file: string; line: number }): Promise<string> {
    await this.enable()

    let fileUrl = file
    if (!file.startsWith('file://') && !file.startsWith('http://') && !file.startsWith('https://')) {
      fileUrl = `file://${file.startsWith('/') ? '' : '/'}${file}`
    }

    const response = await this.cdp.send('Debugger.setBreakpointByUrl', {
      lineNumber: line - 1,
      urlRegex: fileUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      columnNumber: 0,
    })

    this.breakpoints.set(response.breakpointId, { id: response.breakpointId, file, line })
    return response.breakpointId
  }

  async deleteBreakpoint({ breakpointId }: { breakpointId: string }): Promise<void> {
    await this.enable()
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId })
    this.breakpoints.delete(breakpointId)
  }

  listBreakpoints(): BreakpointInfo[] {
    return Array.from(this.breakpoints.values())
  }

  async inspectVariables({ scope = 'local' }: { scope?: 'local' | 'global' } = {}): Promise<VariablesResult> {
    await this.enable()

    if (scope === 'global' || !this.paused) {
      const response = await this.cdp.send('Runtime.globalLexicalScopeNames', {})
      const globalObjResponse = await this.cdp.send('Runtime.evaluate', {
        expression: 'this',
        returnByValue: true,
      })

      return {
        lexicalNames: response.names as unknown as Record<string, unknown>,
        globalThis: globalObjResponse.result.value as Record<string, unknown>,
      }
    }

    if (this.currentCallFrames.length === 0) {
      throw new Error('No active call frames')
    }

    const frame = this.currentCallFrames[0]
    const result: VariablesResult = {}

    for (const scopeObj of frame.scopeChain) {
      if (scopeObj.type === 'global') {
        continue
      }

      if (!scopeObj.object.objectId) {
        continue
      }

      const objProperties = await this.cdp.send('Runtime.getProperties', {
        objectId: scopeObj.object.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: true,
      })

      const variables: Record<string, unknown> = {}
      for (const prop of objProperties.result) {
        if (prop.value && prop.configurable) {
          variables[prop.name] = this.formatPropertyValue(prop.value)
        }
      }

      result[scopeObj.type] = variables
    }

    return result
  }

  async evaluate({ expression }: { expression: string }): Promise<EvaluateResult> {
    await this.enable()

    const consoleStartIndex = this.consoleOutput.length

    const wrappedExpression = `
      try {
        ${expression}
      } catch (e) {
        e;
      }
    `

    let response: Protocol.Debugger.EvaluateOnCallFrameResponse | Protocol.Runtime.EvaluateResponse

    if (this.paused && this.currentCallFrames.length > 0) {
      const frame = this.currentCallFrames[0]
      response = await this.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: wrappedExpression,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
      })
    } else {
      response = await this.cdp.send('Runtime.evaluate', {
        expression: wrappedExpression,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
        awaitPromise: true,
      })
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })

    const consoleOutputs = this.consoleOutput.slice(consoleStartIndex)
    const value = await this.processRemoteObject(response.result)

    return {
      value,
      consoleOutput: consoleOutputs.map((o) => `[${o.type}] ${o.message}`),
    }
  }

  async getLocation(): Promise<LocationInfo> {
    await this.enable()

    if (!this.paused || this.currentCallFrames.length === 0) {
      throw new Error('Debugger is not paused at a breakpoint')
    }

    const frame = this.currentCallFrames[0]
    const { scriptId, lineNumber, columnNumber } = frame.location

    const callstack = this.currentCallFrames.map((f) => ({
      functionName: f.functionName || '(anonymous)',
      url: f.url,
      lineNumber: f.location.lineNumber + 1,
      columnNumber: f.location.columnNumber || 0,
    }))

    let sourceContext = ''
    try {
      const scriptSource = await this.cdp.send('Debugger.getScriptSource', { scriptId })
      const lines = scriptSource.scriptSource.split('\n')
      const startLine = Math.max(0, lineNumber - 3)
      const endLine = Math.min(lines.length - 1, lineNumber + 3)

      for (let i = startLine; i <= endLine; i++) {
        const prefix = i === lineNumber ? '> ' : '  '
        sourceContext += `${prefix}${i + 1}: ${lines[i]}\n`
      }
    } catch {
      sourceContext = 'Unable to retrieve source code'
    }

    return {
      url: frame.url,
      lineNumber: lineNumber + 1,
      columnNumber: columnNumber || 0,
      callstack,
      sourceContext,
    }
  }

  async stepOver(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.stepOver')
  }

  async stepInto(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.stepInto')
  }

  async stepOut(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.stepOut')
  }

  async resume(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.resume')
  }

  getConsoleOutput({ limit = 20 }: { limit?: number } = {}): ConsoleEntry[] {
    return this.consoleOutput.slice(-limit)
  }

  isPaused(): boolean {
    return this.paused
  }

  private formatPropertyValue(value: Protocol.Runtime.RemoteObject): unknown {
    if (value.type === 'object' && value.subtype !== 'null') {
      return `[${value.subtype || value.type}]`
    }
    if (value.type === 'function') {
      return '[function]'
    }
    if (value.value !== undefined) {
      return value.value
    }
    return `[${value.type}]`
  }

  private async processRemoteObject(obj: Protocol.Runtime.RemoteObject): Promise<unknown> {
    if (obj.type === 'undefined') {
      return undefined
    }

    if (obj.value !== undefined) {
      return obj.value
    }

    if (obj.type === 'object' && obj.objectId) {
      try {
        const props = await this.cdp.send('Runtime.getProperties', {
          objectId: obj.objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: true,
        })

        const result: Record<string, unknown> = {}
        for (const prop of props.result) {
          if (prop.value) {
            if (prop.value.type === 'object' && prop.value.objectId && prop.value.subtype !== 'null') {
              try {
                const nestedProps = await this.cdp.send('Runtime.getProperties', {
                  objectId: prop.value.objectId,
                  ownProperties: true,
                  accessorPropertiesOnly: false,
                  generatePreview: true,
                })
                const nestedObj: Record<string, unknown> = {}
                for (const nestedProp of nestedProps.result) {
                  if (nestedProp.value) {
                    nestedObj[nestedProp.name] =
                      nestedProp.value.value !== undefined
                        ? nestedProp.value.value
                        : nestedProp.value.description || `[${nestedProp.value.subtype || nestedProp.value.type}]`
                  }
                }
                result[prop.name] = nestedObj
              } catch {
                result[prop.name] = prop.value.description || `[${prop.value.subtype || prop.value.type}]`
              }
            } else if (prop.value.type === 'function') {
              result[prop.name] = '[function]'
            } else if (prop.value.value !== undefined) {
              result[prop.name] = prop.value.value
            } else {
              result[prop.name] = `[${prop.value.type}]`
            }
          }
        }
        return result
      } catch {
        return obj.description || `[${obj.subtype || obj.type}]`
      }
    }

    return obj.description || `[${obj.type}]`
  }
}
