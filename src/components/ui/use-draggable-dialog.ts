import * as React from "react"

const VIEWPORT_MARGIN = 8
const INTERACTIVE_SELECTOR =
  "button, input, textarea, select, a, [contenteditable=true]"

interface DragState {
  pointerId: number
  element: HTMLElement
  startX: number
  startY: number
  startLeft: number
  startTop: number
  width: number
  height: number
  left: number
  top: number
  moved: boolean
  cleanup: () => void
}

type PointerHandlers = Pick<
  React.DOMAttributes<HTMLElement>,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
>

export function useDraggableDialog(
  headerSlot: string,
  handlers: PointerHandlers = {}
) {
  const [position, setPosition] = React.useState<{
    left: number
    top: number
  } | null>(null)
  const dragState = React.useRef<DragState | null>(null)

  React.useEffect(() => {
    return () => {
      const drag = dragState.current
      if (drag) {
        drag.cleanup()
      }
    }
  }, [])

  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    handlers.onPointerDown?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0 || !event.isPrimary) return

    const target = event.target as Element
    const header = target.closest(`[data-slot="${headerSlot}"]`)
    if (!header || target.closest(INTERACTIVE_SELECTOR)) return

    const rect = event.currentTarget.getBoundingClientRect()
    const element = event.currentTarget

    const drag: DragState = {
      pointerId: event.pointerId,
      element,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      moved: false,
      cleanup: () => {},
    }
    dragState.current = drag

    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== drag.pointerId) return

      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - drag.width - VIEWPORT_MARGIN
      )
      const maxTop = Math.max(
        VIEWPORT_MARGIN,
        window.innerHeight - drag.height - VIEWPORT_MARGIN
      )

      drag.left = Math.min(
        maxLeft,
        Math.max(
          VIEWPORT_MARGIN,
          drag.startLeft + pointerEvent.clientX - drag.startX
        )
      )
      drag.top = Math.min(
        maxTop,
        Math.max(
          VIEWPORT_MARGIN,
          drag.startTop + pointerEvent.clientY - drag.startY
        )
      )
      drag.moved = true
      const deltaX = drag.left - drag.startLeft
      const deltaY = drag.top - drag.startTop
      drag.element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`
    }

    const stop = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== drag.pointerId) return

      drag.cleanup()
      dragState.current = null
      if (!drag.moved) return

      drag.element.style.left = `${drag.left}px`
      drag.element.style.top = `${drag.top}px`
      drag.element.style.translate = "none"
      drag.element.style.transform = ""
      setPosition({ left: drag.left, top: drag.top })
    }

    const stopOnBlur = () => {
      drag.cleanup()
      drag.element.style.left = `${drag.left}px`
      drag.element.style.top = `${drag.top}px`
      drag.element.style.translate = "none"
      drag.element.style.transform = ""
      dragState.current = null
      if (drag.moved) {
        setPosition({ left: drag.left, top: drag.top })
      }
    }

    drag.cleanup = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stopOnBlur)
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stopOnBlur)
    event.preventDefault()
  }

  return {
    draggableStyle: position
      ? ({
          left: position.left,
          top: position.top,
          translate: "none",
        } satisfies React.CSSProperties)
      : undefined,
    dragHandlers: {
      onPointerDown,
      onPointerMove: handlers.onPointerMove,
      onPointerUp: handlers.onPointerUp,
      onPointerCancel: handlers.onPointerCancel,
      onLostPointerCapture: handlers.onLostPointerCapture,
    },
  }
}
