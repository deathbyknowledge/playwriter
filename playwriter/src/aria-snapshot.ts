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

// Use String.raw for CSS syntax highlighting in editors
const css = String.raw

const LABEL_STYLES = css`
  .__pw_label__ {
    position: absolute;
    font: bold 11px Helvetica, Arial, sans-serif;
    padding: 1px 4px;
    background: linear-gradient(to bottom, #FFF785 0%, #FFC542 100%);
    border: 1px solid #E3BE23;
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
 * By default, only shows labels for truly interactive roles (button, link, textbox, etc.)
 * to reduce visual clutter. Set `interactiveOnly: false` to show all elements with refs.
 *
 * @example
 * ```ts
 * const { snapshot, labelCount } = await showAriaRefLabels({ page })
 * const screenshot = await page.screenshot()
 * // Agent sees [e5] label on "Submit" button
 * await page.locator('aria-ref=e5').click()
 * await hideAriaRefLabels({ page })
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

  // Single evaluate call: create container, styles, and all labels
  // ElementHandles get unwrapped to DOM elements in browser context
  // Using 'any' types here since this code runs in browser context
  const labelCount = await page.evaluate(
    ({ refs, containerId, containerStyles, labelStyles }: {
      refs: Array<{ ref: string; element: { getBoundingClientRect(): { width: number; height: number; left: number; top: number; right: number; bottom: number } } }>
      containerId: string
      containerStyles: string
      labelStyles: string
    }) => {
      const doc = (globalThis as any).document
      const win = globalThis as any

      // Remove existing labels if present (idempotent)
      doc.getElementById(containerId)?.remove()

      // Create container - absolute positioned, max z-index, no pointer events
      const container = doc.createElement('div')
      container.id = containerId
      container.style.cssText = containerStyles

      // Inject Vimium-style CSS
      const style = doc.createElement('style')
      style.textContent = labelStyles
      container.appendChild(style)

      // Track placed label rectangles for overlap detection
      // Each rect is { left, top, right, bottom } in viewport coordinates
      const placedLabels: Array<{ left: number; top: number; right: number; bottom: number }> = []

      // Estimate label dimensions (11px font + padding)
      const LABEL_HEIGHT = 16
      const LABEL_CHAR_WIDTH = 7 // approximate width per character

      // Check if two rectangles overlap
      const rectsOverlap = (
        a: { left: number; top: number; right: number; bottom: number },
        b: { left: number; top: number; right: number; bottom: number }
      ) => {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      }

      // Create label for each interactive element
      let count = 0
      for (const { ref, element } of refs) {
        const rect = element.getBoundingClientRect()

        // Skip elements with no size (hidden)
        if (rect.width === 0 || rect.height === 0) {
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

        // Place the label
        const label = doc.createElement('div')
        label.className = '__pw_label__'
        label.textContent = ref

        // Position above element, accounting for scroll
        label.style.left = `${win.scrollX + labelLeft}px`
        label.style.top = `${win.scrollY + labelTop}px`

        container.appendChild(label)
        placedLabels.push(labelRect)
        count++
      }

      doc.documentElement.appendChild(container)
      return count
    },
    {
      refs: filteredRefs.map(({ ref, handle }) => ({ ref, element: handle })),
      containerId: LABELS_CONTAINER_ID,
      containerStyles: CONTAINER_STYLES,
      labelStyles: LABEL_STYLES,
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
