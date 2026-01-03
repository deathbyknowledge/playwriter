import type { Page, Locator, ElementHandle } from 'playwright-core'

export interface AriaRef {
  role: string
  name: string
  ref: string
}

export interface AriaSnapshotResult {
  snapshot: string
  refToElement: Map<string, { role: string; name: string }>
  refHandles: Array<{ ref: string; handle: ElementHandle }>
  getRefsForLocators: (locators: Array<Locator | ElementHandle>) => Promise<Array<AriaRef | null>>
  getRefForLocator: (locator: Locator | ElementHandle) => Promise<AriaRef | null>
  getRefStringForLocator: (locator: Locator | ElementHandle) => Promise<string | null>
}

const LABELS_CONTAINER_ID = '__playwriter_labels__'

// Roles that represent truly interactive elements (can be clicked, typed into, etc.)
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'searchbox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
])

// Color categories for different role types - warm color scheme
// Format: [gradient-top, gradient-bottom, border]
const ROLE_COLORS: Record<string, [string, string, string]> = {
  // Links - yellow (Vimium-style)
  link: ['#FFF785', '#FFC542', '#E3BE23'],
  // Buttons - orange
  button: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  // Text inputs - coral/red
  textbox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  combobox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  searchbox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  spinbutton: ['#FFCDD2', '#EF9A9A', '#E57373'],
  // Checkboxes/Radios/Switches - warm pink
  checkbox: ['#F8BBD0', '#F48FB1', '#EC407A'],
  radio: ['#F8BBD0', '#F48FB1', '#EC407A'],
  switch: ['#F8BBD0', '#F48FB1', '#EC407A'],
  // Sliders - peach
  slider: ['#FFCCBC', '#FFAB91', '#FF8A65'],
  // Menu items - salmon
  menuitem: ['#FFAB91', '#FF8A65', '#FF7043'],
  menuitemcheckbox: ['#FFAB91', '#FF8A65', '#FF7043'],
  menuitemradio: ['#FFAB91', '#FF8A65', '#FF7043'],
  // Tabs/Options - amber
  tab: ['#FFE082', '#FFD54F', '#FFC107'],
  option: ['#FFE082', '#FFD54F', '#FFC107'],
  treeitem: ['#FFE082', '#FFD54F', '#FFC107'],
}

// Default yellow for unknown roles
const DEFAULT_COLORS: [string, string, string] = ['#FFF785', '#FFC542', '#E3BE23']

// Use String.raw for CSS syntax highlighting in editors
const css = String.raw

const LABEL_STYLES = css`
  .__pw_label__ {
    position: absolute;
    font: bold 11px Helvetica, Arial, sans-serif;
    padding: 1px 4px;
    border-radius: 3px;
    color: black;
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6);
    white-space: nowrap;
  }
`

const CONTAINER_STYLES = css`
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2147483647;
  pointer-events: none;
`

/**
 * Get an accessibility snapshot with utilities to look up aria refs for elements.
 * Uses Playwright's internal aria-ref selector engine.
 *
 * @example
 * ```ts
 * const { snapshot, getRefsForLocators } = await getAriaSnapshot({ page })
 * const refs = await getRefsForLocators([page.locator('button'), page.locator('a')])
 * // refs[0].ref is e.g. "e5" - use page.locator('aria-ref=e5') to select
 * ```
 */
