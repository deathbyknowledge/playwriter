// Popup script for configuring rebrow relay settings

interface RelaySettings {
  relayUrl: string
}

const DEFAULT_SETTINGS: RelaySettings = {
  relayUrl: '',
}

async function getSettings(): Promise<RelaySettings> {
  const result = await chrome.storage.sync.get('relaySettings')
  return { ...DEFAULT_SETTINGS, ...result.relaySettings }
}

async function saveSettings(settings: RelaySettings): Promise<void> {
  await chrome.storage.sync.set({ relaySettings: settings })
  // Notify background script that settings changed
  chrome.runtime.sendMessage({ type: 'settingsChanged', settings })
}

async function fetchExtensionState(): Promise<{
  connectionState: string
  tabs: Record<number, { state: string }>
  currentTabId?: number
}> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getState' })
    return response || { connectionState: 'idle', tabs: {} }
  } catch {
    return { connectionState: 'idle', tabs: {} }
  }
}

async function toggleCurrentTab(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'toggleTab' })
}

function updateUI(settings: RelaySettings): void {
  const relayUrlInput = document.getElementById('relay-url') as HTMLInputElement
  relayUrlInput.value = settings.relayUrl
}

function updateStatus(state: {
  connectionState: string
  tabs: Record<number, { state: string }>
  currentTabId?: number
}): void {
  const statusDot = document.getElementById('status-dot') as HTMLDivElement
  const statusText = document.getElementById('status-text') as HTMLSpanElement
  const toggleBtn = document.getElementById('toggle-btn') as HTMLButtonElement

  // Check if current tab is connected
  const currentTabId = state.currentTabId
  const currentTabState = currentTabId ? state.tabs[currentTabId]?.state : null

  // Remove all status classes
  statusDot.classList.remove('connected', 'disconnected', 'connecting', 'error')

  if (state.connectionState === 'extension-replaced') {
    statusDot.classList.add('error')
    statusText.textContent = 'Replaced by another extension'
    toggleBtn.textContent = 'Retry'
  } else if (currentTabState === 'connected') {
    statusDot.classList.add('connected')
    statusText.textContent = 'Connected'
    toggleBtn.textContent = 'Disconnect Tab'
  } else if (currentTabState === 'connecting') {
    statusDot.classList.add('connecting')
    statusText.textContent = 'Connecting...'
    toggleBtn.textContent = 'Cancel'
  } else if (currentTabState === 'error') {
    statusDot.classList.add('error')
    statusText.textContent = 'Error'
    toggleBtn.textContent = 'Retry'
  } else {
    statusDot.classList.add('disconnected')
    statusText.textContent = 'Not connected'
    toggleBtn.textContent = 'Connect Tab'
  }
}

async function init(): Promise<void> {
  const settings = await getSettings()
  updateUI(settings)

  const state = await fetchExtensionState()
  updateStatus(state)

  // Save button
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
  saveBtn.addEventListener('click', async () => {
    const relayUrlInput = document.getElementById('relay-url') as HTMLInputElement

    const newSettings: RelaySettings = {
      relayUrl: relayUrlInput.value.trim(),
    }

    await saveSettings(newSettings)
    window.close()
  })

  // Reset button
  const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement
  resetBtn.addEventListener('click', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    updateUI(DEFAULT_SETTINGS)
  })

  // Toggle button
  const toggleBtn = document.getElementById('toggle-btn') as HTMLButtonElement
  toggleBtn.addEventListener('click', async () => {
    await toggleCurrentTab()
    // Wait a bit for state to update
    setTimeout(async () => {
      const newState = await fetchExtensionState()
      updateStatus(newState)
    }, 500)
  })
}

init()