export async function getAriaSnapshot({ page }: { page: Page }): Promise<AriaSnapshotResult> {
  const snapshotMethod = (page as any)._snapshotForAI
  if (!snapshotMethod) {
    throw new Error('_snapshotForAI not available. Ensure you are using Playwright.')
  }

  const snapshot = await snapshotMethod.call(page)
  const snapshotStr = typeof snapshot === 'string' ? snapshot : (snapshot.full || JSON.stringify(snapshot, null, 2))

  // Discover refs by probing aria-ref=e1, e2, e3... until 10 consecutive misses
  const refToElement = new Map<string, { role: string; name: string }>()
  const refHandles: Array<{ ref: string; handle: ElementHandle }> = []

  let consecutiveMisses = 0
  let refNum = 1

  while (consecutiveMisses < 10) {
    const ref = `e${refNum++}`
    try {
      const locator = page.locator(`aria-ref=${ref}`)
      if (await locator.count() === 1) {
        consecutiveMisses = 0
        const [info, handle] = await Promise.all([
          locator.evaluate((el: any) => ({
            role: el.getAttribute('role') || {
              a: el.hasAttribute('href') ? 'link' : 'generic',
              button: 'button', input: { button: 'button', checkbox: 'checkbox', radio: 'radio',
                text: 'textbox', search: 'searchbox', number: 'spinbutton', range: 'slider',
              }[el.type] || 'textbox', select: 'combobox', textarea: 'textbox', img: 'img',
              nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
            }[el.tagName.toLowerCase()] || 'generic',
            name: el.getAttribute('aria-label') || el.textContent?.trim() || el.placeholder || '',
          })),
          locator.elementHandle({ timeout: 1000 }),
        ])
        refToElement.set(ref, info)
        if (handle) {
          refHandles.push({ ref, handle })
        }
      } else {
        consecutiveMisses++
      }
    } catch {
      consecutiveMisses++
    }
  }

  // Find refs for multiple locators in a single evaluate call
  const getRefsForLocators = async (locators: Array<Locator | ElementHandle>): Promise<Array<AriaRef | null>> => {
    if (locators.length === 0 || refHandles.length === 0) {
      return locators.map(() => null)
    }

    const targetHandles = await Promise.all(
      locators.map(async (loc) => {
        try {
          return 'elementHandle' in loc
            ? await (loc as Locator).elementHandle({ timeout: 1000 })
            : (loc as ElementHandle)
        } catch {
          return null
        }
      })
    )

    const matchingRefs = await page.evaluate(
      ({ targets, candidates }) => targets.map((target) => {
        if (!target) return null
        return candidates.find(({ element }) => element === target)?.ref ?? null
      }),
      { targets: targetHandles, candidates: refHandles.map(({ ref, handle }) => ({ ref, element: handle })) }
    )

    return matchingRefs.map((ref) => {
      if (!ref) return null
      const info = refToElement.get(ref)
      return info ? { ...info, ref } : null
    })
  }

  return {
    snapshot: snapshotStr,
    refToElement,
    refHandles,
    getRefsForLocators,
    getRefForLocator: async (loc) => (await getRefsForLocators([loc]))[0],
    getRefStringForLocator: async (loc) => (await getRefsForLocators([loc]))[0]?.ref ?? null,
  }
}

/**
 * Show Vimium-style labels on interactive elements.
 * Labels are yellow badges positioned above each element showing the aria ref (e.g., "e1", "e2").
 * Use with screenshots so agents can see which elements are interactive.
 *
 * Labels auto-hide after 5 seconds to prevent stale labels remaining on the page.
 * Call this function again if the page HTML changes to get fresh labels.
 *
 * By default, only shows labels for truly interactive roles (button, link, textbox, etc.)
 * to reduce visual clutter. Set `interactiveOnly: false` to show all elements with refs.
 *
 * @example
 * ```ts
 * const { snapshot, labelCount } = await showAriaRefLabels({ page })
 * await page.screenshot({ path: '/tmp/screenshot.png' })
 * // Agent sees [e5] label on "Submit" button
 * await page.locator('aria-ref=e5').click()
 * // Labels auto-hide after 5 seconds, or call hideAriaRefLabels() manually
 * ```
 */
export async function showAriaRefLabels({ page, interactiveOnly = true }: {
  page: Page
  interactiveOnly?: boolean
}): Promise<{
  snapshot: string
  labelCount: number
}> {
  const { snapshot, refHandles, refToElement } = await getAriaSnapshot({ page })

  // Filter to only interactive elements if requested
  const filteredRefs = interactiveOnly
    ? refHandles.filter(({ ref }) => {
        const info = refToElement.get(ref)
        return info && INTERACTIVE_ROLES.has(info.role)
      })
    : refHandles

  // Build refs with role info for color coding
  const refsWithRoles = filteredRefs.map(({ ref, handle }) => ({
    ref,
    element: handle,
    role: refToElement.get(ref)?.role || 'generic',
  }))

  // Single evaluate call: create container, styles, and all labels
  // ElementHandles get unwrapped to DOM elements in browser context
  // Using 'any' types here since this code runs in browser context
  const labelCount = await page.evaluate(
    // Using 'any' for browser types since this runs in browser context
    ({ refs, containerId, containerStyles, labelStyles, roleColors, defaultColors }: {
      refs: Array<{
        ref: string
        role: string
        element: any // Element in browser context
      }>
      containerId: string
      containerStyles: string
      labelStyles: string
      roleColors: Record<string, [string, string, string]>
      defaultColors: [string, string, string]
    }) => {
      const doc = (globalThis as any).document
      const win = globalThis as any

      // Remove existing labels if present (idempotent)
      doc.getElementById(containerId)?.remove()

      // Create container - absolute positioned, max z-index, no pointer events
      const container = doc.createElement('div')
      container.id = containerId
      container.style.cssText = containerStyles

      // Inject base label CSS
      const style = doc.createElement('style')
      style.textContent = labelStyles
      container.appendChild(style)

      // Track placed label rectangles for overlap detection
      // Each rect is { left, top, right, bottom } in viewport coordinates
      const placedLabels: Array<{ left: number; top: number; right: number; bottom: number }> = []

      // Estimate label dimensions (11px font + padding)
      const LABEL_HEIGHT = 16
      const LABEL_CHAR_WIDTH = 7 // approximate width per character

      // Parse alpha from rgb/rgba color string (getComputedStyle always returns these formats)
      const getColorAlpha = (color: string): number => {
        if (color === 'transparent') return 0
        // Match rgba(r, g, b, a) or rgb(r, g, b)
        const match = color.match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/)
        if (match) {
          return match[1] !== undefined ? parseFloat(match[1]) : 1
        }
        return 1 // Default to opaque for unrecognized formats
      }

      // Check if an element has an opaque background that would block elements behind it
      const isOpaqueElement = (el: any): boolean => {
        const style = win.getComputedStyle(el)

        // Check element opacity
        const opacity = parseFloat(style.opacity)
        if (opacity < 0.1) return false

        // Check background-color alpha
        const bgAlpha = getColorAlpha(style.backgroundColor)
        if (bgAlpha > 0.1) return true

        // Check if has background-image (usually opaque)
        if (style.backgroundImage !== 'none') return true

        return false
      }

      // Check if element is visible (not covered by opaque overlay)
      const isElementVisible = (element: any, rect: any): boolean => {
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2

        // Get all elements at this point, from top to bottom
        const stack = doc.elementsFromPoint(centerX, centerY) as any[]

        // Find our target element in the stack
        const targetIndex = stack.findIndex((el: any) =>
          element.contains(el) || el.contains(element)
        )

        // Element not in stack at all - not visible
        if (targetIndex === -1) return false

        // Check if any opaque element is above our target
        for (let i = 0; i < targetIndex; i++) {
          const el = stack[i]
          // Skip our own overlay container
          if (el.id === containerId) continue
          // Skip pointer-events: none elements (decorative overlays)
          if (win.getComputedStyle(el).pointerEvents === 'none') continue
          // If this element is opaque, our target is blocked
          if (isOpaqueElement(el)) return false
        }

        return true
      }

      // Check if two rectangles overlap
      const rectsOverlap = (
        a: { left: number; top: number; right: number; bottom: number },
        b: { left: number; top: number; right: number; bottom: number }
      ) => {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      }

      // Create label for each interactive element
      let count = 0
      for (const { ref, role, element } of refs) {
        const rect = element.getBoundingClientRect()

        // Skip elements with no size (hidden)
        if (rect.width === 0 || rect.height === 0) {
          continue
        }

        // Skip elements that are covered by opaque overlays
        if (!isElementVisible(element, rect)) {
          continue
        }

        // Calculate label position and dimensions
        const labelWidth = ref.length * LABEL_CHAR_WIDTH + 8 // +8 for padding
        const labelLeft = rect.left
        const labelTop = Math.max(0, rect.top - LABEL_HEIGHT)
        const labelRect = {
          left: labelLeft,
          top: labelTop,
          right: labelLeft + labelWidth,
          bottom: labelTop + LABEL_HEIGHT,
        }

        // Skip if this label would overlap with any already-placed label
        const overlaps = placedLabels.some((placed) => rectsOverlap(labelRect, placed))
        if (overlaps) {
          continue
        }

        // Get colors for this role
        const [gradTop, gradBottom, border] = roleColors[role] || defaultColors

        // Place the label
        const label = doc.createElement('div')
        label.className = '__pw_label__'
        label.textContent = ref
        label.style.background = `linear-gradient(to bottom, ${gradTop} 0%, ${gradBottom} 100%)`
        label.style.border = `1px solid ${border}`

        // Position above element, accounting for scroll
        label.style.left = `${win.scrollX + labelLeft}px`
        label.style.top = `${win.scrollY + labelTop}px`

        container.appendChild(label)
        placedLabels.push(labelRect)
        count++
      }

      doc.documentElement.appendChild(container)

      // Auto-hide labels after 5 seconds to prevent stale labels
      win.setTimeout(() => {
        doc.getElementById(containerId)?.remove()
      }, 5000)

      return count
    },
    {
      refs: refsWithRoles.map(({ ref, role, element }) => ({ ref, role, element })),
      containerId: LABELS_CONTAINER_ID,
      containerStyles: CONTAINER_STYLES,
      labelStyles: LABEL_STYLES,
      roleColors: ROLE_COLORS,
      defaultColors: DEFAULT_COLORS,
    }
  )

  return { snapshot, labelCount }
}

/**
 * Remove all aria ref labels from the page.
 */
export async function hideAriaRefLabels({ page }: { page: Page }): Promise<void> {
  await page.evaluate((id) => {
    const doc = (globalThis as any).document
    doc.getElementById(id)?.remove()
  }, LABELS_CONTAINER_ID)
}
